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

  // ---------- Viungo Muhimu (Important Links) ----------
  //
  // Every URL below was read off an official RUCU / HESLB page. Nothing here is
  // invented: no guessed portal paths, no social accounts RUCU does not own.
  // A super admin can override or extend the list from
  // /admin/settings/ -> "Viungo Muhimu", which writes the same shape as JSON to
  // the system_settings row `important_links`. If that row is missing or
  // unreadable these defaults render, so the section is never empty.
  //
  // icon: one of the keys in ICON_SVGS below. Keep it a key, not markup, so a
  // settings value can never inject HTML into the public page.
  const DEFAULT_IMPORTANT_LINKS = [
    { label: "Tovuti ya Ruaha Catholic University", url: "https://www.rucu.ac.tz/", note: "Tovuti rasmi ya chuo —programu, nafasi za kuingia na taarifa zote.", icon: "university" },
    { label: "RUC SIMS", url: "https://sims.rucu.ac.tz/login", note: "Student Information Management System — kuingia kwa wanafunzi.", icon: "portal" },
    { label: "RUC E-Learning", url: "https://lms.rucu.ac.tz/", note: "Mfumo wa kujifunza mtandaoni (LMS) wa chuo.", icon: "study" },
    { label: "RUC E-Library", url: "https://library.rucu.ac.tz/", note: "Maktaba ya dijitali ya chuo — vitabu, machapisho na tafiti.", icon: "library" },
    { label: "HESLB — Tovuti Rasmi", url: "https://www.heslb.go.tz/", note: "Tovuti rasmi ya HESLB: taarifa za mikopo, magadi na maji.", icon: "bank" },
    { label: "HESLB Login (OLAMS)", url: "https://olas.heslb.go.tz/olams/account/login", note: "Kuingia kwenye mfumo rasmi wa HESLB. Si sehemu ya RUCUSO.", icon: "login" },
    { label: "Instagram ya RUCU", url: "https://www.instagram.com/rucu_iringa", note: "Akaunti rasmi ya Instagram ya Ruaha Catholic University.", icon: "instagram" },
    { label: "Facebook ya RUCU", url: "https://www.facebook.com/officialrucuiringa", note: "Ukurasa rasmi wa Facebook wa chuo.", icon: "facebook" },
    { label: "YouTube ya RUCU", url: "https://www.youtube.com/@ruahacatholicuniversity3072", note: "Kanzini rasmi ya YouTube ya chuo.", icon: "youtube" },
    { label: "Wasiliana na RUCU", url: "https://www.rucu.ac.tz/contact", note: "Anwani, simu na barua pepe ya chuo.", icon: "contact" },
    { label: "Wasiliana na RUCUSO", url: "#sec-contact", note: "Njia za msaada za moja kwa moja kupitia RUCUSO.", icon: "rucuso" },
  ];

  // Icons are a fixed lookup, not free text: settings can pick a key but can
  // never inject markup into the public page.
  const ICON_SVGS = {
    university: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h6"/>',
    portal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 13h4M7 16h7"/>',
    study: '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
    library: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>',
    bank: '<path d="M12 3v18M5 8h14M7 8l-4 8h8L7 8zm10 0l-4 8h8l-4-8zM8 21h8"/>',
    login: '<path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>',
    instagram: '<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5h.01"/>',
    facebook: '<path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/>',
    youtube: '<path d="M22.5 12s0-3.5-.45-5.15a2.6 2.6 0 00-1.83-1.84C18.55 4.5 12 4.5 12 4.5s-6.55 0-8.22.51A2.6 2.6 0 001.95 6.85 27 27 0 001.5 12a27 27 0 00.45 5.15 2.6 2.6 0 001.83 1.84c1.67.51 8.22.51 8.22.51s6.55 0 8.22-.51a2.6 2.6 0 001.83-1.84C22.5 15.5 22.5 12 22.5 12z"/><path d="M10 15.2V8.8l5.2 3.2z"/>',
    contact: '<path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012 4.2 2 2 0 014 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.1a2 2 0 012.1-.5c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z"/>',
    rucuso: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
  };

  // Only http(s) and in-page anchors are allowed through. This is the guard
  // against a bad settings value turning the section into a javascript: or
  // data: link, and it also stops "//evil.example" style protocol-relative
  // values from being rendered as if they were ours.
  function safeLinkUrl(url) {
    const raw = String(url == null ? "" : url).trim();
    if (!raw) return "";
    if (raw.charAt(0) === "#") return raw;
    if (!/^https?:\/\//i.test(raw)) return "";
    try {
      const parsed = new URL(raw);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function normalizeLinks(raw) {
    let list = raw;
    if (typeof raw === "string") {
      const text = raw.trim();
      if (!text) return null;
      try { list = JSON.parse(text); } catch { return null; }
    }
    if (!Array.isArray(list)) return null;
    const out = [];
    list.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const url = safeLinkUrl(item.url);
      const label = String(item.label || "").trim();
      if (!url || !label) return;
      out.push({
        label,
        url,
        note: String(item.note || "").trim(),
        icon: Object.prototype.hasOwnProperty.call(ICON_SVGS, item.icon) ? item.icon : "university",
      });
    });
    return out.length ? out : null;
  }

  const DB = {
    ready: false,
    adminLoaded: false,
    session: null,        // { uid, email, name, role }
    studentSession: null, // { reg, name, programme, year, phone, verifiedAt }
    categories: [],       // [{ id, name, active }]
    ministries: [],       // [{ id, name, description, active }]
    leaders: [],          // mapped to the shape the render functions use
    hierarchy: [],        // [{ tier_key, tier_label, tier_rank }] ordered
    positions: [],        // flat tier+position rows from leadership_hierarchy()
    services: [],
    announcements: [],
    documents: [],
    programmes: [],
    feedback: [],         // staff only
    staff: [],
    auditLog: [],
    studentCount: 0,
    // Current page of /admin/students/ results only — never the whole
    // table (see refreshStudentsFull below for why).
    studentsPage: { rows: [], count: 0, page: 1, pageSize: 100 },
    studentFilterOptions: { programmes: [], faculties: [], years: [] },
    contacts: { phone: "", email: "" },
    acadYear: "2026/2027",
    importantLinks: DEFAULT_IMPORTANT_LINKS, // Viungo Muhimu
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
      // Hierarchy, joined onto the row by public_leaders (migration 013). Absent
      // for staff, who read the leaders table directly - the admin screens get
      // this from positionsByTier() instead.
      tier_key: r.tier_key || null,
      tier_label: r.tier_label || "",
      tier_rank: r.tier_rank == null ? null : Number(r.tier_rank),
      position_label: r.position_label || "",
      position_rank: r.position_rank == null ? null : Number(r.position_rank),
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
    // Viungo Muhimu: the admin-configured list wins, otherwise the verified
    // defaults. A malformed or hostile settings value falls back silently
    // rather than emptying the section.
    DB.importantLinks = normalizeLinks(settings.important_links) || DEFAULT_IMPORTANT_LINKS;
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

  // ---------- leadership hierarchy ----------
  // The tiers and the posts inside them, ordered. Read once per public load and
  // kept on DB so the directory, the leader modal and the admin screens all
  // agree on wording and order.
  //
  // Failure here is not fatal on purpose: the public directory still renders, it
  // just falls back to the flat, ungrouped presentation. A structure table
  // should never be able to blank out the leadership page.
  async function refreshHierarchy() {
    try {
      const rows = await API.leadershipHierarchy();
      const seen = new Set();
      DB.hierarchy = (rows || [])
        .filter((r) => {
          if (seen.has(r.tier_key)) return false;
          seen.add(r.tier_key);
          return true;
        })
        .map((r) => ({
          tier_key: r.tier_key,
          tier_label: r.tier_label,
          tier_rank: Number(r.tier_rank) || 0,
        }))
        .sort((a, b) => a.tier_rank - b.tier_rank);
      // leadership_hierarchy() returns position_key / position_label /
      // position_rank; the tables those come from are leadership_positions.key /
      // .label_sw / .rank. Renamed once here so everything downstream can use the
      // column names, and so the two halves of the site (this file and
      // /admin/leaders/) agree on one shape.
      DB.positions = (rows || []).map((r) => ({
        key: r.position_key,
        label_sw: r.position_label,
        rank: Number(r.position_rank) || 0,
        tier_key: r.tier_key,
        ministry_required: r.ministry_required === true,
      }));
    } catch (e) {
      DB.hierarchy = [];
      DB.positions = [];
    }
  }
  // Label for a position key, from the hierarchy when it loaded.
  function positionLabel(key) {
    const hit = DB.positions.find((p) => p.key === key);
    return hit ? hit.label_sw : null;
  }
  // Every post, grouped by tier, for the admin pickers.
  function positionsByTier() {
    const tiers = DB.hierarchy.length
      ? DB.hierarchy
      : [{ tier_key: "executive", tier_label: "Uongozi wa Juu", tier_rank: 1 }];
    return tiers.map((t) => ({
      ...t,
      positions: DB.positions
        .filter((p) => p.tier_key === t.tier_key)
        .sort((a, b) => a.rank - b.rank),
    })).filter((t) => t.positions.length);
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
  // Vacancies are worked out from leadership_positions, not from a list typed
  // here. This used to hardcode the six standalone posts and three ministry
  // roles, which is a second copy of the structure: adding a post in the
  // database left it missing from this page, and the ministry vacancies it
  // invented were free text ("Waziri wa Uchelewa") that matched no position key
  // at all, so filling one created a leader the hierarchy could not label.
  //
  // A post is vacant when no leader holds that key. A post that requires a
  // ministry is tracked per ministry, because "Waziri" is filled once for every
  // ministry rather than once overall.
  function vacantSlots() {
    const filled = DB.leaders.filter((l) => l.name);
    const positions = DB.positions.length ? DB.positions : [];
    const out = [];

    positions.forEach((p) => {
      if (p.ministry_required) {
        DB.ministries.filter((m) => m.active).forEach((m) => {
          const taken = filled.some(
            (l) => l.position === p.key && (!l.ministry_id || l.ministry_id === m.id),
          );
          if (!taken) {
            out.push({
              position: p.key,
              position_label: p.label_sw,
              ministry: m.name,
              ministry_id: m.id,
              vacant: true,
            });
          }
        });
        return;
      }
      // ministry_required is false: a standalone post, filled by anyone.
      if (!filled.some((l) => l.position === p.key)) {
        out.push({
          position: p.key,
          position_label: p.label_sw,
          ministry: "",
          ministry_id: null,
          vacant: true,
        });
      }
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
    // Goes through the validated publish_announcement() RPC (migration 015),
    // which checks every field server-side and stamps the author from
    // auth.uid(). The direct insert it replaced left validation to the browser.
    await API.publishAnnouncement({
      title: a.title,
      description: a.description,
      category: a.category || null,
      audience: a.audience || "Wanafunzi Wote",
      publishDate: a.publishDate || new Date().toISOString().slice(0, 10),
      expiryDate: a.expiryDate || null,
    });
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
  // One page of the /admin/students/ management table, filtered and
  // counted entirely server-side (see supabase-client.js#listStudentsFull
  // for why this replaced loading the whole table into the browser).
  // `opts`: { page, pageSize, search, programme, faculty, year, status }
  async function refreshStudentsFull(opts = {}) {
    const result = await API.listStudentsFull(opts);
    DB.studentsPage = { rows: result.data, count: result.count, page: result.page, pageSize: result.pageSize };
  }
  async function refreshStudentFilterOptions() {
    DB.studentFilterOptions = await API.studentFilterOptions();
  }
  async function saveStudentFull(row, pageOpts) {
    await API.upsertStudent(row);
    await audit("Student Added/Updated", row.registration_number);
    await refreshStudents();
    await refreshStudentsFull(pageOpts);
  }
  async function setStudentStatus(id, status, label, pageOpts) {
    await API.setStudentStatus(id, status);
    await audit(status === "inactive" ? "Student Deactivated" : "Student Activated", label || String(id));
    await refreshStudentsFull(pageOpts);
  }
  async function deleteStudentRow(id, label, pageOpts) {
    await API.deleteStudent(id);
    await audit("Student Deleted", label || String(id));
    await refreshStudents();
    await refreshStudentsFull(pageOpts);
  }
  async function saveStudent(name, reg) {
    const parts = String(name).trim().split(/\s+/);
    const last = parts.length > 1 ? parts.pop() : parts[0] || "";
    const first = parts.shift() || "";
    await API.upsertStudent({ registration_number: reg, first_name: first, last_name: last });
    await audit("Student Added/Updated", reg);
    await refreshStudents();
  }
  // Every existing registration number, for CSV duplicate-detection
  // against the *whole* table (not just whatever page is on screen).
  async function fetchStudentRegistrationNumbers() {
    return await API.listStudentRegistrationNumbers();
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
      DEFAULT_IMPORTANT_LINKS,
      ICON_SVGS,
      normalizeLinks,
      errText, toast, loading,
    readUI, writeUI, loadStudentSession, saveStudentSession, purgePrototypeStorage,
    mapLeader, mapFeedback,
    loadPublic, loadAdmin, setSession, audit,
    refreshLeaders, saveLeader, toggleLeader, removeLeader, vacantSlots,
    refreshHierarchy, positionLabel, positionsByTier,
    refreshMinistries, saveMinistry, updateMinistryDetails, toggleMinistry, removeMinistry,
    refreshServices, saveService, toggleService, removeService,
    refreshAnnouncements, saveAnnouncement, removeAnnouncement,
    refreshDocuments, saveDocument, removeDocument,
    refreshStudents, saveStudent, importStudents, clearStudents,
    refreshStudentsFull, saveStudentFull, setStudentStatus, deleteStudentRow,
    refreshStudentFilterOptions, fetchStudentRegistrationNumbers,
    refreshCategories, saveCategory, removeCategory,
    refreshProgrammes, saveProgramme, removeProgramme,
    saveContacts, setAcadYear,
  };
})();