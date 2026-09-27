// Public student verification for the general feedback/complaints flow.
// This is intentionally separate from HESLB verification and does not use SMS.
import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import {
  clientAddress,
  consumeRateLimit,
  isRegistrationShaped,
  json,
  preflight,
  readJson,
  getSupabase,
} from "../_shared/otp.ts";

function normalizeLastName(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function errorResponse(req: Request, code: string, message: string, status: number) {
  return json(req, {
    success: false,
    verified: false,
    error: { code, message },
  }, status);
}

function successResponse(req: Request, data: Record<string, unknown>) {
  return json(req, {
    success: true,
    verified: true,
    data,
  }, 200);
}

serve(async (req: Request) => {
  try {
    const early = preflight(req);
    if (early) return early;

    let supabase: any;
    try {
      supabase = getSupabase();
    } catch (e) {
      console.error("verify-student: missing Supabase configuration", { message: e instanceof Error ? e.message : String(e) });
      return errorResponse(req, "INTERNAL_ERROR", "Unable to complete verification at this time.", 500);
    }

    const secret = Deno.env.get("STUDENT_LOOKUP_RATE_LIMIT_SECRET");
    if (!secret || secret.length < 32) {
      console.error("verify-student: STUDENT_LOOKUP_RATE_LIMIT_SECRET missing or too short");
      return errorResponse(req, "INTERNAL_ERROR", "Unable to complete verification at this time.", 500);
    }

    const body = await readJson(req);
    const reg = typeof body.reg === "string" ? body.reg.trim() : "";
    const lastName = normalizeLastName(body.last_name);
    const remoteIp = clientAddress(req);

    if (!reg || !lastName) {
      return errorResponse(req, "INVALID_INPUT", "Registration number and last name are required.", 400);
    }
    if (reg.length > 80) {
      return errorResponse(req, "INVALID_INPUT", "Registration number is too long.", 400);
    }
    if (!isRegistrationShaped(reg)) {
      return errorResponse(req, "INVALID_INPUT", "Registration number format is invalid.", 400);
    }

    const allowed = await consumeRateLimit(supabase, secret, [
      { scope: "student_verify_reg", value: reg },
      { scope: "student_verify_ip", value: remoteIp },
    ]);
    if (!allowed) {
      return errorResponse(req, "RATE_LIMITED", "Too many attempts. Please wait a moment and try again.", 429);
    }

    const { data, error } = await supabase
      .from("students")
      .select("id, registration_number, full_name, programme, year_of_study, last_name")
      .or(`registration_number.ilike.${reg.replace(/([\\%_])/g, "\\$1")},legacy_registration_number.ilike.${reg.replace(/([\\%_])/g, "\\$1")}`)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("verify-student: table lookup failed", {
        code: error?.code || "UNKNOWN",
        message: error?.message || "database lookup failed",
      });
      return errorResponse(req, "INTERNAL_ERROR", "Unable to complete verification at this time.", 500);
    }

    if (!data) {
      console.warn("verify-student: no registration match found", {
        reg_prefix: reg.slice(0, 4),
      });
      return errorResponse(req, "NOT_FOUND", "The student details could not be verified.", 404);
    }

    const stored = normalizeLastName(data.last_name);
    if (!stored || stored !== lastName) {
      console.info("verify-student: last-name mismatch", {
        registration_prefix: reg.slice(0, 4),
      });
      return errorResponse(req, "INVALID_CREDENTIALS", "The registration number and last name do not match our records.", 401);
    }

    return successResponse(req, {
      id: data.id,
      full_name: data.full_name,
      programme: data.programme,
      year_of_study: data.year_of_study,
    });
  } catch (e) {
    console.error("verify-student: unhandled exception", {
      message: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(req, "INTERNAL_ERROR", "Unable to complete verification at this time.", 500);
  }
});
