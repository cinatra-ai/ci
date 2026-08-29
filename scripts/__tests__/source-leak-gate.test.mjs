import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildRules, scanFile, RULES,
  setProbeFetch, makeProbeContext, resolveRepoVisibility, resolveProbeFindings,
  loadKnownPublicRepos, verifyPublicRepoCache, serializePublicRepoCache,
  normalizeRepoName, orgPathRepoName, functionalRefCovers,
  PRIVATE_REPO_NAMES, PROBE_EXEMPT_NAMES, FUNCTIONAL_REPO_REFS,
  PROBE_RULE_ID, PROBE_ERROR_RULE_ID, PROBE_BUDGET_RULE_ID,
  PROBE_MAX_NAMES, PUBLIC_CACHE_TTL_DAYS, isValidRepoName, REPO_NAME_MAX,
  readUsesPins, canonicalUsesTarget, legitimateActionValues, isTrackedInScannedTree,
  parseYamlDocuments, assertPrototypesUnpolluted, snapshotPrototypes, hasPrototypeKey,
  setYamlLoader, isPlainObject, isPlainArray, ownItems, own, PROTOTYPE_KEYS, PROTOTYPE_POLLUTION_ERROR,
} from "../source-leak-gate.mjs";
// The VENDORED parser, imported directly by the tests that have to inspect what
// the PARSER produced rather than what the engine decided about it, and by the
// hostile-loader tests, which parse honestly and misbehave around the parse.
import { loadAll as jsYamlLoadAll } from "../lib/vendor/js-yaml/js-yaml.mjs";

// NAMING CONVENTION. Real private repository names appear ONLY where a test
// actually exercises the real list — list membership, the per-match carve-outs
// for the dispatch targets, the public/private twin split, and the places where
// tokenization has to agree with the list. Everything else — the probe, the
// budget, the cache — uses SYNTHETIC names, because those behaviours are
// name-independent and a real name there would be decoration. (The names
// themselves are publishable either way; see the declassification statement in
// the engine. This convention keeps the tests legible about WHY a real name is
// present, not about whether it may be.)

// Replicates the scanner's per-line matching for a single rule on a string —
// including matchExclude, which is per MATCH (contextExclude is per LINE), so a
// line carrying a required functional form AND a leaked one scores 1, not 0.
//
// It is the GRAMMAR harness, and it says so out loud: it hands the rule a
// workflow path and a legitimate-value set that answers YES to everything, so
// what it measures is the carve-out GRAMMAR alone — does this spelling read as a
// machine form? The STRUCTURAL half — whether the file really declares that
// value at a GitHub Actions location — is a property of a whole document and is
// exercised through scanFile against real files further down. Splitting them is
// what keeps each test about one thing; a grammar case would otherwise have to
// ship a whole workflow around every line.
const EVERY_VALUE_IS_LEGITIMATE = { has: () => true };
const GRAMMAR_FILE = ".github/workflows/grammar.yml";
function matchRule(rule, line, { file = GRAMMAR_FILE, legitValues = EVERY_VALUE_IS_LEGITIMATE } = {}) {
  const re = new RegExp(rule.re.source, rule.re.flags);
  let m, found = 0;
  while ((m = re.exec(line)) !== null) {
    if (rule.contextExclude && rule.contextExclude(line)) return 0;
    if (!(rule.matchExclude && rule.matchExclude(m[0], line, m.index, file, { legitValues }))) found++;
    if (!re.global) break;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return found;
}

const active = buildRules({}, "default", null);
const byId = new Map(active.map((r) => [r.id, r]));

// `public-strict` is the SUPERSET profile: it activates every base ("default")
// rule PLUS the public-strict-only rules. Fixture lines for a public-strict-only
// rule (and the stricter public-repo assertions) resolve through this map.
const strictActive = buildRules({}, "public-strict", null);
const strictById = new Map(strictActive.map((r) => [r.id, r]));

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
    const rule = strictById.get(ruleId);
    assert.ok(rule, `fixture references unknown rule ${ruleId}`);
    assert.ok(matchRule(rule, payload) >= 1, `${ruleId} did not match payload: ${JSON.stringify(payload)}`);
  }
  assert.ok(hits.length >= 15, `expected >=15 fixture HIT lines, got ${hits.length}`);
});

test("every fixture MISS line does not match its named rule", () => {
  const misses = fixtureLines("MISS");
  assert.ok(misses.length >= 8, `expected >=8 fixture MISS lines, got ${misses.length}`);
  for (const [ruleId, payload] of misses) {
    const rule = strictById.get(ruleId);
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
    "rationale in eng#0 here",
    "// (eng#0 §7 step 6 rollout)",
    "per ratified spec cinatra-engineering#0 (re-scopes #0)",
    "see cinatra-ai/cinatra-engineering#0 form",
    "filed under cinatra-ai/engineering tracker",
    "fixed in cinatra-ai/engineering#0",
    "https://github.com/cinatra-ai/engineering/issues/0",
    "see engineering/issues/0 directly", // the bare URL-tail form, tested independently
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
    "the myeng#0 token is unrelated",                // alnum before `eng#`
    "a reeng#0 marker",                              // alnum before `eng#`
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

test("SLG_PRIVATE_ENG_REF_STRICT is scoped to the public-strict profile ONLY", () => {
  // The full-form strict rule must NOT be active under the base profile or the
  // profiles PRIVATE repos run (default, ops-docs, ts-monorepo, ...), so their
  // org-sanctioned `engineering#<n>` cross-repo refs keep passing there. It must
  // be active ONLY under `public-strict`.
  assert.equal(byId.has("SLG_PRIVATE_ENG_REF_STRICT"), false, "must be absent under the default profile");
  for (const p of ["default", "ops-docs", "ts-monorepo", "php-wp-plugin", "drupal-module"]) {
    const ids = new Set(buildRules({}, p, null).map((r) => r.id));
    assert.equal(ids.has("SLG_PRIVATE_ENG_REF_STRICT"), false, `must be absent under ${p}`);
  }
  assert.equal(strictById.has("SLG_PRIVATE_ENG_REF_STRICT"), true, "must be present under public-strict");
});

test("public-strict is a SUPERSET: every base (default) rule stays active", () => {
  for (const id of byId.keys()) {
    assert.ok(strictById.has(id), `public-strict dropped base rule ${id}`);
  }
});

test("removing the default short-circuit does NOT drop any built-in rule under default", () => {
  // Regression lock for the filter change: every built-in rule is a base rule
  // (carries "default"), so the `default` profile still runs the full base set.
  const defaultIds = new Set(active.map((r) => r.id));
  for (const r of RULES) {
    // Probe rules are gated by MODE, not by profile — they are opted in with
    // buildRules(..., { probe: true }) and asserted separately.
    if (r.probe) continue;
    // RULES entries with no explicit `profiles` default to universal (incl. default).
    if (!r.profiles || r.profiles.includes("default")) {
      assert.ok(defaultIds.has(r.id), `base rule ${r.id} must stay active under default`);
    }
  }
});

test("under a non-strict profile the sanctioned bare `engineering#<n>` form passes ALL rules", () => {
  // The point of the scoping: a PRIVATE repo cites the tracker as `engineering#<n>`
  // and NO active rule may flag it under the profiles those repos run.
  const sanctioned = "see engineering#0 for the rationale";
  for (const p of ["default", "ops-docs"]) {
    const rules = buildRules({}, p, null);
    const total = rules.reduce((n, r) => n + matchRule(r, sanctioned), 0);
    assert.equal(total, 0, `no rule may flag the sanctioned bare form under ${p}`);
  }
  // …but under public-strict it IS flagged (by the strict rule).
  const strictTotal = strictActive.reduce((n, r) => n + matchRule(r, sanctioned), 0);
  assert.ok(strictTotal >= 1, "public-strict must flag the bare form");
});

test("SLG_PRIVATE_ENG_REF_STRICT flags the bare full-form private-tracker references", () => {
  const rule = strictById.get("SLG_PRIVATE_ENG_REF_STRICT");
  const hits = [
    "see engineering#0 for the rationale",
    "filed engineering#0 upstream",
    "regressed by engineering#0 last week",
    "tracked in the cinatra-engineering repo",
  ];
  for (const line of hits) {
    assert.ok(matchRule(rule, line) >= 1, `should flag: ${JSON.stringify(line)}`);
  }
});

test("SLG_PRIVATE_ENG_REF_STRICT does NOT flag public refs, look-alikes, or the prefixed forms the universal rule owns", () => {
  const rule = strictById.get("SLG_PRIVATE_ENG_REF_STRICT");
  const misses = [
    "the engineering team shipped it",                 // common word, no #<n>
    "software engineering is a discipline",            // common word
    "reverse-engineering#0 is unrelated",              // hyphen before
    "re-engineering#0 marker",                          // hyphen before
    "bioengineering#0 domain token",                    // letter before
    "cinatra-ai/engineering#0 (universal rule owns)", // slash before -> universal's job, not double-flagged
    "legacy note per cinatra-engineering#0",          // trailing #<n> -> universal's job, NOT double-flagged
    "cinatra-engineering-tools is a directory",         // trailing hyphen after the name
    'import x from "@cinatra-ai/engineering";',         // @-scope before
    "public ref cinatra#231 stays",                     // public repo
    "public ref cinatra-cli#61 stays",                  // public repo
  ];
  for (const line of misses) {
    assert.equal(matchRule(rule, line), 0, `should NOT flag: ${JSON.stringify(line)}`);
  }
});

test("SLG_PRIVATE_ENG_REF_STRICT can be allowlisted on a single line via config.lineExcludes", () => {
  const withAllow = buildRules(
    { lineExcludes: ["^// PUBLIC-OK: historical note re engineering#0$"] },
    "public-strict",
    null,
  );
  const rule = withAllow.find((r) => r.id === "SLG_PRIVATE_ENG_REF_STRICT");
  assert.equal(matchRule(rule, "// PUBLIC-OK: historical note re engineering#0"), 0, "allowlisted line is excused");
  assert.ok(matchRule(rule, "a different engineering#0 reference") >= 1, "a different line still flags");
});

test("the gate is clean on its own source under public-strict (sentinel self-exemption)", () => {
  const findings = scanFile("scripts/source-leak-gate.mjs", strictActive);
  assert.equal(findings.length, 0, `self-scan(public-strict) found ${findings.length}: ${JSON.stringify(findings.slice(0, 5))}`);
});

test("SLG_PRIVATE_REPO_REF ships in the default profile", () => {
  assert.ok(byId.has("SLG_PRIVATE_REPO_REF"), "private-repo-ref rule must be a default rule (no config needed)");
});

test("SLG_PRIVATE_REPO_REF flags bare private-repo path forms", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  const hits = [
    "tokens live in cinatra-ai/design here",
    "see cinatra-ai/marketplace#0 for the submission",
    "https://github.com/cinatra-ai/website/issues/0",
    "filed in cinatra-ai/cinatra-business tracker",
    "scaffold from cinatra-ai/create-cinatra-extension",
    "see cinatra-ai/renovate-config for the preset",
    "archived in cinatra-ai/cinatra-poc legacy",
  ];
  for (const line of hits) {
    assert.ok(matchRule(rule, line) >= 1, `should flag: ${JSON.stringify(line)}`);
  }
});

test("the npm-scope carve-out never excuses a name on the PRIVATE list", () => {
  // The carve-out exists because `@<org>/<x>` names a vendored workspace
  // package. That is a reason to spare a name nobody has classified — it is not
  // a reason to write a PRIVATE repository's name into public source, and no
  // package carries one of those names. So the scope is transparent to the
  // private list and opaque to everything else.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    'import { x } from "@cinatra-ai/design";',
    "@cinatra-ai/engineering-proofs-private in a dependency list",
    'import x from "@cinatra-ai/engineering-claude-plugin";',
  ]) {
    assert.equal(matchRule(rule, line), 1, `a private name under an npm scope is a leak: ${JSON.stringify(line)}`);
  }
  // …while every OTHER @-scoped name keeps costing nothing, in both lanes.
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  for (const line of [
    'const m = require("@cinatra-ai/marketplace-sdk");',
    'import x from "@cinatra-ai/cinatra-cli";',
    'import { s } from "@cinatra-ai/sdk-extensions";',
  ]) {
    assert.equal(matchRule(rule, line), 0, `an unlisted package scope stays excused: ${JSON.stringify(line)}`);
    assert.equal(matchRule(probe, line), 0, `the probe never nominates a package scope: ${JSON.stringify(line)}`);
  }
});

test("SLG_PRIVATE_REPO_REF does NOT flag cinatra-ai/ops, public repos, or look-alikes", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  const misses = [
    // cinatra-ai/ops is a REQUIRED functional dispatch target, deliberately excluded:
    "uses: cinatra-ai/ops/.github/workflows/deploy.yml@main",
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

test("SLG_PRIVATE_REPO_REF flags the private proof-image twin and the other private repos", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  const hits = [
    "shots filed in cinatra-ai/engineering-proofs-private",
    "https://github.com/cinatra-ai/engineering-proofs-private/blob/main/shot.png",
    "https://raw.githubusercontent.com/cinatra-ai/engineering-proofs-private/main/shot.png",
    "see cinatra-ai/engineering-proofs-private#0 for the shots",
    "the pack in cinatra-ai/engineering-claude-plugin",
    "assets under cinatra-ai/marketing-explainer-video",
    "retired in cinatra-ai/major-release-workflow",
    "retired in cinatra-ai/blog-content-workflow",
  ];
  for (const line of hits) {
    assert.ok(matchRule(rule, line) >= 1, `should flag: ${JSON.stringify(line)}`);
  }
});

test("SLG_PRIVATE_REPO_REF does NOT flag the PUBLIC proof-image twin or the functional theme target", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  const misses = [
    // The PUBLIC twin of the proof-image host: public repos cite it constantly.
    "public host cinatra-ai/engineering-proofs is cited freely",
    "https://github.com/cinatra-ai/engineering-proofs/blob/main/shot.png",
    "https://github.com/cinatra-ai/engineering-proofs/issues/4",
    "see cinatra-ai/engineering-proofs#4 for the picture",
    // Trailing-boundary look-alikes on the private twin's own name:
    "see cinatra-ai/engineering-proofs-private-foo instead",
    "the cinatra-ai/engineering-proofs-private_bak dir",
    // Only the REQUIRED machine forms of a dispatch target are excused:
    "REMOTE=https://github.com/cinatra-ai/wp-theme.git",
    "repository: cinatra-ai/wp-theme",
  ];
  for (const line of misses) {
    assert.equal(matchRule(rule, line), 0, `should NOT flag: ${JSON.stringify(line)}`);
  }
});

test("SLG_PRIVATE_PROOFS_REF ships in the default profile (universal, not strict-only)", () => {
  // The bare name has no sanctioned use in committed source anywhere, so unlike
  // SLG_PRIVATE_ENG_REF_STRICT it is NOT confined to `public-strict`.
  assert.ok(byId.has("SLG_PRIVATE_PROOFS_REF"), "must be a default rule (no config needed)");
  for (const p of ["default", "ops-docs", "ts-monorepo", "php-wp-plugin", "drupal-module", "public-strict"]) {
    const ids = new Set(buildRules({}, p, null).map((r) => r.id));
    assert.ok(ids.has("SLG_PRIVATE_PROOFS_REF"), `must be active under ${p}`);
  }
});

test("SLG_PRIVATE_PROOFS_REF flags the bare private proof-image repository name", () => {
  const rule = byId.get("SLG_PRIVATE_PROOFS_REF");
  const hits = [
    "pictures pushed to engineering-proofs-private",
    "opened engineering-proofs-private#0 for the shots",
    "see engineering-proofs-private/issues/0 directly",
    "engineering-proofs-private holds the originals",
    "(engineering-proofs-private) is where they land",
  ];
  for (const line of hits) {
    assert.ok(matchRule(rule, line) >= 1, `should flag: ${JSON.stringify(line)}`);
  }
});

test("SLG_PRIVATE_PROOFS_REF does NOT flag the public twin, look-alikes, or the path form the sibling rule owns", () => {
  const rule = byId.get("SLG_PRIVATE_PROOFS_REF");
  const misses = [
    // The PUBLIC twin — the whole point of demanding the full suffix:
    "public host engineering-proofs is cited freely",
    "https://github.com/cinatra-ai/engineering-proofs/blob/main/shot.png",
    // Longer identifiers on either boundary:
    "the myengineering-proofs-private token is unrelated",
    "a re-engineering-proofs-private marker",
    "see engineering-proofs-private-foo instead",
    "the engineering-proofs-private_bak dir",
    // The org-path form belongs SOLELY to SLG_PRIVATE_REPO_REF -> no double-flag:
    "cinatra-ai/engineering-proofs-private is the path form",
    "https://github.com/cinatra-ai/engineering-proofs-private/blob/main/shot.png",
    // The @-scoped form is the org-path form with a scope in front, so it too
    // belongs to SLG_PRIVATE_REPO_REF alone — this rule owns the BARE name.
    'import x from "@cinatra-ai/engineering-proofs-private";',
    "@cinatra-ai/engineering-proofs-private in a dependency list",
    // The public twin is untouched under a scope as well.
    'import x from "@cinatra-ai/engineering-proofs";',
    'import x from "@cinatra-ai/engineering-proofs-private-foo";',
    // The ordinary word, and the private tracker the eng rules own:
    "the engineering team shipped it",
    "filed under cinatra-ai/engineering tracker", // source-leak-allow: deliberate test input
  ];
  for (const line of misses) {
    assert.equal(matchRule(rule, line), 0, `should NOT flag: ${JSON.stringify(line)}`);
  }
});

test("exactly ONE rule owns each private proof-image reference form (no double-flag)", () => {
  // The path form is SLG_PRIVATE_REPO_REF's; the bare name is
  // SLG_PRIVATE_PROOFS_REF's. Neither may claim the other's form, under either
  // the base profile or the strict superset.
  for (const profile of ["default", "public-strict"]) {
    const rules = buildRules({}, profile, null);
    for (const form of [
      "cinatra-ai/engineering-proofs-private",
      "engineering-proofs-private",
      "@cinatra-ai/engineering-proofs-private",
    ]) {
      const total = rules.reduce((n, r) => n + matchRule(r, form), 0);
      assert.equal(total, 1, `exactly one rule must flag ${JSON.stringify(form)} under ${profile}`);
    }
  }
});

test("the PUBLIC proof-image twin passes ALL rules under every profile", () => {
  // It is public and cited constantly; no profile may flag it, in any form.
  const publicForms = [
    "cinatra-ai/engineering-proofs",
    "engineering-proofs",
    "https://github.com/cinatra-ai/engineering-proofs/blob/main/shot.png",
    "https://github.com/cinatra-ai/engineering-proofs/issues/4",
    "embed the picture from cinatra-ai/engineering-proofs",
  ];
  for (const profile of ["default", "ops-docs", "public-strict"]) {
    const rules = buildRules({}, profile, null);
    for (const form of publicForms) {
      const total = rules.reduce((n, r) => n + matchRule(r, form), 0);
      assert.equal(total, 0, `no rule may flag ${JSON.stringify(form)} under ${profile}`);
    }
  }
});

