/**
 * ============================================================
 * ShuleSmart - Firestore Data Engine
 * Product by Prince Alex Digital
 * ============================================================
 * Replaces the Cloudflare Worker API. Every read/write that the
 * school-admin portal previously sent to
 *   https://shulesmart-api.princealexdigital.workers.dev
 * is now performed directly against the project's Firestore
 * database using the Firebase client SDK.
 *
 * The endpoint surface, response shapes and validation messages
 * mirror the old worker so the frontend pages (which import
 * apiGet/apiPost/apiPut/apiPatch/apiDelete) keep working with NO
 * page changes.
 *
 * SECURITY NOTE: tenant scoping uses the authenticated Firebase
 * user's Firestore record (school_id). Firestore browser clients
 * are gated by Cloud Firestore RULES - deploy rules matching these
 * collections before going live (see firestore.rules in the repo).
 * ============================================================
 */

import { auth } from "./firebase-config.js";
import { db } from "./firestore-db.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const nowIso = () => new Date().toISOString();
const todayIso = () => new Date().toISOString().slice(0, 10);

/** Generate a compact unique id (mirrors the worker's generateId). */
function generateId(prefix) {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

const col = (name) => db.collection(name);

/** Convert a Firestore snapshot to a plain object.
 *  NOTE: the document id must win over any stored `id` field — several
 *  collections are written with `.add()` (auto document id) plus a separate
 *  `id` field, and routes address documents by the REAL document id.
 *  Previously the spread let the stored field override it, so receipt /
 *  void / reprint calls targeted non-existent documents and Firestore
 *  answered permission-denied. */
const snapDoc = (doc) => ({ ...doc.data(), id: doc.id });

/** Pump every document from a QuerySnapshot. */
function docsFrom(snap) {
  const out = [];
  snap.forEach((d) => out.push(snapDoc(d)));
  return out;
}

/* ------------------------------------------------------------------ */
/*  School numbering (admission numbers)                                */
/*  Stored per school in the finance_settings singleton doc, alongside */
/*  the receipt prefix. Sequence is kept in the admission_counters doc */
/*  (keyed by schoolId) so it is atomic across concurrent adds.        */
/* ------------------------------------------------------------------ */

/** Read the school's numbering config (safe defaults when unset). */
async function getSchoolNumbering(schoolId) {
  const d = await col("finance_settings").doc(schoolId).get().catch(() => null);
  const s = (d && d.exists) ? d.data() : {};
  return {
    admission_number_prefix: String(s.admission_number_prefix || "ADM").trim().toUpperCase() || "ADM",
    admission_number_start: Math.max(1, Number(s.admission_number_start) || 1),
    admission_number_padding: Math.max(1, Math.min(8, Number(s.admission_number_padding) || 4)),
    admission_auto_generate: s.admission_auto_generate !== false,
    receipt_prefix: String(s.receipt_prefix || "RCT").trim().toUpperCase() || "RCT",
    receipt_digits: Math.max(1, Math.min(8, Number(s.receipt_digits) || 6))
  };
}

function formatAdmissionNumber(cfg, seq) {
  return `${cfg.admission_number_prefix}-${String(seq).padStart(cfg.admission_number_padding, "0")}`;
}

/** Preview the next admission number without consuming the sequence. */
export async function nextAdmissionPreview(session) {
  requireSchoolAdmin(session);
  const cfg = await getSchoolNumbering(session.school.id);
  const ctr = await col("admission_counters").doc(session.school.id).get().catch(() => null);
  const last = ctr && ctr.exists ? (Number(ctr.data().last_no) || 0) : 0;
  const next = Math.max(cfg.admission_number_start, last + 1);
  return {
    success: true,
    admission_number: formatAdmissionNumber(cfg, next),
    prefix: cfg.admission_number_prefix,
    padding: cfg.admission_number_padding,
    start: cfg.admission_number_start,
    auto_generate: cfg.admission_auto_generate
  };
}

/** Generate (and consume) the next admission number atomically. */
async function nextAdmissionNumber(schoolId, cfg) {
  const c = cfg || await getSchoolNumbering(schoolId);
  const ctrRef = col("admission_counters").doc(schoolId);
  const seq = await db.runTransaction(async (tx) => {
    const d = await tx.get(ctrRef);
    const last = d.exists ? (Number(d.data().last_no) || 0) : 0;
    const next = Math.max(c.admission_number_start, last + 1);
    tx.set(ctrRef, { school_id: schoolId, last_no: next, updated_at: nowIso() });
    return next;
  });
  return formatAdmissionNumber(c, seq);
}

/* ------------------------------------------------------------------ */
/*  Session / authorization                                            */
/* ------------------------------------------------------------------ */

/**
 * Founding-owner bootstrap allowlist.
 * On first run, when NO super_owner/owner exists yet, an account with
 * one of these emails is adopted automatically as the platform
 * super_owner (mirrors the old D1 seed row). Everyone else who isn't
 * registered still gets PLATFORM_USER_NOT_FOUND.
 */
const FOUNDING_OWNER_EMAILS = ["senerwaalex@gmail.com"];

/** Platform-wide owner roles. */
export function isOwnerRole(role) {
  return role === "super_owner" || role === "owner";
}

/**
 * Ensure a platform `users` record exists for the given Firebase user.
 *
 * - Returns the existing record when found (matched by firebase_uid).
 * - On first run, when NO super_owner/owner exists yet and the email is
 *   on the FOUNDING_OWNER_EMAILS allowlist, creates that super_owner.
 * - Returns null for any other unregistered login.
 *
 * Used by resolveSession() AND by the Owner dashboard's access gate so
 * bootstrapping happens before any "is this an owner?" decision.
 */
export async function ensurePlatformUser(firebaseUser) {
  if (!firebaseUser) return null;

  const uid = firebaseUser.uid;

  /* Preferred: direct read keyed by UID — the rules allow every
     signed-in user to read their own users/{uid} record. */
  let user = null;
  try {
    const dref = await col("users").doc(uid).get();
    if (dref.exists && dref.data()) user = snapDoc(dref);
  } catch { /* fall through to legacy lookup */ }

  /* Legacy fallback: records created before UID-keying used generated ids. */
  if (!user) {
    try {
      const q = await col("users")
        .where("firebase_uid", "==", uid)
        .limit(1)
        .get();
      q.forEach((d) => { user = snapDoc(d); });
    } catch { /* denied or none */ }
  }

  if (user) return user;

  /* ---- First-run bootstrap: adopt the founding super_owner ------ */
  const email = String(firebaseUser.email || "").trim().toLowerCase();

  let hasOwner = false;
  try {
    const ownersSnap = await col("users")
      .where("platform_role", "in", ["super_owner", "owner"])
      .limit(1)
      .get();
    hasOwner = !ownersSnap.empty;
  } catch { /* unreadable -> assume none */ }

  if (!hasOwner && FOUNDING_OWNER_EMAILS.includes(email)) {
    user = {
      id: uid,
      firebase_uid: uid,
      email,
      display_name: firebaseUser.displayName || "Alex Senerwa",
      phone: null,
      photo_url: firebaseUser.photoURL || null,
      platform_role: "super_owner",
      school_id: null,
      status: "active",
      created_at: nowIso(),
      updated_at: nowIso()
    };
    await col("users").doc(uid).set(user);
    console.info("ShuleSmart: bootstrapped the founding super_owner account for", email);
    return user;
  }

  if (!hasOwner) {
    console.warn(
      "ShuleSmart: this platform has no super_owner yet. Sign in with one of:",
      FOUNDING_OWNER_EMAILS.join(", ")
    );
  }
  return null;
}

/**
 * Resolve the authenticated Firebase user's platform record + school.
 * Mirrors the worker's requireSchoolAdmin()/requirePlatformUser().
 */
export async function resolveSession() {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser) throw new Error("You are not signed in.");

  const user = await ensurePlatformUser(firebaseUser);
  if (!user) throw new Error("PLATFORM_USER_NOT_FOUND");
  if (user.status !== "active") throw new Error("USER_INACTIVE");

  let school = null;
  if (user.school_id) {
    const sd = await col("schools").doc(user.school_id).get();
    if (sd.exists) school = { id: sd.id, ...sd.data() };
  }

  return {
    firebase: { uid: firebaseUser.uid, email: firebaseUser.email || null },
    user,
    school,
    isOwner: isOwnerRole(user.platform_role),
    isSchoolAdmin: user.platform_role === "school_admin"
  };
}

