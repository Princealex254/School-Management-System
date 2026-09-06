/**
 * ============================================================
 * ShuleSmart — Downloadable PDF reports (jsPDF)
 * ============================================================
 * Shared letterhead + table styling that mirrors the printable
 * statement design in print.js: branded header with the SCHOOL
 * name and code on the left, report title on the right, a thick
 * brand rule, section headings, currency note, and totals boxes.
 *
 *   downloadFeesBalancesPdf(rows, meta)
 *   downloadStudentsPdf(rows, meta)
 *
 * jsPDF + autotable are lazy-loaded from cdnjs on first use.
 * ============================================================
 */

const BRAND = {
  blue: [30, 58, 138],      /* #1E3A8A */
  blueLight: [37, 99, 235], /* #2563EB */
  teal: [20, 184, 166],     /* #14B8A6 */
  text: [15, 23, 42],       /* #0F172A */
  gray: [100, 116, 139],    /* #64748B */
  rowAlt: [248, 250, 252],  /* #F8FAFC */
  border: [226, 232, 240],  /* #E2E8F0 */
  green: [4, 120, 87]       /* #047857 */
};

const money = (v) => Number(v || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const initialsOf = (n) => ((n || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("")) || "SS";

async function ensurePdfLibs() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      s.onload = res; s.onerror = () => rej(new Error("Could not load the PDF library. Check your connection."));
      document.head.appendChild(s);
    });
  }
  if (!window.jspdf.jsPDF.API.autoTable) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";
      s.onload = res; s.onerror = () => rej(new Error("Could not load the PDF table plugin. Check your connection."));
      document.head.appendChild(s);
    });
  }
}

const pageW = (doc) => doc.internal.pageSize.getWidth();
const pageH = (doc) => doc.internal.pageSize.getHeight();

/* Statement-style letterhead — school name + code + contact on the
   left, report title + generated date on the right, thick brand rule. */
function drawLetterhead(doc, { title, school }) {
  const W = pageW(doc);
  const s = school || {};
  const sName = (s.name || "").trim() || "ShuleSmart";
  const sCode = (s.school_code || s.code || "").trim();
  const contact = [s.county, s.phone, s.email].filter(Boolean).join("  •  ");

  /* Brand mark (rounded square + initials, teal accent strip) */
  doc.setFillColor(...BRAND.blueLight);
  doc.roundedRect(40, 38, 42, 42, 8, 8, "F");
  doc.setFillColor(...BRAND.teal);
  doc.roundedRect(40, 67, 42, 13, 0, 0, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(initialsOf(sName), 61, 62, { align: "center" });

  /* School name + code + contact */
  let y = 52;
  doc.setTextColor(...BRAND.blue);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.text(sName, 92, y);
  y += 13;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...BRAND.gray);
  if (sCode) {
    doc.text(sCode.toUpperCase(), 92, y);
    y += 11;
  }
  if (contact) {
    doc.text(contact, 92, y, { maxWidth: W / 2 - 90 });
  }

  /* Title + generated date (right-aligned, like the statement) */
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(...BRAND.text);
  doc.text(String(title || "Report").toUpperCase(), W - 40, 50, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...BRAND.gray);
  doc.text("Generated " + new Date().toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" }), W - 40, 64, { align: "right" });

  /* Thick brand rule under the header */
  doc.setDrawColor(...BRAND.blue);
  doc.setLineWidth(2.4);
  doc.line(40, 94, W - 40, 94);
  doc.setLineWidth(0.4);
  doc.setTextColor(...BRAND.text);

  return 116; /* start Y for content */
}

/* Uppercase brand-blue section heading with light underline. */
function sectionHead(doc, text, y) {
  const W = pageW(doc);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...BRAND.blue);
  doc.text(String(text).toUpperCase(), 40, y);
  doc.setDrawColor(...BRAND.border);
  doc.setLineWidth(1);
  doc.line(40, y + 4, W - 40, y + 4);
  doc.setLineWidth(0.4);
  doc.setTextColor(...BRAND.text);
  return y + 18;
}

