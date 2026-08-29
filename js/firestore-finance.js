/**
 * ============================================================
 * ShuleSmart — Firestore Finance Engine
 * Product by Prince Alex Digital
 * ============================================================
 * Ports the worker's finance endpoints to run directly against
 * Firestore: payments (receipt numbering, FIFO charge allocation,
 * overpayment credit), the append-only student ledger, receipts,
 * invoices, fee structures + generation, fee categories, finance
 * settings and the finance dashboard.
 * ============================================================
 */

import { db } from "./firestore-db.js";

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

async function getRef(collName, id) {
  if (!id) return null;
  const d = await col(collName).doc(id).get().catch(() => null);
  return d && d.exists ? snapDoc(d) : null;
}

/* ------------------------------------------------------------------ */
/*  Cost guards for the finance list screens                           */
/*                                                                     */
/*  List views never render unbounded history: scans are capped and    */
/*  student-name joins only touch what is actually rendered. Deeper    */
/*  records stay reachable through the search/filter boxes. Balance    */
/*  math still reads the school-wide ledger ONCE per request — that    */
/*  is the one genuinely required full read (per-student queries       */
/*  would be N+1 and demand composite indexes).                        */
/* ------------------------------------------------------------------ */
const FIN_LIST_CAP = 300;   /* payments / receipts / invoices / structures scans */

/** Newest-first ordering shared by every finance list. */
const byNewest = (a, b) => ts(b.created_at) - ts(a.created_at);

/** Point-read join of one student + class name — used to render a page
 *  window (≈10 rows → ≤20 reads instead of hundreds). */
async function studentCard(studentId) {
  const s = await getRef("students", studentId);
  if (!s) return null;
  const cls = s.class_id ? await getRef("classes", s.class_id) : null;
  return {
    name: `${s.first_name || ""} ${s.last_name || ""}`.trim(),
    admission_number: s.admission_number || "",
    class_id: s.class_id || "",
    class_name: (cls && cls.name) || "",
    guardian_name: s.guardian_name || "",
    guardian_phone: s.guardian_phone || ""
  };
}

/** Two collection reads → lookup used when a filter must match on joined
 *  student data across the WHOLE result set (text search / class filter). */
async function studentDirectory(schoolId) {
  const students = new Map(), classNames = new Map();
  try {
    const sSnap = await col("students").where("school_id", "==", schoolId).limit(1000).get();
    sSnap.forEach((d) => students.set(d.id, d.data()));
  } catch { /* empty */ }
  try {
    const cSnap = await col("classes").where("school_id", "==", schoolId).limit(200).get();
    cSnap.forEach((d) => classNames.set(d.id, d.data().name || ""));
  } catch { /* empty */ }
  return (id) => {
    const s = students.get(id);
    if (!s) return null;
    return {
      name: `${s.first_name || ""} ${s.last_name || ""}`.trim(),
      admission_number: s.admission_number || "",
      class_id: s.class_id || "",
      class_name: classNames.get(s.class_id) || "",
      guardian_name: s.guardian_name || "",
      guardian_phone: s.guardian_phone || ""
    };
  };
}

/* ==================================================================== */
/*  SEQUENCE / SETTINGS                                                  */
/* ==================================================================== */

export async function getFinanceSettings(schoolId) {
  const doc = await col("finance_settings").doc(schoolId).get().catch(() => null);
  const s = doc && doc.exists ? doc.data() : {};
  return {
    allocation_policy: s.allocation_policy || "FIFO",
    payment_methods: Array.isArray(s.payment_methods) ? s.payment_methods : ["M-PESA", "CASH", "BANK", "CARD", "OTHER"],
    receipt_prefix: String(s.receipt_prefix || "RCT").trim().toUpperCase() || "RCT",
    receipt_digits: Math.max(1, Math.min(8, Number(s.receipt_digits) || 6)),
    invoice_prefix: String(s.invoice_prefix || "INV").trim().toUpperCase() || "INV",
    admission_number_prefix: String(s.admission_number_prefix || "ADM").trim().toUpperCase() || "ADM",
    admission_number_start: Math.max(1, Number(s.admission_number_start) || 1),
    admission_number_padding: Math.max(1, Math.min(8, Number(s.admission_number_padding) || 4)),
    admission_auto_generate: s.admission_auto_generate !== false
  };
}

/** Generate the next receipt number: PREFIX-YYYY-NNNNNN. */
export async function nextReceiptNumber(schoolId, dateStr, prefix) {
  const settings = prefix ? { receipt_prefix: prefix } : await getFinanceSettings(schoolId);
  const p = prefix || settings.receipt_prefix;
  const digits = Math.max(1, Math.min(8, Number(settings.receipt_digits) || 6));
  const year = String(dateStr).slice(0, 4) || new Date().getFullYear().toString();
  const ctrRef = col("receipt_counters").doc(`${schoolId}_${year}`);
  const ctr = await db.runTransaction(async (tx) => {
    const cDoc = await tx.get(ctrRef);
    const last = cDoc.exists ? Number(cDoc.data().last_no || 0) : 0;
    const next = last + 1;
    tx.set(ctrRef, { school_id: schoolId, year: Number(year), last_no: next });
    return next;
  });
  return `${p}-${year}-${String(ctr).padStart(digits, "0")}`;
}

export async function nextInvoiceNumber(schoolId, dateStr, prefix = "INV") {
  const y = String(dateStr || todayIso()).slice(0, 4) || new Date().getFullYear().toString();
  const cRef = col("invoice_counters").doc(`${schoolId}_${y}`);
  const ctr = await db.runTransaction(async (tx) => {
    const cDoc = await tx.get(cRef);
    const last = cDoc.exists ? Number(cDoc.data().last_no || 0) : 0;
    const next = last + 1;
    tx.set(cRef, { school_id: schoolId, year: Number(y), last_no: next });
    return next;
  });
  return `${prefix}-${y}-${String(ctr).padStart(6, "0")}`;
}

/* ----------------------------------------------------------------- *
 *  LEDGER helpers                                                    *
 * ----------------------------------------------------------------- */

async function studentLedger(schoolId, studentId) {
  const snap = await col("student_ledger")
    .where("school_id", "==", schoolId)
    .where("student_id", "==", studentId)
    .get().catch(() => null);
  return snap ? docsFrom(snap) : [];
}

/* ==================================================================== */
/*  FEES: BALANCES + STATEMENT                                          */
/* ==================================================================== */

