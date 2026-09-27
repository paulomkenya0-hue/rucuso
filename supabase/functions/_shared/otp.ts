// Shared helpers for the RUCUSO OTP Edge Functions.
// The SMS provider's credentials and the OTP pepper only ever exist here,
// on the server — they are read from Supabase secrets at runtime.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const OTP_TTL_SECONDS = 300;      // code is valid for 5 minutes
export const MAX_ATTEMPTS = 5;           // wrong-code attempts per issued code
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_SENDS_PER_WINDOW = 3;   // per phone number
export const SEND_WINDOW_MINUTES = 15;

const TZ_PHONE = /^\+255\d{9}$/;

export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/[\s()-]/g, "");
  if (TZ_PHONE.test(v)) return v;
  if (/^0\d{9}$/.test(v)) return "+255" + v.slice(1);
  if (/^255\d{9}$/.test(v)) return "+" + v;
  return null;
}

// ---------- rate limiting ----------
//
// Shared by lookup-student and send-otp so there is one implementation of the
// HMAC scheme. The table this uses (student_lookup_attempts, migration 012)
// never stores a registration number or an IP address in the clear: both are
// HMAC'd with a server-side secret first, so a dump of the table does not hand
// an attacker either.

// Same client-address resolution as verify-heslb: Supabase sets at least one of
// these on every request. "unknown-client" is a real bucket, not a bypass — it
// just means everyone who hit this path shares one bucket.
export function clientAddress(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip")
    || req.headers.get("x-real-ip")
    || req.headers.get("x-forwarded-for")?.split(",").map((v) => v.trim()).filter(Boolean).at(-1)
    || "unknown-client"
  );
}

export async function hmacHex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Spends one attempt in every scope given. Returns false as soon as any scope
// is exhausted, so the caller can answer 429 without saying which one tripped.
//
// The scopes are hashed before they leave this function and the caller only
// learns "allowed" or "not allowed", which is what keeps a 429 from becoming an
// oracle: the budget is spent identically whether or not the registration
// number exists, because the caller does not look anything up before calling.
export async function consumeRateLimit(
  supabase: any,
  secret: string,
  scopes: readonly { scope: string; value: string }[],
): Promise<boolean> {
  for (const { scope, value } of scopes) {
    const keyHash = await hmacHex(scope + ":" + value, secret);
    const { data: allowed, error } = await supabase.rpc("consume_student_lookup_attempt", {
      p_scope: scope,
      p_key_hash: keyHash,
    });
    if (error || allowed !== true) return false;
  }
  return true;
}

// A registration number to match with ilike(). The LIKE metacharacters are
// escaped so the value is matched literally, and the number is normalised to
// upper case so the comparison is case-insensitive.
//
// This is shared by lookup-student and send-otp on purpose. The RPC they
// replaced compared lower(registration_number) = lower(p_reg), so a student who
// typed their number in lower case was found. If only one of the two functions
// matched case-insensitively, the student would pass the "is this number in the
// registry?" screen and then be told the same number does not exist when the
// code was sent — the two steps disagreeing about the same input.
export function registrationPattern(raw: string): string {
  return raw.trim().toUpperCase().replace(/([\\%_])/g, "\\$1");
}

// ---------- registration numbers ----------

// The current format, RU/<COURSE_CODE>/<YEAR>/<STUDENT_NUMBER>. The course-code
// segment is why migration 014 added students.course_code.
export const CURRENT_REG_RE = /^RU\/[A-Z]{2,6}\/\d{4}\/\d{3,4}$/i;

// The pre-2026 shape, <PREFIX>/<YEAR>/<INDEX>. Kept only so an unmigrated
// number is recognised well enough to be rate-limited like any other attempt
// rather than being waved through as "not a registration number".
export const LEGACY_REG_RE = /^[A-Z]{2,6}\s*\/\s*\d{2,4}\s*\/\s*\d{1,6}$/i;

// Spaces around the slashes are tolerated on input and removed before matching,
// so a number pasted as "RU / BAFIT / 2024 / 007" behaves identically to a typed
// one. Upper-cased too, so it matches the canonical form that is stored.
export function normaliseReg(reg: string): string {
  return reg.toUpperCase().replace(/\s*([/\-])\s*/g, "$1");
}

export function isRegistrationShaped(reg: string): boolean {
  const n = normaliseReg(reg);
  return CURRENT_REG_RE.test(n) || LEGACY_REG_RE.test(n);
}

// The PostgREST filter that matches a registration number against both
// registration columns, OR'd together so which one matched is never knowable
// from the return value.
//
// This exists as one function because lookup-student and send-otp used to build
// this filter separately, and the two could disagree about what a registration
// number is — which is how a student could pass the lookup step and then be
// told the same number does not exist when the code was sent.
//
// verify-student uses this too. It built its own inline filter for a while,
// which disagreed with this one about whitespace: a number pasted as
// "RU / BAFIT / 2024 / 007" matched here (normaliseReg strips the spaces) but
// not there, so the same student was found by lookup-student and then rejected
// by verify-student. One helper means the three functions cannot drift.
export function regFilter(reg: string): string {
  const pattern = registrationPattern(normaliseReg(reg));
  return `registration_number.ilike.${pattern},legacy_registration_number.ilike.${pattern}`;
}

// student_status is matched with coalesce semantics: rows imported before the
// column existed carry NULL, and a plain .eq() would silently drop every one.
const ACTIVE_STATUS_FILTER = "student_status.is.null,student_status.eq.active";

// How many students this registration number resolves to. Used only to feed a
// server-side log — the caller must never report the result to the browser.
export async function countStudentsMatching(supabase: any, reg: string): Promise<number> {
  const { count, error } = await supabase
    .from("students")
    .select("id", { count: "exact", head: true })
    .or(regFilter(reg))
    .or(ACTIVE_STATUS_FILTER)
    .limit(1);
  if (error) throw new Error("student lookup failed");
  return count ?? 0;
}

// Resolves a registration number to the row it belongs to, or null.
//
// Only ever used to decide whether an SMS can be delivered, and that decision is
// never reported to the browser: the whole point of this helper is that the
// caller must not be able to turn it into an answer.
export async function resolveStudent(
  supabase: any,
  reg: string,
): Promise<{ id: string; phone: string | null } | null> {
  const { data, error } = await supabase
    .from("students")
    .select("id, phone_number")
    .or(regFilter(reg))
    .or(ACTIVE_STATUS_FILTER)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("student lookup failed");
  if (!data) return null;
  return { id: data.id, phone: normalizePhone(data.phone_number) };
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
  return null;
}

export function getSupabase(): any {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, key, { auth: { persistSession: false } });
}

// The pepper is what makes a stolen otp_verifications table useless: without
// it, SHA-256 of a 6-digit code is trivially reversible (a million hashes).
// It is therefore required - a function that runs without one would silently
// store weak hashes, so we refuse to start.
export function getPepper(): string {
  const pepper = Deno.env.get("OTP_PEPPER");
  if (!pepper || pepper.length < 16) {
    throw new Error("OTP_PEPPER not set (needs at least 16 random characters)");
  }
  return pepper;
}

// Stores only a salted SHA-256 hash of the code. The plain code exists in
// this function's memory for the few milliseconds it takes to hand it to the
// SMS provider, and is never written anywhere and never returned.
export async function hashOtp(otp: string, pepper: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(pepper + ":" + otp),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newOtp(): string {
  // crypto.getRandomValues, not Math.random
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
