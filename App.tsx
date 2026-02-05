import React from 'react';
import VoiceAssistant from './components/VoiceAssistant';

const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 relative">
      {/* Background Decor */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
         <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-blue-900/10 rounded-full blur-[100px]"></div>
         <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-indigo-900/10 rounded-full blur-[100px]"></div>
      </div>

      <div className="z-10 w-full flex flex-col items-center gap-6">
        <div className="text-center mb-4">
          <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-300">
            Aria
          </h1>
          <p className="text-slate-400 mt-2">Multilingual Assistant (Gujarati, Hindi, English)</p>
        </div>
        
        <VoiceAssistant />
      </div>
    </div>
  );
};

export default App;