export async function feeBalances(session, query) {
  let students = [];
  try {
    const snap = await col("students").where("school_id", "==", session.school.id).limit(1000).get();
    students = docsFrom(snap).filter((s) => s.status !== "deleted");
  } catch (e) { students = []; }

  const year = query.get("academic_year_id") || "";
  const term = query.get("term_id") || "";
  const cls = query.get("class_id") || "";
  if (cls) students = students.filter((s) => s.class_id === cls);

  const classMap = new Map();
  const cs = await col("classes").where("school_id", "==", session.school.id).get().catch(() => null);
  if (cs) cs.forEach((d) => classMap.set(d.id, d.data().name || ""));

  /* ONE ledger read for the whole school, aggregated per student in memory.
     The old version ran one ledger query PER STUDENT (N+1 — hundreds of
     reads and round-trips per view). Identical math, three queries total. */
  const aggByStudent = new Map(); /* student_id -> [billed, paid] */
  try {
    const lsnap = await col("student_ledger").where("school_id", "==", session.school.id).limit(5000).get();
    lsnap.forEach((d) => {
      const l = d.data();
      if (String(l.status || "POSTED") === "REVERSED") return;
      if (year && l.academic_year_id !== year) return;
      if (term && l.term_id !== term) return;
      const cur = aggByStudent.get(l.student_id) || [0, 0];
      cur[0] += Number(l.debit || 0);
      cur[1] += Number(l.credit || 0);
      aggByStudent.set(l.student_id, cur);
    });
  } catch { /* zeros */ }

  const balances = [];
  for (const s of students) {
    const billedPaid = aggByStudent.get(s.id) || [0, 0];
    const billed = billedPaid[0];
    const paid = billedPaid[1];
    const balance = billed - paid;
    let status = "no_charges";
    if (billed > 0) status = balance > 0 ? "outstanding" : balance < 0 ? "credit" : "fully_paid";
    balances.push({
      id: s.id,
      student_id: s.id,
      admission_number: s.admission_number,
      name: `${s.first_name || ""} ${s.last_name || ""}`.trim(),
      class_name: classMap.get(s.class_id) || "",
      billed, paid, balance, status
    });
  }
  balances.sort((a, b) => a.name.localeCompare(b.name));
  const search = (query.get("search") || "").trim().toLowerCase();
  const statusFilter = query.get("balance_status") || "";
  const out = balances.filter((r) => {
    if (search && !(r.name.toLowerCase().includes(search) || String(r.admission_number || "").toLowerCase().includes(search))) return false;
    if (statusFilter && statusFilter !== "all" && r.status !== statusFilter) return false;
    return true;
  });
  return { success: true, balances: out, count: out.length };
}

/** Full chronological statement with running balance (worker parity). */
export async function studentStatement(session, studentId, query) {
  const stDoc = await col("students").doc(studentId).get();
  if (!stDoc.exists || stDoc.data().school_id !== session.school.id) {
    throw new Error("Student not found.");
  }
  const st = stDoc.data();
  const cls = st.class_id ? await getRef("classes", st.class_id) : null;

  const year = query.get("academic_year_id") || "";
  const term = query.get("term_id") || "";
  const from = query.get("from") || "";
  const to = query.get("to") || "";
  const type = query.get("transaction_type") || "";

  let ledger = await studentLedger(session.school.id, studentId);

  let openingBalance = 0;
  if (from) {
    openingBalance = ledger
      .filter((l) => String(l.transaction_date || "") < from)
      .reduce((s, l) => s + Number(l.debit || 0) - Number(l.credit || 0), 0);
  }

  let lines = ledger.filter((l) => {
    if (year && l.academic_year_id !== year) return false;
    if (term && l.term_id !== term) return false;
    if (from && String(l.transaction_date || "") < from) return false;
    if (to && String(l.transaction_date || "") > to) return false;
    if (type && String(l.entry_type || "").toUpperCase() !== type.toUpperCase()) return false;
    return true;
  });
  lines.sort((a, b) =>
    String(a.transaction_date || "").localeCompare(String(b.transaction_date || "")) ||
    ts(a.created_at) - ts(b.created_at)
  );

  let running = openingBalance;
  lines = lines.map((r) => {
    running += Number(r.debit || 0) - Number(r.credit || 0);
    return { ...r, balance: running };
  });

  /* Resolve readable names for every term/year referenced by the shown
     lines, and expose a stable `date` alias (the ledger stores the value in
     transaction_date, but the statement renderers read `date`). Without this
     the statement had blank dates and no term/year labels. */
  const termIds = [...new Set(lines.map((l) => l.term_id).filter(Boolean))];
  const yearIds = [...new Set(lines.map((l) => l.academic_year_id).filter(Boolean))];
  const termNames = new Map();
  const yearNames = new Map();
  await Promise.all(termIds.map(async (id) => {
    const t = await getRef("terms", id);
    if (t) termNames.set(id, t.name || "");
  }));
  await Promise.all(yearIds.map(async (id) => {
    const y = await getRef("academic_years", id);
    if (y) yearNames.set(id, y.name || "");
  }));
  lines = lines.map((r) => ({
    ...r,
    date: r.transaction_date || r.date || null,
    term_name: termNames.get(r.term_id) || "",
    year_name: yearNames.get(r.academic_year_id) || "",
    academic_year_name: yearNames.get(r.academic_year_id) || ""
  }));

  const period = { opening_balance: openingBalance };
  if (from) period.from = from;
  if (to) period.to = to;
  if (lines.length && !period.from) period.from = String(lines[0].transaction_date || "");
  if (lines.length && !period.to) period.to = String(lines[lines.length - 1].transaction_date || "");
  /* Prefer the explicitly filtered term/year; otherwise derive the set of
     names that appear in the shown transactions so the label is never blank. */
  if (term) {
    const t = await getRef("terms", term);
    period.term_name = (t && t.name) || "";
  } else {
    period.term_name = [...new Set(lines.map((l) => l.term_name).filter(Boolean))].join(", ");
  }
  if (year) {
    const y = await getRef("academic_years", year);
    period.academic_year_name = (y && y.name) || "";
  } else {
    period.academic_year_name = [...new Set(lines.map((l) => l.academic_year_name).filter(Boolean))].join(", ");
  }

  return {
    success: true,
    student: {
      name: `${st.first_name || ""} ${st.last_name || ""}`,
      admission_number: st.admission_number,
      class_name: (cls && cls.name) || "",
      gender: st.gender || "",
      guardian_name: st.guardian_name || "",
      guardian_phone: st.guardian_phone || ""
    },
    school: {
      name: session.school.name || "",
      code: session.school.school_code || "",
      phone: session.school.phone || "",
      email: session.school.email || "",
      county: session.school.county || "",
      physical_address: session.school.physical_address || ""
    },
    lines,
    totals: {
      opening_balance: openingBalance,
      charged: lines.reduce((s, l) => s + Number(l.debit || 0), 0),
      paid: lines.reduce((s, l) => s + Number(l.credit || 0), 0),
      balance: running
    },
    period
  };
}
/* ==================================================================== */
/*  PAYMENTS                                                            */
/* ==================================================================== */

/** List payments (student_name/class_name joins; financial figures are
 *  fetched on demand via getPaymentFinancials). */
export async function listPayments(session, query) {
  const schoolId = session.school.id;
  const search = (query.get("search") || "").trim();
  const limit = Math.min(Number(query.get("limit")) || 20, 100);
  const offset = Number(query.get("offset")) || 0;

  let rows = [];
  try {
    const snap = await col("payments").where("school_id", "==", schoolId).limit(FIN_LIST_CAP).get();
    rows = docsFrom(snap);
  } catch (e) { rows = []; }
  rows.sort(byNewest);

  /* NOTE: applied_to_fees / credit_carried / outstanding_balance are no
     longer computed here. They required two extra school-wide scans
     (payment_allocations + student_ledger) on EVERY page load, while the
     table never displays them. They are fetched fresh — for just one
     payment — via GET /api/payments/{id} when the View modal or the print
     action needs them (see getPaymentFinancials below). */
  const decorate = (r, stu) => ({
    ...r,
    student_name: (stu && stu.name) || "",
    admission_number: (stu && stu.admission_number) || "",
    class_name: (stu && stu.class_name) || "",
    applied_to_fees: null,
    credit_carried: null,
    outstanding_balance: null
  });
  const matchSearch = (p) => {
    if (!search) return true;
    const term = search.toLowerCase();
    return [p.student_name, p.admission_number, p.receipt_no, p.method, p.reference, p.notes]
      .some((v) => v && String(v).toLowerCase().includes(term));
  };

  let page, total;
  if (search) {
    /* Search matches on joined names → enrich everything (one directory
       read pair), filter, then slice. */
    const dir = await studentDirectory(schoolId);
    const enriched = rows.map((r) => decorate(r, dir(r.student_id))).filter(matchSearch);
    total = enriched.length;
    page = enriched.slice(offset, offset + limit);
  } else {
    /* Plain browsing renders ONE page — point-read names for just those
       rows instead of joining up to 400 students. */
    total = rows.length;
    page = await Promise.all(
      rows.slice(offset, offset + limit).map(async (r) => decorate(r, await studentCard(r.student_id)))
    );
  }

  return {
    success: true,
    payments: page,
    limit, offset, total
  };
}