test("SLG_PRIVATE_PROOFS_REF can be allowlisted on a single line via config.lineExcludes", () => {
  const withAllow = buildRules(
    { lineExcludes: ["^// PUBLIC-OK: the twin of engineering-proofs-private$"] },
    "default",
    null,
  );
  const rule = withAllow.find((r) => r.id === "SLG_PRIVATE_PROOFS_REF");
  assert.equal(matchRule(rule, "// PUBLIC-OK: the twin of engineering-proofs-private"), 0, "allowlisted line is excused");
  assert.ok(matchRule(rule, "a different engineering-proofs-private reference") >= 1, "a different line still flags");
});

// --------------------------------------------------------------------------
// The DYNAMIC lane: the repository-visibility probe.
// Every test here installs a stub fetch, so the suite makes no network call and
// stays dependency-free. `calls` records what the stub was actually asked.
// --------------------------------------------------------------------------

function stubFetch(responder) {
  const calls = [];
  setProbeFetch(async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  });
  return calls;
}
function apiResponse(status, body) {
  return { status, json: async () => body };
}
// One nominated candidate, shaped exactly as scanFile emits it.
function candidate(name, extra = {}) {
  return { rule: PROBE_RULE_ID, file: "note.ts", line: 7, column: 1, match: `cinatra-ai/${name}`, snippet: `see cinatra-ai/${name}`, ...extra };
}
function probeCtx(overrides = {}) {
  return makeProbeContext({ token: "t0ken", knownPublic: new Set(), apiBase: "https://api.example.test", ...overrides });
}

test("the probe rule is MODE-gated, never profile-gated", () => {
  // Absent from every profile's static rule set — its regex nominates public
  // repositories too, so it must not run without a resolver behind it.
  for (const p of ["default", "ops-docs", "ts-monorepo", "public-strict"]) {
    const ids = new Set(buildRules({}, p, null).map((r) => r.id));
    assert.equal(ids.has(PROBE_RULE_ID), false, `must be absent under ${p} without the probe opt-in`);
    const probeIds = new Set(buildRules({}, p, null, { probe: true }).map((r) => r.id));
    assert.ok(probeIds.has(PROBE_RULE_ID), `must be present under ${p} with the probe opt-in`);
  }
});

test("the probe rule nominates any org path form, but never the npm scope", () => {
  const rule = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  for (const line of [
    "a brand new cinatra-ai/some-new-repo reference",
    "https://github.com/cinatra-ai/some-new-repo/issues/4",
    "see cinatra-ai/some-new-repo#4 for context",
    "public ref cinatra-ai/cinatra#231 stays",           // nominated, cleared by the API
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `should nominate: ${JSON.stringify(line)}`);
  }
  for (const line of [
    'import { x } from "@cinatra-ai/design";',           // the load-bearing npm-scope carve-out
    'const m = require("@cinatra-ai/marketplace-sdk");',
    "just the cinatra-ai org name with no path",
  ]) {
    assert.equal(matchRule(rule, line), 0, `should NOT nominate: ${JSON.stringify(line)}`);
  }
  // Sentence-final punctuation is not part of the name (it would 404 as a
  // repository that does not exist), but an internal dot is.
  const nameOf = (line) => {
    const re = new RegExp(rule.re.source, rule.re.flags);
    return re.exec(line)[0].split("/")[1];
  };
  assert.equal(nameOf("shipped in cinatra-ai/ci."), "ci");
  assert.equal(nameOf("shipped in cinatra-ai/ci, then."), "ci");
  assert.equal(nameOf("see cinatra-ai/some.repo.js for it"), "some.repo.js");
  assert.equal(nameOf("see cinatra-ai/some-new-repo#4"), "some-new-repo");
});

test("probe: a PUBLIC repository produces no finding", async () => {
  const calls = stubFetch(() => apiResponse(200, { private: false }));
  const out = await resolveProbeFindings([candidate("some-new-repo")], probeCtx());
  assert.deepEqual(out, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/repos\/cinatra-ai\/some-new-repo$/);
  assert.equal(calls[0].init.headers.authorization, "Bearer t0ken");
});

test("probe: a PRIVATE repository (200 private:true) produces a finding", async () => {
  stubFetch(() => apiResponse(200, { private: true }));
  const out = await resolveProbeFindings([candidate("some-new-repo")], probeCtx());
  assert.equal(out.length, 1);
  assert.equal(out[0].rule, PROBE_RULE_ID);
  assert.equal(out[0].match, "cinatra-ai/some-new-repo");
  assert.match(out[0].reason, /private/i);
});

test("probe: a 404 produces a finding (private or nonexistent for this token)", async () => {
  stubFetch(() => apiResponse(404, { message: "Not Found" }));
  const out = await resolveProbeFindings([candidate("invisible-repo")], probeCtx());
  assert.equal(out.length, 1);
  assert.equal(out[0].rule, PROBE_RULE_ID);
  assert.match(out[0].reason, /404/);
});

test("probe: a network error is FAIL-CLOSED, as its own finding naming the cause", async () => {
  stubFetch(() => { throw new Error("ECONNRESET"); });
  const out = await resolveProbeFindings([candidate("some-new-repo")], probeCtx());
  assert.equal(out.length, 1, "a run that cannot verify must never pass the reference");
  assert.equal(out[0].rule, PROBE_ERROR_RULE_ID, "unresolved is a DISTINCT finding, not a leak verdict");
  assert.match(out[0].reason, /ECONNRESET/);
  assert.match(out[0].snippet, /unresolved/);
});

test("probe: a rate limit and a malformed response are fail-closed the same way", async () => {
  for (const [status, body, cause] of [[403, {}, /rate limit/i], [429, {}, /rate limit/i], [200, { name: "x" }, /malformed/i]]) {
    stubFetch(() => apiResponse(status, body));
    const out = await resolveProbeFindings([candidate("some-new-repo")], probeCtx());
    assert.equal(out.length, 1, `status ${status} must produce a finding`);
    assert.equal(out[0].rule, PROBE_ERROR_RULE_ID, `status ${status} must be an unresolved finding`);
    assert.match(out[0].reason, cause);
  }
});

test("probe: a committed-cache hit clears the reference with NO API call", async () => {
  const calls = stubFetch(() => apiResponse(500, {}));
  const ctx = probeCtx({ knownPublic: new Set(["cinatra"]) });
  const out = await resolveProbeFindings([candidate("cinatra")], ctx);
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0, "the cache must be consulted BEFORE any call");
  assert.equal(ctx.calls, 0);
});

test("probe: each distinct name costs exactly one call (memoised per run)", async () => {
  const calls = stubFetch(() => apiResponse(200, { private: true }));
  const ctx = probeCtx();
  const out = await resolveProbeFindings(
    [candidate("repo-a"), candidate("repo-a", { line: 9 }), candidate("repo-b")],
    ctx,
  );
  assert.equal(out.length, 3, "every reference is still reported");
  assert.equal(calls.length, 2, "but only distinct names are fetched");
  assert.equal(ctx.calls, 2);
});

test("probe: the offline rules' names and the functional targets are never probed", async () => {
  const calls = stubFetch(() => apiResponse(200, { private: true }));
  // `ops` and `wp-theme` are named on purpose; every PRIVATE_REPO_NAMES member is
  // already owned by SLG_PRIVATE_REPO_REF, so probing would double-flag it.
  const skipped = ["ops", "wp-theme", "engineering", ...PRIVATE_REPO_NAMES];
  const out = await resolveProbeFindings(skipped.map((n) => candidate(n)), probeCtx());
  assert.deepEqual(out, [], "no probe finding for an exempt or already-owned name");
  assert.equal(calls.length, 0, "and not one API call spent on them");
});

test("PROBE_EXEMPT_NAMES covers the whole offline list (the two stay in step)", () => {
  for (const n of PRIVATE_REPO_NAMES) {
    assert.ok(PROBE_EXEMPT_NAMES.has(n), `${n} is on the offline list but not exempt from the probe`);
  }
  for (const n of ["ops", "wp-theme", "engineering"]) {
    assert.ok(PROBE_EXEMPT_NAMES.has(n), `${n} must stay exempt from the probe`);
  }
});

test("probe: an unauthenticated run sends no authorization header", async () => {
  const calls = stubFetch(() => apiResponse(200, { private: false }));
  await resolveProbeFindings([candidate("some-new-repo")], probeCtx({ token: "" }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, undefined);
});

test("probe: resolveRepoVisibility never returns public without an explicit public answer", async () => {
  for (const [status, body] of [[404, {}], [200, { private: true }], [500, {}], [403, {}], [200, null]]) {
    stubFetch(() => apiResponse(status, body));
    const v = await resolveRepoVisibility("some-new-repo", probeCtx());
    assert.notEqual(v.state, "public", `status ${status} must not resolve public`);
  }
  stubFetch(() => apiResponse(200, { private: false }));
  assert.equal((await resolveRepoVisibility("some-new-repo", probeCtx())).state, "public");
});

test("this repo's own gate configs never exempt the ENGINE whole-file", () => {
  // A whole-file exemption on the engine defeats the sentinel-scoped
  // self-protection it already has: the rule-definition region is skipped by
  // design, and everything OUTSIDE it must still be scanned, or a future leak
  // anywhere else in the file would be silently discarded. This one never comes
  // back — unlike the fixture's, which is time-boxed (next test).
  for (const cfgName of ["source-leak.json", "self-check.json"]) {
    const cfg = JSON.parse(fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "config", cfgName), "utf8",
    ));
    const exempt = new Set(cfg.exemptFileBasenames || []);
    assert.equal(exempt.has("source-leak-gate.mjs"), false,
      `${cfgName} must not exempt the engine whole-file (the sentinel region is the exemption)`);
  }
});

test("a FIXTURE basename exemption exists only while a pin-keyed expiry justifies it", () => {
  // The hermetic self-check runs the CURRENT engine, which skips the fixture by
  // real path — so self-check.json must never carry the exemption at all. The
  // PR/push config drives a PINNED engine out of a separate checkout, where that
  // real-path skip lands on the pinned checkout's own copy; there the exemption
  // is allowed, but only as a debt keyed to the pin that creates it.
  const readCfg = (n) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "config", n), "utf8"));
  assert.equal(new Set(readCfg("self-check.json").exemptFileBasenames || []).has("source-leak.fixture.txt"), false,
    "self-check.json must not exempt the fixture (the engine it runs path-skips it)");

  const cfg = readCfg("source-leak.json");
  const exempt = new Set(cfg.exemptFileBasenames || []);
  const expiry = cfg.exemptFileBasenamesExpiry || {};
  if (!exempt.has("source-leak.fixture.txt")) {
    assert.equal(Object.hasOwn(expiry, "source-leak.fixture.txt"), false,
      "the exemption is gone, so its expiry entry must be gone too");
    return;
  }
  const entry = expiry["source-leak.fixture.txt"];
  assert.ok(entry && entry.untilPin, "the fixture exemption must be keyed to a pin, never open-ended");
  assert.ok(entry.untilPin.uses, "the pin must name the exact `uses:` target, never just the file");
  const pinFile = path.join(import.meta.dirname, "..", "..", entry.untilPin.file);
  const refs = readUsesPins(fs.readFileSync(pinFile, "utf8"))
    .filter((u) => u.target === entry.untilPin.uses)
    .map((u) => u.ref.toLowerCase());
  assert.deepEqual(refs, [String(entry.untilPin.sha).toLowerCase()],
    `${entry.untilPin.file} no longer pins ${entry.untilPin.uses} at the sha the exemption is keyed to — delete the basename AND the expiry entry`);
});

test("the committed public-repos cache parses and holds only confirmed-public names", () => {
  const loaded = loadKnownPublicRepos(path.join(import.meta.dirname, "..", "..", "config", "public-repos.json"));
  assert.ok(loaded.names.size >= 1, "the cache must load");
  // It is a latency cache, never an authority for "private": nothing the offline
  // list calls private, and nothing the probe exempts, may sit in it.
  for (const n of loaded.names) {
    assert.equal(PROBE_EXEMPT_NAMES.has(n), false, `${n} cannot be both cached-public and privately owned`);
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

// --------------------------------------------------------------------------
// Functional dispatch targets: only the REQUIRED machine forms are excused.
// --------------------------------------------------------------------------

test("a dispatch target's required machine forms are excused", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    // The reusable-workflow / action grammar GitHub actually accepts:
    // `<org>/<repo>[/<path>]@<ref>`, path either a workflow file under
    // .github/workflows/ or an action directory, ref one tag/sha/branch token.
    "uses: cinatra-ai/ops/.github/workflows/deploy.yml@main",
    'uses: "cinatra-ai/ops/.github/workflows/deploy.yml@abc123"',
    "uses: cinatra-ai/ops/.github/workflows/deploy.yaml@v1.2.3",
    "uses: cinatra-ai/ops/actions/notify@v1",
    "uses: cinatra-ai/ops@0123456789abcdef0123456789abcdef01234567",
    "repository: cinatra-ai/ops",
    "  repositories: [cinatra-ai/wp-theme]",
    'repository: "cinatra-ai/wp-theme"',
    "repository: cinatra-ai/ops  # the operations repository",
    'REMOTE="https://github.com/cinatra-ai/wp-theme.git"',
    "git clone https://github.com/cinatra-ai/wp-theme.git",
  ]) {
    assert.equal(matchRule(rule, line), 0, `required functional form should be excused: ${JSON.stringify(line)}`);
  }
});

test("the functional carve-out is EXACT: nothing may follow the repository name", () => {
  // The defect this locks: a carve-out that stopped at the repository name and
  // tolerated any suffix excused the very citations it exists to catch — an
  // issue URL or an `#<n>` ref wearing a machine key as a hat. The `uses:` form
  // is anchored by its MANDATORY `@<ref>` (GitHub rejects a ref-less cross-repo
  // `uses:`), the `repository:` form by an explicit terminator.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    "repository: cinatra-ai/ops/issues/0",
    "repository: cinatra-ai/ops#0",
    "uses: cinatra-ai/ops/issues/0",
    "repository: cinatra-ai/ops/pull/0",
    'repository: "cinatra-ai/wp-theme/issues/0"',
    "  repositories: [cinatra-ai/wp-theme#0]",
    // A ref-less cross-repository `uses:` is not a machine form GitHub accepts,
    // so it is not excused either.
    "uses: cinatra-ai/ops/.github/workflows/deploy.yml",
    "uses: cinatra-ai/ops",
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `a suffixed key is a citation, not a machine form: ${JSON.stringify(line)}`);
  }
});

test("EVERY other form of a dispatch target still flags (a name-wide exemption would have hidden these)", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    // ordinary prose — rephraseable, so it is not excused:
    "the cinatra-ai/wp-theme staging remote",
    "download the cinatra-ai/wp-theme tree at a pinned ref",
    "operators run cinatra-ai/ops by hand",
    // issue citations and browse URLs — exactly what a leak looks like:
    "see cinatra-ai/ops#0 for the rationale",
    "https://github.com/cinatra-ai/ops/issues/0",
    "https://github.com/cinatra-ai/wp-theme/blob/main/style.css",
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `should flag: ${JSON.stringify(line)}`);
  }
});

// The grammar harness for the hook itself: a workflow path and a set that calls
// every value legitimate, so what is under test is the SPAN the grammar covers.
function grammarCovers(name, line, index) {
  return functionalRefCovers(name, line, index, GRAMMAR_FILE, { legitValues: EVERY_VALUE_IS_LEGITIMATE });
}

test("the functional carve-out is per MATCH, not per line", () => {
  // The whole reason for replacing the name-wide exemption: one line may carry
  // a required reference AND a leaked one, and only the required one is excused.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  const line = "uses: cinatra-ai/ops/.github/workflows/x.yml@main  # rationale in cinatra-ai/ops#0";
  assert.equal(matchRule(rule, line), 1, "the issue citation must still flag on a line with a legitimate `uses:`");
  assert.equal(grammarCovers("ops", line, line.indexOf("cinatra-ai/ops")), true, "the `uses:` occurrence is covered");
  assert.equal(grammarCovers("ops", line, line.lastIndexOf("cinatra-ai/ops")), false, "the citation is NOT covered");
});

test("the functional carve-out is keyed to its own repository, never shared", () => {
  const line = "uses: cinatra-ai/ops/.github/workflows/x.yml@main";
  assert.equal(grammarCovers("ops", line, line.indexOf("cinatra-ai/ops")), true);
  assert.equal(grammarCovers("wp-theme", line, line.indexOf("cinatra-ai/ops")), false);
  for (const f of FUNCTIONAL_REPO_REFS) {
    assert.ok(PRIVATE_REPO_NAMES.includes(f.name), `${f.name} carries a carve-out but is not on the private list`);
  }
});

test("a `uses:` / `repository:` carve-out needs BOTH a file and the document's word", () => {
  // The structural contract, at the hook: the grammar is necessary and never
  // sufficient. With no path there is no document, and with a document that
  // declares nothing there is no legitimate value — so the same line that the
  // grammar covers is covered in neither case. The clone form declares no YAML
  // location at all and is unaffected: it is a shell remote.
  const line = "uses: cinatra-ai/ops/.github/workflows/x.yml@main";
  const at = line.indexOf("cinatra-ai/ops");
  assert.equal(grammarCovers("ops", line, at), true, "grammar + a file + the value: covered");
  assert.equal(functionalRefCovers("ops", line, at), false, "no path, no document, no carve-out");
  assert.equal(functionalRefCovers("ops", line, at, GRAMMAR_FILE, { legitValues: new Set() }), false,
    "a file that declares no such value excuses nothing");
  assert.equal(
    functionalRefCovers("ops", line, at, GRAMMAR_FILE,
      { legitValues: new Set(["cinatra-ai/ops/.github/workflows/x.yml@main"]) }), true,
    "the value the document declares is the value the carve-out excuses",
  );
  // A DIFFERENT ref is a different dispatch: the value must match whole.
  assert.equal(
    functionalRefCovers("ops", line, at, GRAMMAR_FILE,
      { legitValues: new Set(["cinatra-ai/ops/.github/workflows/x.yml@v1"]) }), false,
    "the same target at another ref is not this value",
  );
  const clone = "git clone https://github.com/cinatra-ai/wp-theme.git";
  assert.equal(functionalRefCovers("wp-theme", clone, clone.indexOf("cinatra-ai/wp-theme")), true,
    "the clone form is a shell remote: no file, no document, unchanged");
});

// --------------------------------------------------------------------------
// Shared tokenization: the static lane and the probe must agree.
// --------------------------------------------------------------------------

