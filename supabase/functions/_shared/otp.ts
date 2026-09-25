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
