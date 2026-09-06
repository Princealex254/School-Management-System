/**
 * ============================================================
 * ShuleSmart — School Admin API Layer (Firestore edition)
 * Product by Prince Alex Digital
 * ============================================================
 * Drop-in replacement for the Cloudflare Worker API. Every page
 * keeps importing apiGet/apiPost/apiPut/apiPatch/apiDelete — the
 * functions now execute directly against Firebase Firestore via
 * the data engines instead of calling a remote worker.
 *
 *   js/firestore-data.js    — session, CRUD, academics
 *   js/firestore-finance.js — ledger, payments, invoices…
 *   js/firestore-admin.js   — owner, settings, promotions
 *
 * Errors are thrown as Error(message) exactly like before, so all
 * existing catch (e) => showToast(e.message) paths keep working.
 * ============================================================
 */

import {
  resolveSession,
  listModule, createRecord, updateRecord, statusRecord, fetchByKey,
  listStudents, createStudent, getStudent, updateStudent,
  updateStudentStatus, studentFinance, nextAdmissionPreview,
  attendanceReport, attendanceRoster, saveAttendance, marksRoster, saveMarks, getResults, examResultsDetail,
  getCurrentTerm, getCurrentAcademicYear
} from "./firestore-data.js";
import {
  feeBalances, studentStatement,
  listPayments, createPayment,
  listReceipts, getReceipt, markReceiptReprint, voidReceipt,
  reversePayment, refundPayment, allocatePayment, addStudentCredit,
  financeDashboard, financeSettingsGet, financeSettingsUpdate,
  createFeeCategory, deleteFeeCategory,
  listFeeStructures, getFeeStructure, saveFeeStructure,
  generateFeeStructureCharges, statusFeeStructure,
  listInvoices, getInvoiceDetail, createInvoices,
  getPaymentFinancials,
  issueInvoice, postInvoice, cancelInvoice
} from "./firestore-finance.js";
import {
  listSchools, createSchool, getSchool, updateSchool, deleteSchool,
  listSchoolAdmins, createSchoolAdmin, updateSchoolAdmin,
  toggleSchoolAdminStatus, deleteSchoolAdmin,
  listPortalUsers, createPortalUser, updatePortalUser, togglePortalUserStatus,
  schoolDashboard, schoolSettingsGet, schoolSettingsUpdate,
  updateOwnProfile,
  promotionsPreview, promotionBatchesList, promotionBatchCreate,
  promotionBatchGet, promotionBatchMapping, promotionBatchGenerate,
  promotionStudentOverride, promotionBatchComplete, promotionBatchDiscard
} from "./firestore-admin.js";

/* ------------------------------------------------------------------ */
/*  Endpoint router                                                    */
/* ------------------------------------------------------------------ */

import { canAccessSection } from "./common.js";

const GENERIC_MODULES = [
  "academic-years", "terms", "classes", "subjects", "teachers", "staff", "exams", "activity"
];

/* ------------------------------------------------------------------ */
/*  Role gate — data-layer mirror of the sidebar filter                */
/* ------------------------------------------------------------------ */

function cachedPortalUser() {
  try {
    const raw = localStorage.getItem("shulesmart_session_cache");
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && parsed.session && parsed.session.user) || null;
  } catch { return null; }
}

/** Endpoint prefix -> nav key. Null = not menu-scoped (auth/owner/etc.). */
function requiredMenuKey(endpoint) {
  const clean = String(endpoint || "").split("?")[0];
  const parts = clean.split("/").filter(Boolean);
  if (parts[0] !== "api") return null;
  if (clean.startsWith("/api/auth") || clean === "/api/me") return null;
  if (clean.startsWith("/api/school/settings")) return "settings";
  if (clean.startsWith("/api/school")) return null;
  if (clean.startsWith("/api/finance")) return "finance-dashboard";
  if (parts[1] === "attendance" && parts[2] === "report") return "attendance-reports";
  const map = {
    students: "students", teachers: "teachers", staff: "staff",
    classes: "classes", subjects: "subjects", exams: "exams",
    marks: "marks", results: "results", attendance: "attendance",
    fees: "fees", payments: "payments", receipts: "receipts",
    invoices: "invoices", "fee-structures": "fee-structure",
    promotions: "promotions", activity: "activity", users: "users",
    "academic-years": "academic-years", terms: "terms"
  };
  return map[parts[1]] || null;
}

