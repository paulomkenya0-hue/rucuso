const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("bulk SMS reuses one provider module and reads credentials from secrets only", () => {
  const sms = read("supabase/functions/_shared/sms.ts");
  assert.match(sms, /api\.beem\.africa\/v1\/sms/);
  assert.match(sms, /api\.africastalking\.com\/version1\/messaging/);
  assert.match(sms, /Deno\.env\.get\("SMS_API_KEY"\)/);
  assert.match(sms, /Deno\.env\.get\("SMS_SENDER_ID"\)/);
  assert.match(sms, /export const MAX_BULK_MESSAGE_CHARS/);
  assert.match(sms, /export async function sendSms/);
  // No hard-coded credential-shaped value anywhere in the module.
  assert.doesNotMatch(sms, /authorization["'\s:]+["'`][A-Za-z0-9+/=_-]{20,}/i);

  // The OTP function must keep its own copy: its test rewrites that file's
  // imports, so routing it through this shared module would break the loader.
  const otp = read("supabase/functions/send-otp/index.ts");
  assert.doesNotMatch(otp, /_shared\/sms\.ts/);
});

test("requireHeslbManager mirrors is_heslb_manager() for the service-role path", () => {
  const admin = read("supabase/functions/_shared/admin.ts");
  assert.match(admin, /export async function requireHeslbManager/);
  assert.match(admin, /profile\.role === "super_admin"/);
  assert.match(admin, /profile\.role !== "leader" && profile\.role !== "admin"/);
  assert.match(admin, /manage_heslb_beneficiaries/);
  assert.match(admin, /ministry_id/);
  // The same normalized names the SQL function accepts.
  assert.match(admin, /mikoponauwezeshaji/);
  assert.match(admin, /wizarayamikoponauwezeshaji/);
  assert.match(admin, /loansandempowerment/);
  assert.match(admin, /\.replace\(\/\[\^a-z0-9\]\/g, ""\)/);
});

test("send-bulk-sms is guarded, bounded, and only texts registered numbers", () => {
  const edge = read("supabase/functions/send-bulk-sms/index.ts");

  // Authorization runs before any provider call.
  assert.match(edge, /await requireHeslbManager\(req/);
  assert.ok(
    edge.indexOf("requireHeslbManager(req") < edge.indexOf("sendSms("),
    "authorization must precede sending",
  );

  // A per-call cap so one request cannot run past the function timeout.
  assert.match(edge, /const MAX_RECIPIENTS_PER_CALL = (\d+)/);
  const cap = Number(edge.match(/const MAX_RECIPIENTS_PER_CALL = (\d+)/)[1]);
  assert.ok(cap > 0 && cap <= 500, "recipient cap should be a small positive number");

  // Recipients are checked against the register, not trusted as sent.
  assert.match(edge, /from\("heslb_beneficiaries"\)/);
  assert.match(edge, /\.in\("phone", phones\)/);

  // Message length is bounded on the server, not just in the composer.
  assert.match(edge, /MAX_BULK_MESSAGE_CHARS/);
  assert.match(edge, /INVALID_MESSAGE/);
});

test("the bulk SMS audit row carries counts and no personal data", () => {
  const edge = read("supabase/functions/send-bulk-sms/index.ts");
  const call = edge.match(/await logAudit\(([\s\S]*?)\);\n/);
  assert.ok(call, "expected a logAudit call");
  assert.match(call[1], /recipients=/);
  assert.match(call[1], /sent=/);
  assert.doesNotMatch(call[1], /\bmessage\b/);
  assert.doesNotMatch(call[1], /\bphone\b/);
});

test("supabase-client exposes sendBulkSms over the send-bulk-sms function", () => {
  const api = read("supabase/supabase-client.js");
  assert.match(api, /async sendBulkSms\(message, phones\)/);
  assert.match(api, /functions\.invoke\("send-bulk-sms",\s*\{/);
});

test("the composer page is gated to the HESLB managers and sends in batches", () => {
  const page = read("admin/sms/index.html");
  assert.match(page, /requireRole\(\["super_admin", "admin", "leader"\]/);
  assert.match(page, /rpc\("is_heslb_manager"\)/);
  assert.match(page, /API\.sendBulkSms\(/);
  assert.match(page, /const BATCH_SIZE = (\d+)/);
  // Active-by-default, matching the recipients the register considers current.
  assert.match(page, /id="filterStatus"[^>]*><option value="active" selected/);
  assert.match(page, /rel="icon"/);
});

test("leadership directory lays tiers out as columns, highest rank leftmost", () => {
  const app = read("js/app.js");
  assert.doesNotMatch(app, /leadertier|leadgrid/);
  assert.match(app, /class="leadcol"/);
  assert.match(app, /class="leadcol__title"/);
  assert.match(app, /class="leadcol__stack"/);

  const html = read("index.html");
  assert.match(html, /class="leadcolumns" id="leaderGrid"/);
  assert.doesNotMatch(html, /class="leadgrid"/);

  const css = read("css/portal.css");
  assert.match(css, /\.leadcolumns\s*\{[^}]*grid-auto-flow:\s*column/s);
  assert.doesNotMatch(css, /\.leadertier|\.leadgrid/);
});
