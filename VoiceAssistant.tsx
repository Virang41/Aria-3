import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { ConnectionState } from '../types';
import { base64ToUint8Array, float32To16BitPCM, pcmToAudioBuffer } from '../utils/audioUtils';
import { getUserProfile, updateUserMemory, addHistoryItem, getRecentHistory, clearUserMemory } from '../utils/memoryDb';
import { initFirebase, loadMemoryFromFirebase, saveMemoryToFirebase } from '../utils/firebaseClient';
import Visualizer from './Visualizer';

// Interface for Grounding Chunks (Search Results)
interface GroundingChunk {
  web?: {
    uri: string;
    title: string;
  };
}

// Available voices
const VOICES = [
    { name: 'Aoede', label: 'Aoede (Deep, Confident)' },
    { name: 'Puck', label: 'Puck (Playful, Energetic)' },
    { name: 'Charon', label: 'Charon (Deep, Authoritative)' },
    { name: 'Kore', label: 'Kore (Calm, Soothing)' },
    { name: 'Fenrir', label: 'Fenrir (Fast, Intense)' },
];

// AudioWorklet processor code inline
const WORKLET_CODE = `
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    
    const channelData = input[0]; // Mono
    
    // Fill the internal buffer
    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.bufferIndex++] = channelData[i];
      
      // When buffer is full, send to main thread
      if (this.bufferIndex >= this.bufferSize) {
        this.port.postMessage(this.buffer);
        this.buffer = new Float32Array(this.bufferSize); // Clear buffer
        this.bufferIndex = 0;
      }
    }
    return true;
  }
}
registerProcessor('audio-processor', AudioProcessor);
`;

// Tool Definition: Allow the model to save user information
const updateMemoryTool: FunctionDeclaration = {
  name: 'update_user_memory',
  description: 'Saves a piece of information to the "memory.json" file. Use this when the user asks you to remember a fact, a task, a preference, or their name.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      key: {
        type: Type.STRING,
        description: 'The key for the memory (e.g., "user_name", "todo_list", "favorite_color").',
      },
      value: {
        type: Type.STRING,
        description: 'The value to store. If it is a list, format it as a string.',
      },
    },
    required: ['key', 'value'],
  },
};

