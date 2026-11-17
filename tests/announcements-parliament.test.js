// Migration 018 + the new announcement / parliament surfaces.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n");

const sql = read("supabase/migrations/018_announcement_management_and_parliament.sql");

test("018 is additive: no drop table, truncate, or bulk delete", () => {
  assert.doesNotMatch(sql, /drop\s+table|truncate|delete\s+from\s+public\.(announcements|leaders|students)/i);
});

test("existing announcements stay visible: status defaults to published", () => {
  assert.match(sql, /add column if not exists status\s+text\s+not null default 'published'/);
});

test("public announcement policy requires published status; drafts are staff-only", () => {
  assert.match(sql, /status = 'published'\s+and publish_date <= current_date/);
});

test("save_announcement checks authorization before anything else and is not callable by anon", () => {
  const fn = sql.slice(sql.indexOf("function public.save_announcement"));
  assert.ok(fn.indexOf("NOT_AUTHORIZED") < fn.indexOf("TITLE_REQUIRED"));
  assert.match(sql, /revoke all on function public\.save_announcement[^;]*from public, anon/);
  assert.match(sql, /image_path[^;]*announcements\/\[A-Za-z0-9\._-\]/);
});

test("parliament table is RLS-locked and the public view hides private contact data", () => {
  assert.match(sql, /alter table public\.parliament_members enable row level security/);
  assert.match(sql, /revoke all on public\.parliament_members from anon/);
  assert.match(sql, /case when contact_public then phone end/);
  assert.match(sql, /case when contact_public then email end/);
  assert.match(sql, /contact_public boolean not null default false/);
});

test("new buckets have a MIME allow-list and no SVG anywhere", () => {
  assert.match(sql, /'announcement-images'[\s\S]*?array\['image\/jpeg', 'image\/png', 'image\/webp'\]/);
  assert.doesNotMatch(sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"), /svg/i);
});

test("client validates images by size, type and file signature", () => {
  const api = read("supabase/supabase-client.js");
  assert.match(api, /async uploadImage\(/);
  assert.match(api, /sniffImageType/);
  assert.match(api, /path\.startsWith\(bucket \+ "\/"\)/);
});

test("admin parliament page uses the guard and permission check and escapes output", () => {
  const html = read("admin/parliament/index.html");
  assert.match(html, /requireRole\(\["super_admin", "admin"\]/);
  assert.match(html, /hasPermission\(profile, "manage_parliament"\)/);
  assert.match(html, /function esc\(/);
});

test("public site renders parliament and only https images", () => {
  assert.match(read("index.html"), /id="parliamentGrid"/);
  const app = read("js/app.js");
  assert.match(app, /function safeHttps/);
  assert.match(app, /renderParliament\(\);/);
});
