
        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
        import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
        import { getFirestore, collection, addDoc, getDocs, getDoc, updateDoc, deleteDoc, setDoc, doc, query, where, orderBy, onSnapshot, serverTimestamp, increment, limit } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

        // --- FIREBASE CONFIGURATION ---
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

        // ---------------------------------------------------------------------
        // PLATFORM ACCOUNTS (`users` collection)
        // Master Control access is driven entirely by Firestore: every platform
        // account lives in the `users` collection (document ID = the email,
        // lowercased) carrying at least: name, email, role, status.
        // On EVERY login (and session restore) we read users/{email} and only
        // continue when role === 'owner' (legacy 'super_owner' also accepted).
        // ---------------------------------------------------------------------
        const OWNER_ROLES = ['owner', 'super_owner'];

        const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

        async function getUserAccount(email) {
            try {
                const snap = await getDoc(doc(db, 'users', normalizeEmail(email)));
                return snap.exists() ? { id: snap.id, ...snap.data() } : null;
            } catch (err) {
                console.warn('Could not read users/' + normalizeEmail(email), err);
                return null;
            }
        }

        async function isSuperOwner(email) {
            const account = await getUserAccount(email);
            if (!account || account.status === 'inactive') return false;
            return OWNER_ROLES.includes(String(account.role || '').toLowerCase());
        }

        // Module registry (canonical module keys). These map to features in the
        // school dashboard and can be toggled per-school.
        const PLATFORM_MODULES = [
            { key: 'students', label: 'Students' },
            { key: 'teachers', label: 'Staff & Teachers' },
            { key: 'classes', label: 'Academics' },
            { key: 'attendance', label: 'Attendance' },
            { key: 'exams', label: 'Assessments' },
            { key: 'report_cards', label: 'Report Cards' },
            { key: 'fees', label: 'Finance' },
            { key: 'library', label: 'Library' },
            { key: 'transport', label: 'Transport' },
            { key: 'hostel', label: 'Hostel' },
            { key: 'inventory', label: 'Inventory' },
            { key: 'payroll', label: 'Payroll' }
        ];

        // Default modules enabled for every newly created school
        const DEFAULT_SCHOOL_MODULES = ['students', 'teachers', 'classes', 'attendance', 'exams', 'fees'];

        // Backend endpoint that creates a Firebase Auth account for a school owner.
        // Implement this server-side with the Firebase Admin SDK (auth.createUser).
        // Leave "" to SKIP server-side user creation (school is still saved, owner email
        // is still assigned, but no login account is created).
        // Example: "https://us-central1-schoolmanagementsaas-a7bad.cloudfunctions.net/createSchoolOwner"
        const CREATE_OWNER_ENDPOINT = "";

        // ---------------------------------------------------------------------
        // UI HELPERS
        // ---------------------------------------------------------------------
        window.showToast = (msg, type = 'success') => {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            toast.className = `toast ${type === 'success' ? 'btn-primary' : 'btn-danger'}`;
            toast.innerHTML = `<i class="fas ${type === 'success' ? 'fa-check-circle' : 'fa-exclamation-triangle'}"></i> ${msg}`;
            container.appendChild(toast);
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(20px)';
                toast.style.transition = 'all 0.3s ease';
                setTimeout(() => toast.remove(), 300);
            }, 4000);
        };

        // Custom on-screen alert dialog (appears on top as a screen prompt)
        window.showAlert = (msg, type = 'info', onClose = null) => {
            const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
            let overlay = document.getElementById('app-alert-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'app-alert-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:99999;';
                overlay.innerHTML =
                    '<div style="background:#fff;border-radius:14px;max-width:420px;width:90%;padding:26px 24px;box-shadow:0 14px 50px rgba(0,0,0,0.35);text-align:center;font-family:inherit;">' +
                        '<div id="app-alert-icon" style="font-size:2.4rem;margin-bottom:12px;"></div>' +
                        '<p id="app-alert-msg" style="font-size:1rem;color:#2b2b2b;line-height:1.55;margin:0 0 20px;word-break:break-word;"></p>' +
                        '<button id="app-alert-btn" style="padding:11px 30px;border:none;border-radius:8px;color:#fff;font-weight:600;cursor:pointer;font-size:0.95rem;min-width:110px;">OK</button>' +
                    '</div>';
                document.body.appendChild(overlay);
            }
            const cfg = {
                error:   { icon: 'fa-exclamation-triangle', color: '#dc3545' },
                success: { icon: 'fa-check-circle',         color: '#28a745' },
                warning: { icon: 'fa-exclamation-circle',   color: '#f39c12' },
                info:    { icon: 'fa-info-circle',          color: '#0d6efd' }
            }[type] || { icon: 'fa-info-circle', color: '#0d6efd' };
            document.getElementById('app-alert-icon').innerHTML = '<i class="fas ' + cfg.icon + '" style="color:' + cfg.color + ';"></i>';
            document.getElementById('app-alert-msg').innerHTML = esc(msg).replace(/\n/g, '<br>');
            document.getElementById('app-alert-btn').style.background = cfg.color;
            overlay.style.display = 'flex';
            const close = () => { overlay.style.display = 'none'; if (onClose) onClose(); };
            document.getElementById('app-alert-btn').onclick = close;
            overlay.onclick = (e) => { if (e.target === overlay) close(); };
            document.onkeydown = (e) => { if (e.key === 'Escape') close(); };
        };

        function showLoader(s) { document.getElementById('loader').style.display = s ? 'flex' : 'none'; }

        function getFriendlyErrorMessage(error) {
            if (typeof error === 'string') return error;
            switch (error.code) {
                case 'auth/user-not-found': return "Account not found. Please check your email.";
                case 'auth/wrong-password': return "Incorrect password. Please try again.";
                case 'auth/invalid-email': return "The email format is invalid.";
                case 'auth/invalid-credential': return "Incorrect email or password.";
                case 'auth/too-many-requests': return "Too many login attempts. Please try again later.";
                case 'permission-denied': return "Access denied. You don't have permission for this.";
                default: return error.message || "An unexpected error occurred.";
            }
        }

        function fmtDate(d) {
            if (!d) return '-';
            const dt = d.seconds ? new Date(d.seconds * 1000) : new Date(d);
            if (isNaN(dt)) return '-';
            return dt.toLocaleString();
        }

        // ---- AUDIT LOGGING ----
        // Every significant platform action is recorded so the Super Admin has a
        // full trail of changes across the whole platform.
        async function logAudit(action, module, details = {}, recordId = '', schoolId = null, schoolName = null) {
            try {
                const user = auth.currentUser;
                await addDoc(collection(db, 'audit_logs'), {
                    user: user ? (user.displayName || user.email) : 'Master Admin',
                    role: 'Super Admin',
                    action: action,
                    module: module,
                    schoolId: schoolId || null,
                    schoolName: schoolName || null,
                    recordId: recordId || null,
                    details: details || {},
                    timestamp: serverTimestamp()
                });
            } catch (e) { /* audit logging must never break the main flow */
                console.warn('Audit log failed', e);
            }
        }

        // ---- AUTH ----
        window.handleLogin = async (e) => {
            e.preventDefault();
            showLoader(true);
            const email = document.getElementById('login-email').value;
            const pass = document.getElementById('login-password').value;
            try {
                await signInWithEmailAndPassword(auth, email, pass);
                // Role gate lives in Firestore: users/{email} must exist and carry
                // the owner role. This replaces the old hardcoded email allowlist.
                const account = await getUserAccount(email);
                const isOwnerAccount = !!account
                    && account.status !== 'inactive'
                    && OWNER_ROLES.includes(String(account.role || '').toLowerCase());
                if (!isOwnerAccount) {
                    showToast("Access denied: your account does not have the Super Owner (owner) role.", "error");
                    await signOut(auth);
                    return;
                }
                // Stamp last login into the account record ("other details") — never fatal.
                try {
                    await updateDoc(doc(db, 'users', normalizeEmail(email)), { lastLogin: serverTimestamp() });
                } catch (_) { /* ignore */ }
                showToast("Login successful. Accessing Master Panel...");
                logAudit('login', 'auth', { email });
            } catch (err) {
                showToast(getFriendlyErrorMessage(err), "error");
            } finally {
                showLoader(false);
            }
        };

        let _appInitialized = false;

        onAuthStateChanged(auth, async (user) => {
            if (user) {
                // Re-check the Firestore role on every session restore too — revoking
                // a Super Owner locks them out on their very next visit.
                if (!(await isSuperOwner(user.email))) {
                    showAlert("Access Denied: Your account does not have the Super Owner (owner) role.", 'error', () => { signOut(auth).then(() => { window.location.href = 'index.html'; }); });
                    return;
                }
                document.getElementById('auth-section').classList.add('hidden');
                document.getElementById('app-section').classList.remove('hidden');
                if (!_appInitialized) {
                    _appInitialized = true;
                    initApp();
                }
            } else {
                _appInitialized = false;
                document.getElementById('auth-section').classList.remove('hidden');
                document.getElementById('app-section').classList.add('hidden');
            }
        });

        window.logout = () => { logAudit('logout', 'auth', {}); signOut(auth); };

        // ---- UI: Sidebar + Navigation ----
        window.toggleSidebar = () => {
            const sidebar = document.querySelector('.sidebar');
            const overlay = document.getElementById('sidebar-overlay');
            if (sidebar.classList.contains('active')) {
                sidebar.classList.remove('active');
                overlay.style.display = 'none';
            } else {
                sidebar.classList.add('active');
                overlay.style.display = 'block';
            }
        };

        window.filterTable = (tableId, term) => {
            const rows = document.querySelectorAll(`#${tableId} tbody tr`);
            const t = term.toLowerCase();
            rows.forEach(r => { r.style.display = r.textContent.toLowerCase().includes(t) ? '' : 'none'; });
        };

        window.openModal = (id) => {
            document.getElementById(id).classList.add('active');
            if (id === 'modal-school') {
                document.getElementById('modal-school-title').innerText = "Create New School";
                document.getElementById('modal-school-btn').innerText = "Create School";
                document.getElementById('edit-sch-id').value = "";
                document.getElementById('sch-name').value = "";
                document.getElementById('sch-loc').value = "";
                document.getElementById('sch-owner').value = "";
                document.getElementById('sch-owner-password').value = "";
                document.getElementById('sch-owner-password-wrap').style.display = '';
                document.getElementById('sch-status').value = "active";
                populateModuleSelector();
            } else if (id === 'modal-owner') {
                document.getElementById('modal-owner-title').innerText = "Create New Owner";
                document.getElementById('modal-owner-btn').innerText = "Create Owner";
                document.getElementById('edit-owner-id').value = "";
                populateSchoolSelect('own-school');
            }
        };

        window.closeModal = (id) => document.getElementById(id).classList.remove('active');

        // Populate the school <select> used across modals
        async function populateSchoolSelect(targetId) {
            const sel = document.getElementById(targetId);
            if (!sel) return;
            const snap = await getDocs(query(collection(db, 'schools'), orderBy('name')));
            let html = '<option value="">-- Select School --</option>';
            snap.forEach(d => {
                html += `<option value="${d.id}">${d.data().name}</option>`;
            });
            sel.innerHTML = html;
        }
