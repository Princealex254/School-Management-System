/**
 * ============================================================
 * ShuleSmart — Firestore Admin / Owner / Promotions Engine
 * Product by Prince Alex Digital
 * ============================================================
 * Ports the remaining worker endpoints to Firestore:
 *   - Owner: schools + school administrators (creates Firebase
 *     Auth accounts through the Identity Toolkit REST API — the
 *     same public-key signUp flow the worker used).
 *   - School admin: dashboard stats, school settings/grading,
 *     self-service profile update.
 *   - Promotions: year rollover preview, batches, mapping,
 *     generation, per-student overrides and completion.
 * ============================================================
 */

import { db } from "./firestore-db.js";
import { isOwnerRole } from "./firestore-data.js";
import { PORTAL_ROLES, ACCESS_KEYS } from "./common.js";

const nowIso = () => new Date().toISOString();
const todayIso = () => new Date().toISOString().slice(0, 10);
const col = (name) => db.collection(name);
/** Document id wins over any stored `id` field (see firestore-data.js). */
const snapDoc = (doc) => ({ ...doc.data(), id: doc.id });
function docsFrom(snap) {
  const out = [];
  snap.forEach((d) => out.push(snapDoc(d)));
  return out;
}
function generateId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
const ts = (v) => {
  if (!v) return 0;
  if (typeof v === "object" && typeof v.toMillis === "function") return v.toMillis();
  const n = Date.parse(String(v));
  return Number.isNaN(n) ? 0 : n;
};

/** Index-safe school-scoped scan: Firestore single-field where("school_id")
 *  plus an in-memory field filter. Mirrors how the rest of the app filters
 *  students by status, so a missing composite index can never silently hide
 *  an existing row (e.g. an open promotion draft) or break a flow. */
async function scanByField(schoolId, collName, field, value, cap = 5000) {
  try {
    const snap = await col(collName).where("school_id", "==", schoolId).limit(cap).get();
    if (snap.empty) return [];
    return docsFrom(snap).filter((d) => d[field] === value);
  } catch (e) {
    console.warn(`ShuleSmart: scan ${collName} unavailable (${e && e.message})`);
    return [];
  }
}

/** Public web API key of the Firebase project (identifier only). */
const FIREBASE_WEB_API_KEY = "AIzaSyCe4zBkbLEMTobEPiqfDtVmEImDTB6GbGM";

async function logAdminActivity(session, action, description) {
  try {
    await col("activity_logs").add({
      school_id: session.user.school_id || null,
      user_id: session.user.id || "",
      user_display_name: session.user.display_name || "System",
      action,
      description,
      created_at: new Date()
    });
  } catch (e) {
    console.warn("ShuleSmart: activity log write failed", e && e.message);
  }
}

/* ==================================================================== */
/*  OWNER: SCHOOLS                                                       */
/* ==================================================================== */

export async function listSchools(session) {
  if (!isOwnerRole(session.user.platform_role)) throw new Error("OWNER_ACCESS_REQUIRED");
  let rows = [];
  const snap = await col("schools").limit(1000).get().catch(() => null);
  if (snap) rows = docsFrom(snap);
  rows = rows.filter((s) => s.status !== "deleted");
  rows.sort((a, b) => ts(b.created_at) - ts(a.created_at));
  return { success: true, schools: rows };
}

export async function createSchool(session, body) {
  if (!isOwnerRole(session.user.platform_role)) throw new Error("OWNER_ACCESS_REQUIRED");
  const name = String(body.name || "").trim();
  const schoolCode = String(body.school_code || "").trim();
  const county = String(body.county || "").trim();
  if (!name || !schoolCode || !county) throw new Error("School name, code and county are required.");

  const dupSnap = await col("schools").where("school_code", "==", schoolCode).limit(1).get();
  let dup = false;
  dupSnap.forEach((d) => { if (d.data().status !== "deleted") dup = true; });
  if (dup) throw new Error("A school with this code already exists.");

  const id = generateId("sch_");
  const school = {
    id, name, school_code: schoolCode,
    school_type: body.school_type || "",
    email: body.email || null,
    phone: body.phone || null,
    county,
    physical_address: body.physical_address || null,
    logo_key: body.logo_key || null,
    status: "active",
    created_by: session.user.id,
    created_at: nowIso(), updated_at: nowIso()
  };
  await col("schools").doc(id).set(school);
  return { success: true, message: "School created successfully.", school };
}

export async function getSchool(session, id) {
  if (!isOwnerRole(session.user.platform_role)) throw new Error("OWNER_ACCESS_REQUIRED");
  const d = await col("schools").doc(id).get();
  if (!d.exists || d.data().status === "deleted") throw new Error("School not found.");
  return { success: true, school: snapDoc(d) };
}

export async function updateSchool(session, id, body) {
  if (!isOwnerRole(session.user.platform_role)) throw new Error("OWNER_ACCESS_REQUIRED");
  const d = await col("schools").doc(id).get();
  if (!d.exists || d.data().status === "deleted") throw new Error("School not found.");
  const ex = d.data();
  const next = {
    name: body.name ? String(body.name).trim() : ex.name,
    school_code: body.school_code ? String(body.school_code).trim() : ex.school_code,
    school_type: body.school_type ?? ex.school_type,
    email: body.email != null ? body.email : ex.email,
    phone: body.phone != null ? body.phone : ex.phone,
    county: body.county ? String(body.county).trim() : ex.county,
    physical_address: body.physical_address != null ? body.physical_address : ex.physical_address,
    status: body.status ?? ex.status,
    updated_at: nowIso()
  };
  await col("schools").doc(id).update(next);
  return { success: true, message: "School updated successfully.", school: { ...ex, ...next } };
}

/** Soft delete (status = deleted), mirroring the worker. */
export async function deleteSchool(session, id) {
  if (!isOwnerRole(session.user.platform_role)) throw new Error("OWNER_ACCESS_REQUIRED");
  const d = await col("schools").doc(id).get();
  if (!d.exists) throw new Error("School not found.");
  await col("schools").doc(id).update({ status: "deleted", updated_at: nowIso() });
  return { success: true, message: "School removed successfully." };
}
/* ==================================================================== */
/*  OWNER: SCHOOL ADMINISTRATORS                                         */
/* ==================================================================== */

