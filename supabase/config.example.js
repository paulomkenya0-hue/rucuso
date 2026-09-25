// Copy this file to config.js (same folder) and fill in your own project's
// values — Supabase Dashboard -> Project Settings -> API.
//
// The anon key is PUBLIC by design (it ships inside front-end JS everywhere
// Supabase is used) — it is safe as long as Row Level Security is enabled
// on every table, which supabase/schema.sql already does. Never put your
// service_role key here or anywhere in front-end code.
window.RUCUSO_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-PUBLIC-ANON-KEY"
};