test("normalizeRepoName folds case and strips a clone URL's `.git`", () => {
  assert.equal(normalizeRepoName("Design"), "design");
  assert.equal(normalizeRepoName("design.git"), "design");
  assert.equal(normalizeRepoName("design.github"), "design.github");
  assert.equal(orgPathRepoName("cinatra-ai/design.git"), "design");
  assert.equal(orgPathRepoName("cinatra-ai/some.repo.js"), "some.repo.js");
});

test("a clone URL resolves to the repository it clones", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  assert.ok(matchRule(rule, "clone cinatra-ai/design.git today") >= 1, "`.git` must not hide a listed name");
});

test("a listed name with a dotted continuation is a DIFFERENT repository", () => {
  // The bug this locks: truncating `<listed>.something` back to `<listed>` would
  // flag the wrong repository in the static lane while the probe read it whole.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  assert.equal(matchRule(rule, "see cinatra-ai/design.foo for the helper"), 0);
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  assert.equal(matchRule(probe, "see cinatra-ai/design.foo for the helper"), 1, "the probe claims it instead");
});

test("both lanes tokenize identically, and never both claim the same token", () => {
  const statics = buildRules({}, "default", null);
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  for (const line of [
    "see cinatra-ai/design here",              // listed  -> static only
    "see cinatra-ai/design.foo here",          // dotted  -> probe only
    "see cinatra-ai/design.git here",          // clone   -> static only
    "see cinatra-ai/.github-private here",     // dotted leading name -> probe only
    "see cinatra-ai/some-new-repo here",       // unlisted -> probe only
    "see cinatra-ai/ops#0 here",             // listed  -> static only
  ]) {
    const staticHits = statics.reduce((n, r) => n + matchRule(r, line), 0);
    const probeHits = matchRule(probe, line);
    assert.equal(staticHits + probeHits, 1, `exactly one lane must claim ${JSON.stringify(line)}`);
  }
});

test("the name grammar admits every legal GitHub repository name", () => {
  // The old grammar demanded an alnum or a dot FIRST, so `<org>/_shared` — a
  // perfectly legal repository — was invisible to both lanes.
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  const nameOf = (line) => {
    const re = new RegExp(probe.re.source, probe.re.flags);
    const m = re.exec(line);
    return m ? m[0].split("/")[1] : null;
  };
  assert.equal(nameOf("see cinatra-ai/_s for it"), "_s", "an underscore-leading name is nominated");
  assert.equal(nameOf("see cinatra-ai/_shared-tools for it"), "_shared-tools");
  assert.equal(nameOf("see cinatra-ai/.github-private for it"), ".github-private");
});

test("the name grammar stops at GitHub's 100-character ceiling", () => {
  // A longer run of name characters is not a repository: probing it can only
  // 404, and a 404 is reported as a fail-closed finding. The trailing boundary
  // refuses to stop mid-token, so an over-long run is not nominated AT ALL
  // rather than truncated to its first 100 characters.
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  const nameOf = (line) => {
    const re = new RegExp(probe.re.source, probe.re.flags);
    const m = re.exec(line);
    return m ? m[0].split("/")[1] : null;
  };
  const at100 = "a".repeat(REPO_NAME_MAX);
  const at101 = "a".repeat(REPO_NAME_MAX + 1);
  assert.equal(REPO_NAME_MAX, 100);
  assert.equal(nameOf(`see cinatra-ai/${at100} here`), at100, "a 100-character name is nominated");
  assert.equal(nameOf(`see cinatra-ai/${at101} here`), null, "a 101-character run is not a repository name");
});

test("ONE name grammar: the tokenizer and the cache validator agree", () => {
  // Two hand-kept copies drift, and a name one lane accepts while the other
  // rejects is exactly the disagreement that yields two different findings for
  // one reference.
  for (const good of ["ci", "_s", ".github-private", "some.repo.js", "a-b_c.d", "a".repeat(REPO_NAME_MAX)]) {
    assert.equal(isValidRepoName(good), true, `should be a legal name: ${good}`);
  }
  for (const good of ["-secret", "-lead"]) {
    assert.equal(isValidRepoName(good), true, `GitHub accepts a leading hyphen: ${good}`);
  }
  for (const bad of ["", ".", "..", "bad name", "ci.", "a".repeat(REPO_NAME_MAX + 1)]) {
    assert.equal(isValidRepoName(bad), false, `should NOT be a legal name: ${JSON.stringify(bad)}`);
  }
  // And what the validator accepts is exactly what the tokenizer reads whole.
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  for (const good of ["ci", "_s", ".github-private", "some.repo.js"]) {
    const re = new RegExp(probe.re.source, probe.re.flags);
    assert.equal(re.exec(`see cinatra-ai/${good} here`)[0].split("/")[1], good);
  }
});

test("a leading dot is a legal repository name", () => {
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  const re = new RegExp(probe.re.source, probe.re.flags);
  assert.equal(re.exec("see cinatra-ai/.github-private notes")[0], "cinatra-ai/.github-private");
});

// --------------------------------------------------------------------------
// Canonical token boundaries on the literal-name rules. A dot IS a repository-
// name character, so a rule that treats it as a boundary claims the wrong
// repository — and lets the probe claim the same token as well.
// --------------------------------------------------------------------------

test("a dotted sibling of the private tracker is a DIFFERENT repository", () => {
  const rule = byId.get("SLG_PRIVATE_ENG_REF");
  for (const line of [
    "see cinatra-ai/engineering.tools for the sibling",   // dotted suffix
    "the cinatra-ai/engineering.v2 mirror",
  ]) {
    assert.equal(matchRule(rule, line), 0, `a dotted sibling is not the tracker: ${JSON.stringify(line)}`);
  }
  // …while a sentence-final period is still punctuation, not a name character.
  assert.ok(matchRule(rule, "filed under cinatra-ai/engineering. Then closed.") >= 1);
  assert.ok(matchRule(rule, "https://github.com/cinatra-ai/engineering/issues/0") >= 1);
});

test("a dotted neighbour of the private proof host is a DIFFERENT repository", () => {
  const rule = byId.get("SLG_PRIVATE_PROOFS_REF");
  for (const line of [
    "the engineering-proofs-private.bak mirror",          // dotted suffix
    "see sibling.engineering-proofs-private notes",       // dotted prefix
  ]) {
    assert.equal(matchRule(rule, line), 0, `a dotted neighbour is not the host: ${JSON.stringify(line)}`);
  }
  assert.ok(matchRule(rule, "filed under engineering-proofs-private. Then closed.") >= 1);
});

test("a tracker-form reference yields EXACTLY one finding, never a double", () => {
  // The double this locks: the static rule read `<org>/engineering.tools` as the
  // tracker (wrong repository) while the probe, which tokenizes the name whole,
  // nominated `engineering.tools` — one reference, two findings.
  const statics = buildRules({}, "default", null);
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  for (const line of [
    "filed under cinatra-ai/engineering tracker",     // the tracker -> static only
    "see cinatra-ai/engineering.tools here",          // a dotted sibling -> probe only
    "https://github.com/cinatra-ai/engineering/issues/0",
    "pushed to engineering-proofs-private",           // bare private host -> static only
    "see cinatra-ai/engineering-proofs-private.bak",  // dotted sibling -> probe only
  ]) {
    const total = statics.reduce((n, r) => n + matchRule(r, line), 0) + matchRule(probe, line);
    assert.equal(total, 1, `exactly one rule may claim ${JSON.stringify(line)}`);
  }
});

// --------------------------------------------------------------------------
// Probe budget: a cap, a deadline, bounded concurrency, and nothing unasked
// ever reads as clean.
// --------------------------------------------------------------------------

test("probe budget: names over the per-run cap become budget findings, unqueried", async () => {
  const calls = stubFetch(() => apiResponse(200, { private: false }));
  const ctx = probeCtx({ maxNames: 3 });
  const cands = ["r1", "r2", "r3", "r4", "r5"].map((n) => candidate(n));
  const out = await resolveProbeFindings(cands, ctx);
  assert.equal(calls.length, 3, "only the capped number of names is fetched");
  assert.equal(out.length, 2, "every unasked candidate is still reported");
  for (const f of out) {
    assert.equal(f.rule, PROBE_BUDGET_RULE_ID);
    assert.match(f.reason, /cap/);
    assert.match(f.snippet, /probe budget/);
  }
  assert.deepEqual(out.map((f) => f.match).sort(), ["cinatra-ai/r4", "cinatra-ai/r5"]);
});

test("probe budget: EVERY reference to an unasked name is named, not just the first", async () => {
  stubFetch(() => apiResponse(200, { private: false }));
  const ctx = probeCtx({ maxNames: 1 });
  const out = await resolveProbeFindings(
    [candidate("r1"), candidate("r2"), candidate("r2", { line: 9 }), candidate("r2", { file: "other.ts" })],
    ctx,
  );
  assert.equal(out.length, 3, "all three references to the unasked name are reported");
  assert.ok(out.every((f) => f.rule === PROBE_BUDGET_RULE_ID));
});

test("probe budget: a passed deadline stops further calls and reports the rest", async () => {
  const calls = stubFetch(async () => { await new Promise((r) => setTimeout(r, 12)); return apiResponse(200, { private: false }); });
  const ctx = probeCtx({ deadlineMs: 1, concurrency: 1, maxNames: 50 });
  const out = await resolveProbeFindings(["a", "b", "c", "d"].map((n) => candidate(n)), ctx);
  assert.ok(calls.length < 4, `the deadline must cut the run short (made ${calls.length} calls)`);
  assert.ok(out.length >= 1, "the names it never asked about are reported");
  assert.ok(out.every((f) => f.rule === PROBE_BUDGET_RULE_ID));
  assert.match(out[0].reason, /deadline/);
});

test("probe budget: concurrency is bounded", async () => {
  let inFlight = 0, peak = 0;
  stubFetch(async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return apiResponse(200, { private: true });
  });
  const ctx = probeCtx({ concurrency: 2, maxNames: 50 });
  const out = await resolveProbeFindings(["a", "b", "c", "d", "e", "f"].map((n) => candidate(n)), ctx);
  assert.ok(peak <= 2, `at most 2 requests in flight, saw ${peak}`);
  assert.equal(out.length, 6, "and every name still gets its verdict");
});

test("probe budget: a cached name costs no budget", async () => {
  const calls = stubFetch(() => apiResponse(200, { private: true }));
  const ctx = probeCtx({ maxNames: 1, knownPublic: new Set(["cached-a", "cached-b"]) });
  const out = await resolveProbeFindings(
    [candidate("cached-a"), candidate("cached-b"), candidate("fresh-one")].map((c) => c),
    ctx,
  );
  assert.equal(calls.length, 1, "the cache hits do not consume the cap");
  assert.equal(out.length, 1);
  assert.equal(out[0].rule, PROBE_RULE_ID);
});

test("probe deadline: an IN-FLIGHT request is cut at the deadline, not at its own timeout", async () => {
  // The defect this locks: the deadline only stopped NEW requests, so a request
  // already in flight kept its full 10s timeout and a 60s lane could run ~70s.
  // The fetch here never resolves on its own — it settles only when the signal
  // the gate handed it aborts — so the elapsed time IS the timeout the gate
  // chose. With a 60ms deadline that must be ~60ms, not the 10s request timeout.
  const seen = [];
  setProbeFetch((url, init) => new Promise((_, reject) => {
    seen.push(url);
    // A long real timer stands in for the open socket of a server that never
    // answers: `AbortSignal.timeout` uses an UNREF'd timer, so without it the
    // loop would simply drain instead of proving anything.
    const stuck = setTimeout(() => reject(new Error("the stub was never aborted")), 30_000);
    init.signal.addEventListener("abort", () => {
      clearTimeout(stuck);
      reject(init.signal.reason ?? new Error("aborted"));
    });
  }));
  const ctx = probeCtx({ deadlineMs: 60, concurrency: 2, maxNames: 50 });
  const started = Date.now();
  const out = await resolveProbeFindings(["a", "b", "c", "d"].map((n) => candidate(n)), ctx);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 3000, `the lane must end at its deadline, not at the request timeout (took ${elapsed}ms)`);
  assert.ok(seen.length >= 1, "at least one request was actually opened");
  assert.equal(out.length, 4, "every reference is still reported — nothing unasked reads as clean");
  for (const f of out) {
    assert.equal(f.rule, PROBE_BUDGET_RULE_ID, "a request the deadline cut is the fail-closed BUDGET finding");
    assert.match(f.reason, /deadline/);
    assert.match(f.snippet, /probe budget/);
  }
});

test("probe deadline: a request opened past the deadline is never sent", async () => {
  const calls = stubFetch(() => apiResponse(200, { private: false }));
  const ctx = probeCtx({ deadlineMs: 60 });
  ctx.deadlineAt = Date.now() - 1; // the lane's time is already gone
  const v = await resolveRepoVisibility("some-new-repo", ctx);
  assert.equal(v.state, "deadline");
  assert.match(v.reason, /deadline/);
  assert.equal(calls.length, 0, "no request may be opened that cannot finish inside the deadline");
});

test("the shipped budget defaults are finite", () => {
  assert.ok(Number.isFinite(PROBE_MAX_NAMES) && PROBE_MAX_NAMES > 0);
  const ctx = probeCtx({});
  assert.ok(Number.isFinite(ctx.maxNames) && Number.isFinite(ctx.deadlineMs) && Number.isFinite(ctx.concurrency));
});

// --------------------------------------------------------------------------
// Cache freshness: stamped entries, strict validation, a TTL, and a refresh mode.
// --------------------------------------------------------------------------

function writeCache(dir, obj) {
  const f = path.join(dir, "public-repos.json");
  fs.writeFileSync(f, `${JSON.stringify(obj, null, 2)}\n`);
  return f;
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "slg-cache-")); }