export async function listSchoolAdmins(session) {
  if (!isOwnerRole(session.user.platform_role)) throw new Error("OWNER_ACCESS_REQUIRED");
  let rows = [];
  const snap = await col("users").where("platform_role", "==", "school_admin").limit(1000).get().catch(() => null);
  if (snap) rows = docsFrom(snap);
  rows = rows.filter((u) => u.status !== "deleted");
  const schools = new Map();
  const ssnap = await col("schools").limit(1000).get().catch(() => null);
  if (ssnap) ssnap.forEach((d) => schools.set(d.id, d.data()));
  const admins = rows.map((u) => {
    const sch = u.school_id ? schools.get(u.school_id) : null;
    return { ...u, school_name: sch ? sch.name : "", school_code: sch ? sch.school_code : "" };
  });
  admins.sort((a, b) => ts(b.created_at) - ts(a.created_at));
  return { success: true, schoolAdmins: admins };
}

/**
 * Create a school admin: provisions the Firebase Auth account via the
 * Identity Toolkit REST signUp endpoint (does NOT sign the browser in
 * as the new user — parity with the worker's createFirebaseAuthUser).
 */
export async function createSchoolAdmin(session, body) {
  if (!isOwnerRole(session.user.platform_role)) throw new Error("OWNER_ACCESS_REQUIRED");
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const displayName = String(body.display_name || body.name || "").trim();
  const schoolId = String(body.school_id || "");
  if (!email || !password || !displayName || !schoolId) {
    throw new Error("Email, password, name and school are required.");
  }
  if (password.length < 6) throw new Error("The temporary password must be at least 6 characters.");

  const schoolDoc = await col("schools").doc(schoolId).get();
  if (!schoolDoc.exists) throw new Error("School not found.");
  const school = snapDoc(schoolDoc);

  const dupSnap = await col("users").where("email", "==", email).limit(1).get();
  let dupUser = false;
  dupSnap.forEach(() => { dupUser = true; });
  if (dupUser) throw new Error("An account with this email already exists.");

  /* Provision the Firebase Auth account (server-side equivalent flow). */
  let uid = null;
  try {
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_WEB_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, displayName, returnSecureToken: false })
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if ((data.error && data.error.message) === "EMAIL_EXISTS") {
        throw new Error("ADMIN_EMAIL_EXISTS");
      }
      throw new Error("FIREBASE_ACCOUNT_FAILED");
    }
    uid = data.localId;
  } catch (e) {
    if (e && e.message === "ADMIN_EMAIL_EXISTS") throw new Error("An account with this email already exists.");
    if (e && e.message === "FIREBASE_ACCOUNT_FAILED") throw new Error("Could not create the sign-in account. Try again.");
    throw e;
  }

  /* NOTE: the users document is keyed by the Firebase Auth UID so
     Firestore security rules can resolve the caller's profile with a
     direct get() (no query support in rules). */
  const user = {
    id: uid,
    firebase_uid: uid,
    email,
    display_name: displayName,
    phone: body.phone ? String(body.phone).trim() : null,
    photo_url: null,
    platform_role: "school_admin",
    role: PORTAL_ROLES[body.role] ? body.role : "head",
    school_id: schoolId,
    status: "active",
    created_at: nowIso(), updated_at: nowIso()
  };
  await col("users").doc(uid).set(user);
  await logAdminActivity(session, "SCHOOL_ADMIN_CREATED", `School admin created for ${school.name}.`);
  return {
    success: true,
    message: "School admin created successfully.",
    user,
    firebase_uid: uid,
    school: { id: school.id, name: school.name, school_code: school.school_code }
  };
}

export async function updateSchoolAdmin(session, id, body) {
  if (!isOwnerRole(session.user.platform_role)) throw new Error("OWNER_ACCESS_REQUIRED");
  const d = await col("users").doc(id).get();
  if (!d.exists || d.data().platform_role !== "school_admin" || d.data().status === "deleted") {
    throw new Error("School admin not found.");
  }
  const ex = d.data();
  if (body.school_id && body.school_id !== ex.school_id) {
    const s = await col("schools").doc(body.school_id).get();
    if (!s.exists) throw new Error("School not found.");
  }
  const next = {
    display_name: body.display_name ?? ex.display_name,
    phone: body.phone ?? ex.phone,
    role: body.role && PORTAL_ROLES[body.role] ? body.role : (ex.role || "head"),
    school_id: body.school_id ?? ex.school_id,
    status: body.status ?? ex.status,
    updated_at: nowIso()
  };
  await col("users").doc(id).update(next);
  return { success: true, message: "School admin updated successfully.", user: { ...ex, ...next } };
}

export async function toggleSchoolAdminStatus(session, id, body) {
  if (!isOwnerRole(session.user.platform_role)) throw new Error("OWNER_ACCESS_REQUIRED");
  const d = await col("users").doc(id).get();
  if (!d.exists || d.data().platform_role !== "school_admin" || d.data().status === "deleted") {
    throw new Error("School admin not found.");
  }
  const nextStatus = body.status === "inactive" ? "inactive" : "active";
  await col("users").doc(id).update({ status: nextStatus, updated_at: nowIso() });
  return { success: true, message: `School admin is now ${nextStatus}.` };
}

/** Soft delete a school admin. */
/* ==================================================================== */
/*  SCHOOL ADMIN: PORTAL USER ACCOUNTS                                  */
/*  The School Head manages the sign-in accounts of their own school    */
/*  and assigns each one a portal role (PORTAL_ROLES in common.js).     */
/* ==================================================================== */

function requirePortalManager(session) {
  if (!session.isSchoolAdmin || !session.user.school_id || !session.school) {
    throw new Error("SCHOOL_ADMIN_REQUIRED");
  }
  if ((session.user.role || "head") !== "head") {
    throw new Error("Only the School Head can manage portal accounts.");
  }
}

/** Portal accounts live in the TOP-LEVEL users/{uid} collection — the same
 *  documents login reads (ensurePlatformUser / login.html) and the same
 *  store the Owner saves school admins into. One shape, one location,
 *  nothing to fall out of sync. */
const portalCol = (_session) => col("users");

/**
 * Normalise a `menu_access` grant to its canonical stored form.
 * Accepts "*" (string), an array of nav keys, or a JSON/comma string from
 * the client form. Unknown keys are dropped; selecting every section
 * collapses to "*". Returns undefined when nothing is provided, in which
 * case the account keeps legacy role-based access (field stays absent).
 */