/** Live financial figures for ONE payment — powers the View modal and the
 *  printed receipt without forcing every list view to scan the whole ledger.
 *  ≈3 reads instead of the previous ~7,000. */
export async function getPaymentFinancials(session, id) {
  const pDoc = await col("payments").doc(id).get();
  if (!pDoc.exists || pDoc.data().school_id !== session.school.id) {
    throw new Error("Payment not found.");
  }
  const p = snapDoc(pDoc);

  /* Allocations of this single payment: equality on payment_id alone rides
     the automatic single-field index — no composite index required. */
  let appliedTotal = 0;
  try {
    const asnap = await col("payment_allocations").where("payment_id", "==", id).get();
    asnap.forEach((d) => { appliedTotal += Number(d.data().amount || 0); });
  } catch { /* zeros */ }

  /* The student's live account position (same math as the old list scan,
     scoped to one student via the existing studentLedger helper). */
  const ledger = await studentLedger(session.school.id, p.student_id);
  let balance = 0;
  for (const l of ledger) {
    if (String(l.status || "POSTED") === "REVERSED") continue;
    balance += Number(l.debit || 0) - Number(l.credit || 0);
  }

  return {
    success: true,
    payment_id: id,
    applied_to_fees: Math.round(appliedTotal * 100) / 100,
    credit_carried: Math.max(0, Math.round((Number(p.amount || 0) - appliedTotal) * 100) / 100),
    outstanding_balance: Math.round(balance * 100) / 100
  };
}
/**
 * POST /api/payments — record a payment, issue a receipt number,
 * allocate to oldest open charges, carry overpayment as credit, and
 * write an immutable POSTED credit on the student's ledger.
 */
export async function createPayment(session, body) {
  const schoolId = session.school.id;
  const studentId = body.student_id;
  const amount = Math.max(0, Number(body.amount) || 0);
  if (!studentId) throw new Error("student_id is required.");
  if (!(amount > 0)) throw new Error("A positive payment amount is required.");

  const stDoc = await col("students").doc(studentId).get();
  if (!stDoc.exists || stDoc.data().school_id !== schoolId) {
    throw new Error("Student not found.");
  }
  const method = String(body.method || "Cash").trim();
  const reference = body.reference ? String(body.reference).trim() : null;
  const payDate = body.payment_date || todayIso();
  const notes = body.notes ? String(body.notes).trim() : null;
  const payerName = body.payer_name ? String(body.payer_name).trim() : null;

  /* ---- FIFO: allocate to oldest open charges ---- */
  const ledger = await studentLedger(schoolId, studentId);
  const netByReference = {};
  for (const l of ledger) {
    const refKey = l.reference_id || "unalloc";
    if (l.entry_type === "CHARGE") {
      netByReference[refKey] = (netByReference[refKey] || 0) + (Number(l.debit || 0) - Number(l.credit || 0));
    }
  }
  const charges = ledger
    .filter((l) => l.entry_type === "CHARGE")
    .sort((a, b) => String(a.transaction_date || "").localeCompare(String(b.transaction_date || "")) || ts(a.created_at) - ts(b.created_at));

  let toAllocate = amount;
  const allocations = [];
  for (const ch of charges) {
    if (toAllocate <= 0) break;
    const refKey = ch.reference_id || "unalloc";
    const remain = Math.max(0, Number(netByReference[refKey] || 0));
    if (remain <= 0) continue;
    const amt = Math.min(toAllocate, remain);
    if (amt <= 0) continue;
    allocations.push({ charge_id: ch.id || ch.reference_id, amount: amt });
    netByReference[refKey] -= amt;
    toAllocate -= amt;
  }
  const appliedTotal = allocations.reduce((s, a) => s + a.amount, 0);
  const creditCarried = Math.max(0, Math.round((amount - appliedTotal) * 100) / 100);

  const id = generateId("pay_");
  const receipt_no = await nextReceiptNumber(schoolId, payDate);
  await col("payments").doc(id).set({
    id,
    school_id: schoolId,
    student_id: studentId,
    amount,
    method,
    reference,
    payment_date: payDate,
    notes,
    payer_name: payerName,
    receipt_no,
    status: "COMPLETED",
    recorded_by: session.user.display_name,
    created_at: nowIso()
  });

  /* Explicit document id so the stored `id` field always matches it —
     routes address receipts by their real document id. */
  const receiptDocId = generateId("rcpt_");
  await col("receipts").doc(receiptDocId).set({
    id: receiptDocId,
    school_id: schoolId,
    student_id: studentId,
    payment_id: id,
    receipt_number: receipt_no,
    amount,
    method,
    reference,
    payment_date: payDate,
    status: "ISSUED",
    reprint_count: 0,
    last_reprinted_at: null,
    created_at: nowIso()
  });

  await col("student_ledger").add({
    id: generateId("led_"),
    school_id: schoolId,
    student_id: studentId,
    academic_year_id: body.academic_year_id || null,
    term_id: body.term_id || null,
    transaction_type: "payment",
    entry_type: "PAYMENT",
    entry_category: "FEES",
    payment_reference: reference,
    reference_type: "payment",
    reference_id: id,
    receipt_no,
    description: `Payment received (${method})`,
    debit: 0,
    credit: amount,
    transaction_date: payDate,
    created_by: session.user.display_name,
    status: "POSTED",
    created_at: nowIso()
  });

  if (allocations.length) {
    await col("payment_allocations").add({
      id: generateId("alloc_"),
      school_id: schoolId,
      payment_id: id,
      charge_id: allocations[0].charge_id,
      invoice_id: null,
      amount: appliedTotal,
      created_at: nowIso()
    });
  }

  await logFinanceActivity(session, "PAYMENT_RECORDED", `Payment ${receipt_no} recorded for ${amount} (${method}).`);

  /* Student's true ledger position after this payment:
     pre-balance (debits − credits) minus the new credit. */
  const preBalance = ledger.reduce(
    (bal, l) => bal + Number(l.debit || 0) - Number(l.credit || 0), 0
  );
  return {
    success: true,
    message: "Payment recorded.",
    payment: { id, student_id: studentId, amount, method, reference, payment_date: payDate, status: "COMPLETED" },
    receipt_no,
    applied_to_fees: appliedTotal,
    credit_carried: creditCarried,
    outstanding_balance: Math.max(0, Math.round((preBalance - amount) * 100) / 100)
  };
}
/* ==================================================================== */
/*  RECEIPTS                                                            */
/* ==================================================================== */

function normalizeReceipt(r, studentMap) {
  const stu = studentMap.get(r.student_id) || {};
  const cls = stu.class_id ? stu.class_name : "";
  return {
    ...r,
    student_name: stu.name || "",
    admission_number: stu.admission_number || "",
    class_name: cls || (r.class_name || ""),
    guardian_name: stu.guardian_name || "",
    guardian_phone: stu.guardian_phone || ""
  };
}

