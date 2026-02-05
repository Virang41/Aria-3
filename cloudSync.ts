
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/files';
const UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';

interface GeminiFile {
  name: string; // "files/..."
  displayName: string;
  uri: string;
  state: string;
}

export async function listFiles(apiKey: string): Promise<GeminiFile[]> {
  try {
    const response = await fetch(`${BASE_URL}?pageSize=100&key=${apiKey}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.files || [];
  } catch (e) {
    console.error("Failed to list files", e);
    return [];
  }
}

export async function deleteFile(apiKey: string, fileName: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/${fileName}?key=${apiKey}`, { method: 'DELETE' });
  } catch (e) {
    console.error(`Failed to delete file ${fileName}`, e);
  }
}

export async function uploadMemoryFile(apiKey: string, jsonString: string): Promise<GeminiFile | null> {
  try {
    const blob = new Blob([jsonString], { type: 'application/json' });
    const metadata = { file: { displayName: 'ARIA_MEMORY.json' } };

    const formData = new FormData();
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    formData.append('file', blob);

    const response = await fetch(`${UPLOAD_URL}?key=${apiKey}`, {
      method: 'POST',
      body: formData,
    });
    
    if (!response.ok) {
        console.error("Upload failed", await response.text());
        return null;
    }
    
    const data = await response.json();
    return data.file;
  } catch (e) {
    console.error("Failed to upload memory file", e);
    return null;
  }
}

/**
 * Finds the memory file, reads it (by asking the model), and returns the parsed object.
 * Returns null if no file found or error.
 */
export async function fetchCloudMemory(apiKey: string, aiClient: any): Promise<any | null> {
    const files = await listFiles(apiKey);
    const memoryFile = files.find(f => f.displayName === 'ARIA_MEMORY.json');
    
    if (!memoryFile) return null;

    // We need to wait for the file to be active? Usually small JSONs are active immediately.
    // However, to read it, we must use a model generation.
    try {
        const response = await aiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: {
                parts: [
                    { fileData: { mimeType: 'application/json', fileUri: memoryFile.uri } },
                    { text: "Output ONLY the raw JSON content of this file. Do not use markdown formatting. Do not add any text before or after." }
                ]
            }
        });

        const text = response.text;
        if (!text) return null;
        
        // Clean potential markdown code blocks
        const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanJson);
    } catch (e) {
        console.error("Failed to read cloud memory", e);
        return null;
    }
}

export async function saveCloudMemory(apiKey: string, memoryObj: any): Promise<void> {
    const jsonString = JSON.stringify(memoryObj, null, 2);
    
    // 1. List existing
    const files = await listFiles(apiKey);
    const oldFiles = files.filter(f => f.displayName === 'ARIA_MEMORY.json');
    
    // 2. Upload NEW first (to ensure we have data)
    const newFile = await uploadMemoryFile(apiKey, jsonString);
    if (!newFile) return; // Failed to save
    
    // 3. Delete OLD files
    for (const f of oldFiles) {
        await deleteFile(apiKey, f.name);
    }
}