function normalizeAccess(raw) {
  let arr = null;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return undefined;
    if (t === "*") return "*";
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) arr = parsed;
      else if (parsed === "*") return "*";
    } catch {
      arr = t.split(",").map((s) => s.trim());
    }
  } else if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw === "*") {
    return "*";
  }
  if (arr === null) return undefined;
  const granted = new Set(arr);
  const clean = ACCESS_KEYS.filter((k) => granted.has(k));
  return clean.length === ACCESS_KEYS.length ? "*" : clean;
}

const accessSummary = (access) =>
  access === "*" ? ACCESS_KEYS.length + " sections" : (Array.isArray(access) ? access.length : 0) + " sections";

/** List the school's portal accounts (tenant-scoped). */
export async function listPortalUsers(session, query) {
  requirePortalManager(session);
  const search = String(query.get("search") || "").trim().toLowerCase();
  const status = query.get("status") || "";
  const limit = Math.min(Number(query.get("limit")) || 20, 100);
  const offset = Number(query.get("offset")) || 0;

  /* Read THIS school's accounts: the equality filter scopes results
     server-side AND lets the security rules prove tenant isolation
     (they require exactly this comparison). Single-equality queries
     run on the automatic index — no composite index required.
     platform_role/status/search narrow further in memory below. */
  let snap;
  try {
    snap = await portalCol(session)
      .where("school_id", "==", session.school.id)
      .limit(500).get();
  } catch (e) {
    if (String((e && e.code) || "").includes("permission-denied")) {
      throw new Error("Firestore rules blocked the portal-users list. Publish the latest firestore.rules (Console → Firestore → Rules → Publish), then hard-refresh.");
    }
    throw e;
  }
  let rows = docsFrom(snap);
  rows = rows.filter((u) => u.platform_role === "school_admin");
  rows = rows.filter((u) => u.status !== "deleted");
  if (status) rows = rows.filter((u) => (u.status || "active") === status);
  if (search) {
    rows = rows.filter((u) => [u.display_name, u.email, u.role]
      .some((v) => v && String(v).toLowerCase().includes(search)));
  }
  rows.sort((a, b) => ts(b.created_at) - ts(a.created_at));

  return { success: true, users: rows.slice(offset, offset + limit), total: rows.length };
}

/** Provision a Firebase Auth account (same Identity Toolkit flow the
 *  owner-side createSchoolAdmin uses). */
async function provisionFirebaseAccount(email, password, displayName) {
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, displayName, returnSecureToken: false })
    }
  );
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if ((data.error && data.error.message) === "EMAIL_EXISTS") {
      throw new Error("An account with this email already exists.");
    }
    throw new Error("Could not create the sign-in account. Try again.");
  }
  return data.localId;
}

/** Create a portal account for the school with an assigned role. */
export async function createPortalUser(session, body) {
  requirePortalManager(session);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const displayName = String(body.display_name || "").trim();
  const role = PORTAL_ROLES[body.role] ? body.role : "head";
  if (!email || !password || !displayName) throw new Error("Name, email and a temporary password are required.");
  if (password.length < 6) throw new Error("The temporary password must be at least 6 characters.");

  /* Uniqueness is enforced by Firebase Auth itself: provisionFirebaseAccount
     runs BEFORE any Firestore write and rejects emails already registered
     platform-wide (EMAIL_EXISTS). A pre-check by email here would be an
     unscoped list query the rules correctly refuse. */

  const uid = await provisionFirebaseAccount(email, password, displayName);
  const access = normalizeAccess(body.menu_access);
  const user = {
    id: uid,
    firebase_uid: uid,
    email,
    display_name: displayName,
    phone: body.phone ? String(body.phone).trim() : null,
    photo_url: null,
    platform_role: "school_admin",
    role,
    school_id: session.school.id,
    status: "active",
    created_at: nowIso(), updated_at: nowIso()
  };
  if (access !== undefined) user.menu_access = access;
  await portalCol(session).doc(uid).set(user);
  await logAdminActivity(
    session, "PORTAL_USER_CREATED",
    `Portal account created for ${displayName} (${role}) with ${accessSummary(access)} access.`
  );
  return { success: true, message: "Portal account created.", user };
}

/** Update name / phone / role. The signed-in Head cannot change their own
 *  role (self-demotion lockout guard). Passwords live in Firebase Auth and
 *  are never modified here. */
export async function updatePortalUser(session, id, body) {
  requirePortalManager(session);
  const d = await portalCol(session).doc(id).get();
  if (!d.exists) {
    throw new Error("Portal account not found.");
  }
  if (id === session.user.id && body.role && body.role !== (d.data().role || "head")) {
    throw new Error("You cannot change your own role.");
  }
  const next = {
    display_name: body.display_name != null ? String(body.display_name).trim() : d.data().display_name,
    phone: body.phone != null ? String(body.phone).trim() : (d.data().phone || null),
    role: body.role && PORTAL_ROLES[body.role] ? body.role : (d.data().role || "head"),
    updated_at: nowIso()
  };
  if (body.menu_access != null) {
    const access = normalizeAccess(body.menu_access);
    if (access !== undefined) {
      if (id === session.user.id && access !== "*") {
        throw new Error("You cannot restrict your own portal access.");
      }
      next.menu_access = access;
    }
  }
  await portalCol(session).doc(id).update(next);
  const detail = next.menu_access !== undefined
    ? ` with ${accessSummary(next.menu_access)} access`
    : (body.menu_access != null ? " (access reset to role default)" : "");
  await logAdminActivity(session, "PORTAL_USER_UPDATED", `Portal account updated: ${next.display_name}${detail}.`);
  return { success: true, message: "Portal account updated." };
}

/** Activate / deactivate a portal account. Heads cannot deactivate
 *  themselves (lockout guard). */
export async function togglePortalUserStatus(session, id, body) {
  requirePortalManager(session);
  if (id === session.user.id) throw new Error("You cannot deactivate your own account.");
  const d = await portalCol(session).doc(id).get();
  if (!d.exists) {
    throw new Error("Portal account not found.");
  }
  const nextStatus = body.status === "inactive" ? "inactive" : "active";
  await portalCol(session).doc(id).update({ status: nextStatus, updated_at: nowIso() });
  await logAdminActivity(session, "PORTAL_USER_STATUS", `Portal account marked ${nextStatus}.`);
  return { success: true, message: `Account is now ${nextStatus}.` };
}

