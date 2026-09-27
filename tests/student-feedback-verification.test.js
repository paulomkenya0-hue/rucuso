const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('index.html');
const appJs = read('js/app.js');
const verifyStudent = read('supabase/functions/verify-student/index.ts');
const client = read('supabase/supabase-client.js');

test('student verification uses registration number and last name instead of phone OTP', () => {
  assert.match(html, /Uthibitisho wa Mwanafunzi/i);
  assert.match(html, /Ingiza Registration Number yako ili kuanza uthibitisho/i);
  assert.match(html, /Ingiza Jina la Mwisho/i);
  assert.match(html, /Jina la mwisho/i);
  assert.match(html, /THIBITISHA/);
  assert.doesNotMatch(html, /Uthibitisho wa simu|TUMA OTP|THIBITISHA OTP|Namba ya uthibitisho/i);
});

test('verification logic normalizes last-name checks and keeps identity hidden until success', () => {
  assert.match(appJs, /lastName.*trim|trim\(\).*lastName|verifyStudentLastName|last_name_verified/i);
  assert.match(verifyStudent, /function normalizeLastName\(raw: unknown\)[\s\S]{0,120}raw\.trim\(\)\.toLowerCase\(\)/);
  assert.match(verifyStudent, /verified:\s*true/);
  assert.match(client, /verifyStudent\(|last_name:|verifyStudentLastName/i);
  assert.doesNotMatch(appJs, /phone_number.*verified|otp_verified.*true|sendOtp\(/i);
});
