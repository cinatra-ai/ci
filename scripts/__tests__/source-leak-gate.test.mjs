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

test("SLG_PRIVATE_ENG_REF ships in the default profile", () => {
  assert.ok(byId.has("SLG_PRIVATE_ENG_REF"), "private-eng-ref rule must be a default rule (no config needed)");
});

test("SLG_PRIVATE_ENG_REF flags every private-tracker reference form", () => {
  const rule = byId.get("SLG_PRIVATE_ENG_REF");
  const hits = [
    "rationale in eng#231 here",
    "// (eng#119 §7 step 6 rollout)",
    "per ratified spec cinatra-engineering#119 (re-scopes #116)",
    "see cinatra-ai/cinatra-engineering#56 form",
    "filed under cinatra-ai/engineering tracker",
    "fixed in cinatra-ai/engineering#309",
    "https://github.com/cinatra-ai/engineering/issues/343",
    "see engineering/issues/343 directly", // the bare URL-tail form, tested independently
  ];
  for (const line of hits) {
    assert.ok(matchRule(rule, line) >= 1, `should flag: ${JSON.stringify(line)}`);
  }
});

test("SLG_PRIVATE_ENG_REF does NOT flag public-repo references", () => {
  const rule = byId.get("SLG_PRIVATE_ENG_REF");
  const misses = [
    "public ref cinatra#231 stays",
    "public ref cinatra-cli#61 stays",
    "full public path cinatra-ai/cinatra#231",
    "the engineering team shipped this feature",
    "reverse-engineering the protocol",
    "https://github.com/cinatra-ai/cinatra/issues/255",
    // Repo-token-boundary look-alikes (JS `\b` would false-positive on these):
    "see cinatra-ai/engineering-foo for the helper", // hyphen after `engineering`
    "the cinatra-ai/engineering_tools dir",          // underscore after `engineering`
    "cinatra-ai/engineeringx is unrelated",          // letter after `engineering`
    "reverse-engineering/issues/ is a folder",       // hyphen-prefixed `engineering`
    "the myeng#5 token is unrelated",                // alnum before `eng#`
    "a reeng#5 marker",                              // alnum before `eng#`
  ];
  for (const line of misses) {
    assert.equal(matchRule(rule, line), 0, `should NOT flag: ${JSON.stringify(line)}`);
  }
});

test("SLG_PRIVATE_ENG_REF can be allowlisted on a single line via config.lineExcludes", () => {
  // A deliberately-public reference is excused by the same lineExcludes
  // mechanism the other rules honor (full-line-anchored so it cannot mask a
  // token elsewhere on the line).
  const withAllow = buildRules(
    { lineExcludes: ["^// PUBLIC-OK: see cinatra-ai/engineering for the protocol$"] },
    "default",
    null,
  );
  const rule = withAllow.find((r) => r.id === "SLG_PRIVATE_ENG_REF");
  assert.equal(matchRule(rule, "// PUBLIC-OK: see cinatra-ai/engineering for the protocol"), 0, "allowlisted line is excused");
  assert.ok(matchRule(rule, "// not allowlisted: see cinatra-ai/engineering here") >= 1, "a different line still flags");
});

test("SLG_PRIVATE_REPO_REF ships in the default profile", () => {
  assert.ok(byId.has("SLG_PRIVATE_REPO_REF"), "private-repo-ref rule must be a default rule (no config needed)");
});

test("SLG_PRIVATE_REPO_REF flags bare private-repo path forms", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  const hits = [
    "tokens live in cinatra-ai/design here",
    "see cinatra-ai/marketplace#12 for the submission",
    "https://github.com/cinatra-ai/website/issues/4",
    "filed in cinatra-ai/cinatra-business tracker",
    "scaffold from cinatra-ai/create-cinatra-extension",
    "see cinatra-ai/renovate-config for the preset",
    "archived in cinatra-ai/cinatra-poc legacy",
  ];
  for (const line of hits) {
    assert.ok(matchRule(rule, line) >= 1, `should flag: ${JSON.stringify(line)}`);
  }
});

test("SLG_PRIVATE_REPO_REF does NOT flag the @cinatra-ai npm scope, cinatra-ai/ops, public repos, or look-alikes", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  const misses = [
    // The vendored npm workspace package scope — load-bearing negative lookbehind:
    'import { x } from "@cinatra-ai/design";',
    'const m = require("@cinatra-ai/marketplace-sdk");',
    // cinatra-ai/ops is a REQUIRED functional dispatch target, deliberately excluded:
    "uses: cinatra-ai/ops/.github/workflows/deploy.yml",
    "repository: cinatra-ai/ops",
    // engineering is owned by SLG_PRIVATE_ENG_REF, not this rule:
    "filed under cinatra-ai/engineering tracker",
    // public repos stay:
    "public ref cinatra-ai/cinatra#231 stays",
    "https://github.com/cinatra-ai/cinatra-cli/issues/61",
    // token-boundary look-alikes:
    "see cinatra-ai/design-system-foo for the helper", // hyphen after name
    "the cinatra-ai/website_tools dir",                // underscore after name
    "cinatra-ai/marketplacex is unrelated",            // letter after name
  ];
  for (const line of misses) {
    assert.equal(matchRule(rule, line), 0, `should NOT flag: ${JSON.stringify(line)}`);
  }
});

test("SLG_PRIVATE_DESIGN_PHRASE flags descriptive design-repo prose", () => {
  const rule = byId.get("SLG_PRIVATE_DESIGN_PHRASE");
  const hits = [
    "pull tokens from the design repository",
    "the legacy design repositriy typo form",
    "edit the design repo to add a token",
  ];
  for (const line of hits) {
    assert.ok(matchRule(rule, line) >= 1, `should flag: ${JSON.stringify(line)}`);
  }
});

test("SLG_PRIVATE_DESIGN_PHRASE does NOT flag the public-safe phrasing", () => {
  const rule = byId.get("SLG_PRIVATE_DESIGN_PHRASE");
  const misses = [
    "pull tokens from the Cinatra design system",
    "the design team owns the tokens",
    "redesign repository layout later", // not the standalone phrase
  ];
  for (const line of misses) {
    assert.equal(matchRule(rule, line), 0, `should NOT flag: ${JSON.stringify(line)}`);
  }
});