export async function deleteSchoolAdmin(session, id) {
  if (!isOwnerRole(session.user.platform_role)) throw new Error("OWNER_ACCESS_REQUIRED");
  const d = await col("users").doc(id).get();
  if (!d.exists || d.data().platform_role !== "school_admin") throw new Error("School admin not found.");
  await col("users").doc(id).update({ status: "deleted", updated_at: nowIso() });
  return { success: true, message: "School admin removed successfully." };
}
/* ==================================================================== */
/*  SCHOOL ADMIN: DASHBOARD / SETTINGS / PROFILE                         */
/* ==================================================================== */

export async function schoolDashboard(session) {
  if (!session.isSchoolAdmin || !session.school) throw new Error("SCHOOL_ADMIN_REQUIRED");
  const schoolId = session.school.id;
  const today = todayIso();

  const countIn = async (collName, pred) => {
    try {
      const snap = await col(collName).where("school_id", "==", schoolId).limit(1000).get();
      let n = 0;
      snap.forEach((d) => { if (!pred || pred(d.data())) n++; });
      return n;
    } catch { return 0; }
  };

  const [totalStudents, activeTeachers, totalClasses, totalSubjects, attendanceToday] = await Promise.all([
    countIn("students", (s) => s.status !== "deleted"),
    countIn("teachers", (t) => t.status === "active"),
    countIn("classes", (c) => c.status === "active"),
    countIn("subjects", (s) => s.status === "active"),
    countIn("attendance", (a) => a.date === today)
  ]);

  /* Fees: billed vs paid from the append-only ledger. */
  let billed = 0, paid = 0;
  try {
    const snap = await col("student_ledger").where("school_id", "==", schoolId).limit(5000).get();
    snap.forEach((d) => {
      const l = d.data();
      billed += Number(l.debit || 0);
      paid += Number(l.credit || 0);
    });
  } catch { /* zeros */ }

  let upcomingExams = [];
  try {
    const snap = await col("exams")
      .where("school_id", "==", schoolId)
      .where("status", "==", "active")
      .limit(50).get();
    upcomingExams = docsFrom(snap)
      .filter((e) => String(e.end_date || "") >= today)
      .sort((a, b) => String(a.start_date || "").localeCompare(String(b.start_date || "")))
      .slice(0, 5);
  } catch { /* empty */ }

  let recentActivity = [];
  try {
    const snap = await col("activity_logs").where("school_id", "==", schoolId).limit(8).get();
    recentActivity = docsFrom(snap).sort((a, b) => ts(b.created_at) - ts(a.created_at));
  } catch { /* empty */ }

  return {
    success: true,
    stats: {
      totalStudents,
      activeTeachers,
      totalClasses,
      totalSubjects,
      attendanceToday,
      outstandingFees: Math.max(0, Math.round((billed - paid) * 100) / 100),
      paymentsCollected: Math.round(paid * 100) / 100,
      upcomingExams: upcomingExams.length
    },
    upcomingExams,
    recentActivity
  };
}
const DEFAULT_GRADE_SCALE = [
  { grade: "A", min: 80 }, { grade: "B", min: 65 }, { grade: "C", min: 50 },
  { grade: "D", min: 35 }, { grade: "E", min: 0 }
];

export async function getSchoolGrading(schoolId) {
  const d = await col("schools").doc(schoolId).get().catch(() => null);
  const s = d && d.exists ? d.data() : {};
  let scale = DEFAULT_GRADE_SCALE;
  try {
    if (typeof s.grade_scale === "string" && s.grade_scale.trim()) {
      const parsed = JSON.parse(s.grade_scale);
      if (Array.isArray(parsed) && parsed.length) scale = parsed;
    } else if (Array.isArray(s.grade_scale) && s.grade_scale.length) {
      scale = s.grade_scale;
    }
  } catch { /* default */ }
  return { mode: s.grading_mode === "grades" || s.grading_mode === "both" ? s.grading_mode : "marks", scale };
}

export async function schoolSettingsGet(session) {
  if (!session.isSchoolAdmin || !session.school) throw new Error("SCHOOL_ADMIN_REQUIRED");
  const grading = await getSchoolGrading(session.school.id);
  return { success: true, school: session.school, grading: { mode: grading.mode, scale: grading.scale } };
}

export async function schoolSettingsUpdate(session, body) {
  if (!session.isSchoolAdmin || !session.school) throw new Error("SCHOOL_ADMIN_REQUIRED");
  const schoolId = session.school.id;

  let gradingUpdate = null;
  if (body.grading_mode != null || body.grade_scale != null) {
    const mode = ["grades", "both"].includes(body.grading_mode) ? body.grading_mode : "marks";
    let scaleJson = JSON.stringify(DEFAULT_GRADE_SCALE);
    if (mode !== "marks") {
      const arr = Array.isArray(body.grade_scale) ? body.grade_scale : [];
      const clean = arr
        .map((g) => ({ grade: String(g.grade || "").trim(), min: Math.max(0, Math.min(100, Number(g.min))) }))
        .filter((g) => g.grade && !isNaN(g.min))
        .sort((a, b2) => b2.min - a.min);
      if (clean.length === 0) throw new Error("At least one valid grade band is required for letter grades.");
      scaleJson = JSON.stringify(clean);
    }
    gradingUpdate = { mode, scaleJson };
  }

  const hasProfile = body.name != null || body.email != null || body.phone != null ||
    body.county != null || body.physical_address != null || body.school_type != null;
  if (hasProfile && !String(body.name || "").trim()) throw new Error("School name is required.");

  const patch = { updated_at: nowIso() };
  if (hasProfile) {
    patch.name = String(body.name).trim();
    patch.email = body.email || null;
    patch.phone = body.phone || null;
    patch.county = body.county || null;
    patch.physical_address = body.physical_address || null;
    patch.school_type = body.school_type || null;
  }
  if (gradingUpdate) {
    patch.grading_mode = gradingUpdate.mode;
    patch.grade_scale = gradingUpdate.scaleJson;
  }
  if (!hasProfile && !gradingUpdate) throw new Error("Nothing to update.");
  await col("schools").doc(schoolId).update(patch);

  await logAdminActivity(session, hasProfile ? "SCHOOL_PROFILE_UPDATED" : "GRADING_SETTINGS_UPDATED",
    hasProfile ? `School profile updated (${String(body.name || "").trim()}).` : "Grading settings changed.");

  const freshDoc = await col("schools").doc(schoolId).get();
  const fresh = snapDoc(freshDoc);
  const grading = await getSchoolGrading(schoolId);
  return {
    success: true,
    message: hasProfile ? "School settings updated successfully." : "Grading settings updated successfully.",
    school: fresh,
    grading: { mode: grading.mode, scale: grading.scale },
    grading_saved: true
  };
}