/** List receipts with filters. */
export async function listReceipts(session, query) {
  const schoolId = session.school.id;
  const search = (query.get("search") || "").trim();
  const status = query.get("status") || "";
  const from = query.get("from") || "";
  const to = query.get("to") || "";
  const limit = Math.min(Number(query.get("limit")) || 20, 100);
  const offset = Number(query.get("offset")) || 0;

  let rows = [];
  try {
    const snap = await col("receipts").where("school_id", "==", schoolId).limit(FIN_LIST_CAP).get();
    rows = docsFrom(snap);
  } catch (e) { rows = []; }

  /* Status + date filters use raw receipt fields — apply them BEFORE any
     student joins so plain browsing only ever joins one page of rows. */
  rows = rows.filter((r) => {
    if (status && String(r.status || "") !== status) return false;
    if (from && String(r.payment_date || "") < from) return false;
    if (to && String(r.payment_date || "") > to) return false;
    return true;
  });
  rows.sort((a, b) => ts(b.payment_date) - ts(a.payment_date));

  let receipts, total;
  if (search) {
    /* Text search includes student names → enrich everything first. */
    const dir = await studentDirectory(schoolId);
    const enriched = rows
      .map((r) => normalizeReceipt(r, new Map([[r.student_id, dir(r.student_id)]])))
      .filter((r) => {
        const term = search.toLowerCase();
        return [r.receipt_number, r.student_name, r.admission_number, r.method, r.reference]
          .some((v) => v && String(v).toLowerCase().includes(term));
      });
    total = enriched.length;
    receipts = enriched.slice(offset, offset + limit);
  } else {
    total = rows.length;
    receipts = await Promise.all(rows.slice(offset, offset + limit).map(async (r) => {
      const card = await studentCard(r.student_id);
      const m = new Map();
      if (card) m.set(r.student_id, card);
      return normalizeReceipt(r, m);
    }));
  }

  return {
    success: true,
    receipts,
    limit, offset, total
  };
}

/** Receipt detail — enriched with everything the printable receipt needs:
 *  guardian details (from the student), cashier / notes / term-year labels
 *  (from the linked payment) and the student's live account balance. */
export async function getReceipt(session, id) {
  const doc = await col("receipts").doc(id).get();
  if (!doc.exists || doc.data().school_id !== session.school.id) {
    throw new Error("Receipt not found.");
  }
  const r = snapDoc(doc);

  const sDoc = r.student_id ? await getRef("students", r.student_id) : null;
  const cls = sDoc && sDoc.class_id ? await getRef("classes", sDoc.class_id) : null;

  /* Linked payment carries the richer context captured at the counter. */
  const pDoc = r.payment_id ? await col("payments").doc(r.payment_id).get().catch(() => null) : null;
  const pay = pDoc && pDoc.exists ? snapDoc(pDoc) : {};
  const ay = pay.academic_year_id ? await getRef("academic_years", pay.academic_year_id) : null;
  const trm = pay.term_id ? await getRef("terms", pay.term_id) : null;

  /* Student's current account position (mirrors feeBalances). */
  const ledger = await studentLedger(session.school.id, r.student_id);
  let net = 0;
  for (const l of ledger) {
    if (String(l.status || "POSTED") === "REVERSED") continue;
    net += Number(l.debit || 0) - Number(l.credit || 0);
  }

  const stuMap = new Map([[r.student_id, {
    name: sDoc ? `${sDoc.first_name || ""} ${sDoc.last_name || ""}`.trim() : "",
    admission_number: sDoc ? sDoc.admission_number || "" : "",
    class_name: (cls && cls.name) || "",
    guardian_name: (sDoc && sDoc.guardian_name) || "",
    guardian_phone: (sDoc && sDoc.guardian_phone) || ""
  }]]);
  const receipt = normalizeReceipt({
    ...r,
    notes: pay.notes || "",
    payer_name: pay.payer_name || "",
    issued_by: pay.recorded_by || "",
    issued_at: r.created_at || null,
    academic_year_name: (ay && ay.name) || "",
    term_name: (trm && trm.name) || ""
  }, stuMap);

  return {
    success: true,
    receipt,
    balance: Math.round(net * 100) / 100,
    school: {
      name: session.school.name || "",
      code: session.school.school_code || "",
      phone: session.school.phone || "",
      email: session.school.email || "",
      county: session.school.county || "",
      physical_address: session.school.physical_address || ""
    }
  };
}

/** Mark a receipt as reprinted. */
export async function markReceiptReprint(session, receiptId) {
  const r = await col("receipts").doc(receiptId).get();
  if (!r.exists || r.data().school_id !== session.school.id) throw new Error("Receipt not found.");
  const cur = Number(r.data().reprint_count || 0);
  await col("receipts").doc(receiptId).update({ reprint_count: cur + 1, last_reprinted_at: todayIso() });
  return { success: true, message: "Receipt marked as reprinted." };
}

/** Void a receipt. If the receipt is linked to a payment, the linked payment
 *  is reversed too: a REVERSAL debit lands on the student's ledger (so the
 *  statement shows it and the fee credit is reinstated). Receipts without a
 *  linked payment are paperwork-only. */
export async function voidReceipt(session, receiptId) {
  const rDoc = await col("receipts").doc(receiptId).get();
  if (!rDoc.exists || rDoc.data().school_id !== session.school.id) throw new Error("Receipt not found.");
  const r = snapDoc(rDoc);
  if (String(r.status) === "VOIDED") throw new Error("Receipt is already voided.");

  let moneyReversed = false;
  if (r.payment_id) {
    const payDoc = await col("payments").doc(r.payment_id).get().catch(() => null);
    const pay = payDoc && payDoc.exists ? snapDoc(payDoc) : null;
    if (pay && String(pay.status) !== "REVERSED") {
      /* Identical financial trail to Reverse Payment: reversing DEBIT on the
         ledger, payment flagged REVERSED, sibling receipts flagged REVERSED. */
      await reversePayment(session, r.payment_id, {
        reason: `Receipt ${r.receipt_number || ""} voided`.trim()
      });
      moneyReversed = true;
    }
  }

  /* This receipt reads VOIDED (the audit intent); any sibling receipts of the
     same payment read REVERSED, as written by reversePayment above. */
  await col("receipts").doc(receiptId).update({
    status: "VOIDED",
    voided_at: todayIso(),
    voided_by: session.user.display_name
  });

  await logFinanceActivity(
    session,
    "RECEIPT_VOIDED",
    `Receipt ${r.receipt_number} voided${moneyReversed ? " and the linked payment reversed." : "."}`
  );
  return {
    success: true,
    money_reversed: moneyReversed,
    message: moneyReversed
      ? "Receipt voided — the linked payment was reversed and the fees were reinstated on the ledger."
      : "Receipt voided."
  };
}
/* ==================================================================== */
/*  REVERSAL / REFUND / CREDITS                                         */
/* ==================================================================== */

async function mustGetPayment(session, id) {
  const d = await col("payments").doc(id).get();
  if (!d.exists || d.data().school_id !== session.school.id) throw new Error("Payment not found.");
  return snapDoc(d);
}

async function mustGetStudent(session, id) {
  const d = await col("students").doc(id).get();
  if (!d.exists || d.data().school_id !== session.school.id) throw new Error("Student not found.");
  return snapDoc(d);
}

