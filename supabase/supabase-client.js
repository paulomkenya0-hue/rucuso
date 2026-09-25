// RucusoAPI — a thin wrapper around supabase-js.
// Load order in index.html must be:
//   1. https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2  (UMD build, exposes window.supabase)
//   2. config.js  (defines window.RUCUSO_CONFIG)
//   3. this file  (defines window.RucusoAPI)
(function () {
  if (!window.RUCUSO_CONFIG) {
    console.error("RUCUSO_CONFIG missing — copy supabase/config.example.js to supabase/config.js and fill in your Supabase URL/anon key.");
    return;
  }
  const { createClient } = window.supabase; // global from the UMD build
  const client = createClient(window.RUCUSO_CONFIG.SUPABASE_URL, window.RUCUSO_CONFIG.SUPABASE_ANON_KEY);

  window.RucusoAPI = {
    client,

    // ---------------- Auth (real admin accounts) ----------------
    async adminLogin(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const { data: profile, error: perr } = await client
        .from("profiles").select("*").eq("id", data.user.id).single();
      if (perr) throw perr;
      if (!profile.active) { await client.auth.signOut(); throw new Error("Account is disabled."); }
      return { user: data.user, profile };
    },
    async adminLogout() { await client.auth.signOut(); },
    async currentSession() {
      const { data: { session } } = await client.auth.getSession();
      if (!session) return null;
      const { data: profile } = await client.from("profiles").select("*").eq("id", session.user.id).single();
      return { user: session.user, profile };
    },

    // ---------------- Student verification ----------------
    // Calls the lookup_student() RPC (SECURITY DEFINER) — never selects
    // the students table directly, so the full registry stays private.
    async lookupStudent(regNumber) {
      const { data, error } = await client.rpc("lookup_student", { p_reg: regNumber });
      if (error) throw error;
      return data && data.length ? data[0] : null;
    },
    // Bulk import from the admin CSV screen. Uses upsert with
    // ignoreDuplicates so existing registration numbers are never
    // silently overwritten (matches the "never overwrite blindly" rule).
    async bulkUpsertStudents(rows) {
      const { data, error } = await client
        .from("students")
        .upsert(rows, { onConflict: "registration_number", ignoreDuplicates: true })
        .select();
      if (error) throw error;
      return data;
    },
    // Real OTP sending must happen server-side (Edge Function) so the SMS
    // provider's API key never reaches the browser. This calls a Supabase
    // Edge Function named "send-otp" that you deploy separately — see
    // supabase/edge-functions-README.md.
    async sendOtp(phoneNumber, studentRegNumber) {
      const { data, error } = await client.functions.invoke("send-otp", {
        body: { phone: phoneNumber, reg: studentRegNumber }
      });
      if (error) throw error;
      return data; // { ok: true } — the function itself stores the hashed OTP
    },
    async verifyOtp(phoneNumber, code) {
      const { data, error } = await client.functions.invoke("verify-otp", {
        body: { phone: phoneNumber, code }
      });
      if (error) throw error;
      return data; // { verified: true/false }
    },

    // ---------------- Feedback ----------------
    async submitFeedback(payload) {
      // payload: { reference_number, submission_type, category_id, title,
      //   description, priority, is_anonymous, student_id, student_name_snapshot, ... }
      const { data, error } = await client.from("feedback").insert(payload).select().single();
      if (error) throw error;
      return data;
    },
    // Uses the track_feedback() RPC — only returns the fields a student
    // is allowed to see, regardless of anonymity.
    async trackFeedback(ref) {
      const { data, error } = await client.rpc("track_feedback", { p_ref: ref });
      if (error) throw error;
      return data && data.length ? data[0] : null;
    },
    async listFeedback(filters = {}) {
      let q = client.from("feedback").select("*").order("created_at", { ascending: false });
      if (filters.status) q = q.eq("status", filters.status);
      if (filters.category_id) q = q.eq("category_id", filters.category_id);
      if (filters.ministry_id) q = q.eq("ministry_id", filters.ministry_id);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
    async updateFeedback(id, patch) {
      const { data, error } = await client.from("feedback").update(patch).eq("id", id).select().single();
      if (error) throw error;
      return data;
    },
    async addStatusHistory(feedback_id, old_status, new_status, changed_by) {
      const { error } = await client.from("feedback_status_history")
        .insert({ feedback_id, old_status, new_status, changed_by });
      if (error) throw error;
    },
    async addInternalNote(feedback_id, admin_id, note) {
      const { error } = await client.from("internal_notes").insert({ feedback_id, admin_id, note });
      if (error) throw error;
    },

    // ---------------- Reference data ----------------
    async listCategories() { const { data, error } = await client.from("categories").select("*").eq("active", true); if (error) throw error; return data; },
    async listMinistries() { const { data, error } = await client.from("ministries").select("*").eq("active", true); if (error) throw error; return data; },
    async listLeaders() { const { data, error } = await client.from("leaders").select("*").eq("active", true); if (error) throw error; return data; },
    async listServices() { const { data, error } = await client.from("student_services").select("*").eq("active", true); if (error) throw error; return data; },
    async listAnnouncements() {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await client.from("announcements").select("*")
        .lte("publish_date", today).order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
    async listDocuments() { const { data, error } = await client.from("documents").select("*").order("uploaded_at", { ascending: false }); if (error) throw error; return data; },

    // ---------------- Storage (photos, documents) ----------------
    async uploadFile(bucket, path, file) {
      const { data, error } = await client.storage.from(bucket).upload(path, file, { upsert: true });
      if (error) throw error;
      const { data: pub } = client.storage.from(bucket).getPublicUrl(data.path);
      return pub.publicUrl;
    },

    // ---------------- Audit log ----------------
    async logAction(actor_id, actor_label, action, details) {
      const { error } = await client.from("audit_logs").insert({ actor_id, actor_label, action, details });
      if (error) console.error("audit log write failed:", error);
    }
  };
})();
