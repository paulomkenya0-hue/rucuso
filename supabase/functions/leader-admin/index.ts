// RUCUSO — leader-admin
//
// The ONLY way a leader account is created, has its password reset, or is
// deactivated/deleted. Every action requires the caller to be an active
// SUPER_ADMIN (checked server-side via requireSuperAdmin — never trust a
// role claim sent from the browser). Runs with the service role key, so it
// can call supabase.auth.admin.* which the browser's anon/authenticated
// clients cannot.
//
// POST body: { action: "list" | "create" | "reset_password" | "deactivate" | "activate" | "delete", ...fields }
//
// Secrets required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (both are
// provided automatically to every Supabase Edge Function).

import { json, preflight, readJson, getSupabase } from "../_shared/otp.ts";
import { requireSuperAdmin, isResponse, logAudit, generateTempPassword } from "../_shared/admin.ts";

// The valid positions live in leadership_positions (migration 013), not here.
// These constants used to be a hand-typed copy of that list, which is how the
// list in the admin form and the list enforced by the function drifted apart —
// both had to be edited in two places to add a post.
//
// Validation is now done against the table, so a post added by a super admin
// works here immediately. The database also enforces it: profiles.position is a
// foreign key, so an unknown key cannot be stored at all.
async function isKnownPosition(supabase: any, position: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("leadership_positions")
    .select("key")
    .eq("key", position)
    .maybeSingle();
  return !error && !!data;
}

// A post that belongs to a ministry must be filed against one. Previously this
// was decided by a hardcoded STANDALONE_POSITIONS set; now the table says
// which posts need a ministry, and the same rule is enforced by a trigger in
// migration 013, so the two cannot disagree.
async function ministryRequiredFor(supabase: any, position: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("leadership_positions")
    .select("ministry_required")
    .eq("key", position)
    .maybeSingle();
  if (error || !data) return false;
  return data.ministry_required === true;
}

// deno-lint-ignore no-explicit-any
async function handle(req: Request): Promise<Response> {
  const early = preflight(req);
  if (early) return early;

  const supabase = getSupabase();
  const caller = await requireSuperAdmin(req, supabase);
  if (isResponse(caller)) return caller;

  const body = await readJson(req);
  const action = typeof body.action === "string" ? body.action : "";

  switch (action) {
    case "list":           return await listLeaders(req, supabase);
    case "create":       return await createLeader(req, supabase, caller, body);
    case "reset_password": return await resetPassword(req, supabase, caller, body);
    case "deactivate":   return await setActive(req, supabase, caller, body, false);
    case "activate":     return await setActive(req, supabase, caller, body, true);
    case "delete":       return await deleteLeader(req, supabase, caller, body);
    default:             return json(req, { error: "UNKNOWN_ACTION" }, 400);
  }
}

