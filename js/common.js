/**
 * ShuleSmart — School Admin Common UI
 * Shared sidebar/topbar shell + reusable utilities (toasts, modals,
 * confirmations, formatters, loading/empty/error states, logout).
 */

import { auth } from "./firebase-config.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

export const NAV_GROUPS = [
  { label: "Overview", items: [
    { key: "dashboard", label: "Dashboard", href: "/dashboard/", icon: "fa-solid fa-gauge-high" },
    { key: "activity", label: "Activity Log", href: "/activity/", icon: "fa-solid fa-clock-rotate-left" }
  ]},
  { label: "Academics", items: [
    { key: "students", label: "Students", href: "/students/", icon: "fa-solid fa-user-graduate" },
    { key: "teachers", label: "Teachers", href: "/teachers/", icon: "fa-solid fa-chalkboard-user" },
    { key: "staff", label: "Staff", href: "/staff/", icon: "fa-solid fa-user-tie" },
    { key: "classes", label: "Classes", href: "/classes/", icon: "fa-solid fa-layer-group" },
    { key: "subjects", label: "Subjects", href: "/subjects/", icon: "fa-solid fa-book" }
  ]},
  { label: "Examinations", items: [
    { key: "exams", label: "Exams", href: "/exams/", icon: "fa-solid fa-file-pen" },
    { key: "marks", label: "Marks", href: "/marks/", icon: "fa-solid fa-pen-to-square" },
    { key: "results", label: "Results", href: "/results/", icon: "fa-solid fa-chart-simple" }
  ]},
  { label: "Finance", items: [
    { key: "finance-dashboard", label: "Finance Dashboard", href: "/finance-dashboard/", icon: "fa-solid fa-chart-pie" },
    { key: "fees", label: "Fees & Balances", href: "/fees/", icon: "fa-solid fa-money-bill-wave" },
    { key: "fee-structure", label: "Fee Structure", href: "/fee-structure/", icon: "fa-solid fa-list-check" },
    { key: "invoices", label: "Invoices", href: "/invoices/", icon: "fa-solid fa-file-invoice-dollar" },
    { key: "payments", label: "Payments", href: "/payments/", icon: "fa-solid fa-hand-holding-dollar" },
    { key: "receipts", label: "Receipts", href: "/receipts/", icon: "fa-solid fa-receipt" }
  ]},
  { label: "Administration", items: [
    { key: "promotions", label: "Promotions & Rollover", href: "/promotions/", icon: "fa-solid fa-arrow-right-arrow-left" },
    { key: "attendance", label: "Attendance", href: "/attendance/", icon: "fa-solid fa-clipboard-user" },
    { key: "attendance-reports", label: "Attendance Reports", href: "/attendance-reports/", icon: "fa-solid fa-chart-column" },
    { key: "academic-years", label: "Academic Years", href: "/academic-years/", icon: "fa-solid fa-calendar-check" },
    { key: "terms", label: "Terms", href: "/terms/", icon: "fa-solid fa-calendar-days" },
    { key: "reports", label: "Reports", href: "/reports/", icon: "fa-solid fa-file-lines" }
  ]},
  { label: "System", items: [
    { key: "users", label: "Portal Users", href: "/users/", icon: "fa-solid fa-users-gear" },
    { key: "settings", label: "Settings", href: "/settings/", icon: "fa-solid fa-gear" }
  ]}
];