function requireOwner(session) {
  if (!session.isOwner) throw new Error("OWNER_ACCESS_REQUIRED");
}

function requireSchoolAdmin(session) {
  if (!session.isSchoolAdmin || !session.user.school_id) {
    throw new Error("SCHOOL_ADMIN_REQUIRED");
  }
  if (!session.school) throw new Error("SCHOOL_NOT_FOUND");
}

/**
 * Module permission vocabulary (documented for future finer-grained
 * roles). A school_admin is ALWAYS granted every action below — they
 * have full management rights over their own school's portal.
 */
const PERMISSIONS = Object.freeze({
  "school_admin": [
    "dashboard.view", "students.view", "students.manage",
    "teachers.view", "teachers.manage", "staff.view", "staff.manage",
    "classes.view", "classes.manage", "subjects.view", "subjects.manage",
    "academics.view", "academics.manage", "exams.view", "exams.manage",
    "marks.view", "marks.manage", "results.view",
    "attendance.view", "attendance.report",
    "finance.view", "fees.manage", "statements.view",
    "invoices.view", "invoices.create", "invoices.issue", "invoices.cancel",
    "payments.record", "payments.reverse", "payments.refund",
    "receipts.view", "receipts.print", "receipts.reprint", "receipts.void",
    "ledger.view", "ledger.adjust", "credits.post",
    "fee_structures.manage", "fee_categories.manage", "finance.settings",
    "promotions.manage", "settings.school", "profile.self"
  ]
});

/**
 * Authorisation gate. Owners and school admins are unrestricted:
 *   - owners act platform-wide,
 *   - school_admins hold EVERY action inside their own school
 *     (enforced by requireSchoolAdmin + tenant scoping everywhere).
 */
function isAllowed(session, action) {
  if (session.isOwner || session.isSchoolAdmin) return true;
  const perms = PERMISSIONS[session.user.platform_role] || [];
  if (!perms.includes(action)) throw new Error("ACTION_NOT_ALLOWED");
}

/* ------------------------------------------------------------------ */
/*  Activity log emission (append-only, tenant-scoped)                 */
/* ------------------------------------------------------------------ */

async function logActivity(session, action, description) {
  try {
    await col("activity_logs").add({
      school_id: session.user.school_id || session.school?.id || null,
      user_id: session.user.id,
      user_display_name: session.user.display_name || "System",
      action,
      description,
      created_at: new Date()
    });
  } catch (e) {
    // Activity logging must never break the primary operation.
    console.warn("ShuleSmart: activity log write failed", e && e.message);
  }
}

/* ------------------------------------------------------------------ */
/*  Generic school-scoped CRUD (mirrors the worker module handlers)    */
/* ------------------------------------------------------------------ */

function moduleD(route) {
  const map = {
    "academic-years": { coll: "academic_years", key: "academicYears", statuses: ["active", "inactive", "archived"], search: false },
    "terms": { coll: "terms", key: "terms", statuses: [], search: false },
    "classes": { coll: "classes", key: "classes", statuses: ["active", "inactive"], search: false },
    "subjects": { coll: "subjects", key: "subjects", statuses: ["active", "inactive"], search: false },
    "teachers": { coll: "teachers", key: "teachers", statuses: ["active", "inactive"], search: ["staff_number", "first_name", "last_name", "email"] },
    "staff": { coll: "staff", key: "staff", statuses: ["active", "inactive"], search: ["staff_number", "first_name", "last_name", "email", "role", "department"] },
    "exams": { coll: "exams", key: "exams", statuses: ["active", "inactive"], search: false },
    "activity": { coll: "activity_logs", key: "activity", statuses: [], search: ["action", "description", "user_display_name"], readOnly: true }
  };
  return map[route] || null;
}
/* ---- In-memory search + tenant-scoped list ---- */
function matchSearch(row, search, fields) {
  if (!search) return true;
  const needle = search.toLowerCase();
  if (fields === true) {
    return Object.values(row).some((v) => v != null && String(v).toLowerCase().includes(needle));
  }
  return (fields || []).some((f) => row[f] != null && String(row[f]).toLowerCase().includes(needle));
}