/* One meta field: tiny uppercase gray label over a bold value. */
function metaField(doc, label, value, x, y) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);
  doc.setTextColor(...BRAND.gray);
  doc.text(String(label).toUpperCase(), x, y);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10.5);
  doc.setTextColor(...BRAND.text);
  doc.text(String(value == null || value === "" ? "—" : value), x, y + 13);
}

/* Right-aligned totals boxes (statement .print-totals style). */
function totalsBox(doc, label, value, xRight, y, opts = {}) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(...BRAND.gray);
  doc.text(String(label).toUpperCase(), xRight, y, { align: "right" });
  doc.setFontSize(opts.hero ? 16 : 13);
  doc.setTextColor(...(opts.color || BRAND.text));
  doc.text(String(value), xRight, y + (opts.hero ? 18 : 15), { align: "right" });
}

function footerNote(doc, text) {
  const W = pageW(doc), H = pageH(doc);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...BRAND.gray);
  doc.text(text, W / 2, H - 24, { align: "center" });
}

function pageNumbers(doc) {
  const W = pageW(doc), H = pageH(doc);
  const total = doc.internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...BRAND.gray);
    doc.text(`Page ${i} of ${total}`, W - 40, H - 24, { align: "right" });
  }
}

const TABLE_STYLES = {
  styles: { font: "helvetica", fontSize: 9, cellPadding: 5, lineColor: BRAND.border, lineWidth: 0.3 },
  headStyles: { fillColor: BRAND.blue, textColor: 255, fontStyle: "bold", fontSize: 8.5 },
  alternateRowStyles: { fillColor: BRAND.rowAlt },
  /* top: 110 keeps continued rows BELOW the repeated letterhead (38–94)
     on every page after the first — prevents header/table overlap. */
  margin: { left: 40, right: 40, top: 110 }
};

/* ------------------------------------------------------------------ */
/*  Fees & Balances report                                             */
/* ------------------------------------------------------------------ */

export async function downloadFeesBalancesPdf(rows, meta = {}) {
  await ensurePdfLibs();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const lh = () => drawLetterhead(doc, { title: "Fees & Balances Report", school: meta.school });

  let y = lh();

  /* Fees Overview section */
  y = sectionHead(doc, "Fees Overview", y);
  const col2 = pageW(doc) / 2 + 10;
  metaField(doc, "Class", meta.classLabel || "All Classes", 40, y);
  metaField(doc, "Balances", meta.statusLabel || "All Balances", col2, y);
  y += 34;
  metaField(doc, "Students", `${rows.length} student(s)`, 40, y);
  if (meta.search) metaField(doc, "Search", `"${meta.search}"`, col2, y);
  y += (meta.search ? 26 : 0) + 26;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...BRAND.gray);
  doc.text("All amounts below are in KSh (Kenyan Shillings).", 40, y);
  doc.setTextColor(...BRAND.text);
  y += 14;

  const statusLabels = { outstanding: "Outstanding", fully_paid: "Fully Paid", credit: "In Credit", no_charges: "No Charges" };
  const body = rows.map((r, i) => [
    String(i + 1),
    r.name || "",
    r.admission_number || "",
    r.class_name || "—",
    money(r.billed),
    money(r.paid),
    money(r.balance || 0),
    statusLabels[r.status] || r.status || ""
  ]);

  doc.autoTable({
    startY: y,
    head: [["#", "Student", "Adm. No.", "Class", "Billed", "Paid", "Balance", "Status"]],
    body,
    ...TABLE_STYLES,
    columnStyles: {
      0: { cellWidth: 22, halign: "center", textColor: BRAND.gray },
      4: { halign: "right" }, 5: { halign: "right" },
      6: { halign: "right", fontStyle: "bold" },
      7: { cellWidth: 62, fontSize: 8 }
    },
    didDrawPage: () => lh()
  });

  /* Totals */
  const totals = rows.reduce((a, r) => ({
    billed: a.billed + Number(r.billed || 0),
    paid: a.paid + Number(r.paid || 0),
    balance: a.balance + Number(r.balance || 0)
  }), { billed: 0, paid: 0, balance: 0 });
  const outstanding = Math.max(0, totals.balance);
  const credit = Math.max(0, -totals.balance);

  const W = pageW(doc), H = pageH(doc);
  let ty = doc.lastAutoTable.finalY + 28;
  if (ty > H - 100) { doc.addPage(); lh(); ty = 132; }
  doc.setDrawColor(...BRAND.border);
  doc.setLineWidth(0.8);
  doc.line(40, ty - 12, W - 40, ty - 12);
  doc.setLineWidth(0.4);
  totalsBox(doc, "Total Billed", money(totals.billed), W - 40 - 250, ty);
  totalsBox(doc, "Total Paid", money(totals.paid), W - 40 - 125, ty);
  if (credit > 0) totalsBox(doc, "Available Credit", money(credit), W - 40, ty, { hero: true, color: BRAND.green });
  else totalsBox(doc, "Outstanding Balance", money(outstanding), W - 40, ty, { hero: true, color: BRAND.blue });
  doc.setTextColor(...BRAND.text);

  footerNote(doc, "Generated by ShuleSmart. For inquiries, contact the school accounts office.");
  pageNumbers(doc);

  const d = new Date().toISOString().slice(0, 10);
  doc.save(`fees-balances-${String(meta.classLabel || "all-classes").replace(/\s+/g, "-").toLowerCase()}-${d}.pdf`);
}

