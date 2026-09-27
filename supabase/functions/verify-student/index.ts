// Public student verification for the general feedback/complaints flow.
// This is intentionally separate from HESLB verification and does not use SMS.
import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import {
  clientAddress,
  consumeRateLimit,
  isRegistrationShaped,
  json,
  normaliseReg,
  preflight,
  readJson,
  getSupabase,
  regFilter,
} from "../_shared/otp.ts";


function normalizeLastName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return normalizeName(raw);
}

// Normalise a name for comparison: Unicode-normalised (NFKC, so a composed
// "é" and a decomposed "e´" compare equal), trimmed, internal whitespace
// collapsed to single spaces, and lower-cased. Both the stored value and the
// student's input go through this, so a match no longer depends on which form
// of a character, or how many spaces, either side happened to store.
function normalizeName(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

// True when the student-supplied last name matches a stored name.
//
// The stored name may hold the COMPLETE name in one field ("Angelina Barbino
// SANGA"), so the input is matched against each whitespace-delimited component
// of the full name rather than requiring the whole field to equal it. Matching
// whole components — not substrings — is what keeps a short input such as "AN"
// from matching "Angelina": "AN" is not a component of that name.
//
// The dedicated last_name column is checked first (fast path); the full name is
// the authoritative fallback, because it is a stored generated column that is
// always populated, whereas last_name depends on how the row was imported.
function lastNameMatches(input: string, storedFullName: string, storedLastName: string): boolean {
  const target = normalizeName(input);
  if (!target) return false;
  if (storedLastName && normalizeName(storedLastName) === target) return true;
  const fullName = normalizeName(storedFullName);
  if (!fullName) return false;
  return fullName.split(" ").some((part) => part === target);
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
    const rawReg = typeof body.reg === "string" ? body.reg.trim() : "";
    // Normalise once, here, so the rate-limit bucket and the query filter are
    // the same number however it was typed: "ru/baed/2024/002",
    // "RU / BAED / 2024 / 002" and " RU/BAED/2024/002 " all become
    // "RU/BAED/2024/002". regFilter() normalises again internally, which is
    // idempotent, so the two can never disagree.
    const reg = normaliseReg(rawReg);
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
      { scope: "reg", value: reg },
      { scope: "ip", value: remoteIp },
    ]);
    if (!allowed) {
      return errorResponse(req, "RATE_LIMITED", "Too many attempts. Please wait a moment and try again.", 429);
    }


    // The registration filter can in principle match more than one row (a
    // number present as one student's registration_number and another's
    // legacy_registration_number), so a small candidate set is fetched and each
    // is checked. Nothing about how many candidates there were — or which failed
    // the name check — leaves this function.
    const { data, error } = await supabase
      .from("students")
      .select("id, registration_number, full_name, programme, year_of_study, last_name")
      .or(regFilter(reg))
      .limit(5);

    if (error) {
      console.error("verify-student: table lookup failed", {
        code: error?.code || "UNKNOWN",
        message: error?.message || "database lookup failed",
      });
      return errorResponse(req, "INTERNAL_ERROR", "Unable to complete verification at this time.", 500);
    }

    let match: any = null;
    if (Array.isArray(data)) {
      for (const row of data) {
        if (lastNameMatches(lastName, row.full_name, row.last_name)) {
          match = row;
          break;
        }
      }
    }

    if (!match) {
      // One response for every failure — no registration match and name
      // mismatch are deliberately indistinguishable, so a failed verification
      // cannot be told apart by which of the two failed. That distinction is
      // an existence oracle: a 404 says "this number is not in the registry"
      // while a 401 says "this number is, but the name is wrong".
      console.info("verify-student: verification failed", {
        reg_prefix: reg.slice(0, 4),
      });
      return errorResponse(req, "INVALID_CREDENTIALS", "The registration number and last name do not match our records.", 401);
    }

    return successResponse(req, {
      id: match.id,
      full_name: match.full_name,
      programme: match.programme,
      year_of_study: match.year_of_study,
    });
  } catch (e) {
    console.error("verify-student: unhandled exception", {
      message: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(req, "INTERNAL_ERROR", "Unable to complete verification at this time.", 500);
  }
});
