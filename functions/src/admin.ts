// Firebase Admin SDK singleton for all functions.
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";

if (getApps().length === 0) {
  initializeApp();
}

export const db = getFirestore();
export const rtdb = getDatabase();
