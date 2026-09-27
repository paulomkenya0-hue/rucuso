// Public student verification for the general feedback/complaints flow.
// This is intentionally separate from HESLB verification and does not use SMS.
import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import {
  clientAddress,
  consumeRateLimit,
  countStudentsMatching,
  isRegistrationShaped,
  json,
  preflight,
  readJson,
  getSupabase,
} from "../_shared/otp.ts";

const ACCEPTED = { verified: false } as const;

function normalizeLastName(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  const supabase = getSupabase();
  const secret = Deno.env.get("STUDENT_LOOKUP_RATE_LIMIT_SECRET");
  if (!secret || secret.length < 32) return json(req, { error: "NOT_CONFIGURED" }, 503);

  const body = await readJson(req);
  const reg = typeof body.reg === "string" ? body.reg.trim() : "";
  const lastName = normalizeLastName(body.last_name);
  const remoteIp = clientAddress(req);

  if (!reg || !lastName || reg.length > 80) return json(req, ACCEPTED);
  if (!isRegistrationShaped(reg)) return json(req, ACCEPTED);

  const allowed = await consumeRateLimit(supabase, secret, [
    { scope: "student_verify_reg", value: reg },
    { scope: "student_verify_ip", value: remoteIp },
  ]);
  if (!allowed) return json(req, { error: "TOO_MANY_REQUESTS" }, 429);

  try {
    const { data, error } = await supabase
      .from("students")
      .select("id, registration_number, full_name, programme, year_of_study, last_name")
      .or(`registration_number.ilike.${reg.replace(/([\\%_])/g, "\\$1")},legacy_registration_number.ilike.${reg.replace(/([\\%_])/g, "\\$1")}`)
      .limit(1)
      .maybeSingle();

    if (error) return json(req, { verified: false }, 503);
    if (!data) return json(req, ACCEPTED);

    const stored = normalizeLastName(data.last_name);
    const ok = stored.length > 0 && stored === lastName;
    if (!ok) return json(req, ACCEPTED);

    return json(req, {
      verified: true,
      full_name: data.full_name,
      programme: data.programme,
      year_of_study: data.year_of_study,
    });
  } catch (e) {
    console.error("verify-student: lookup failed", e);
    return json(req, { verified: false }, 503);
  }
});