/** PUT /api/auth/profile — self-service display name + phone only. */
export async function updateOwnProfile(session, body) {
  const displayName = String(body.display_name || "").trim();
  const phone = String(body.phone || "").trim();
  if (!displayName) throw new Error("Display name is required.");
  /* Profile docs are keyed by the Firebase Auth UID (users/{uid}), so we write
     directly to our own document. Querying users by firebase_uid would require
     the "list" permission, granted only to owners, so a school_admin would be
     denied. session.user.id equals the uid, so we avoid the query entirely and
     stay within the rules' own-record allowance. */
  const refId = session.user.id || session.user.firebase_uid;
  if (!refId) throw new Error("Platform user not found.");
  await col("users").doc(refId).update({ display_name: displayName, phone: phone || null, updated_at: nowIso() });
  if (session.user.school_id) {
    await logAdminActivity(session, "PROFILE_UPDATED", "Admin profile updated.");
  }
  return {
    success: true,
    message: "Profile updated successfully.",
    user: { ...session.user, display_name: displayName, phone: phone || null }
  };
}
/* ==================================================================== */
/*  PROMOTIONS / YEAR ROLLOVER                                           */
/* ==================================================================== */

async function studentBalances(schoolId) {
  const map = new Map();
  try {
    const snap = await col("student_ledger").where("school_id", "==", schoolId).limit(5000).get();
    snap.forEach((d) => {
      const l = d.data();
      if (String(l.status || "POSTED") === "REVERSED") return;
      const cur = map.get(l.student_id) || 0;
      map.set(l.student_id, cur + Number(l.debit || 0) - Number(l.credit || 0));
    });
  } catch { /* empty */ }
  return map;
}

/** GET /api/promotions/preview?from=<yearId> */
export async function promotionsPreview(session, query) {
  if (!session.isSchoolAdmin) throw new Error("SCHOOL_ADMIN_REQUIRED");
  const schoolId = session.school.id;
  const fromId = query.get("from");
  if (!fromId) throw new Error("from (academic year id) is required.");

  const fyDoc = await col("academic_years").doc(fromId).get();
  if (!fyDoc.exists || fyDoc.data().school_id !== schoolId) throw new Error("Academic year not found.");
  const fromYear = snapDoc(fyDoc);

  const snap = await col("students").where("school_id", "==", schoolId).get();
  const students = docsFrom(snap).filter((s) => s.status === "active");

  const balances = await studentBalances(schoolId);
  const classes = new Map();
  const csnap = await col("classes").where("school_id", "==", schoolId).get().catch(() => null);
  if (csnap) csnap.forEach((d) => classes.set(d.id, { class_id: d.id, class_name: d.data().name + (d.data().stream ? " - " + d.data().stream : ""), students: [], count: 0 }));

  let outstandingTotal = 0, creditsTotal = 0, unassigned = 0;
  for (const s of students) {
    const bal = Math.round((balances.get(s.id) || 0) * 100) / 100;
    if (bal > 0) outstandingTotal += bal;
    if (bal < 0) creditsTotal += Math.abs(bal);
    const row = { student_id: s.id, name: `${s.first_name || ""} ${s.last_name || ""}`.trim(), admission_number: s.admission_number, balance: bal };
    if (s.class_id && classes.has(s.class_id)) classes.get(s.class_id).students.push(row);
    else unassigned++;
  }
  const classList = [...classes.values()];
  classList.forEach((g) => { g.count = g.students.length; });

  let batch = null;
  const existing = await scanByField(schoolId, "promotion_batches", "from_academic_year_id", fromId);
  const candidates = existing.filter((b) => b.status !== "cancelled");
  candidates.sort((a, b) => ts(b.created_at) - ts(a.created_at));
  batch = candidates[0] || null;

  return {
    success: true,
    fromYear,
    classes: classList,
    totals: {
      students: students.length,
      unassigned,
      outstanding: Math.round(outstandingTotal * 100) / 100,
      credits: Math.round(creditsTotal * 100) / 100
    },
    batch
  };
}

