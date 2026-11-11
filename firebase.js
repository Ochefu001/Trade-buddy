import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD1LtNwrayf1mDoLxfQantZdAi02EvBlVo",
  authDomain: "trade-buddy-25dee.firebaseapp.com",
  projectId: "trade-buddy-25dee",
  storageBucket: "trade-buddy-25dee.firebasestorage.app",
  messagingSenderId: "363066163554",
  appId: "1:363066163554:web:834407c5eaf3b6805c6c3b"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Page to open after a successful login or sign-up
export const AFTER_LOGIN = "dashboard.html";

export function friendlyError(code) {
  var m = {
    "auth/email-already-in-use": "That email already has an account. Try logging in instead.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/weak-password": "Choose a stronger password with at least 8 characters.",
    "auth/invalid-credential": "Wrong email or password.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
    "auth/network-request-failed": "No internet connection. Check your network and retry.",
    "auth/unauthorized-domain": "This website address isn't authorised in Firebase yet.",
    "auth/operation-not-allowed": "Email login isn't switched on in Firebase yet.",
    "permission-denied": "Saving was blocked by the database rules. Check that your Firestore rules are published."
  };
  return m[code] || "Something went wrong. Please try again.";
}