/* ------------------------------------------------------------------ */
/*  Portal access roles                                                */
/*                                                                     */
/*  Single source of truth for which side menus each portal role may   */
/*  see and manage. Roles are assigned to school_admin accounts by     */
/*  the platform owner (Administrator form). Accounts WITHOUT a role   */
/*  default to "head" (full access), so every existing administrator   */
/*  keeps working unchanged.                                           */
/* ------------------------------------------------------------------ */
export const PORTAL_ROLES = {
  head:       { label: "School Head / Principal", menus: "*" },
  school_admin: { label: "School Admin",          menus: "*" },
  deputy:     { label: "Deputy Head",             menus: ["dashboard", "activity", "students", "teachers", "staff", "classes", "subjects", "exams", "marks", "results", "finance-dashboard", "fees", "fee-structure", "invoices", "payments", "receipts", "promotions", "attendance", "attendance-reports", "academic-years", "terms", "reports"] },
  accountant: { label: "Accountant / Bursar",     menus: ["dashboard", "activity", "students", "finance-dashboard", "fees", "fee-structure", "invoices", "payments", "receipts", "reports"] },
  teacher:    { label: "Teacher",                 menus: ["dashboard", "students", "classes", "subjects", "exams", "marks", "results", "attendance", "attendance-reports", "reports"] },
  secretary:  { label: "Secretary",               menus: ["dashboard", "activity", "students", "teachers", "staff", "classes", "subjects", "academic-years", "terms", "attendance-reports", "reports"] }
};

/** Menu list ("*" = everything) for a portal role. Unknown roles fall
 *  back to full access so legacy accounts never lose their menus. */
export function menusForRole(role) {
  return (PORTAL_ROLES[role] || PORTAL_ROLES.head).menus;
}

export function portalRoleLabel(role) {
  return (PORTAL_ROLES[role] || PORTAL_ROLES.head).label;
}

/** Dashboard is visible to every role; everything else is checked. */
export function canAccessMenu(role, key) {
  if (!key || key === "dashboard") return true;
  const menus = menusForRole(role);
  if (menus === "*") return true;
  return menus.includes(key);
}

/* ------------------------------------------------------------------ */
/*  Fine-grained section rights (per account)                          */
/*                                                                     */
/*  Every portal account may carry an explicit `menu_access` grant:    */
/*    - undefined / absent  → legacy behaviour: use the role's preset  */
/*    - "*"                → full access to every section              */
/*    - [key, ...]         → exactly those sections (dashboard always  */
/*                           stays reachable regardless).              */
/*  The School Head edits this list on the Portal Users screen.        */
/* ------------------------------------------------------------------ */

/** Every grantable nav key, in sidebar order. */
export const ACCESS_KEYS = NAV_GROUPS.reduce((acc, g) => {
  g.items.forEach((i) => acc.push(i.key));
  return acc;
}, []);

/**
 * Resolve which sections a portal account may access. Accepts either a
 * user object ({ role, menu_access }) or a bare role string, so all three
 * enforcement layers (sidebar, page gate, API gate) share one source.
 */
export function effectiveMenus(user) {
  const role = typeof user === "string" ? user : ((user && user.role) || "head");
  const access = typeof user === "string" ? undefined : (user && user.menu_access);
  if (access === "*") return "*";
  if (Array.isArray(access)) return access;
  return menusForRole(role);
}

/** Does this portal account have access to the given nav key? */
export function canAccessSection(user, key) {
  if (!key || key === "dashboard") return true;
  const menus = effectiveMenus(user);
  if (menus === "*") return true;
  return menus.includes(key);
}

/** Maps a school-admin page URL to its nav key (student-details.html →
 *  "students", etc.). */
export function navKeyFromPath(pathname) {
  // Pages now live at /<folder>/index.html, so the active key is the
  // folder name (the segment before the trailing "index" / "index.html").
  const segs = String(pathname || "").split("/").filter(Boolean);
  let file = segs.length ? segs[segs.length - 1] : "";
  if (/^index(\.html)?$/i.test(file) && segs.length > 1) file = segs[segs.length - 2];
  file = file.replace(/\.html$/i, "");
  const aliases = { "student-details": "students", "teacher-details": "teachers" };
  return aliases[file] || file || "dashboard";
}