/** GET /api/promotions/batches */
export async function promotionBatchesList(session) {
  if (!session.isSchoolAdmin) throw new Error("SCHOOL_ADMIN_REQUIRED");
  const schoolId = session.school.id;
  let rows = [];
  const snap = await col("promotion_batches").where("school_id", "==", schoolId).limit(500).get().catch(() => null);
  if (snap) rows = docsFrom(snap);

  const yearNames = new Map();
  const ysnap = await col("academic_years").where("school_id", "==", schoolId).get().catch(() => null);
  if (ysnap) ysnap.forEach((d) => yearNames.set(d.id, d.data().name));

  /* Prefer the count stamped on each batch by generate(); only fall back to a
     school-wide scan for batches created before that field existed. */
  const counts = new Map();
  if (rows.some((b) => b.student_count == null)) {
    const psnap = await col("student_promotions").where("school_id", "==", schoolId).get().catch(() => null);
    if (psnap) psnap.forEach((d) => {
      const b = d.data().promotion_batch_id;
      counts.set(b, (counts.get(b) || 0) + 1);
    });
  }

  const batches = rows
    .map((b) => ({
      ...b,
      from_year_name: yearNames.get(b.from_academic_year_id) || "",
      to_year_name: yearNames.get(b.to_academic_year_id) || "",
      student_count: b.student_count != null ? b.student_count : (counts.get(b.id) || 0)
    }))
    .sort((a, b) => ts(b.created_at) - ts(a.created_at));

  return { success: true, batches };
}
/** POST /api/promotions/batches */
export async function promotionBatchCreate(session, body) {
  if (!session.isSchoolAdmin) throw new Error("SCHOOL_ADMIN_REQUIRED");
  const schoolId = session.school.id;
  const fromId = body.from_academic_year_id;
  const toId = body.to_academic_year_id;
  if (!fromId || !toId) throw new Error("from_academic_year_id and to_academic_year_id are required.");
  if (fromId === toId) throw new Error("The destination year must be different from the current one.");

  const fy = await col("academic_years").doc(fromId).get();
  const ty = await col("academic_years").doc(toId).get();
  if (!fy.exists || !ty.exists) throw new Error("Academic year not found.");
  /* Prerequisite rule: the destination year must already have at least one
     term created (the first term of the new year). */
  const termsForTo = await scanByField(schoolId, "terms", "academic_year_id", toId);
  if (!termsForTo.length) {
    throw new Error("The destination academic year has no terms yet. Create the first term for " + ty.data().name + " before running the rollover.");
  }

  /* Gather every batch that ever touched this from-year. */
  const existing = await scanByField(schoolId, "promotion_batches", "from_academic_year_id", fromId);

  /* A completed batch locks the year — prevent a second rollover of the same
     year (which would duplicate destination enrollments). */
  if (existing.some((b) => b.status === "completed")) {
    throw new Error("This academic year has already been rolled over. Start a new rollover from the next year instead.");
  }

  const openDraft = existing.find((b) => b.status === "draft");
  if (openDraft) {
    /* Auto-resume: continue the existing draft instead of erroring so a
       half-finished rollover can simply be picked up again. */
    return { success: true, resumed: true, message: "Resuming your open rollover draft.", batch: openDraft };
  }

  const id = generateId("pbatch_");
  const record = {
    id, school_id: schoolId,
    from_academic_year_id: fromId, to_academic_year_id: toId,
    from_year_name: fy.data().name, to_year_name: ty.data().name,
    status: "draft",
    student_count: 0,
    created_by: session.user.display_name,
    created_at: nowIso()
  };
  await col("promotion_batches").doc(id).set(record);
  return { success: true, message: "Rollover batch started.", batch: record };
}

/** GET /api/promotions/batches/:id */
export async function promotionBatchGet(session, id) {
  if (!session.isSchoolAdmin) throw new Error("SCHOOL_ADMIN_REQUIRED");
  const schoolId = session.school.id;
  const bDoc = await col("promotion_batches").doc(id).get();
  if (!bDoc.exists || bDoc.data().school_id !== schoolId) throw new Error("Promotion batch not found.");
  const batch = snapDoc(bDoc);

  let students = [];
  let mapping = [];
  const srows = await scanByField(schoolId, "student_promotions", "promotion_batch_id", id);
  students = srows;

  const mrows = await scanByField(schoolId, "promotion_mappings", "promotion_batch_id", id);
  mapping = mrows.map((m) => ({ class_id: m.class_id, action: m.action, to_class_id: m.to_class_id }));

  /* Join student identity onto each row — raw promotion docs only carry ids. */
  if (students.length) {
    const asnap = await col("students").where("school_id", "==", schoolId).get().catch(() => null);
    if (asnap) {
      const info = new Map();
      docsFrom(asnap).forEach((st) => info.set(st.id, st));
      students = students.map((sp) => {
        const st = info.get(sp.student_id) || {};
        return {
          ...sp,
          student_name: `${st.first_name || ""} ${st.last_name || ""}`.trim(),
          admission_number: st.admission_number || "",
          balance: Number(sp.balance_carried || 0)
        };
      });
    }
  }

  const summary = { promote: 0, repeat: 0, graduate: 0, transfer: 0, leave: 0, outstanding: 0, credits: 0 };
  for (const sp of students) {
    if (summary[sp.action] != null) summary[sp.action] += 1;
    const bal = Number(sp.balance_carried || 0);
    if (bal > 0) summary.outstanding += bal;
    if (bal < 0) summary.credits += Math.abs(bal);
  }
  summary.outstanding = Math.round(summary.outstanding * 100) / 100;
  summary.credits = Math.round(summary.credits * 100) / 100;

  return { success: true, batch, mapping, students, summary };
}