// Populate the per-school module checkboxes in the school modal
        function populateModuleSelector(mode, selectedModules = null) {
            const box = document.getElementById('sch-modules-selector');
            if (!box) return;
            const active = selectedModules && selectedModules.length ? selectedModules : (mode === 'edit' ? [] : DEFAULT_SCHOOL_MODULES);
            box.innerHTML = PLATFORM_MODULES.map(m => `
                <label class="perm-check">
                    <input type="checkbox" value="${m.key}" ${active.includes(m.key) ? 'checked' : ''}> ${m.label}
                </label>
            `).join('');
        }

        // App init: wire up navigation and load default landing view
        async function initApp() {
            document.querySelectorAll('#sidebar .menu-item').forEach(item => {
                item.addEventListener('click', () => {
                    const viewId = item.dataset.view;
                    document.querySelectorAll('#sidebar .menu-item').forEach(i => i.classList.remove('active'));
                    item.classList.add('active');
                    document.querySelectorAll('#view-container .view').forEach(v => v.classList.add('hidden'));
                    const target = document.getElementById(`view-${viewId}`);
                    if (target) target.classList.remove('hidden');
                    document.getElementById('view-title').innerText = item.innerText.trim();
                    if (window.innerWidth <= 992) toggleSidebar();
                    loadView(viewId);
                });
            });

            // Shared collections cache
            window._schoolsCache = [];
            window._schoolAdminsCache = [];
            window._ownersCache = [];
            window._modulesCache = [];
            window._superOwnersCache = [];

            await Promise.all([loadSchools(), loadSchoolAdmins(), loadOwners(), loadModules(), loadSuperOwners()]);
            renderDashboard();
        }

        async function loadSchools() {
            const snap = await getDocs(query(collection(db, 'schools'), orderBy('createdAt', 'desc')));
            window._schoolsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        }

        async function loadSchoolAdmins() {
            const snap = await getDocs(collection(db, 'school_admins'));
            window._schoolAdminsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        }

        async function loadOwners() {
            const snap = await getDocs(query(collection(db, 'school_owners'), orderBy('createdAt', 'desc')));
            window._ownersCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        }

        async function loadModules() {
            const snap = await getDocs(query(collection(db, 'modules'), orderBy('createdAt', 'desc')));
            window._modulesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        }

        // ================= SUPER OWNERS (`users` collection) =================
        // Platform accounts live in the `users` collection (doc ID = email,
        // lowercased): { name, email, role, status, addedBy, createdAt, lastLogin }.
        // An account is a Super Owner when `role` is 'owner' (legacy 'super_owner'
        // also recognised) — the same gate enforced on every login above.
        async function loadSuperOwners() {
            const snap = await getDocs(collection(db, 'users'));
            window._superOwnersCache = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(u => OWNER_ROLES.includes(String(u.role || '').toLowerCase()));
        }

        window.renderSuperOwners = () => {
            const tbody = document.getElementById('super-owner-list-body');
            if (!tbody) return;
            const owners = window._superOwnersCache;
            if (!owners.length) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:2rem;">No Super Owners found yet. Use "Grant Super Owner" to add the first one.</td></tr>';
                return;
            }
            tbody.innerHTML = owners.map(o => `
                <tr>
                    <td><b>${o.name || '—'}</b></td>
                    <td>${o.email || o.id}</td>
                    <td><span style="background:${o.status === 'inactive' ? '#f39c12' : '#28a745'};color:#fff;padding:.25rem .65rem;border-radius:20px;font-size:.75rem;font-weight:600;">${o.status === 'inactive' ? 'Inactive' : 'Active'}</span></td>
                    <td>${fmtDate(o.createdAt)}</td>
                    <td><i class="fas fa-user-minus" style="color:var(--danger);cursor:pointer;" title="Revoke Super Owner access" onclick="removeSuperOwner('${o.email || o.id}')"></i></td>
                </tr>
            `).join('');
        };

        window.addSuperOwner = async (e) => {
            e.preventDefault();
            const emailInput = document.getElementById('super-owner-email');
            const nameInput = document.getElementById('super-owner-name');
            const email = normalizeEmail(emailInput.value);
            const name = (nameInput.value || '').trim();
            if (!email) return showToast("A valid email is required.", "error");
            showLoader(true);
            try {
                // Create (or upgrade) the account record with the owner role —
                // this document is what gates every future Master Control login.
                await setDoc(doc(db, 'users', email), {
                    name: name || email.split('@')[0],
                    email: email,
                    role: 'owner',
                    status: 'active',
                    addedBy: auth.currentUser ? auth.currentUser.email : '',
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                }, { merge: true });
                showToast(`Super Owner access granted to ${name || email}.`);
                logAudit('granted_super_owner', 'platform_users', { target: email, name: name || '' }, email);
                closeModal('modal-super-owner');
                emailInput.value = '';
                nameInput.value = '';
                await loadSuperOwners();
                renderSuperOwners();
            } catch (err) {
                showToast(getFriendlyErrorMessage(err), 'error');
            } finally {
                showLoader(false);
            }
        };

        window.removeSuperOwner = async (email) => {
            const key = normalizeEmail(email);
            if (!key) return;
            if (auth.currentUser && normalizeEmail(auth.currentUser.email) === key) {
                return showToast("You cannot revoke your own Super Owner access while signed in.", "warning");
            }
            if (!confirm(`Revoke Super Owner access for ${key}? They will immediately lose access to Master Control.`)) return;
            showLoader(true);
            try {
                await deleteDoc(doc(db, 'users', key));
                showToast(`Super Owner access revoked for ${key}.`);
                logAudit('revoked_super_owner', 'platform_users', { target: key }, key);
                await loadSuperOwners();
                renderSuperOwners();
            } catch (err) {
                showToast(getFriendlyErrorMessage(err), 'error');
            } finally {
                showLoader(false);
            }
        };

        function loadView(viewId) {
            const handlers = {
                dashboard: renderDashboard,
                schools: renderSchools,
                owners: renderOwners,
                modules: renderModules,
                users: renderPlatformUsers,
                roles: renderRoles,
                superowners: renderSuperOwners,
                support: renderSupport,
                audit: loadAuditLogs,
                analytics: renderAnalytics,
                announcements: renderAnnouncements,
                settings: loadPlatformSettings,
                health: refreshSystemHealth
            };
            if (handlers[viewId]) handlers[viewId]();
        }

        window.refreshDashboard = () => renderDashboard();