/* ------------------------------------------------------------------ */
/*  Generic list — cost-aware paging                                   */
/*                                                                     */
/*  Plain browsing reads ONLY the requested page plus one cheap count  */
/*  aggregate, instead of scanning up to 1000 documents per request.   */
/*  Substring search cannot run server-side in Firestore, so search    */
/*  requests use a bounded in-memory scan (LIST_SCAN_CAP). The paged   */
/*  path needs one composite index per collection (school_id ASC,      */
/*  [status ASC,] created_at DESC); until those exist in the Firebase  */
/*  console, the bounded scan below serves traffic automatically.      */
/* ------------------------------------------------------------------ */

const LIST_SCAN_CAP = 300;

export async function listModule(session, route, query) {
  const d = moduleD(route);
  requireSchoolAdmin(session);
  const limit = Math.min(Number(query.get("limit")) || 20, 100);
  const offset = Number(query.get("offset")) || 0;
  const search = query.get("search") || "";
  const status = query.get("status") || "";
  const from = query.get("from") || "";
  const to = query.get("to") || "";

  /* Date ranges run through the bounded scan too: created_at is stored as a
     mix of Firestore Timestamps and ISO strings depending on the writer, so
     an in-memory millisecond comparison (ts()) is the one type-safe filter. */
  if (!search && !from && !to) {
    try {
      return await listModulePaged(session, d, { limit, offset, status });
    } catch (e) {
      console.warn(`ShuleSmart: paged list ${d.coll} unavailable (${e && e.message}) — serving a bounded scan instead. Create the composite index suggested by this error in the Firebase console to enable cheap paging.`);
    }
  }
  return listModuleScan(session, d, { limit, offset, search, status, from, to });
}

/** Newest-first single page. Reads are billed for the returned rows (and any
 *  offset skipped), never for the whole collection like the old scan. */
async function listModulePaged(session, d, { limit, offset, status }) {
  const useStatus = status && d.statuses.includes(status);
  let q = col(d.coll).where("school_id", "==", session.school.id);
  if (useStatus) q = q.where("status", "==", status);
  else if (d.statuses.length) q = q.where("status", "!=", "deleted"); /* these collections always carry a status field */
  q = q.orderBy("created_at", "desc");

  const [snap, total] = await Promise.all([
    q.offset(offset).limit(limit).get(), /* fresh facade: page window only */
    q.count()                            /* q itself has no offset/limit  */
  ]);
  return { success: true, [d.key]: docsFrom(snap), total };
}

/** Parses filter dates into inclusive millisecond bounds.
 *  "YYYY-MM-DD" values are read as UTC days ("to" covers the whole day). */
function rangeBounds(from, to) {
  const fromMs = from ? Date.parse(from) : NaN;
  let toMs = to ? Date.parse(to) : NaN;
  if (!Number.isNaN(toMs) && /^\d{4}-\d{2}-\d{2}$/.test(to)) toMs += 86400000 - 1;
  return { fromMs, toMs };
}

/** Bounded in-memory scan — used for substring search, date ranges, and as
 *  the paged-path fallback. Capped far below the previous 1000-doc read. */
async function listModuleScan(session, d, { limit, offset, search, status, from, to }) {
  let snap;
  try {
    snap = await col(d.coll).where("school_id", "==", session.school.id).limit(LIST_SCAN_CAP).get();
  } catch (e) {
    console.warn(`ShuleSmart: list ${d.coll} failed`, e);
    return { success: true, [d.key]: [], total: 0 };
  }

  let rows = docsFrom(snap);
  rows = rows.filter((r) => r.status !== "deleted");
  if (status && d.statuses.includes(status)) {
    rows = rows.filter((r) => (r.status || "active") === status);
  }
  if (search) rows = rows.filter((r) => matchSearch(r, search, d.search));
  if (from || to) {
    const { fromMs, toMs } = rangeBounds(from, to);
    rows = rows.filter((r) => {
      const t = ts(r.created_at);
      if (!Number.isNaN(fromMs) && t < fromMs) return false;
      if (!Number.isNaN(toMs) && t > toMs) return false;
      return true;
    });
  }
  rows.sort((a, b) => ts(b.created_at) - ts(a.created_at));

  const total = rows.length;
  return { success: true, [d.key]: rows.slice(offset, offset + limit), total };
}

function ts(v) {
  if (!v) return 0;
  if (typeof v === "object" && typeof v.toMillis === "function") return v.toMillis();
  const n = Date.parse(String(v));
  return Number.isNaN(n) ? 0 : n;
}

export async function fetchByKey(session, route, id) {
  requireSchoolAdmin(session);
  const doc = await col(moduleD(route).coll).doc(id).get();
  if (!doc.exists || doc.data().school_id !== session.school.id) {
    throw new Error("Record not found.");
  }
  return snapDoc(doc);
}

async function clearCurrentFlag(schoolId, collName) {
  const snap = await col(collName).where("school_id", "==", schoolId).get();
  const batch = db.batch();
  let n = 0;
  snap.forEach((d) => {
    if (d.data().is_current) { batch.update(d.ref, { is_current: 0 }); n++; }
  });
  if (n) await batch.commit();
}
async function findDup(schoolId, collName, match) {
  const snap = await col(collName).where("school_id", "==", schoolId).get();
  return docsFrom(snap).find((r) => {
    if ((r.status || "active") === "deleted") return false;
    for (const k of Object.keys(match)) {
      if (String(r[k] || "") !== match[k]) return false;
    }
    return true;
  }) || null;
}

