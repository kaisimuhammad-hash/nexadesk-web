import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let firestoreInstance = null;

export function getFirestoreDb() {
  if (firestoreInstance) return firestoreInstance;
  if (getApps().length > 0) {
    firestoreInstance = getFirestore();
    return firestoreInstance;
  }

  try {
    const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (serviceAccountVar) {
      let serviceAccount;
      try {
        serviceAccount = JSON.parse(serviceAccountVar);
      } catch {
        // jika base64
        serviceAccount = JSON.parse(Buffer.from(serviceAccountVar, 'base64').toString('utf8'));
      }
      initializeApp({
        credential: cert(serviceAccount),
      });
      firestoreInstance = getFirestore();
      console.log('[firebase] Berhasil terhubung ke Firestore via FIREBASE_SERVICE_ACCOUNT');
      return firestoreInstance;
    }

    if (
      process.env.FIREBASE_CONFIG ||
      process.env.GCP_PROJECT ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.K_SERVICE
    ) {
      initializeApp();
      firestoreInstance = getFirestore();
      console.log('[firebase] Berhasil terhubung ke Firestore via Default Credentials');
      return firestoreInstance;
    }
  } catch (err) {
    console.warn('[firebase] Firestore tidak diinisialisasi (memakai penyimpanan lokal):', err.message);
  }

  return null;
}