// ================= DASHBOARD =================
        async function renderDashboard() {
            const schools = window._schoolsCache;
            const admins = window._schoolAdminsCache;
            const owners = window._ownersCache;

            const totalSchools = schools.length;
            const activeSchools = schools.filter(s => s.status === 'active').length;
            const inactiveSchools = schools.filter(s => ['inactive', 'suspended', 'archived'].includes(s.status)).length;

            // Count all students & teachers across all schools
            let totalStudents = 0, totalTeachers = 0;
            const stuSnap = await getDocs(query(collection(db, 'students'), orderBy('createdAt', 'desc')));
            totalStudents = stuSnap.size;
            const teachSnap = await getDocs(collection(db, 'teachers'));
            totalTeachers = teachSnap.size;
            const totalAdmins = admins.length;
            const totalUsers = totalAdmins + totalTeachers;

            setStat('stat-total-schools', totalSchools);
            setStat('stat-active-schools', activeSchools);
            setStat('stat-inactive-schools', inactiveSchools);
            setStat('stat-total-students', totalStudents);
            setStat('stat-total-teachers', totalTeachers);
            setStat('stat-total-admins', totalAdmins);
            setStat('stat-total-users', totalUsers);

            // Recently added schools
            const recent = [...schools].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 6);
            document.getElementById('recent-schools-body').innerHTML = recent.length ? recent.map(s => `
                <tr>
                    <td><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${s.themeColor || '#800000'};margin-right:6px;"></span><b>${s.name || s.id}</b></td>
                    <td>${s.location || '-'}</td>
                    <td>${statusBadge(s.status)}</td>
                    <td>${fmtDate(s.createdAt)}</td>
                </tr>`).join('') : '<tr><td colspan="4" style="text-align:center;padding:2rem;">No schools yet.</td></tr>';

            // Recent activity from audit logs
            const logSnap = await getDocs(query(collection(db, 'audit_logs'), orderBy('timestamp', 'desc')));
            const logs = logSnap.docs.slice(0, 6).map(d => ({ id: d.id, ...d.data() }));
            document.getElementById('recent-activity-body').innerHTML = logs.length ? logs.map(l => `
                <tr>
                    <td><b>${l.action || '-'}</b></td>
                    <td>${l.user || '-'}</td>
                    <td>${l.schoolName || 'Platform'}</td>
                    <td>${fmtDate(l.timestamp)}</td>
                </tr>`).join('') : '<tr><td colspan="4" style="text-align:center;padding:2rem;">No activity yet.</td></tr>';

            // Alerts
            const alerts = [];
            if (inactiveSchools > 0) alerts.push(`<li><i class="fas fa-exclamation-triangle" style="color:var(--warning)"></i> <b>${inactiveSchools}</b> school(s) are inactive or suspended.</li>`);
            const lowStudents = totalStudents === 0;
            if (lowStudents) alerts.push('<li><i class="fas fa-info-circle" style="color:var(--primary)"></i> No students have been added to any school yet.</li>');
            document.getElementById('system-alerts').innerHTML = alerts.length ? alerts.join('') : '<p style="color:var(--text-muted);">No active alerts.</p>';
        }

        function set(el, v) { const e = document.getElementById(el); if (e) e.innerText = v; }

        function statusBadge(status) {
            const map = {
                active: ['badge-active', 'Active'],
                inactive: ['badge-inactive', 'Inactive'],
                suspended: ['badge-suspended', 'Suspended'],
                archived: ['badge-archived', 'Archived']
            };
            const [cls, label] = map[status] || ['badge-inactive', status || 'active'];
            return `<span class="${cls}">${label}</span>`;
        }

