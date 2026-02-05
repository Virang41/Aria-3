import { Blob } from '@google/genai';

// Decodes base64 string to Uint8Array
export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Encodes Uint8Array to base64 string
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Converts raw PCM data to an AudioBuffer
export function pcmToAudioBuffer(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1
): AudioBuffer {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      // Convert Int16 to Float32 (-1.0 to 1.0)
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

/**
 * Downsamples AudioBuffer to target sample rate using simple linear interpolation/decimation.
 * This is "good enough" for speech recognition purposes.
 */
function downsampleBuffer(buffer: Float32Array, inputSampleRate: number, targetSampleRate: number): Float32Array {
  if (inputSampleRate === targetSampleRate) {
    return buffer;
  }
  if (inputSampleRate < targetSampleRate) {
    throw new Error("Upsampling is not supported");
  }
  
  const sampleRateRatio = inputSampleRate / targetSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  
  for (let i = 0; i < newLength; i++) {
    // Simple decimation/nearest neighbor
    const originalIndex = Math.round(i * sampleRateRatio);
    // Boundary check
    if (originalIndex < buffer.length) {
        result[i] = buffer[originalIndex];
    }
  }
  
  return result;
}

// Converts Float32 audio data (from microphone) to Gemin-compatible PCM blob (16kHz)
export function float32To16BitPCM(float32Data: Float32Array, inputSampleRate: number): Blob {
  const targetSampleRate = 16000;
  
  // Downsample if necessary
  const processedData = downsampleBuffer(float32Data, inputSampleRate, targetSampleRate);
  
  const l = processedData.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    // Clamp values to -1 to 1 and scale to Int16 range
    const s = Math.max(-1, Math.min(1, processedData[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  
  return {
    data: uint8ArrayToBase64(new Uint8Array(int16.buffer)),
    mimeType: `audio/pcm;rate=${targetSampleRate}`,
  };
}