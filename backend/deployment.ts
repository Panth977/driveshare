/**
 * Everything that names one deployment of DriveShare. To run your own copy, put your
 * Firebase project and Google OAuth client here (see README › Deploy your own).
 * Nothing in this file is secret: it ships in the web bundle.
 */
export const deployment = {
  projectId: 'driveshare-p977',
  /** Cloud Functions + Firestore region. */
  region: 'asia-south1',
  /** Firebase console › Project settings › Your apps › Web app › Config. */
  webConfig: {
    apiKey: 'AIzaSyAWR8cBuwkE11bVWy2WDSOUZVqBkJBxqUY',
    authDomain: 'driveshare-p977.firebaseapp.com',
    projectId: 'driveshare-p977',
    storageBucket: 'driveshare-p977.firebasestorage.app',
    messagingSenderId: '35301309547',
    appId: '1:35301309547:web:5b09392ee191663ecc852e',
  },
  /** Google Auth Platform › Clients › Web client (its secret goes to Secret Manager as GOOGLE_CLIENT_SECRET). */
  googleClientId: '35301309547-REPLACE.apps.googleusercontent.com',
  /** Extra origins the web app is served from (the two Firebase Hosting ones are always allowed). */
  extraOrigins: [] as string[],
  /** Local dev server. */
  devPort: 5191,
};

export const REGION = deployment.region;

/** Every origin the web app may call the functions from (and start Drive uploads for). */
export const ORIGINS = [
  `https://${deployment.projectId}.web.app`,
  `https://${deployment.projectId}.firebaseapp.com`,
  `http://localhost:${deployment.devPort}`,
  ...deployment.extraOrigins,
];
