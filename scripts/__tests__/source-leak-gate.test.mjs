import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRules, scanFile } from "../source-leak-gate.mjs";

// Replicates the scanner's per-line matching for a single rule on a string.
function matchRule(rule, line) {
  const re = new RegExp(rule.re.source, rule.re.flags);
  let m, found = 0;
  while ((m = re.exec(line)) !== null) {
    if (rule.contextExclude && rule.contextExclude(line)) return 0;
    found++;
    if (!re.global) break;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return found;
}

const active = buildRules({}, "default", null);
const byId = new Map(active.map((r) => [r.id, r]));

test("every fixture HIT line matches its named rule", () => {
  const fixture = fs.readFileSync(path.join(import.meta.dirname, "..", "__fixtures__", "source-leak.fixture.txt"), "utf8");
  let checked = 0;
  for (const line of fixture.split("\n")) {
    const m = line.match(/^HIT:([A-Z_]+):([\s\S]*)$/);
    if (!m) continue;
    const [, ruleId, payload] = m;
    const rule = byId.get(ruleId);
    assert.ok(rule, `fixture references unknown rule ${ruleId}`);
    assert.ok(matchRule(rule, payload) >= 1, `${ruleId} did not match payload: ${JSON.stringify(payload)}`);
    checked++;
  }
  assert.ok(checked >= 15, `expected >=15 fixture HIT lines, got ${checked}`);
});

test("negative cases do not match", () => {
  const negatives = [
    ["SLG_MILESTONE_NUMBER", "Phase 1 of the project"],
    ["SLG_MILESTONE_NUMBER", "phased rollout is enabled"],
    ["SLG_MILESTONE_NUMBER", "if (NEXT_PHASE=phase-production-build) {}"],
    ["SLG_MILESTONE_VERSION", '  "version": "6.13.0",'],
    ["SLG_MILESTONE_VERSION", "deprecated in v2.0 of the OpenAPI spec"],
    ["SLG_MILESTONE_SHORTHAND", "padding P256 with p-4 grid"],
    ["SLG_HISTORICAL", "the cache used to be invalidated on write"],
    ["SLG_PLANNING_DOC", "see AGENTS.md#section for details"],
    ["SLG_PROVENANCE", "deprecated in v2.0 of the spec"],
  ];
  for (const [ruleId, line] of negatives) {
    const rule = byId.get(ruleId);
    assert.ok(rule, `unknown rule ${ruleId}`);
    assert.equal(matchRule(rule, line), 0, `${ruleId} should NOT match: ${JSON.stringify(line)}`);
  }
});

test("the gate is clean on its own source (sentinel self-exemption)", () => {
  // Run from repo root so the relative SELF_PATH resolves.
  const findings = scanFile("scripts/source-leak-gate.mjs", active);
  assert.equal(findings.length, 0, `self-scan found ${findings.length}: ${JSON.stringify(findings.slice(0, 5))}`);
});

test("self-exemption does not mask a normal file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slg-"));
  const f = path.join(dir, "note.md");
  fs.writeFileSync(f, "context: see Phase 530 here\n");
  try {
    const findings = scanFile(f, active);
    assert.ok(findings.some((x) => x.rule === "SLG_MILESTONE_NUMBER"), "should flag a normal file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config-driven single-prefix IDs are detected only when configured", () => {
  assert.equal(byId.has("SLG_REQ_ID_SINGLE"), false, "default profile must not ship project-specific prefixes");
  const withCfg = buildRules({ reqIdSinglePrefixes: ["ABC"] }, "default", null);
  const single = withCfg.find((r) => r.id === "SLG_REQ_ID_SINGLE");
  assert.ok(single, "config should add SLG_REQ_ID_SINGLE");
  assert.ok(matchRule(single, "see ABC-12 in the tracker") >= 1, "should match configured prefix");
});
