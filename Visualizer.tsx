import React, { useEffect, useRef } from 'react';
import { ConnectionState } from '../types';

interface VisualizerProps {
  state: ConnectionState;
  inputAnalyser: AnalyserNode | null;
  outputAnalyser: AnalyserNode | null;
}

const Visualizer: React.FC<VisualizerProps> = ({ state, inputAnalyser, outputAnalyser }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;
      const centerX = width / 2;
      const centerY = height / 2;
      
      ctx.clearRect(0, 0, width, height);

      if (state !== ConnectionState.CONNECTED) {
        // Idle Animation
        const time = Date.now() / 1000;
        ctx.beginPath();
        const radius = 30 + Math.sin(time * 2) * 2;
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        
        if (state === ConnectionState.CONNECTING || state === ConnectionState.RECONNECTING) {
             ctx.fillStyle = 'rgba(59, 130, 246, 0.5)'; // Blue pulse
             ctx.shadowBlur = 20;
             ctx.shadowColor = '#3b82f6';
        } else if (state === ConnectionState.ERROR) {
             ctx.fillStyle = 'rgba(239, 68, 68, 0.5)'; // Red
             ctx.shadowBlur = 0;
        } else {
             ctx.fillStyle = 'rgba(71, 85, 105, 0.5)'; // Slate
             ctx.shadowBlur = 0;
        }
        
        ctx.fill();
        animationRef.current = requestAnimationFrame(render);
        return;
      }

      // --- Active Visualizer ---
      
      // 1. Get Data
      let dataArray = new Uint8Array(0);
      let isOutput = false;

      // Prioritize Output (Model Speaking)
      if (outputAnalyser) {
          const bufferLength = outputAnalyser.frequencyBinCount;
          const outData = new Uint8Array(bufferLength);
          outputAnalyser.getByteFrequencyData(outData);
          
          // Check if there is actual sound energy
          const sum = outData.reduce((a, b) => a + b, 0);
          if (sum > 500) { // Threshold to detect speaking
              dataArray = outData;
              isOutput = true;
          }
      }

      // If Model not speaking, check Input (User Mic)
      if (!isOutput && inputAnalyser) {
          const bufferLength = inputAnalyser.frequencyBinCount;
          const inData = new Uint8Array(bufferLength);
          inputAnalyser.getByteFrequencyData(inData);
          dataArray = inData;
      }

      if (dataArray.length === 0) {
          // Connected but silence
          ctx.beginPath();
          ctx.arc(centerX, centerY, 30, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
          ctx.fill();
          animationRef.current = requestAnimationFrame(render);
          return;
      }

      // 2. Draw Circular Wave
      const bars = 60;
      const radius = 40;
      const step = (Math.PI * 2) / bars;

      // Visual Style based on who is talking
      if (isOutput) {
          ctx.strokeStyle = '#60a5fa'; // Blue for AI
          ctx.fillStyle = '#2563eb';
          ctx.shadowColor = '#3b82f6';
      } else {
          ctx.strokeStyle = '#f472b6'; // Pink/Purple for User
          ctx.fillStyle = '#db2777';
          ctx.shadowColor = '#ec4899';
      }
      
      ctx.shadowBlur = 15;
      ctx.lineWidth = 2;

      ctx.beginPath();
      for (let i = 0; i < bars; i++) {
        // Map frequency data to bar height
        // Focus on lower frequencies for voice (indices 0-30 roughly for FFT 256)
        const dataIndex = Math.floor((i / bars) * (dataArray.length / 2)); 
        const value = dataArray[dataIndex] || 0;
        
        const barHeight = (value / 255) * 60; 
        const angle = i * step;

        // Start point (inner circle)
        const x1 = centerX + Math.cos(angle) * (radius);
        const y1 = centerY + Math.sin(angle) * (radius);
        
        // End point (outer)
        const x2 = centerX + Math.cos(angle) * (radius + barHeight + 5);
        const y2 = centerY + Math.sin(angle) * (radius + barHeight + 5);

        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();

      // Center orb
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius - 5, 0, Math.PI * 2);
      ctx.fill();

      animationRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [state, inputAnalyser, outputAnalyser]);

  return (
    <div className="h-48 flex items-center justify-center w-full">
      <canvas 
        ref={canvasRef} 
        width={400} 
        height={300} 
        className="w-full h-full object-contain"
      />
    </div>
  );
};

export default Visualizer;
