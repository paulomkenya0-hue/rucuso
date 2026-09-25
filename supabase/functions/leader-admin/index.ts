// RUCUSO — leader-admin
//
// The ONLY way a leader account is created, has its password reset, or is
// deactivated/deleted. Every action requires the caller to be an active
// SUPER_ADMIN (checked server-side via requireSuperAdmin — never trust a
// role claim sent from the browser). Runs with the service role key, so it
// can call supabase.auth.admin.* which the browser's anon/authenticated
// clients cannot.
//
// POST body: { action: "create" | "reset_password" | "deactivate" | "activate" | "delete", ...fields }
//
// Secrets required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (both are
// provided automatically to every Supabase Edge Function).

import { json, preflight, readJson, getSupabase } from "../_shared/otp.ts";
import { requireSuperAdmin, isResponse, logAudit, generateTempPassword } from "../_shared/admin.ts";

const POSITIONS = ["president", "secretary_general", "minister", "deputy_minister", "representative", "officer"];

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
    case "create":       return await createLeader(req, supabase, caller, body);
    case "reset_password": return await resetPassword(req, supabase, caller, body);
    case "deactivate":   return await setActive(req, supabase, caller, body, false);
    case "activate":     return await setActive(req, supabase, caller, body, true);
    case "delete":       return await deleteLeader(req, supabase, caller, body);
    default:             return json(req, { error: "UNKNOWN_ACTION" }, 400);
  }
}

async function createLeader(req: Request, supabase: any, caller: { id: string; full_name: string }, body: Record<string, unknown>) {
  const full_name = String(body.full_name ?? "").trim();
  const position = String(body.position ?? "").trim();
  const ministry_id = body.ministry_id ? String(body.ministry_id) : null;
  const username = String(body.username ?? "").trim();
  const phone_number = body.phone_number ? String(body.phone_number).trim() : null;
  const email = body.email ? String(body.email).trim() : null;
  const programme = body.programme ? String(body.programme).trim() : null;
  const year_of_study = body.year_of_study ? String(body.year_of_study).trim() : null;
  const bio = body.biography ? String(body.biography).trim() : null;
  const photo_url = body.photo_url ? String(body.photo_url).trim() : null;
  const public_visible = body.public_visibility !== false;
  const active = body.active_status !== false;

  if (!full_name) return json(req, { error: "FULL_NAME_REQUIRED" }, 400);
  if (!POSITIONS.includes(position)) return json(req, { error: "INVALID_POSITION" }, 400);
  if (!/^[a-z0-9._-]{3,32}$/i.test(username)) {
    return json(req, { error: "INVALID_USERNAME" }, 400);
  }

  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .ilike("username", username)
    .maybeSingle();
  if (existing) return json(req, { error: "USERNAME_TAKEN" }, 409);

  const tempPassword = generateTempPassword();
  const authEmail = email && email.includes("@") ? email : `${username}@login.rucuso.online`;

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: authEmail,
    password: tempPassword,
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
    message: "Account ya kiongozi imeundwa kikamilifu.",
    leader_id: leaderRow.id,
    profile_id: newUserId,
    username,
    temporary_password: tempPassword, // shown ONCE to the super admin; never stored in plaintext elsewhere
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
