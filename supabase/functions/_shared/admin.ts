// Shared helper for admin-only Edge Functions (leader-admin, etc).
// Verifies the caller's Supabase Auth access token and checks their profile
// role — every admin Edge Function must call this before touching anything,
// because the function itself runs with the service role key and therefore
// bypasses RLS entirely. If this check is skipped, RLS is not protecting you.

import { json } from "./otp.ts";

export async function requireSuperAdmin(
  req: Request,
  supabase: any,
): Promise<{ id: string; full_name: string } | Response> {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json(req, { error: "NOT_AUTHENTICATED" }, 401);

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return json(req, { error: "NOT_AUTHENTICATED" }, 401);

  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("id, full_name, role, active")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profErr || !profile) return json(req, { error: "NO_PROFILE" }, 403);
  if (!profile.active || profile.role !== "super_admin") {
    return json(req, { error: "FORBIDDEN_NOT_SUPER_ADMIN" }, 403);
  }
  return { id: profile.id, full_name: profile.full_name };
}

// Who may act on the HESLB register: a super admin, or an admin granted
// manage_heslb_beneficiaries, or a leader — but only while their active
// ministry is loans and empowerment (the "Waziri/Naibu wa Mikopo").
//
// This mirrors public.is_heslb_manager() (migration 009) exactly, but it has to
// exist separately: Edge Functions run with the service role and bypass RLS, so
// the database function that guards the table in the browser protects nothing
// here. If the two ever drift, this check is the one that actually decides.
export async function requireHeslbManager(
  req: Request,
  supabase: any,
): Promise<{ id: string; full_name: string } | Response> {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json(req, { error: "NOT_AUTHENTICATED" }, 401);

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return json(req, { error: "NOT_AUTHENTICATED" }, 401);

  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("id, full_name, role, active, permissions, ministry_id")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profErr || !profile) return json(req, { error: "NO_PROFILE" }, 403);
  if (!profile.active) return json(req, { error: "FORBIDDEN_NOT_HESLB_MANAGER" }, 403);

  const identity = { id: profile.id, full_name: profile.full_name };
  if (profile.role === "super_admin") return identity;

  if (profile.role !== "leader" && profile.role !== "admin") {
    return json(req, { error: "FORBIDDEN_NOT_HESLB_MANAGER" }, 403);
  }
  const canManage = profile.role === "leader"
    || profile.permissions?.manage_heslb_beneficiaries === true;
  if (!canManage || !profile.ministry_id) {
    return json(req, { error: "FORBIDDEN_NOT_HESLB_MANAGER" }, 403);
  }

  const { data: ministry, error: minErr } = await supabase
    .from("ministries")
    .select("name, active")
    .eq("id", profile.ministry_id)
    .maybeSingle();
  if (minErr || !ministry || !ministry.active) {
    return json(req, { error: "FORBIDDEN_NOT_HESLB_MANAGER" }, 403);
  }
  const normalized = String(ministry.name).toLowerCase().trim().replace(/[^a-z0-9]/g, "");
  const LOAN_MINISTRIES = new Set([
    "loansandempowerment",
    "loansempowerment",
    "ministryofloansandempowerment",
    "ministryofloansempowerment",
    "mikoponauwezeshaji",
    "wizarayamikoponauwezeshaji",
  ]);
  if (!LOAN_MINISTRIES.has(normalized)) {
    return json(req, { error: "FORBIDDEN_NOT_HESLB_MANAGER" }, 403);
  }
  return identity;
}

export function isResponse(x: unknown): x is Response {
  return x instanceof Response;
}

export async function logAudit(
  supabase: any,
  actorId: string,
  actorLabel: string,
  action: string,
  details: string,
): Promise<void> {
  await supabase.from("audit_logs").insert({
    actor_id: actorId,
    actor_label: actorLabel,
    action,
    details,
  });
}

// 12-char temporary password: unambiguous character set (no 0/O/1/l/I),
// meets Supabase Auth's minimum length, meant to be changed on first login.
export function generateTempPassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const buf = new Uint32Array(12);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join("");
}