/* ------------------------------------------------------------------ */
/*  Students report                                                    */
/* ------------------------------------------------------------------ */

export async function downloadStudentsPdf(rows, meta = {}) {
  await ensurePdfLibs();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const lh = () => drawLetterhead(doc, { title: "Students Report", school: meta.school });

  let y = lh();

  y = sectionHead(doc, "Student Register", y);
  const col2 = pageW(doc) / 2 + 10;
  metaField(doc, "Class", meta.classLabel || "All Classes", 40, y);
  metaField(doc, "Students", `${rows.length} student(s)`, col2, y);
  y += 34;
  if (meta.search) {
    metaField(doc, "Search", `"${meta.search}"`, 40, y);
    y += 26;
  }

  const cap = (v) => (v || "").charAt(0).toUpperCase() + (v || "").slice(1);
  const body = rows.map((r, i) => [
    String(i + 1),
    `${r.first_name || ""} ${r.last_name || ""}`.trim(),
    r.admission_number || "",
    r.class_name || "—",
    r.gender || "—",
    r.guardian_name || "—",
    r.guardian_phone || "—",
    cap(r.status || "active")
  ]);

  doc.autoTable({
    startY: y,
    head: [["#", "Student", "Adm. No.", "Class", "Gender", "Guardian", "Phone", "Status"]],
    body,
    ...TABLE_STYLES,
    columnStyles: {
      0: { cellWidth: 22, halign: "center", textColor: BRAND.gray },
      7: { cellWidth: 50, fontSize: 8 }
    },
    didDrawPage: () => lh()
  });

  const active = rows.filter((r) => (r.status || "active") === "active").length;
  const inactive = rows.length - active;
  const W = pageW(doc), H = pageH(doc);
  let ty = doc.lastAutoTable.finalY + 28;
  if (ty > H - 100) { doc.addPage(); lh(); ty = 132; }
  doc.setDrawColor(...BRAND.border);
  doc.setLineWidth(0.8);
  doc.line(40, ty - 12, W - 40, ty - 12);
  doc.setLineWidth(0.4);
  totalsBox(doc, "Total Students", String(rows.length), W - 40 - 125, ty);
  if (inactive > 0) totalsBox(doc, "Inactive", String(inactive), W - 40 - 250, ty);
  totalsBox(doc, "Active", String(active), W - 40, ty, { hero: true, color: BRAND.blue });
  doc.setTextColor(...BRAND.text);

  footerNote(doc, "Generated by ShuleSmart. For inquiries, contact the school administration office.");
  pageNumbers(doc);

  const d = new Date().toISOString().slice(0, 10);
  doc.save(`students-${String(meta.classLabel || "all-classes").replace(/\s+/g, "-").toLowerCase()}-${d}.pdf`);
}