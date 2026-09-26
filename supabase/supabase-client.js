// RucusoAPI — the only place that talks to Supabase.
//
// Load order in index.html must be:
//   1. https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2  (UMD build, exposes window.supabase)
//   2. supabase/config.js  (defines window.RUCUSO_CONFIG)
//   3. this file    (defines window.RucusoAPI)
//   4. js/data.js   (defines window.RucusoData — the app's data layer)
//
// Security notes:
//   * Only the anon/publishable key is ever used here. The service_role key
//     lives in Supabase secrets and is used by the OTP Edge Functions only.
//   * Every permission decision is made by RLS in the database, not by this
//     file. These functions never widen access; they only send requests.
//   * There is no localStorage fallback anywhere in this file. If Supabase is
//     unreachable the caller gets an error, never stale local data.
(function () {
  const cfg = window.RUCUSO_CONFIG;
  if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    console.error("RUCUSO_CONFIG missing or incomplete — see js/config.example.js.");
    window.RucusoAPI = null;
    return;
  }
  const { createClient } = window.supabase;
  const client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  // ---------- error translation (one Kiswahili message per failure mode) ----------
  const MESSAGES = {
    NETWORK: "Imeshindikana kuwasiliana na database. Tafadhali jaribu tena.",
    RLS: "Hakuna kibali cha kufanya kitendo hiki. Ingia kama msimamizi.",
    AUTH: "Muda wa kuingia umeisha. Tafadhali ingia tena.",
    PROFILE: "Akaunti hii haina profili ya msimamizi. Wasiliana na msimamizi mkuu.",
    DISABLED: "Akaunti hii imezimwa. Wasiliana na msimamizi mkuu.",
    BAD_LOGIN: "Barua pepe au nenosiri si sahihi.",
    DUPLICATE: "Rekodi hii tayari ipo.",
    NOT_FOUND: "Hakuna rekodi iliyopatikana.",
  };

  function friendlyError(err) {
    if (!err) return new Error("Hitilafu isiyotarajiwa.");
    const raw = `${err.message || err.code || err}`.trim();
    const code = err.code || "";
    // network / fetch failures
    if (/fetch|network|failed to fetch|load failed|timeout/i.test(raw) && !code) {
      return new Error(MESSAGES.NETWORK);
    }
    if (code === "42501" || /row-level security/i.test(raw)) return new Error(MESSAGES.RLS);
    if (/JWT expired|invalid JWT|AuthSessionMissing|session not found|token is expired/i.test(raw)) {
      return new Error(MESSAGES.AUTH);
    }
    if (code === "23505" || /duplicate key|already exists/i.test(raw)) return new Error(MESSAGES.DUPLICATE);
    if (code === "PGRST116" || /no rows found|0 rows/i.test(raw)) return new Error(MESSAGES.NOT_FOUND);
    if (code === "23503" || /foreign key|violates not-null|null value/i.test(raw)) {
      return new Error("Taarifa hazijapitika kikamilifu. Hakiki sehemu zote za lazima.");
    }
    const e = new Error(raw);
    e.raw = err;
    return e;
  }

  // unwrap PostgREST / function responses into data-or-throw
  function ok(res) {
    if (res.error) throw friendlyError(res.error);
    return res.data;
  }

  const BUCKETS = {
    documents: "rucu-documents",
    photos: "leader-photos",
    attachments: "feedback-attachments",
  };

  function pathFromPublicUrl(url) {
    if (!url) return null;
    const marker = "/object/public/";
    const i = url.indexOf(marker);
    if (i === -1) return null;
    return url.slice(i + marker.length);
  }

  const api = {
    client,
    BUCKETS,
    friendlyError,
    pathFromPublicUrl,

    // ---------------- Auth (real Supabase accounts, hashed passwords) ----------
    async adminLogin(email, password) {
      const { data, error } = await client.auth.signInWithPassword({
        email: String(email || "").trim(),
        password,
      });
      if (error) {
        throw /invalid login credentials/i.test(error.message)
          ? new Error(MESSAGES.BAD_LOGIN)
          : friendlyError(error);
      }
      const { data: profile, error: perr } = await client
        .from("profiles").select("*").eq("id", data.user.id).maybeSingle();
      if (perr) throw friendlyError(perr);
      if (!profile) {
        await client.auth.signOut();
        throw new Error(MESSAGES.PROFILE);
      }
      if (!profile.active) {
        await client.auth.signOut();
        throw new Error(MESSAGES.DISABLED);
      }
      return { user: data.user, profile };
    },

    // Leaders (and admins who prefer it) sign in with a username instead of
    // an email. Supabase Auth itself only ever takes email+password, so this
    // resolves the username to its auth email first via a security-definer
    // RPC that returns null for both "no such username" and "inactive
    // account" — the same response either way, so it can't be used to probe
    // which usernames exist.
    async usernameLogin(username, password) {
      const { data: email, error: rerr } = await client.rpc("resolve_login_email", {
        p_username: String(username || "").trim(),
      });
      if (rerr) throw friendlyError(rerr);
      if (!email) throw new Error(MESSAGES.BAD_LOGIN);
      return api.adminLogin(email, password);
    },

    async adminLogout() {
      await client.auth.signOut();
    },

    async currentSession() {
      const { data: { session } } = await client.auth.getSession();
      if (!session) return null;
      const { data: profile } = await client
        .from("profiles").select("*").eq("id", session.user.id).maybeSingle();
      return { user: session.user, profile };
    },

    onAuthChange(handler) {
      client.auth.onAuthStateChange((_event, session) => {
        // Yield first: anything the handler does with this client (signing out,
        // re-reading the profile) must not run inside the auth callback's lock.
        setTimeout(() => handler(session), 0);
      });
    },

    // ---------------- HESLB beneficiaries (RLS-authorized staff only) ----------
    async heslbBeneficiaryStats() {
      return ok(await client.rpc("heslb_beneficiary_stats"));
    },
    async heslbBeneficiaryYearStats() {
      return ok(await client.rpc("heslb_beneficiary_year_stats"));
    },
    async listHeslbBeneficiaries(filters = {}) {
      let query = client.from("heslb_beneficiaries").select(
        "full_name, index_number, phone, faculty, year_of_study, status, created_at, updated_at",
        { count: "exact" }
      ).order("full_name");
      if (filters.faculty) query = query.eq("faculty", filters.faculty);
      if (filters.year) query = query.eq("year_of_study", Number(filters.year));
      if (filters.status) query = query.eq("status", filters.status);
      const term = String(filters.search || "").replace(/[^\p{L}\p{N}\s/+\-]/gu, " ").trim();
      if (term) query = query.or(`full_name.ilike.%${term}%,index_number.ilike.%${term}%,phone.ilike.%${term}%`);
      const from = Math.max(0, Number(filters.from) || 0);
      const to = Math.max(from, Number(filters.to) || from + 49);
      const result = await query.range(from, to);
      if (result.error) throw friendlyError(result.error);
      return { data: result.data || [], count: result.count || 0 };
    },
    async listHeslbBeneficiaryKeys() {
      const rows = [];
      const pageSize = 1000;
      for (let from = 0; ; from += pageSize) {
        const page = ok(await client.from("heslb_beneficiaries")
          .select("index_number, phone").order("index_number").range(from, from + pageSize - 1));
        rows.push(...page);
        if (page.length < pageSize) return rows;
      }
    },
    async getHeslbBeneficiary(id) {
      return ok(await client.from("heslb_beneficiaries")
        .select("full_name, index_number, phone, faculty, year_of_study, status")
        .eq("index_number", id).single());
    },
    async saveHeslbBeneficiary(row) {
      const { recordKey, ...values } = row;
      const query = recordKey
        ? client.from("heslb_beneficiaries").update(values).eq("index_number", recordKey)
        : client.from("heslb_beneficiaries").insert(values);
      return ok(await query.select("index_number").single());
    },
    async importHeslbBeneficiaries(rows, updateExisting) {
      if (!rows.length) return [];
      const query = updateExisting
        ? client.from("heslb_beneficiaries").upsert(rows, { onConflict: "index_number" })
        : client.from("heslb_beneficiaries").insert(rows);
      return ok(await query.select("index_number"));
    },
    async verifyHeslbBeneficiary(indexNumber, phone) {
      const { data, error } = await client.functions.invoke("verify-heslb", {
        body: { index_number: indexNumber, phone },
      });
      if (error) throw friendlyError(error);
      return !!(data && data.verified === true);
    },

    // ---------------- Students ----------------
    // Public lookups go through the lookup_student() RPC; the students table
    // itself has no public read policy, so the registry stays private.
    async lookupStudent(regNumber) {
      const rows = await ok(await client.rpc("lookup_student", { p_reg: regNumber }));
      return rows && rows.length ? rows[0] : null;
    },
    // Temporary OTP-bypass path (see migration 006): confirms the phone
    // number on file matches, without ever exposing that phone number.
    // Returns null on any mismatch — caller cannot tell whether the
    // registration number or the phone number was the problem.
    async verifyStudentIdentity(regNumber, phone) {
      const rows = await ok(await client.rpc("verify_student_identity", { p_reg: regNumber, p_phone: phone }));
      return rows && rows.length ? rows[0] : null;
    },
    // student_count() returns a scalar, so PostgREST replies with a bare number.
    async studentCount() {
      return Number((await ok(await client.rpc("student_count"))) || 0);
    },
    async listStudents() {
      return ok(await client
        .from("students")
        .select("id, registration_number, first_name, middle_name, last_name, full_name, programme, year_of_study, phone_number, email")
        .order("registration_number"));
    },
    // Full column set for the /admin/students/ management table (search,
    // filter by faculty/programme/year/academic year, edit, deactivate).
    async listStudentsFull() {
      return ok(await client
        .from("students")
        .select("id, registration_number, first_name, middle_name, last_name, full_name, programme, faculty, department, year_of_study, academic_year, phone_number, email, gender, student_status")
        .order("registration_number")
        .limit(5000));
    },
    async setStudentStatus(id, status) {
      return ok(await client.from("students").update({ student_status: status }).eq("id", id).select());
    },
    async deleteStudent(id) {
      return ok(await client.from("students").delete().eq("id", id));
    },
    async upsertStudent(row) {
      return ok(await client.from("students").upsert(row, { onConflict: "registration_number" }).select());
    },
    async bulkUpsertStudents(rows) {
      if (!rows.length) return [];
      return ok(await client
        .from("students")
        .upsert(rows, { onConflict: "registration_number", ignoreDuplicates: true })
        .select());
    },
    async deleteAllStudents() {
      return ok(await client.from("students").delete().neq("id", "00000000-0000-0000-0000-000000000000"));
    },

    // ---------------- OTP (server-side Edge Functions) ----------------
    // sendOtp() and verifyOtp() only ever receive a status back. The code, the
    // hash and the SMS provider's key never leave the server.
    async sendOtp(phoneNumber, studentRegNumber) {
      return ok(await client.functions.invoke("send-otp", {
        body: { phone: phoneNumber, reg: studentRegNumber },
      }));
    },
    async verifyOtp(phoneNumber, code) {
      return ok(await client.functions.invoke("verify-otp", {
        body: { phone: phoneNumber, code },
      }));
    },

    // ---------------- RUCUSO AI ----------------
    // The question goes to the rucuso-ai Edge Function, which holds the AI
    // provider's key and decides server-side what data the caller may see.
    // Nothing here needs a key of its own, and no private data is fetched by
    // the browser to answer a question.
    async askAI(question, history, view) {
      const res = await client.functions.invoke("rucuso-ai", {
        body: { question, history: history || [], view: view || null },
      });
      if (res.error) {
        // A non-2xx reply carries our own JSON body; pull the Kiswahili
        // message out of it instead of showing a generic gateway error.
        let body = null;
        try {
          body = await res.error.context.json();
        } catch (_) { /* no structured body */ }
        const message = (body && (body.message || body.error)) || "";
        const e = new Error(message || MESSAGES.NETWORK);
        e.code = (body && body.error) || "";
        e.raw = res.error;
        throw e;
      }
      return res.data;
    },

    // ---------------- Feedback ----------------
    // Public submissions go through submit_feedback(): it mints the reference
    // number, enforces anonymity and blocks duplicate spam inside the database.
    async submitFeedback(payload) {
      const ref = await ok(await client.rpc("submit_feedback", payload));
      return ref;
    },
    async trackFeedback(ref) {
      const rows = await ok(await client.rpc("track_feedback", { p_ref: ref }));
      return rows && rows.length ? rows[0] : null;
    },
    async listFeedback(filters = {}) {
      let q = client
        .from("feedback")
        .select("*, category:categories(name), ministry:ministries(name), assignee:profiles(full_name)")
        .order("created_at", { ascending: false });
      if (filters.status) q = q.eq("status", filters.status);
      if (filters.category_id) q = q.eq("category_id", filters.category_id);
      if (filters.ministry_id) q = q.eq("ministry_id", filters.ministry_id);
      return ok(await q);
    },
    async getFeedback(id) {
      const rows = await ok(await client
        .from("feedback")
        .select("*, category:categories(name), ministry:ministries(name), assignee:profiles(full_name)")
        .eq("id", id).limit(1));
      return rows && rows.length ? rows[0] : null;
    },
    async updateFeedback(id, patch) {
      return ok(await client
        .from("feedback")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id).select());
    },
    async addStatusHistory(feedback_id, old_status, new_status) {
      const { data: { user } } = await client.auth.getUser();
      return ok(await client.from("feedback_status_history")
        .insert({ feedback_id, old_status, new_status, changed_by: user?.id ?? null }));
    },
    async listStatusHistory(feedback_id) {
      return ok(await client
        .from("feedback_status_history")
        .select("*, who:profiles(full_name)")
        .eq("feedback_id", feedback_id).order("created_at"));
    },
    async addInternalNote(feedback_id, note) {
      const { data: { user } } = await client.auth.getUser();
      return ok(await client.from("internal_notes")
        .insert({ feedback_id, admin_id: user?.id ?? null, note }));
    },
    async listInternalNotes(feedback_id) {
      return ok(await client
        .from("internal_notes")
        .select("*, who:profiles(full_name)")
        .eq("feedback_id", feedback_id).order("created_at"));
    },
    async listAttachments(feedback_id) {
      return ok(await client.from("attachments").select("*").eq("feedback_id", feedback_id));
    },

    // ---------------- Reference data ----------------
    async listCategories() {
      return ok(await client.from("categories").select("*").eq("active", true).order("name"));
    },
    async listAllCategories() {
      return ok(await client.from("categories").select("*").order("name"));
    },
    async createCategory(name) {
      return ok(await client.from("categories").insert({ name }).select());
    },
    async updateCategory(id, patch) {
      return ok(await client.from("categories").update(patch).eq("id", id).select());
    },
    async deleteCategory(id) {
      return ok(await client.from("categories").delete().eq("id", id));
    },

    async listMinistries() {
      return ok(await client.from("ministries").select("*").eq("active", true).order("name"));
    },
    async listAllMinistries() {
      return ok(await client.from("ministries").select("*").order("name"));
    },
    async createMinistry(payload) {
      return ok(await client.from("ministries").insert(payload).select());
    },
    async updateMinistry(id, patch) {
      return ok(await client.from("ministries").update(patch).eq("id", id).select());
    },
    async deleteMinistry(id) {
      return ok(await client.from("ministries").delete().eq("id", id));
    },

    async listStaff() {
      return ok(await client
        .from("profiles").select("id, full_name, role, ministry_id, active")
        .eq("active", true).order("full_name"));
    },

    // ---------------- Leaders ----------------
    // Frontend names map to columns like this:
    //   name -> full_name | phone -> phone_public | photo -> photo_url
    //   ministry (name) -> ministry_id           | active -> active
    // Anonymous visitors cannot select from `leaders` at all (that would expose
    // registration_number and phone_private) — they read public_leaders.
    // Public directory. Always the view, never the base table: the table has
    // private columns (registration_number, phone_private) and RLS cannot
    // hide columns, only rows.
    async listLeaders() {
      return ok(await client.from("public_leaders").select("*").order("created_at"));
    },
    // Admin screens only - the base table, including inactive rows and the
    // private fields the edit form needs. RLS allows this for staff only.
    async listAllLeaders() {
      return ok(
        await client.from("leaders").select("*, ministry:ministries(name)").order("created_at")
      );
    },
    async createLeader(payload) {
      return ok(await client.from("leaders").insert(payload).select());
    },
    async updateLeader(id, payload) {
      return ok(await client.from("leaders").update(payload).eq("id", id).select());
    },
    async setLeaderActive(id, active) {
      return ok(await client.from("leaders").update({ active }).eq("id", id).select());
    },
    async deleteLeader(id) {
      return ok(await client.from("leaders").delete().eq("id", id));
    },

    // ---------------- Student services ----------------
    async listServices() {
      return ok(await client.from("student_services").select("*").eq("active", true).order("name"));
    },
    async listAllServices() {
      return ok(await client.from("student_services").select("*").order("name"));
    },
    async createService(payload) {
      return ok(await client.from("student_services").insert(payload).select());
    },
    async updateService(id, patch) {
      return ok(await client.from("student_services").update(patch).eq("id", id).select());
    },
    async deleteService(id) {
      return ok(await client.from("student_services").delete().eq("id", id));
    },

    // ---------------- Announcements ----------------
    // RLS already hides anything not yet published or already expired, so the
    // public list needs no date filter here.
    async listAnnouncements() {
      return ok(await client
        .from("announcements")
        .select("*, author:profiles(full_name)")
        .order("created_at", { ascending: false }));
    },
    async listAllAnnouncements() {
      return ok(await client
        .from("announcements")
        .select("*, author:profiles(full_name)")
        .order("created_at", { ascending: false }));
    },
    async createAnnouncement(payload) {
      return ok(await client.from("announcements").insert(payload).select());
    },
    async updateAnnouncement(id, patch) {
      return ok(await client.from("announcements").update(patch).eq("id", id).select());
    },
    async deleteAnnouncement(id) {
      return ok(await client.from("announcements").delete().eq("id", id));
    },

    // ---------------- Documents ----------------
    async listDocuments() {
      return ok(await client.from("documents").select("*").order("uploaded_at", { ascending: false }));
    },
    async createDocument(payload) {
      return ok(await client.from("documents").insert(payload).select());
    },
    async deleteDocument(id) {
      return ok(await client.from("documents").delete().eq("id", id));
    },

    // ---------------- Settings ----------------
    async getSettings() {
      const rows = await ok(await client.from("system_settings").select("*"));
      const out = {};
      (rows || []).forEach((r) => { out[r.key] = r.value; });
      return out;
    },
    async setSetting(key, value) {
      return ok(await client.from("system_settings")
        .upsert({ key, value }, { onConflict: "key" }).select());
    },

    // ---------------- Programmes ----------------
    async listProgrammes() {
      return ok(await client.from("programmes").select("*").order("name"));
    },
    async createProgramme(name) {
      return ok(await client.from("programmes").insert({ name }).select());
    },
    async deleteProgramme(id) {
      return ok(await client.from("programmes").delete().eq("id", id));
    },

    // ---------------- Storage ----------------
    // Public buckets (documents, leader photos): upload returns a shareable URL.
    async uploadFile(bucket, path, file) {
      const { error } = await client.storage.from(bucket).upload(path, file, { upsert: true });
      if (error) throw friendlyError(error);
      const { data: pub } = client.storage.from(bucket).getPublicUrl(path);
      return pub.publicUrl;
    },
    // Private bucket (feedback evidence): returns a path, read it with
    // signedUrl() — only staff can.
    async uploadPrivateFile(bucket, path, file) {
      const { error } = await client.storage.from(bucket).upload(path, file, { upsert: false });
      if (error) throw friendlyError(error);
      return path;
    },
    async signedUrl(bucket, path, seconds = 600) {
      const { data, error } = await client.storage.from(bucket).createSignedUrl(path, seconds);
      if (error) throw friendlyError(error);
      return data.signedUrl;
    },
    async removeFile(bucket, pathOrUrl) {
      const path = pathOrUrl.startsWith("http") ? pathFromPublicUrl(pathOrUrl) : pathOrUrl;
      if (!path) return;
      const { error } = await client.storage.from(bucket).remove([path]);
      if (error) console.warn("storage remove failed:", error.message);
    },

    // ---------------- Audit log ----------------
    // Two paths on purpose:
    //   logAction()       — staff, writes audit_logs directly (RLS allows it)
    //   logPublicAction() — anonymous visitors; audit_logs has no public INSERT
    //                       policy on purpose, so a whitelisted RPC is used and
    //                       it can only ever record the student verification.
    async logPublicAction(action, details) {
      const { error } = await client.rpc("log_public_action", {
        p_action: action,
        p_details: details,
      });
      if (error) console.warn("audit write failed:", error.message);
    },
    async logAction(action, details, actorLabel) {
      const { data: { user } } = await client.auth.getUser();
      const { error } = await client.from("audit_logs").insert({
        actor_id: user?.id ?? null,
        actor_label: actorLabel || user?.email || "System",
        action,
        details: details || null,
      });
      if (error) console.warn("audit log write failed:", error.message);
    },
    async listAudit(limit = 50) {
      return ok(await client
        .from("audit_logs").select("*").order("created_at", { ascending: false }).limit(limit));
    },
  };

  window.RucusoAPI = api;
})();
