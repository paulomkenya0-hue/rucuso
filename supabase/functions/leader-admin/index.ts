// RUCUSO — leader-admin
//
// All leader-account management is restricted to active SUPER_ADMIN users.
// The function uses the Supabase service-role client, so every request MUST
// pass requireSuperAdmin() before touching database/auth-admin operations.
//
// POST body:
//   { action: "list" }
//   { action: "create", ...fields }
//   { action: "reset_password", profile_id }
//   { action: "deactivate", profile_id }
//   { action: "activate", profile_id }
//   { action: "delete", profile_id }

import { json, preflight, readJson, getSupabase } from "../_shared/otp.ts";
import {
  requireSuperAdmin,
  isResponse,
  logAudit,
  generateTempPassword,
} from "../_shared/admin.ts";

const POSITIONS = [
  "president",
  "secretary_general",
  "minister",
  "deputy_minister",
  "representative",
  "officer",
];

// deno-lint-ignore no-explicit-any
async function handle(req: Request): Promise<Response> {
  const early = preflight(req);
  if (early) return early;

  const supabase = getSupabase();

  // Every action is protected server-side.
  const caller = await requireSuperAdmin(req, supabase);
  if (isResponse(caller)) return caller;

  const body = await readJson(req);
  const action = typeof body.action === "string" ? body.action : "";

  switch (action) {
    case "list":
      return await listLeaders(req, supabase);

    case "create":
      return await createLeader(req, supabase, caller, body);

    case "reset_password":
      return await resetPassword(req, supabase, caller, body);

    case "deactivate":
      return await setActive(req, supabase, caller, body, false);

    case "activate":
      return await setActive(req, supabase, caller, body, true);

    case "delete":
      return await deleteLeader(req, supabase, caller, body);

    default:
      return json(req, { error: "UNKNOWN_ACTION" }, 400);
  }
}

// -----------------------------------------------------------------------------
// LIST
// -----------------------------------------------------------------------------
//
// Returns only information needed by the admin UI.
// IMPORTANT: phone_private is deliberately excluded.
// -----------------------------------------------------------------------------

async function listLeaders(req: Request, supabase: any) {
  const { data, error } = await supabase
    .from("profiles")
    .select(`
      id,
      full_name,
      role,
      position,
      username,
      ministry_id,
      active,
      must_change_password,
      leader_id,
      leaders (
        id,
        full_name,
        position,
        ministry_id,
        phone_public,
        email,
        photo_url,
        bio,
        responsibilities,
        programme,
        year_of_study,
        office_location,
        start_date,
        end_date,
        active,
        public_visible,
        created_at
      )
    `)
    .eq("role", "leader")
    .order("full_name", { ascending: true });

  if (error) {
    return json(req, {
      error: "LEADERS_FETCH_FAILED",
      detail: error.message,
    }, 500);
  }

  const ministryIds = [
    ...new Set(
      (data ?? [])
        .map((row: any) => row.ministry_id)
        .filter(Boolean),
    ),
  ];

  let ministries: Record<string, string> = {};

  if (ministryIds.length > 0) {
    const { data: ministryRows, error: ministryError } = await supabase
      .from("ministries")
      .select("id, name")
      .in("id", ministryIds);

    if (ministryError) {
      return json(req, {
        error: "MINISTRIES_FETCH_FAILED",
        detail: ministryError.message,
      }, 500);
    }

    ministries = Object.fromEntries(
      (ministryRows ?? []).map((m: any) => [m.id, m.name]),
    );
  }

  const leaders = (data ?? []).map((profile: any) => {
    const leader = Array.isArray(profile.leaders)
      ? profile.leaders[0] ?? null
      : profile.leaders ?? null;

    return {
      profile_id: profile.id,
      leader_id: profile.leader_id ?? leader?.id ?? null,
      full_name: profile.full_name,
      username: profile.username,
      role: profile.role,
      position: profile.position ?? leader?.position ?? null,
      ministry_id: profile.ministry_id ?? leader?.ministry_id ?? null,
      ministry_name:
        ministries[profile.ministry_id ?? leader?.ministry_id] ?? null,
      active: profile.active,
      must_change_password: profile.must_change_password,

      phone_public: leader?.phone_public ?? null,
      email: leader?.email ?? null,
      photo_url: leader?.photo_url ?? null,
      bio: leader?.bio ?? null,
      responsibilities: leader?.responsibilities ?? null,
      programme: leader?.programme ?? null,
      year_of_study: leader?.year_of_study ?? null,
      office_location: leader?.office_location ?? null,
      start_date: leader?.start_date ?? null,
      end_date: leader?.end_date ?? null,
      public_visible: leader?.public_visible ?? false,
      leader_active: leader?.active ?? false,
      created_at: leader?.created_at ?? null,
    };
  });

  return json(req, {
    ok: true,
    leaders,
  });
}

