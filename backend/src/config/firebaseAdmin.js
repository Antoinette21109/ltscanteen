import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const appName = 'ltscanteen';

export function getFirebaseServices() {
  const existingApp = getApps().find((app) => app.name === appName);
  if (existingApp) {
    return { auth: getAuth(existingApp), firestore: getFirestore(existingApp) };
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '');
  } catch (error) {
    const configurationError = new Error('FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON.');
    configurationError.code = 'firebase/configuration-missing';
    throw configurationError;
  }

  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    const configurationError = new Error('Firebase Admin service-account credentials are not configured.');
    configurationError.code = 'firebase/configuration-missing';
    throw configurationError;
  }

  const app = initializeApp({
    credential: cert({
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email,
      privateKey: serviceAccount.private_key
    }),
    projectId: serviceAccount.project_id
  }, appName);

  return { auth: getAuth(app), firestore: getFirestore(app) };
}
