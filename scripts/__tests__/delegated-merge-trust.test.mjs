import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ROOT = new URL("../../", import.meta.url);
const OWNER = "@groganz";
const TRUST_ANCHORS = [
  "/config/delegated-merge-authorities.json",
  "/scripts/delegated-merge-receipt.mjs",
  "/scripts/truthful-attribution-gate.mjs",
  "/config/high-risk-defaults.json",
  "/.github/workflows/truthful-attribution-gate.yml",
];

test("current delegated authority is revision 3", () => {
  const policy = JSON.parse(fs.readFileSync(new URL("config/delegated-merge-authorities.json", ROOT)));
  assert.deepEqual(policy.authority, {
    id: "grant-8e65116e40c6d1fb440753a9d0c93909ae7e25dff6b5ce74f08ce2ae283d3bbe",
    revision: 3,
    digest: "b3b0c839f2e069b785611f2532447733f90c96ea62d6eb40f11f7bccb49da918",
  });
});

test("delegated-merge trust anchors name the owner alone", () => {
  const lines = fs.readFileSync(new URL(".github/CODEOWNERS", ROOT), "utf8").split("\n");
  const entries = lines.filter(line => line && !line.startsWith("#")).map(line => line.trim().split(/\s+/));
  for (const file of TRUST_ANCHORS) {
    const matches = entries.filter(([candidate]) => candidate === file);
    assert.equal(matches.length, 1, file);
    assert.deepEqual(matches[0].slice(1), [OWNER], file);
  }

  const broad = entries.find(([file]) => file === "/.github/");
  assert.deepEqual(broad, ["/.github/", OWNER, "@megajustice"]);
  assert.ok(lines.findIndex(line => line.startsWith("/.github/workflows/truthful-attribution-gate.yml "))
    > lines.findIndex(line => line.startsWith("/.github/ ")));
});
