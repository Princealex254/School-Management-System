/**
 * ============================================================
 * ShuleSmart — Print module (receipts & statements)
 * ============================================================
 * Reusable branded A4 documents rendered in a hidden iframe so
 * the browser's native Print dialog can be used to print or
 * "Save as PDF".
 */

import { apiGet, apiPost } from "./api.js";
import { escapeHtml, initials, formatDate, formatDateTime, formatCurrency } from "./common.js";

/* ------------------------------------------------------------------ */
/*  Low-level: open a printable document for `content` (inner body)    */
/* ------------------------------------------------------------------ */

/* Reused hidden print frame — created once, never removed, so no
   iframe document is ever unloaded (avoids Chrome's benign
   "Permissions policy violation: unload is not allowed" warning). */
let printFrame = null;

function getPrintFrame() {
  if (printFrame && document.body.contains(printFrame)) return printFrame;
  printFrame = document.createElement("iframe");
  printFrame.setAttribute("aria-hidden", "true");
  printFrame.setAttribute("tabindex", "-1");
  printFrame.style.cssText =
    "position:fixed;right:-10000px;bottom:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none;";
  document.body.appendChild(printFrame);
  return printFrame;
}

/* Shared stylesheet for every printable document. */
const PRINT_STYLES = `
  *{box-sizing:border-box;} html,body{margin:0;padding:0;}
  body{font-family:'Inter',Arial,sans-serif;color:#0F172A;background:#fff;}
  .print-doc{max-width:780px;margin:0 auto;padding:24px 40px;page-break-after:always;}
  .print-doc:last-child{page-break-after:auto;}
  .print-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:3px solid #1E3A8A;padding-bottom:14px;margin-bottom:18px;}
  .print-brand{display:flex;align-items:center;gap:12px;}
  .print-mark{width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,#2563EB,#14B8A6);color:#fff;display:flex;align-items:center;justify-content:center;font-family:'Plus Jakarta Sans',sans-serif;font-size:18px;font-weight:800;flex-shrink:0;}
  .print-brand-name{font-family:'Plus Jakarta Sans',sans-serif;font-size:21px;font-weight:800;color:#1E3A8A;line-height:1.1;}
  .print-brand-code{font-size:11px;color:#64748B;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-top:3px;}
  .print-title{font-family:'Plus Jakarta Sans',sans-serif;font-size:23px;font-weight:800;color:#0F172A;text-transform:uppercase;letter-spacing:.04em;text-align:right;line-height:1.1;}
  .print-sub{font-size:11px;color:#64748B;text-align:right;margin-top:5px;text-transform:none;letter-spacing:0;}
  .print-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 28px;margin:12px 0 6px;}
  .print-field{font-size:13px;margin-bottom:7px;}
  .print-field .k{color:#64748B;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:1px;}
  .print-field .v{font-weight:700;color:#0F172A;font-size:14px;}
  .print-table{width:100%;border-collapse:collapse;margin:10px 0 12px;font-size:13px;}
  .print-table th{background:#1E3A8A;color:#fff;text-align:left;padding:9px 10px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;}
  .print-table td{padding:8px 10px;border-bottom:1px solid #E2E8F0;vertical-align:top;}
  .print-table tr:nth-child(even) td{background:#F8FAFC;}
  .print-table.small th{padding:6px 5px;font-size:9px;text-align:center;}
  .print-table.small td{padding:5px 5px;font-size:10.5px;text-align:center;}
  .print-table.small td.name,.print-table.small th.name{text-align:left;}
  .amount{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
  .print-totals{display:flex;justify-content:flex-end;gap:28px;margin-top:8px;padding-top:14px;border-top:1px solid #E2E8F0;}
  .t-box{text-align:right;}
  .t-box .k{font-size:10.5px;color:#64748B;font-weight:700;text-transform:uppercase;letter-spacing:.06em;display:block;}
  .t-box .v{font-size:17px;font-weight:800;color:#0F172A;margin-top:3px;font-variant-numeric:tabular-nums;}
  .t-box.hero .v{color:#1E3A8A;font-size:21px;}
  .print-ack{margin-top:20px;padding-top:14px;border-top:1px solid #E2E8F0;font-size:13px;color:#0F172A;line-height:1.6;}
  .print-sign{margin-top:26px;display:flex;justify-content:space-between;gap:24px;font-size:12px;color:#334155;}
  .print-sign .line{width:190px;border-top:1.5px solid #334155;margin-top:26px;}
  .print-note{margin-top:14px;font-size:11.5px;color:#64748B;line-height:1.5;}
  .print-currency{margin:0 0 -2px;font-size:11.5px;color:#64748B;font-weight:600;}
  .print-sub{font-family:'Plus Jakarta Sans',sans-serif;font-size:12.5px;font-weight:800;color:#1E3A8A;text-transform:uppercase;letter-spacing:.07em;margin:20px 0 8px;padding-bottom:6px;border-bottom:1.5px solid #E2E8F0;}
  .print-remark{border:1.5px dashed #CBD5E1;border-radius:10px;padding:10px 12px;min-height:52px;font-size:12px;color:#334155;margin-bottom:12px;}
  .rf-rank{font-size:15px;font-weight:800;color:#1E3A8A;}
`;