/** Reverse a payment: add a reversing DEBIT ledger entry, reopen. */
export async function reversePayment(session, paymentId, body) {
  const schoolId = session.school.id;
  const pay = await mustGetPayment(session, paymentId);
  const reason = String(body.reason || "").trim();
  if (!reason) throw new Error("A reversal reason is required.");
  if (String(pay.status) === "REVERSED") throw new Error("Payment is already reversed.");

  const now = todayIso();
  const amount = Number(pay.amount);

  await col("student_ledger").add({
    id: generateId("led_"),
    school_id: schoolId,
    student_id: pay.student_id,
    academic_year_id: pay.academic_year_id || null,
    term_id: pay.term_id || null,
    transaction_type: "reversal",
    entry_type: "REVERSAL",
    entry_category: "PAYMENT",
    payment_reference: pay.reference || null,
    reference_type: "payment_reversal",
    reference_id: paymentId,
    receipt_no: pay.receipt_no || null,
    description: `Reversal of payment ${pay.receipt_no || ""}`.trim(),
    debit: amount,
    credit: 0,
    transaction_date: now,
    created_by: session.user.display_name,
    status: "POSTED",
    reversed_at: now,
    reversed_by: session.user.display_name,
    reversal_reason: reason,
    created_at: nowIso()
  });

  await col("payments").doc(paymentId).update({ status: "REVERSED", reversed_at: now, reversed_by: session.user.display_name, reversal_reason: reason });
  const rs = await col("receipts").where("payment_id", "==", paymentId).get().catch(() => null);
  if (rs) {
    const b = db.batch();
    let n = 0;
    rs.forEach((d) => { b.update(d.ref, { status: "REVERSED" }); n++; });
    if (n) await b.commit();
  }

  await logFinanceActivity(session, "PAYMENT_REVERSED", `Payment ${pay.receipt_no} (${amount}) reversed: ${reason}.`);
  return { success: true, message: "Payment reversed and the original transaction retained." };
}
/** Record a refund (partial/full) against a payment. */
export async function refundPayment(session, paymentId, body) {
  const schoolId = session.school.id;
  const pay = await mustGetPayment(session, paymentId);
  const amount = Math.max(0, Number(body.amount) || 0);
  if (!(amount > 0)) throw new Error("A refund amount is required.");
  if (amount > Number(pay.amount)) throw new Error("Refund cannot exceed the original payment amount.");
  const reason = String(body.reason || "").trim();
  if (!reason) throw new Error("A refund reason is required.");
  const now = todayIso();

  await col("refunds").add({
    id: generateId("refund_"), school_id: schoolId, student_id: pay.student_id, payment_id: paymentId,
    amount, method: body.method || "CASH", reason, reference: body.reference || null,
    status: "PROCESSED", approved_by: session.user.display_name, created_by: session.user.display_name, created_at: nowIso()
  });
  await col("student_ledger").add({
    id: generateId("led_"), school_id: schoolId, student_id: pay.student_id,
    academic_year_id: pay.academic_year_id || null, term_id: pay.term_id || null,
    transaction_type: "refund", entry_type: "REFUND", entry_category: "FEES",
    payment_reference: pay.reference || null, reference_type: "payment_refund", reference_id: paymentId,
    receipt_no: pay.receipt_no || null, description: `Refund of ${amount} (${reason})`,
    debit: amount, credit: 0, transaction_date: now, created_by: session.user.display_name, status: "POSTED", created_at: nowIso()
  });
  if (amount >= Number(pay.amount)) {
    await col("payments").doc(paymentId).update({ status: "REFUNDED" });
  }
  await logFinanceActivity(session, "REFUND_PROCESSED", `Refund of ${amount} on ${pay.receipt_no}: ${reason}.`);
  return { success: true, message: "Refund processed." };
}

/** Re-allocate a payment across charges. */
export async function allocatePayment(session, paymentId, body) {
  const schoolId = session.school.id;
  const pay = await mustGetPayment(session, paymentId);
  const allocs = Array.isArray(body.allocations) ? body.allocations.filter((a) => Number(a.amount) > 0) : [];
  const total = allocs.reduce((s, a) => s + Number(a.amount), 0);
  if (Math.abs(total - Number(pay.amount)) > 0.01) throw new Error("Allocated total must equal the payment amount.");
  const batch = db.batch();
  const cur = await col("payment_allocations").where("payment_id", "==", paymentId).get();
  cur.forEach((d) => batch.delete(d.ref));
  for (const a of allocs) {
    const allocId = generateId("alloc_");
    batch.set(col("payment_allocations").doc(allocId), {
      id: allocId, school_id: schoolId, payment_id: paymentId,
      charge_id: a.charge_id || null, invoice_id: a.invoice_id || null, amount: Number(a.amount), created_at: nowIso()
    });
  }
  await batch.commit();
  await logFinanceActivity(session, "PAYMENT_REALLOCATED", `Payment ${pay.receipt_no} reallocated.`);
  return { success: true, message: "Payment allocation updated." };
}

/** Post a discount/waiver/scholarship credit to the ledger. */
export async function addStudentCredit(session, studentId, body) {
  const schoolId = session.school.id;
  const st = await mustGetStudent(session, studentId);
  const type = String(body.type || "ADJUSTMENT").toUpperCase();
  const creditTypes = ["DISCOUNT", "SCHOLARSHIP", "WAIVER", "SPECIAL_ADJUSTMENT", "ADJUSTMENT"];
  if (!creditTypes.includes(type)) throw new Error(`Unsupported credit type "${type}".`);
  const amount = Math.max(0, Number(body.amount) || 0);
  if (!(amount > 0)) throw new Error("A credit amount is required.");
  const reason = String(body.reason || body.description || "").trim();
  if (!reason) throw new Error("A credit reason is required.");
  const now = todayIso();

  await col("student_ledger").add({
    id: generateId("led_"), school_id: schoolId, student_id: studentId,
    academic_year_id: body.academic_year_id || null, term_id: body.term_id || null,
    transaction_type: type.toLowerCase(), entry_type: type, entry_category: "DISCOUNT",
    reference_type: "credit", reference_id: null, receipt_no: null,
    description: reason, debit: 0, credit: amount, transaction_date: now,
    created_by: session.user.display_name, status: "POSTED", created_at: nowIso()
  });
  await logFinanceActivity(session, "CREDIT_POSTED", `Credit of ${amount} (${type}) posted for ${st.first_name || ""} ${st.last_name || ""}.`);
  return { success: true, message: "Credit posted to the ledger." };
}
/* ==================================================================== */
/*  FINANCE DASHBOARD                                                   */
/* ==================================================================== */

export async function financeDashboard(session, query) {
  const schoolId = session.school.id;
  const year = query.get("academic_year_id") || "";
  const term = query.get("term_id") || "";
  const from = query.get("from") || "";
  const to = query.get("to") || "";

  let ledger = [];
  try {
    const snap = await col("student_ledger").where("school_id", "==", schoolId).limit(5000).get();
    ledger = docsFrom(snap);
  } catch (e) { ledger = []; }
  if (year) ledger = ledger.filter((l) => l.academic_year_id === year);
  if (term) ledger = ledger.filter((l) => l.term_id === term);
  if (from) ledger = ledger.filter((l) => String(l.transaction_date || "") >= from);
  if (to) ledger = ledger.filter((l) => String(l.transaction_date || "") <= to);

  const today = todayIso();
  const studentNet = new Map();
  let totalCharges = 0, totalPayments = 0, discounts = 0, todaysCollections = 0;
  for (const l of ledger) {
    if (String(l.status || "POSTED") === "REVERSED") continue;
    const d = Number(l.debit || 0);
    const c = Number(l.credit || 0);
    if (d > 0) totalCharges += d;
    if (l.entry_type === "PAYMENT" || l.transaction_type === "payment") totalPayments += c;
    if (["DISCOUNT", "SCHOLARSHIP", "WAIVER", "SPECIAL_ADJUSTMENT"].includes(String(l.entry_type || "")) && c > 0) discounts += c;
    if (String(l.transaction_date || "") === today && l.entry_type === "PAYMENT") todaysCollections += c;
    const cur = studentNet.get(l.student_id) || 0;
    studentNet.set(l.student_id, cur + d - c);
  }
  let outstanding = 0, credit = 0, studentsWithBalance = 0;
  studentNet.forEach((bal) => {
    if (bal > 0) { outstanding += bal; studentsWithBalance++; }
    else if (bal < 0) credit += Math.abs(bal);
  });

  const byMethod = new Map();
  for (const l of ledger) {
    if (l.entry_type !== "PAYMENT") continue;
    const m = String(l.payment_reference || "Other");
    const key = m || "Other";
    const cur = byMethod.get(key) || { method: m || "Other", count: 0, total: 0 };
    cur.count += 1;
    cur.total += Number(l.credit || 0);
    byMethod.set(key, cur);
  }

  let payments = [];
  try {
    /* True newest-first via orderBy when the school_id+created_at index
       exists; until then the inner catch falls back to a bounded scan. */
    const pSnap = await col("payments").where("school_id", "==", schoolId)
      .orderBy("created_at", "desc").limit(8).get()
      .catch(() => col("payments").where("school_id", "==", schoolId).limit(50).get());
    payments = pSnap ? docsFrom(pSnap) : [];
  } catch (e) { payments = []; }
  payments.sort(byNewest);
  const recentPayments = payments.slice(0, 8).map(async (p) => {
    const s = p.student_id ? await getRef("students", p.student_id) : null;
    return { ...p, student_name: s ? `${s.first_name || ""} ${s.last_name || ""}`.trim() : "", admission_number: s ? s.admission_number || "" : "" };
  });

  return {
    success: true,
    summary: {
      total_charges: Math.round(totalCharges * 100) / 100,
      total_payments_received: Math.round(totalPayments * 100) / 100,
      total_discounts_waivers: Math.round(discounts * 100) / 100,
      todays_collections: Math.round(todaysCollections * 100) / 100
    },
    balances: {
      outstanding: Math.round(outstanding * 100) / 100,
      credit: Math.round(credit * 100) / 100,
      students_with_balance: studentsWithBalance
    },
    by_method: [...byMethod.values()],
    recent_payments: await Promise.all(recentPayments),
    recent_reversals: []
  };
}
/* ==================================================================== */
/*  FEE STRUCTURES (v2)                                                 */
/* ==================================================================== */

