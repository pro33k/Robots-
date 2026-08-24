import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDNBYMMBSz2ZINXoIirST18OBI8sAW9jUI",
  authDomain: "vortex-76dd2.firebaseapp.com",
  projectId: "vortex-76dd2",
  storageBucket: "vortex-76dd2.firebasestorage.app",
  messagingSenderId: "512660258844",
  appId: "1:512660258844:web:923a4582de6c56d4b3dfd9",
  measurementId: "G-LJ2CK5T6BV"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);