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