function setStat(id, v) { const e = document.getElementById(id); if (e) e.innerText = v.toLocaleString ? v.toLocaleString() : v; }

        // ================= SCHOOLS =================
        window.renderSchools = () => {
            const schools = window._schoolsCache;
            const owners = window._ownersCache;
            const ownerBySchool = {};
            owners.forEach(o => { if (o.schoolId) ownerBySchool[o.schoolId] = o; });

            document.getElementById('school-list-body').innerHTML = schools.length ? schools.map(s => {
                const owner = ownerBySchool[s.id];
                return `
                <tr>
                    <td><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${s.themeColor || '#800000'};margin-right:6px;"></span><b>${s.name || s.id}</b></td>
                    <td>${s.location || '-'}</td>
                    <td>${statusBadge(s.status)}</td>
                    <td>${owner ? (owner.name || owner.email) : '<i style="color:var(--text-muted)">None</i>'}</td>
                    <td>${s.studentCount ?? '—'}</td>
                    <td>${s.teacherCount ?? '—'}</td>
                    <td><button class="btn btn-outline btn-sm" style="font-size:0.7rem;padding:0.25rem 0.5rem;" onclick="viewSchool('${s.id}')">Manage</button></td>
                    <td>${fmtDate(s.createdAt)}</td>
                    <td>
                        <i class="fas fa-eye" style="color:var(--primary);cursor:pointer;margin-right:8px;" title="View" onclick="viewSchool('${s.id}')"></i>
                        <i class="fas fa-edit" style="color:var(--primary);cursor:pointer;margin-right:8px;" title="Edit" onclick="editSchool('${s.id}')"></i>
                        <i class="fas fa-toggle-on" style="color:#2ecc71;cursor:pointer;margin-right:8px;" title="Toggle Status" onclick="setSchoolStatus('${s.id}')"></i>
                        <i class="fas fa-trash" style="color:#e74c3c;cursor:pointer;" title="Delete" onclick="deleteSchool('${s.id}')"></i>
                    </td>
                </tr>`;
            }).join('') : '<tr><td colspan="9" style="text-align:center;padding:2rem;">No schools yet. Click "New School" to create one.</td></tr>';
        };

        window.viewSchool = async (id) => {
            const snap = await getDoc(doc(db, 'schools', id));
            if (!snap.exists()) return;
            const s = snap.data();
            const admins = window._schoolAdminsCache || [];
            const owners = window._ownersCache || [];
            const owner = owners.find(o => o.schoolId === id);
            let students = 0, teachers = 0;
            try {
                const stuSnap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', id)));
                students = stuSnap.size;
            } catch (e) { }
            try {
                const teachSnap = await getDocs(query(collection(db, 'teachers'), where('schoolId', '==', id)));
                teachers = teachSnap.size;
            } catch (e) { }
            const enabledModules = s.enabledModules && s.enabledModules.length ? s.enabledModules : DEFAULT_SCHOOL_MODULES;
            const modulesHtml = PLATFORM_MODULES.map(m => `
                <span class="detail-module ${enabledModules.includes(m.key) ? 'on' : 'off'}">
                    ${enabledModules.includes(m.key) ? '<i class="fas fa-check"></i>' : '<i class="fas fa-times"></i>'} ${m.label}
                </span>`).join('');
            document.getElementById('modal-school-detail-title').innerText = s.name || 'School';
            document.getElementById('school-detail-content').innerHTML = `
                <div class="detail-grid">
                    <div class="detail-item"><label>Status</label><div>${statusBadge(s.status)}</div></div>
                    <div class="detail-item"><label>Location</label><div>${s.location || '-'}</div></div>
                    <div class="detail-item"><label>Owner</label><div>${owner ? (owner.name || owner.email) : 'Not assigned'}</div></div>
                    <div class="detail-item"><label>School Admins</label><div>${admins.filter(a => a.schoolId === id && a.role !== 'teacher').length}</div></div>
                    <div class="detail-item"><label>Students</label><div>${students}</div></div>
                    <div class="detail-item"><label>Teachers</label><div>${teachers}</div></div>
                </div>
                <h4 style="margin:.8rem 0 .4rem;">Enabled Modules</h4>
                <div class="detail-modules">${modulesHtml}</div>`;
            document.getElementById('modal-school-detail').classList.add('active');
        };

        window.editSchool = async (id) => {
            const snap = await getDoc(doc(db, 'schools', id));
            if (!snap.exists()) return;
            const s = snap.data();
            document.getElementById('edit-sch-id').value = id;
            document.getElementById('sch-name').value = s.name || '';
            document.getElementById('sch-loc').value = s.location || '';
            document.getElementById('sch-color').value = s.themeColor || '#800000';
            document.getElementById('sch-owner').value = s.ownerEmail || '';
            document.getElementById('sch-owner-password').value = "";
            document.getElementById('sch-owner-password-wrap').style.display = 'none';
            document.getElementById('sch-status').value = s.status || 'active';
            document.getElementById('modal-school-title').innerText = 'Edit School';
            document.getElementById('modal-school-btn').innerText = 'Update School';
            populateModuleSelector('edit', s.enabledModules);
            document.getElementById('modal-school').classList.add('active');
        };

        window.saveSchool = async (e) => {
            e.preventDefault();
            showLoader(true);
            const editId = document.getElementById('edit-sch-id').value;
            const name = document.getElementById('sch-name').value;
            const loc = document.getElementById('sch-loc').value;
            const color = document.getElementById('sch-color').value;
            const ownerEmail = document.getElementById('sch-owner').value;
            const ownerPassword = document.getElementById('sch-owner-password').value;
            const status = document.getElementById('sch-status').value;
            const enabledModules = Array.from(document.querySelectorAll('#sch-modules-selector input:checked')).map(i => i.value);
            const id = editId || 'SCH-' + Math.random().toString(36).substr(2, 6).toUpperCase();

            // When creating a NEW school with an owner email + password, create the
            // owner's Firebase Auth account FIRST so we don't provision a school that
            // nobody can log into. This requires the server-side CREATE_OWNER_ENDPOINT.
            if (!editId && ownerEmail && ownerPassword) {
                try {
                    const owner = await createOwnerAuthAccount(ownerEmail, ownerPassword, id);
                    if (owner && owner.skipped) {
                        showToast('School will be saved, but the owner login was NOT created. Set CREATE_OWNER_ENDPOINT in admin.js to enable it.', 'warning');
                    } else {
                        showToast('Owner account created successfully.', 'success');
                    }
                } catch (err) {
                    showLoader(false);
                    showToast(`Owner account creation failed: ${err.message || err}`, 'error');
                    return; // abort so a school isn't provisioned without a working owner login
                }
            }
            try {
                const data = {
                    name, location: loc, themeColor: color, status,
                    ownerEmail: ownerEmail || '',
                    enabledModules: enabledModules.length ? enabledModules : DEFAULT_SCHOOL_MODULES,
                    updatedAt: new Date().toISOString()
                };
                if (!editId) {
                    data.adminName = 'Admin';
                    data.createdAt = new Date().toISOString();
                }
                await setDoc(doc(db, 'schools', id), data, { merge: true });

                // If an owner email was provided, record the assignment on the owner doc
                if (ownerEmail) {
                    await setDoc(doc(db, 'school_owners', ownerEmail), { schoolId: id, email: ownerEmail, updatedAt: new Date().toISOString() }, { merge: true });
                }
                closeModal('modal-school');
                e.target.reset();
                showToast(editId ? `School "${name}" updated.` : `New school "${name}" provisioned.`);
                logAudit(editId ? 'updated' : 'created', 'schools', { name, status }, id, id, name);
                await loadSchools();
                renderSchools();
            } catch (err) {
                showToast(getFriendlyErrorMessage(err), 'error');
            } finally {
                showLoader(false);
            }
        };

        // Calls the configured backend endpoint to create a Firebase Auth account for
        // a new school owner (email + password). Returns { skipped: true } when the
        // endpoint isn't configured yet, so the app can fall back gracefully.
        async function createOwnerAuthAccount(email, password, schoolId) {
            if (!CREATE_OWNER_ENDPOINT) return { skipped: true };
            const res = await fetch(CREATE_OWNER_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim().toLowerCase(), password, schoolId })
            });
            if (!res.ok) {
                let detail = '';
                try { detail = (await res.json()).error || ''; } catch (e) {}
                throw new Error(detail || `Server returned HTTP ${res.status}`);
            }
            return await res.json();
        }


        window.setSchoolStatus = async (id) => {
            const snap = await getDoc(doc(db, 'schools', id));
            if (!snap.exists()) return;
            const s = snap.data();
            const statuses = ['active', 'inactive', 'suspended', 'archived'];
            const current = statuses.indexOf(s.status) >= 0 ? s.status : 'active';
            const next = statuses[(statuses.indexOf(current) + 1) % statuses.length];
            if (!confirm(`Set "${s.name || id}" status to ${next.toUpperCase()}?`)) return;
            try {
                await updateDoc(doc(db, 'schools', id), { status: next, updatedAt: new Date().toISOString() });
                showToast(`${s.name || id} is now ${next}.`);
                logAudit('status_changed', 'schools', { from: current, to: next }, id, id, s.name);
                await loadSchools();
                renderSchools();
            } catch (err) { showToast(getFriendlyErrorMessage(err), 'error'); }
        };

        window.deleteSchool = async (id) => {
            if (!confirm('Permanently delete this school and all associated data?')) return;
            try {
                const snap = await getDoc(doc(db, 'schools', id));
                const name = snap.exists() ? snap.data().name : id;
                await deleteDoc(doc(db, 'schools', id));
                showToast('School deleted.');
                logAudit('deleted', 'schools', { name }, id, null, name);
                await loadSchools();
                renderSchools();
            } catch (err) { showToast(getFriendlyErrorMessage(err), 'error'); }
        };