async function linkFeeStructureName(s, refs) {
  const ay = s.academic_year_id ? await getRef("academic_years", s.academic_year_id) : null;
  const trm = s.term_id ? await getRef("terms", s.term_id) : null;
  const cls = s.class_id ? await getRef("classes", s.class_id) : null;
  return {
    ...s,
    academic_year_name: ay ? ay.name : "",
    term_name: trm ? trm.name : "",
    class_name: cls ? cls.name : "",
    total: Number(s.total || 0),
    item_count: (s.items || []).length,
    students_charged: Number(s.students_charged || 0)
  };
}

export async function listFeeStructures(session, query) {
  let rows = [];
  const snap = await col("fee_structures").where("school_id", "==", session.school.id).limit(FIN_LIST_CAP).get().catch(() => null);
  if (snap) rows = docsFrom(snap);
  const status = query.get("status") || "";
  let out = rows.filter((r) => r.status !== "deleted");
  if (status) out = out.filter((r) => r.status === status);
  out.sort((a, b) => ts(b.created_at) - ts(a.created_at));
  const limit = Math.min(Number(query.get("limit")) || 20, 100);
  const offset = Number(query.get("offset")) || 0;
  const page = await Promise.all(out.slice(offset, offset + limit).map((s) => linkFeeStructureName(s)));
  return { success: true, feeStructures: page, total: out.length };
}

export async function getFeeStructure(session, id) {
  const d = await col("fee_structures").doc(id).get();
  if (!d.exists || d.data().school_id !== session.school.id) throw new Error("Fee structure not found.");
  const s = snapDoc(d);
  return { success: true, structure: s, items: s.items || [], total: Number(s.total || 0), students_charged: Number(s.students_charged || 0) };
}

export async function saveFeeStructure(session, id, body) {
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((i) => String(i.item_name || i.name || "").trim() && Number(i.amount || 0) > 0)
    .map((i, idx) => ({
      item_name: String(i.item_name || i.name).trim(),
      amount: Math.max(0, Number(i.amount) || 0),
      mandatory: i.mandatory !== false,
      sort_order: idx,
      category: i.category || null,
      description: i.description || null
    }));
  if (!items.length) throw new Error("Add at least one fee item.");
  const total = items.reduce((s, i) => s + i.amount, 0);

  if (id) {
    const d = await col("fee_structures").doc(id).get();
    if (!d.exists || d.data().school_id !== session.school.id) throw new Error("Fee structure not found.");
    await col("fee_structures").doc(id).update({
      ...(body.name ? { title: String(body.name).trim() } : {}),
      academic_year_id: body.academic_year_id || d.data().academic_year_id || null,
      term_id: body.term_id || d.data().term_id || null,
      class_id: body.class_id || d.data().class_id || null,
      stream: body.stream ?? d.data().stream ?? null,
      notes: body.notes ?? d.data().notes ?? null,
      items, total,
      version: (d.data().version || 1),
      updated_at: nowIso()
    });
    return { success: true, message: "Fee structure updated.", structure: { id, title: body.name, total, items } };
  }

  const newId = generateId("fstruct_");
  await col("fee_structures").doc(newId).set({
    id: newId, school_id: session.school.id,
    title: String(body.name || body.title || "").trim(),
    academic_year_id: body.academic_year_id || null,
    term_id: body.term_id || null,
    class_id: body.class_id || null,
    stream: body.stream || null,
    notes: body.notes || null,
    items, total,
    version: 1,
    status: "active",
    students_charged: 0,
    created_at: nowIso(), updated_at: nowIso()
  });
  await logActivitySimple(session, "FEE_STRUCTURE_CREATED", `Fee structure ${String(body.name || "").trim()} created.`);
  return { success: true, message: "Fee structure created.", id: newId, total, items };
}
/** Generate charges for eligible students from a fee structure.
 *  Charges may ONLY be generated for the CURRENT, active term and year
 *  and for a specific class — never for a term that is not active. */