/* ---- generic create / update / status ---- */
export async function createRecord(session, route, body) {
  const d = moduleD(route);
  requireSchoolAdmin(session);
  const schoolId = session.school.id;

  const id = generateId(route === "academic-years" ? "acad_" : route.substring(0, 5));
  const record = { id, school_id: schoolId, status: "active", created_at: nowIso(), updated_at: nowIso() };

  if (route === "academic-years") {
    record.name = String(body.name || "").trim();
    record.start_date = body.start_date || null;
    record.end_date = body.end_date || null;
    record.is_current = body.is_current ? 1 : 0;
    if (!record.name) throw new Error("Year name is required.");
    if (record.is_current) await clearCurrentFlag(schoolId, "academic_years");
  } else if (route === "terms") {
    record.name = String(body.name || "").trim();
    record.academic_year_id = body.academic_year_id || null;
    record.start_date = body.start_date || null;
    record.end_date = body.end_date || null;
    record.is_current = body.is_current ? 1 : 0;
    if (!record.name) throw new Error("Term name is required.");
    if (record.is_current) await clearCurrentFlag(schoolId, "terms");
  } else if (route === "classes") {
    record.name = String(body.name || "").trim();
    record.stream = body.stream ? String(body.stream).trim() : null;
    record.capacity = Number(body.capacity) || 0;
    record.class_teacher_id = body.class_teacher_id || null;
    if (!record.name) throw new Error("Class name is required.");
    if (await findDup(schoolId, "classes", { name: record.name, stream: record.stream || "" })) {
      throw new Error("This class and stream combination already exists.");
    }
    if (record.class_teacher_id) {
      const t = await col("teachers").doc(record.class_teacher_id).get();
      if (!t.exists || t.data().school_id !== schoolId) throw new Error("Selected class teacher does not exist.");
    }
  } else if (route === "subjects") {
    record.code = String(body.code || "").trim();
    record.name = String(body.name || "").trim();
    if (!record.code || !record.name) throw new Error("Subject code and name are required.");
  } else if (route === "teachers") {
    record.staff_number = String(body.staff_number || "").trim();
    record.first_name = String(body.first_name || "").trim();
    record.last_name = String(body.last_name || "").trim();
    for (const f of ["email", "phone", "gender", "employment_date", "employment_type"])
      record[f] = body[f] || null;
    if (!record.staff_number || !record.first_name || !record.last_name) throw new Error("Staff number and name are required.");
  } else if (route === "staff") {
    record.staff_number = String(body.staff_number || "").trim();
    record.first_name = String(body.first_name || "").trim();
    record.last_name = String(body.last_name || "").trim();
    for (const f of ["department", "role", "email", "phone", "employment_date"])
      record[f] = body[f] || null;
    if (!record.staff_number || !record.first_name || !record.last_name) throw new Error("Staff number and name are required.");
  } else if (route === "exams") {
    record.name = String(body.name || "").trim();
    for (const f of ["academic_year_id", "term_id", "start_date", "end_date"])
      record[f] = body[f] || null;
    if (!record.name) throw new Error("Exam name is required.");
  } else {
    throw new Error("Route not found");
  }

  if (!d.readOnly) await col(d.coll).doc(id).set(record);
  await logActivity(session, `${route.toUpperCase().replace("-", "_")}_CREATED`, `${record.name || record.first_name || ""} created.`);
  return { success: true, message: "Created successfully.", [d.key.replace(/s$/, "")]: record };
}
/* ---- generic update (partial-friendly, worker semantics) ---- */
export async function updateRecord(session, route, id, body) {
  const d = moduleD(route);
  requireSchoolAdmin(session);
  const doc = await col(d.coll).doc(id).get();
  if (!doc.exists || doc.data().school_id !== session.school.id) {
    throw new Error("Record not found.");
  }
  const ex = doc.data();
  const next = { ...ex };

  if (route === "academic-years") {
    if (body.name) next.name = String(body.name).trim();
    next.start_date = body.start_date ?? ex.start_date ?? null;
    next.end_date = body.end_date ?? ex.end_date ?? null;
    if (body.is_current != null) {
      next.is_current = body.is_current ? 1 : 0;
      if (next.is_current) await clearCurrentFlag(session.school.id, "academic_years");
    }
    next.status = body.status ?? ex.status ?? "active";
  } else if (route === "terms") {
    if (body.name) next.name = String(body.name).trim();
    next.academic_year_id = body.academic_year_id ?? ex.academic_year_id ?? null;
    next.start_date = body.start_date ?? ex.start_date ?? null;
    next.end_date = body.end_date ?? ex.end_date ?? null;
    if (body.is_current != null) {
      next.is_current = body.is_current ? 1 : 0;
      if (next.is_current) await clearCurrentFlag(session.school.id, "terms");
    }
    next.status = body.status ?? ex.status ?? "active";
  } else if (route === "classes") {
    next.name = body.name ? String(body.name).trim() : ex.name;
    next.stream = body.stream != null ? String(body.stream).trim() : ex.stream;
    if (body.capacity != null) next.capacity = Number(body.capacity) || 0;
    if (body.class_teacher_id != null) next.class_teacher_id = body.class_teacher_id || null;
    next.status = body.status ?? ex.status ?? "active";
  } else if (route === "subjects") {
    next.code = body.code ? String(body.code).trim() : ex.code;
    next.name = body.name ? String(body.name).trim() : ex.name;
    next.status = body.status ?? ex.status ?? "active";
  } else if (route === "teachers") {
    next.staff_number = body.staff_number ? String(body.staff_number).trim() : ex.staff_number;
    next.first_name = body.first_name ?? ex.first_name;
    next.last_name = body.last_name ?? ex.last_name;
    for (const f of ["email", "phone", "gender", "employment_date", "employment_type"])
      if (body[f] != null) next[f] = body[f];
    next.status = body.status ?? ex.status ?? "active";
  } else if (route === "staff") {
    next.staff_number = body.staff_number ? String(body.staff_number).trim() : ex.staff_number;
    next.first_name = body.first_name ?? ex.first_name;
    next.last_name = body.last_name ?? ex.last_name;
    for (const f of ["department", "role", "email", "phone", "employment_date"])
      if (body[f] != null) next[f] = body[f];
    next.status = body.status ?? ex.status ?? "active";
  } else if (route === "exams") {
    next.name = body.name ? String(body.name).trim() : ex.name;
    for (const f of ["academic_year_id", "term_id", "start_date", "end_date"])
      if (body[f] != null) next[f] = body[f];
    next.status = body.status ?? ex.status ?? "active";
  } else {
    throw new Error("Route not found");
  }

  next.updated_at = nowIso();
  await col(d.coll).doc(id).update(next);
  await logActivity(session, `${route.toUpperCase().replace("-", "_")}_UPDATED`, `${next.name || next.first_name || ""} updated.`);
  return { success: true, message: "Updated successfully." };
}