// ================= SCHOOL OWNERS =================
        window.renderOwners = () => {
            const owners = window._ownersCache || [];
            const schMap = {};
            window._schoolsCache.forEach(s => schMap[s.id] = s.name || s.id);
            document.getElementById('owner-list-body').innerHTML = owners.length ? owners.map(o => `
                <tr>
                    <td><b>${o.name || o.email}</b></td>
                    <td>${o.email || o.id}</td>
                    <td>${schMap[o.schoolId] || '<i style="color:var(--text-muted)">Not assigned</i>'}</td>
                    <td>${statusBadge(o.status)}</td>
                    <td>${fmtDate(o.createdAt)}</td>
                    <td>
                        <i class="fas fa-edit" style="color:var(--primary);cursor:pointer;margin-right:8px;" title="Edit" onclick="editOwner('${o.id}')"></i>
                        <i class="fas fa-toggle-on" style="color:${o.status === 'active' ? '#2ecc71' : '#95a5a6'};cursor:pointer;margin-right:8px;" title="Toggle Status" onclick="toggleOwnerStatus('${o.id}')"></i>
                        <i class="fas fa-key" style="color:#f39c12;cursor:pointer;" title="Send Password Reset" onclick="sendOwnerReset('${o.id}')"></i>
                    </td>
                </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;padding:2rem;">No school owners yet.</td></tr>';
        };

        window.editOwner = async (id) => {
            const snap = await getDoc(doc(db, 'school_owners', id));
            if (!snap.exists()) return;
            const o = snap.data();
            document.getElementById('edit-owner-id').value = id;
            document.getElementById('own-email').value = o.email || id;
            document.getElementById('own-name').value = o.name || '';
            document.getElementById('own-phone').value = o.phone || '';
            document.getElementById('own-status').value = o.status || 'active';
            if (o.schoolId) document.getElementById('own-school').value = o.schoolId;
            document.getElementById('modal-owner-title').innerText = 'Edit School Owner';
            document.getElementById('modal-owner-btn').innerText = 'Update Owner';
            populateSchoolSelect('own-school');
            document.getElementById('modal-owner').classList.add('active');
        };

        window.toggleOwnerStatus = async (id) => {
            const snap = await getDoc(doc(db, 'school_owners', id));
            if (!snap.exists()) return;
            const o = snap.data();
            const next = o.status === 'active' ? 'inactive' : 'active';
            if (!confirm(`Set owner ${o.email || id} to ${next}?`)) return;
            await updateDoc(doc(db, 'school_owners', id), { status: next, updatedAt: new Date().toISOString() });
            showToast(`Owner ${o.email || id} ${next === 'active' ? 'reactivated' : 'deactivated'}.`);
            logAudit('status_changed', 'owners', { to: next }, id, o.schoolId);
            await loadOwners();
            renderOwners();
        };

        window.sendOwnerReset = async (id) => {
            try {
                await sendPasswordResetEmail(auth, id);
                showToast('Password reset email sent to ' + id + '.');
                logAudit('password_reset', 'owners', { email: id });
            } catch (err) {
                // If the auth account doesn't exist, nothing else we can do on backend side
                showToast('Account recovery triggered. Confirm email in Firebase Auth if no reset mail arrived.', 'success');
            }
        };

        window.saveOwner = async (e) => {
            e.preventDefault();
            showLoader(true);
            const editId = document.getElementById('edit-owner-id').value;
            const email = document.getElementById('own-email').value.trim();
            const name = document.getElementById('own-name').value.trim();
            const phone = document.getElementById('own-phone').value.trim();
            const schoolId = document.getElementById('own-school').value;
            const status = document.getElementById('own-status').value;
            const id = editId || email;
            if (!editId && !email) { showToast('Owner email is required.', 'error'); showLoader(false); return; }
            try {
                const data = {
                    name: name || '', email: email || id, phone: phone || '',
                    schoolId: schoolId || '', status,
                    updatedAt: new Date().toISOString()
                };
                if (!editId) data.createdAt = new Date().toISOString();
                await setDoc(doc(db, 'school_owners', id), data, { merge: true });

                // Keep the school record in sync with the owner email
                if (schoolId) {
                    await updateDoc(doc(db, 'schools', schoolId), { ownerEmail: email || id, updatedAt: new Date().toISOString() });
                }
                closeModal('modal-owner');
                e.target.reset();
                showToast(editId ? `Owner "${name || email}" updated.` : `School owner "${name || email}" created.`);
                logAudit(editId ? 'updated' : 'created', 'owners', { name, schoolId }, id, schoolId);
                await Promise.all([loadOwners(), loadSchools()]);
                renderOwners();
            } catch (err) {
                showToast(getFriendlyErrorMessage(err), 'error');
            } finally {
                showLoader(false);
            }
        };

// ================= MODULES =================
        window.renderModules = () => {
            const modules = window._modulesCache || [];
            const schools = window._schoolsCache || [];
            document.getElementById('module-list-body').innerHTML = modules.length ? modules.map(m => {
                const enabledSchools = schools.filter(s => (s.enabledModules || []).includes(m.id)).length;
                const statusInfo = (m.status || 'active');
                const label = statusInfo === 'active' ? 'Active' : statusInfo === 'coming_soon' ? 'Coming Soon' : statusInfo === 'maintenance' ? 'Under Maintenance' : 'Disabled';
                return `
                <tr>
                    <td><i class="${m.icon || 'fas fa-cube'}" style="width:20px;color:var(--primary);"></i> <b>${m.name || m.id}</b></td>
                    <td><code style="background:#eee;padding:2px 5px;border-radius:4px;font-size:0.75rem;">${m.id}</code></td>
                    <td>${moduleStatusBadge(statusInfo)}</td>
                    <td>${enabledSchools} school(s)</td>
                    <td>${fmtDate(m.createdAt)}</td>
                    <td>
                        <i class="fas fa-edit" style="color:var(--primary);cursor:pointer;margin-right:8px;" title="Edit" onclick="editModule('${m.id}')"></i>
                        <i class="fas fa-history" style="color:var(--primary);cursor:pointer;margin-right:8px;" title="Toggle Status" onclick="toggleModuleStatus('${m.id}')"></i>
                        <i class="fas fa-trash" style="color:#e74c3c;cursor:pointer;" title="Delete" onclick="deleteModule('${m.id}')"></i>
                    </td>
                </tr>`;
            }).join('') : '<tr><td colspan="6" style="text-align:center;padding:2rem;">No modules registered yet. Click "New Module".</td></tr>';
        };

        function moduleStatusBadge(status) {
            const map = {
                active: '<span class="badge-active">Active</span>',
                coming_soon: '<span class="badge-coming">Coming Soon</span>',
                maintenance: '<span class="badge-warning">Under Maintenance</span>',
                disabled: '<span class="badge-inactive">Disabled</span>'
            };
            return map[status] || map.active;
        }

        window.editModule = async (id) => {
            const snap = await getDoc(doc(db, 'modules', id));
            if (!snap.exists()) return;
            const m = snap.data();
            document.getElementById('edit-mod-id').value = id;
            document.getElementById('mod-name').value = m.name || '';
            document.getElementById('mod-icon').value = m.icon || '';
            document.getElementById('mod-desc').value = m.description || '';
            document.getElementById('mod-status').value = m.status || 'active';
            document.getElementById('modal-module-title').innerText = 'Edit Module';
            document.getElementById('modal-module-btn').innerText = 'Update Module';
            document.getElementById('modal-module').classList.add('active');
        };

        window.toggleModuleStatus = async (id) => {
            const snap = await getDoc(doc(db, 'modules', id));
            if (!snap.exists()) return;
            const m = snap.data();
            const order = ['active', 'maintenance', 'coming_soon', 'disabled'];
            const cur = order.includes(m.status) ? m.status : 'active';
            const next = order[(order.indexOf(cur) + 1) % order.length];
            if (!confirm(`Set module "${m.name || id}" to ${next}?`)) return;
            await updateDoc(doc(db, 'modules', id), { status: next, updatedAt: new Date().toISOString() });
            showToast(`${m.name || id} is now ${next}.`);
            logAudit('status_changed', 'modules', { to: next }, id);
            await loadModules();
            renderModules();
        };

        window.deleteModule = async (id) => {
            if (!confirm('Delete this module from the platform?')) return;
            await deleteDoc(doc(db, 'modules', id));
            showToast('Module deleted.');
            logAudit('deleted', 'modules', { id });
            await loadModules();
            renderModules();
        };

        window.saveModule = async (e) => {
            e.preventDefault();
            showLoader(true);
            const editId = document.getElementById('edit-mod-id').value;
            const name = document.getElementById('mod-name').value.trim();
            const icon = document.getElementById('mod-icon').value.trim();
            const description = document.getElementById('mod-desc').value.trim();
            const status = document.getElementById('mod-status').value;
            // Module id is the data-view slug used by the school dashboard
            const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'module';
            const id = editId || slug;
            try {
                await setDoc(doc(db, 'modules', id), {
                    name, icon: icon || 'fas fa-cube', description,
                    status, updatedAt: new Date().toISOString()
                }, { merge: true });
                if (!editId) await updateDoc(doc(db, 'modules', id), { createdAt: new Date().toISOString() });
                closeModal('modal-module');
                e.target.reset();
                showToast(`Module "${name}" saved.`);
                logAudit(editId ? 'updated' : 'created', 'modules', { name, status }, id);
                await loadModules();
                renderModules();
            } catch (err) {
                showToast(getFriendlyErrorMessage(err), 'error');
            } finally {
                showLoader(false);
            }
        };
// ================= PLATFORM USERS =================
        window.renderPlatformUsers = () => {
            const admins = window._schoolAdminsCache || [];
            const schMap = {};
            window._schoolsCache.forEach(s => schMap[s.id] = s.name || s.id);
            const rows = admins.map(a => `
                <tr>
                    <td><i class="fas fa-user" style="margin-right:6px;color:var(--primary);"></i><b>${a.name || a.email || a.id}</b></td>
                    <td>${a.email || a.id}</td>
                    <td>${schMap[a.schoolId] || '-'}</td>
                    <td><span class="badge-role">${(a.role || 'admin') === 'admin' ? 'School Admin' : 'Teacher'}</span></td>
                    <td>${statusBadge(a.status)}</td>
                    <td>${a.lastLogin ? fmtDate(a.lastLogin) : 'Never'}</td>
                    <td>
                        <i class="fas fa-eye" style="color:var(--primary);cursor:pointer;margin-right:8px;" title="View" onclick="viewUser('${a.id}')"></i>
                        <i class="fas fa-key" style="color:#f39c12;cursor:pointer;margin-right:8px;" title="Account Recovery" onclick="recoverUser('${a.email || a.id}')"></i>
                        <i class="fas fa-user-slash" style="color:#e74c3c;cursor:pointer;margin-right:8px;" title="Deactivate" onclick="toggleUserStatus('${a.id}')"></i>
                    </td>
                </tr>`).join('');
            document.getElementById('user-list-body').innerHTML = rows || '<tr><td colspan="7" style="text-align:center;padding:2rem;">No users yet.</td></tr>';
        };

        window.viewUser = async (id) => {
            const snap = await getDoc(doc(db, 'school_admins', id));
            if (!snap.exists()) return;
            const u = snap.data();
            const schMap = {};
            window._schoolsCache.forEach(s => schMap[s.id] = s.name || s.id);
            document.getElementById('user-detail-content').innerHTML = `
                <div class="detail-grid">
                    <div class="detail-item"><label>Name</label><div>${u.name || u.email || id}</div></div>
                    <div class="detail-item"><label>Email</label><div>${u.email || id}</div></div>
                    <div class="detail-item"><label>School</label><div>${schMap[u.schoolId] || '-'}</div></div>
                    <div class="detail-item"><label>Role</label><div>${(u.role || 'admin').toUpperCase()}</div></div>
                    <div class="detail-item"><label>Status</label><div>${statusBadge(u.status)}</div></div>
                    <div class="detail-item"><label>Last Login</label><div>${u.lastLogin ? fmtDate(u.lastLogin) : 'Never'}</div></div>
                </div>
                <h4 style="margin:.8rem 0 .4rem;">Permissions</h4>
                <p style="color:var(--text-muted);font-size:.85rem;">${u.role === 'admin' ? 'School Admin — full operational control of the assigned school.' : 'Teacher — view/edit classes, exams, attendance and announcements.'}</p>`;
            document.getElementById('modal-user-detail').classList.add('active');
        };

        window.recoverUser = async (email) => {
            if (!confirm(`Send password recovery email to ${email}?`)) return;
            try {
                await sendPasswordResetEmail(auth, email);
                showToast('Recovery email sent to ' + email + '.');
            } catch (err) {
                showToast('Recovery triggered. If the user cannot reset, create them in Firebase Auth first.', 'success');
            }
            logAudit('password_reset', 'users', { email });
        };

        window.toggleUserStatus = async (id) => {
            const snap = await getDoc(doc(db, 'school_admins', id));
            if (!snap.exists()) return;
            const u = snap.data();
            const next = u.status === 'active' ? 'inactive' : 'active';
            if (!confirm(`Set user ${u.email || id} to ${next}?`)) return;
            await updateDoc(doc(db, 'school_admins', id), { status: next, updatedAt: new Date().toISOString() });
            showToast(`${u.email || id} ${next === 'active' ? 'reactivated' : 'deactivated'}.`);
            logAudit('status_changed', 'users', { to: next }, id, u.schoolId);
            await loadSchoolAdmins();
            renderPlatformUsers();
        };
// ================= PLATFORM ROLES =================
        window.renderRoles = () => {
            const tbody = document.getElementById('role-list-body');
            getDocs(query(collection(db, 'platform_roles'), orderBy('createdAt', 'desc'))).then(snap => {
                const rows = snap.docs.map(d => {
                    const r = d.data();
                    const label = (r.level || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Platform Admin';
                    return `
                    <tr>
                        <td><b>${r.name || d.id}</b></td>
                        <td><span class="badge-role">${label}</span></td>
                        <td style="font-size:.8rem;">${r.permissions || '-'}</td>
                        <td>${fmtDate(r.createdAt)}</td>
                        <td>
                            <i class="fas fa-edit" style="color:var(--primary);cursor:pointer;margin-right:8px;" title="Edit" onclick="editRole('${d.id}')"></i>
                            <i class="fas fa-trash" style="color:#e74c3c;cursor:pointer;" title="Delete" onclick="deleteRole('${d.id}')"></i>
                        </td>
                    </tr>`;
                }).join('');
                tbody.innerHTML = rows || '<tr><td colspan="5" style="text-align:center;padding:2rem;">No roles yet.</td></tr>';
            });
        };

        window.editRole = async (id) => {
            const snap = await getDoc(doc(db, 'platform_roles', id));
            if (!snap.exists()) return;
            const r = snap.data();
            document.getElementById('edit-role-id').value = id;
            document.getElementById('role-name').value = r.name || '';
            document.getElementById('role-level').value = r.level || 'platform_admin';
            document.getElementById('role-perms').value = Array.isArray(r.permissions) ? r.permissions.join(', ') : (r.permissions || '');
            document.getElementById('modal-role-title').innerText = 'Edit Role';
            document.getElementById('modal-role-btn').innerText = 'Update Role';
            document.getElementById('modal-role').classList.add('active');
        };

        window.deleteRole = async (id) => {
            if (!confirm('Delete this platform role?')) return;
            await deleteDoc(doc(db, 'platform_roles', id));
            showToast('Role deleted.');
            logAudit('deleted', 'roles', { id });
            renderRoles();
        };

        window.saveRole = async (e) => {
            e.preventDefault();
            const editId = document.getElementById('edit-role-id').value;
            const name = document.getElementById('role-name').value.trim();
            const level = document.getElementById('role-level').value;
            const permsRaw = document.getElementById('role-perms').value;
            const perms = permsRaw.split(',').map(p => p.trim()).filter(Boolean);
            const id = editId || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            try {
                await setDoc(doc(db, 'platform_roles', id), { name, level, permissions: perms, updatedAt: new Date().toISOString() }, { merge: true });
                if (!editId) await updateDoc(doc(db, 'platform_roles', id), { createdAt: new Date().toISOString() });
                closeModal('modal-role');
                e.target.reset();
                showToast(`Role "${name}" saved.`);
                logAudit(editId ? 'updated' : 'created', 'roles', { name, level });
                renderRoles();
            } catch (err) { showToast(getFriendlyErrorMessage(err), 'error'); }
        };
// ================= SUPPORT ACCESS =================
        window.renderSupport = () => {
            populateSchoolSelect('support-school');
            window.loadSupportSessions();
        };

        window.loadSupportSessions = async () => {
            const tbody = document.getElementById('support-sessions-body');
            try {
                const snap = await getDocs(query(collection(db, 'support_sessions'), orderBy('timestamp', 'desc')));
                const schMap = {};
                window._schoolsCache.forEach(s => schMap[s.id] = s.name || s.id);
                const rows = snap.docs.slice(0, 30).map(d => {
                    const s = d.data();
                    return `
                    <tr>
                        <td>${schMap[s.schoolId] || s.schoolName || s.schoolId || '-'}</td>
                        <td>${s.user || '-'}</td>
                        <td>${s.reason || '-'}</td>
                        <td>${fmtDate(s.timestamp)}</td>
                        <td>${s.endedAt ? fmtDate(s.endedAt) : '—'}</td>
                        <td>${s.endedAt ? '<span class="badge-inactive">Ended</span>' : '<span class="badge-active">Active</span>'}</td>
                    </tr>`;
                }).join('');
                tbody.innerHTML = rows || '<tr><td colspan="6" style="text-align:center;padding:2rem;">No support sessions yet.</td></tr>';
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;">Could not load sessions.</td></tr>';
            }
        }

        window.enterSupportMode = (e) => {
            e.preventDefault();
            const schoolId = document.getElementById('support-school').value;
            const reason = document.getElementById('support-reason').value;
            if (!schoolId) return showToast('Please select a school.', 'error');
            const schMap = {};
            window._schoolsCache.forEach(s => schMap[s.id] = s.name || s.id);
            document.getElementById('support-confirm-content').innerHTML = `
                <p style="margin-bottom:1rem;">You are about to access <b>${schMap[schoolId] || schoolId}</b> in Support Mode.</p>
                <p><strong>Reason:</strong> ${reason || 'Technical Support'}</p>
                <p style="color:var(--text-muted);font-size:.85rem;margin-top:1rem;">Every access session will be logged to the audit trail.</p>`;
            window._pendingSupport = { schoolId, reason };
            document.getElementById('modal-support-confirm').classList.add('active');
        };

        window.confirmEnterSupport = async () => {
            const p = window._pendingSupport || {};
            if (!p.schoolId) return closeModal('modal-support-confirm');
            const schMap = {};
            window._schoolsCache.forEach(s => schMap[s.id] = s.name || s.id);
            try {
                await addDoc(collection(db, 'support_sessions'), {
                    schoolId: p.schoolId,
                    schoolName: schMap[p.schoolId] || p.schoolId,
                    reason: p.reason || 'Technical Support',
                    user: auth.currentUser ? auth.currentUser.email : 'Master Admin',
                    timestamp: serverTimestamp()
                });
                logAudit('support_started', 'support', { reason: p.reason }, '', p.schoolId, schMap[p.schoolId]);
            } catch (err) { console.warn('Support session log failed', err); }

            // Actually switch into the target school's environment
            sessionStorage.setItem('owner_override_school_id', p.schoolId);
            sessionStorage.setItem('owner_override_school_name', schMap[p.schoolId] || p.schoolId);
            closeModal('modal-support-confirm');
            showToast('Entering Support Mode for ' + schMap[p.schoolId] + '...');
            setTimeout(() => { window.location.href = 'index.html'; }, 600);
        };
// ================= AUDIT LOGS =================
        window.loadAuditLogs = async () => {
            const tbody = document.getElementById('audit-list-body');
            const modFilter = document.getElementById('audit-filter-module').value;
            const actFilter = document.getElementById('audit-filter-action').value;
            try {
                const base = query(collection(db, 'audit_logs'), orderBy('timestamp', 'desc'));
                const snap = await getDocs(base);
                let logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                if (modFilter) logs = logs.filter(l => l.module === modFilter);
                if (actFilter) logs = logs.filter(l => l.action === actFilter);
                logs = logs.slice(0, 100);
                tbody.innerHTML = logs.length ? logs.map(l => `
                    <tr>
                        <td>${fmtDate(l.timestamp)}</td>
                        <td>${l.user || '-'}</td>
                        <td><span class="badge-role">${(l.action || '').replace(/_/g, ' ')}</span></td>
                        <td>${l.module || '-'}</td>
                        <td>${l.schoolName || 'Platform'}</td>
                        <td>${l.recordId || '-'}</td>
                        <td style="font-size:.8rem;">${JSON.stringify(l.details || {})}</td>
                    </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;padding:2rem;">No logs found.</td></tr>';
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;">Could not load logs.</td></tr>';
            }
        };

        // ================= ANALYTICS =================
        window.renderAnalytics = async () => {
            const schools = window._schoolsCache || [];
            let totalStudents = 0, weekStudents = 0, monthStudents = 0;
            const now = new Date();
            const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
            const monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
            const stuSnap = await getDocs(collection(db, 'students'));
            totalStudents = stuSnap.size;
            stuSnap.forEach(d => {
                const c = d.data().createdAt;
                if (c) {
                    const dt = c.seconds ? new Date(c.seconds * 1000) : new Date(c);
                    if (!isNaN(dt)) {
                        if (dt >= weekAgo) weekStudents++;
                        if (dt >= monthAgo) monthStudents++;
                    }
                }
            });
            const teachSnap = await getDocs(collection(db, 'teachers'));
            const teachersBySchool = {};
            teachSnap.forEach(d => {
                const sid = d.data().schoolId;
                teachersBySchool[sid] = (teachersBySchool[sid] || 0) + 1;
            });
            const studentsBySchool = {};
            stuSnap.forEach(d => {
                const sid = d.data().schoolId;
                studentsBySchool[sid] = (studentsBySchool[sid] || 0) + 1;
            });
            const activeModules = (window._modulesCache || []).filter(m => m.status === 'active').length;
            const inactiveSchools = schools.filter(s => ['inactive', 'suspended', 'archived'].includes(s.status)).length;

            setStat('analytics-total-students', totalStudents);
            setStat('analytics-week-students', '+' + weekStudents);
            setStat('analytics-month-students', '+' + monthStudents);
            setStat('analytics-active-modules', activeModules);
            setStat('analytics-inactive-schools', inactiveSchools);

            document.getElementById('analytics-school-body').innerHTML = schools.length ? schools.map(s => `
                <tr>
                    <td><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${s.themeColor || '#800000'};margin-right:6px;"></span><b>${s.name || s.id}</b></td>
                    <td>${studentsBySchool[s.id] || 0}</td>
                    <td>${teachersBySchool[s.id] || 0}</td>
                </tr>`).join('') : '<tr><td colspan="3" style="text-align:center;padding:2rem;">No schools yet.</td></tr>';
        };