// Lists every leader account with the directory details a super admin needs.
//
// The admin page has always asked for { action: "list" }, but no such case
// existed in this switch — every call came back UNKNOWN_ACTION and the page
// showed the error instead of the table. Adding the case here is what makes
// /admin/leaders/ usable at all.
async function listLeaders(req: Request, supabase: any): Promise<Response> {
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, full_name, username, position, ministry_id, active, must_change_password, leader_id")
    .eq("role", "leader")
    .order("full_name", { ascending: true });

  if (error) return json(req, { error: "LIST_FAILED" }, 500);

  // Directory fields and labels come from the leaders table plus the hierarchy.
  // position_label and ministry_name are resolved here so the browser does not
  // have to keep its own copy of the labels (see POSITION_FALLBACK_LABELS in
  // admin/leaders/index.html, which is only a fallback for unknown keys).
  const { data: leaderRows } = await supabase
    .from("leaders")
    .select("id, full_name, position, ministry_id, active, public_visible");

  const { data: ministries } = await supabase
    .from("ministries")
    .select("id, name");

  const { data: positions } = await supabase
    .from("leadership_positions")
    .select("key, label_sw, tier_key, rank, ministry_required");

  const { data: tiers } = await supabase
    .from("leadership_tiers")
    .select("key, label_sw, rank");

  const ministryName = new Map((ministries || []).map((m: any) => [m.id, m.name]));
  const positionInfo = new Map((positions || []).map((p: any) => [p.key, p]));
  const tierInfo = new Map((tiers || []).map((t: any) => [t.key, t]));

  // The directory row is looked up by leader_id where the profile carries one,
  // and by full name otherwise, so an account created before the two were
  // linked still shows its position and ministry.
  const directoryById = new Map((leaderRows || []).map((l: any) => [l.id, l]));
  const directoryByName = new Map(
    (leaderRows || []).map((l: any) => [String(l.full_name || "").trim().toLowerCase(), l]),
  );

  const leaders = (profiles || []).map((p: any) => {
    const dir = (p.leader_id && directoryById.get(p.leader_id))
      || directoryByName.get(String(p.full_name || "").trim().toLowerCase());
    const position = p.position || (dir && dir.position) || null;
    const info = position ? positionInfo.get(position) : null;
    const tier = info ? tierInfo.get(info.tier_key) : null;
    return {
      profile_id: p.id,
      full_name: p.full_name,
      username: p.username || null,
      position,
      position_label: info ? info.label_sw : null,
      ministry_required: info ? info.ministry_required === true : false,
      tier_key: info ? info.tier_key : null,
      tier_label: tier ? tier.label_sw : null,
      tier_rank: tier ? Number(tier.rank) : null,
      position_rank: info ? Number(info.rank) : null,
      ministry_name: p.ministry_id ? (ministryName.get(p.ministry_id) || null) : null,
      active: p.active !== false,
      must_change_password: p.must_change_password === true,
      // leaders.active is the directory's own switch; an account can be usable
      // for login while the person is not listed publicly.
      leader_active: dir ? dir.active !== false : null,
      public_visible: dir ? dir.public_visible !== false : null,
    };
  });

  return json(req, { leaders });
}