export async function generateFeeStructureCharges(session, id) {
  const d = await col("fee_structures").doc(id).get();
  if (!d.exists || d.data().school_id !== session.school.id) throw new Error("Fee structure not found.");
  const st = d.data();
  const items = st.items || [];
  if (!items.length) throw new Error("This structure has no fee items.");

  /* ---- Term must be current/active ---- */
  if (!st.term_id) throw new Error("Select a term on this fee structure before generating charges.");
  const tDoc = await col("terms").doc(st.term_id).get();
  if (!tDoc.exists || tDoc.data().school_id !== session.school.id) throw new Error("The term on this fee structure no longer exists.");
  const term = tDoc.data();
  if (Number(term.is_current) !== 1) {
    throw new Error("You can only generate charges for the current, active term. This structure is set to a term that is not currently active.");
  }

  /* ---- Academic year must be current ---- */
  if (!st.academic_year_id) throw new Error("Select an academic year on this fee structure before generating charges.");
  const ayDoc = await col("academic_years").doc(st.academic_year_id).get();
  if (!ayDoc.exists || ayDoc.data().school_id !== session.school.id) throw new Error("The academic year on this fee structure no longer exists.");
  if (Number(ayDoc.data().is_current) !== 1) {
    throw new Error("You can only generate charges for the current academic year. This structure is set to a year that is not currently active.");
  }

  /* ---- A specific class is required ---- */
  if (!st.class_id) throw new Error("Select a class on this fee structure before generating charges — charges are applied per class.");

  let students = [];
  const snap = await col("students").where("school_id", "==", session.school.id).limit(1000).get().catch(() => null);
  if (snap) students = docsFrom(snap).filter((s) => s.status === "active");
  // Charge only students currently enrolled in the structure's class.
  students = students.filter((s) => s.class_id === st.class_id);

  const chargedSnap = await col("student_charges").where("school_id", "==", session.school.id).where("structure_id", "==", id).get().catch(() => null);
  const already = new Set();
  if (chargedSnap) chargedSnap.forEach((d2) => already.add(d2.data().student_id));
  const targets = students.filter((s) => !already.has(s.id));

  const today = todayIso();
  const total = items.reduce((s2, i) => s2 + Number(i.amount || 0), 0);

  /* Firestore batches cap at 500 operations — commit in chunks so any
     school size works (1 charge doc + 1 ledger entry per fee item). */
  const FLUSH_AT = 450;
  let batch = db.batch();
  let ops = 0;
  let n = 0;

  for (const stu of targets) {
    const chargeId = generateId("chg_");
    batch.set(col("student_charges").doc(chargeId), {
      id: chargeId, school_id: session.school.id, student_id: stu.id,
      structure_id: id,
      academic_year_id: st.academic_year_id || null, term_id: st.term_id || null,
      class_id: st.class_id || null, total_amount: total,
      status: "active", created_by: session.user.display_name, created_at: nowIso()
    });
    ops++;
    for (const it of items) {
      const ledId = generateId("led_");
      batch.set(col("student_ledger").doc(ledId), {
        id: ledId, school_id: session.school.id, student_id: stu.id,
        academic_year_id: st.academic_year_id || null, term_id: st.term_id || null,
        transaction_type: "fee_charge", entry_type: "CHARGE", entry_category: "FEES",
        reference_type: "charge", reference_id: chargeId, description: it.item_name,
        debit: Number(it.amount || 0), credit: 0, transaction_date: today,
        created_by: session.user.display_name, status: "POSTED", created_at: nowIso()
      });
      ops++;
    }
    n++;
    if (ops >= FLUSH_AT) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops) await batch.commit();
  await col("fee_structures").doc(id).update({ students_charged: (st.students_charged || 0) + n });
  await logActivitySimple(session, "FEES_GENERATED", `${n} student(s) charged from ${st.title}.`);
  return { success: true, message: `${n} student(s) charged successfully.`, generated: n };
}

export async function statusFeeStructure(session, id, body) {
  const d = await col("fee_structures").doc(id).get();
  if (!d.exists || d.data().school_id !== session.school.id) throw new Error("Fee structure not found.");
  const next = body.status === "archived" ? "archived" : "active";
  await col("fee_structures").doc(id).update({ status: next });
  return { success: true, message: `Fee structure is now ${next}.` };
}
/* ==================================================================== */
/*  FINANCE SETTINGS + FEE CATEGORIES                                    */
/* ==================================================================== */

export async function financeSettingsGet(session) {
  const settings = await getFinanceSettings(session.school.id);
  let cats = [];
  const cs = await col("fee_categories").where("school_id", "==", session.school.id).get().catch(() => null);
  if (cs) cats = docsFrom(cs).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return { success: true, settings, fee_categories: cats };
}

export async function financeSettingsUpdate(session, body) {
  const schoolId = session.school.id;
  const cur = await getFinanceSettings(schoolId);
  const methods = Array.isArray(body.payment_methods) ? body.payment_methods.map(String) : null;

  const boolVal = (v, dflt) => {
    if (v == null) return dflt;
    return typeof v === "string" ? (v === "true" || v === "1") : !!v;
  };
  const numVal = (v, dflt, min, max) => {
    const n = Number(v);
    if (v == null || v === "" || Number.isNaN(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  };

  await col("finance_settings").doc(schoolId).set({
    school_id: schoolId,
    allocation_policy: body.allocation_policy || cur.allocation_policy,
    payment_methods: methods || cur.payment_methods,
    receipt_prefix: String(body.receipt_prefix || cur.receipt_prefix).trim().toUpperCase() || cur.receipt_prefix,
    receipt_digits: numVal(body.receipt_digits, cur.receipt_digits, 1, 8),
    invoice_prefix: body.invoice_prefix || cur.invoice_prefix,
    admission_number_prefix: String(body.admission_number_prefix || cur.admission_number_prefix).trim().toUpperCase() || cur.admission_number_prefix,
    admission_number_start: numVal(body.admission_number_start, cur.admission_number_start, 1, 99999999),
    admission_number_padding: numVal(body.admission_number_padding, cur.admission_number_padding, 1, 8),
    admission_auto_generate: boolVal(body.admission_auto_generate, cur.admission_auto_generate),
    updated_by: session.user.display_name,
    updated_at: nowIso()
  }, { merge: true });
  await logActivitySimple(session, "FINANCE_SETTINGS_UPDATED", "Finance settings updated.");
  return { success: true, message: "Finance settings updated." };
}

export async function createFeeCategory(session, body) {
  const name = String(body.name || "").trim();
  if (!name) throw new Error("Category name is required.");
  await col("fee_categories").add({
    id: generateId("fcat_"), school_id: session.school.id, name,
    kind: String(body.kind || "CHARGE").toUpperCase(),
    description: body.description || null,
    created_by: session.user.display_name, created_at: nowIso()
  });
  await logActivitySimple(session, "FEE_CATEGORY_CREATED", `Fee category "${name}" created.`);
  return { success: true, message: "Fee category created." };
}

export async function deleteFeeCategory(session, body) {
  if (!body.id) throw new Error("Category id is required.");
  await col("fee_categories").doc(body.id).delete();
  return { success: true, message: "Fee category deleted." };
}
/* ==================================================================== */
/*  INVOICES                                                             */
/* ==================================================================== */

export async function listInvoices(session, query) {
  const schoolId = session.school.id;
  const search = (query.get("search") || "").trim();
  const status = query.get("status") || "";
  const studentId = query.get("student_id") || "";
  const year = query.get("academic_year_id") || "";
  const term = query.get("term_id") || "";
  const cls = query.get("class_id") || "";
  const limit = Math.min(Number(query.get("limit")) || 20, 200);
  const offset = Number(query.get("offset")) || 0;

  let rows = [];
  const snap = await col("invoices").where("school_id", "==", schoolId).limit(FIN_LIST_CAP).get().catch(() => null);
  if (snap) rows = docsFrom(snap);

  /* Status / student / year / term live on the invoice doc itself — filter
     those BEFORE any student joins. */
  rows = rows.filter((r) => {
    if (status && r.status !== status) return false;
    if (studentId && r.student_id !== studentId) return false;
    if (year && r.academic_year_id !== year) return false;
    if (term && r.term_id !== term) return false;
    return true;
  });
  rows.sort(byNewest);

  /* class_id and student names come from the joined student doc, so class
     and text-search filters need the full directory join; plain browsing
     only point-reads the visible page. */
  let invoices, total;
  if (cls || search) {
    const dir = await studentDirectory(schoolId);
    const enriched = rows
      .map((r) => ({ ...r, ...(dir(r.student_id) || {}) }))
      .filter((r) => {
        if (cls && r.class_id !== cls) return false;
        if (search) {
          const t = search.toLowerCase();
          return [r.invoice_number, r.student_name, r.admission_number].some((v) => v && String(v).toLowerCase().includes(t));
        }
        return true;
      });
    total = enriched.length;
    invoices = enriched.slice(offset, offset + limit);
  } else {
    total = rows.length;
    invoices = await Promise.all(
      rows.slice(offset, offset + limit).map(async (r) => ({ ...r, ...(await studentCard(r.student_id)) }))
    );
  }

  return { success: true, invoices, total };
}

export async function getInvoiceDetail(session, id) {
  const d = await col("invoices").doc(id).get();
  if (!d.exists || d.data().school_id !== session.school.id) throw new Error("Invoice not found.");
  const inv = snapDoc(d);
  const items = (inv.items || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  let allocs = [];
  const as = await col("payment_allocations").where("invoice_id", "==", id).get().catch(() => null);
  if (as) allocs = docsFrom(as);
  const sDoc = inv.student_id ? await getRef("students", inv.student_id) : null;
  return {
    success: true,
    invoice: {
      ...inv,
      student_name: sDoc ? `${sDoc.first_name || ""} ${sDoc.last_name || ""}`.trim() : "",
      admission_number: sDoc ? sDoc.admission_number || "" : ""
    },
    items,
    allocations: allocs
  };
}
/** Create invoices from a structure or custom items for selected students. */
export async function createInvoices(session, body) {
  const schoolId = session.school.id;
  let structure = null;
  let itemList = [];
  if (body.structure_id) {
    structure = await col("fee_structures").doc(body.structure_id).get().then((dd) => (dd.exists && dd.data().school_id === schoolId) ? dd.data() : null).catch(() => null);
    if (!structure) throw new Error("Fee structure not found.");
    itemList = (structure.items || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  } else if (Array.isArray(body.items)) {
    itemList = body.items
      .filter((i) => String(i.item_name || i.description || "").trim() && Number(i.amount) > 0)
      .map((i, idx) => ({ item_name: String(i.item_name || i.description).trim(), amount: Number(i.amount), category: i.category || null, description: i.description || null, sort_order: idx }));
  }
  if (!itemList.length) throw new Error("No fee items to invoice.");

  const ayId = body.academic_year_id || (structure ? structure.academic_year_id : null);
  const termId = body.term_id || (structure ? structure.term_id : null);
  const classId = body.class_id || (structure ? structure.class_id : null);

  let targets = [];
  if (Array.isArray(body.student_ids) && body.student_ids.length) {
    const ids = body.student_ids.slice(0, 200);
    const snap = await col("students").where("school_id", "==", schoolId).where("status", "==", "active").get().catch(() => null);
    if (snap) targets = docsFrom(snap).filter((s) => ids.includes(s.id));
  } else {
    const snap = await col("students").where("school_id", "==", schoolId).where("status", "==", "active").limit(500).get().catch(() => null);
    if (snap) targets = docsFrom(snap);
  }
  if (classId) targets = targets.filter((s) => s.class_id === classId);
  if (!targets.length) return { success: true, message: "No students matched.", created: 0, skipped: 0, invoices: [] };

  const today = todayIso();
  const dueDate = body.due_date || null;
  const discountAmount = Math.max(0, Number(body.discount_amount) || 0);
  const subtotal = itemList.reduce((sum, it) => sum + Number(it.amount || 0), 0);
  const createdInvoices = [];
  let skipped = 0;

  for (const s of targets) {
    const invNo = await nextInvoiceNumber(schoolId, today);
    const invId = generateId("inv_");
    await col("invoices").doc(invId).set({
      id: invId, school_id: schoolId, student_id: s.id,
      invoice_number: invNo,
      academic_year_id: ayId, term_id: termId,
      class_id: s.class_id || classId || (structure ? structure.class_id : null),
      status: "DRAFT",
      subtotal, discount_amount: discountAmount,
      total_amount: Math.max(0, subtotal - discountAmount),
      issue_date: today, due_date: dueDate,
      source_structure_id: structure ? structure.id : null,
      amount_paid: null, posted_at: null,
      created_by: body.created_by || session.user.display_name,
      notes: body.notes || null,
      items: itemList,
      created_at: nowIso(), updated_at: nowIso()
    });
    createdInvoices.push({ id: invId, invoice_number: invNo, student_id: s.id });
  }
  await logActivitySimple(session, "INVOICES_BULK_CREATED", `${createdInvoices.length} invoice(s) created.`);
  return { success: true, message: `${createdInvoices.length} invoice(s) created.`, created: createdInvoices.length, skipped, invoices: createdInvoices };
}

async function mustOwnInvoice(session, id) {
  const d = await col("invoices").doc(id).get();
  if (!d || !d.exists || d.data().school_id !== session.school.id) throw new Error("Invoice not found.");
  return snapDoc(d);
}

/** Issue invoice (DRAFT -> ISSUED). */
export async function issueInvoice(session, id) {
  const inv = await mustOwnInvoice(session, id);
  await col("invoices").doc(id).update({ status: "ISSUED", updated_at: nowIso() });
  await logActivitySimple(session, "INVOICE_ISSUED", `Invoice ${inv.invoice_number} issued.`);
  return { success: true, message: "Invoice issued.", invoice: { ...inv, status: "ISSUED" } };
}
/** Post invoice charges to the student ledger (idempotent). */
export async function postInvoice(session, id) {
  const inv = await mustOwnInvoice(session, id);
  if (inv.posted_at) throw new Error("Invoice has already been posted to the ledger.");
  if (!["ISSUED", "DRAFT"].includes(inv.status)) throw new Error("Only issued or draft invoices can be posted.");
  const items = inv.items || [];
  if (!items.length) throw new Error("Invoice has no items to post.");
  const now = todayIso();
  const batch = db.batch();
  for (const it of items) {
    const ledId = generateId("led_");
    batch.set(col("student_ledger").doc(ledId), {
      id: ledId, school_id: session.school.id, student_id: inv.student_id,
      academic_year_id: inv.academic_year_id || null, term_id: inv.term_id || null,
      transaction_type: "fee_charge", entry_type: "CHARGE", entry_category: it.category || "FEES",
      reference_type: "invoice", reference_id: id,
      description: String(it.description || it.item_name), debit: Number(it.amount || 0), credit: 0,
      transaction_date: now, created_by: session.user.display_name, status: "POSTED", created_at: nowIso()
    });
  }
  if (Number(inv.discount_amount) > 0) {
    const discId = generateId("led_");
    batch.set(col("student_ledger").doc(discId), {
      id: discId, school_id: session.school.id, student_id: inv.student_id,
      academic_year_id: inv.academic_year_id || null, term_id: inv.term_id || null,
      transaction_type: "discount", entry_type: "DISCOUNT", entry_category: "DISCOUNT",
      reference_type: "invoice", reference_id: id,
      description: `Discount applied to ${inv.invoice_number}`, debit: 0, credit: Number(inv.discount_amount),
      transaction_date: now, created_by: session.user.display_name, status: "POSTED", created_at: nowIso()
    });
  }
  await batch.commit();
  await col("invoices").doc(id).update({ posted_at: now, posted_by: session.user.display_name, updated_at: nowIso() });
  await logActivitySimple(session, "INVOICE_POSTED", `Invoice ${inv.invoice_number} charges posted to ledger.`);
  return { success: true, message: "Invoice charges posted to the student ledger.", posted: items.length };
}

/** Cancel invoice (only when nothing posted). */
export async function cancelInvoice(session, id) {
  const inv = await mustOwnInvoice(session, id);
  if (inv.posted_at) throw new Error("Posted invoices cannot be cancelled — reverse the ledger entries instead.");
  await col("invoices").doc(id).update({ status: "CANCELLED", updated_at: nowIso() });
  await logActivitySimple(session, "INVOICE_CANCELLED", `Invoice ${inv.invoice_number} cancelled.`);
  return { success: true, message: "Invoice cancelled." };
}

/* ==================================================================== */
/*  ACTIVITY                                                             */
/* ==================================================================== */

export async function logActivitySimple(session, action, description) {
  try {
    await col("activity_logs").add({
      school_id: session.school?.id || session.user?.school_id || null,
      user_id: session.user?.id || "",
      user_display_name: session.user?.display_name || "System",
      action,
      description,
      created_at: new Date()
    });
  } catch (e) {
    console.warn("ShuleSmart: activity log write failed", e && e.message);
  }
}

/** Alias for the older call sites that used logFinanceActivity. */
async function logFinanceActivity(session, action, description) {
  return logActivitySimple(session, action, description);
}