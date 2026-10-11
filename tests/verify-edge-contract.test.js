const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const verifyFile = fs.readFileSync(path.join(root, 'supabase/functions/verify-student/index.ts'), 'utf8');
const clientFile = fs.readFileSync(path.join(root, 'supabase/supabase-client.js'), 'utf8');

test('verification edge function returns structured JSON for invalid input and server failure', () => {
  assert.match(verifyFile, /INVALID_INPUT/);
  assert.match(verifyFile, /INTERNAL_ERROR/);
  assert.match(verifyFile, /success\s*:\s*false/);
  assert.match(verifyFile, /errorResponse\s*\(\s*req\s*,\s*"INVALID_INPUT"|errorResponse\s*\(\s*req\s*,\s*'INVALID_INPUT'/);
  assert.match(verifyFile, /errorResponse\s*\(\s*req\s*,\s*"INTERNAL_ERROR"|errorResponse\s*\(\s*req\s*,\s*'INTERNAL_ERROR'/);
});

test('client maps edge-function errors to friendly student verification messaging', () => {
  assert.match(clientFile, /INVALID_CREDENTIALS|Hatukuweza kuthibitisha|Uthibitisho wa namba ya usajili/);
  assert.doesNotMatch(clientFile, /Edge Function returned a non-2xx status code/);
});
