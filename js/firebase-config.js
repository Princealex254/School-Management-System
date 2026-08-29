/**
 * ============================================================
 * ShuleSmart — School Admin Firebase Configuration
 * Product by Prince Alex Digital
 * ============================================================
 * Initializes the SAME Firebase project used by the rest of the
 * platform. Loaded only by school-admin pages, so there is no
 * duplicate initialization within a single page load.
 * Exports the shared app, auth and Firestore instances.
 * ============================================================
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
// MODULAR Firestore. The classic chainable surface (db.collection()…)
// used by the ShuleSmart engines is provided by firestore-db.js (shim).
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCe4zBkbLEMTobEPiqfDtVmEImDTB6GbGM",
  authDomain: "schoolmanagementsaas-a7bad.firebaseapp.com",
  projectId: "schoolmanagementsaas-a7bad",
  storageBucket: "schoolmanagementsaas-a7bad.firebasestorage.app",
  messagingSenderId: "133538484653",
  appId: "1:133538484653:web:d8634d4485e56ad0379124",
  measurementId: "G-DSDCG8MY5E"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };