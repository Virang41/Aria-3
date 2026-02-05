import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, Firestore } from 'firebase/firestore';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA0NLX_bMJMkTzdpT5kBTQ59sGZxwA5Cv4",
  authDomain: "vimesta-accc2.firebaseapp.com",
  databaseURL: "https://vimesta-accc2-default-rtdb.firebaseio.com",
  projectId: "vimesta-accc2",
  storageBucket: "vimesta-accc2.firebasestorage.app",
  messagingSenderId: "28709583985",
  appId: "1:28709583985:web:4e690ab272ca373b7d2fd0",
  measurementId: "G-1042R75VTX"
};

let db: Firestore | null = null;
let app: FirebaseApp | null = null;

// Initialize Firebase with the hardcoded config by default
export const initFirebase = (config: any = FIREBASE_CONFIG): boolean => {
  try {
    if (getApps().length === 0) {
      app = initializeApp(config);
    } else {
      app = getApp();
    }
    db = getFirestore(app);
    console.log("Firebase initialized successfully with hardcoded config");
    return true;
  } catch (e) {
    console.error("Firebase init error:", e);
    return false;
  }
};

// Load the entire memory object from Firestore
export const loadMemoryFromFirebase = async (): Promise<any | null> => {
  if (!db) {
      // Try to auto-init if not done yet
      if (!initFirebase()) {
          console.warn("Firebase DB not initialized");
          return null;
      }
  }
  try {
    const docRef = doc(db, 'aria_data', 'user_memory');
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return docSnap.data();
    }
    return {};
  } catch (e) {
    console.error("Error loading from Firebase:", e);
    return null;
  }
};

// Save (Merge) memory to Firestore
export const saveMemoryToFirebase = async (data: any): Promise<void> => {
  if (!db) {
     if (!initFirebase()) return;
  }
  try {
    const docRef = doc(db, 'aria_data', 'user_memory');
    await setDoc(docRef, data, { merge: true });
    console.log("Memory saved to Firebase");
  } catch (e) {
    console.error("Error saving to Firebase:", e);
  }
};