export function initShell({ active = "dashboard" } = {}) {
  const school = window.currentSchool || {};
  const admin = window.currentAdmin || { name: "School Admin", role: "head" };
  const roleLabel = portalRoleLabel(admin.role);

  const sidebar = document.getElementById("sidebar");

  /* Filter the navigation down to what this account may see and manage. */
  const menus = effectiveMenus(admin);
  const allowed = canAccessSection(admin, active);
  const groups = NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => i.key === "dashboard" || menus === "*" || menus.includes(i.key)) }))
    .filter((g) => g.items.length > 0);

  sidebar.innerHTML = `
    <div class="sa-sidebar-brand">
      <div class="sa-brand-mark">${initials(school.name || "SS")}</div>
      <div class="sa-brand-text">
        <div class="sa-brand-name">${escapeHtml(school.name || "ShuleSmart")}</div>
        <div class="sa-brand-code">${escapeHtml(school.school_code || "SCHOOL")}</div>
      </div>
    </div>
    <nav class="sa-sidebar-nav">
      ${groups.map((group) => `
        <div class="sa-nav-group">
          <div class="sa-nav-group-label">${group.label}</div>
          ${group.items.map((item) => `
            <a href="${item.href}" class="sa-nav-item ${item.key === active ? "active" : ""}">
              <i class="${item.icon}"></i><span>${item.label}</span>
            </a>
          `).join("")}
        </div>
      `).join("")}
      ${allowed ? "" : `
      <div class="sa-nav-group">
        <div class="sa-nav-group-label">Access</div>
        <a href="../dashboard/" class="sa-nav-item active"><i class="fa-solid fa-lock"></i><span>Section not available</span></a>
      </div>`}
    </nav>
    <div class="sa-sidebar-foot">
      <button class="sa-nav-item" id="logoutBtn"><i class="fa-solid fa-right-from-bracket"></i><span>Logout</span></button>
    </div>
  `;

  const topbar = document.getElementById("topbar");
  topbar.innerHTML = `
    <div class="sa-topbar-left">
      <button class="sa-icon-btn sa-hamburger" id="hamburgerBtn" aria-label="Open menu"><i class="fa-solid fa-bars"></i></button>
      <div class="sa-topbar-title" id="topbarTitle"></div>
    </div>
    <div class="sa-topbar-right">
      <span class="sa-school-chip"><i class="fa-solid fa-school"></i> ${escapeHtml(school.name || "")}</span>
      <div class="sa-user-chip" title="${escapeHtml(roleLabel)}">
        <span class="sa-avatar">${initials(admin.name || "A")}</span>
        <span>
          <span class="sa-avatar-name">${escapeHtml(admin.name || "")}</span>
          <span style="display:block;font-size:10px;color:var(--text-secondary);line-height:1.25;">${escapeHtml(roleLabel)}</span>
        </span>
      </div>
    </div>
  `;

  const overlay = document.getElementById("sidebarOverlay");
  const hamburger = document.getElementById("hamburgerBtn");
  function openSidebar() { sidebar.classList.add("open"); overlay.classList.add("show"); }
  function closeSidebar() { sidebar.classList.remove("open"); overlay.classList.remove("show"); }
  hamburger.addEventListener("click", openSidebar);
  overlay.addEventListener("click", closeSidebar);
  sidebar.querySelectorAll(".sa-nav-item").forEach((a) => a.addEventListener("click", closeSidebar));

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Sign out of ShuleSmart?",
      message: "You will need to sign in again to manage your school.",
      confirmText: "Sign Out",
      danger: false
    });
    if (!ok) return;
    try { localStorage.removeItem("shulesmart_session_cache"); } catch { /* ignore */ }
    try { await signOut(auth); } catch { /* ignore */ }
    window.location.href = "../login/";
  });

  /* Role guard — this page sits outside the signed-in user's menus.
     Blank the content and bounce to the dashboard (visible to all roles). */
  if (!allowed) {
    const main = document.querySelector(".sa-content");
    if (main) main.innerHTML = `
      <div style="padding:70px 20px;text-align:center;">
        <i class="fa-solid fa-lock" style="font-size:36px;color:var(--text-secondary);"></i>
        <h3 style="font-family:var(--font-display);font-size:20px;margin:14px 0 6px;">Section not available</h3>
        <p style="color:var(--text-secondary);font-size:14px;margin:0 0 4px;">
          Your role — ${escapeHtml(roleLabel)} — does not include this section.
        </p>
        <p style="color:var(--text-secondary);font-size:13px;">Redirecting you to the dashboard…</p>
      </div>`;
    setTimeout(() => { window.location.href = "../dashboard/"; }, 1800);
  }
}

