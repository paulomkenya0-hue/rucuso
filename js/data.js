// RucusoData — the application's data layer.
//
// Everything the app shows comes from Supabase. This file holds:
//   * DB            — an in-memory cache that the render functions read from
//   * loaders       — one per module, each fetching from Supabase
//   * mutators      — one per write, each writes to Supabase and then
//                     re-reads the affected rows so the UI can never drift
//   * the two localStorage keys left in the app, both of which are *not*
//     application data: the student's own verified session, and UI prefs
//
// There is no localStorage fallback. If Supabase is unreachable the user gets
// a clear message instead of quietly seeing yesterday's data.
(function () {
  const API = window.RucusoAPI;
  const KEY_STUDENT = "rucu_student_session_v1";
  const KEY_UI = "rucu_ui_v1";

  // Expected leadership positions. These are NOT stored in the database and
  // are NOT fake leaders: the admin list uses them to show which posts are
  // still unfilled, derived from the ministries that actually exist.
  const SINGULAR_POSITIONS = ["president", "vice_president", "secretary_general", "prime_minister", "prime_minister_secretary", "deputy_secretary_general"];
  const MINISTRY_ROLES = ["Waziri", "Naibu Waziri", "Katibu"];

  const DB = {
    ready: false,
    adminLoaded: false,
    session: null,        // { uid, email, name, role }
    studentSession: null, // { reg, name, programme, year, phone, verifiedAt }
    categories: [],       // [{ id, name, active }]
    ministries: [],       // [{ id, name, description, active }]
    leaders: [],          // mapped to the shape the render functions use
    services: [],
    announcements: [],
    documents: [],
    programmes: [],
    feedback: [],         // staff only
    staff: [],
    auditLog: [],
    studentCount: 0,
    studentsFull: [], // [{ id, registration_number, full_name, programme, faculty, department, year_of_study, academic_year, phone_number, email, gender, student_status }]
    contacts: { phone: "", email: "" },
    acadYear: "2026/2027",
  };

  // ---------- small helpers ----------
  const errText = (e) => (e && e.message) || "Hitilafu isiyotarajiwa.";

  function readUI() {
    try { return JSON.parse(localStorage.getItem(KEY_UI)) || {}; } catch { return {}; }
  }
  function writeUI(patch) {
    try {
      localStorage.setItem(KEY_UI, JSON.stringify(Object.assign(readUI(), patch)));
    } catch { /* private mode — prefs just won't persist */ }
  }
  function loadStudentSession() {
    try { return JSON.parse(localStorage.getItem(KEY_STUDENT)) || null; } catch { return null; }
  }
  function saveStudentSession(s) {
    try {
      if (s) localStorage.setItem(KEY_STUDENT, JSON.stringify(s));
      else localStorage.removeItem(KEY_STUDENT);
    } catch { /* ignore */ }
  }
  // The prototype stored every module under one 'rucu_v1' key, demo data
  // included. Nothing reads it any more, so it is dropped on first load rather
  // than left lying around in visitors' browsers.
  function purgePrototypeStorage() {
    try { localStorage.removeItem("rucu_v1"); } catch { /* ignore */ }
  }

  // ---------- loading states / feedback ----------
  function loading(el, text) {
    if (!el) return;
    el.innerHTML = `<p class="muted" style="padding:10px 0;">${text || "Inapakia..."} ⏳</p>`;
  }
  function toast(message, kind) {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      document.body.appendChild(t);
    }
    t.textContent = message;
    t.className = "toast " + (kind === "err" ? "err" : "ok");
    t.style.display = "block";
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.display = "none"; }, kind === "err" ? 6000 : 3500);
  }

  // ---------- row mapping ----------
  function mapLeader(r) {
    return {
      id: r.id,
      name: r.full_name,
      position: r.position,
      ministry: r.ministry || r.ministry_name || "",
      ministry_id: r.ministry_id || null,
      phone: r.phone_public || "",
      bio: r.bio || "",
      photo: r.photo_url || "",
      programme: r.programme || "",
      year: r.year_of_study || "",
      email: r.email || "",
      office: r.office_location || "",
      responsibilities: r.responsibilities || "",
      active: r.active !== false,
    };
  }
  function mapFeedback(r) {
    return {
      id: r.id,
      ref: r.reference_number,
      type: r.submission_type,
      category: r.category?.name || r.category_id || "—",
      category_id: r.category_id || null,
      title: r.title,
      desc: r.description,
      date: r.incident_date || "",
      loc: r.location || "",
      solution: r.suggested_solution || "",
      rating: r.satisfaction_rating || "",
      priority: r.priority,
      anonymous: !!r.is_anonymous,
      name: r.student_name_snapshot || "",
      reg: r.student_reg_snapshot || "",
      programme: r.student_programme || "",
      year: r.student_year || "",
      phone: r.student_phone || "",
      email: r.student_email || "",
      student_id: r.student_id || null,
      status: r.status,
      ministry: r.ministry?.name || "",
      ministry_id: r.ministry_id || null,
      assignedTo: r.assigned_to || "",
      assignedToName: r.assignee?.full_name || "",
      response: r.response || "",
      createdAt: r.created_at,
      resolvedAt: r.resolved_at || null,
    };
  }
  function mapService(r) {
    return { id: r.id, name: r.name, description: r.description || "", contact: r.contact || "", active: !!r.active };
  }
  function mapAnnouncement(r) {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      category: r.category || "",
      audience: r.audience || "Wanafunzi Wote",
      publishDate: r.publish_date || "",
      expiryDate: r.expiry_date || "",
      author: r.author?.full_name || "",
      author_id: r.author || null,
      image: r.image_url || "",
      createdAt: r.created_at,
    };
  }
  function mapDocument(r) {
    return {
      id: r.id,
      title: r.title,
      category: r.category || "",
      fileName: r.file_name || "",
      url: r.file_url,
      uploadedAt: r.uploaded_at,
      uploadedBy: r.uploaded_by || null,
    };
  }

  // ---------- public / shared loaders ----------
  async function loadPublic() {
    const [cats, mins, leaders, services, anns, docs, progs, settings] = await Promise.all([
      API.listCategories(),
      API.listMinistries(),
      API.listLeaders(),
      API.listServices(),
      API.listAnnouncements(),
      API.listDocuments(),
      API.listProgrammes(),
      API.getSettings(),
    ]);
    DB.categories = (cats || []).map((c) => ({ id: c.id, name: c.name, active: c.active }));
    DB.ministries = (mins || []).map((m) => ({ id: m.id, name: m.name, description: m.description || "", active: m.active }));
    DB.leaders = (leaders || []).map(mapLeader);
    DB.services = (services || []).map(mapService);
    DB.announcements = (anns || []).map(mapAnnouncement);
    DB.documents = (docs || []).map(mapDocument);
    DB.programmes = (progs || []).map((p) => ({ id: p.id, name: p.name }));
    DB.contacts = { phone: settings.contact_phone || "", email: settings.contact_email || "" };
    DB.acadYear = settings.academic_year || "2026/2027";
  }

  // ---------- admin loaders ----------
  async function loadAdmin() {
    const [feedback, staff, audit, allMins, allServices, allCats, count, leaders, anns] = await Promise.all([
      API.listFeedback(),
      API.listStaff(),
      API.listAudit(50),
      API.listAllMinistries(),
      API.listAllServices(),
      API.listAllCategories(),
      API.studentCount(),
      API.listAllLeaders(),
      API.listAllAnnouncements(),
    ]);
    DB.feedback = (feedback || []).map(mapFeedback);
    DB.staff = (staff || []).map((p) => ({ id: p.id, name: p.full_name, role: p.role }));
    DB.auditLog = (audit || []).map((a) => ({
      action: a.action, details: a.details, by: a.actor_label || "—", at: a.created_at,
    }));
    DB.ministries = (allMins || []).map((m) => ({ id: m.id, name: m.name, description: m.description || "", active: m.active }));
    DB.services = (allServices || []).map(mapService);
    DB.categories = (allCats || []).map((c) => ({ id: c.id, name: c.name, active: c.active }));
    DB.studentCount = Number(count || 0);
    DB.leaders = (leaders || []).map(mapLeader);
    DB.announcements = (anns || []).map(mapAnnouncement);
    DB.adminLoaded = true;
  }

  // ---------- session ----------
  async function setSession(session) {
    DB.session = session
      ? {
          uid: session.user.id,
          email: session.user.email,
          name: session.profile?.full_name || session.user.email,
          role: session.profile?.role || "officer",
        }
      : null;
    if (DB.session) await audit("Login", DB.session.email);
  }

  // ---------- audit ----------
  async function audit(action, details) {
    if (!API) return;
    await API.logAction(action, details || "", DB.session?.name || "System");
    if (DB.session) {
      DB.auditLog.unshift({ action, details: details || "", by: DB.session.name, at: new Date().toISOString() });
      if (DB.auditLog.length > 300) DB.auditLog.length = 300;
    }
  }

  // ---------- leaders ----------
  // Staff see the real table (inactive rows + private fields for the edit
  // form); everyone else sees the public view, which cannot leak them.
  async function refreshLeaders() {
    const rows = DB.session ? await API.listAllLeaders() : await API.listLeaders();
    DB.leaders = (rows || []).map(mapLeader);
  }
  async function saveLeader(form) {
    const payload = {
      full_name: form.name,
      position: form.position,
      ministry_id: form.ministry_id || null,
      phone_public: form.phone || null,
      bio: form.bio || null,
      photo_url: form.photo || null,
      programme: form.programme || null,
      year_of_study: form.year || null,
      email: form.email || null,
      office_location: form.office || null,
      responsibilities: form.responsibilities || null,
      active: !!form.active,
    };
    let row;
    if (form.id) {
      row = (await API.updateLeader(form.id, payload))[0];
      await audit("Leader Updated", payload.full_name + " — " + payload.position);
    } else {
      row = (await API.createLeader(payload))[0];
      await audit("Leader Created", payload.full_name + " — " + payload.position);
    }
    await refreshLeaders();
    return row;
  }
  async function toggleLeader(id, active) {
    await API.setLeaderActive(id, active);
    const l = DB.leaders.find((x) => x.id === id);
    await audit("Leader " + (active ? "Activated" : "Deactivated"), (l ? l.name : id) + " — " + (l ? l.position : ""));
    await refreshLeaders();
  }
  async function removeLeader(id) {
    const l = DB.leaders.find((x) => x.id === id);
    await API.deleteLeader(id);
    await audit("Leader Removed", l ? l.name + " — " + l.position : String(id));
    await refreshLeaders();
  }
  // Unfilled posts, derived from the real data. Nothing is written to the DB.
  function vacantSlots() {
    const filled = DB.leaders.filter((l) => l.name);
    const positionAliases = {
      "Rais": "president",
      "Makamu wa Rais": "vice_president",
      "Katibu Mkuu": "secretary_general",
      "Waziri Mkuu": "prime_minister",
      "Katibu wa Ofisi ya Waziri Mkuu": "prime_minister_secretary",
      "Naibu Katibu Mkuu": "deputy_secretary_general",
    };
    const out = [];
    SINGULAR_POSITIONS.forEach((pos) => {
      if (!filled.some((l) => l.position === pos || positionAliases[l.position] === pos)) {
        out.push({ position: pos, ministry: "", ministry_id: null, vacant: true });
      }
    });
    DB.ministries.filter((m) => m.active).forEach((m) => {
      MINISTRY_ROLES.forEach((role) => {
        const pos = `${role} wa ${m.name}`;
        if (!filled.some((l) => l.position === pos && (!l.ministry_id || l.ministry_id === m.id))) {
          out.push({ position: pos, ministry: m.name, ministry_id: m.id, vacant: true });
        }
      });
    });
    return out;
  }

  // ---------- ministries ----------
  async function refreshMinistries() {
    const rows = DB.session ? await API.listAllMinistries() : await API.listMinistries();
    DB.ministries = rows.map((m) => ({ id: m.id, name: m.name, description: m.description || "", active: m.active }));
  }
  async function saveMinistry(name, description) {
    const rows = await API.createMinistry({ name, description: description || null, active: true });
    await audit("Ministry Created", name);
    await refreshMinistries();
    return rows[0];
  }
  async function updateMinistryDetails(id, name, description) {
    await API.updateMinistry(id, { name, description: description || null });
    await audit("Ministry Updated", name);
    await refreshMinistries();
  }
  async function toggleMinistry(id, active) {
    await API.updateMinistry(id, { active });
    const m = DB.ministries.find((x) => x.id === id);
    await audit("Ministry " + (active ? "Enabled" : "Disabled"), m ? m.name : String(id));
    await refreshMinistries();
  }
  async function removeMinistry(id) {
    const m = DB.ministries.find((x) => x.id === id);
    await API.deleteMinistry(id);
    await audit("Ministry Removed", m ? m.name : String(id));
    await refreshMinistries();
    await refreshLeaders();
  }

  // ---------- services ----------
  async function refreshServices() {
    const rows = DB.session ? await API.listAllServices() : await API.listServices();
    DB.services = rows.map(mapService);
  }
  async function saveService(payload) {
    if (payload.id) {
      await API.updateService(payload.id, {
        name: payload.name, description: payload.description, contact: payload.contact, active: payload.active,
      });
      await audit("Service Updated", payload.name);
    } else {
      await API.createService({
        name: payload.name, description: payload.description || "", contact: payload.contact || "", active: !!payload.active,
      });
      await audit("Service Created", payload.name);
    }
    await refreshServices();
  }
  async function toggleService(id, active) {
    await API.updateService(id, { active });
    const s = DB.services.find((x) => x.id === id);
    await audit("Service " + (active ? "Enabled" : "Disabled"), s ? s.name : String(id));
    await refreshServices();
  }
  async function removeService(id) {
    const s = DB.services.find((x) => x.id === id);
    await API.deleteService(id);
    await audit("Service Removed", s ? s.name : String(id));
    await refreshServices();
  }

  // ---------- announcements ----------
  async function refreshAnnouncements() {
    const rows = DB.session ? await API.listAllAnnouncements() : await API.listAnnouncements();
    DB.announcements = rows.map(mapAnnouncement);
  }
  async function saveAnnouncement(a) {
    const payload = {
      title: a.title,
      description: a.description,
      category: a.category || null,
      audience: a.audience || "Wanafunzi Wote",
      publish_date: a.publishDate || new Date().toISOString().slice(0, 10),
      expiry_date: a.expiryDate || null,
      author: DB.session?.uid || null,
    };
    await API.createAnnouncement(payload);
    await audit("Announcement Published", a.title);
    await refreshAnnouncements();
  }
  async function removeAnnouncement(id) {
    const a = DB.announcements.find((x) => x.id === id);
    await API.deleteAnnouncement(id);
    await audit("Announcement Removed", a ? a.title : String(id));
    await refreshAnnouncements();
  }

  // ---------- documents ----------
  async function refreshDocuments() {
    DB.documents = (await API.listDocuments()).map(mapDocument);
  }
  async function saveDocument({ title, category, file }) {
    const safe = String(file.name).replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
    const url = await API.uploadFile(API.BUCKETS.documents, path, file);
    await API.createDocument({ title, category: category || null, file_url: url, file_name: file.name });
    await audit("Document Uploaded", title);
    await refreshDocuments();
    return url;
  }
  async function removeDocument(id) {
    const d = DB.documents.find((x) => x.id === id);
    await API.removeFile(API.BUCKETS.documents, d?.url);
    await API.deleteDocument(id);
    await audit("Document Removed", d ? d.title : String(id));
    await refreshDocuments();
  }

  // ---------- students ----------
  async function refreshStudents() {
    DB.studentCount = await API.studentCount();
  }
  // Full record set for /admin/students/ (search/filter/edit/deactivate).
  // Kept separate from refreshStudents() (which only tracks the count used
  // elsewhere) so pages that don't need the full registry stay cheap.
  async function refreshStudentsFull() {
    DB.studentsFull = await API.listStudentsFull();
  }
  async function saveStudentFull(row) {
    await API.upsertStudent(row);
    await audit("Student Added/Updated", row.registration_number);
    await refreshStudents();
    await refreshStudentsFull();
  }
  async function setStudentStatus(id, status, label) {
    await API.setStudentStatus(id, status);
    await audit(status === "inactive" ? "Student Deactivated" : "Student Activated", label || String(id));
    await refreshStudentsFull();
  }
  async function deleteStudentRow(id, label) {
    await API.deleteStudent(id);
    await audit("Student Deleted", label || String(id));
    await refreshStudents();
    await refreshStudentsFull();
  }
  async function saveStudent(name, reg) {
    const parts = String(name).trim().split(/\s+/);
    const last = parts.length > 1 ? parts.pop() : parts[0] || "";
    const first = parts.shift() || "";
    await API.upsertStudent({ registration_number: reg, first_name: first, last_name: last });
    await audit("Student Added/Updated", reg);
    await refreshStudents();
  }
  async function importStudents(rows) {
    if (!rows.length) return { added: 0 };
    const inserted = await API.bulkUpsertStudents(rows);
    await audit("Students CSV Import", "Waliotumwa: " + rows.length + ", walioingizwa: " + (inserted || []).length);
    await refreshStudents();
    return { added: (inserted || []).length };
  }
  async function clearStudents() {
    await API.deleteAllStudents();
    await audit("Students Registry Cleared", "Msimamizi alifuta taarifa zote za wanafunzi");
    await refreshStudents();
  }

  // ---------- categories / programmes / settings ----------
  async function refreshCategories() {
    const rows = DB.session ? await API.listAllCategories() : await API.listCategories();
    DB.categories = rows.map((c) => ({ id: c.id, name: c.name, active: c.active }));
  }
  async function saveCategory(name) {
    await API.createCategory(name);
    await audit("Category Created", name);
    await refreshCategories();
  }
  async function removeCategory(id) {
    const c = DB.categories.find((x) => x.id === id);
    await API.deleteCategory(id);
    await audit("Category Removed", c ? c.name : String(id));
    await refreshCategories();
  }
  async function refreshProgrammes() {
    DB.programmes = (await API.listProgrammes()).map((p) => ({ id: p.id, name: p.name }));
  }
  async function saveProgramme(name) {
    await API.createProgramme(name);
    await audit("Programme Created", name);
    await refreshProgrammes();
  }
  async function removeProgramme(id) {
    const p = DB.programmes.find((x) => x.id === id);
    await API.deleteProgramme(id);
    await audit("Programme Removed", p ? p.name : String(id));
    await refreshProgrammes();
  }
  async function saveContacts(phone, email) {
    await API.setSetting("contact_phone", phone);
    await API.setSetting("contact_email", email);
    DB.contacts = { phone, email };
    await audit("Contact Information Updated", phone + " / " + email);
  }
  async function setAcadYear(year) {
    await API.setSetting("academic_year", year);
    DB.acadYear = year;
    await audit("Academic Year Changed", year);
  }

  window.RucusoData = {
    DB,
    SINGULAR_POSITIONS,
    MINISTRY_ROLES,
    errText, toast, loading,
    readUI, writeUI, loadStudentSession, saveStudentSession, purgePrototypeStorage,
    mapLeader, mapFeedback,
    loadPublic, loadAdmin, setSession, audit,
    refreshLeaders, saveLeader, toggleLeader, removeLeader, vacantSlots,
    refreshMinistries, saveMinistry, updateMinistryDetails, toggleMinistry, removeMinistry,
    refreshServices, saveService, toggleService, removeService,
    refreshAnnouncements, saveAnnouncement, removeAnnouncement,
    refreshDocuments, saveDocument, removeDocument,
    refreshStudents, saveStudent, importStudents, clearStudents,
    refreshStudentsFull, saveStudentFull, setStudentStatus, deleteStudentRow,
    refreshCategories, saveCategory, removeCategory,
    refreshProgrammes, saveProgramme, removeProgramme,
    saveContacts, setAcadYear,
  };
})();