// -----------------------------------------------------------------------------
// CREATE
// -----------------------------------------------------------------------------

async function createLeader(
  req: Request,
  supabase: any,
  caller: { id: string; full_name: string },
  body: Record<string, unknown>,
) {
  const full_name = String(body.full_name ?? "").trim();
  const position = String(body.position ?? "").trim();
  const ministry_id = body.ministry_id
    ? String(body.ministry_id)
    : null;
  const username = String(body.username ?? "").trim();
  const phone_number = body.phone_number
    ? String(body.phone_number).trim()
    : null;
  const email = body.email
    ? String(body.email).trim()
    : null;
  const programme = body.programme
    ? String(body.programme).trim()
    : null;
  const year_of_study = body.year_of_study
    ? String(body.year_of_study).trim()
    : null;
  const bio = body.biography
    ? String(body.biography).trim()
    : null;
  const photo_url = body.photo_url
    ? String(body.photo_url).trim()
    : null;
  const public_visible = body.public_visibility !== false;
  const active = body.active_status !== false;

  if (!full_name) {
    return json(req, { error: "FULL_NAME_REQUIRED" }, 400);
  }

  if (!POSITIONS.includes(position)) {
    return json(req, { error: "INVALID_POSITION" }, 400);
  }

  if (!/^[a-z0-9._-]{3,32}$/i.test(username)) {
    return json(req, { error: "INVALID_USERNAME" }, 400);
  }

  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .ilike("username", username)
    .maybeSingle();

  if (existing) {
    return json(req, { error: "USERNAME_TAKEN" }, 409);
  }

  const tempPassword = generateTempPassword();

  const authEmail =
    email && email.includes("@")
      ? email
      : `${username}@login.rucuso.online`;

  const { data: created, error: createErr } =
    await supabase.auth.admin.createUser({
      email: authEmail,
      password: tempPassword,
      email_confirm: true,
    });

  if (createErr || !created?.user) {
    return json(req, {
      error: "AUTH_CREATE_FAILED",
      detail: createErr?.message,
    }, 500);
  }

  const newUserId = created.user.id;

  const rollback = async () => {
    await supabase.auth.admin.deleteUser(newUserId).catch(() => {});
  };

  const { data: leaderRow, error: leaderErr } = await supabase
    .from("leaders")
    .insert({
      full_name,
      position,
      ministry_id,
      phone_public: public_visible ? phone_number : null,
      phone_private: phone_number,
      email,
      photo_url,
      bio,
      programme,
      year_of_study,
      active,
      public_visible,
    })
    .select("id")
    .single();

  if (leaderErr || !leaderRow) {
    await rollback();

    return json(req, {
      error: "LEADER_INSERT_FAILED",
      detail: leaderErr?.message,
    }, 500);
  }

  const { error: profileErr } = await supabase
    .from("profiles")
    .insert({
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
    await supabase
      .from("leaders")
      .delete()
      .eq("id", leaderRow.id);

    await rollback();

    return json(req, {
      error: "PROFILE_INSERT_FAILED",
      detail: profileErr.message,
    }, 500);
  }

  await logAudit(
    supabase,
    caller.id,
    caller.full_name,
    "Leader Creation",
    `Aliunda akaunti ya kiongozi: ${full_name} (${position}), username: ${username}`,
  );

  return json(req, {
    ok: true,
    message: "Account ya kiongozi imeundwa kikamilifu.",
    leader_id: leaderRow.id,
    profile_id: newUserId,
    username,
    temporary_password: tempPassword,
  });
}

// -----------------------------------------------------------------------------
// RESET PASSWORD
// -----------------------------------------------------------------------------

async function resetPassword(
  req: Request,
  supabase: any,
  caller: { id: string; full_name: string },
  body: Record<string, unknown>,
) {
  const profile_id = String(body.profile_id ?? "");

  if (!profile_id) {
    return json(req, { error: "PROFILE_ID_REQUIRED" }, 400);
  }

  const tempPassword = generateTempPassword();

  const { error } =
    await supabase.auth.admin.updateUserById(
      profile_id,
      { password: tempPassword },
    );

  if (error) {
    return json(req, {
      error: "RESET_FAILED",
      detail: error.message,
    }, 500);
  }

  await supabase
    .from("profiles")
    .update({ must_change_password: true })
    .eq("id", profile_id);

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", profile_id)
    .maybeSingle();

  await logAudit(
    supabase,
    caller.id,
    caller.full_name,
    "Password Reset",
    `Alireset password ya: ${profile?.full_name ?? profile_id}`,
  );

  return json(req, {
    ok: true,
    temporary_password: tempPassword,
  });
}

// -----------------------------------------------------------------------------
// ACTIVATE / DEACTIVATE
// -----------------------------------------------------------------------------

async function setActive(
  req: Request,
  supabase: any,
  caller: { id: string; full_name: string },
  body: Record<string, unknown>,
  active: boolean,
) {
  const profile_id = String(body.profile_id ?? "");

  if (!profile_id) {
    return json(req, { error: "PROFILE_ID_REQUIRED" }, 400);
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .update({ active })
    .eq("id", profile_id)
    .select("full_name, leader_id")
    .maybeSingle();

  if (error) {
    return json(req, {
      error: "UPDATE_FAILED",
      detail: error.message,
    }, 500);
  }

  if (profile?.leader_id) {
    await supabase
      .from("leaders")
      .update({ active })
      .eq("id", profile.leader_id);
  }

  await logAudit(
    supabase,
    caller.id,
    caller.full_name,
    active ? "Leader Activation" : "Leader Deactivation",
    `${active ? "Aliwezesha" : "Alizima"} akaunti ya: ${
      profile?.full_name ?? profile_id
    }`,
  );

  return json(req, { ok: true });
}

// -----------------------------------------------------------------------------
// DELETE
// -----------------------------------------------------------------------------

async function deleteLeader(
  req: Request,
  supabase: any,
  caller: { id: string; full_name: string },
  body: Record<string, unknown>,
) {
  const profile_id = String(body.profile_id ?? "");

  if (!profile_id) {
    return json(req, { error: "PROFILE_ID_REQUIRED" }, 400);
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, leader_id")
    .eq("id", profile_id)
    .maybeSingle();

  const { error } =
    await supabase.auth.admin.deleteUser(profile_id);

  if (error) {
    return json(req, {
      error: "DELETE_FAILED",
      detail: error.message,
    }, 500);
  }

  await supabase
    .from("profiles")
    .delete()
    .eq("id", profile_id);

  if (profile?.leader_id) {
    await supabase
      .from("leaders")
      .update({
        active: false,
        public_visible: false,
      })
      .eq("id", profile.leader_id);
  }

  await logAudit(
    supabase,
    caller.id,
    caller.full_name,
    "Leader Deletion",
    `Alifuta akaunti ya: ${profile?.full_name ?? profile_id}`,
  );

  return json(req, { ok: true });
}

Deno.serve(handle);
