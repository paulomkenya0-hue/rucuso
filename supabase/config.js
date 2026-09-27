// Copy this file to config.js (same folder) and fill in your own project's
// values — Supabase Dashboard -> Project Settings -> API.
//
// The anon key is PUBLIC by design (it ships inside front-end JS everywhere
// Supabase is used) — it is safe as long as Row Level Security is enabled
// on every table, which supabase/schema.sql already does. Never put your
// service_role key here or anywhere in front-end code.
window.RUCUSO_CONFIG = {
  SUPABASE_URL: "https://ratxhdnjigwuehcrzosm.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_-MtWPzaUYUbh5J6ZNIsBbQ_X5iFp-6U",

  // Cloudflare Turnstile PUBLIC site key. Safe to commit — Turnstile site keys
  // are meant to be visible, and the thing that actually matters is the secret
  // key, which is NOT here and never should be.
  //
  // Left empty on purpose. A site key is bound to specific hostnames, so filling
  // this in with a key for another domain would render a widget that never
  // completes and would block every student. While it is empty, the identity
  // check runs on the server-side rate limits alone, which is the real control
  // anyway.
  //
  // To enable: create a Turnstile widget for rucuso.online in the Cloudflare
  // dashboard, put the site key above, then set the secret on the server:
  //   supabase secrets set TURNSTILE_SECRET_KEY=<secret>
  //   supabase functions deploy lookup-student
  TURNSTILE_SITE_KEY: ""
};
