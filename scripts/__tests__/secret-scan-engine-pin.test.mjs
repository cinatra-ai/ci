import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "../lib/vendor/js-yaml/js-yaml.mjs";

// TruffleHog before 3.97.7 walks `git log <head>` and stops at the first commit equal to the
// --since-commit base. On a PR head that merged its base branch, that base sits in the middle of
// the walk, so PR commits dated before it are never scanned and the scan still exits 0.
// Upstream fixed it in trufflesecurity/trufflehog#5325 (merge dc2edce2), first released in 3.97.7:
// the engine now asks git for the real base..head range. (3.95.5 also missed a value on the line after
// a line longer than 64 KiB; 3.97.7 finds it.)
const FIRST_FIXED = [3, 97, 7];

function workflow(name) {
  return load(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
}

function semver(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text));
  assert.ok(m, `engine version ${JSON.stringify(text)} is not an exact X.Y.Z pin`);
  return m.slice(1).map(Number);
}

function atLeast(v, min) {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

function gateStep() {
  const steps = workflow("secret-scan-gate").jobs["secret-scan-gate"].steps;
  const step = steps.find(s => typeof s.uses === "string" && s.uses.startsWith("trufflesecurity/trufflehog@"));
  assert.ok(step, "secret-scan-gate has no trufflesecurity/trufflehog step");
  return step;
}

function sweepVersion() {
  const image = workflow("secret-scan-sweep").jobs.sweep.env.TRUFFLEHOG_IMAGE;
  const m = /^ghcr\.io\/trufflesecurity\/trufflehog:([^@\s]+)$/.exec(image);
  assert.ok(m, `sweep image ${JSON.stringify(image)} is not a version-tagged trufflehog image`);
  return m[1];
}

test("secret-scan-gate: the TruffleHog action stays pinned to a full commit SHA", () => {
  assert.match(gateStep().uses, /^trufflesecurity\/trufflehog@[0-9a-f]{40}$/);
});

test("secret-scan-gate: the engine pin includes the merged-base range fix (>= 3.97.7)", () => {
  const v = semver(gateStep().with.version);
  assert.ok(atLeast(v, FIRST_FIXED),
    `engine ${v.join(".")} predates ${FIRST_FIXED.join(".")}: --since-commit skips PR commits on a branch that merged its base`);
});

test("secret-scan-sweep: the engine image is the same pinned version as the gate", () => {
  assert.equal(sweepVersion(), String(gateStep().with.version));
  assert.ok(atLeast(semver(sweepVersion()), FIRST_FIXED));
});
