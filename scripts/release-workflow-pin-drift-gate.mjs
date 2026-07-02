#!/usr/bin/env node
/**
 * release-workflow-pin-drift-gate — fails CLOSED if any Cinatra extension /
 * connector repo's `.github/workflows/release.yml` calls the central
 * `reusable-extension-release.yml` at a ref that is NOT a gated ref (i.e. a ref
 * whose `release` job is NOT behind the `release-approval` Environment).
 *
 * WHY THIS EXISTS (the opt-in-vs-enforced-default trap):
 *   The release-approval Environment wall is applied by the reusable workflow's
 *   release job via `environment: release-approval`, which first appears at ref
 *   1e4448a (v0.1.1). A repo only gets the human-approval pause if it OPTS IN by
 *   pinning that gated ref. Any repo that keeps an older ungated pin
 *   (fea09b38 / v0.1.0), or a new/scaffolded repo that copies an old release.yml,
 *   silently FAILS OPEN: its tag publishes with NO approval pause. An opt-in-
 *   per-repo security control fails open for every repo that did not opt in.
 *   The durable fix is enforced-by-default: this gate scans EVERY extension repo
 *   and fails closed the moment any of them pins a non-gated ref.
 *
 * WHAT IT CHECKS (per repo):
 *   - release.yml exists,
 *   - it calls reusable-extension-release.yml,
 *   - the `uses:` ref is a pinned 40-char SHA (not a mutable tag/branch),
 *   - that SHA is in the committed gated-ref allowlist (config/release-workflow-gated-refs.json).
 *   Any of these failing => that repo is DRIFTED => the gate exits nonzero.
 *
 * WHY AN ALLOWLIST OF GATED SHAS (not a "minimum ref"):
 *   Commit SHAs are not orderable, so "below the gated minimum" cannot be a SHA
 *   comparison. The gated set is a CURATED allowlist: every ref whose release job
 *   carries the `environment: release-approval` wall. Publishing a new gated
 *   reusable-workflow tag => add its SHA to the allowlist (and Renovate/pin bumps
 *   move repos onto it). A ref NOT in the allowlist is treated as ungated.
 *
 * AUTH / EXECUTION MODEL (same shape as governance-drift-gate):
 *   Enumerating org repos + reading each release.yml across the org is done with
 *   an operator-provisioned token (default env RELEASE_PIN_DRIFT_READ_TOKEN;
 *   falls back to GH_TOKEN/GITHUB_TOKEN). This is a SCHEDULED / manual job, NOT a
 *   required PR status check (a fork PR has no such token, and the drift lives in
 *   OTHER repos than the one a PR touches). When NO token is available the gate
 *   SKIPS GREEN (exit 0 + ::notice) so it ships before the token is provisioned.
 *   When a token IS present but a read returns an error / unparseable data, the
 *   gate HARD FAILS — a degraded privileged read must not mask drift.
 *
 * The scan/verdict core (`auditPins`) is pure and offline-testable: it takes the
 * gated-ref allowlist and a map of { repo -> release.yml text | null }. The live
 * fetch (`fetchExtensionRepos`, via `gh api`) is a thin wrapper used only with
 * `--live`. A `--repos-json <file>` hook feeds the map directly for tests.
 *
 * Zero runtime dependencies (node builtins + the `gh` CLI for `--live`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const GATE_VERSION = "0.1.0";

const REUSABLE_WORKFLOW_PATH =
  "cinatra-ai/.github/.github/workflows/reusable-extension-release.yml";

/* ------------------------------- pin parsing ------------------------------- */