/** PUT /api/promotions/batches/:id/mapping */
export async function promotionBatchMapping(session, id, body) {
  if (!session.isSchoolAdmin) throw new Error("SCHOOL_ADMIN_REQUIRED");
  const schoolId = session.school.id;
  const bDoc = await col("promotion_batches").doc(id).get();
  if (!bDoc.exists || bDoc.data().school_id !== schoolId) throw new Error("Promotion batch not found.");
  if (bDoc.data().status !== "draft") throw new Error("Only draft batches can be modified.");
  const mapping = Array.isArray(body.mapping) ? body.mapping : [];
  if (!mapping.length) throw new Error("Map at least one class.");

  /* Validate + dedupe into {class_id -> {action, to_class_id}}. Skip rows are
     persisted too — an explicit Skip must stick even on a resumed draft. */
  const wanted = new Map();
  for (const m of mapping) {
    if (!m.class_id) continue;
    const action = ["promote", "graduate", "skip"].includes(m.action) ? m.action : "promote";
    const toClass = action === "promote" ? (m.to_class_id || null) : null;
    if (action === "promote" && !toClass) throw new Error("Choose a destination class for every promoted class.");
    wanted.set(m.class_id, { action, to_class_id: toClass });
  }
  if (!wanted.size) throw new Error("Map at least one class.");

  const FLUSH_AT = 450;
  let wb = db.batch();
  let ops = 0;
  for (const [classId, w] of wanted) {
    wb.set(col("promotion_mappings").doc(`${id}_${classId}`), {
      id: `${id}_${classId}`,
      promotion_batch_id: id, school_id: schoolId,
      class_id: classId, action: w.action, to_class_id: w.to_class_id,
      updated_at: nowIso()
    }, { merge: true });
    if (++ops >= FLUSH_AT) { await wb.commit(); wb = db.batch(); ops = 0; }
  }

  /* Drop stale rows from earlier saves so classes later set to Skip can never
     be resurrected by generate(). */
  const oldRows = await scanByField(schoolId, "promotion_mappings", "promotion_batch_id", id);
  for (const d of oldRows) {
    if (!wanted.has(d.class_id)) { wb.delete(col("promotion_mappings").doc(d.id)); ops++; }
  }
  if (ops) await wb.commit();
  return { success: true, message: "Mapping saved." };
}
/** POST /api/promotions/batches/:id/generate */
export async function promotionBatchGenerate(session, id) {
  if (!session.isSchoolAdmin) throw new Error("SCHOOL_ADMIN_REQUIRED");
  const schoolId = session.school.id;
  const bDoc = await col("promotion_batches").doc(id).get();
  if (!bDoc.exists || bDoc.data().school_id !== schoolId) throw new Error("Promotion batch not found.");
  const batch = snapDoc(bDoc);
  if (batch.status !== "draft") throw new Error("Only draft batches can generate students.");

  const mappingRows = await scanByField(schoolId, "promotion_mappings", "promotion_batch_id", id);
  const mapping = mappingRows;
  if (!mapping.length) throw new Error("Save a class mapping first.");
  const mapByClass = new Map(mapping.map((m) => [m.class_id, m]));

  /* IMPORTANT: match the query shape used by promotionsPreview — a single
     school_id index plus an in-memory status filter. Scanning the school's
     docs and filtering in memory needs no composite index at all. */
  const ssnap = await col("students").where("school_id", "==", schoolId).get().catch(() => null);
  const allStudents = (ssnap ? docsFrom(ssnap) : []).filter((s) => s.status === "active");

  /* Existing promotions in this batch — never duplicate. */
  const existingRows = await scanByField(schoolId, "student_promotions", "promotion_batch_id", id);
  const existing = new Set(existingRows.map((d) => d.student_id));

  const balances = await studentBalances(schoolId);

  let generated = 0, skipped = 0;
  for (const s of allStudents) {
    const m = mapByClass.get(s.class_id);
    if (!m || m.action === "skip" || existing.has(s.id)) { skipped++; continue; }
    const action = m.action === "graduate" ? "graduate" : "promote";
    /* Deterministic doc key `${id}_${s.id}` keeps document id ≡ stored id
       (no .add() drift) and makes re-generation naturally idempotent. */
    const sprId = `${id}_${s.id}`;
    await col("student_promotions").doc(sprId).set({
      id: sprId,
      school_id: schoolId,
      promotion_batch_id: id,
      student_id: s.id,
      from_class_id: s.class_id || null,
      current_class_id: s.class_id || null,
      to_class_id: action === "promote" ? (m.to_class_id || null) : null,
      action,
      balance_carried: Math.round((balances.get(s.id) || 0) * 100) / 100,
      status: "pending",
      created_at: nowIso()
    }, { merge: true });
    generated++;
  }
  /* Stamp the count on the batch so the batch list never has to scan every
     student_promotions document. */
  await col("promotion_batches").doc(id).update({ student_count: generated, updated_at: nowIso() }).catch(() => {});
  return { success: true, message: `${generated} student(s) prepared.`, generated, skipped };
}