async function createLeader(req: Request, supabase: any, caller: { id: string; full_name: string }, body: Record<string, unknown>) {
  const full_name = String(body.full_name ?? "").trim();
  const position = String(body.position ?? "").trim();
  let ministry_id = body.ministry_id ? String(body.ministry_id) : null;
  const username = String(body.username ?? "").trim();
  const phone_number = body.phone_number ? String(body.phone_number).trim() : null;
  const email = body.email ? String(body.email).trim().toLowerCase() : "";
  const programme = body.programme ? String(body.programme).trim() : null;
  const year_of_study = body.year_of_study ? String(body.year_of_study).trim() : null;
  const bio = body.biography ? String(body.biography).trim() : null;
  const photo_url = body.photo_url ? String(body.photo_url).trim() : null;
  const public_visible = body.public_visibility !== false;
  const active = body.active_status !== false;

  if (!full_name) return json(req, { error: "FULL_NAME_REQUIRED" }, 400);
  if (!(await isKnownPosition(supabase, position))) return json(req, { error: "INVALID_POSITION" }, 400);
  // A post that belongs to a ministry cannot be created without one; a post
  // that does not is filed against no ministry at all, rather than accepting
  // whatever the browser happened to send.
  if (await ministryRequiredFor(supabase, position)) {
    if (!ministry_id) return json(req, { error: "MINISTRY_REQUIRED" }, 400);
  } else {
    ministry_id = null;
  }
  if (!/^[a-z0-9._-]{3,32}$/i.test(username)) {
    return json(req, { error: "INVALID_USERNAME" }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(req, { error: "VALID_EMAIL_REQUIRED" }, 400);
  }

  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .ilike("username", username)
    .maybeSingle();
  if (existing) return json(req, { error: "USERNAME_TAKEN" }, 409);

 const initialPassword = generateTempPassword();

const { data: created, error: createErr } =
  await supabase.auth.admin.createUser({
    email,
    password: initialPassword,
    email_confirm: true,
  });

  if (createErr || !created?.user) {
    return json(req, { error: "AUTH_CREATE_FAILED", detail: createErr?.message }, 500);
  }
  const newUserId = created.user.id;

  // Roll back the auth user if anything below fails — never leave an
  // orphaned login with no profile/leader row.
  const rollback = async () => {
    await supabase.auth.admin.deleteUser(newUserId).catch(() => {});
  };

  const { data: leaderRow, error: leaderErr } = await supabase
    .from("leaders")
    .insert({
      full_name, position, ministry_id,
      phone_public: public_visible ? phone_number : null,
      phone_private: phone_number,
      email, photo_url, bio, programme, year_of_study,
      active, public_visible,
    })
    .select("id")
    .single();
  if (leaderErr || !leaderRow) {
    await rollback();
    return json(req, { error: "LEADER_INSERT_FAILED", detail: leaderErr?.message }, 500);
  }

  const { error: profileErr } = await supabase.from("profiles").insert({
    id: newUserId,
    full_name,
    role: "leader",
    position,
    ministry_id,
    username,
    active,
    must_change_password: true,
    leader_id: leaderRow.id,
    permissions: {},
  });
  if (profileErr) {
    await supabase.from("leaders").delete().eq("id", leaderRow.id);
    await rollback();
    return json(req, { error: "PROFILE_INSERT_FAILED", detail: profileErr?.message }, 500);
  }

  await logAudit(supabase, caller.id, caller.full_name, "Leader Creation",
    `Aliunda akaunti ya kiongozi: ${full_name} (${position}), username: ${username}`);

  return json(req, {
    ok: true,
    message: "Akaunti imeundwa kikamilifu. Tumia Reset Password kupata password ya muda.",
    leader_id: leaderRow.id,
    profile_id: newUserId,
    username,
  });
}

async function resetPassword(req: Request, supabase: any, caller: { id: string; full_name: string }, body: Record<string, unknown>) {
  const profile_id = String(body.profile_id ?? "");
  if (!profile_id) return json(req, { error: "PROFILE_ID_REQUIRED" }, 400);

  const tempPassword = generateTempPassword();
  const { error } = await supabase.auth.admin.updateUserById(profile_id, { password: tempPassword });
  if (error) return json(req, { error: "RESET_FAILED", detail: error.message }, 500);

  await supabase.from("profiles").update({ must_change_password: true }).eq("id", profile_id);

  const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", profile_id).maybeSingle();
  await logAudit(supabase, caller.id, caller.full_name, "Password Reset",
    `Alireset password ya: ${profile?.full_name ?? profile_id}`);

  return json(req, { ok: true, temporary_password: tempPassword });
}

async function setActive(req: Request, supabase: any, caller: { id: string; full_name: string }, body: Record<string, unknown>, active: boolean) {
  const profile_id = String(body.profile_id ?? "");
  if (!profile_id) return json(req, { error: "PROFILE_ID_REQUIRED" }, 400);

  const { data: profile, error } = await supabase
    .from("profiles")
    .update({ active })
    .eq("id", profile_id)
    .select("full_name, leader_id")
    .maybeSingle();
  if (error) return json(req, { error: "UPDATE_FAILED", detail: error.message }, 500);

  if (profile?.leader_id) {
    await supabase.from("leaders").update({ active }).eq("id", profile.leader_id);
  }

  await logAudit(supabase, caller.id, caller.full_name,
    active ? "Leader Activation" : "Leader Deactivation",
    `${active ? "Aliwezesha" : "Alizima"} akaunti ya: ${profile?.full_name ?? profile_id}`);

  return json(req, { ok: true });
}

async function deleteLeader(req: Request, supabase: any, caller: { id: string; full_name: string }, body: Record<string, unknown>) {
  const profile_id = String(body.profile_id ?? "");
  if (!profile_id) return json(req, { error: "PROFILE_ID_REQUIRED" }, 400);

  const { data: profile } = await supabase.from("profiles").select("full_name, leader_id").eq("id", profile_id).maybeSingle();

  // Leave the public directory row (history/attribution on past announcements
  // etc. reference profile ids) but remove the login entirely.
  const { error } = await supabase.auth.admin.deleteUser(profile_id);
  if (error) return json(req, { error: "DELETE_FAILED", detail: error.message }, 500);
  await supabase.from("profiles").delete().eq("id", profile_id);
  if (profile?.leader_id) {
    await supabase.from("leaders").update({ active: false, public_visible: false }).eq("id", profile.leader_id);
  }

  await logAudit(supabase, caller.id, caller.full_name, "Leader Deletion",
    `Alifuta akaunti ya: ${profile?.full_name ?? profile_id}`);

  return json(req, { ok: true });
}

Deno.serve(handle);