export async function statusRecord(session, route, id, body) {
  const d = moduleD(route);
  requireSchoolAdmin(session);
  const doc = await col(d.coll).doc(id).get();
  if (!doc.exists || doc.data().school_id !== session.school.id) {
    throw new Error("Record not found.");
  }
  const next = (d.statuses && d.statuses.length)
    ? (d.statuses.includes(body.status) ? body.status : "active")
    : (body.status === "inactive" ? "inactive" : "active");
  await col(d.coll).doc(id).update({ status: next });
  await logActivity(session, `${route.toUpperCase().replace("-", "_")}_STATUS_CHANGED`, `Record marked ${next}.`);
  return { success: true, message: `Record is now ${next}.` };
}
/* ------------------------------------------------------------------ */
/*  STUDENTS  (list / create / get / update / status / finance)        */
/* ------------------------------------------------------------------ */

export async function listStudents(session, query) {
  requireSchoolAdmin(session);
  const search = (query.get("search") || "").trim();
  const classFilter = query.get("class_id") || "";
  const statusFilter = query.get("status") || "";
  const limit = Math.min(Number(query.get("limit")) || 20, 100);
  const offset = Number(query.get("offset")) || 0;

  let rows = [];
  try {
    const snap = await col("students").where("school_id", "==", session.school.id).limit(1000).get();
    rows = docsFrom(snap);
  } catch (e) {
    console.warn("ShuleSmart: students list failed", e);
    return { success: true, students: [], total: 0 };
  }

  rows = rows.filter((r) => r.status !== "deleted");
  if (classFilter) rows = rows.filter((r) => r.class_id === classFilter);
  if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
  if (search) {
    const term = search.toLowerCase();
    rows = rows.filter((r) =>
      `${r.first_name || ""} ${r.last_name || ""}`.toLowerCase().includes(term) ||
      String(r.admission_number || "").toLowerCase().includes(term)
    );
  }
  rows.sort((a, b) => ts(b.created_at) - ts(a.created_at));
  return { success: true, students: rows.slice(offset, offset + limit), total: rows.length };
}

export async function createStudent(session, body) {
  requireSchoolAdmin(session);
  const schoolId = session.school.id;
  let admission_number = String(body.admission_number || "").trim();
  const first_name = String(body.first_name || "").trim();
  const last_name = String(body.last_name || "").trim();
  if (!first_name || !last_name) {
    throw new Error("First name and last name are required.");
  }
  /* If no manual admission number is supplied and the school has auto
     generation enabled, assign the next number from the configured scheme.
     Otherwise a manual number is required. */
  let numbering = null;
  if (!admission_number) {
    numbering = await getSchoolNumbering(schoolId);
    if (numbering.admission_auto_generate) {
      admission_number = await nextAdmissionNumber(schoolId, numbering);
    } else {
      throw new Error("Admission number is required.");
    }
  } else {
    /* A number was supplied directly (e.g. prefilled from the Add-Student
       preview). If it follows the school's scheme, advance the sequence
       counter past it so the next auto/previewed number doesn't collide. */
    numbering = await getSchoolNumbering(schoolId);
    const prefix = numbering.admission_number_prefix;
    const re = new RegExp(`^${prefix}-(\\d+)$`);
    const m = String(admission_number).toUpperCase().match(re);
    if (m) {
      const used = parseInt(m[1], 10);
      if (!Number.isNaN(used)) {
        const ctrRef = col("admission_counters").doc(schoolId);
        await db.runTransaction(async (tx) => {
          const d = await tx.get(ctrRef);
          const last = d.exists ? (Number(d.data().last_no) || 0) : 0;
          if (used > last) tx.set(ctrRef, { school_id: schoolId, last_no: used, updated_at: nowIso() });
        });
      }
    }
  }

  const id = generateId("stu_");
  const record = {
    id, school_id: schoolId,
    admission_number, first_name, last_name,
    gender: body.gender || null,
    date_of_birth: body.date_of_birth || null,
    class_id: body.class_id || null,
    guardian_name: body.guardian_name || null,
    guardian_phone: body.guardian_phone || null,
    guardian_email: body.guardian_email || null,
    residential_address: body.residential_address || null,
    enrollment_date: body.enrollment_date || null,
    status: "active",
    created_at: nowIso(), updated_at: nowIso()
  };
  await col("students").doc(id).set(record);
  await logActivity(session, "STUDENT_CREATED", `Student ${first_name} ${last_name} (${admission_number}) enrolled.`);
  return { success: true, message: "Student created successfully.", student: record, fees_auto_posted: false };
}

export async function getStudent(session, id) {
  requireSchoolAdmin(session);
  const doc = await col("students").doc(id).get();
  if (!doc.exists || doc.data().school_id !== session.school.id) {
    throw new Error("Student not found.");
  }
  return { success: true, student: snapDoc(doc) };
}

export async function updateStudent(session, id, body) {
  requireSchoolAdmin(session);
  const doc = await col("students").doc(id).get();
  if (!doc.exists || doc.data().school_id !== session.school.id) {
    throw new Error("Student not found.");
  }
  const ex = doc.data();
  if (body.class_id && body.class_id !== ex.class_id) {
    const c = await col("classes").doc(body.class_id).get();
    if (!c.exists || c.data().school_id !== session.school.id) {
      throw new Error("The selected class does not exist.");
    }
  }
  const next = {
    admission_number: body.admission_number ? String(body.admission_number).trim() : ex.admission_number,
    first_name: body.first_name ?? ex.first_name,
    last_name: body.last_name ?? ex.last_name,
    gender: body.gender ?? ex.gender,
    date_of_birth: body.date_of_birth ?? ex.date_of_birth,
    class_id: body.class_id ?? ex.class_id,
    guardian_name: body.guardian_name ?? ex.guardian_name,
    guardian_phone: body.guardian_phone ?? ex.guardian_phone,
    guardian_email: body.guardian_email ?? ex.guardian_email,
    residential_address: body.residential_address ?? ex.residential_address,
    enrollment_date: body.enrollment_date ?? ex.enrollment_date,
    status: body.status ?? ex.status,
    updated_at: nowIso()
  };
  await col("students").doc(id).update(next);
  await logActivity(session, "STUDENT_UPDATED", `${next.first_name} ${next.last_name} (${next.admission_number}) updated.`);
  return { success: true, message: "Student updated successfully.", student: { ...ex, ...next } };
}