/** Shared branded letterhead markup. */
function printHeadMarkup(sName, sCode, title) {
  return `
    <div class="print-head">
      <div class="print-brand">
        <div class="print-mark">${escapeHtml(initials(sName))}</div>
        <div>
          <div class="print-brand-name">${escapeHtml(sName)}</div>
          ${sCode ? `<div class="print-brand-code">${escapeHtml(sCode)}</div>` : ""}
        </div>
      </div>
      <div>
        <div class="print-title">${escapeHtml(title)}</div>
        <div class="print-sub">Generated ${escapeHtml(formatDateTime(new Date().toISOString()))}</div>
      </div>
    </div>`;
}

export function printHTML({ title = "ShuleSmart", content = "", school = null } = {}) {
  const ctx = school || window.currentSchool || {};
  const sName = (ctx.name || "").trim() || "ShuleSmart";
  const sCode = (ctx.school_code || ctx.code || "").trim();

  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;} html,body{margin:0;padding:0;}
  body{font-family:'Inter',Arial,sans-serif;color:#0F172A;background:#fff;}
  .print-doc{max-width:780px;margin:0 auto;padding:24px 40px;}
  .print-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:3px solid #1E3A8A;padding-bottom:14px;margin-bottom:18px;}
  .print-brand{display:flex;align-items:center;gap:12px;}
  .print-mark{width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,#2563EB,#14B8A6);color:#fff;display:flex;align-items:center;justify-content:center;font-family:'Plus Jakarta Sans',sans-serif;font-size:18px;font-weight:800;flex-shrink:0;}
  .print-brand-name{font-family:'Plus Jakarta Sans',sans-serif;font-size:21px;font-weight:800;color:#1E3A8A;line-height:1.1;}
  .print-brand-code{font-size:11px;color:#64748B;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-top:3px;}
  .print-title{font-family:'Plus Jakarta Sans',sans-serif;font-size:23px;font-weight:800;color:#0F172A;text-transform:uppercase;letter-spacing:.04em;text-align:right;line-height:1.1;}
  .print-sub{font-size:11px;color:#64748B;text-align:right;margin-top:5px;text-transform:none;letter-spacing:0;}
  .print-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 28px;margin:12px 0 6px;}
  .print-field{font-size:13px;margin-bottom:7px;}
  .print-field .k{color:#64748B;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:1px;}
  .print-field .v{font-weight:700;color:#0F172A;font-size:14px;}
  .print-table{width:100%;border-collapse:collapse;margin:10px 0 12px;font-size:13px;}
  .print-table th{background:#1E3A8A;color:#fff;text-align:left;padding:9px 10px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;}
  .print-table td{padding:8px 10px;border-bottom:1px solid #E2E8F0;vertical-align:top;}
  .print-table tr:nth-child(even) td{background:#F8FAFC;}
  .amount{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
  .print-totals{display:flex;justify-content:flex-end;gap:28px;margin-top:8px;padding-top:14px;border-top:1px solid #E2E8F0;}
  .t-box{text-align:right;}
  .t-box .k{font-size:10.5px;color:#64748B;font-weight:700;text-transform:uppercase;letter-spacing:.06em;display:block;}
  .t-box .v{font-size:17px;font-weight:800;color:#0F172A;margin-top:3px;font-variant-numeric:tabular-nums;}
  .t-box.hero .v{color:#1E3A8A;font-size:21px;}
  .print-ack{margin-top:20px;padding-top:14px;border-top:1px solid #E2E8F0;font-size:13px;color:#0F172A;line-height:1.6;}
  .print-sign{margin-top:26px;display:flex;justify-content:space-between;gap:24px;font-size:12px;color:#334155;}
  .print-sign .line{width:190px;border-top:1.5px solid #334155;margin-top:4px;}
  .print-note{margin-top:14px;font-size:11.5px;color:#64748B;line-height:1.5;}
  .print-currency{margin:0 0 -2px;font-size:11.5px;color:#64748B;font-weight:600;}
  .print-sub{font-family:'Plus Jakarta Sans',sans-serif;font-size:12.5px;font-weight:800;color:#1E3A8A;text-transform:uppercase;letter-spacing:.07em;margin:20px 0 8px;padding-bottom:6px;border-bottom:1.5px solid #E2E8F0;}
  .print-amount{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:12px;padding:14px 18px;margin:16px 0;flex-wrap:wrap;}
  .print-amount .lab{font-size:10.5px;color:#1E3A8A;font-weight:700;text-transform:uppercase;letter-spacing:.06em;}
  .print-amount .val{font-size:26px;font-weight:800;color:#1E3A8A;font-variant-numeric:tabular-nums;line-height:1.1;margin-top:4px;}
  .print-words{font-size:12px;color:#334155;font-weight:600;font-style:italic;margin-top:6px;max-width:430px;line-height:1.5;}
  .print-pill{display:inline-block;background:#EEF2FF;color:#1E3A8A;font-weight:700;font-size:10.5px;border-radius:999px;padding:2px 9px;margin-left:8px;vertical-align:middle;}
  .print-muted{color:#64748B;font-weight:500;}
  .print-badge{display:inline-block;background:#DBEAFE;color:#1D4ED8;font-weight:700;font-size:10.5px;border-radius:6px;padding:1px 7px;margin-top:3px;}
    @media print{
    body{print-color-adjust:exact;-webkit-print-color-adjust:exact;}
    .print-doc{padding:6px 0;}
    @page{margin:14mm 12mm;}
    .report-cards .report-card{break-inside:avoid;page-break-inside:avoid;}
  }
  /* One report card per printed page (multi-page PDF via a single print job). */
  .report-cards .report-card{break-inside:avoid;break-after:page;page-break-inside:avoid;page-break-after:always;}
  .report-cards .report-card:last-child{break-after:auto;page-break-after:auto;}
</style>
</head>
<body>
  <div class="print-doc">
    <div class="print-head">
      <div class="print-brand">
        <div class="print-mark">${escapeHtml(initials(sName))}</div>
        <div>
          <div class="print-brand-name">${escapeHtml(sName)}</div>
          ${sCode ? `<div class="print-brand-code">${escapeHtml(sCode)}</div>` : ""}
        </div>
      </div>
      <div>
        <div class="print-title">${escapeHtml(title)}</div>
        <div class="print-sub">Generated ${escapeHtml(formatDateTime(new Date().toISOString()))}</div>
      </div>
    </div>
    ${content}
  </div>
</body>
</html>`;

  const frame = getPrintFrame();
  const fWin = frame.contentWindow;
  const fDoc = fWin.document;
  fDoc.open();
  fDoc.write(doc);
  fDoc.close();

  let done = false;
  const doPrint = () => {
    if (done) return;
    done = true;
    try { fWin.focus(); fWin.print(); } catch (e) { /* ignore */ }
  };
  frame.addEventListener("load", doPrint, { once: true });
  setTimeout(doPrint, 250);

  return frame;
}
/* ------------------------------------------------------------------ */
/*  Amount in words (KES)                                              */
/* ------------------------------------------------------------------ */

const NUM_ONES = ["Zero","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
const NUM_TENS = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
const NUM_SCALES = ["", "Thousand", "Million", "Billion"];

function threeDigitWords(n) {
  if (n === 0) return "";
  const parts = [];
  const h = Math.floor(n / 100);
  const rem = n % 100;
  if (h) parts.push(NUM_ONES[h] + " Hundred");
  if (rem) {
    if (rem < 20) parts.push(NUM_ONES[rem]);
    else {
      const t = Math.floor(rem / 10);
      const o = rem % 10;
      parts.push(NUM_TENS[t] + (o ? "-" + NUM_ONES[o] : ""));
    }
  }
  return parts.join(" ");
}

function wholeToWords(n) {
  if (n === 0) return "Zero";
  let words = "";
  let scale = 0;
  while (n > 0) {
    const chunk = n % 1000;
    if (chunk > 0) {
      const label = threeDigitWords(chunk) + (NUM_SCALES[scale] ? " " + NUM_SCALES[scale] : "");
      words = label + (words ? ", " + words : "");
    }
    n = Math.floor(n / 1000);
    scale++;
  }
  return words;
}

function numberToWords(value) {
  const totalCents = Math.round(Math.abs(Number(value) || 0) * 100);
  const shillings = Math.floor(totalCents / 100);
  const cents = totalCents % 100;
  let out = wholeToWords(shillings) + " Shillings";
  if (cents) out += " and " + wholeToWords(cents) + " Cents";
  if (shillings === 0 && cents === 0) out = "Zero Shillings";
  return out;
}

/* ------------------------------------------------------------------ */
/*  Receipt content builder                                            */
/* ------------------------------------------------------------------ */

export function buildReceiptContent({ student = {}, payment = {}, balance = 0, appliedToFees = 0, creditCarried = 0, status = "ISSUED", reprint = null } = {}) {
  const amount = Number(payment.amount || 0);
  const method = payment.method || "";
  const reference = payment.reference || "";
  const notes = payment.notes || "";
  const cashier = payment.recorded_by || payment.issued_by || "";
  const guardian = [student.guardian_name, student.guardian_phone].filter(Boolean).join(" • ");
  const termCtx = [payment.academic_year_name, payment.term_name].filter(Boolean).join(" • ");
  const isReversed = String(status).toUpperCase() === "REVERSED";
  const isVoided = String(status).toUpperCase() === "VOIDED";
  const banner = isReversed
    ? `<div style="border:2px solid #B91C1C;color:#B91C1C;font-weight:800;text-align:center;padding:8px;border-radius:10px;margin-bottom:14px;letter-spacing:.08em;">RECEIPT REVERSED — NOT VALID FOR PAYMENT</div>`
    : isVoided
      ? `<div style="border:2px solid #B45309;color:#B45309;font-weight:800;text-align:center;padding:8px;border-radius:10px;margin-bottom:14px;letter-spacing:.08em;">RECEIPT VOIDED</div>`
      : "";

  /* Balance can be negative — that is available CREDIT, not a negative due. */
  let balanceBox;
  if (balance == null) {
    balanceBox = `<div class="t-box hero"><span class="k">Outstanding Balance</span><span class="v">—</span></div>`;
  } else if (Number(balance) < 0) {
    balanceBox = `
      <div class="t-box"><span class="k">Outstanding Balance</span><span class="v">${formatCurrency(0)}</span></div>
      <div class="t-box"><span class="k">Available Credit</span><span class="v" style="color:#047857;">${formatCurrency(Math.abs(balance))}</span></div>`;
  } else {
    balanceBox = `<div class="t-box hero"><span class="k">Outstanding Balance</span><span class="v">${formatCurrency(balance)}</span></div>`;
  }

  return `
  ${banner}
  <div class="print-amount">
    <div>
      <div class="lab">Amount Received</div>
      <div class="val">${formatCurrency(amount)}</div>
      <div class="print-words">${escapeHtml(numberToWords(amount))}</div>
    </div>
    <div style="text-align:right;">
      <div class="lab">Receipt No.</div>
      <div class="val" style="font-size:20px;">${escapeHtml(payment.receipt_no || payment.receipt_number || "—")}</div>
      <div class="print-muted" style="font-size:11px;margin-top:5px;">Paid on ${escapeHtml(formatDate(payment.payment_date))}</div>
      ${reprint ? `<div class="print-muted" style="font-size:11px;">Reprint #${escapeHtml(String(reprint.count))} on ${escapeHtml(formatDate(reprint.at))}</div>` : ""}
    </div>
  </div>

  <div class="print-sub">Received From</div>
  <div class="print-grid">
    <div class="print-field"><span class="k">Student</span><span class="v">${escapeHtml(student.name || "—")}</span></div>
    <div class="print-field"><span class="k">Admission No.</span><span class="v">${escapeHtml(student.admission_number || "—")}</span></div>
    <div class="print-field"><span class="k">Class</span><span class="v">${escapeHtml(student.class_name || "—")}${termCtx ? `<span class="print-pill">${escapeHtml(termCtx)}</span>` : ""}</span></div>
    <div class="print-field"><span class="k">Parent / Guardian</span><span class="v">${escapeHtml(guardian || "—")}</span></div>
  </div>

  <div class="print-sub">Payment Details</div>
  <div class="print-grid">
    <div class="print-field"><span class="k">Payment Method</span><span class="v">${escapeHtml(method || "—")}</span></div>
    <div class="print-field"><span class="k">Transaction Reference</span><span class="v">${escapeHtml(reference || "—")}</span></div>
    <div class="print-field"><span class="k">Received By</span><span class="v">${escapeHtml(cashier || "—")}</span></div>
    <div class="print-field"><span class="k">Recorded On</span><span class="v">${escapeHtml(formatDateTime(payment.created_at))}</span></div>
  </div>

  <table class="print-table">
    <thead><tr><th>Description</th><th class="amount">Amount</th></tr></thead>
    <tbody>
      <tr><td>School Fees Payment${termCtx ? ` — ${escapeHtml(termCtx)}` : ""}</td><td class="amount">${formatCurrency(amount)}</td></tr>
      <tr><td style="font-weight:700;">TOTAL PAID</td><td class="amount" style="font-weight:700;">${formatCurrency(amount)}</td></tr>
    </tbody>
  </table>

  <div class="print-totals">
    ${appliedToFees > 0 ? `<div class="t-box"><span class="k">Applied to Fees</span><span class="v">${formatCurrency(appliedToFees)}</span></div>` : ""}
    ${creditCarried > 0 ? `<div class="t-box"><span class="k">Credit Carried</span><span class="v">${formatCurrency(creditCarried)}</span></div>` : ""}
    ${balanceBox}
  </div>

  ${notes ? `<p class="print-note"><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ""}
  <div class="print-ack">Received with thanks.</div>
  <div class="print-sign">
    <div><div>Received by</div><div class="line"></div></div>
    <div><div>Signature</div><div class="line"></div></div>
    <div><div>Student / Guardian</div><div class="line"></div></div>
  </div>
  <p class="print-note">This is a computer-generated receipt. Please retain it for your records.</p>`;
}
/* ------------------------------------------------------------------ */
/*  Statement content builder                                          */
/* ------------------------------------------------------------------ */

export function buildStatementContent({ student = {}, lines = [], totals = {}, school = {}, period = {} } = {}) {
  /* Bare money values — currency is stated once at the top of the statement
     instead of repeating "KSh" on every cell. Values (including zero) are
     always shown. */
  const num = (v) => Number(v || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const rows = lines.length
    ? lines.map((l) => `
      <tr>
        <td>${escapeHtml(formatDate(l.date || l.transaction_date))}</td>
        <td>
          ${escapeHtml(l.description || l.transaction_type || "—")}
          ${l.term_name ? `<span class="print-pill">${escapeHtml(l.term_name)}</span>` : ""}
          ${l.receipt_no ? `<div class="print-badge">${escapeHtml(l.receipt_no)}</div>` : ""}
        </td>
        <td class="amount">${num(l.debit)}</td>
        <td class="amount">${num(l.credit)}</td>
        <td class="amount" style="font-weight:700;">${num(l.balance)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="text-align:center;color:#64748B;padding:18px;">No transactions recorded yet.</td></tr>`;

  const t = totals || {};
  const closing = Number(t.balance || 0);
  /* Positive closing = amount owed; negative closing = available credit. */
  const outstanding = Math.max(0, closing);
  const credit = Math.max(0, -closing);
  const guardian = [student.guardian_name, student.guardian_phone].filter(Boolean).join(" • ");
  const periodLabel = [period.from, period.to].filter(Boolean).map((d) => formatDate(d)).join(" – ") || "All history";
  const ctxLine = [period.term_name, period.academic_year_name].filter(Boolean).join(" • ");
  const schoolContact = [school.phone, school.email].filter(Boolean).join(" • ");

  return `
  <div class="print-sub">Student Account</div>
  <div class="print-grid">
    <div class="print-field"><span class="k">Student</span><span class="v">${escapeHtml(student.name || "—")}</span></div>
    <div class="print-field"><span class="k">Admission No.</span><span class="v">${escapeHtml(student.admission_number || "—")}</span></div>
    <div class="print-field"><span class="k">Class</span><span class="v">${escapeHtml(student.class_name || "—")}</span></div>
    <div class="print-field"><span class="k">Gender</span><span class="v">${escapeHtml(student.gender || "—")}</span></div>
    <div class="print-field"><span class="k">Parent / Guardian</span><span class="v">${escapeHtml(guardian || "—")}</span></div>
    <div class="print-field"><span class="k">School</span><span class="v">${escapeHtml(school.name || "")}${schoolContact ? `<div class="print-muted" style="font-size:11px;font-weight:500;">${escapeHtml(schoolContact)}</div>` : ""}</span></div>
  </div>

  <div class="print-sub">Statement Period</div>
  <div class="print-grid">
    <div class="print-field"><span class="k">Period</span><span class="v">${escapeHtml(periodLabel)}</span></div>
    <div class="print-field"><span class="k">Term / Year</span><span class="v">${escapeHtml(ctxLine || "—")}</span></div>
  </div>

  <p class="print-currency">All amounts below are in KSh (Kenyan Shillings).</p>

  <table class="print-table">
    <thead><tr><th>Date</th><th>Description</th><th class="amount">Debit</th><th class="amount">Credit</th><th class="amount">Balance</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="print-totals">
    ${outstanding > 0
      ? `<div class="t-box hero"><span class="k">Outstanding Balance</span><span class="v">${num(outstanding)}</span></div>`
      : `<div class="t-box"><span class="k">Outstanding Balance</span><span class="v">${num(0)}</span></div>
         <div class="t-box hero" ><span class="k">Available Credit</span><span class="v" style="color:#047857;">${num(credit)}</span></div>`}
  </div>

  <div class="print-sign">
    <div><div>Prepared by</div><div class="line"></div></div>
    <div><div>Authorised Signature</div><div class="line"></div></div>
  </div>
  <p class="print-note">Generated by ShuleSmart. For inquiries, contact the school accounts office.</p>`;
}

/* ------------------------------------------------------------------ */
/*  Public actions (fetch + print)                                     */
/* ------------------------------------------------------------------ */

export async function printPaymentReceipt({ payment, studentId, appliedToFees = 0, creditCarried = 0, student = {}, balance = null } = {}) {
  if (!studentId) { console.warn("printPaymentReceipt: no studentId"); return; }

  let d = null;
  try { d = await apiGet(`/api/students/${studentId}/statement`); } catch (e) { console.warn("printPaymentReceipt: statement fetch failed", e); }

  const info = {
    name: (d && d.student && (d.student.name || "").trim()) || (student.name || "").trim() || "",
    admission_number: (d && d.student && d.student.admission_number) || student.admission_number || "",
    class_name: (d && d.student && d.student.class_name) || student.class_name || "",
    gender: (d && d.student && d.student.gender) || student.gender || "",
    guardian_name: (d && d.student && d.student.guardian_name) || student.guardian_name || "",
    guardian_phone: (d && d.student && d.student.guardian_phone) || student.guardian_phone || ""
  };
  /* Prefer the live statement; fall back to the caller-provided balance
     (e.g. the post-payment outstanding returned by POST /api/payments). */
  const balanceOut = d ? Number((d.totals && d.totals.balance) || 0)
    : (balance != null && !isNaN(Number(balance)) ? Number(balance) : null);

  printHTML({
    title: "Official Receipt",
    school: (d && d.school) || null,
    content: buildReceiptContent({ student: info, payment, balance: balanceOut, appliedToFees, creditCarried })
  });
  return d;
}

export async function printStudentStatement(studentId, fallback = {}, preloaded = null) {
  if (!studentId) return;

  let d = preloaded;
  if (!d) {
    try { d = await apiGet(`/api/students/${studentId}/statement`); } catch (e) { console.warn("printStudentStatement: statement fetch failed", e); }
  }

  const student = {
    name: (d && d.student && (d.student.name || "").trim()) || (fallback.name || "").trim() || "",
    admission_number: (d && d.student && d.student.admission_number) || fallback.admission_number || "",
    class_name: (d && d.student && d.student.class_name) || fallback.class_name || "",
    gender: (d && d.student && d.student.gender) || fallback.gender || "",
    guardian_name: (d && d.student && d.student.guardian_name) || fallback.guardian_name || "",
    guardian_phone: (d && d.student && d.student.guardian_phone) || fallback.guardian_phone || ""
  };

  const content = buildStatementContent({
    student,
    lines: (d && d.lines) || [],
    totals: (d && d.totals) || {},
    school: (d && d.school) || {},
    period: (d && d.period) || {}
  });
  printHTML({ title: "Student Statement", school: (d && d.school) || null, content });
  return d;
}

/* ------------------------------------------------------------------ */
/*  Print / reprint a stored receipt by its id                         */
/* ------------------------------------------------------------------ */

export async function printReceiptById(receiptId, { markReprint = false } = {}) {
  if (!receiptId) return null;
  const d = await apiGet(`/api/receipts/${receiptId}`);
  const r = (d && d.receipt) || {};

  /* Reprint bookkeeping is best-effort — never block printing on it. */
  if (markReprint) {
    try {
      await apiPost(`/api/receipts/${receiptId}/reprint`, {});
      r.reprint_count = Number(r.reprint_count || 0) + 1;
      r.last_reprinted_at = new Date().toISOString().slice(0, 10);
    } catch (e) { console.warn("printReceiptById: reprint log failed", e); }
  }

  const content = buildReceiptContent({
    student: {
      name: r.student_name || "",
      admission_number: r.admission_number || "",
      class_name: r.class_name || "",
      guardian_name: r.guardian_name || "",
      guardian_phone: r.guardian_phone || ""
    },
    payment: {
      amount: r.amount,
      method: r.method,
      reference: r.reference,
      notes: r.notes,
      payment_date: r.payment_date,
      created_at: r.issued_at,
      receipt_no: r.receipt_number,
      recorded_by: r.issued_by
    },
    balance: d.balance != null ? Number(d.balance) : null,
    status: r.status,
    reprint: r.reprint_count > 0 ? { count: r.reprint_count, at: r.last_reprinted_at } : null
  });

    printHTML({ title: "Official Receipt", school: (d && d.school) || null, content });
  return d;
}

/* ================================================================== */
/*  RESULTS — Class Ranking (PDF) + Student Report Cards               */
/*                                                                     */
/*  All of the data needed is produced by GET                          */
/*  /api/results/detail?exam_id=&class_id= (examResultsDetail in       */
/*  firestore-data.js). These builders turn it into branded, print-    */
/*  ready documents. printHTML() renders them in a hidden iframe and   */
/*  calls window.print(); the browser then offers "Save as PDF".      */
/* ================================================================== */

/* ---- small local helpers (none of these exist on common.js) ---- */
function fmtNum(v, dec = 2) {
  return Number(v == null || v === "" ? 0 : v).toLocaleString("en-KE", {
    minimumFractionDigits: dec, maximumFractionDigits: dec
  });
}

/* Letter grade -> brand colour. Falls back to dark text for unknowns. */
function gradeColor(grade) {
  const g = String(grade || "").toUpperCase();
  const map = { A: "#047857", B: "#1D4ED8", C: "#B45309", D: "#C2410C", E: "#B91C1C" };
  return map[g] || "#334155";
}

function gradeBg(grade) {
  const g = String(grade || "").toUpperCase();
  const map = { A: "#DCFCE8", B: "#DBEAFE", C: "#FEF3C7", D: "#FFEDD8", E: "#FEE2E2" };
  return map[g] || "#F1F5F9";
}

/* Pass / fail analytics derived from the school's grading settings.
 * marks mode  -> pass = average >= 50 (Kenya's common benchmark)
 * grades mode -> pass = grade is NOT the lowest grade on the scale. */
function passInfo(students, grading = {}) {
  const useGrades = grading.mode === "grades" || grading.mode === "both";
  if (useGrades) {
    const scale = (grading.scale || []).slice().sort((a, b) => Number(b.min || 0) - Number(a.min || 0));
    const failGrade = scale.length ? String(scale[scale.length - 1].grade).toUpperCase() : "E";
    const passed = students.filter((s) => s.grade && String(s.grade).toUpperCase() !== failGrade);
    return { useGrades: true, passMark: null, passed: passed.length, failGrade };
  }
  const passMark = 50;
  const passed = students.filter((s) => typeof s.average === "number" && s.average >= passMark);
  return { useGrades: false, passMark, passed: passed.length, failGrade: null };
}

/* A friendly, auto-generated comment for report cards when no custom
 * remark is stored on the result. */
function defaultRemark(average, grade, useGrades) {
  if (useGrades) {
    const g = String(grade || "").toUpperCase();
    if (g === "A") return "Excellent performance — keep up the outstanding work.";
    if (g === "B") return "Very good. Continue to apply consistent effort.";
    if (g === "C") return "Good. There is room for improvement with more practice.";
    if (g === "D") return "Fair. More effort and regular revision are needed.";
    if (g === "E") return "Weak. Requires extra support and focused revision.";
    return "Continue to work hard and seek help whenever needed.";
  }
  const a = Number(average);
  if (a >= 80) return "Excellent performance — keep up the outstanding work.";
  if (a >= 65) return "Very good. Continue to apply consistent effort.";
  if (a >= 50) return "Good. There is room for improvement with more practice.";
  if (a >= 35) return "Fair. More effort and regular revision are needed.";
  return "Weak. Requires extra support and focused revision.";
}

/* 1st/2nd/3rd get a medal; everyone else just sees their position. */
function rankLabel(rank) {
  if (rank === 1) return '<span style="color:#D97706;font-weight:800;">🥇 1</span>';
  if (rank === 2) return '<span style="color:#9DA7B2;font-weight:800;">🥈 2</span>';
  if (rank === 3) return '<span style="color:#CD7F32;font-weight:800;">🥉 3</span>';
  return String(rank);
}

/* Re-usable subtitle block (title + context line) for the result docs. */
function printSubContext(title, sub) {
  return `<div class="print-sub">${escapeHtml(title)}</div>` +
    `<p class="print-muted" style="font-size:11px;color:#64748B;margin:-6px 0 12px;">${escapeHtml(sub)}</p>`;
}

/* Fetch the rich detail payload shared by ranking + report cards. */
function fetchResultsDetail(examId, classId = null) {
  if (!examId) throw new Error("exam_id is required.");
  const p = new URLSearchParams({ exam_id: examId });
    if (classId) p.set("class_id", classId);
  return apiGet("/api/results/detail?" + p.toString());
}

/* ---- Class ranking sheet (leaderboard style) ---- */
export function buildClassRankingContent(detail = {}) {
  const exam = detail.exam || {};
  const subjects = detail.subjects || [];
  const students = detail.students || [];
  const grading = detail.grading || {};
  const useGrades = grading.mode === "grades" || grading.mode === "both";
  const info = passInfo(students, grading);

  const scored = students.filter((s) => typeof s.average === "number");
  const classAvg = scored.length
    ? Math.round((scored.reduce((sum, s) => sum + s.average, 0) / scored.length) * 100) / 100
    : null;
  const top = scored[0] || null;

  const subjectHeaders = subjects
    .map((s) => `<th style="min-width:44px;text-align:center;padding:6px 4px;">${escapeHtml(s.name || s.id || "")}</th>`)
    .join("");
  const gradeHeader = useGrades ? `<th style="min-width:40px;text-align:center;">Grade</th>` : "";

  const headRow =
    `<th style="width:40px;">Pos</th>` +
    `<th style="min-width:90px;">Adm. No.</th>` +
    `<th>Student</th>` +
    subjectHeaders +
    `<th class="amount" style="min-width:52px;">Total</th>` +
    `<th class="amount" style="min-width:54px;">Average</th>` +
    gradeHeader +
    `<th style="min-width:46px;">Rank</th>`;

  const rows = students.map((s, i) => {
    const avg = typeof s.average === "number" ? s.average : null;
    const medal = s.rank === 1 ? `<i class="fa-solid fa-trophy" style="color:#D97706;" title="Top of class"></i>` : "";
    const subjectCells = subjects.map((subj) => {
      const sc = (s.subjects || []).find((x) => x.subject_id === subj.id);
      const has = sc && sc.score != null;
      const color = has ? "#0F172A" : "#94A3B8";
      return `<td class="amount" style="color:${color};text-align:center;">${has ? fmtNum(sc.score, 1) : "—"}</td>`;
    }).join("");
    const gradeCell = useGrades
      ? `<td style="text-align:center;font-weight:700;color:${gradeColor(s.grade)};">${escapeHtml(s.grade || "—")}</td>`
      : "";
    return `<tr>` +
      `<td style="font-weight:700;">${rankLabel(s.rank != null ? s.rank : i + 1)}${medal}</td>` +
      `<td>${escapeHtml(s.admission_number || "—")}</td>` +
      `<td>${escapeHtml(s.name || "—")}</td>` +
      subjectCells +
      `<td class="amount" style="font-weight:700;">${s.total != null ? fmtNum(s.total, 2) : "—"}</td>` +
      `<td class="amount" style="font-weight:700;">${avg != null ? fmtNum(avg, 2) + "%" : "—"}</td>` +
      gradeCell +
      `<td style="text-align:center;font-weight:700;">${s.rank != null ? rankLabel(s.rank) : "—"}</td>` +
      `</tr>`;
  }).join("");

  const context = [
    exam.name ? `Exam: ${exam.name}` : null,
    detail.term_name ? `Term: ${detail.term_name}` : null,
    detail.academic_year_name ? `Year: ${detail.academic_year_name}` : null,
    detail.class_name ? `Class: ${detail.class_name}` : null,
    exam.start_date ? `Date: ${formatDate(exam.start_date)}${exam.end_date ? " – " + formatDate(exam.end_date) : ""}` : null
  ].filter(Boolean).join(" • ") || "—";

  const summary = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">` +
    `<span class="print-badge">Students: ${escapeHtml(String(students.length))}</span>` +
    (scored.length ? `<span class="print-badge">Scored: ${escapeHtml(String(scored.length))}</span>` : "") +
    (classAvg != null ? `<span class="print-badge">Class Avg: ${fmtNum(classAvg, 2)}%</span>` : "") +
    (top ? `<span class="print-badge">Top: ${escapeHtml(top.name || "—")} — ${fmtNum(top.average, 2)}%</span>` : "") +
    (info.passed != null ? `<span class="print-badge">Passed: ${escapeHtml(String(info.passed))}</span>` : "") +
    `</div>`;

  return printSubContext("Class Ranking", context) +
    summary +
        `<table class="print-table" style="font-size:11px;">` +
    `<thead><tr>${headRow}</tr></thead>` +
    `<tbody>${rows || `<tr><td colspan="2" style="text-align:center;padding:28px;">No student results for this exam / class.</td></tr>`}</tbody>` +
    `</table>`;
}

/** GET /api/results/detail  -> branded class ranking sheet.
 *  The browser Print dialog -> "Save as PDF" gives the ranking PDF. */
export async function printClassRanking(examId, classId = null) {
  const d = await fetchResultsDetail(examId, classId);
  const detail = {
    exam: d.exam, class_name: d.class_name, term_name: d.term_name,
    academic_year_name: d.academic_year_name, grading: d.grading,
    subjects: d.subjects, students: d.students
  };
  printHTML({ title: "Class Ranking", school: d.school || null, content: buildClassRankingContent(detail) });
  return detail;
}

/* ---- Single student report card (one printed page) ---- */
export function buildSingleReportCard(student = {}, detail = {}) {
  const grading = detail.grading || {};
  const useGrades = grading.mode === "grades" || grading.mode === "both";
  const subjects = detail.subjects || [];
  const exam = detail.exam || {};
  const studentSubjects = student.subjects || [];

  const subjectRows = (studentSubjects.length ? studentSubjects : subjects).map((subj) => {
    const rec = studentSubjects.find((x) => x.subject_id === subj.id) || subj;
    const has = rec && rec.score != null;
    const score = has ? fmtNum(rec.score, 1) : "—";
    const scoreColor = has ? "#0F172A" : "#94A3B8";
    const gradeCell = useGrades
      ? `<td style="width:54px;text-align:center;font-weight:700;color:${gradeColor(rec.grade)};background:${gradeBg(rec.grade)};border-radius:4px;">${escapeHtml(rec.grade || "—")}</td>`
      : "";
    const name = rec.subject_name || subj.name || subj.subject_name || subj.id || "Subject";
    return `<tr>` +
      `<td>${escapeHtml(name)}</td>` +
      `<td class="amount" style="width:70px;color:${scoreColor};text-align:center;">${score}</td>` +
      gradeCell +
      `</tr>`;
  }).join("");

  const total = student.total != null ? fmtNum(student.total, 2) : "—";
  const avg = student.average != null ? fmtNum(student.average, 2) + "%" : "—";
  const grade = useGrades ? (student.grade || "—") : "—";
  const rank = student.rank != null ? rankLabel(student.rank) : "—";
  const gradeHeader = useGrades ? `<th style="width:54px;text-align:center;">Grade</th>` : "";
  const remark = defaultRemark(student.average, student.grade, useGrades);

  return `
    <div class="print-sub">Report Card</div>
    <p class="print-muted" style="font-size:11px;color:#64748B;margin:-6px 0 8px;">
      ${escapeHtml(exam.name || "—")} • ${escapeHtml(detail.term_name || "—")} ${escapeHtml(detail.academic_year_name || "—")}
    </p>

    <div class="print-grid" style="margin-top:10px;">
      <div class="print-field"><span class="k">Student Name</span><span class="v" style="font-size:16px;color:#0F172A;">${escapeHtml(student.name || "—")}</span></div>
      <div class="print-field"><span class="k">Admission No.</span><span class="v">${escapeHtml(student.admission_number || "—")}</span></div>
      <div class="print-field"><span class="k">Class</span><span class="v">${escapeHtml(student.class_name || detail.class_name || "—")}</span></div>
      <div class="print-field"><span class="k">Position in Class</span><span class="v" style="color:#1E3A8A;">${rank}</span></div>
      <div class="print-field"><span class="k">Term / Year</span><span class="v">${escapeHtml(detail.term_name || "—")} / ${escapeHtml(detail.academic_year_name || "—")}</span></div>
      ${useGrades ? `<div class="print-field"><span class="k">Overall Grade</span><span class="v" style="color:${gradeColor(student.grade)};">${escapeHtml(grade)}</span></div>` : ""}
    </div>

    <table class="print-table" style="font-size:12.5px;">
            <thead><tr><th style="text-align:left;">Subject</th><th class="amount" style="width:70px;">Score (%)</th>${gradeHeader}</tr></thead>
      <tbody>${subjectRows}</tbody>
    </table>

    <div class="print-totals">
      <div class="t-box"><span class="k">Total Marks</span><span class="v">${total}</span></div>
      <div class="t-box"><span class="k">Average</span><span class="v" style="color:${gradeColor(student.grade)};">${avg}</span></div>
      ${useGrades ? `<div class="t-box hero"><span class="k">Grade</span><span class="v">${escapeHtml(grade)}</span></div>` : ""}
    </div>

    <div class="print-sub">Class Teacher's Remark</div>
    <div class="print-remark" style="font-size:12px;">${escapeHtml(remark)}</div>

    <div class="print-sign">
      <div><div style="font-weight:700;">Class Teacher</div><div class="line"></div></div>
      <div><div style="font-weight:700;">Headteacher</div><div class="line"></div></div>
      <div style="text-align:right;"><div style="font-weight:700;">Parent / Guardian</div><div class="line"></div></div>
    </div>

        <p class="print-note">Generated by ShuleSmart • This report card is computer-generated and valid without a signature.</p>
  `;
}

/* ---- All students -> multi-page document (one page per student) ---- */
export function buildReportCardsContent(detail = {}) {
  const students = detail.students || [];
  if (!students.length) {
    return `<div class="print-remark" style="margin:28px 0;">No student results were found for this${detail.class_name ? " / " + detail.class_name : ""} — enter marks for this exam first.</div>`;
  }
  return `<div class="report-cards">` +
    students.map((s) => `<div class="report-card">${buildSingleReportCard(s, detail)}</div>`).join("") +
    `</div>`;
}

/** GET /api/results/detail  -> every student's report card as a single
 *  multi-page PDF (one page per student). Pass classId to scope a class,
 *  or leave it null to print all classes in the exam at once. */
export async function printStudentReportCards(examId, classId = null) {
  const d = await fetchResultsDetail(examId, classId);
  const detail = {
    exam: d.exam, class_name: d.class_name, term_name: d.term_name,
    academic_year_name: d.academic_year_name, grading: d.grading,
    subjects: d.subjects, students: d.students
  };
  printHTML({
    title: "Student Report Cards",
    school: d.school || null,
    content: buildReportCardsContent(detail)
  });
  return detail;
}

/** Print a single student's report card (used from student rows / detail).
 *  classId, when known, scopes the lookup to the student's class. */
export async function printStudentReportCard(examId, studentId, classId = null) {
  if (!studentId) throw new Error("student_id is required.");
  const d = await fetchResultsDetail(examId, classId);
  const detail = {
    exam: d.exam, class_name: d.class_name, term_name: d.term_name,
    academic_year_name: d.academic_year_name, grading: d.grading,
    subjects: d.subjects, students: d.students
  };
  const found = (detail.students || []).find((s) => s.student_id === studentId);
  if (!found) throw new Error("No results found for this student in the selected exam.");
  printHTML({
    title: `Report Card — ${found.name || "Student"}`,
    school: d.school || null,
    content: buildSingleReportCard(found, detail)
  });
  return { student: found, grading: detail.grading };
}