/** Blocks API calls that fall outside the signed-in account's sections.
 *  Reads only the local session cache (no extra Firestore reads); the
 *  cache is refreshed by every page load's background session revalidation.
 *
 *  Reads (GET) of the pure "reference" modules are allowed for everyone:
 *  those lists (academic years, terms, classes, subjects, exams) are loaded
 *  as filter/dropdown data by many OTHER sections, so a custom grant must
 *  never break an unrelated page's dropdowns. Writes stay gated. */
function assertRoleCanManage(endpoint, method) {
  const user = cachedPortalUser();
  if (!user || user.platform_role !== "school_admin") return;
  const key = requiredMenuKey(endpoint);
  if (!key) return;
  if (method === "GET" && ["academic-years", "terms", "classes", "subjects", "exams"].includes(key)) return;
  if (!canAccessSection(user, key)) {
    throw new Error("Your account does not have access to manage this section.");
  }
}

async function route(method, rawEndpoint, body) {
  const [pathPart, queryPart] = String(rawEndpoint).split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const query = new URLSearchParams(queryPart || "");
  const seg = (i) => parts[i] || "";
  const last = () => parts[parts.length - 1] || "";
  const mod = seg(1);
  /* ---------- Public / identity ---------- */
  if (pathPart === "/api/auth/me" && method === "GET") {
    const s = await resolveSession();
    return { success: true, firebase: s.firebase, user: s.user, school: s.school };
  }
  if (pathPart === "/api/me" && method === "GET") {
    const s = await resolveSession();
    return { success: true, firebase: s.firebase, platformUser: s.user, registered: true };
  }
  if (pathPart === "/api/auth/profile" && method === "PUT") {
    return updateOwnProfile(await resolveSession(), body || {});
  }

  /* ---------- Owner: schools ---------- */
  if (pathPart === "/api/schools" && method === "GET") return listSchools(await resolveSession());
  if (pathPart === "/api/schools" && method === "POST") return createSchool(await resolveSession(), body || {});
  if (mod === "schools" && seg(2)) {
    if (method === "GET") return getSchool(await resolveSession(), seg(2));
    if (method === "PUT") return updateSchool(await resolveSession(), seg(2), body || {});
    if (method === "DELETE") return deleteSchool(await resolveSession(), seg(2));
  }

  /* ---------- Owner: school admins ---------- */
  if (pathPart === "/api/school-admins" && method === "GET") return listSchoolAdmins(await resolveSession());
  if (pathPart === "/api/school-admins" && method === "POST") return createSchoolAdmin(await resolveSession(), body || {});
  /* ---------- School Head: portal user accounts for their own school ----- */
  if (pathPart === "/api/users" && method === "GET") return listPortalUsers(await resolveSession(), query);
  if (pathPart === "/api/users" && method === "POST") return createPortalUser(await resolveSession(), body || {});
  if (mod === "users" && seg(2)) {
    if (last() === "status" && method === "PATCH") return togglePortalUserStatus(await resolveSession(), seg(2), body || {});
    if (method === "PUT") return updatePortalUser(await resolveSession(), seg(2), body || {});
  }
  if (mod === "school-admins" && seg(2)) {
    if (last() === "status" && method === "PATCH") return toggleSchoolAdminStatus(await resolveSession(), seg(2), body || {});
    if (method === "PUT") return updateSchoolAdmin(await resolveSession(), seg(2), body || {});
    if (method === "DELETE") return deleteSchoolAdmin(await resolveSession(), seg(2));
  }

  /* ---------- School admin: dashboard + settings ---------- */
  if (pathPart === "/api/school/dashboard" && method === "GET") return schoolDashboard(await resolveSession());
  if (pathPart === "/api/school/settings" && method === "GET") return schoolSettingsGet(await resolveSession());
  if (pathPart === "/api/school/settings" && method === "PUT") return schoolSettingsUpdate(await resolveSession(), body || {});

  /* ---------- Generic CRUD modules ---------- */
  if (parts[0] === "api" && GENERIC_MODULES.includes(mod)) {
    const session = await resolveSession();
    if (!seg(2) && method === "GET") return listModule(session, mod, query);
    if (!seg(2) && method === "POST") return createRecord(session, mod, body || {});
    if (seg(2) && last() === "status" && method === "PATCH") return statusRecord(session, mod, seg(2), body || {});
    if (seg(2) && method === "PUT") return updateRecord(session, mod, seg(2), body || {});
    if (seg(2) && method === "GET") {
      const rec = await fetchByKey(session, mod, seg(2));
      const singular = { "academic-years": "year", terms: "term", classes: "class", subjects: "subject", teachers: "teacher", staff: "member", exams: "exam", activity: "entry" }[mod] || "record";
      return { success: true, [singular]: rec };
    }
  }
  /* ---------- Students ---------- */
  if (pathPart === "/api/students/next-admission" && method === "GET") return nextAdmissionPreview(await resolveSession());
  if (mod === "students") {
    const id = seg(2);
    if (!id && method === "GET") return listStudents(await resolveSession(), query);
    if (!id && method === "POST") return createStudent(await resolveSession(), body || {});
    const session = await resolveSession();
    if (id && last() === "finance" && method === "GET") return studentFinance(session, id);
    if (id && last() === "statement" && method === "GET") return studentStatement(session, id, query);
    if (id && last() === "credits" && method === "POST") return addStudentCredit(session, id, body || {});
    if (id && last() === "status" && method === "PATCH") return updateStudentStatus(session, id, body || {});
    if (id && method === "GET") return getStudent(session, id);
    if (id && method === "PUT") return updateStudent(session, id, body || {});
  }

  /* ---------- Academics: attendance / marks / results ---------- */
  if (pathPart === "/api/attendance" && method === "GET") return attendanceRoster(await resolveSession(), query);
  if (pathPart === "/api/attendance/save" && method === "POST") return saveAttendance(await resolveSession(), body || {});
  if (pathPart === "/api/attendance/report" && method === "GET") return attendanceReport(await resolveSession(), query);
  if (pathPart === "/api/marks" && method === "GET") return marksRoster(await resolveSession(), query);
  if (pathPart === "/api/marks" && method === "POST") return saveMarks(await resolveSession(), body || {});
  if (pathPart === "/api/results" && method === "GET") return getResults(await resolveSession(), query);
  if (pathPart === "/api/results/detail" && method === "GET") return examResultsDetail(await resolveSession(), query);

  /* ---------- Current term / year helper ---------- */
  if (pathPart === "/api/terms/current" && method === "GET") return getCurrentTerm(await resolveSession());
  if (pathPart === "/api/academic-years/current" && method === "GET") return getCurrentAcademicYear(await resolveSession());

  /* ---------- Finance ---------- */
  if (pathPart === "/api/fees/balances" && method === "GET") return feeBalances(await resolveSession(), query);
  if (pathPart === "/api/payments" && method === "GET") return listPayments(await resolveSession(), query);
  if (pathPart === "/api/payments" && method === "POST") return createPayment(await resolveSession(), body || {});
  if (mod === "payments" && seg(2)) {
    const tail = last();
    if (tail === "reverse" && method === "POST") return reversePayment(await resolveSession(), seg(2), body || {});
    if (tail === "refund" && method === "POST") return refundPayment(await resolveSession(), seg(2), body || {});
    if (tail === "allocate" && method === "POST") return allocatePayment(await resolveSession(), seg(2), body || {});
    if (method === "GET") return getPaymentFinancials(await resolveSession(), seg(2));
  }
  if (mod === "receipts") {
    const id = seg(2);
    if (!id && method === "GET") return listReceipts(await resolveSession(), query);
    if (id && last() === "reprint" && method === "POST") return markReceiptReprint(await resolveSession(), id);
    if (id && last() === "void" && method === "POST") return voidReceipt(await resolveSession(), id);
    if (id && method === "GET") return getReceipt(await resolveSession(), id);
  }
  if (pathPart === "/api/finance/dashboard" && method === "GET") return financeDashboard(await resolveSession(), query);
  if (pathPart === "/api/finance/settings" && method === "GET") return financeSettingsGet(await resolveSession());
  if (pathPart === "/api/finance/settings" && method === "PUT") return financeSettingsUpdate(await resolveSession(), body || {});
  if (pathPart === "/api/fee-categories" && method === "POST") return createFeeCategory(await resolveSession(), body || {});
  if (pathPart === "/api/fee-categories" && method === "DELETE") return deleteFeeCategory(await resolveSession(), body || {});
  /* ---------- Fee structures ---------- */
  if (mod === "fee-structures") {
    const id = seg(2);
    const session = await resolveSession();
    if (!id && method === "GET") return listFeeStructures(session, query);
    if (!id && method === "POST") return saveFeeStructure(session, null, body || {});
    if (id && last() === "status" && method === "PATCH") return statusFeeStructure(session, id, body || {});
    if (id && last() === "generate" && method === "POST") return generateFeeStructureCharges(session, id);
    if (id && method === "GET") return getFeeStructure(session, id);
    if (id && method === "PUT") return saveFeeStructure(session, id, body || {});
  }

  /* ---------- Invoices ---------- */
  if (mod === "invoices") {
    const id = seg(2);
    const session = await resolveSession();
    if (!id && method === "GET") return listInvoices(session, query);
    if (!id && method === "POST") return createInvoices(session, body || {});
    if (id && last() === "issue" && method === "PATCH") return issueInvoice(session, id);
    if (id && last() === "post" && method === "POST") return postInvoice(session, id);
    if (id && last() === "cancel" && method === "PATCH") return cancelInvoice(session, id);
    if (id && method === "GET") return getInvoiceDetail(session, id);
  }

  /* ---------- Promotions ---------- */
  if (pathPart === "/api/promotions/preview" && method === "GET") return promotionsPreview(await resolveSession(), query);
  if (pathPart === "/api/promotions/batches" && method === "GET") return promotionBatchesList(await resolveSession());
  if (pathPart === "/api/promotions/batches" && method === "POST") return promotionBatchCreate(await resolveSession(), body || {});
  if (mod === "promotions" && seg(2) === "batches" && seg(3)) {
    const batchId = seg(3);
    const tail = last();
    const session = await resolveSession();
    if (!seg(4) && method === "GET") return promotionBatchGet(session, batchId);
    if (tail === "mapping" && method === "PUT") return promotionBatchMapping(session, batchId, body || {});
    if (tail === "generate" && method === "POST") return promotionBatchGenerate(session, batchId);
    if (tail === "complete" && method === "POST") return promotionBatchComplete(session, batchId, body || {});
    if (tail === "discard" && method === "POST") return promotionBatchDiscard(session, batchId);
    if (seg(4) === "students" && seg(5) && method === "PUT") {
      return promotionStudentOverride(session, batchId, seg(5), body || {});
    }
  }

  throw new Error(`Route not found (${method} ${pathPart})`);
}

