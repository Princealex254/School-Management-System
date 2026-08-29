/**
 * ============================================================
 * ShuleSmart — School Admin Authorization
 * ============================================================
 * requireSchoolAdmin() is called at the top of every protected
 * School Admin page. It:
 *   1. Waits for Firebase auth state.
 *   2. Redirects to login.html if no user is signed in.
 *   3. Asks the Worker (GET /api/auth/me) to identify the user.
 *   4. Confirms  platform_role === "school_admin",
 *                status === "active",
 *                school_id is set  (enforced by the Worker).
 *   5. Exposes window.currentSchool / window.currentAdmin for
 *      display purposes only — the backend remains the authority.
 *
 * No protected data is loaded until this succeeds.
 * ============================================================
 */

import { auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { apiRequest } from "./api.js";
import { canAccessSection, navKeyFromPath } from "./common.js";

let waiters = [];

/*
|--------------------------------------------------------------------------
| LOCAL SESSION CACHE
|--------------------------------------------------------------------------
| After the first successful sign-in we remember who the admin is (display
| purposes only) so the shell/sidebar paints INSTANTLY on every navigation
| instead of waiting on Firebase + a Worker round-trip. The cached session
| is re-validated against the Worker in the background and expires after
| 6 hours. Authorization always remains server-side per request.
*/
const SESSION_CACHE_KEY = "shulesmart_session_cache";
const SESSION_CACHE_TTL = 6 * 60 * 60 * 1000;

function currentFirebaseUser() {
  return new Promise((resolve) => {
    const current = auth.currentUser;
    if (current) {
      resolve(current);
      return;
    }
    // Wait for Firebase to restore a persisted session.
    waiters.push(resolve);
    if (waiters.length === 1) {
      onAuthStateChanged(auth, (user) => {
        const pending = waiters;
        waiters = [];
        pending.forEach((r) => r(user));
      });
    }
  });
}

function exposeContext(user, school) {
  window.currentAdmin = {
    id: user.id,
    firebase_uid: user.firebase_uid,
    name: user.display_name || "School Admin",
    email: user.email,
    phone: user.phone || "",
    photo_url: user.photo_url || "",
    role: user.role || "head",
    menu_access: user.menu_access
  };
  window.currentSchool = {
    id: school.id,
    name: school.name,
    school_code: school.school_code,
    school_type: school.school_type,
    logo_key: school.logo_key || "",
    email: school.email || "",
    phone: school.phone || "",
    county: school.county || "",
    physical_address: school.physical_address || ""
  };
}

function readSessionCache() {
  try {
    const raw = localStorage.getItem(SESSION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ts || !parsed.session || !parsed.session.user || !parsed.session.school) return null;
    if (Date.now() - parsed.ts > SESSION_CACHE_TTL) {
      localStorage.removeItem(SESSION_CACHE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeSessionCache(user, school) {
  try {
    localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify({ ts: Date.now(), session: { user, school } }));
  } catch { /* storage unavailable — slow path still works */ }
}

export function clearSessionCache() {
  try { localStorage.removeItem(SESSION_CACHE_KEY); } catch { /* ignore */ }
}

function isSessionValid(session) {
  const u = session && session.user;
  const s = session && session.school;
  return Boolean(
    u && s &&
    u.platform_role === "school_admin" &&
    u.status === "active" &&
    u.school_id &&
    s.id
  );
}

/* Page-level role gate: every protected school-admin page maps to a nav
   key via its URL; roles outside that menu are stopped here, before any
   page script runs (the sidebar filter is only the visible layer). */
function assertPageAccess(user) {
  const key = navKeyFromPath(window.location.pathname);
  if (!canAccessSection(user, key)) {
    showAccessDenied(`Your account does not have access to this section (${key}).`);
    throw new Error("SECTION_ACCESS_DENIED");
  }
}

async function signOutAndRedirect() {
  clearSessionCache();
  try { await signOut(auth); } catch { /* ignore */ }
  window.location.href = "../login/";
}

let revalidating = false;
function revalidateSessionInBackground() {
  if (revalidating) return;
  revalidating = true;
  (async () => {
    try {
      const session = await apiRequest("/api/auth/me");
      if (!isSessionValid(session)) {
        showAccessDenied("Your account is no longer authorized to access this portal.");
        clearSessionCache();
        try { await signOut(auth); } catch { /* ignore */ }
        return;
      }
      exposeContext(session.user, session.school);
      writeSessionCache(session.user, session.school);
      document.dispatchEvent(new CustomEvent("session:refreshed"));
    } catch (e) {
      /* Offline / transient failure — keep the cached session working.
         Every real API call is still authorized server-side by token. */
      console.warn("ShuleSmart: session revalidation skipped", e && e.message);
    } finally {
      revalidating = false;
    }
  })();
}

export async function requireSchoolAdmin() {
  const cached = readSessionCache();

  /*
   * FAST PATH — a recent trusted session exists locally:
   * paint the shell instantly now, re-validate quietly afterwards.
   */
  if (cached) {
    assertPageAccess(cached.session.user);
    exposeContext(cached.session.user, cached.session.school);
    revalidateSessionInBackground();

    const firebaseUser = await currentFirebaseUser();
    if (!firebaseUser) {
      await signOutAndRedirect();
      throw new Error("School Admin sign-in required.");
    }

    return {
      firebaseUser,
      platformUser: cached.session.user,
      school: cached.session.school
    };
  }

  /*
   * SLOW PATH — first load / expired cache:
   * full Firebase + Worker verification, then cache for next time.
   */
  const firebaseUser =
    await currentFirebaseUser();

  if (!firebaseUser) {
    window.location.href = "../login/";
    throw new Error("School Admin sign-in required.");
  }

  let session;
  try {
    session = await apiRequest("/api/auth/me");
  } catch (error) {
    // Session not authorized on the platform — log out and redirect.
    try { await signOut(auth); } catch { /* ignore */ }
    window.location.href = "../login/";
    throw error;
  }

  if (!isSessionValid(session)) {
    showAccessDenied("Your account is not authorized to access this portal.");
    throw new Error("Access denied.");
  }

  assertPageAccess(session.user);

  exposeContext(session.user, session.school);
  writeSessionCache(session.user, session.school);

  return {
    firebaseUser,
    platformUser: session.user,
    school: session.school
  };
}

/* Convenience accessors. */
export function currentSchool() {
  return window.currentSchool || null;
}

export function currentAdmin() {
  return window.currentAdmin || null;
}

function showAccessDenied(message) {
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0F172A;padding:24px;">
      <div style="max-width:420px;width:100%;background:#fff;border-radius:20px;padding:34px;text-align:center;box-shadow:0 20px 50px rgba(15,23,42,.25);">
        <div style="font-size:38px;margin-bottom:12px;">🔒</div>
        <h1 style="font-family:Inter,system-ui;font-size:20px;margin:0 0 8px;">Access Denied</h1>
        <p style="font-size:14px;color:#64748B;margin:0 0 18px;line-height:1.5;">${message}</p>
        <a href="../login/" style="display:inline-block;background:#2563EB;color:#fff;padding:11px 20px;border-radius:10px;text-decoration:none;font-weight:700;">Go to Login</a>
      </div>
    </div>`;
}