const VoiceAssistant: React.FC = () => {
  const [apiKey, setApiKey] = useState<string>('');
  const [inputKey, setInputKey] = useState<string>('');
  
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [sources, setSources] = useState<GroundingChunk[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState('Aoede');
  
  // Analysers for Visualizer
  const [inputAnalyser, setInputAnalyser] = useState<AnalyserNode | null>(null);
  const [outputAnalyser, setOutputAnalyser] = useState<AnalyserNode | null>(null);

  // Memory Display State
  const [showMemory, setShowMemory] = useState(false);
  const [memoryData, setMemoryData] = useState<Record<string, any>>({});
  
  // Refs for audio handling
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioInputContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  
  // Refs for API session & Logic
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const isIntentionalCloseRef = useRef<boolean>(false);
  const retryTimeoutRef = useRef<number | null>(null);
  
  // Audio playback queue management
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // Transcription buffer for context restoration
  const currentInputTransRef = useRef<string>('');
  const currentOutputTransRef = useRef<string>('');

  // Load API Key & Init Firebase
  useEffect(() => {
    // 1. Initialize Firebase with hardcoded config
    initFirebase();

    // 2. Load stored Gemini API Key
    const storedKey = localStorage.getItem('gemini_api_key');
    if (storedKey) setApiKey(storedKey);

    refreshMemoryDisplay();
  }, []);

  const refreshMemoryDisplay = async () => {
    const profile = await getUserProfile();
    setMemoryData(profile);
  };

  const handleDownloadMemory = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(memoryData, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "memory.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const handleManualSync = async () => {
    setIsSyncing(true);
    try {
        await saveMemoryToFirebase(memoryData);
        alert("Memory synced to Firebase Cloud successfully.");
    } catch (e) {
        alert("Sync failed. Check console.");
    } finally {
        setIsSyncing(false);
    }
  };

  const handleClearMemory = async () => {
    if (window.confirm("Are you sure you want to wipe Aria's memory locally and on Firebase?")) {
        await clearUserMemory();
        await saveMemoryToFirebase({}); // Clear Firebase
        await refreshMemoryDisplay();
    }
  };

  const handleSaveCredentials = () => {
    const newApiKey = inputKey.trim();
    if (!newApiKey) {
        setErrorMessage("Gemini API Key is required.");
        return;
    }

    setApiKey(newApiKey);
    localStorage.setItem('gemini_api_key', newApiKey);
    setErrorMessage('');
  };

  const handleResetCredentials = () => {
    isIntentionalCloseRef.current = true;
    fullCleanup();
    setApiKey('');
    setInputKey('');
    localStorage.removeItem('gemini_api_key');
    setConnectionState(ConnectionState.DISCONNECTED);
  };

  const requestWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      }
    } catch (err) {
      console.warn('Wake Lock request failed:', err);
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      } catch (err) {}
    }
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && 
         (connectionState === ConnectionState.CONNECTED || connectionState === ConnectionState.RECONNECTING)) {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [connectionState, requestWakeLock]);

  const fullCleanup = useCallback(() => {
    if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    releaseWakeLock();

    // Reset Visualizers
    setInputAnalyser(null);
    setOutputAnalyser(null);

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (outputGainRef.current) {
        outputGainRef.current.disconnect();
        outputGainRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (audioInputContextRef.current) {
      audioInputContextRef.current.close();
      audioInputContextRef.current = null;
    }
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, [releaseWakeLock]);

  const closeSession = useCallback(async () => {
    if (sessionPromiseRef.current) {
        try {
            const session = await sessionPromiseRef.current;
            if (session && typeof session.close === 'function') {
                session.close();
            }
        } catch (e) {
            console.error("Error closing session", e);
        }
        sessionPromiseRef.current = null;
    }
  }, []);

  const initAudioContexts = async () => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ 
        sampleRate: 24000, latencyHint: 'interactive'
      });
      
      // Setup Output Analyser
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      
      const gain = ctx.createGain();
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      
      outputGainRef.current = gain;
      setOutputAnalyser(analyser);
      audioContextRef.current = ctx;
    }
    
    if (!audioInputContextRef.current || audioInputContextRef.current.state === 'closed') {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ 
        sampleRate: 16000, latencyHint: 'interactive' 
      });
      audioInputContextRef.current = ctx;
    }

    await audioContextRef.current.resume();
    await audioInputContextRef.current.resume();
  };

  const initMicStream = async () => {
    if (!streamRef.current) {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ 
        audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true } 
      });
    }
    return streamRef.current;
  };

  const connect = async (isReconnect = false) => {
    setErrorMessage('');
    if (!apiKey) {
        setErrorMessage("API Key is missing.");
        setConnectionState(ConnectionState.ERROR);
        return;
    }

    try {
      setConnectionState(isReconnect ? ConnectionState.RECONNECTING : ConnectionState.CONNECTING);
      
      await initAudioContexts();
      await requestWakeLock();
      
      if (!workletNodeRef.current) {
         try {
             const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
             const workletUrl = URL.createObjectURL(blob);
             if (audioInputContextRef.current) {
                 await audioInputContextRef.current.audioWorklet.addModule(workletUrl);
             }
         } catch (e) {}
      }

      const stream = await initMicStream();

      // --- Sync Memory from Firebase ---
      if (!isReconnect) {
          setIsSyncing(true);
          try {
             const fbMemory = await loadMemoryFromFirebase();
             if (fbMemory) {
                 // Update local DB with Firebase data
                 const keys = Object.keys(fbMemory);
                 for (const k of keys) {
                     await updateUserMemory(k, fbMemory[k]);
                 }
             }
          } catch(e) {
              console.error("Failed to sync from Firebase", e);
          }
          setIsSyncing(false);
      }
      // ---------------------------------
      
      const userProfile = await getUserProfile();
      await setMemoryData(userProfile);
      const recentHistory = await getRecentHistory(4);
      
      const contextString = recentHistory.length > 0 
        ? `\n\nRecent Conversation Context:\n${recentHistory.map(h => `${h.role}: ${h.text}`).join('\n')}`
        : '';

      const systemInstruction = `Your name is Aria. You are a helpful, witty, and personalized AI assistant.
      
      *** MEMORY FILE (memory.json) ***
      I have read the "memory.json" file and here is its current content:
      ${JSON.stringify(userProfile, null, 2)}
      
      *** INSTRUCTIONS ***
      1. **USE MEMORY**: Use the data in "memory.json" to answer questions about the user.
      2. **UPDATE MEMORY**: If the user asks you to remember something, use the 'update_user_memory' tool.
      3. **LANGUAGE**: Speak fluently in Gujarati, Hindi, or English.
      4. **BEHAVIOR**: Be concise. You are having a real-time voice conversation. Don't be too verbose.

      ${contextString}`;

      const ai = new GoogleGenAI({ apiKey: apiKey });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
          },
          tools: [
            { googleSearch: {} },
            { functionDeclarations: [updateMemoryTool] }
          ],
          outputAudioTranscription: {}, 
          inputAudioTranscription: {},
          systemInstruction: systemInstruction,
        },
        callbacks: {
            onopen: () => {
                console.log("Session Opened");
                setConnectionState(ConnectionState.CONNECTED);
                isIntentionalCloseRef.current = false; 

                if (!audioInputContextRef.current || !stream) return;
                
                // Cleanup old input nodes
                if (sourceNodeRef.current) sourceNodeRef.current.disconnect();
                if (workletNodeRef.current) workletNodeRef.current.disconnect();

                // Setup Input Analyser (User Voice Visualization)
                const analyser = audioInputContextRef.current.createAnalyser();
                analyser.fftSize = 256;
                analyser.smoothingTimeConstant = 0.5;
                setInputAnalyser(analyser);

                const source = audioInputContextRef.current.createMediaStreamSource(stream);
                sourceNodeRef.current = source;
                
                const workletNode = new AudioWorkletNode(audioInputContextRef.current, 'audio-processor');
                workletNodeRef.current = workletNode;
                
                // Graph: Source -> Analyser -> Worklet -> Destination
                source.connect(analyser);
                analyser.connect(workletNode);
                workletNode.connect(audioInputContextRef.current.destination);

                const inputSampleRate = audioInputContextRef.current.sampleRate;

                workletNode.port.onmessage = (event) => {
                    const inputData = event.data;
                    const pcmBlob = float32To16BitPCM(inputData, inputSampleRate);
                    sessionPromise.then((session) => {
                         session.sendRealtimeInput({ media: pcmBlob });
                    }).catch(() => {});
                };
            },
            onmessage: async (message: LiveServerMessage) => {
                if (message.toolCall) {
                    const responses = [];
                    for (const fc of message.toolCall.functionCalls) {
                        if (fc.name === 'update_user_memory') {
                            const { key, value } = fc.args as any;
                            await updateUserMemory(key, value);
                            
                            // Re-fetch full memory to ensure consistency
                            const newProfile = await getUserProfile();
                            await setMemoryData(newProfile); 
                            
                            // Sync to Firebase
                            setIsSyncing(true);
                            saveMemoryToFirebase(newProfile)
                                .then(() => console.log("Firebase sync complete"))
                                .catch(err => console.error("Firebase sync failed", err))
                                .finally(() => setIsSyncing(false));

                            responses.push({
                                id: fc.id,
                                name: fc.name,
                                response: { result: "Saved." }
                            });
                        }
                    }
                    if (responses.length > 0) {
                        sessionPromise.then(s => s.sendToolResponse({ functionResponses: responses }));
                    }
                }

                const serverContent = message.serverContent;
                if (serverContent) {
                    if (serverContent.inputTranscription) {
                        currentInputTransRef.current += serverContent.inputTranscription.text;
                    }
                    if (serverContent.outputTranscription) {
                        currentOutputTransRef.current += serverContent.outputTranscription.text;
                    }
                    
                    if (serverContent.turnComplete) {
                        if (currentInputTransRef.current) await addHistoryItem('user', currentInputTransRef.current);
                        if (currentOutputTransRef.current) await addHistoryItem('model', currentOutputTransRef.current);
                        
                        currentInputTransRef.current = '';
                        currentOutputTransRef.current = '';
                    }

                    const modelTurn = serverContent.modelTurn;
                    const groundingChunks = 
                        serverContent.groundingMetadata?.groundingChunks || 
                        (modelTurn as any)?.groundingMetadata?.groundingChunks ||
                        (modelTurn?.parts?.find((p: any) => (p as any).groundingMetadata) as any)?.groundingMetadata?.groundingChunks;

                    if (groundingChunks && Array.isArray(groundingChunks)) {
                        const newSources = groundingChunks
                            .filter((c: any) => c.web)
                            .map((c: any) => ({ web: { title: c.web.title, uri: c.web.uri } }));
                        if (newSources.length > 0) {
                            setSources(prev => [...newSources, ...prev].slice(0, 5));
                        }
                    }

                    const base64Audio = modelTurn?.parts?.[0]?.inlineData?.data;
                    if (base64Audio && audioContextRef.current && outputGainRef.current) {
                        try {
                            const uint8 = base64ToUint8Array(base64Audio);
                            const audioBuffer = pcmToAudioBuffer(uint8, audioContextRef.current);
                            
                            // Prevent overlapping / glitching by scheduling correctly
                            if (nextStartTimeRef.current < audioContextRef.current.currentTime) {
                                nextStartTimeRef.current = audioContextRef.current.currentTime;
                            }
                            
                            const source = audioContextRef.current.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(outputGainRef.current); // Connect to Gain (which goes to Analyser)
                            
                            source.onended = () => {
                                activeSourcesRef.current.delete(source);
                            };
                            
                            source.start(nextStartTimeRef.current);
                            activeSourcesRef.current.add(source);
                            nextStartTimeRef.current += audioBuffer.duration;
                        } catch (err) {}
                    }
                    
                    if (serverContent.interrupted) {
                        activeSourcesRef.current.forEach(s => s.stop());
                        activeSourcesRef.current.clear();
                        nextStartTimeRef.current = 0;
                    }
                }
            },
            onclose: (e) => {
                console.log("Session closed", e);
                if (!isIntentionalCloseRef.current) {
                    setConnectionState(ConnectionState.RECONNECTING);
                    closeSession(); 
                    retryTimeoutRef.current = window.setTimeout(() => {
                        connect(true);
                    }, 2000); 
                } else {
                    fullCleanup();
                    setConnectionState(ConnectionState.DISCONNECTED);
                }
            },
            onerror: (err) => {
                console.error("Session error", err);
            }
        }
      });
      
      sessionPromiseRef.current = sessionPromise;
      sessionPromise.catch(err => {
         console.error("Connect failed", err);
         if (!isIntentionalCloseRef.current) {
             setConnectionState(ConnectionState.RECONNECTING);
             retryTimeoutRef.current = window.setTimeout(() => connect(true), 3000);
         } else {
             setErrorMessage(err.message || "Failed to connect.");
             setConnectionState(ConnectionState.ERROR);
             fullCleanup();
         }
      });

    } catch (error: any) {
      console.error("Setup failed", error);
      if (!isIntentionalCloseRef.current) {
         retryTimeoutRef.current = window.setTimeout(() => connect(true), 3000);
      } else {
         setErrorMessage(error.message);
         setConnectionState(ConnectionState.ERROR);
         fullCleanup();
      }
    }
  };

  const manualDisconnect = () => {
    isIntentionalCloseRef.current = true;
    disconnect();
  };

  const disconnect = async () => {
    await closeSession();
    if (isIntentionalCloseRef.current) {
        fullCleanup();
        setConnectionState(ConnectionState.DISCONNECTED);
    }
  };

  useEffect(() => {
    return () => {
      isIntentionalCloseRef.current = true;
      fullCleanup();
    };
  }, [fullCleanup]);

  // --- LOGIN SCREEN WITH GEMINI API KEY ONLY ---
  if (!apiKey) {
    return (
      <div className="w-full max-w-md bg-slate-900 rounded-3xl overflow-hidden shadow-2xl border border-slate-800 p-8">
        <div className="flex flex-col items-center gap-6">
          <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center text-3xl">🔑</div>
          <div className="text-center">
            <h2 className="text-xl font-semibold text-white mb-2">Setup Aria</h2>
            <p className="text-sm text-slate-400">Enter your Google Gemini API Key to enable Voice.</p>
            <p className="text-[10px] text-slate-500 mt-1">Firebase Memory is already configured.</p>
          </div>
          
          <div className="w-full space-y-4">
            <div>
                <label className="text-xs text-slate-500 uppercase font-bold ml-1">Gemini API Key</label>
                <input
                type="password"
                placeholder="Paste Gemini API Key"
                value={inputKey}
                onChange={(e) => setInputKey(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 text-white rounded-xl px-4 py-3 mt-1 focus:outline-none focus:border-blue-500"
                />
            </div>
            
            {errorMessage && (
                <p className="text-red-400 text-xs text-center">{errorMessage}</p>
            )}
          </div>

          <button onClick={handleSaveCredentials} className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-3 rounded-xl transition-colors">
            Start Assistant
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md flex flex-col gap-4">
    <div className="w-full bg-slate-900 rounded-3xl overflow-hidden shadow-2xl border border-slate-800 relative">
      
      {/* Settings Bar */}
      <div className="absolute top-4 right-4 z-20 flex gap-2">
         {connectionState === ConnectionState.DISCONNECTED && (
             <div className="relative group">
                <select 
                    value={selectedVoice}
                    onChange={(e) => setSelectedVoice(e.target.value)}
                    className="appearance-none bg-slate-800 text-xs text-slate-300 rounded-full px-3 py-1.5 pr-6 border border-slate-700 focus:outline-none focus:border-blue-500 cursor-pointer"
                >
                    {VOICES.map(v => <option key={v.name} value={v.name}>{v.label}</option>)}
                </select>
                <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-slate-500 text-[10px]">▼</div>
             </div>
         )}
         <button
            onClick={() => setShowMemory(!showMemory)}
            className={`rounded-full w-8 h-8 flex items-center justify-center transition-all border border-slate-700
                ${showMemory ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}
            `}
            title="View Memory"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
          </button>
      </div>

      <div className="p-8 pb-4 flex flex-col items-center">
        
        <Visualizer 
            state={connectionState} 
            inputAnalyser={inputAnalyser}
            outputAnalyser={outputAnalyser}
        />

        <div className="mt-8 mb-4 w-full flex justify-center gap-4">
          <button
            onClick={() => {
                if (connectionState === ConnectionState.DISCONNECTED || connectionState === ConnectionState.ERROR) {
                    isIntentionalCloseRef.current = false;
                    connect();
                } else {
                    manualDisconnect();
                }
            }}
            className={`
                relative group rounded-full p-4 transition-all duration-300
                ${(connectionState === ConnectionState.CONNECTED || connectionState === ConnectionState.RECONNECTING)
                    ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/50' 
                    : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/50'
                }
            `}
          >
             <div className={`absolute inset-0 rounded-full blur opacity-0 group-hover:opacity-50 transition-opacity duration-300
                ${(connectionState === ConnectionState.CONNECTED || connectionState === ConnectionState.RECONNECTING) ? 'bg-red-500' : 'bg-blue-400'}
             `}></div>

            <div className="relative z-10 w-16 h-16 flex items-center justify-center">
                {(connectionState === ConnectionState.CONNECTED || connectionState === ConnectionState.RECONNECTING) ? (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-8 h-8">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-8 h-8">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                    </svg>
                )}
            </div>
          </button>
        </div>

        <div className="text-center h-6">
            <p className="text-slate-500 text-sm font-medium">
                {isSyncing ? "Syncing memory with Firebase..." : (
                    <>
                        {connectionState === ConnectionState.DISCONNECTED && `Tap to talk to ${selectedVoice}`}
                        {connectionState === ConnectionState.CONNECTING && "Connecting..."}
                        {connectionState === ConnectionState.RECONNECTING && "Reconnecting..."}
                        {connectionState === ConnectionState.CONNECTED && "Listening..."}
                        {connectionState === ConnectionState.ERROR && (errorMessage || "Connection failed.")}
                    </>
                )}
            </p>
        </div>
      </div>
      
      {/* Memory Viewer Panel */}
      {showMemory && (
        <div className="border-t border-slate-800 bg-slate-950 p-4 animate-in slide-in-from-bottom-5">
            <div className="flex justify-between items-center mb-2">
                <h3 className="text-sm font-semibold text-slate-400">Memory (Local & Firebase)</h3>
                <div className="flex gap-2">
                     <button onClick={handleManualSync} className="text-xs text-green-400 hover:text-green-300 hover:underline">Sync Cloud</button>
                    <button onClick={handleClearMemory} className="text-xs text-red-400 hover:text-red-300 hover:underline">Clear All</button>
                    <button onClick={handleDownloadMemory} className="text-xs text-blue-400 hover:text-blue-300 hover:underline">Download .json</button>
                </div>
            </div>
            <div className="w-full bg-slate-900 rounded-lg p-3 overflow-x-auto border border-slate-800">
                <pre className="text-xs text-green-400 font-mono">
                    {Object.keys(memoryData).length === 0 ? "// Memory is empty" : JSON.stringify(memoryData, null, 2)}
                </pre>
            </div>
        </div>
      )}

      <div className="bg-slate-950 px-6 py-4 flex justify-between items-center text-xs text-slate-600 border-t border-slate-800">
         <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full 
                ${isSyncing ? 'bg-blue-500 animate-pulse' : (
                  connectionState === ConnectionState.CONNECTED ? 'bg-green-500' : 
                  (connectionState === ConnectionState.RECONNECTING || connectionState === ConnectionState.CONNECTING ? 'bg-yellow-500' : 
                  (connectionState === ConnectionState.ERROR ? 'bg-red-500' : 'bg-slate-700'))
                )}
            `}></span>
            {isSyncing ? 'Syncing...' : connectionState}
         </div>
         <button onClick={handleResetCredentials} className="text-slate-500 hover:text-white transition-colors">
            Reset API Key
         </button>
      </div>
    </div>

    {/* Grounding Sources Panel */}
    {sources.length > 0 && (
        <div className="w-full bg-slate-900/80 rounded-2xl p-4 border border-slate-800 backdrop-blur-sm shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-500">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
                Sources
            </h3>
            <div className="flex flex-wrap gap-2">
                {sources.map((source, idx) => (
                    <a 
                        key={idx}
                        href={source.web?.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs bg-slate-800 hover:bg-slate-700 text-blue-400 border border-slate-700 rounded-lg px-3 py-2 transition-colors flex items-center gap-2 max-w-full truncate"
                    >
                        <span className="truncate">{source.web?.title}</span>
                        <svg className="w-3 h-3 flex-shrink-0 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    </a>
                ))}
            </div>
        </div>
    )}
    </div>
  );
};

export default VoiceAssistant;