/* ------------------------------------------------------------------ */
/*  Public API — identical signatures to the previous REST client       */
/* ------------------------------------------------------------------ */

export async function apiRequest(endpoint, options = {}) {
  const method = (options.method || "GET").toUpperCase();

  let body = options.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  try {
    assertRoleCanManage(endpoint, method);
    return await route(method, endpoint, body || {});
  } catch (error) {
    const code = String((error && error.code) || "");
    /* Firestore permission/network failures read better as plain text. */
        if (code.startsWith("permission-denied")) {
      throw new Error("You do not have permission to perform this action." + (error && error.message ? " (" + error.message + ")" : ""));
    }
    if (code.startsWith("unavailable") || code.startsWith("failed-precondition")) {
      throw new Error("Unable to reach the database. Check your connection and try again.");
    }
    throw new Error((error && error.message) || "Request failed.");
  }
}

/* Convenience wrappers so modules read naturally. */
export const apiGet = (endpoint) => apiRequest(endpoint, { method: "GET" });

export const apiPost = (endpoint, body) =>
  apiRequest(endpoint, { method: "POST", body: JSON.stringify(body) });

export const apiPut = (endpoint, body) =>
  apiRequest(endpoint, { method: "PUT", body: JSON.stringify(body) });

export const apiPatch = (endpoint, body) =>
  apiRequest(endpoint, { method: "PATCH", body: JSON.stringify(body) });

export const apiDelete = (endpoint) =>
  apiRequest(endpoint, { method: "DELETE" });