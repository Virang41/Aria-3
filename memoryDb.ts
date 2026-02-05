const DB_NAME = 'AriaVoiceAssistantDB';
const DB_VERSION = 1;
const STORE_PROFILE = 'user_profile';
const STORE_HISTORY = 'conversation_history';

// Types
export interface UserProfile {
  [key: string]: any;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

// Open DB Helper
const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_PROFILE)) {
        db.createObjectStore(STORE_PROFILE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: 'timestamp' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

// Profile Operations
export const getUserProfile = async (): Promise<UserProfile> => {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_PROFILE, 'readonly');
    const store = tx.objectStore(STORE_PROFILE);
    const request = store.getAll();
    request.onsuccess = () => {
      const result = request.result || [];
      // Convert array of {key, value} back to object
      const profile: UserProfile = {};
      result.forEach((item: any) => {
        profile[item.key] = item.value;
      });
      resolve(profile);
    };
  });
};

export const updateUserMemory = async (key: string, value: any): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROFILE, 'readwrite');
    const store = tx.objectStore(STORE_PROFILE);
    store.put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const clearUserMemory = async (): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROFILE, 'readwrite');
    const store = tx.objectStore(STORE_PROFILE);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

// History Operations
export const addHistoryItem = async (role: 'user' | 'model', text: string): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    // Keep only last 20 items to save space, logic could be added here
    store.put({ role, text, timestamp: Date.now() });
    tx.oncomplete = () => resolve();
  });
};

export const getRecentHistory = async (limit: number = 5): Promise<ChatMessage[]> => {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_HISTORY, 'readonly');
    const store = tx.objectStore(STORE_HISTORY);
    const request = store.getAll();
    request.onsuccess = () => {
      const res = request.result as ChatMessage[];
      // Sort by timestamp desc and take last N
      res.sort((a, b) => a.timestamp - b.timestamp);
      resolve(res.slice(-limit));
    };
  });
};
