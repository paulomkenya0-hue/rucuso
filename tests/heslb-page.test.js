const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("HESLB admin inline JavaScript parses", () => {
  const html = fs.readFileSync(path.join(root, "admin/heslb/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => scripts.forEach((script) => new vm.Script(script)));
});

test("admin dashboard HESLB permission gate parses", () => {
  const html = fs.readFileSync(path.join(root, "admin/dashboard/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
  assert.ok(scripts.length > 0);
  assert.doesNotThrow(() => scripts.forEach((script) => new vm.Script(script)));
});