test("cache: a fresh entry is trusted and a stale one is ignored", () => {
  const dir = tmpdir();
  try {
    const f = writeCache(dir, {
      ttlDays: 7,
      public: [
        { name: "fresh-repo", verifiedAt: "2026-03-10" },
        { name: "stale-repo", verifiedAt: "2026-03-01" },
      ],
    });
    const loaded = loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" });
    assert.equal(loaded.names.has("fresh-repo"), true);
    assert.equal(loaded.names.has("stale-repo"), false, "past the TTL the name must be resolved live");
    assert.match(loaded.note, /TTL/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cache: a stale entry is PROBED rather than trusted", async () => {
  const dir = tmpdir();
  try {
    const f = writeCache(dir, { ttlDays: 7, public: [{ name: "stale-repo", verifiedAt: "2026-03-01" }] });
    const loaded = loadKnownPublicRepos(f, { now: "2026-04-01T00:00:00Z" });
    const calls = stubFetch(() => apiResponse(200, { private: true }));
    const out = await resolveProbeFindings([candidate("stale-repo")], probeCtx({ knownPublic: loaded.names }));
    assert.equal(calls.length, 1, "a stale entry must not clear the name for free");
    assert.equal(out.length, 1, "and the live answer wins");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cache: a malformed FILE is a hard error", () => {
  // The FILE's structure still throws: there is nothing to read, so the caller
  // (main()) turns it into the usual gate failure.
  const dir = tmpdir();
  try {
    for (const obj of [{ ttlDays: 7 }, { public: {} }, [], "nope", null]) {
      const f = writeCache(dir, obj);
      assert.throws(() => loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" }),
        `should reject ${JSON.stringify(obj)}`);
    }
    const f = path.join(dir, "public-repos.json");
    fs.writeFileSync(f, "{not json");
    assert.throws(() => loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" }), /valid JSON/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cache: a malformed ENTRY never clears a name — it is stale, with one warning", () => {
  // CHANGED EXPECTATION (was: every one of these throws). The types are now
  // CHECKED rather than coerced, and a single bad entry must not decide the fate
  // of the whole file: it is skipped with one warning naming it, and the name it
  // was going to clear is resolved live. What the old code got wrong is the
  // COERCION — `{"name": 123}` stringified into the perfectly good name `123`
  // and cleared `<org>/123` with no probe at all, and `["2026-03-12"]`
  // stringified into a day that then read as fresh. Both are entries below.
  const dir = tmpdir();
  const bad = [
    { entry: "ci", why: /not an object/ },                              // legacy bare string
    { entry: null, why: /not an object/ },                              // a null is not an entry
    { entry: ["ci", "2026-03-12"], why: /not an object/ },              // nor is an array
    { entry: { name: 123, verifiedAt: "2026-03-12" }, why: /not a JSON string/ },
    { entry: { verifiedAt: "2026-03-12" }, why: /name/ },               // no name at all
    { entry: { name: "ci", verifiedAt: ["2026-03-12"] }, why: /not a JSON string/ },
    { entry: { name: "ci" }, why: /verifiedAt/ },                       // no verifiedAt
    { entry: { name: "ci", verifiedAt: "10-03-2026" }, why: /verifiedAt/ },
    { entry: { name: "bad name", verifiedAt: "2026-03-12" }, why: /not a repository name/ },
    { entry: { name: "ci.git", verifiedAt: "2026-03-12" }, why: /not a repository name/ },
    { entry: { name: "has/slash", verifiedAt: "2026-03-12" }, why: /not a repository name/ },
  ];
  try {
    for (const { entry, why } of bad) {
      const label = JSON.stringify(entry);
      const f = writeCache(dir, { ttlDays: 7, public: [entry] });
      const loaded = loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" });
      assert.equal(loaded.names.size, 0, `${label} must clear nothing`);
      assert.equal(loaded.warnings.length, 1, `${label} must raise exactly one warning`);
      assert.match(loaded.warnings[0], why, label);
      assert.match(loaded.note, /untrustworthy/, label);
    }
    // A good entry alongside a bad one is unaffected: the bad entry is skipped,
    // not the file.
    const f = writeCache(dir, {
      ttlDays: 7,
      public: [{ name: 123, verifiedAt: "2026-03-12" }, { name: "good-repo", verifiedAt: "2026-03-12" }],
    });
    const loaded = loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" });
    assert.deepEqual([...loaded.names], ["good-repo"]);
    // The unusable entry is not listed either: there is no name to re-probe, so
    // `--verify-cache` drops it instead of laundering it into a stamped one.
    assert.deepEqual(loaded.entries, [{ name: "good-repo", verifiedAt: "2026-03-12" }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cache: a coerced-name entry is RESOLVED LIVE, and the live answer wins", async () => {
  // End to end: the numeric name the loader refuses to trust costs an API call,
  // and the API's answer — not the cache — decides.
  const dir = tmpdir();
  try {
    const f = writeCache(dir, { ttlDays: 7, public: [{ name: 123, verifiedAt: "2026-03-12" }] });
    const loaded = loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" });
    const calls = stubFetch(() => apiResponse(200, { private: true }));
    const out = await resolveProbeFindings([candidate("123")], probeCtx({ knownPublic: loaded.names }));
    assert.equal(calls.length, 1, "a coerced name must not clear the repository for free");
    assert.equal(out.length, 1, "and the live answer wins");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cache: an entry expires BY verifiedAt + ttlDays, measured in UTC calendar days", () => {
  // CHANGED EXPECTATION (was: `ageDays <= ttlDays`, so the entry at exactly the
  // expiry instant was still trusted — one day more than the TTL it is named
  // for). The clock is injected, so the boundary is asserted, not approximated.
  const dir = tmpdir();
  try {
    const f = writeCache(dir, { ttlDays: 7, public: [{ name: "boundary-repo", verifiedAt: "2026-08-28" }] });
    const fresh = loadKnownPublicRepos(f, { now: "2026-09-03T23:59:59Z" });
    assert.equal(fresh.names.has("boundary-repo"), true, "one second before the expiry it is still fresh");
    const expired = loadKnownPublicRepos(f, { now: "2026-09-04T00:00:00Z" });
    assert.equal(expired.names.has("boundary-repo"), false, "at verifiedAt + ttlDays it has expired");
    assert.match(expired.note, /TTL/);
    // Whole UTC days, so the hour of the day never decides: every instant inside
    // the last fresh day is fresh, and every instant of the expiry day is not.
    assert.equal(loadKnownPublicRepos(f, { now: "2026-09-03T00:00:00Z" }).names.has("boundary-repo"), true);
    assert.equal(loadKnownPublicRepos(f, { now: "2026-09-04T23:59:59Z" }).names.has("boundary-repo"), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cache: an out-of-range ttlDays makes the WHOLE cache ignored, with one warning", () => {
  // A TTL the loader silently accepted was the freshness rule switched off: a
  // 3650-day TTL keeps vouching for a repository that went private years ago.
  const dir = tmpdir();
  try {
    for (const bad of [3650, 8, 0, -1, 3.5, "7", null, true]) {
      const f = writeCache(dir, { ttlDays: bad, public: [{ name: "fresh-repo", verifiedAt: "2026-03-10" }] });
      const loaded = loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" });
      assert.equal(loaded.names.size, 0, `ttlDays ${JSON.stringify(bad)} must void the whole cache`);
      assert.equal(loaded.ttlValid, false);
      assert.equal(loaded.warnings.length, 1, "exactly one warning line");
      assert.match(loaded.warnings[0], /ttlDays/);
      assert.match(loaded.note, /IGNORED/);
      // The entries are still listed, so `--verify-cache` can repair the file.
      assert.equal(loaded.entries.length, 1);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cache: an in-range ttlDays is honoured, and an absent one takes the shipped default", () => {
  const dir = tmpdir();
  try {
    for (const good of [1, 3, PUBLIC_CACHE_TTL_DAYS]) {
      const f = writeCache(dir, { ttlDays: good, public: [{ name: "fresh-repo", verifiedAt: "2026-03-12" }] });
      const loaded = loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" });
      assert.equal(loaded.names.has("fresh-repo"), true, `ttlDays ${good} must be honoured`);
      assert.equal(loaded.warnings.length, 0);
    }
    const f = writeCache(dir, { public: [{ name: "fresh-repo", verifiedAt: "2026-03-12" }] });
    const loaded = loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" });
    assert.equal(loaded.ttlDays, PUBLIC_CACHE_TTL_DAYS, "an absent ttlDays is the shipped default, not an error");
    assert.equal(loaded.names.has("fresh-repo"), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cache: a calendar-invalid verifiedAt is STALE, never verified", () => {
  // `new Date("2026-02-30T00:00:00Z")` does not throw — it normalises to March
  // 2nd — so a shape check plus "did it parse?" accepted a day that never
  // existed and then called it fresh. The round-trip catches it.
  const dir = tmpdir();
  try {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31"]) {
      const f = writeCache(dir, { ttlDays: 7, public: [{ name: "impossible-day", verifiedAt: bad }] });
      const loaded = loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" });
      assert.equal(loaded.names.has("impossible-day"), false, `${bad} must never vouch for a name`);
      assert.equal(loaded.warnings.length, 1);
      assert.match(loaded.warnings[0], /verifiedAt/);
      assert.match(loaded.note, /untrustworthy/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cache: a FUTURE verifiedAt is STALE, never verified", () => {
  // A stamp dated ahead of now can never age out; it would vouch forever.
  const dir = tmpdir();
  try {
    const f = writeCache(dir, {
      ttlDays: 7,
      public: [
        { name: "time-traveller", verifiedAt: "2027-01-01" },
        { name: "today-repo", verifiedAt: "2026-03-12" },
      ],
    });
    const loaded = loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" });
    assert.equal(loaded.names.has("time-traveller"), false, "a future stamp must not be trusted");
    assert.equal(loaded.names.has("today-repo"), true, "today is not the future");
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /future/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cache: an untrustworthy stamp is RESOLVED LIVE, and the live answer wins", async () => {
  const dir = tmpdir();
  try {
    const f = writeCache(dir, { ttlDays: 7, public: [{ name: "time-traveller", verifiedAt: "2027-01-01" }] });
    const loaded = loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" });
    const calls = stubFetch(() => apiResponse(200, { private: true }));
    const out = await resolveProbeFindings([candidate("time-traveller")], probeCtx({ knownPublic: loaded.names }));
    assert.equal(calls.length, 1, "an invalid entry must not clear the name for free");
    assert.equal(out.length, 1, "and the live answer wins");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cache: --verify-cache restamps what is still public and DROPS what is not", async () => {
  const dir = tmpdir();
  try {
    const f = writeCache(dir, {
      $comment: "kept",
      ttlDays: 7,
      public: [
        { name: "still-public", verifiedAt: "2026-01-01" },
        { name: "went-private", verifiedAt: "2026-01-01" },
      ],
    });
    stubFetch((url) => (url.endsWith("/still-public") ? apiResponse(200, { private: false }) : apiResponse(404, {})));
    const r = await verifyPublicRepoCache(f, probeCtx(), { now: "2026-03-12T00:00:00Z" });
    assert.equal(r.changed, true);
    assert.deepEqual(r.dropped.map((d) => d.name), ["went-private"]);
    const after = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.equal(after.$comment, "kept", "the file's own documentation survives a rewrite");
    assert.deepEqual(after.public, [{ name: "still-public", verifiedAt: "2026-03-12" }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cache: --verify-cache never launders an unresolved entry into a fresh stamp", async () => {
  const dir = tmpdir();
  try {
    // Canonical on disk, so the only thing that could change the file is a
    // laundered timestamp — which is exactly what this test forbids.
    const f = path.join(dir, "public-repos.json");
    fs.writeFileSync(f, serializePublicRepoCache({ ttlDays: 7, public: [{ name: "unreachable", verifiedAt: "2026-01-01" }] }));
    stubFetch(() => { throw new Error("ECONNRESET"); });
    const r = await verifyPublicRepoCache(f, probeCtx(), { now: "2026-03-12T00:00:00Z" });
    assert.equal(r.unresolved.length, 1);
    assert.equal(r.changed, false, "an unresolved entry is left EXACTLY as it was");
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")).public, [{ name: "unreachable", verifiedAt: "2026-01-01" }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the committed cache is valid, fresh-shaped, and holds nothing privately owned", () => {
  const f = path.join(import.meta.dirname, "..", "..", "config", "public-repos.json");
  const loaded = loadKnownPublicRepos(f, { now: new Date(`${JSON.parse(fs.readFileSync(f, "utf8")).public[0].verifiedAt}T00:00:00Z`) });
  assert.ok(loaded.entries.length >= 1, "the cache must load");
  assert.equal(loaded.ttlDays, PUBLIC_CACHE_TTL_DAYS);
  for (const e of loaded.entries) {
    assert.equal(PROBE_EXEMPT_NAMES.has(e.name), false, `${e.name} cannot be both cached-public and privately owned`);
  }
});

test("the serializer emits JSON with or without other top-level fields", () => {
  // A cache carrying only `public` — no `$comment`, and no `ttlDays` because the
  // documented default applies — serialised as `{,` and was not JSON at all, so
  // the writer produced a file the very next read could not parse.
  const bare = serializePublicRepoCache({ public: [{ name: "still-public", verifiedAt: "2026-03-12" }] });
  assert.deepEqual(JSON.parse(bare), { public: [{ name: "still-public", verifiedAt: "2026-03-12" }] });
  const full = serializePublicRepoCache({ $comment: "why", ttlDays: 7, public: [{ name: "still-public", verifiedAt: "2026-03-12" }] });
  assert.deepEqual(JSON.parse(full), {
    $comment: "why", ttlDays: 7, public: [{ name: "still-public", verifiedAt: "2026-03-12" }],
  });
  // And the round trip is stable: reserialising what parsed changes nothing.
  assert.equal(serializePublicRepoCache(JSON.parse(bare)), bare);
  assert.equal(serializePublicRepoCache(JSON.parse(full)), full);
});

test("the committed cache is already in the generator's canonical form", () => {
  // Otherwise the weekly refresh would "drift" on formatting alone and open a
  // pull request that changes nothing — noise that trains people to ignore it.
  const f = path.join(import.meta.dirname, "..", "..", "config", "public-repos.json");
  const onDisk = fs.readFileSync(f, "utf8");
  assert.equal(serializePublicRepoCache(JSON.parse(onDisk)), onDisk);
});

test("a refresh that changes nothing rewrites nothing", async () => {
  const dir = tmpdir();
  try {
    const f = path.join(dir, "public-repos.json");
    fs.writeFileSync(f, serializePublicRepoCache({ $comment: "x", ttlDays: 7, public: [{ name: "still-public", verifiedAt: "2026-03-12" }] }));
    const before = fs.readFileSync(f, "utf8");
    stubFetch(() => apiResponse(200, { private: false }));
    const r = await verifyPublicRepoCache(f, probeCtx(), { now: "2026-03-12T00:00:00Z" });
    assert.equal(r.changed, false, "same day, same entries => no drift");
    assert.equal(fs.readFileSync(f, "utf8"), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Pin-keyed expiry of a file-basename exemption (exemptFileBasenamesExpiry).
//
// These run the gate as a subprocess over a throwaway tree, because the
// behaviour under test is an exit code and an operator-facing message, not a
// return value. The marker payload is assembled at runtime so this file carries
// no intact example of it.
// ---------------------------------------------------------------------------
const EXPIRY_SCANNER = path.join(import.meta.dirname, "..", "source-leak-gate.mjs");
const EXPIRY_MARKER = "see " + "Phase " + "530 here";
const PIN_A = "83ca29ef8df0a33d11ba02568c61f2fdc56a3eaf";
const PIN_B = "0123456789abcdef0123456789abcdef01234567";

function expiryTree(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slg-expiry-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  // `untilPin.file` must be TRACKED in the scanned tree — an untracked file is
  // not the caller that runs — so the fixture tree is a real repository with its
  // files in the index. (The untracked and symlinked cases are exercised on
  // purpose in their own tests below.)
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}
const PIN_TARGET = "some-org/ci/.github/workflows/gate.yml";
function workflowPinning(ref) {
  return `name: caller\njobs:\n  gate:\n    uses: ${PIN_TARGET}@${ref} # v0.0.0\n`;
}
// One tree, one knob: `notes.txt` carries a marker, and the config exempts it by
// basename under an expiry keyed to `.github/workflows/caller.yml`.
function expiryCase({ pinnedSha = PIN_A, config }) {
  const files = {
    "notes.txt": `${EXPIRY_MARKER}\n`,
    ".github/workflows/caller.yml": workflowPinning(pinnedSha),
    "config/gate.json": JSON.stringify(config, null, 1),
  };
  if (pinnedSha === null) delete files[".github/workflows/caller.yml"];
  return expiryTree(files);
}
function runExpiryGate(dir) {
  const res = spawnSync(
    "node",
    [EXPIRY_SCANNER, "--profile", "default", "--ratchet-mode", "off", "--config", "config/gate.json", "--exit-on-match"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" } },
  );
  return { status: res.status, err: res.stderr, out: res.stdout };
}
const liveConfig = {
  exemptFileBasenames: ["notes.txt"],
  exemptFileBasenamesExpiry: {
    "notes.txt": { untilPin: { file: ".github/workflows/caller.yml", uses: PIN_TARGET, sha: PIN_A }, why: "keyed to the pinned engine" },
  },
};

test("expiry: while the file still pins the keyed sha the exemption is live and silent", () => {
  const dir = expiryCase({ config: liveConfig });
  try {
    const r = runExpiryGate(dir);
    assert.equal(r.status, 0, `expected a clean run, got ${r.status}: ${r.err}`);
    assert.equal(/EXPIRED|config error/.test(r.err), false, `a live exemption says nothing: ${r.err}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: the live case is not vacuous — the same tree without the exemption is red", () => {
  const dir = expiryCase({ config: { exemptFileBasenames: [], exemptFileBasenamesExpiry: {} } });
  try {
    assert.equal(runExpiryGate(dir).status, 1, "the marker file must be a finding when nothing exempts it");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: a moved pin EXPIRES the exemption — exit 1 naming both shas and the pair to delete", () => {
  const dir = expiryCase({ pinnedSha: PIN_B, config: liveConfig });
  try {
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1);
    assert.match(r.err, /EXPIRED/);
    assert.match(r.err, /notes\.txt/);
    assert.match(r.err, /\.github\/workflows\/caller\.yml/);
    assert.ok(r.err.includes(PIN_TARGET), "the message must name the `uses:` target the exemption is keyed to");
    assert.ok(r.err.includes(PIN_B), "the message must name the sha the file pins NOW");
    assert.ok(r.err.includes(PIN_A), "the message must name the sha the exemption was keyed to");
    assert.match(r.err, /exemptFileBasenames AND its exemptFileBasenamesExpiry entry/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: an unreadable pin file is a config error, never a silent exemption", () => {
  const dir = expiryCase({ pinnedSha: null, config: liveConfig });
  try {
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1);
    assert.match(r.err, /config error/);
    assert.match(r.err, /not readable/);
    assert.match(r.err, /\.github\/workflows\/caller\.yml/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: the KEYED TARGET being unpinned is a config error, whatever other lines pin", () => {
  // The defect this locks: the check accepted ANY sha anywhere in the pin file,
  // so moving the gate reference to `@main` while an unrelated
  // `actions/checkout@<sha>` stayed put left the exemption silently alive.
  const dir = expiryCase({ config: liveConfig });
  try {
    fs.writeFileSync(
      path.join(dir, ".github/workflows/caller.yml"),
      `name: caller\njobs:\n  gate:\n    uses: ${PIN_TARGET}@main\n    steps:\n      - uses: actions/checkout@${PIN_A}\n`,
    );
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1, "an unpinned target is a config error even though another line carries the keyed sha");
    assert.match(r.err, /config error/);
    assert.match(r.err, /not pinned to a commit sha/);
    assert.ok(r.err.includes(PIN_TARGET), "the message names the target that is not pinned");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: an unrelated line's sha never answers for the keyed target", () => {
  // Same shape, one step further: the keyed target is pinned to a DIFFERENT sha
  // while an unrelated action carries the keyed one. The verdict must be EXPIRED,
  // read off the target alone.
  const dir = expiryCase({ pinnedSha: PIN_B, config: liveConfig });
  try {
    fs.appendFileSync(path.join(dir, ".github/workflows/caller.yml"), `    steps:\n      - uses: actions/checkout@${PIN_A}\n`);
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1);
    assert.match(r.err, /EXPIRED/);
    assert.ok(r.err.includes(PIN_B), "the target's own ref is the one compared");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: another action pinned to another sha does not disturb a LIVE exemption", () => {
  const dir = expiryCase({ config: liveConfig });
  try {
    fs.appendFileSync(path.join(dir, ".github/workflows/caller.yml"), `    steps:\n      - uses: actions/checkout@${PIN_B}\n`);
    const r = runExpiryGate(dir);
    assert.equal(r.status, 0, `an unrelated pin is irrelevant, got ${r.status}: ${r.err}`);
    assert.equal(/EXPIRED|config error/.test(r.err), false, r.err);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: a MISSING target is a config error, even when the file pins the keyed sha elsewhere", () => {
  const dir = expiryCase({ config: liveConfig });
  try {
    fs.writeFileSync(
      path.join(dir, ".github/workflows/caller.yml"),
      `name: caller\njobs:\n  gate:\n    steps:\n      - uses: actions/checkout@${PIN_A}\n`,
    );
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1);
    assert.match(r.err, /config error/);
    assert.match(r.err, /carries no such `uses:` line/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: the keyed target pinned twice at DIFFERENT refs cannot key an exemption", () => {
  const dir = expiryCase({ config: liveConfig });
  try {
    fs.appendFileSync(path.join(dir, ".github/workflows/caller.yml"), `  gate2:\n    uses: ${PIN_TARGET}@${PIN_B}\n`);
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1);
    assert.match(r.err, /config error/);
    assert.match(r.err, /different refs/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: a malformed entry is a config error, named — and it names all THREE keys", () => {
  // Each message states the shape the operator has to write, so it has to state
  // the REAL one: an entry is `untilPin { file, uses, sha }`, and a diagnostic
  // that named only `{ file, sha }` sent the reader back with an entry the very
  // next check rejects for the missing `uses` target.
  const SHAPE = /untilPin must be \{ file: [^}]*uses: [^}]*sha: [^}]*\}/;
  for (const [label, entry, expected] of [
    ["the entry is not an object at all", "just-a-string", /must be an object carrying untilPin \{ file, uses, sha \}/],
    ["the entry is an array", [".github/workflows/caller.yml"], /must be an object carrying untilPin \{ file, uses, sha \}/],
    ["no untilPin", { why: "x" }, SHAPE],
    ["untilPin is a string", { untilPin: ".github/workflows/caller.yml" }, SHAPE],
    ["no sha", { untilPin: { file: ".github/workflows/caller.yml", uses: PIN_TARGET } }, SHAPE],
    ["sha is a branch", { untilPin: { file: ".github/workflows/caller.yml", uses: PIN_TARGET, sha: "main" } }, SHAPE],
    ["no file", { untilPin: { uses: PIN_TARGET, sha: PIN_A } }, SHAPE],
    ["no uses target", { untilPin: { file: ".github/workflows/caller.yml", sha: PIN_A } }, SHAPE],
  ]) {
    const dir = expiryCase({ config: { exemptFileBasenames: ["notes.txt"], exemptFileBasenamesExpiry: { "notes.txt": entry } } });
    try {
      const r = runExpiryGate(dir);
      assert.equal(r.status, 1, `${label}: expected exit 1`);
      assert.match(r.err, /config error/, label);
      assert.match(r.err, expected, label);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("expiry: an entry for a basename that is NOT exempt is a config error", () => {
  const dir = expiryCase({ config: { exemptFileBasenames: [], exemptFileBasenamesExpiry: liveConfig.exemptFileBasenamesExpiry } });
  try {
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1);
    assert.match(r.err, /config error/);
    assert.match(r.err, /'notes\.txt', which is not listed in exemptFileBasenames/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: a gate line that is not a `uses:` scalar is not a pin — config error, not a verdict", () => {
  // END TO END for the reader's grammar: a real gate call REPLACED by text no
  // runner accepts must never keep the exemption it justifies alive. The keyed
  // target is then simply absent, which is a config error and stops the run.
  for (const [value, reason] of [
    // Not a mapping at all: the parser reads one plain scalar, so the job
    // declares no `uses:` and the keyed target is absent.
    [`uses:${PIN_TARGET}@${PIN_A}`, /carries no such `uses:` line/],
    // A ref the `<target>@<ref>` grammar rejects: parsed, but not a dispatch.
    [`uses: ${PIN_TARGET}@${PIN_A} and then some`, /carries no such `uses:` line/],
    // An unbalanced quote is not YAML at all, and a caller nobody can parse is
    // a caller nobody can key an exemption to.
    [`uses: "${PIN_TARGET}@${PIN_A}`, /not parseable YAML/],
  ]) {
    const dir = expiryCase({ config: liveConfig });
    try {
      fs.writeFileSync(path.join(dir, ".github/workflows/caller.yml"), `name: caller\njobs:\n  gate:\n    ${value}\n`);
      const r = runExpiryGate(dir);
      assert.equal(r.status, 1, `an invalid gate line is not a pin: ${JSON.stringify(value)}`);
      assert.match(r.err, /config error/);
      assert.match(r.err, reason);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // A STEP is not the caller's dispatch: an action a job happens to pin at the
  // keyed target cannot answer for the reusable-workflow call the exemption
  // names.
  {
    const dir = expiryCase({ config: liveConfig });
    try {
      fs.writeFileSync(path.join(dir, ".github/workflows/caller.yml"),
        `name: caller\njobs:\n  gate:\n    steps:\n      - uses: ${PIN_TARGET}@${PIN_A}\n`);
      const r = runExpiryGate(dir);
      assert.equal(r.status, 1, "a step-level `uses:` is not a job-level dispatch");
      assert.match(r.err, /config error/);
      assert.match(r.err, /carries no such `uses:` line/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // The well-formed spellings — bare, quoted, with or without a trailing
  // comment — are pins, and the exemption they key stays live and silent.
  for (const value of [
    `uses: ${PIN_TARGET}@${PIN_A}`,
    `uses: "${PIN_TARGET}@${PIN_A}"`,
    `uses: '${PIN_TARGET}@${PIN_A}'  # v0.0.0`,
  ]) {
    const dir = expiryCase({ config: liveConfig });
    try {
      fs.writeFileSync(path.join(dir, ".github/workflows/caller.yml"), `name: caller\njobs:\n  gate:\n    ${value}\n`);
      const r = runExpiryGate(dir);
      assert.equal(r.status, 0, `a well-formed pin keeps the exemption live: ${JSON.stringify(value)} — ${r.err}`);
      assert.equal(/EXPIRED|config error/.test(r.err), false, r.err);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("expiry: the expiry map itself must be an object", () => {
  const dir = expiryCase({ config: { exemptFileBasenames: ["notes.txt"], exemptFileBasenamesExpiry: ["notes.txt"] } });
  try {
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1);
    assert.match(r.err, /config error/);
    assert.match(r.err, /must be an object mapping a file basename/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// `untilPin.file` names the CALLER WORKFLOW, not "any file carrying the line".
// ---------------------------------------------------------------------------

function expiryConfigFor(file) {
  return {
    exemptFileBasenames: ["notes.txt"],
    exemptFileBasenamesExpiry: { "notes.txt": { untilPin: { file, uses: PIN_TARGET, sha: PIN_A }, why: "keyed to the pinned engine" } },
  };
}

test("expiry: untilPin.file must be a repository-root workflow — a README carrying the line is not a pin", () => {
  // The defect this locks: any readable path was accepted, so a document that
  // merely QUOTES the target at the old sha kept the exemption alive while the
  // real caller had already moved.
  const dir = expiryTree({
    "notes.txt": `${EXPIRY_MARKER}\n`,
    "README.md": workflowPinning(PIN_A),
    "config/gate.json": JSON.stringify(expiryConfigFor("README.md"), null, 1),
  });
  try {
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1, "a README is not a caller workflow, even carrying the keyed pin");
    assert.match(r.err, /config error/);
    assert.match(r.err, /must be a repository-relative/);
    assert.match(r.err, /README\.md/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: untilPin.file may not climb out of the scanned tree", () => {
  const dir = expiryTree({
    "notes.txt": `${EXPIRY_MARKER}\n`,
    "config/gate.json": JSON.stringify(expiryConfigFor("../outside/caller.yml"), null, 1),
  });
  const outside = path.join(path.dirname(dir), "outside");
  try {
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "caller.yml"), workflowPinning(PIN_A));
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1, "a path outside the scanned tree is not a pin, whatever it carries");
    assert.match(r.err, /config error/);
    assert.match(r.err, /must be a repository-relative/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("expiry: a SYMLINKED workflow is a config error — a link points anywhere", () => {
  const dir = expiryTree({
    "notes.txt": `${EXPIRY_MARKER}\n`,
    ".github/workflows/real.yml": workflowPinning(PIN_A),
    "config/gate.json": JSON.stringify(expiryConfigFor(".github/workflows/link.yml"), null, 1),
  });
  try {
    fs.symlinkSync("real.yml", path.join(dir, ".github/workflows/link.yml"));
    spawnSync("git", ["add", "-A"], { cwd: dir }); // tracked, and STILL refused
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1);
    assert.match(r.err, /config error/);
    assert.match(r.err, /SYMLINK/);
    assert.match(r.err, /link\.yml/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: an UNTRACKED workflow is a config error — it is not the caller that runs", () => {
  const dir = expiryTree({
    "notes.txt": `${EXPIRY_MARKER}\n`,
    "config/gate.json": JSON.stringify(expiryConfigFor(".github/workflows/untracked.yml"), null, 1),
  });
  try {
    fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github/workflows/untracked.yml"), workflowPinning(PIN_A));
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1, "an untracked file carrying the keyed pin does not keep the exemption alive");
    assert.match(r.err, /config error/);
    assert.match(r.err, /not tracked/);
    // Not vacuous: the SAME file, once tracked, keys a live exemption.
    spawnSync("git", ["add", "-A"], { cwd: dir });
    const ok = runExpiryGate(dir);
    assert.equal(ok.status, 0, `the tracked workflow keys a live exemption: ${ok.err}`);
    assert.equal(/EXPIRED|config error/.test(ok.err), false, ok.err);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: untilPin.file may not be a PATHSPEC PATTERN — a literal `*.yml` is not the caller", () => {
  // The defect this locks: `git ls-files --error-unmatch -- <file>` reads its
  // argument as a PATHSPEC, so an untracked file literally named
  // `.github/workflows/*.yml` was reported "tracked" on the strength of some
  // other workflow matching the glob, and the exemption stayed live keyed to a
  // file nothing runs. A pattern is now refused before git is asked at all, and
  // the tracked check itself asks git with `--literal-pathspecs` and compares the
  // answer byte-for-byte with the path it asked about.
  const dir = expiryTree({
    "notes.txt": `${EXPIRY_MARKER}\n`,
    ".github/workflows/caller.yml": workflowPinning(PIN_A),
    "config/gate.json": JSON.stringify(expiryConfigFor(".github/workflows/*.yml"), null, 1),
  });
  try {
    // The literal wildcard file EXISTS and carries the keyed pin — and is untracked.
    fs.writeFileSync(path.join(dir, ".github/workflows/*.yml"), workflowPinning(PIN_A));
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1, "a pattern is not the caller workflow, whatever it matches");
    assert.match(r.err, /config error/);
    assert.match(r.err, /must name ONE file/);
    // Not vacuous: the real tracked workflow in the SAME tree keys a live exemption.
    fs.writeFileSync(path.join(dir, "config/gate.json"),
      JSON.stringify(expiryConfigFor(".github/workflows/caller.yml"), null, 1));
    const ok = runExpiryGate(dir);
    assert.equal(ok.status, 0, `the tracked caller keys a live exemption: ${ok.err}`);
    assert.equal(/EXPIRED|config error/.test(ok.err), false, ok.err);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("isTrackedInScannedTree answers about the PATH, not about what a pathspec matches", () => {
  // The engine-level half of the same defect: git must be asked with
  // `--literal-pathspecs`, and its answer must BE the path that was asked about.
  const dir = expiryTree({
    ".github/workflows/real.yml": workflowPinning(PIN_A),
  });
  const cwd0 = process.cwd();
  try {
    fs.writeFileSync(path.join(dir, ".github/workflows/*.yml"), workflowPinning(PIN_A));
    process.chdir(dir);
    assert.equal(isTrackedInScannedTree(".github/workflows/real.yml"), true);
    assert.equal(isTrackedInScannedTree(".github/workflows/*.yml"), false,
      "an untracked literal file is untracked, even though the glob would match a tracked one");
    assert.equal(isTrackedInScannedTree(".github/workflows/absent.yml"), false);
  } finally { process.chdir(cwd0); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: a `uses:` inside a block scalar is NOT the pin", () => {
  // Same rule as the carve-out: a `uses:` line inside a `run: |` block is shell
  // text no runner dispatches, so it cannot answer for a keyed target.
  const dir = expiryTree({
    "notes.txt": `${EXPIRY_MARKER}\n`,
    ".github/workflows/caller.yml":
      `name: caller\njobs:\n  gate:\n    steps:\n      - run: |\n          cat <<'EOF' > x.yml\n          uses: ${PIN_TARGET}@${PIN_A}\n          EOF\n`,
    "config/gate.json": JSON.stringify(expiryConfigFor(".github/workflows/caller.yml"), null, 1),
  });
  try {
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1, "a heredoc line is not a pin, so the keyed target is simply absent");
    assert.match(r.err, /config error/);
    assert.match(r.err, /carries no such `uses:` line/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The keyed target is compared CASE-CANONICALLY (owner + repository only).
// ---------------------------------------------------------------------------

test("canonicalUsesTarget folds the owner and repository, never the path", () => {
  assert.equal(canonicalUsesTarget("Some-Org/CI/.github/workflows/Gate.yml"), "some-org/ci/.github/workflows/Gate.yml");
  assert.equal(canonicalUsesTarget("Some-Org/CI"), "some-org/ci");
  assert.equal(canonicalUsesTarget("actions/Checkout"), "actions/checkout");
});

test("expiry: a case-variant spelling of the keyed target IS the target", () => {
  // The refusal cost this removes: GitHub resolves `Some-Org/CI/...` and
  // `some-org/ci/...` to the same dispatch, so a caller spelling the target with
  // different case was refused as "no such line" on input that is perfectly
  // valid.
  const variant = "Some-Org/CI/.github/workflows/gate.yml";
  const dir = expiryTree({
    "notes.txt": `${EXPIRY_MARKER}\n`,
    ".github/workflows/caller.yml": `name: caller\njobs:\n  gate:\n    uses: ${variant}@${PIN_A}\n`,
    "config/gate.json": JSON.stringify(expiryConfigFor(".github/workflows/caller.yml"), null, 1),
  });
  try {
    const r = runExpiryGate(dir);
    assert.equal(r.status, 0, `a case-variant spelling of the same dispatch is the pin: ${r.err}`);
    assert.equal(/EXPIRED|config error/.test(r.err), false, r.err);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: case variants at DIFFERENT refs are an ambiguous target, not an evasion", () => {
  // The defect this locks: compared literally, a SECOND `uses:` line spelling
  // the same target in different case slipped past the duplicate check, so the
  // exemption stayed live on a target the file pins twice at two shas.
  const variant = "Some-Org/CI/.github/workflows/gate.yml";
  const dir = expiryTree({
    "notes.txt": `${EXPIRY_MARKER}\n`,
    ".github/workflows/caller.yml":
      `name: caller\njobs:\n  gate:\n    uses: ${PIN_TARGET}@${PIN_A}\n  gate2:\n    uses: ${variant}@${PIN_B}\n`,
    "config/gate.json": JSON.stringify(expiryConfigFor(".github/workflows/caller.yml"), null, 1),
  });
  try {
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1);
    assert.match(r.err, /config error/);
    assert.match(r.err, /different refs/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("expiry: the PATH segments of a target keep their case", () => {
  // Only the owner and repository fold: a checkout's file names are
  // case-sensitive, so `…/workflows/Gate.yml` is a different workflow.
  const dir = expiryTree({
    "notes.txt": `${EXPIRY_MARKER}\n`,
    ".github/workflows/caller.yml": `name: caller\njobs:\n  gate:\n    uses: some-org/ci/.github/workflows/Gate.yml@${PIN_A}\n`,
    "config/gate.json": JSON.stringify(expiryConfigFor(".github/workflows/caller.yml"), null, 1),
  });
  try {
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1, "a differently-cased PATH is a different workflow");
    assert.match(r.err, /config error/);
    assert.match(r.err, /carries no such `uses:` line/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("readUsesPins: returns the JOB-LEVEL dispatches as { target, ref } pairs, in document order", () => {
  // It reports PAIRS, not a deduplicated bag of shas: an expiry is keyed to one
  // target, and only that target's ref may answer for it — so a caller must be
  // able to tell WHICH dispatch carried which ref.
  //
  // It reads `jobs.<id>.uses` and nothing else. A STEP's `uses:` is an action a
  // job runs, not the caller's dispatch of a reusable workflow, and an expiry
  // keyed to one was never keyed to a caller. The value is then split with the
  // carve-out's own `<target>@<ref>` grammar, in which `@<ref>` is MANDATORY
  // (GitHub rejects a ref-less cross-repository `uses:`): a ref-less line and a
  // LOCAL `uses: ./…` are not cross-repository dispatches and are absent from
  // the result. Neither ever was one in substance — a ref-less entry could only
  // fail the sha test, and reporting it merely changed which config error the
  // expiry printed.
  const pins = readUsesPins(
    `jobs:\n`
    + `  a:\n    uses: o/r/.github/workflows/w.yml@${PIN_A} # v1\n    with:\n      ref: main\n`
    + `  b:\n    uses: o/b@v4\n`
    + `  c:\n    uses: o/c\n`
    + `  d:\n    uses: ./.github/actions/local\n`
    + `  e:\n    uses: "o/d@${PIN_B}"\n`
    + `  f:\n    steps:\n      - uses: o/a@${PIN_A}\n`,
  );
  assert.deepEqual(pins, [
    { target: "o/r/.github/workflows/w.yml", ref: PIN_A },
    { target: "o/b", ref: "v4" },
    { target: "o/d", ref: PIN_B },
  ]);
});

test("readUsesPins: only a real dispatch is a pin — text that spells one is not", () => {
  // The defect class this locks, once and for all: a `uses:` line that a runner
  // never dispatches must not answer for a keyed pin. Each spelling below was a
  // separate review round while the reader tracked YAML by hand — a heredoc, a
  // folded block, a `- |` item, a colon-carrying key, a whole-document scalar, a
  // multi-line quoted scalar, an `env:` mapping whose key happens to be `uses`.
  // The parser knows all of them for what they are: text.
  const jobValue = (value) => readUsesPins(`name: caller\njobs:\n  gate:\n    ${value}\n`);
  for (const value of [
    `uses:o/a@${PIN_A}`,                       // no whitespace: one plain scalar, not a mapping
    `uses: o/a@${PIN_A} and then some`,        // trailing junk: not a `<target>@<ref>`
    `uses: o/a@${PIN_A}#0`,                    // a comment-less `#` is a citation
    `# uses: o/a@${PIN_A}`,                    // a comment is prose about a step
  ]) {
    assert.deepEqual(jobValue(value), [], `not a pin: ${JSON.stringify(value)}`);
  }
  for (const value of [
    `uses: o/a@${PIN_A}`,
    `uses: "o/a@${PIN_A}"`,
    `uses: 'o/a@${PIN_A}'  # v1.2.3`,
  ]) {
    assert.deepEqual(jobValue(value), [{ target: "o/a", ref: PIN_A }], `a pin: ${JSON.stringify(value)}`);
  }
  // Every multi-line TEXT form, each one a former round: the `uses:` inside is
  // text, and only the real job-level dispatch is a pin.
  const dispatch = `jobs:\n  gate:\n    uses: o/a@${PIN_A}\n`;
  for (const text of [
    `jobs:\n  a:\n    steps:\n      - run: |\n          cat <<'EOF' > x.yml\n          uses: o/x@${PIN_B}\n          EOF\n`,
    `jobs:\n  a:\n    steps:\n      - run: >-\n          uses: o/x@${PIN_B}\n`,
    `jobs:\n  a:\n    payloads:\n      - |\n        uses: o/x@${PIN_B}\n`,
    `jobs:\n  a:\n    steps:\n      - run: &payload |\n          uses: o/x@${PIN_B}\n`,
    `jobs:\n  a:\n    steps:\n      - run:x: |\n          uses: o/x@${PIN_B}\n`,
    `jobs:\n  a:\n    steps:\n      - env:\n          uses: o/x@${PIN_B}\n`,
    `jobs:\n  a:\n    steps:\n      - description: "\n          uses: o/x@${PIN_B}\n          "\n`,
    `jobs:\n  a:\n    steps:\n      - "NOTE": "\n          uses: o/x@${PIN_B}\n          "\n`,
  ]) {
    assert.deepEqual(readUsesPins(text), [], `text is not a pin:\n${text}`);
    assert.deepEqual(readUsesPins(`${dispatch}${text.replace(/^jobs:\n/, "")}`),
      [{ target: "o/a", ref: PIN_A }], `only the real dispatch is a pin:\n${text}`);
  }
  // A `--- |` document is one string: it declares no jobs at all.
  assert.deepEqual(readUsesPins(`--- |\njobs:\n  gate:\n    uses: o/a@${PIN_A}\n`), []);
  // And a caller nobody can parse is NULL — a config error at the call site,
  // never a silent "no pins".
  assert.equal(readUsesPins(`jobs:\n  gate:\n    uses: "o/a@${PIN_A}\n`), null, "an unbalanced quote is not YAML");
  assert.equal(readUsesPins("a: 1\na: 2\n"), null, "a duplicated key is not YAML");
});

// --------------------------------------------------------------------------
// The functional carve-outs are MACHINE GRAMMARS, not substrings.
// --------------------------------------------------------------------------

test("a carve-out key must OWN its line: a comment excuses nothing", () => {
  // The defect this locks: the carve-out matched anywhere on the line, so a
  // commented-out step — prose ABOUT a machine form — excused the name in it.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    "# uses: cinatra-ai/ops@main",
    "  # uses: cinatra-ai/ops/.github/workflows/deploy.yml@main",
    "# repository: cinatra-ai/ops",
    "  # - uses: cinatra-ai/ops@main",
    "see uses: cinatra-ai/ops@main in the old job",  // the key is not the first token
    "step uses: cinatra-ai/ops@main to deploy",
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `a commented / embedded key is prose: ${JSON.stringify(line)}`);
  }
  // …while the real key, with or without a sequence marker, still is one.
  for (const line of [
    "uses: cinatra-ai/ops@main",
    "  - uses: cinatra-ai/ops@main",
    "\t- uses: cinatra-ai/ops/actions/notify@v1",
    "      repository: cinatra-ai/ops",
  ]) {
    assert.equal(matchRule(rule, line), 0, `a real machine form is excused: ${JSON.stringify(line)}`);
  }
});

test("a carve-out scalar must be COMPLETE: trailing junk leaves the exemption", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    "uses: cinatra-ai/ops@main and then some",
    "uses: cinatra-ai/ops@main#0",                 // a comment-less `#` is a citation
    'uses: "cinatra-ai/ops@main',                  // unbalanced quote
    "uses: 'cinatra-ai/ops@main\"",                // mismatched quotes
    "repository: cinatra-ai/ops junk",
    "repository: cinatra-ai/ops#0",
    'repository: "cinatra-ai/ops',
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `an incomplete scalar is not a machine form: ${JSON.stringify(line)}`);
  }
  // A real YAML comment (whitespace, then `#`) IS a terminator, and the excused
  // span stops at the value — so a citation inside the comment still flags.
  assert.equal(matchRule(rule, "uses: cinatra-ai/ops@main  # pinned by the release job"), 0);
  assert.equal(matchRule(rule, "repository: cinatra-ai/ops  # the operations repository"), 0);
  assert.equal(matchRule(rule, "uses: cinatra-ai/ops@main  # see cinatra-ai/ops#0"), 1);
});

test("a carve-out key is SEPARATED from its value by real whitespace", () => {
  // The defect this locks: the key/value gap was `[ \t]*`, so `uses:<org>/<repo>@main`
  // — which is not a YAML scalar at all, and which no runner accepts — was
  // excused as a machine form.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    "uses:cinatra-ai/ops@main",
    "  - uses:cinatra-ai/ops/.github/workflows/deploy.yml@main",
    "repository:cinatra-ai/ops",
    "repositories:[cinatra-ai/wp-theme]",
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `no space after the key is not a scalar: ${JSON.stringify(line)}`);
  }
  for (const line of [
    "uses: cinatra-ai/ops@main",
    "  - uses:\tcinatra-ai/ops@main",
    "repository: cinatra-ai/ops",
    "  repositories: [cinatra-ai/wp-theme]",
  ]) {
    assert.equal(matchRule(rule, line), 0, `the spaced form is the machine form: ${JSON.stringify(line)}`);
  }
});

test("the SCALAR and FLOW-SEQUENCE checkout forms are separate grammars", () => {
  // The defect this locks: one terminator set served both forms, so `,` and `]`
  // ended a scalar that had never opened a sequence — and trailing junk after a
  // comma was excused. The sequence form now needs PAIRED delimiters, and it
  // validates EVERY entry, not just the first.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    "repository: cinatra-ai/ops,#0",                     // nothing was opened: this is a citation
    "repository: cinatra-ai/ops, and then some",
    "repository: cinatra-ai/ops]",
    "repositories: [cinatra-ai/wp-theme",                // unclosed
    "repositories: [cinatra-ai/wp-theme, junk]",         // an entry that is not `<org>/<repo>`
    "repositories: cinatra-ai/wp-theme]",
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `not a paired, fully validated sequence: ${JSON.stringify(line)}`);
  }
  // A real flow sequence excuses EVERY entry, in either quoting, with any owner
  // in the other entries, under the same trailing-comment rule.
  for (const line of [
    "repositories: [cinatra-ai/wp-theme, cinatra-ai/wp-theme]",
    'repositories: ["cinatra-ai/wp-theme", cinatra-ai/ops]',
    "  repositories: [ other-org/public, cinatra-ai/wp-theme ]  # both checkouts",
  ]) {
    assert.equal(matchRule(rule, line), 0, `every entry of a real sequence is excused: ${JSON.stringify(line)}`);
  }
});

test("a flow sequence's OWNERS must be logins GitHub can issue", () => {
  // The defect this locks: the owner grammar accepted a trailing or doubled
  // hyphen, so `bad-/public` parsed as a valid entry — the sequence read as a
  // machine form and carried the private entry out with it. GitHub logins are
  // 1..39 of `[A-Za-z0-9-]` with no leading, trailing or consecutive hyphen; an
  // entry whose owner cannot exist makes the sequence not a machine form, and
  // every private entry in it is a finding.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    "repositories: [bad-/public, cinatra-ai/ops]",
    "repositories: [a--b/x, cinatra-ai/ops]",
    "repositories: [-a/x, cinatra-ai/ops]",
    "repositories: [cinatra-ai/ops, bad-/public]",
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `an impossible owner voids the sequence: ${JSON.stringify(line)}`);
  }
  for (const line of [
    "repositories: [other-org/public, cinatra-ai/ops]",
    "repositories: [a-b-c/x, cinatra-ai/ops]",
    "repositories: [a/x, cinatra-ai/ops]",
  ]) {
    assert.equal(matchRule(rule, line), 0, `every owner is a real login: ${JSON.stringify(line)}`);
  }
  // The 39-character ceiling is real, hyphens included: the hyphen rule alone
  // would have accepted a 77-character login.
  const maxOwner = "a".repeat(39);
  const maxHyphenated = "a-".repeat(20).slice(0, 39);
  assert.equal(matchRule(rule, `repositories: [${maxOwner}/x, cinatra-ai/ops]`), 0);
  assert.equal(matchRule(rule, `repositories: [${maxHyphenated}/x, cinatra-ai/ops]`), 0);
  assert.ok(matchRule(rule, `repositories: [${maxOwner}a/x, cinatra-ai/ops]`) >= 1, "40 characters is not a login");
  assert.ok(matchRule(rule, `repositories: [${"a-".repeat(21).slice(0, 41)}/x, cinatra-ai/ops]`) >= 1, "41 hyphenated characters is not a login");
});

test("a flow sequence may carry ONE optional trailing comma", () => {
  // The refusal cost this removes: `repositories: [<org>/<repo>,]` is valid YAML
  // — a flow sequence may end with a separator — and a runner reads it exactly
  // like the comma-less spelling, so refusing it called correct input a leak.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    "repositories: [cinatra-ai/wp-theme,]",
    "repositories: [cinatra-ai/wp-theme, ]",
    "  repositories: [ other-org/public, cinatra-ai/wp-theme, ]  # both checkouts",
    "repositories: [cinatra-ai/ops, other-org/public,]",
  ]) {
    assert.equal(matchRule(rule, line), 0, `one trailing comma is still YAML: ${JSON.stringify(line)}`);
  }
  for (const line of [
    "repositories: [cinatra-ai/wp-theme,,]",     // not a separator that repeats
    "repositories: [cinatra-ai/wp-theme,",       // still unclosed
    "repositories: [,cinatra-ai/wp-theme]",      // a LEADING comma is not YAML
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `not a flow sequence: ${JSON.stringify(line)}`);
  }
});

test("owner and repository names fold CASE, the YAML key does not", () => {
  // GitHub resolves owner/repository names case-insensitively, so
  // `uses: Cinatra-AI/Ops@main` is the same dispatch as the lower-case spelling:
  // refusing it refused correct input.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    "uses: Cinatra-AI/Ops@main",
    "uses: cinatra-ai/OPS/.github/workflows/deploy.yml@main",
    "repository: CINATRA-AI/OPS",
    "  repositories: [Cinatra-AI/WP-Theme]",
    'REMOTE="https://github.com/Cinatra-AI/WP-Theme.git"',
    "git clone git@github.com:CINATRA-AI/wp-theme.git",
  ]) {
    assert.equal(matchRule(rule, line), 0, `a correct dispatch in another case is still a dispatch: ${JSON.stringify(line)}`);
  }
  for (const line of [
    "see Cinatra-AI/Ops#0 for the rationale",
    "the CINATRA-AI/WP-Theme staging remote",
    "Uses: cinatra-ai/ops@main",                          // the KEY is case-sensitive: this is prose
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `case never excuses a non-machine form: ${JSON.stringify(line)}`);
  }
});

test("the clone carve-out is ANCHORED on the left: an npm scope is not a remote", () => {
  // The defect this locks: the clone pattern was unanchored, so it matched from
  // the org onward inside `@<org>/<repo>.git` — the npm-scoped spelling — and
  // excused it as a clone URL.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    'import x from "@cinatra-ai/wp-theme.git";',
    "@cinatra-ai/wp-theme.git",
    "see x@cinatra-ai/wp-theme.git",
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `an \`@\` before the org is not a clone reference: ${JSON.stringify(line)}`);
  }
  for (const line of [
    // the three full remotes…
    "git clone https://github.com/cinatra-ai/wp-theme.git",
    "git clone git@github.com:cinatra-ai/wp-theme.git",
    "git clone ssh://git@github.com/cinatra-ai/wp-theme.git",
    'REMOTE="https://github.com/cinatra-ai/wp-theme.git"',
    // …and the bare form standing on its own.
    "cinatra-ai/wp-theme.git",
    "gh repo clone cinatra-ai/wp-theme.git",
    '"cinatra-ai/wp-theme.git"',
    "[cinatra-ai/wp-theme.git]",
  ]) {
    assert.equal(matchRule(rule, line), 0, `a clone remote is excused: ${JSON.stringify(line)}`);
  }
  // …and the citations wearing a remote's spelling are unchanged.
  for (const line of [
    "https://github.com/cinatra-ai/wp-theme.git/issues/0",
    "git@github.com:cinatra-ai/ops.git",                  // no clone carve-out for this name
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `still a finding: ${JSON.stringify(line)}`);
  }
});

test("the clone carve-out anchors the FULL REMOTES too: junk before a remote is not a remote", () => {
  // The defect this locks: the left delimiter guarded only the BARE form, so any
  // junk could carry a full remote — `xhttps://github.com/<org>/<repo>.git` is
  // not a remote anybody clones, but it spells the private name in full and the
  // carve-out excused it. Now one delimiter sits in front of an OPTIONAL remote
  // prefix, so both forms answer to it.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    "xhttps://github.com/cinatra-ai/wp-theme.git",
    "xgit@github.com:cinatra-ai/wp-theme.git",
    "xssh://git@github.com/cinatra-ai/wp-theme.git",
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `junk before a remote is not a remote: ${JSON.stringify(line)}`);
  }
  // The clean remotes are unchanged — at the start of a line, after whitespace,
  // after an opening quote or bracket, and after the `=` of an assignment.
  for (const line of [
    "https://github.com/cinatra-ai/wp-theme.git",
    "git clone https://github.com/cinatra-ai/wp-theme.git",
    "git clone git@github.com:cinatra-ai/wp-theme.git",
    "git clone ssh://git@github.com/cinatra-ai/wp-theme.git",
    "REMOTE=https://github.com/cinatra-ai/wp-theme.git",
    'REMOTE="https://github.com/cinatra-ai/wp-theme.git"',
    "(https://github.com/cinatra-ai/wp-theme.git)",
  ]) {
    assert.equal(matchRule(rule, line), 0, `a clone remote is excused: ${JSON.stringify(line)}`);
  }
});

test("a `uses:` ref may contain slashes (branch names do), but never whitespace, `@` or `#`", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    "uses: cinatra-ai/ops@release/1.0",
    "uses: cinatra-ai/ops/.github/workflows/deploy.yml@feature/x-y",
    'uses: "cinatra-ai/ops/actions/notify@release/1.0"',
  ]) {
    assert.equal(matchRule(rule, line), 0, `a slash-containing ref is legal: ${JSON.stringify(line)}`);
  }
  for (const line of [
    "uses: cinatra-ai/ops@ main",
    "uses: cinatra-ai/ops@main@extra",
    "uses: cinatra-ai/ops@",
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `not a ref GitHub accepts: ${JSON.stringify(line)}`);
  }
});

test("the clone-URL carve-out terminates at `.git`", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  for (const line of [
    "REMOTE=https://github.com/cinatra-ai/wp-theme.git",
    "git clone https://github.com/cinatra-ai/wp-theme.git",
    'REMOTE="https://github.com/cinatra-ai/wp-theme.git"',
    "git clone git@github.com:cinatra-ai/wp-theme.git, then build",
  ]) {
    assert.equal(matchRule(rule, line), 0, `a clone remote is excused: ${JSON.stringify(line)}`);
  }
  for (const line of [
    "https://github.com/cinatra-ai/wp-theme.git/issues/0",
    "https://github.com/cinatra-ai/wp-theme.git/anything",
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `a citation wearing a remote's spelling: ${JSON.stringify(line)}`);
  }
  // The carve-out is per repository: no other listed name has a clone form.
  assert.ok(matchRule(rule, "git@github.com:cinatra-ai/ops.git") >= 1);
});

// --------------------------------------------------------------------------
// STRUCTURAL carve-outs: the document decides, not the line.
//
// Every case below runs through scanFile against a REAL file, because that is
// the only caller that has a document to parse. The grammar half — which
// spellings read as a machine form at all — is exercised by matchRule above.
// --------------------------------------------------------------------------

// Runs `body` through the scanner as `rel`, from inside a throwaway tree, and
// returns the rule ids (or the line numbers) it flags.
function scanTree(cases) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slg-struct-")));
  const cwd0 = process.cwd();
  try {
    process.chdir(dir);
    return cases({
      ids(rel, body) { return this.findings(rel, body).map((f) => f.rule); },
      lines(rel, body) { return this.findings(rel, body).map((f) => f.line); },
      findings(rel, body) {
        fs.mkdirSync(path.dirname(rel) === "." ? "." : path.dirname(rel), { recursive: true });
        fs.writeFileSync(rel, body);
        return scanFile(rel, active);
      },
    });
  } finally { process.chdir(cwd0); fs.rmSync(dir, { recursive: true, force: true }); }
}

test("where the file path is known, `uses:` is excused only in a ROOT workflow or an action file", () => {
  // The path restriction is real rather than a documented impossibility: scanFile
  // passes it, and a caller that cannot name the file gets no carve-out at all.
  //
  // Paths reach the scan REPOSITORY-RELATIVE (`git ls-files`), and the workflow
  // arm is anchored at the root: GitHub executes `.github/workflows/` at the
  // repository root and nowhere else, so `nested/.github/workflows/fake.yml` is
  // an ordinary document and the reference in it is prose. `action.ya?ml` stays
  // matched by basename at any depth — composite actions live in subdirectories.
  // (The test runs FROM the temp tree for exactly that reason: an absolute path
  // is not a repository-relative one.)
  const workflow = "name: deploy\njobs:\n  deploy:\n    uses: cinatra-ai/ops/.github/workflows/deploy.yml@main\n";
  const action = "name: notify\nruns:\n  using: composite\n  steps:\n    - uses: cinatra-ai/ops/actions/notify@v1\n";
  scanTree((t) => {
    for (const rel of [".github/workflows/deploy.yml", ".github/workflows/deploy.yaml", "./.github/workflows/deploy.yml"]) {
      assert.deepEqual(t.ids(rel, workflow), [], `a root workflow dispatches: ${rel}`);
    }
    for (const rel of ["action.yml", ".github/actions/notify/action.yaml", "some/dir/action.yml"]) {
      assert.deepEqual(t.ids(rel, action), [], `a composite action dispatches: ${rel}`);
    }
    for (const rel of ["nested/.github/workflows/fake.yml", "docs/.github/workflows/example.yaml", "templates/deploy.yml"]) {
      assert.deepEqual(t.ids(rel, workflow), ["SLG_PRIVATE_REPO_REF"], `not a file GitHub runs: ${rel}`);
    }
    // Not YAML at all: no document, no carve-out.
    assert.deepEqual(t.ids("docs/runbook.md", workflow), ["SLG_PRIVATE_REPO_REF"]);
  });
});

test("`uses:` is excused only where the DOCUMENT dispatches that exact value", () => {
  // The structural rule, in the file class where the carve-out is widest: the
  // same line, in the same root workflow, is a machine form at a step and text
  // everywhere else — and a value the document does not dispatch is never a
  // machine form, however well it is spelled.
  const rel = ".github/workflows/deploy.yml";
  scanTree((t) => {
    assert.deepEqual(t.ids(rel, "jobs:\n  build:\n    steps:\n      - uses: cinatra-ai/ops/actions/notify@v1\n"), [],
      "a step's action is a dispatch");
    assert.deepEqual(t.ids(rel, "jobs:\n  deploy:\n    uses: cinatra-ai/ops/.github/workflows/deploy.yml@main\n"), [],
      "a job's reusable-workflow call is a dispatch");
    assert.deepEqual(t.ids(rel, "on: push\nuses: cinatra-ai/ops/actions/notify@v1\n"), ["SLG_PRIVATE_REPO_REF"],
      "a top-level `uses:` is not a step, whatever it spells");
    assert.deepEqual(t.ids(rel, "jobs:\n  build:\n    outputs:\n      uses: cinatra-ai/ops/actions/notify@v1\n"),
      ["SLG_PRIVATE_REPO_REF"], "a mapping under a job is not a step");
  });
});

test("the `repository:` key is a machine form only at an Actions location — in any YAML", () => {
  // `repository:` is a mapping key, so unlike `uses:` it is legal in ANY YAML
  // file — but being YAML is necessary and not sufficient. It must stand where a
  // runner reads it: a step's `with:`. A bare `repository: <org>/<repo>` at the
  // top of a document is a key wearing a machine hat, and outside YAML entirely
  // it is prose.
  const step = (body) => `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ${body}\n`;
  scanTree((t) => {
    for (const rel of [".github/workflows/x.yml", ".github/actions/n/action.yaml", "compose.yml", "deploy/values.yaml"]) {
      assert.deepEqual(t.ids(rel, step("repository: cinatra-ai/ops")), [], `a checkout input is a machine form: ${rel}`);
      assert.deepEqual(t.ids(rel, "repository: cinatra-ai/ops\n"), ["SLG_PRIVATE_REPO_REF"],
        `a bare key at the document root is not a checkout: ${rel}`);
    }
    for (const rel of ["docs/runbook.md", "scripts/deploy.sh", "notes.txt", "src/app.ts"]) {
      assert.deepEqual(t.ids(rel, step("repository: cinatra-ai/ops")), ["SLG_PRIVATE_REPO_REF"],
        `outside YAML there is no document to read: ${rel}`);
    }
  });
});

test("a `repositories:` FLOW SEQUENCE is not a value any Actions location carries", () => {
  // The grammar still reads a paired, fully validated sequence (matchRule
  // covers that above), and the structural rule now decides whether the file
  // actually carries such a value. No Actions input takes a LIST at
  // `repository:` — a checkout takes one string — so a parsed document never
  // declares one, and the sequence is a finding wherever it stands. Excusing it
  // would mean excusing a value no runner ever reads.
  const seq = "jobs:\n  build:\n    steps:\n      - with:\n          repositories: [cinatra-ai/wp-theme]\n";
  scanTree((t) => {
    assert.deepEqual(t.ids(".github/workflows/x.yml", seq), ["SLG_PRIVATE_REPO_REF"]);
    assert.deepEqual(t.ids("compose.yml", "repositories: [cinatra-ai/wp-theme]\n"), ["SLG_PRIVATE_REPO_REF"]);
    // Not vacuous: the SCALAR spelling of the same input, at the same location,
    // is excused — so what fails here is the list, not the key.
    assert.deepEqual(t.ids(".github/workflows/x.yml",
      "jobs:\n  build:\n    steps:\n      - with:\n          repository: cinatra-ai/wp-theme\n"), []);
  });
});

test("a legitimate SCALAR checkout does not excuse a FLOW SEQUENCE in the SAME document", () => {
  // The case the two scans above cannot see, because each writes its own file:
  // one document carrying BOTH forms. The workflow really checks out
  // `cinatra-ai/wp-theme` at a step's `with:` (a scalar, excused), and the
  // `repositories: [...]` line elsewhere in the same document is still a
  // finding. Node kinds are kept apart INSIDE a file: the legitimate-value set
  // holds the scalars the document declares, and the flow form asks with a
  // sequence key no scalar can answer. Reduced to the entry's bare text — which
  // is what the flow matcher captures — the honest step at line 7 excused every
  // list in the file.
  const wf = [
    "name: build",                                    // 1
    "jobs:",                                          // 2
    "  build:",                                       // 3
    "    steps:",                                     // 4
    "      - uses: actions/checkout@v4",              // 5
    "        with:",                                  // 6
    "          repository: cinatra-ai/wp-theme",      // 7  a real checkout input
    "      - name: fan out",                          // 8
    "        with:",                                  // 9
    "          repositories: [cinatra-ai/wp-theme]",  // 10 no Actions input takes a LIST
    "",
  ].join("\n");
  const rel = ".github/workflows/build.yml";
  scanTree((t) => {
    assert.deepEqual(t.lines(rel, wf), [10],
      "the flow sequence is a finding even though the same file legitimately checks the repository out");
    const flagged = t.findings(rel, wf);
    assert.equal(flagged[0].rule, "SLG_PRIVATE_REPO_REF");
    // NOT VACUOUS, both ways: the scalar step alone is clean, and the list alone
    // is a finding — so what line 10 fails for is its node kind, nothing else.
    assert.deepEqual(t.ids(rel, wf.split("\n").slice(0, 7).join("\n") + "\n"), []);
    assert.deepEqual(t.ids(rel,
      "jobs:\n  build:\n    steps:\n      - with:\n          repositories: [cinatra-ai/wp-theme]\n"),
      ["SLG_PRIVATE_REPO_REF"]);
  });
});

test("a heredoc, a folded block and a `- |` item are TEXT — the parser knows what a line cannot", () => {
  // Three former review rounds in one file. A `run: |` heredoc, a `run: >-`
  // folded block and a `- |` sequence item are strings the runner never reads as
  // YAML, so no `uses:` inside them is a dispatch. The real step and the real
  // `with:` mapping around them are unchanged.
  const wf = [
    "name: deploy",
    "jobs:",
    "  build:",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          repository: cinatra-ai/ops",          // 7: a real checkout input
    "      - run: |",
    "          cat <<'EOF' > out.yml",
    "          uses: cinatra-ai/ops@main",           // 10: heredoc text, dispatched nowhere
    "",                                             // a blank line continues the block
    "          repository: cinatra-ai/ops",          // 12: text — but see below
    "          EOF",
    "      - run: >-",
    "          uses: cinatra-ai/ops@main",           // 15: folded text
    "      - uses: cinatra-ai/ops/.github/workflows/deploy.yml@main",  // 16: a real step
    "",
  ];
  scanTree((t) => {
    assert.deepEqual(t.lines(".github/workflows/deploy.yml", wf.join("\n")), [10, 15],
      "the heredoc and folded `uses:` values are dispatched nowhere in this file");
  });
  // Line 12 is the DUPLICATE case, and it is excused deliberately: this file
  // really does check out `cinatra-ai/ops` at line 7, so the name is already in
  // it and repeating it inside a heredoc reveals nothing the file does not
  // already say. Membership is by VALUE for exactly that reason.
});

test("a `- |` item, a colon-carrying key and a bare `|` document are TEXT too", () => {
  const wf = [
    "name: deploy",
    "jobs:",
    "  build:",
    "    steps:",
    "      - name: write the payloads",
    "        payloads:",
    "          - |",
    "            repository: cinatra-ai/ops",   // 8: text, and a value line 11 dispatches
    "            uses: cinatra-ai/ops@main",    // 9: text, dispatched nowhere
    "        with:",
    "          repository: cinatra-ai/ops",     // 11: a real checkout input
    "      - run:x: |",
    "          uses: cinatra-ai/ops@main",      // 13: a colon-carrying key still opens a block
    "      - run: |",
    "          uses: cinatra-ai/ops@main",      // 15: the plain `key: |` block
    "      - uses: cinatra-ai/ops/.github/workflows/deploy.yml@main",  // 16: a real step
    "",
  ];
  scanTree((t) => {
    assert.deepEqual(t.lines(".github/workflows/deploy.yml", wf.join("\n")), [9, 13, 15]);
    // A whole-document scalar carries no jobs at all, so nothing in it is a
    // dispatch — including a `--- |` document, which opens one mid-stream.
    assert.deepEqual(t.ids("doc.yml", "|\n  repository: cinatra-ai/ops\n"), ["SLG_PRIVATE_REPO_REF"]);
    assert.deepEqual(t.ids("doc.yml", "--- |\njobs:\n  gate:\n    uses: cinatra-ai/ops@main\n"), ["SLG_PRIVATE_REPO_REF"]);
    // Not vacuous: the same key, at a real Actions location, is excused.
    assert.deepEqual(t.ids("doc.yml", "jobs:\n  a:\n    steps:\n      - with:\n          repository: cinatra-ai/ops\n"), []);
  });
});

test("a multi-line quoted scalar and a quoted KEY are TEXT", () => {
  // `description: "` opens ONE string value that runs to the next `"`, so the
  // lines between it are text — and a quoted key (`"NOTE": "`) opens exactly the
  // same way. Both were review rounds; both are ordinary strings to a parser.
  const wf = (key) => [
    "name: deploy",
    "jobs:",
    "  build:",
    "    steps:",
    "      - name: note",
    `        ${key}: "`,
    "          repository: cinatra-ai/ops",   // 7: text, and a value line 11 dispatches
    "          uses: cinatra-ai/ops@main",    // 8: text, dispatched nowhere
    '          "',
    "        with:",
    "          repository: cinatra-ai/ops",   // 11: a real checkout input
    "      - uses: cinatra-ai/ops/.github/workflows/deploy.yml@main",  // 12: a real step
    "",
  ].join("\n");
  scanTree((t) => {
    assert.deepEqual(t.lines(".github/workflows/deploy.yml", wf("description")), [8]);
    assert.deepEqual(t.lines(".github/workflows/deploy.yml", wf('"NOTE"')), [8],
      "a quoted key opens a quoted scalar exactly like a bare one");
    // A quoted scalar that CLOSES on its own line opens no text region: the
    // mapping under it is a mapping, including through the `\"` and `''` escapes.
    for (const opening of [
      'description: "just a note"',
      'description: "he said \\"hi\\""',
      "description: 'it''s fine'",
      'description: "a note"  # and a comment',
    ]) {
      assert.deepEqual(
        t.ids(".github/workflows/x.yml",
          `jobs:\n  a:\n    steps:\n      - name: note\n        ${opening}\n        with:\n          repository: cinatra-ai/ops\n`),
        [], `a closed quoted scalar excuses nothing after it: ${opening}`,
      );
    }
  });
});

test("an `env:` mapping whose key is `uses`, and an anchored block, are not dispatches", () => {
  // Two more former rounds. `env:` takes a mapping of NAMES to values, so a
  // variable that happens to be called `uses` is an environment variable, not a
  // step; and an anchor between the key and the block indicator (`run: &payload |`)
  // still opens a block scalar.
  scanTree((t) => {
    assert.deepEqual(
      t.ids(".github/workflows/x.yml", "jobs:\n  a:\n    steps:\n      - env:\n          uses: cinatra-ai/ops@main\n"),
      ["SLG_PRIVATE_REPO_REF"], "an env var named `uses` dispatches nothing");
    assert.deepEqual(
      t.ids(".github/workflows/x.yml", "jobs:\n  a:\n    steps:\n      - run: &payload |\n          uses: cinatra-ai/ops@main\n"),
      ["SLG_PRIVATE_REPO_REF"], "an anchor does not make a heredoc a step");
    // Not vacuous: the same value, as the step's own `uses:`, is a dispatch.
    assert.deepEqual(t.ids(".github/workflows/x.yml", "jobs:\n  a:\n    steps:\n      - uses: cinatra-ai/ops@main\n"), []);
  });
});

test("a value the file really dispatches is excused wherever it appears", () => {
  // The other half of value-membership, stated once on its own: a name the file
  // already carries in a live dispatch is not made secret by appearing again in
  // a heredoc. What the gate stops is a private name a public file would not
  // otherwise carry — and this file carries it either way.
  const dispatched = "cinatra-ai/ops/.github/workflows/deploy.yml@main";
  const wf = (inside) => "name: deploy\njobs:\n"
    + `  deploy:\n    uses: ${dispatched}\n`
    + `  build:\n    steps:\n      - run: |\n          uses: ${inside}\n`;
  scanTree((t) => {
    assert.deepEqual(t.ids(".github/workflows/deploy.yml", wf(dispatched)), [],
      "the heredoc repeats a value this very file dispatches");
    assert.deepEqual(t.ids(".github/workflows/deploy.yml", wf("cinatra-ai/ops/.github/workflows/deploy.yml@v1")),
      ["SLG_PRIVATE_REPO_REF"], "another ref is another value, and this file dispatches nothing like it");
  });
});

test("a YAML file that does not PARSE gets no carve-out at all", () => {
  // Fail closed. A document nobody can read has no locations, so nothing in it
  // stands at one — a broken file must never be a place to hide a reference.
  const step = "jobs:\n  build:\n    steps:\n      - uses: cinatra-ai/ops/.github/workflows/deploy.yml@main\n";
  scanTree((t) => {
    assert.deepEqual(t.ids(".github/workflows/deploy.yml", step), [], "the file parses: the step is a dispatch");
    assert.deepEqual(t.ids(".github/workflows/deploy.yml", `name: deploy\nname: deploy\n${step}`),
      ["SLG_PRIVATE_REPO_REF"], "a duplicated key is not YAML, so there is no document to appeal to");
    assert.deepEqual(t.ids(".github/workflows/deploy.yml", `${step}      - description: "unterminated\n`),
      ["SLG_PRIVATE_REPO_REF"], "an unterminated quoted scalar is not YAML either");
  });
});

test("the VENDORED YAML parser is the file its provenance records", () => {
  // The drift guard for scripts/lib/vendor/js-yaml/. The engine parses YAML with
  // a copy of a published MIT package, committed because the gate runs in
  // consuming repositories' CI with no `npm install`. A copy nobody can verify
  // is a copy nobody should trust, so the digest is recorded beside it and
  // recomputed here: editing the parser, or refreshing it without updating
  // PROVENANCE.md, fails this test.
  const dir = path.join(import.meta.dirname, "..", "lib", "vendor", "js-yaml");
  const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "js-yaml.mjs"))).digest("hex");
  const provenance = fs.readFileSync(path.join(dir, "PROVENANCE.md"), "utf8");
  const recorded = provenance.match(/vendored file sha256[^`]*`([0-9a-f]{64})`/);
  assert.ok(recorded, "PROVENANCE.md must record the vendored file's sha256");
  assert.equal(digest, recorded[1],
    "scripts/lib/vendor/js-yaml/js-yaml.mjs no longer matches the digest in PROVENANCE.md — "
    + "re-vendor from the published tarball and update the provenance in the same change");
  assert.ok(fs.existsSync(path.join(dir, "LICENSE")), "the vendored copy ships its licence");
  assert.match(provenance, /registry\.npmjs\.org/, "the provenance names the tarball it came from");
  assert.match(provenance, /sha512-/, "the provenance records the registry integrity of that tarball");
});

// --------------------------------------------------------------------------
// The name grammar: a leading `-`, and a token that must END at a boundary.
// --------------------------------------------------------------------------

test("a leading hyphen is a legal repository name, and it is nominated", () => {
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  const re = new RegExp(probe.re.source, probe.re.flags);
  assert.equal(re.exec("see cinatra-ai/-secret here")[0], "cinatra-ai/-secret");
  assert.equal(isValidRepoName("-secret"), true);
});

test("an over-long run is NOT truncated to a name that must 404", () => {
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  const nameOf = (line) => {
    const re = new RegExp(probe.re.source, probe.re.flags);
    const m = re.exec(line);
    return m ? m[0].split("/")[1] : null;
  };
  const at100 = "a".repeat(REPO_NAME_MAX);
  assert.equal(nameOf(`see cinatra-ai/${at100} here`), at100, "a 100-character name is nominated");
  assert.equal(nameOf(`see cinatra-ai/${at100}.x here`), null, "the run continues past the ceiling: not a name");
  assert.equal(nameOf(`see cinatra-ai/${"a".repeat(REPO_NAME_MAX + 1)} here`), null, "101 characters is not a name");
});

// --------------------------------------------------------------------------
// `.git` is a clone suffix, recognised BEFORE the dotted-sibling boundary.
// --------------------------------------------------------------------------

test("a `.git` clone suffix names the SAME repository, in every lane", () => {
  // The defect this locks: `.git` was normalised away only AFTER the
  // dotted-sibling boundary had already rejected the token, so the clone form of
  // a private repository produced no finding in either lane.
  const rules = buildRules({}, "public-strict", null);
  const total = (line) => rules.reduce((n, r) => n + matchRule(r, line), 0);
  for (const line of [
    "clone cinatra-ai/engineering.git now",
    "git@github.com:cinatra-ai/ops.git",
    "clone engineering-proofs-private.git now",
    "https://github.com/cinatra-ai/engineering.git/issues/0",
    "clone cinatra-ai/design.git today",
  ]) {
    assert.equal(total(line), 1, `the clone form is the same repository: ${JSON.stringify(line)}`);
  }
  // …while a DOTTED SIBLING is still a different repository, claimed by nobody
  // offline (the probe owns it).
  for (const line of [
    "the cinatra-ai/engineering.gitlab mirror",
    "see cinatra-ai/engineering.tools for the sibling",
  ]) {
    assert.equal(total(line), 0, `a dotted sibling is not the tracker: ${JSON.stringify(line)}`);
  }
});

test("a token of nothing but dots is not a repository name, and is never nominated", () => {
  // GitHub rejects `.`, `..` and every longer run. The guard used to stop at two
  // dots, so an ellipsis (`<org>/...`) was nominated as the repository `.` and
  // spent a probe request on a name that can only 404.
  for (const name of [".", "..", "...", "....."]) {
    assert.equal(isValidRepoName(name), false, `${JSON.stringify(name)} is not a name`);
  }
  assert.equal(isValidRepoName(".github-private"), true);
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  const nameOf = (line) => {
    const m = new RegExp(probe.re.source, probe.re.flags).exec(line);
    return m ? m[0].split("/")[1] : null;
  };
  for (const line of ["see cinatra-ai/... for the rest", "see cinatra-ai/.. here", "see cinatra-ai/. here"]) {
    assert.equal(nameOf(line), null, `nothing to nominate in ${JSON.stringify(line)}`);
    assert.equal(matchRule(probe, line), 0, `and no candidate: ${JSON.stringify(line)}`);
  }
  assert.equal(nameOf("see cinatra-ai/.github-private here"), ".github-private", "a leading dot is still a name");
});

test("`<org>/.git` is a NAME, not an empty clone suffix — it is nominated and probed", async () => {
  // The defect this locks: `.git` is a valid name under the grammar, but
  // normalisation stripped the suffix to an EMPTY base, and both lanes drop an
  // empty name — so the reference was excluded without ever being asked about.
  assert.equal(normalizeRepoName(".git"), ".git", "stripping would leave no name at all");
  assert.equal(normalizeRepoName("ops.git"), "ops", "a real clone suffix still comes off");
  assert.equal(orgPathRepoName("cinatra-ai/.git"), ".git");
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  assert.equal(matchRule(probe, "see cinatra-ai/.git here"), 1, "it is nominated like any other name");
  const calls = stubFetch(() => apiResponse(404, { message: "Not Found" }));
  const out = await resolveProbeFindings([candidate(".git")], probeCtx());
  assert.equal(calls.length, 1, "the name is actually asked about");
  assert.equal(out.length, 1, "and a 404 is a finding");
  assert.equal(out[0].rule, PROBE_RULE_ID);
});

// --------------------------------------------------------------------------
// A numeric issue reference must TERMINATE.
// --------------------------------------------------------------------------

test("`#<n>` that runs into another alphanumeric is not an issue reference", () => {
  const rules = buildRules({}, "public-strict", null);
  const total = (line) => rules.reduce((n, r) => n + matchRule(r, line), 0);
  for (const line of [
    "the eng#0abc digest is not an issue",
    "the cinatra-engineering#0abc digest is not an issue",
    "the engineering#0abc digest is not an issue",
  ]) {
    assert.equal(total(line), 0, `not an issue citation: ${JSON.stringify(line)}`);
  }
  // The real citations are unchanged.
  for (const line of [
    "rationale in eng#0 here",
    "per ratified spec cinatra-engineering#0",
    "see engineering#0 for the rationale",
    "closed as eng#0.",
    "closed as eng#0, then reopened",
  ]) {
    assert.equal(total(line), 1, `a terminated citation still flags: ${JSON.stringify(line)}`);
  }
});

// --------------------------------------------------------------------------
// AGGREGATE: every active rule over one corpus. Exactly one finding per leaked
// form (no double-flag), zero for everything that is allowed to stay.
// --------------------------------------------------------------------------

test("aggregate: every active rule over one corpus agrees on the count", () => {
  const rules = buildRules({}, "public-strict", null);
  const total = (line) => rules.reduce((n, r) => n + matchRule(r, line), 0);
  const corpus = [
    // The npm scope: transparent to a private name, opaque to everything else.
    ['import x from "@cinatra-ai/engineering";', 1],
    ['import x from "@cinatra-ai/cinatra-cli";', 0],
    ['import { x } from "@cinatra-ai/design";', 1],
    ['import x from "@cinatra-ai/engineering-proofs-private";', 1],
    // The machine grammars (and the forms that only look like them).
    ["uses: cinatra-ai/ops/.github/workflows/deploy.yml@main", 0],
    ["  - uses: cinatra-ai/ops@release/1.0  # pinned", 0],
    ["repository: cinatra-ai/wp-theme", 0],
    ["  repositories: [cinatra-ai/wp-theme]", 0],
    ["REMOTE=https://github.com/cinatra-ai/wp-theme.git", 0],
    ["# uses: cinatra-ai/ops@main", 1],
    ["uses: cinatra-ai/ops@main and then some", 1],
    ["repository: cinatra-ai/ops#0", 1],
    ["https://github.com/cinatra-ai/wp-theme.git/issues/0", 1],
    // The clone suffix.
    ["clone cinatra-ai/engineering.git now", 1],
    ["git@github.com:cinatra-ai/ops.git", 1],
    ["clone engineering-proofs-private.git now", 1],
    ["https://github.com/cinatra-ai/engineering.git/issues/0", 1],
    ["the cinatra-ai/engineering.gitlab mirror", 0],
    ["see cinatra-ai/engineering.tools for the sibling", 0],
    // Terminated issue references.
    ["the eng#0abc digest is not an issue", 0],
    ["rationale in eng#0 here", 1],
    // The machine grammars, exactly: the gap, the paired sequence, the case
    // fold, and the anchored clone form.
    ["uses:cinatra-ai/ops@main", 1],
    ["repository: cinatra-ai/ops,#0", 1],
    ["  repositories: [cinatra-ai/wp-theme, cinatra-ai/wp-theme]", 0],
    ["uses: Cinatra-AI/Ops@main", 0],
    ['import x from "@cinatra-ai/wp-theme.git";', 1],
    ["see cinatra-ai/... for the rest", 0],
  ];
  for (const [line, expected] of corpus) {
    assert.equal(total(line), expected, `${expected} finding(s) expected for ${JSON.stringify(line)}`);
  }
});

// --------------------------------------------------------------------------
// PROTOTYPE POLLUTION: a parsed document is attacker-shaped input.
//
// The engine's two structural readers decide who gets a carve-out
// (legitimateActionValues) and which pin is live (readUsesPins), and both answer
// by reading `jobs` off a parsed document. A YAML document that reaches the
// JavaScript prototype chain therefore forges BOTH: a private name excused
// because "the file dispatches it", and an expired exemption kept alive because
// "the caller still pins that sha" — neither of which the file says.
//
// js-yaml 4.1.0 guarded a directly written `__proto__` key but not the MERGE
// path, so the merge form below produced exactly that. The vendored parser is
// 4.1.1, which fixes it — and NONE of the tests here depend on that, because a
// dependency's next version is a bug nobody has found yet. Each case is written
// against the ENGINE's guards, and each guard alone is sufficient.
// --------------------------------------------------------------------------

const POLLUTED_SHA = "4d5e6f708192a3b4c5d607182930a4b5c6d7e8f9";
// The published payload shape: an anchored mapping whose `__proto__` key carries
// a whole fabricated dispatch, merged into the document root. Under 4.1.0 the
// root's own keys stayed innocent while its PROTOTYPE supplied `jobs`.
const MERGE_PAYLOAD = [
  "payload: &payload",
  "  __proto__:",
  "    jobs:",
  "      gate:",
  `        uses: cinatra-ai/ops/.github/workflows/deploy.yml@${POLLUTED_SHA}`,
  "<<: *payload",
  "name: harmless",
  "",
].join("\n");
// The same forgery without the merge: a plain `__proto__` mapping at the root.
const PLAIN_PROTO_PAYLOAD = [
  "__proto__:",
  "  jobs:",
  "    gate:",
  `      uses: cinatra-ai/ops/.github/workflows/deploy.yml@${POLLUTED_SHA}`,
  "",
].join("\n");
// The HONEST twin: the same dispatch, declared the way a real caller declares
// it. Every refusal below is measured against this, so "the gate refuses
// everything" can never pass for "the gate is safe".
const HONEST_CALLER = [
  "name: harmless",
  "jobs:",
  "  gate:",
  `    uses: cinatra-ai/ops/.github/workflows/deploy.yml@${POLLUTED_SHA}`,
  "",
].join("\n");

test("a document that reaches the prototype chain buys NO carve-out, in either form", () => {
  // Both halves of the finding, end to end through scanFile: the private name in
  // the payload is a FINDING, because a document carrying a prototype-reaching
  // key is a document whose structure nobody can state — the same answer a
  // syntax error gets, and for the same reason.
  const rel = ".github/workflows/deploy.yml";
  scanTree((t) => {
    assert.deepEqual(t.ids(rel, MERGE_PAYLOAD), ["SLG_PRIVATE_REPO_REF"],
      "the merge form (`<<:` onto a `__proto__` payload) must not fabricate a dispatch");
    assert.deepEqual(t.ids(rel, PLAIN_PROTO_PAYLOAD), ["SLG_PRIVATE_REPO_REF"],
      "a plain `__proto__` mapping must not fabricate a dispatch either");
    // NOT VACUOUS: the identical dispatch, honestly declared, is still excused.
    // Without this leg the two assertions above would also pass if the carve-out
    // had simply been deleted.
    assert.deepEqual(t.ids(rel, HONEST_CALLER), [],
      "a real caller that really dispatches the value keeps its carve-out");
  });
});

test("a prototype-reaching mapping key makes the document unreadable at any depth", () => {
  // `__proto__`, `constructor` and `prototype` are refused wholesale rather than
  // sanitised, and the refusal is not limited to the document root: the payload
  // that matters is always nested. No workflow, action or compose file needs
  // those keys, so the refusal costs nothing real.
  for (const key of PROTOTYPE_KEYS) {
    assert.equal(parseYamlDocuments(`${key}:\n  a: 1\n`), null, `a root \`${key}:\` key is unreadable`);
    assert.equal(parseYamlDocuments(`on: push\njobs:\n  a:\n    steps:\n      - with:\n          ${key}: 1\n`), null,
      `a nested \`${key}:\` key is unreadable too`);
    assert.equal(parseYamlDocuments(`a:\n  - b:\n      ${key}: 1\n`), null,
      `\`${key}:\` inside a sequence is unreadable too`);
  }
  assert.equal(legitimateActionValues(MERGE_PAYLOAD), null, "no value set at all");
  assert.equal(readUsesPins(MERGE_PAYLOAD), null, "no pins at all");
  assert.equal(legitimateActionValues(PLAIN_PROTO_PAYLOAD), null);
  assert.equal(readUsesPins(PLAIN_PROTO_PAYLOAD), null);
  // The honest twin still parses, still yields its value and still yields its
  // pin — the refusal is keyed to the key, not to the shape of a workflow.
  assert.deepEqual([...legitimateActionValues(HONEST_CALLER)],
    [`cinatra-ai/ops/.github/workflows/deploy.yml@${POLLUTED_SHA}`]);
  assert.deepEqual(readUsesPins(HONEST_CALLER),
    [{ target: "cinatra-ai/ops/.github/workflows/deploy.yml", ref: POLLUTED_SHA }]);
});

test("hasPrototypeKey walks own properties, follows containers, and survives cycles", () => {
  assert.equal(hasPrototypeKey({ a: { b: [{ c: 1 }] } }, new Set()), false, "an ordinary document is clean");
  assert.equal(hasPrototypeKey([[{ deep: { prototype: 1 } }]], new Set()), true, "nested inside sequences");
  // An INHERITED `__proto__`-ish key is not the document's own key, so it does
  // not make the document unreadable — the own-property reads below are what
  // makes it harmless, and confusing the two would refuse ordinary files.
  assert.equal(hasPrototypeKey(Object.assign(Object.create({ constructor: 1 }), { a: 1 }), new Set()), false);
  // YAML anchors make cycles; the walk must terminate rather than recurse away.
  const cyclic = { a: {} };
  cyclic.a.back = cyclic;
  assert.equal(hasPrototypeKey(cyclic, new Set()), false, "a cyclic document terminates");
  const cyclicBad = { a: { prototype: 1 } };
  cyclicBad.a.back = cyclicBad;
  assert.equal(hasPrototypeKey(cyclicBad, new Set()), true, "and a cyclic one still gets caught");
});

test("the readers read OWN properties only — an inherited `jobs` is not there", () => {
  // The guard that does not depend on the parser at all. Whatever a future
  // parser hands back, a key the document does not OWN is not a key the engine
  // will read, and an object whose prototype has been replaced is not a mapping
  // the engine will read at all.
  const forged = {
    jobs: { gate: { uses: `cinatra-ai/ops/.github/workflows/deploy.yml@${POLLUTED_SHA}` } },
    runs: { steps: [{ uses: `cinatra-ai/ops/actions/notify@${POLLUTED_SHA}` }] },
  };
  const doc = Object.create(forged);
  doc.name = "harmless";

  // The two predicates every read in legitimateActionValues and readUsesPins
  // goes through, on the forged document.
  assert.equal(isPlainObject(doc), false,
    "an object whose prototype is neither Object.prototype nor null is not a mapping this engine reads");
  assert.equal(own(doc, "jobs"), undefined, "`jobs` is inherited, so it is absent");
  assert.equal(own(doc, "runs"), undefined, "`runs` is inherited, so it is absent");
  assert.equal(own(doc, "name"), "harmless", "and an OWN key is still read normally");

  // Same forgery one level down: an ordinary root whose `jobs` mapping inherits
  // its job. `Object.getOwnPropertyNames` is what the reader enumerates, so the
  // inherited job id is never visited.
  const jobs = Object.create({ gate: { uses: `cinatra-ai/ops/.github/workflows/deploy.yml@${POLLUTED_SHA}` } });
  assert.deepEqual(Object.getOwnPropertyNames(jobs), [], "no job ids to enumerate");
  assert.equal(own(jobs, "gate"), undefined, "the inherited job is absent");

  // A null-prototype mapping IS ordinary (js-yaml never returns one, but a
  // future parser might, and refusing it would be a refusal on valid input).
  const bare = Object.assign(Object.create(null), { jobs: { gate: { uses: "a/b@c" } } });
  assert.equal(isPlainObject(bare), true, "a null-prototype mapping is still a mapping");
  assert.deepEqual(own(bare, "jobs"), { gate: { uses: "a/b@c" } });
});

test("a parsed SEQUENCE is walked by own index — a polluted hole is not an element", () => {
  // `for (const x of arr)` reads 0..length-1 THROUGH the prototype chain, so a
  // polluted `Array.prototype[1]` hands a HOLE a value the document never
  // contained: an inherited step whose `uses:` forges a dispatch, an inherited
  // document whose `jobs` forges a pin. YAML cannot spell a hole, so the seam
  // hands the readers the document a hostile parser would return; the walk must
  // see own indices only.
  const forged = `cinatra-ai/ops/.github/workflows/deploy.yml@${POLLUTED_SHA}`;
  const steps = [{ uses: "actions/checkout@v4" }];
  steps.length = 2;                       // index 1 is a HOLE, not a value
  const docsWithHole = [{ name: "caller" }];
  docsWithHole.length = 2;                // so is this one
  try {
    Array.prototype[1] = { uses: forged, jobs: { gate: { uses: forged } } };
    assert.equal(steps[1].uses, forged, "the hole really does resolve through the prototype");

    setYamlLoader(() => [{ jobs: { build: { steps } } }]);
    const values = legitimateActionValues("the loader decides, not this text");
    assert.deepEqual([...values], ["actions/checkout@v4"],
      "only the OWN step is a step; the hole yields no legitimate value");
    assert.equal(values.has(forged), false, "and the inherited dispatch is not in the file");

    setYamlLoader(() => docsWithHole);
    assert.deepEqual(readUsesPins("the loader decides, not this text"), [],
      "an inherited DOCUMENT is not a document either, so it pins nothing");

    // The walk the two readers share, and the predicate under it.
    assert.deepEqual(ownItems(steps), [{ uses: "actions/checkout@v4" }]);
    assert.deepEqual(ownItems(Object.assign([], { 0: "a", jobs: "not an element" })), ["a"]);
    assert.equal(isPlainArray(steps), true);
    assert.equal(isPlainArray(Object.setPrototypeOf([], { 0: forged })), false,
      "an array whose prototype has been replaced is not the parser's own sequence");
    assert.deepEqual(ownItems(Object.setPrototypeOf([], { 0: forged })), []);
    // The pollution walker reads own indices too: an inherited element cannot
    // make a clean document unreadable, and a hole is not a place to hide one.
    const holed = [{ a: 1 }];
    holed.length = 2;
    assert.equal(hasPrototypeKey(holed, new Set()), false, "the inherited element is not the document's");
  } finally {
    setYamlLoader(null);
    delete Array.prototype[1];
  }
  assert.equal(Object.hasOwn(Array.prototype, "1"), false, "the pollution is cleaned up");
});

test("a parser that pollutes DURING a parse aborts the ENGINE'S SCAN PATH", () => {
  // The comparator test below proves the guard reports a changed prototype; this
  // one proves the guard is WIRED to the parse — that a run cannot reach a
  // verdict past a parser that edited the interpreter halfway through, which is
  // exactly what a 4.1.0-class parser bug does. The seam installs a loader that
  // parses honestly and pollutes around the parse, and the named abort must come
  // back out of scanFile.
  const rel = ".github/workflows/deploy.yml";
  setYamlLoader((text) => {
    Object.prototype.jobs = { gate: { uses: `cinatra-ai/ops/.github/workflows/deploy.yml@${POLLUTED_SHA}` } };
    return jsYamlLoadAll(text);
  });
  try {
    scanTree((t) => {
      assert.throws(() => t.findings(rel, HONEST_CALLER), (e) => {
        assert.equal(e.name, PROTOTYPE_POLLUTION_ERROR, "the abort is NAMED, not a generic scanner failure");
        assert.match(e.message, /Object\.prototype changed shape during a YAML parse/);
        assert.match(e.message, /added jobs/, "and it names what the parse added");
        assert.match(e.message, /aborted rather than completed/);
        return true;
      }, "a polluted parse must abort the scan instead of returning findings");
    });
  } finally {
    setYamlLoader(null);
    delete Object.prototype.jobs;
  }
  // NOT VACUOUS: with the vendored loader back, that same file scans to a verdict.
  scanTree((t) => assert.deepEqual(t.ids(rel, HONEST_CALLER), [],
    "the honest caller is excused again once the parser behaves"));
});

test("assertPrototypesUnpolluted NAMES a builtin prototype that changed shape (the comparator alone)", () => {
  // Guard (c): the last line of defence. If the interpreter this gate reasons
  // with has been edited by the input it was reading, then nothing the run has
  // said — including the clean verdicts already printed — can be trusted, so the
  // run ends with a NAMED error instead of a result.
  const snapshot = snapshotPrototypes();
  assert.doesNotThrow(() => assertPrototypesUnpolluted(snapshot), "a clean interpreter is silent");

  Object.prototype.jobs = { gate: { uses: `cinatra-ai/ops/.github/workflows/deploy.yml@${POLLUTED_SHA}` } };
  try {
    assert.throws(
      () => assertPrototypesUnpolluted(snapshot),
      (e) => {
        assert.equal(e.name, PROTOTYPE_POLLUTION_ERROR, "the error is NAMED, not a generic failure");
        assert.match(e.message, /Object\.prototype changed shape/);
        assert.match(e.message, /added jobs/, "it names what changed");
        assert.match(e.message, /aborted rather than completed/, "and says the run's output is void");
        return true;
      },
    );
  } finally {
    delete Object.prototype.jobs;
  }
  assert.doesNotThrow(() => assertPrototypesUnpolluted(snapshot), "and it is silent again once cleaned up");

  // A REMOVED name is a change too: deletion is as much an edit as addition.
  const arraySnapshot = snapshotPrototypes();
  const flatten = Array.prototype.flat;
  delete Array.prototype.flat;
  try {
    assert.throws(() => assertPrototypesUnpolluted(arraySnapshot), (e) => {
      assert.equal(e.name, PROTOTYPE_POLLUTION_ERROR);
      assert.match(e.message, /Array\.prototype changed shape .*removed flat/);
      return true;
    });
  } finally {
    Object.defineProperty(Array.prototype, "flat", { value: flatten, writable: true, configurable: true, enumerable: false });
  }
  assert.doesNotThrow(() => assertPrototypesUnpolluted(snapshotPrototypes()));
});

test("a PIN FILE that reaches the prototype chain is a CONFIG ERROR, not a live pin", () => {
  // The other half of the finding. An expiry is keyed to a sha the caller really
  // pins; a payload document that forges `jobs.<id>.uses` would keep an expired
  // basename exemption alive forever. Unreadable means unreadable: the exemption
  // whose expiry cannot be evaluated does not stay in force.
  const forgedCaller = [
    "payload: &payload",
    "  __proto__:",
    "    jobs:",
    "      gate:",
    `        uses: ${PIN_TARGET}@${PIN_A}`,
    "<<: *payload",
    "name: caller",
    "",
  ].join("\n");
  const dir = expiryTree({
    "notes.txt": `${EXPIRY_MARKER}\n`,
    ".github/workflows/caller.yml": forgedCaller,
    "config/gate.json": JSON.stringify(liveConfig, null, 1),
  });
  try {
    const r = runExpiryGate(dir);
    assert.equal(r.status, 1, `a forged pin file must be a config error, got ${r.status}: ${r.err}`);
    assert.match(r.err, /config error/);
    assert.match(r.err, /not parseable YAML/);
    assert.match(r.err, /__proto__/, "the message names why the document was refused");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // NOT VACUOUS: the same tree with the pin honestly declared is green, so the
  // refusal above is about the payload and not about the fixture.
  const honest = expiryTree({
    "notes.txt": `${EXPIRY_MARKER}\n`,
    ".github/workflows/caller.yml": workflowPinning(PIN_A),
    "config/gate.json": JSON.stringify(liveConfig, null, 1),
  });
  try {
    assert.equal(runExpiryGate(honest).status, 0, "the honest caller keeps its live exemption");
  } finally { fs.rmSync(honest, { recursive: true, force: true }); }
});

test("the vendored parser itself no longer pollutes through the merge path", () => {
  // The dependency half of the fix, asserted directly rather than assumed from a
  // version string: 4.1.0 set the merge target's prototype here. This is a
  // REGRESSION guard on the vendored copy — if a future re-vendor reintroduces
  // it, the engine's own guards still hold (every test above), but the operator
  // should be told the parser moved backwards.
  const docs = parseYamlDocumentsUnguarded(MERGE_PAYLOAD);
  for (const doc of docs) {
    assert.equal(Object.getPrototypeOf(doc), Object.prototype,
      "the merge must not replace the document's prototype");
    assert.equal(Object.hasOwn(doc, "jobs"), false, "and it declares no `jobs` of its own");
  }
});

// Parses with the vendored parser directly, bypassing the engine's refusals, so
// the test above can inspect what the PARSER produced rather than what the
// engine decided to do about it.
function parseYamlDocumentsUnguarded(text) {
  return jsYamlLoadAll(text);
}