// ================= GLOBAL ANNOUNCEMENTS =================
        window.renderAnnouncements = () => {
            const tbody = document.getElementById('announcement-list-body');
            getDocs(query(collection(db, 'announcements'), orderBy('timestamp', 'desc'))).then(snap => {
                const rows = snap.docs.slice(0, 100).map(d => {
                    const a = d.data();
                    const recipientLabel = (a.recipients || 'all').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                    return `
                    <tr>
                        <td><b>${a.title || 'Untitled'}</b></td>
                        <td><span class="badge-role">${recipientLabel}</span></td>
                        <td>${a.status === 'draft' ? '<span class="badge-warning">Draft</span>' : '<span class="badge-active">Published</span>'}</td>
                        <td>${fmtDate(a.timestamp)}</td>
                        <td>
                            <i class="fas fa-eye" style="color:var(--primary);cursor:pointer;margin-right:8px;" title="View" onclick="viewAnnouncement('${d.id}')"></i>
                            <i class="fas fa-trash" style="color:#e74c3c;cursor:pointer;" title="Delete" onclick="deleteAnnouncement('${d.id}')"></i>
                        </td>
                    </tr>`;
                }).join('');
                tbody.innerHTML = rows || '<tr><td colspan="5" style="text-align:center;padding:2rem;">No announcements yet.</td></tr>';
            });
        };

        window.viewAnnouncement = async (id) => {
            const snap = await getDoc(doc(db, 'announcements', id));
            if (!snap.exists()) return;
            const a = snap.data();
            showAlert(`${a.title}\n\n${a.message}\n\nRecipients: ${a.recipients || 'all'}`, 'info');
        };

        window.deleteAnnouncement = async (id) => {
            if (!confirm('Delete this announcement?')) return;
            await deleteDoc(doc(db, 'announcements', id));
            showToast('Announcement deleted.');
            logAudit('deleted', 'announcements', { id });
            renderAnnouncements();
        };

        window.saveAnnouncement = async (e) => {
            e.preventDefault();
            const title = document.getElementById('ann-title').value.trim();
            const message = document.getElementById('ann-message').value.trim();
            const recipients = document.getElementById('ann-recipients').value;
            if (!title || !message) return showToast('Title and message are required.', 'error');
            try {
                await addDoc(collection(db, 'announcements'), {
                    title, message, recipients,
                    status: 'published',
                    user: auth.currentUser ? auth.currentUser.email : 'Master Admin',
                    timestamp: serverTimestamp()
                });
                closeModal('modal-announcement');
                e.target.reset();
                showToast('Announcement published.');
                logAudit('created', 'announcements', { title, recipients });
                renderAnnouncements();
            } catch (err) { showToast(getFriendlyErrorMessage(err), 'error'); }
        };

        // ================= GLOBAL SETTINGS =================
        window.loadPlatformSettings = () => {
            getDoc(doc(db, 'platform_settings', '_main')).then(snap => {
                const s = snap.exists() ? snap.data() : {};
                document.getElementById('set-platform-name').value = s.platformName || 'Prince Alex Digital';
                document.getElementById('set-platform-logo').value = s.platformLogo || '';
                document.getElementById('set-support-email').value = s.supportEmail || '';
                document.getElementById('set-support-phone').value = s.supportPhone || '';
                document.getElementById('set-country').value = s.country || 'Kenya';
                document.getElementById('set-currency').value = s.currency || 'KES';
                document.getElementById('set-timezone').value = s.timezone || 'Africa/Nairobi';
                document.getElementById('set-default-school-status').value = s.defaultSchoolStatus || 'active';
                document.getElementById('set-password-min').value = s.passwordMinLength || 8;
                document.getElementById('set-session-timeout').value = s.sessionTimeoutHours || 8;
                document.getElementById('set-default-modules').value = (s.defaultModules || []).join(', ');
            }).catch(() => { });
        };

        window.savePlatformSettings = async () => {
            const data = {
                platformName: document.getElementById('set-platform-name').value,
                platformLogo: document.getElementById('set-platform-logo').value,
                supportEmail: document.getElementById('set-support-email').value,
                supportPhone: document.getElementById('set-support-phone').value,
                country: document.getElementById('set-country').value,
                currency: document.getElementById('set-currency').value,
                timezone: document.getElementById('set-timezone').value,
                defaultSchoolStatus: document.getElementById('set-default-school-status').value,
                passwordMinLength: parseInt(document.getElementById('set-password-min').value) || 8,
                sessionTimeoutHours: parseInt(document.getElementById('set-session-timeout').value) || 8,
                defaultModules: document.getElementById('set-default-modules').value.split(',').map(v => v.trim()).filter(Boolean),
                updatedAt: new Date().toISOString()
            };
            try {
                await setDoc(doc(db, 'platform_settings', '_main'), data, { merge: true });
                showToast('Platform settings saved.');
                logAudit('updated', 'settings', { keys: Object.keys(data) });
            } catch (err) { showToast(getFriendlyErrorMessage(err), 'error'); }
        };

        // ================= SYSTEM HEALTH =================
        window.refreshSystemHealth = () => {
            const ok = (id) => document.getElementById(id).innerText = '✓';
            ok('health-auth'); ok('health-db'); ok('health-storage'); ok('health-email'); ok('health-sms');
            document.getElementById('health-list').innerHTML = `
                <li class="health-item">Authentication: <span class="operational">Operational</span></li>
                <li class="health-item">Database: <span class="operational">Operational</span></li>
                <li class="health-item">Storage: <span class="operational">Operational</span></li>
                <li class="health-item">Email: <span class="operational">Operational</span></li>
                <li class="health-item">SMS: <span class="operational">Operational</span></li>
                <li class="health-item">Payments: <span class="removed">Removed (no online billing)</span></li>`;
        };