export async function updateStudentStatus(session, id, body) {
  requireSchoolAdmin(session);
  const doc = await col("students").doc(id).get();
  if (!doc.exists || doc.data().school_id !== session.school.id) {
    throw new Error("Student not found.");
  }
  const nxt = body.status === "inactive" ? "inactive" : "active";
  await col("students").doc(id).update({ status: nxt });
  await logActivity(session, "STUDENT_STATUS_CHANGED", `Student marked ${nxt}.`);
  return { success: true, message: `Student is now ${nxt}.` };
}
/** Ledger + finance summary for a single student (mirrors the worker). */
export async function studentFinance(session, id) {
  requireSchoolAdmin(session);
  const doc = await col("students").doc(id).get();
  if (!doc.exists || doc.data().school_id !== session.school.id) {
    throw new Error("Student not found.");
  }
  const stu = snapDoc(doc);
  const cls = stu.class_id ? await col("classes").doc(stu.class_id).get().catch(() => null) : null;

  let ledgerRows = [];
  try {
    const snap = await col("student_ledger").where("student_id", "==", id).limit(1000).get();
    ledgerRows = docsFrom(snap);
  } catch (e) { ledgerRows = []; }
  ledgerRows.sort((a, b) => ts(b.created_at) - ts(a.created_at));

  let charges = 0, payments = 0, discounts = 0, credit = 0, debit = 0;
  for (const l of ledgerRows) {
    charges += Number(l.debit || 0);
    payments += (l.transaction_type === "payment" ? Number(l.credit || 0) : 0);
    if (["DISCOUNT", "SCHOLARSHIP", "WAIVER", "SPECIAL_ADJUSTMENT", "credit"].includes(String(l.entry_type || l.transaction_type || ""))) {
      discounts += Number(l.credit || 0);
    }
    debit += Number(l.debit || 0);
    credit += Number(l.credit || 0);
  }
  const balance = debit - credit;
  const outstanding = Math.max(0, balance);
  const available = Math.max(0, -balance);

  let receipts = [];
  try {
    const rs = await col("receipts").where("student_id", "==", id).limit(20).get();
    receipts = docsFrom(rs);
  } catch (e) { /* leave */ }
  receipts.sort((a, b) => ts(b.payment_date) - ts(a.payment_date));

  return {
    success: true,
    student: {
      id: stu.id,
      name: `${stu.first_name || ""} ${stu.last_name || ""}`.trim(),
      admission_number: stu.admission_number,
      class_name: cls && cls.exists ? cls.data().name || "" : ""
    },
    summary: { outstanding_balance: outstanding, available_credit: available },
    charges, payments, discounts_waivers: discounts,
    recent_transactions: ledgerRows.slice(0, 50),
    recent_receipts: receipts.slice(0, 10)
  };
}
/* ------------------------------------------------------------------ */
/*  ATTENDANCE REPORT                                                  */
/* ------------------------------------------------------------------ */