export function setTopbarTitle(title) {
  const el = document.getElementById("topbarTitle");
  if (el) el.textContent = title;
}

/* ------------------------------------------------------------------ */
/*  Escape + formatting helpers                                        */
/* ------------------------------------------------------------------ */

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/* Normalizes timestamps from any backend into a Date (local timezone
   conversion happens downstream via toLocale*). Handles:
   - Firestore Timestamp objects (toMillis / seconds+nanoseconds)
   - Date instances
   - ISO strings that already carry a "Z" / ±HH:MM offset
   - Numeric epoch values in seconds or milliseconds
   - SQLite-style "YYYY-MM-DD HH:MM:SS" strings, which datetime('now')
     stores in UTC — treated as UTC by appending the Z marker.
   Returns null when the value cannot be interpreted as a date. */
function toDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "object") {
    if (typeof value.toMillis === "function") return new Date(value.toMillis()); /* Firestore Timestamp */
    if (typeof value.seconds === "number") return new Date(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6));
    return null;
  }
  let s = String(value).trim();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000); /* epoch seconds */
  if (/^\d{13}$/.test(s)) return new Date(Number(s));        /* epoch millis  */
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.exec(s);
  if (m) { /* UTC string without timezone marker → make it explicit */
    let t = m[2]; if (t.length === 5) t += ":00";
    s = m[1] + "T" + t + "Z";
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function formatDate(value) {
  const d = toDate(value);
  if (!d) return value == null || value === "" ? "\u2014" : String(value);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(value) {
  const d = toDate(value);
  if (!d) return value == null || value === "" ? "\u2014" : String(value);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatCurrency(value) {
  const num = Number(value || 0);
  return "KSh " + num.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function badgeHtml(status) {
  const s = String(status || "").toLowerCase();
  let cls = "sa-badge sa-badge-neutral";
  if (["active", "present", "paid", "current"].includes(s)) cls = "sa-badge sa-badge-success";
  if (["inactive", "absent", "overdue"].includes(s)) cls = "sa-badge sa-badge-danger";
  if (["pending", "late", "unpaid"].includes(s)) cls = "sa-badge sa-badge-warning";
  if (s === "excused") cls = "sa-badge sa-badge-info";
  return `<span class="${cls}">${escapeHtml(status || "—")}</span>`;
}

/* ------------------------------------------------------------------ */
/*  Toasts                                                            */
/* ------------------------------------------------------------------ */

export function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  const icons = {
    success: "fa-solid fa-circle-check",
    error: "fa-solid fa-circle-exclamation",
    warning: "fa-solid fa-triangle-exclamation",
    info: "fa-solid fa-circle-info"
  };
  const toast = document.createElement("div");
  toast.className = `sa-toast ${type}`;
  toast.innerHTML = `
    <i class="${icons[type] || icons.info}"></i>
    <span class="sa-toast-msg"></span>
    <button class="sa-toast-close" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>`;
  toast.querySelector(".sa-toast-msg").textContent = message;
  container.appendChild(toast);
  const remove = () => {
    toast.classList.add("hide");
    setTimeout(() => toast.remove(), 260);
  };
  toast.querySelector(".sa-toast-close").addEventListener("click", remove);
  setTimeout(remove, 4500);
}

/* ------------------------------------------------------------------ */
/*  Modal + confirmation dialogs                                      */
/* ------------------------------------------------------------------ */

export function openModal(html, { onMount } = {}) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="sa-modal-overlay">
      <div class="sa-modal" role="dialog" aria-modal="true">
        <button class="sa-modal-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
        ${html}
      </div>
    </div>`;
  root.querySelector(".sa-modal-overlay").addEventListener("click", (e) => {
    if (e.target.classList.contains("sa-modal-overlay")) closeModal();
  });
  root.querySelector(".sa-modal-close").addEventListener("click", closeModal);
  if (typeof onMount === "function") onMount(root);
}

export function closeModal() {
  const root = document.getElementById("modalRoot");
  root.innerHTML = "";
}

export function confirmDialog({ title, message, confirmText = "Confirm", danger = true }) {
  return new Promise((resolve) => {
    openModal(`
      <div style="text-align:center;">
        <div class="sa-confirm-icon ${danger ? "danger" : "info"}">
          <i class="fa-solid ${danger ? "fa-trash-can" : "fa-circle-question"}"></i>
        </div>
        <h3 class="sa-modal-title">${escapeHtml(title)}</h3>
        <p class="sa-modal-message">${escapeHtml(message)}</p>
        <div class="sa-modal-actions">
          <button class="sa-btn sa-btn-ghost" id="confirmCancel">Cancel</button>
          <button class="sa-btn ${danger ? "sa-btn-danger" : "sa-btn-primary"}" id="confirmOk">${escapeHtml(confirmText)}</button>
        </div>
      </div>`);

    document.getElementById("confirmCancel").addEventListener("click", () => { closeModal(); resolve(false); });
    document.getElementById("confirmOk").addEventListener("click", () => { closeModal(); resolve(true); });
  });
}

/* ------------------------------------------------------------------ */
/*  Content states (loading / empty / error)                          */
/* ------------------------------------------------------------------ */

export function loadingState(el, text = "Loading...") {
  el.innerHTML = `
    <div class="sa-state">
      <div class="sa-spinner"></div>
      <p>${escapeHtml(text)}</p>
    </div>`;
}

export function emptyState(el, { icon = "fa-solid fa-circle-info", title = "Nothing here yet", message = "" } = {}) {
  el.innerHTML = `
    <div class="sa-state">
      <i class="${icon}"></i>
      <h4>${escapeHtml(title)}</h4>
      ${message ? `<p>${escapeHtml(message)}</p>` : ""}
    </div>`;
}

export function errorState(el, message = "Something went wrong. Please try again.") {
  el.innerHTML = `
    <div class="sa-state">
      <i class="fa-solid fa-triangle-exclamation"></i>
      <h4>Unable to load data</h4>
      <p>${escapeHtml(message)}</p>
    </div>`;
}

/* ------------------------------------------------------------------ */
/*  Scaffold notice for modules being wired up                        */
/* ------------------------------------------------------------------ */

export function scaffoldNotice({ title = "Module ready", description = "", endpoint = "", icon = "fa-solid fa-hammer" }) {
  const slot = document.getElementById("moduleSlot");
  if (!slot) return;
  slot.innerHTML = `
    <div class="sa-card">
      <div class="sa-state">
        <i class="${icon}"></i>
        <h4>${escapeHtml(title)}</h4>
        <p>${escapeHtml(description)}</p>
        ${endpoint ? `<code class="sa-endpoint-chip">${escapeHtml(endpoint)}</code>` : ""}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/*  Searchable combobox (search inside a dropdown)                     */
/* ------------------------------------------------------------------ */
/*  Renders a click-to-open dropdown with a live search box, so long
 *  lists (students, staff…) can be narrowed by typing. Supports both
 *  single-select (payments) and multi-select (invoices) by passing
 *  { multiple: true }. Returns a handle with setOptions / getValue /
 *  getValues / setValue / clear so callers keep full control without
 *  touching any native <select>.
 */
const openComboboxes = new Set();

export function searchableCombobox({
  container,                 // element to mount into
  options = [],              // [{ id, label }]
  multiple = false,
  selected = multiple ? [] : "",
  placeholder = "Search and select…",
  emptyText = "No matches",
  onChange = null
}) {
  container.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.className = "sa-ss";
  let state = multiple ? new Set(selected) : (selected || "");
  const field = document.createElement("button");
  field.type = "button";
  field.className = "sa-ss-field";
  field.innerHTML = '<span class="sa-ss-value"></span><i class="fa-solid fa-chevron-down sa-ss-arrow"></i>';

  const panel = document.createElement("div");
  panel.className = "sa-ss-panel";
  const search = document.createElement("input");
  search.type = "text";
  search.className = "sa-ss-search";
  search.placeholder = placeholder;
  search.autocomplete = "off";
  const listEl = document.createElement("div");
  listEl.className = "sa-ss-list";
  panel.append(search, listEl);
  wrapper.append(field, panel);
  container.appendChild(wrapper);

  const valueEl = field.querySelector(".sa-ss-value");
  let currentOptions = options;

  const labelOf = (id) => {
    const hit = currentOptions.find((o) => o.id === id) || options.find((o) => o.id === id);
    return hit ? hit.label : id;
  };

  function renderValue() {
    if (multiple) {
      const arr = Array.from(state);
      valueEl.textContent = arr.length ? arr.map(labelOf).join(", ") : "Select…";
    } else {
      valueEl.textContent = state ? labelOf(state) : "Select…";
    }
    valueEl.classList.toggle("has", multiple ? state.size > 0 : !!state);
  }

  function renderList() {
    const q = (search.value || "").trim().toLowerCase();
    const list = q ? currentOptions.filter((o) => o.label.toLowerCase().includes(q)) : currentOptions;
    if (!list.length) {
      listEl.innerHTML = `<div class="sa-ss-empty">${escapeHtml(emptyText)}</div>`;
      return;
    }
    listEl.innerHTML = list.map((o) => {
      const sel = multiple ? state.has(o.id) : state === o.id;
      return `<div class="sa-ss-opt${sel ? " sel" : ""}" data-id="${o.id}">${escapeHtml(o.label)}</div>`;
    }).join("");
    listEl.querySelectorAll("[data-id]").forEach((opt) => opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = opt.dataset.id;
      if (multiple) {
        if (state.has(id)) state.delete(id); else state.add(id);
        renderList();
      } else {
        state = id;
        close();
      }
      renderValue();
      if (onChange) onChange(getValue());
    }));
  }

  function open() {
    openComboboxes.forEach((x) => x !== wrapper && x.classList.remove("open"));
    openComboboxes.clear();
    wrapper.classList.add("open");
    openComboboxes.add(wrapper);
    search.value = "";
    renderList();
    search.focus();
  }
  function close() {
    wrapper.classList.remove("open");
    openComboboxes.delete(wrapper);
  }

  field.addEventListener("click", () => (wrapper.classList.contains("open") ? close() : open()));
  search.addEventListener("input", renderList);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = listEl.querySelector(".sa-ss-opt");
      if (first) first.click();
      e.preventDefault();
    }
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  function getValue() {
    return multiple ? Array.from(state) : state;
  }
  function setValue(v) {
    if (multiple) { state.clear(); (v || []).forEach((x) => state.add(x)); }
    else state = v || "";
    renderValue();
  }
  function setOptions(list) {
    currentOptions = list || [];
    renderValue();
  }
  function clear() { setValue(multiple ? [] : ""); }

  renderValue();
  return { wrapper, getValue, setValue, setOptions, clear, open, close };
}

/* One delegated close handler for every combobox sharing this document. */
document.addEventListener("click", (e) => {
  if (!e.target || !e.target.closest) return;
  if (e.target.closest(".sa-ss")) return;
  openComboboxes.forEach((w) => w.classList.remove("open"));
  openComboboxes.clear();
});

