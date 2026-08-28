import { test } from "node:test";
import assert from "node:assert/strict";
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
  PROBE_MAX_NAMES, PUBLIC_CACHE_TTL_DAYS,
} from "../source-leak-gate.mjs";

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
function matchRule(rule, line) {
  const re = new RegExp(rule.re.source, rule.re.flags);
  let m, found = 0;
  while ((m = re.exec(line)) !== null) {
    if (rule.contextExclude && rule.contextExclude(line)) return 0;
    if (!(rule.matchExclude && rule.matchExclude(m[0], line, m.index))) found++;
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
  const sanctioned = "see engineering#231 for the rationale";
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
    "see engineering#231 for the rationale",
    "filed engineering#5 upstream",
    "regressed by engineering#1099 last week",
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
    "reverse-engineering#5 is unrelated",              // hyphen before
    "re-engineering#5 marker",                          // hyphen before
    "bioengineering#5 domain token",                    // letter before
    "cinatra-ai/engineering#309 (universal rule owns)", // slash before -> universal's job, not double-flagged
    "legacy note per cinatra-engineering#119",          // trailing #<n> -> universal's job, NOT double-flagged
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
    { lineExcludes: ["^// PUBLIC-OK: historical note re engineering#5$"] },
    "public-strict",
    null,
  );
  const rule = withAllow.find((r) => r.id === "SLG_PRIVATE_ENG_REF_STRICT");
  assert.equal(matchRule(rule, "// PUBLIC-OK: historical note re engineering#5"), 0, "allowlisted line is excused");
  assert.ok(matchRule(rule, "a different engineering#5 reference") >= 1, "a different line still flags");
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

test("SLG_PRIVATE_REPO_REF flags the private proof-image twin and the other private repos", () => {
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  const hits = [
    "shots filed in cinatra-ai/engineering-proofs-private",
    "https://github.com/cinatra-ai/engineering-proofs-private/blob/main/shot.png",
    "https://raw.githubusercontent.com/cinatra-ai/engineering-proofs-private/main/shot.png",
    "see cinatra-ai/engineering-proofs-private#4 for the shots",
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
    // The npm-scope carve-out holds for the added members too:
    'import x from "@cinatra-ai/engineering-claude-plugin";',
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
    "opened engineering-proofs-private#4 for the shots",
    "see engineering-proofs-private/issues/4 directly",
    "engineering-proofs-private holds the originals",
    "(engineering-proofs-private) is where they land",
    // The one deliberate exception to the npm-scope carve-out: no package will
    // ever carry this name, so the @-scoped literal is a leak like any other.
    'import x from "@cinatra-ai/engineering-proofs-private";',
    "@cinatra-ai/engineering-proofs-private in a dependency list",
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
    // The carve-out is narrowed by ONE literal, not opened: every other
    // @-scoped package name is still untouched, including the public twin's.
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
    "uses: cinatra-ai/ops/.github/workflows/deploy.yml",
    'uses: "cinatra-ai/ops/.github/workflows/deploy.yml@abc123"',
    "repository: cinatra-ai/ops",
    "  repositories: [cinatra-ai/wp-theme]",
    'REMOTE="https://github.com/cinatra-ai/wp-theme.git"',
    "git clone https://github.com/cinatra-ai/wp-theme.git",
  ]) {
    assert.equal(matchRule(rule, line), 0, `required functional form should be excused: ${JSON.stringify(line)}`);
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
    "see cinatra-ai/ops#378 for the rationale",
    "https://github.com/cinatra-ai/ops/issues/378",
    "https://github.com/cinatra-ai/wp-theme/blob/main/style.css",
  ]) {
    assert.ok(matchRule(rule, line) >= 1, `should flag: ${JSON.stringify(line)}`);
  }
});

test("the functional carve-out is per MATCH, not per line", () => {
  // The whole reason for replacing the name-wide exemption: one line may carry
  // a required reference AND a leaked one, and only the required one is excused.
  const rule = byId.get("SLG_PRIVATE_REPO_REF");
  const line = "uses: cinatra-ai/ops/x.yml  # rationale in cinatra-ai/ops#378";
  assert.equal(matchRule(rule, line), 1, "the issue citation must still flag on a line with a legitimate `uses:`");
  assert.equal(functionalRefCovers("ops", line, line.indexOf("cinatra-ai/ops")), true, "the `uses:` occurrence is covered");
  assert.equal(functionalRefCovers("ops", line, line.lastIndexOf("cinatra-ai/ops")), false, "the citation is NOT covered");
});

test("the functional carve-out is keyed to its own repository, never shared", () => {
  const line = "uses: cinatra-ai/ops/x.yml";
  assert.equal(functionalRefCovers("ops", line, line.indexOf("cinatra-ai/ops")), true);
  assert.equal(functionalRefCovers("wp-theme", line, line.indexOf("cinatra-ai/ops")), false);
  for (const f of FUNCTIONAL_REPO_REFS) {
    assert.ok(PRIVATE_REPO_NAMES.includes(f.name), `${f.name} carries a carve-out but is not on the private list`);
  }
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
    "see cinatra-ai/ops#378 here",             // listed  -> static only
  ]) {
    const staticHits = statics.reduce((n, r) => n + matchRule(r, line), 0);
    const probeHits = matchRule(probe, line);
    assert.equal(staticHits + probeHits, 1, `exactly one lane must claim ${JSON.stringify(line)}`);
  }
});

test("a leading dot is a legal repository name", () => {
  const probe = buildRules({}, "default", null, { probe: true }).find((r) => r.id === PROBE_RULE_ID);
  const re = new RegExp(probe.re.source, probe.re.flags);
  assert.equal(re.exec("see cinatra-ai/.github-private notes")[0], "cinatra-ai/.github-private");
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

test("cache: malformed entries are hard errors, never silently ignored", () => {
  const dir = tmpdir();
  const bad = [
    { public: ["ci"] },                                            // legacy bare string
    { public: [{ name: "ci" }] },                                  // no verifiedAt
    { public: [{ name: "ci", verifiedAt: "10-03-2026" }] },        // wrong date shape
    { public: [{ name: "bad name", verifiedAt: "2026-03-10" }] },  // invalid repo name
    { public: [{ name: "ci.git", verifiedAt: "2026-03-10" }] },    // a clone suffix is not a name
    { public: [{ name: "-lead", verifiedAt: "2026-03-10" }] },     // must start with a dot or alnum
    { ttlDays: 7 },                                                // no public array
  ];
  try {
    for (const obj of bad) {
      const f = writeCache(dir, obj);
      assert.throws(() => loadKnownPublicRepos(f, { now: "2026-03-12T00:00:00Z" }),
        `should reject ${JSON.stringify(obj)}`);
    }
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