export async function attendanceReport(session, query) {
  requireSchoolAdmin(session);
  const schoolId = session.school.id;
  const from = query.get("from") || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const to = query.get("to") || todayIso();
  const classFilter = query.get("class_id") || "";

  let students = [];
  try {
    const snap = await col("students").where("school_id", "==", schoolId).limit(1000).get();
    students = docsFrom(snap);
  } catch (e) { students = []; }
  if (classFilter) students = students.filter((s) => s.class_id === classFilter);

  const byStudent = new Map();
  try {
    const fromDate = new Date(from + "T00:00:00");
    const toDate = new Date(to + "T23:59:59");
    const snap = await col("attendance").where("school_id", "==", schoolId).get();
    snap.forEach((d) => {
      const a = d.data();
      const adate = new Date(String(a.date || "") + "T00:00:00");
      if (adate < fromDate || adate > toDate) return;
      const rec = byStudent.get(a.student_id) || { present: 0, absent: 0, late: 0, excused: 0, marked: 0 };
      const st = String(a.status || "present").toLowerCase();
      if (rec[st] != null) rec[st] += 1;
      rec.marked += 1;
      byStudent.set(a.student_id, rec);
    });
  } catch (e) { /* leave zeros */ }

  const report = students
    .map((s) => {
      const r = byStudent.get(s.id) || { present: 0, absent: 0, late: 0, excused: 0, marked: 0 };
      return {
        student_id: s.id,
        admission_number: s.admission_number,
        name: `${s.first_name || ""} ${s.last_name || ""}`.trim(),
        present: r.present,
        absent: r.absent,
        late: r.late,
        excused: r.excused,
        marked: r.marked
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { success: true, report, from, to };
}

/* ------------------------------------------------------------------ */
/*  ATTENDANCE REGISTER (mark + prefill)                                */
/*  One document per student per date: { school_id, student_id,         */
/*  class_id, date, status(present|absent|late|excused) }.              */
/* ------------------------------------------------------------------ */

const ATT_STATUSES = ["present", "absent", "late", "excused"];

/** GET /api/attendance?class_id&date — students of a class with any
 *  previously saved status for that date prefilled. */
export async function attendanceRoster(session, query) {
  requireSchoolAdmin(session);
  const schoolId = session.school.id;
  const classId = String(query.get("class_id") || "").trim();
  const date = String(query.get("date") || todayIso()).slice(0, 10);
  if (!classId) throw new Error("class_id is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("A valid date is required.");

  let students = [];
  try {
    const snap = await col("students").where("school_id", "==", schoolId).limit(1000).get();
    students = docsFrom(snap).filter((s) => s.status !== "deleted" && s.class_id === classId);
  } catch (e) { students = []; }
  students.sort((a, b) =>
    `${a.first_name || ""} ${a.last_name || ""}`.trim().localeCompare(`${b.first_name || ""} ${b.last_name || ""}`.trim()));

  /* Previously saved marks for this exact class + date. */
  const existing = new Map();
  try {
    const snap = await col("attendance")
      .where("school_id", "==", schoolId)
      .where("date", "==", date)
      .get();
    snap.forEach((d) => {
      const a = d.data();
      if (a.class_id !== classId) return;
      existing.set(a.student_id, { doc_id: d.id, status: String(a.status || "").toLowerCase() });
    });
  } catch (e) { /* nothing saved yet */ }

  return {
    success: true,
    class_id: classId,
    date,
    statuses: ATT_STATUSES,
    marked_count: existing.size,
    students: students.map((s) => {
      const hit = existing.get(s.id);
      return {
        student_id: s.id,
        admission_number: s.admission_number || "",
        name: `${s.first_name || ""} ${s.last_name || ""}`.trim(),
        status: hit ? hit.status : ""
      };
    })
  };
}

/** POST /api/attendance/save — bulk upsert one row per student for a date.
 *  Existing documents (same student + date) are updated, not duplicated. */
export async function saveAttendance(session, body) {
  requireSchoolAdmin(session);
  const schoolId = session.school.id;
  const classId = String(body.class_id || "").trim();
  const date = String(body.date || todayIso()).slice(0, 10);
  const records = Array.isArray(body.records) ? body.records : [];
     if (!classId) throw new Error("class_id is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("A valid date is required.");
  if (date > todayIso()) throw new Error("Attendance cannot be recorded for a future date.");
  if (!records.length) throw new Error("No attendance records to save.");

  const clean = [];
  for (const rec of records) {
    const sid = String(rec.student_id || "").trim();
    const st = String(rec.status || "").trim().toLowerCase();
    if (!sid) continue;
    if (!ATT_STATUSES.includes(st)) throw new Error(`Invalid status "${rec.status}" for a student.`);
    clean.push({ student_id: sid, status: st });
  }
  if (!clean.length) throw new Error("No attendance records to save.");

  /* Reuse existing documents so re-saving updates instead of duplicating. */
  const existingByStudent = new Map();
  try {
    const snap = await col("attendance")
      .where("school_id", "==", schoolId)
      .where("date", "==", date)
      .get();
    snap.forEach((d) => {
      const a = d.data();
      if (clean.some((c) => c.student_id === a.student_id)) {
        existingByStudent.set(a.student_id, d.id);
      }
    });
  } catch (e) { /* none yet */ }

  const now = nowIso();
  const FLUSH_AT = 450;
  let batch = db.batch();
  let ops = 0;
  for (const rec of clean) {
    const payload = {
      school_id: schoolId,
      student_id: rec.student_id,
      class_id: classId,
      date,
      status: rec.status,
      recorded_by: session.user.display_name,
      updated_at: now
    };
    const hitDocId = existingByStudent.get(rec.student_id);
    if (hitDocId) {
      batch.update(col("attendance").doc(hitDocId), payload);
    } else {
      const nid = generateId("att_");
      batch.set(col("attendance").doc(nid), { id: nid, ...payload, created_at: now });
    }
    ops++;
    if (ops >= FLUSH_AT) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  if (ops) await batch.commit();

  await logActivity(session, "ATTENDANCE_SAVED", `Attendance saved for ${clean.length} student(s) on ${date}.`);
  return {
    success: true,
    message: `Attendance saved for ${clean.length} student(s).`,
    saved: clean.length,
    date,
    class_id: classId
  };
}

/* ------------------------------------------------------------------ */
/*  MARKS + RESULTS (parity - mirrors the worker briefly)              */
/* ------------------------------------------------------------------ */

/** Roster for a marks entry board: students in a class with existing
 *  scores for the given exam+subject. */
export async function marksRoster(session, query) {
  requireSchoolAdmin(session);
  const examId = query.get("exam_id");
  const subjectId = query.get("subject_id");
  const classId = query.get("class_id");
  if (!examId || !subjectId || !classId) {
    throw new Error("exam_id, subject_id and class_id are required.");
  }
  const schoolId = session.school.id;
  const snap = await col("students").where("school_id", "==", schoolId).where("class_id", "==", classId).get();
  const students = docsFrom(snap).filter((s) => s.status !== "deleted");

  const marks = new Map();
  const ms = await col("marks")
    .where("school_id", "==", schoolId)
    .where("exam_id", "==", examId)
    .where("subject_id", "==", subjectId)
    .get().catch(() => null);
  if (ms) ms.forEach((d) => { marks.set(d.data().student_id, d.data().score); });

  const roster = students
    .map((s) => ({
      student_id: s.id,
      admission_number: s.admission_number,
      name: `${s.first_name || ""} ${s.last_name || ""}`.trim(),
      score: marks.has(s.id) ? marks.get(s.id) : null
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { success: true, roster };
}

/** Save marks for an exam + subject (batch replace). */
export async function saveMarks(session, body) {
  requireSchoolAdmin(session);
  const { exam_id, subject_id, class_id, marks: entries } = body || {};
  if (!exam_id || !subject_id || !class_id || !Array.isArray(entries)) {
    throw new Error("exam_id, subject_id, class_id and marks are required.");
  }
  const schoolId = session.school.id;
  const existing = await col("marks")
    .where("school_id", "==", schoolId)
    .where("exam_id", "==", exam_id)
    .where("subject_id", "==", subject_id)
    .get().catch(() => null);
  const batch = db.batch();
  if (existing) existing.forEach((d) => batch.delete(d.ref));
  for (const e of entries) {
    if (e.student_id == null) continue;
    const score = e.score == null || e.score === "" ? null : Number(e.score);
    batch.set(col("marks").doc(generateId("mark_")), {
      id: generateId("mark_"),
      school_id: schoolId,
      student_id: e.student_id,
      exam_id, subject_id, class_id,
      score: Number.isNaN(score) ? null : score,
      recorded_by: session.user.display_name,
      created_at: nowIso(), updated_at: nowIso()
    });
  }
  await batch.commit();
  await logActivity(session, "MARKS_SAVED", `Marks saved for exam ${exam_id}, subject ${subject_id}.`);
  return { success: true, message: "Marks saved successfully.", saved: entries.length };
}

/** Results: one row per student with totals + averages (parity). */
export async function getResults(session, query) {
  requireSchoolAdmin(session);
  const schoolId = session.school.id;
  const examId = query.get("exam_id");
  if (!examId) throw new Error("exam_id is required.");

  const classId = query.get("class_id") || "";
  const snap = await col("students").where("school_id", "==", schoolId).limit(1000).get();
  let students = docsFrom(snap).filter((s) => s.status !== "deleted");
  if (classId) students = students.filter((s) => s.class_id === classId);

  const rows = await col("marks").where("school_id", "==", schoolId).where("exam_id", "==", examId).get().catch(() => null);
  const byStudent = new Map();
  if (rows) rows.forEach((d) => {
    const m = d.data();
    const cur = byStudent.get(m.student_id) || [];
    cur.push(m);
    byStudent.set(m.student_id, cur);
  });

  const results = students.map((s) => {
    const mr = byStudent.get(s.id) || [];
    const total = mr.reduce((sum, m) => sum + Number(m.score || 0), 0);
    const valid = mr.filter((m) => m.score != null);
    const avg = valid.length ? total / valid.length : null;
    return {
      student_id: s.id,
      admission_number: s.admission_number,
      name: `${s.first_name || ""} ${s.last_name || ""}`.trim(),
      subject_count: valid.length,
      total,
      average: avg == null ? null : Math.round(avg * 100) / 100
    };
  }).sort((a, b) => (b.average || 0) - (a.average || 0));

  return { success: true, results };
}

/* ------------------------------------------------------------------ */
/*  EXAM RESULT DOCUMENTS (class ranking + per-student report forms)    */
/* ------------------------------------------------------------------ */

const DEFAULT_GRADE_SCALE = [
  { grade: "A", min: 80 }, { grade: "B", min: 65 }, { grade: "C", min: 50 },
  { grade: "D", min: 35 }, { grade: "E", min: 0 }
];

async function schoolGradingConfig(schoolId) {
  const d = await col("schools").doc(schoolId).get().catch(() => null);
  const s = (d && d.exists) ? d.data() : {};
  let scale = DEFAULT_GRADE_SCALE;
  try {
    if (typeof s.grade_scale === "string" && s.grade_scale.trim()) {
      const parsed = JSON.parse(s.grade_scale);
      if (Array.isArray(parsed) && parsed.length) scale = parsed;
    } else if (Array.isArray(s.grade_scale) && s.grade_scale.length) {
      scale = s.grade_scale;
    }
  } catch { /* keep default */ }
  return { mode: s.grading_mode === "grades" || s.grading_mode === "both" ? s.grading_mode : "marks", scale };
}

function gradeForScore(score, grading) {
  if (!grading || grading.mode === "marks") return "";
  const v = Number(score);
  if (score == null || Number.isNaN(v)) return "";
  const hit = (grading.scale || [])
    .map((g) => ({ grade: g.grade, min: Number(g.min) }))
    .filter((g) => !Number.isNaN(g.min) && v >= g.min)
    .sort((a, b) => b.min - a.min)[0];
  return hit ? hit.grade : "";
}

/** GET /api/results/detail?exam_id&class_id
 *  Everything the printable class-ranking sheet and per-student report
 *  forms need: subject-by-subject scores, totals, averages, position in
 *  class and letter grades (per the school's grading settings). */
export async function examResultsDetail(session, query) {
  requireSchoolAdmin(session);
  const schoolId = session.school.id;
  const examId = query.get("exam_id");
  if (!examId) throw new Error("exam_id is required.");
  const classId = query.get("class_id") || "";

  async function refRow(collName, rid) {
    if (!rid) return null;
    const d = await col(collName).doc(rid).get().catch(() => null);
    return d && d.exists && d.data().school_id === schoolId ? snapDoc(d) : null;
  }

  const examDoc = await col("exams").doc(examId).get();
  if (!examDoc.exists || examDoc.data().school_id !== schoolId) throw new Error("Exam not found.");
  const exam = snapDoc(examDoc);

  const classRow = classId ? await refRow("classes", classId) : null;
  const termRow = exam.term_id ? await refRow("terms", exam.term_id) : null;
  const yearRow = exam.academic_year_id ? await refRow("academic_years", exam.academic_year_id) : null;

  /* Subject catalogue (for names + column order). */
  const subjOrder = [];
  const subjNames = new Map();
  try {
    const ss = await col("subjects").where("school_id", "==", schoolId).limit(300).get();
    ss.forEach((d) => {
      const s = d.data();
      subjNames.set(d.id, s.name || s.code || d.id);
      subjOrder.push({ id: d.id, name: s.name || s.code || d.id });
    });
  } catch (e) { /* none configured */ }

  const grading = await schoolGradingConfig(schoolId);

  let students = [];
  try {
    const snap = await col("students").where("school_id", "==", schoolId).limit(1000).get();
    students = docsFrom(snap).filter((s) => s.status !== "deleted" && (!classId || s.class_id === classId));
  } catch (e) { students = []; }

  const marksRows = await col("marks")
    .where("school_id", "==", schoolId)
    .where("exam_id", "==", examId)
    .get().catch(() => null);
  const byStudent = new Map();
  const usedSubjects = new Set();
  if (marksRows) marksRows.forEach((d) => {
    const m = d.data();
    if (m.score == null) return;
    usedSubjects.add(m.subject_id);
    const arr = byStudent.get(m.student_id) || [];
    arr.push(m);
    byStudent.set(m.student_id, arr);
  });

  const className = classRow ? `${classRow.name || ""}${classRow.stream ? " " + classRow.stream : ""}`.trim() : "";

  const ranked = [];
  const unranked = [];
  for (const s of students) {
    const mr = (byStudent.get(s.id) || []).slice().sort((a, b) =>
      String(subjNames.get(a.subject_id) || "").localeCompare(String(subjNames.get(b.subject_id) || "")));
    const subjects = mr.map((m) => ({
      subject_id: m.subject_id,
      subject_name: subjNames.get(m.subject_id) || "Subject",
      score: m.score,
      grade: gradeForScore(m.score, grading)
    }));
    const scored = subjects.filter((x) => x.score != null);
    const total = scored.reduce((sum, x) => sum + Number(x.score || 0), 0);
    const average = scored.length ? Math.round((total / scored.length) * 100) / 100 : null;
    const row = {
      student_id: s.id,
      admission_number: s.admission_number || "",
      name: `${s.first_name || ""} ${s.last_name || ""}`.trim(),
      class_name: className,
      subjects,
      subject_count: scored.length,
      total: Math.round(total * 100) / 100,
      average,
      grade: average != null ? gradeForScore(average, grading) : ""
    };
    (scored.length ? ranked : unranked).push(row);
  }

  ranked.sort((a, b) => (b.average || 0) - (a.average || 0));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  unranked.forEach((r) => { r.rank = null; });

  return {
    success: true,
    exam: {
      id: exam.id || examId,
      name: exam.name || "",
      start_date: exam.start_date || null,
      end_date: exam.end_date || null
    },
    class_id: classId,
    class_name: className,
    term_name: (termRow && termRow.name) || "",
    academic_year_name: (yearRow && yearRow.name) || "",
    grading,
    subjects: subjOrder.filter((s) => usedSubjects.has(s.id)),
    students: [...ranked, ...unranked]
  };
}
