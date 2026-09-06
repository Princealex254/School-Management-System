/**
 * ============================================================
 * ShuleSmart — Firebase Configuration
 * Product by Prince Alex Digital
 * ============================================================
 *
 * Purpose of this file:
 *   - Initialize the Firebase application (once, for the whole app).
 *   - Initialize Firebase Authentication.
 *   - Export the shared `app` and `auth` instances so that any other
 *     script (login.html, future dashboard pages, role-based routing,
 *     etc.) can import and reuse the SAME Firebase instance instead
 *     of re-initializing Firebase multiple times.
 *
 * This file intentionally contains NO login logic, NO UI code, and
 * NO Firebase Analytics setup. It is a single-responsibility module:
 * configuration + initialization + exports only.
 * ============================================================
 */

// Firebase modular SDK imports (v10.14.1)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
// MODULAR Firestore. The classic chainable surface (db.collection()…)
// used by the ShuleSmart engines is provided by firestore-db.js (shim).
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/**
 * ShuleSmart Firebase project configuration.
 * This identifies which Firebase project this app talks to.
 */
const firebaseConfig = {
    apiKey: "AIzaSyCe4zBkbLEMTobEPiqfDtVmEImDTB6GbGM",
    authDomain: "schoolmanagementsaas-a7bad.firebaseapp.com",
    projectId: "schoolmanagementsaas-a7bad",
    storageBucket: "schoolmanagementsaas-a7bad.firebasestorage.app",
    messagingSenderId: "133538484653",
    appId: "1:133538484653:web:d8634d4485e56ad0379124",
    measurementId: "G-DSDCG8MY5E"
};

// Initialize the Firebase app exactly once for the entire application.
const app = initializeApp(firebaseConfig);

// Initialize Firebase Authentication using the initialized app instance.
// Note: Firebase Analytics is intentionally NOT initialized here — it is
// not required for authentication and can cause issues in some
// environments (e.g. when running outside a standard browser context).
const auth = getAuth(app);

// Initialize Firestore for role-based access checks (e.g. the "users"
// collection where each user document carries their platform role).
const db = getFirestore(app);

// Export the shared instances for use across the ShuleSmart platform.
export { app, auth, db };