// A `uses:` line (block style, optional list dash + quotes) whose value is the
// reusable-extension-release workflow. Captures the value after the colon.
const USES_LINE_RE = /^\s*(?:-\s+)?(["']?)uses\1\s*:[ \t]*(.*?)[ \t]*$/;
// A pinned ref: <owner>/<repo>/.../<file>.yml@<40-hex>. Captures the 40-hex SHA.
const PINNED_SHA_RE = /@([0-9a-f]{40})(?:\s|$)/;

/**
 * Extract the reusable-extension-release pin from a release.yml text.
 * Returns { found:boolean, raw:string|null, sha:string|null, pinnedToSha:boolean }.
 *   found      — a `uses:` line referencing the reusable workflow was located.
 *   raw        — the full ref token (everything after `@`, incl. any comment) or the whole value.
 *   sha        — the 40-hex SHA if the ref is SHA-pinned, else null.
 *   pinnedToSha— whether the ref is an immutable 40-char SHA (vs a mutable tag/branch).
 */
function extractReusablePin(text) {
  if (typeof text !== "string") return { found: false, raw: null, sha: null, pinnedToSha: false };
  for (const line of text.split(/\r?\n/)) {
    const m = USES_LINE_RE.exec(line);
    if (!m) continue;
    let value = m[2];
    if (!value.includes(REUSABLE_WORKFLOW_PATH)) continue;
    // Strip a trailing YAML comment from the value (after the ref token).
    // The ref token is up to the first whitespace following `@...`.
    const at = value.indexOf(`${REUSABLE_WORKFLOW_PATH}@`);
    if (at === -1) {
      // Referenced but with no `@ref` (e.g. a mutable default) — treat as found, unpinned.
      return { found: true, raw: value, sha: null, pinnedToSha: false };
    }
    const afterAt = value.slice(at + REUSABLE_WORKFLOW_PATH.length + 1);
    const refToken = afterAt.split(/[\s#]/, 1)[0];
    const shaMatch = /^[0-9a-f]{40}$/.test(refToken) ? refToken : null;
    return { found: true, raw: refToken, sha: shaMatch, pinnedToSha: Boolean(shaMatch) };
  }
  return { found: false, raw: null, sha: null, pinnedToSha: false };
}

/* --------------------------------- audit --------------------------------- */

/**
 * Pure audit core. Inputs:
 *   gatedRefs: string[]  — 40-hex SHAs whose reusable-release job carries the wall.
 *   repos:     { [repo:string]: string | null }  — release.yml text, or null if absent.
 * A repo maps to `null` when it has NO release.yml (not an extension release repo)
 * — those are SKIPPED (not drift). A repo present here with release.yml text is
 * audited. A repo whose release.yml does NOT call the reusable workflow is also
 * skipped (its release path is elsewhere, e.g. direct npm publish).
 * Returns { ok, findings: [{repo, reason, ref}], audited: [{repo, ref, gated}] }.
 */
function auditPins({ gatedRefs, repos }) {
  const gated = new Set((gatedRefs || []).map((s) => String(s).toLowerCase()));
  const findings = [];
  const audited = [];
  for (const repo of Object.keys(repos).sort()) {
    const text = repos[repo];
    if (text == null) continue; // no release.yml — not a release repo
    const pin = extractReusablePin(text);
    if (!pin.found) continue; // release.yml exists but does not call the reusable workflow
    if (!pin.pinnedToSha) {
      findings.push({ repo, reason: "not-sha-pinned", ref: pin.raw });
      audited.push({ repo, ref: pin.raw, gated: false });
      continue;
    }
    const isGated = gated.has(pin.sha.toLowerCase());
    audited.push({ repo, ref: pin.sha, gated: isGated });
    if (!isGated) {
      findings.push({ repo, reason: "ungated-ref", ref: pin.sha });
    }
  }
  return { ok: findings.length === 0, findings, audited };
}

function reportFindings(findings) {
  const REASONS = {
    "ungated-ref":
      "pins reusable-extension-release at a ref NOT in the gated allowlist (release job would run with NO release-approval Environment pause — fails open)",
    "not-sha-pinned":
      "does not SHA-pin reusable-extension-release (a mutable tag/branch can silently drop the release-approval wall)",
  };
  return findings
    .map((f) => `  - ${f.repo}: ${REASONS[f.reason] || f.reason}\n      ref: ${JSON.stringify(f.ref)}`)
    .join("\n");
}

/* ------------------------------ live fetch ------------------------------ */

function ghApi(endpoint, token, { paginate = false } = {}) {
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  const argv = ["api"];
  if (paginate) argv.push("--paginate");
  argv.push(endpoint, "-H", "Accept: application/vnd.github+json");
  const res = spawnSync("gh", argv, { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    return { ok: false, error: `gh api ${endpoint} failed (exit ${res.status}): ${(res.stderr || "").trim()}` };
  }
  // --paginate concatenates JSON arrays as separate arrays; ask jq to merge upstream
  // instead. Here (no --paginate on arrays) parse straight; for repo lists we page below.
  try {
    return { ok: true, data: JSON.parse(res.stdout) };
  } catch (e) {
    return { ok: false, error: `gh api ${endpoint} returned unparseable JSON: ${e.message}` };
  }
}

// List all non-archived repos in the org (paginated).
function listOrgRepos(org, token) {
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  const res = spawnSync(
    "gh",
    ["api", "--paginate", `orgs/${org}/repos?per_page=100`, "--jq", ".[] | select(.archived==false) | .name"],
    { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    return { ok: false, error: `gh api orgs/${org}/repos failed (exit ${res.status}): ${(res.stderr || "").trim()}` };
  }
  const names = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { ok: true, names };
}

// Fetch a single repo's .github/workflows/release.yml text. A 404 => null (no
// release.yml). Any OTHER error => a hard error (must not mask drift).
function fetchReleaseYml(repo, token) {
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  const res = spawnSync(
    "gh",
    ["api", `repos/${repo}/contents/.github/workflows/release.yml`, "--jq", ".content"],
    { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    const err = (res.stderr || "").trim();
    if (/HTTP 404|Not Found/i.test(err)) return { ok: true, text: null }; // no release.yml
    return { ok: false, error: `read ${repo} release.yml failed (exit ${res.status}): ${err}` };
  }
  const b64 = res.stdout.trim();
  if (!b64) return { ok: true, text: null };
  try {
    return { ok: true, text: Buffer.from(b64, "base64").toString("utf8") };
  } catch (e) {
    return { ok: false, error: `decode ${repo} release.yml failed: ${e.message}` };
  }
}

/**
 * Fetch { repo -> release.yml text | null } for every non-archived org repo.
 * Returns { ok, repos, errors }.
 */
function fetchExtensionRepos({ org, token, only }) {
  const errors = [];
  const repos = {};
  let names;
  if (only && only.length) {
    names = only;
  } else {
    const listed = listOrgRepos(org, token);
    if (!listed.ok) return { ok: false, repos, errors: [listed.error] };
    names = listed.names;
  }
  for (const name of names) {
    const full = name.includes("/") ? name : `${org}/${name}`;
    const r = fetchReleaseYml(full, token);
    if (!r.ok) {
      errors.push(r.error);
      continue;
    }
    repos[full] = r.text;
  }
  return { ok: errors.length === 0, repos, errors };
}

/* --------------------------------- CLI --------------------------------- */

const VALUE_FLAGS = new Set(["root", "org", "gated-refs", "token-env", "repos-json", "only"]);
const BOOLEAN_FLAGS = new Set(["live", "quiet"]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) return fail(`unexpected argument: ${tok}`);
    const eq = tok.indexOf("=");
    const key = eq !== -1 ? tok.slice(2, eq) : tok.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq !== -1) return fail(`--${key} takes no value`);
      args[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      const value = eq !== -1 ? tok.slice(eq + 1) : argv[++i];
      if (value === undefined || value.trim() === "" || (eq === -1 && value.startsWith("--"))) {
        return fail(`--${key} requires a value`);
      }
      args[key] = value;
    } else {
      return fail(`unknown flag --${key}`);
    }
  }
  return args;
}

function fail(msg) {
  console.error(`[release-workflow-pin-drift-gate] ${msg}`);
  process.exit(2);
}

function readJson(file, optional = false) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    if (obj && typeof obj === "object") delete obj._comment;
    return obj;
  } catch (e) {
    if (optional && e.code === "ENOENT") return null;
    fail(`cannot read/parse ${file}: ${e.message}`);
  }
}

// Load the gated-ref allowlist: accepts { gatedRefs: [...] } or a bare [...] array.
function loadGatedRefs(file) {
  const obj = readJson(file);
  const arr = Array.isArray(obj) ? obj : obj && Array.isArray(obj.gatedRefs) ? obj.gatedRefs : null;
  if (!arr || arr.length === 0) {
    fail(`gated-ref allowlist ${file} must list at least one gated SHA (gatedRefs: [...])`);
  }
  for (const s of arr) {
    if (!/^[0-9a-f]{40}$/.test(String(s))) fail(`gated ref ${JSON.stringify(s)} is not a 40-hex SHA`);
  }
  return arr;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = "root" in args ? path.resolve(args.root) : process.cwd();
  const quiet = Boolean(args.quiet);

  const gatedFile = path.resolve(
    root,
    args["gated-refs"] || path.join("config", "release-workflow-gated-refs.json")
  );
  const gatedRefs = loadGatedRefs(gatedFile);

  let repos;
  if (args["repos-json"]) {
    // Test / dry-run hook: read the { repo -> release.yml text|null } map from a file.
    repos = readJson(path.resolve(root, args["repos-json"]));
  } else if (args.live) {
    const org = args.org || "cinatra-ai";
    const tokenEnv = args["token-env"] || "RELEASE_PIN_DRIFT_READ_TOKEN";
    const token =
      process.env[tokenEnv] || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
    if (!token) {
      const msg =
        `release-workflow-pin-drift-gate: not configured — no token in ${tokenEnv}/GH_TOKEN/GITHUB_TOKEN; ` +
        `skipping the org-wide release-pin scan (provision a token with repo contents:read + read:org to arm it).`;
      if (process.env.GITHUB_ACTIONS) process.stdout.write(`::notice::${msg}\n`);
      if (!quiet) process.stderr.write(msg + "\n");
      process.exit(0);
    }
    const only = args.only ? args.only.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const fetched = fetchExtensionRepos({ org, token, only });
    if (!fetched.ok) {
      process.stderr.write("release-workflow-pin-drift-gate: FAIL — live read incomplete:\n");
      for (const e of fetched.errors) process.stderr.write(`  - ${e}\n`);
      process.exit(1);
    }
    repos = fetched.repos;
  } else {
    fail("provide --live (org-wide scan via gh) or --repos-json <file> (test/dry-run)");
  }

  const { ok, findings, audited } = auditPins({ gatedRefs, repos });

  if (!quiet) {
    const gatedCount = audited.filter((a) => a.gated).length;
    process.stderr.write(
      `release-workflow-pin-drift-gate: audited ${audited.length} release repo(s); ` +
        `${gatedCount} gated, ${audited.length - gatedCount} NOT gated.\n`
    );
  }

  if (ok) {
    if (!quiet) {
      process.stderr.write(
        "release-workflow-pin-drift-gate: clean — every extension release.yml pins a gated reusable-release ref.\n"
      );
    }
    process.exit(0);
  }
  process.stderr.write(
    "release-workflow-pin-drift-gate: FAIL — repo(s) can release WITHOUT the release-approval Environment pause:\n" +
      reportFindings(findings) +
      `\n  FIX: bump each repo's .github/workflows/release.yml to pin ${REUSABLE_WORKFLOW_PATH}\n` +
      `  at a gated ref from config/release-workflow-gated-refs.json (e.g. the v0.1.1 SHA).\n` +
      "  A new gated reusable-workflow release => add its SHA to that allowlist.\n"
  );
  process.exit(1);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isMainModule()) {
  try {
    main();
  } catch (e) {
    console.error("[release-workflow-pin-drift-gate] gate failed:", e.message);
    process.exit(2);
  }
}

export { extractReusablePin, auditPins, reportFindings, fetchExtensionRepos, REUSABLE_WORKFLOW_PATH, GATE_VERSION };
