import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildRules, scanFile, RULES,
  setProbeFetch, makeProbeContext, resolveRepoVisibility, resolveProbeFindings,
  loadKnownPublicRepos, PRIVATE_REPO_NAMES, PROBE_EXEMPT_NAMES,
  PROBE_RULE_ID, PROBE_ERROR_RULE_ID,
} from "../source-leak-gate.mjs";

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
    // Deliberately excluded, same functional class as the ops dispatch target:
    "the cinatra-ai/wp-theme staging remote",
    "REMOTE=https://github.com/cinatra-ai/wp-theme.git",
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
    "filed under cinatra-ai/engineering tracker",
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
