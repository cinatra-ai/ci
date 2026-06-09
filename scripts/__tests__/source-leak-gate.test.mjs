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

function fixtureLines(tag) {
  const fixture = fs.readFileSync(path.join(import.meta.dirname, "..", "__fixtures__", "source-leak.fixture.txt"), "utf8");
  const out = [];
  for (const line of fixture.split("\n")) {
    const m = line.match(new RegExp(`^${tag}:([A-Z_]+):([\\s\\S]*)$`));
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

test("every fixture HIT line matches its named rule", () => {
  const hits = fixtureLines("HIT");
  for (const [ruleId, payload] of hits) {
    const rule = byId.get(ruleId);
    assert.ok(rule, `fixture references unknown rule ${ruleId}`);
    assert.ok(matchRule(rule, payload) >= 1, `${ruleId} did not match payload: ${JSON.stringify(payload)}`);
  }
  assert.ok(hits.length >= 15, `expected >=15 fixture HIT lines, got ${hits.length}`);
});

test("every fixture MISS line does not match its named rule", () => {
  const misses = fixtureLines("MISS");
  assert.ok(misses.length >= 8, `expected >=8 fixture MISS lines, got ${misses.length}`);
  for (const [ruleId, payload] of misses) {
    const rule = byId.get(ruleId);
    assert.ok(rule, `unknown rule ${ruleId}`);
    assert.equal(matchRule(rule, payload), 0, `${ruleId} should NOT match: ${JSON.stringify(payload)}`);
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
  // Assemble the marker so this test file carries no intact example.
  fs.writeFileSync(f, "context: see " + "Phase " + "530 here\n");
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
