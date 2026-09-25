-- ============================================================
-- RUCUSO — migration 003: support for the RUCUSO AI Edge Function
--
-- Run this AFTER 002_production_backend.sql, in the Supabase SQL Editor.
-- Run it before deploying supabase/functions/rucuso-ai.
--
-- What it does:
--   * ai_queries - one row per question asked. Doubles as the rate-limit
--     ledger and as a small audit trail ("who asked the AI what").
--   * The table has RLS enabled and NO policies, so the browser cannot read
--     or write it at all. Only the rucuso-ai Edge Function touches it, with
--     the service_role key.
--
-- Nothing here is required by the rest of the app: if the AI is never
-- deployed, this table simply sits empty and the front end falls back to its
-- built-in rule-based answers.
-- ============================================================

create table if not exists ai_queries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,
  client_key text not null,     -- staff: their auth uid; visitor: hash of ip+user-agent
  role       text not null,     -- visitor | user | staff
  question   text not null,
  created_at timestamptz not null default now()
);

-- The rate-limit queries are always "count rows for this client_key since X".
create index if not exists ai_queries_client_created_idx
  on ai_queries (client_key, created_at desc);

alter table ai_queries enable row level security;

-- Deliberately no policies. A staff member can see what the AI was asked in
-- the app's own admin screens via the service role; granting a read policy
-- would mean exposing the questions of every visitor to every staff account,
-- which is not something this table needs.
revoke all on ai_queries from anon, authenticated;