/** PUT /api/promotions/batches/:id/students/:studentId */
export async function promotionStudentOverride(session, batchId, studentId, body) {
  if (!session.isSchoolAdmin) throw new Error("SCHOOL_ADMIN_REQUIRED");
  const schoolId = session.school.id;
  const bDoc = await col("promotion_batches").doc(batchId).get();
  if (!bDoc.exists || bDoc.data().school_id !== schoolId) throw new Error("Promotion batch not found.");
  if (bDoc.data().status !== "draft") throw new Error("Only draft batches can be modified.");

  const action = ["promote", "repeat", "graduate", "transfer", "leave"].includes(body.action) ? body.action : null;
  if (!action) throw new Error("A valid action is required.");
  let toClass = action === "promote" || action === "repeat" ? (body.to_class_id || null) : null;
  if ((action === "promote" || action === "repeat") && !toClass) {
    throw new Error("A destination class is required for promote/repeat.");
  }
  if (toClass) {
    const cDoc = await col("classes").doc(toClass).get();
    if (!cDoc.exists || cDoc.data().school_id !== schoolId) throw new Error("Destination class not found in this school.");
  }

  const rows = await scanByField(schoolId, "student_promotions", "promotion_batch_id", batchId);
  const target = rows.filter((r) => r.student_id === studentId);
  if (!target.length) throw new Error("Student not found in this batch.");
  for (const r of target) await col("student_promotions").doc(r.id).update({ action, to_class_id: toClass });
  return { success: true, message: "Student promotion updated." };
}
/** POST /api/promotions/batches/:id/complete */
export async function promotionBatchComplete(session, batchId, body) {
  if (!session.isSchoolAdmin) throw new Error("SCHOOL_ADMIN_REQUIRED");
  const schoolId = session.school.id;
  if (String(body.confirm || "").trim() !== "PROMOTE") {
    throw new Error("Type PROMOTE to confirm the year rollover.");
  }
  const bDoc = await col("promotion_batches").doc(batchId).get();
  if (!bDoc.exists || bDoc.data().school_id !== schoolId) throw new Error("Promotion batch not found.");
  const batch = snapDoc(bDoc);
  if (batch.status !== "draft") throw new Error("This batch has already been processed.");

  const psnapRows = await scanByField(schoolId, "student_promotions", "promotion_batch_id", batchId);
  const promotions = psnapRows.filter((sp) => sp.status !== "completed");

  if (!promotions.length) {
    await col("promotion_batches").doc(batchId).update({ status: "completed", completed_at: nowIso() });
    await logAdminActivity(session, "PROMOTION_COMPLETED", "Year rollover completed (all students were already processed).");
    return { success: true, message: "Year rollover completed. All students were already processed." };
  }

  /* Pre-flight guard: never start the rollover while a promoted student is
     missing a destination class. Repeating students fall back to their
     current class when no explicit destination was chosen. */
  const missingDest = promotions.filter(
    (sp) => sp.action === "promote"
      ? !sp.to_class_id
      : (sp.action === "repeat" && !sp.to_class_id && !(sp.from_class_id || sp.current_class_id))
  );
  if (missingDest.length) {
    throw new Error(`${missingDest.length} student(s) have no destination class. Open the batch and set every promoted student's destination class before completing.`);
  }

  const today = todayIso();
  const now = nowIso();
  const outcomeToEnrStatus = { promote: "promoted", repeat: "repeated", graduate: "graduated", transfer: "transferred", leave: "left" };

  /* Snapshot source + destination enrollments once and index by student —
     replaces a lookup query per student and makes completion scale. */
  const [srcRows, dstRows] = await Promise.all([
    scanByField(schoolId, "student_enrollments", "academic_year_id", batch.from_academic_year_id),
    scanByField(schoolId, "student_enrollments", "academic_year_id", batch.to_academic_year_id)
  ]);
  const srcByStudent = new Map();
  srcRows.forEach((d) => { if (!srcByStudent.has(d.student_id)) srcByStudent.set(d.student_id, d); });
  const dstByStudent = new Map();
  dstRows.forEach((d) => { if (!dstByStudent.has(d.student_id)) dstByStudent.set(d.student_id, d); });

  const FLUSH_AT = 450;
  const summary = { promote: 0, repeat: 0, graduate: 0, transfer: 0, leave: 0 };
  const failed = [];
  let processed = 0;
  let wb = db.batch();
  let ops = 0;

  const flush = async () => {
    if (!ops) return;
    await wb.commit();
    wb = db.batch();
    ops = 0;
  };

  for (const sp of promotions) {
    try {
      const srcEnr = srcByStudent.get(sp.student_id);
      /* Close the historical enrollment for the year that is ending. */
      if (srcEnr) {
        const srcUpd = { enrollment_status: outcomeToEnrStatus[sp.action] || "active", updated_at: now };
        if (sp.action === "graduate" || sp.action === "transfer" || sp.action === "leave") srcUpd.exit_date = today;
        wb.update(col("student_enrollments").doc(srcEnr.id), srcUpd);
        if (++ops >= FLUSH_AT) await flush();
      }

      if (sp.action === "promote" || sp.action === "repeat") {
        const keepClass = sp.action === "promote" ? sp.to_class_id : (sp.to_class_id || sp.from_class_id || sp.current_class_id);
        /* Create or refresh the destination-year enrollment. */
        const dstEnr = dstByStudent.get(sp.student_id);
        if (dstEnr) {
          wb.update(col("student_enrollments").doc(dstEnr.id), { class_id: keepClass, enrollment_status: "active", updated_at: now });
        } else {
          /* Explicit key so document id ≡ stored id (no .add() drift). */
          const enrId = generateId("enr_");
          wb.set(col("student_enrollments").doc(enrId), {
            id: enrId, school_id: schoolId,
            student_id: sp.student_id,
            academic_year_id: batch.to_academic_year_id,
            class_id: keepClass,
            enrollment_status: "active",
            enrollment_date: today,
            created_by: session.user.display_name,
            created_at: now
          });
        }
        if (++ops >= FLUSH_AT) await flush();
        /* students.class_id represents the CURRENT class. */
        wb.update(col("students").doc(sp.student_id), { class_id: keepClass, status: "active", updated_at: now });
        if (++ops >= FLUSH_AT) await flush();
      } else {
        /* graduated / transferred / left → deactivate and clear the class. */
        wb.update(col("students").doc(sp.student_id), {
          status: "inactive",
          class_id: null,
          exit_reason: sp.action,
          exit_date: today,
          updated_at: now
        });
        if (++ops >= FLUSH_AT) await flush();
      }

      const spUpd = { status: "completed", processed_at: now };
      if (srcEnr) spUpd.from_enrollment_id = srcEnr.id;
      wb.update(col("student_promotions").doc(sp.id), spUpd);
      if (++ops >= FLUSH_AT) await flush();

      summary[sp.action] = (summary[sp.action] || 0) + 1;
      processed++;
    } catch (e) {
      console.warn("ShuleSmart: promotion processing failed", sp.student_id, e);
      failed.push(sp.student_id);
      wb.update(col("student_promotions").doc(sp.id), { status: "failed", failed_message: String((e && e.message) || e).slice(0, 300) });
      if (++ops >= FLUSH_AT) await flush();
    }
  }
  await flush();

  if (failed.length) {
    await logAdminActivity(session, "PROMOTION_PARTIAL_FAILURE", `${failed.length} student(s) failed during rollover completion.`);
    return {
      success: false,
      message: `${processed} of ${promotions.length} processed. ${failed.length} failed (${failed.slice(0, 10).join(", ")}${failed.length > 10 ? ", …" : ""}) — the batch stays open so you can re-run completion.`,
      failed: failed.map((id) => ({ student_id: id }))
    };
  }

  await col("promotion_batches").doc(batchId).update({ status: "completed", completed_at: now });
  await logAdminActivity(session, "PROMOTION_COMPLETED", `Year rollover completed: ${summary.promote} promoted, ${summary.repeat} repeating, ${summary.graduate} graduated, ${summary.transfer} transferred, ${summary.leave} left.`);
  return {
    success: true,
    summary,
    message: `Year rollover completed. ${processed} student(s) processed — ${summary.promote} promoted, ${summary.repeat} repeating, ${summary.graduate} graduated, ${summary.transfer} transferred, ${summary.leave} left.`
  };
}

/** POST /api/promotions/batches/:id/discard */
export async function promotionBatchDiscard(session, id) {
  if (!session.isSchoolAdmin) throw new Error("SCHOOL_ADMIN_REQUIRED");
  const schoolId = session.school.id;
  const bDoc = await col("promotion_batches").doc(id).get();
  if (!bDoc.exists || bDoc.data().school_id !== schoolId) throw new Error("Promotion batch not found.");
  if (bDoc.data().status === "completed") {
    throw new Error("A completed rollover cannot be discarded. Only open drafts can be removed.");
  }

  const FLUSH_AT = 450;
  let wb = db.batch();
  let ops = 0;
  const flush = async () => {
    if (!ops) return;
    await wb.commit();
    wb = db.batch();
    ops = 0;
  };

  /* Remove everything generated for this draft — mappings and promotion rows. */
  const mappings = await scanByField(schoolId, "promotion_mappings", "promotion_batch_id", id);
  for (const m of mappings) { wb.delete(col("promotion_mappings").doc(m.id)); if (++ops >= FLUSH_AT) await flush(); }

  const students = await scanByField(schoolId, "student_promotions", "promotion_batch_id", id);
  for (const s of students) { wb.delete(col("student_promotions").doc(s.id)); if (++ops >= FLUSH_AT) await flush(); }

  wb.delete(col("promotion_batches").doc(id));
  ops++;
  await flush();

  await logAdminActivity(session, "PROMOTION_DISCARDED", "Unfinished year-rollover draft discarded.");
  return { success: true, message: "Draft discarded. You can now start a fresh rollover." };
}