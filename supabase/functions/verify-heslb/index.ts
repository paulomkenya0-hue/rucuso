// Public HESLB check. This endpoint compares one submitted identity pair and
// returns only a boolean; it never returns beneficiary fields or list access.
import { json, preflight, readJson, getSupabase } from "../_shared/otp.ts";

function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let phone = raw.trim().replace(/[\s()-]/g, "");
  if (/^0[678]\d{8}$/.test(phone)) phone = "+255" + phone.slice(1);
  else if (/^255[678]\d{8}$/.test(phone)) phone = "+" + phone;
  return /^\+255[678]\d{8}$/.test(phone) ? phone : null;
}

async function hashClientKey(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  const supabase = getSupabase();
  const secret = Deno.env.get("HESLB_RATE_LIMIT_SECRET");
  if (!secret || secret.length < 32) return json(req, { verified: false }, 503);

  const ip = req.headers.get("cf-connecting-ip")
    || req.headers.get("x-real-ip")
    || req.headers.get("x-forwarded-for")?.split(",").map((value) => value.trim()).filter(Boolean).at(-1)
    || "unknown-client";
  const keyHash = await hashClientKey(ip, secret);
  const { data: allowed, error: limitError } = await supabase.rpc("consume_heslb_verification_attempt", {
    p_key_hash: keyHash,
  });
  if (limitError || allowed !== true) return json(req, { verified: false }, 429);

  const body = await readJson(req);
  const indexNumber = typeof body.index_number === "string" ? body.index_number.trim().toUpperCase() : "";
  const phone = normalizePhone(body.phone);
  if (!indexNumber || indexNumber.length > 80 || !phone) return json(req, { verified: false });

  const { data, error } = await supabase.from("heslb_beneficiaries")
    .select("index_number")
    .eq("index_number", indexNumber)
    .eq("phone", phone)
    .eq("status", "active")
    .maybeSingle();
  if (error) return json(req, { verified: false }, 503);
  return json(req, { verified: !!data });
});
