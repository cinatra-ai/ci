#!/usr/bin/env node
/**
 * meta-commentary-surface-coverage — the NEW-SURFACE detector for the
 * meta-commentary gate rollout (cinatra-ai/docs#160 AC11).
 *
 * WHY THIS EXISTS. `config/meta-commentary-inventory.json` is a point-in-time
 * census: it records, per public org repo, which paths are published surfaces
 * and which are exempt. Nothing re-derives it. A repo created after the census,
 * or a `docs/` tree added to a repo that previously published only a README,
 * arrives with NO caller and NO inventory entry — and every existing check stays
 * green, because each of them only ever looks at the paths it was already told
 * about. The absence is invisible by construction.
 *
 * This check closes that: it enumerates the org's PUBLIC, NON-ARCHIVED repos and
 * the published-surface paths each one actually has today, then reconciles that
 * census against (a) the inventory and (b) caller presence. Anything the
 * inventory does not account for is a finding.
 *
 * FINDINGS (all of them fail the check — see FAIL-CLOSED below):
 *   unknown-repo         a public, non-archived repo with no inventory entry.
 *                        Its surfaces are unclassified, so nothing scans them.
 *   undeclared-surface   a path matching the inventory's own `surfacePatterns`
 *                        that the repo's entry does not record — neither as
 *                        published nor with a written exemption rationale.
 *   missing-caller       a repo whose inventory entry carries a `published` or
 *                        `staged-listing` surface but has no gate caller
 *                        workflow, and no recorded `coverage` explaining why.
 *   stale-inventory-repo an inventory entry for a repo that is no longer a
 *                        public, non-archived org repo. The record is wrong; a
 *                        wrong record is what produced the gap in the first
 *                        place, so it is surfaced rather than tolerated.
 *
 * FAIL-CLOSED, deliberately. Every degraded condition is a failure, never a
 * silent pass: no token, an API error, an empty census, an unparseable
 * inventory, a repo whose tree cannot be read. A coverage check that green-skips
 * when it cannot see is worse than no coverage check, because it reads as proof.
 * (The org-wide release-pin gate green-skips without its operator token; that is
 * a different trade — it needs a privileged cross-org token that did not exist
 * yet. This one needs only PUBLIC repo reads, which the default CI token can
 * always do, so there is no dormant-shipping case to accommodate.)
 *
 * COVERAGE ESCAPES ARE RECORDED, NEVER INFERRED. A published surface may be
 * covered by something other than a pinned caller — cinatra-ai/docs runs its own
 * repo-local blocking check. That is expressed by a machine-readable
 * `"coverage": "repo-local"` on the inventory surface, not by a prose note and
 * never by the script guessing. An absent `coverage` means a caller is required.
 *
 * THE CORE IS PURE AND OFFLINE. `reconcile(inventory, census)` takes plain data
 * and returns findings; `--census-json <file>` feeds it a recorded census, which
 * is how the fixtures pin both the missing-repo and the missing-caller-on-a-
 * newly-declared-surface cases. `--live` is a thin `gh api` wrapper that BUILDS
 * such a census. The two are separable on purpose: the reconciliation logic is
 * testable without a network, and the fetch has no verdict logic in it.
 *
 * Usage:
 *   node scripts/meta-commentary-surface-coverage.mjs --live [--org cinatra-ai]
 *   node scripts/meta-commentary-surface-coverage.mjs --census-json <file>
 *   [--inventory <path>] [--json]
 *
 * Exit codes: 0 = every surface accounted for, 1 = finding(s), 2 = usage/config
 * error or a degraded read.
 *
 * Zero runtime dependencies (node builtins + the `gh` CLI for `--live`).
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DEFAULT_INVENTORY = "config/meta-commentary-inventory.json";
const DEFAULT_ORG = "cinatra-ai";

// Workflow filenames that constitute a gate caller. The org convention is
// `docs-meta-commentary.yml` (every one of the rolled-out callers uses it);
// `meta-commentary-gate.yml` is the name a repo running the gate on ITSELF uses.
// A repo that wires the gate under some other filename reads as missing-caller —
// fail-closed: the fix is to record `coverage` in the inventory, which is a
// reviewed statement, not a filename this script silently learns to accept.
const CALLER_WORKFLOWS = new Set([
  ".github/workflows/docs-meta-commentary.yml",
  ".github/workflows/meta-commentary-gate.yml",
]);

const PUBLISHED_CLASSES = new Set(["published", "staged-listing"]);

/* ------------------------------ glob matching ------------------------------ */

// The inventory's `surfacePatterns` are simple globs — `README.md`,
// `docs/**/*.md`, `.wordpress-org/**/*.md`. Supported: `**` (any number of path
// segments, including none) and `*` (any run of characters within one segment).
// Nothing else; a pattern is data in a reviewed file, not a user-supplied query.
function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` swallows zero or more leading segments; a bare `**` is any run.
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

function matchesAny(path, patterns) {
  return patterns.some((p) => globToRegExp(p).test(path));
}

/* -------------------------------- reconcile -------------------------------- */

/**
 * Reconcile a census of what the org actually has against the inventory.
 *
 * @param {object} inventory parsed config/meta-commentary-inventory.json
 * @param {object} census    { org, repos: [{ repo, archived, private, surfaces[], workflows[] }] }
 * @returns {{findings: Array<{kind,repo,path?,detail}>, checked: number}}
 */
export function reconcile(inventory, census) {
  const findings = [];

  const surfacePatterns = inventory.surfacePatterns;
  if (!Array.isArray(surfacePatterns) || surfacePatterns.length === 0) {
    throw new Error("inventory has no surfacePatterns[]");
  }
  if (!Array.isArray(inventory.repos)) throw new Error("inventory has no repos[]");
  if (!Array.isArray(census.repos)) throw new Error("census has no repos[]");
  if (census.repos.length === 0) {
    // An empty census is indistinguishable from "the org has nothing to check",
    // and would make every reconciliation vacuously green. Refuse it.
    throw new Error("census is empty — refusing to report coverage from a census of zero repos");
  }

  const excludedArchived = new Set(inventory.excludedArchivedRepos || []);
  const byRepo = new Map(inventory.repos.map((r) => [r.repo, r]));

  // Only PUBLIC, NON-ARCHIVED repos are in scope: a private repo publishes
  // nothing, and an archived repo is read-only (no caller can be added to it).
  const live = census.repos.filter((r) => !r.archived && !r.private);
  const liveNames = new Set(live.map((r) => r.repo));

  for (const repo of live) {
    const entry = byRepo.get(repo.repo);
    if (!entry) {
      findings.push({
        kind: "unknown-repo",
        repo: repo.repo,
        detail:
          "public, non-archived org repo with no inventory entry — its published surfaces are unclassified and unscanned",
      });
      continue;
    }

    const recorded = new Set((entry.surfaces || []).map((s) => s.path));
    // A recorded entry may itself be a glob (`docs/**/*.md`); a concrete census
    // path is covered when it matches one.
    const recordedPatterns = [...recorded];
    for (const path of repo.surfaces || []) {
      if (!matchesAny(path, surfacePatterns)) continue;
      if (recorded.has(path) || matchesAny(path, recordedPatterns)) continue;
      findings.push({
        kind: "undeclared-surface",
        repo: repo.repo,
        path,
        detail: "matches a published-surface pattern but is not recorded in the inventory (neither published nor exempt)",
      });
    }

    const publishedSurfaces = (entry.surfaces || []).filter((s) => PUBLISHED_CLASSES.has(s.class));
    if (publishedSurfaces.length === 0) continue;

    // A recorded, machine-readable coverage escape on EVERY published surface —
    // never a prose note, never inferred.
    const allCovered = publishedSurfaces.every((s) => typeof s.coverage === "string" && s.coverage.length > 0);
    const hasCaller = (repo.workflows || []).some((w) => CALLER_WORKFLOWS.has(w));
    if (!hasCaller && !allCovered) {
      findings.push({
        kind: "missing-caller",
        repo: repo.repo,
        detail:
          `${publishedSurfaces.length} published/staged-listing surface(s) recorded, but no gate caller workflow ` +
          `(${[...CALLER_WORKFLOWS].join(" | ")}) and no recorded "coverage" on every published surface`,
      });
    }
  }

  for (const entry of inventory.repos) {
    if (liveNames.has(entry.repo)) continue;
    if (excludedArchived.has(entry.repo)) continue;
    findings.push({
      kind: "stale-inventory-repo",
      repo: entry.repo,
      detail: "recorded in the inventory but not a public, non-archived org repo in the census",
    });
  }

  findings.sort((a, b) => a.repo.localeCompare(b.repo) || a.kind.localeCompare(b.kind) || (a.path || "").localeCompare(b.path || ""));
  return { findings, checked: live.length };
}

/* --------------------------------- fetch ---------------------------------- */

function gh(args) {
  const res = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`gh ${args.join(" ")} failed to start: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} exited ${res.status}: ${(res.stderr || "").trim()}`);
  }
  return res.stdout;
}

/**
 * Build a census from the live GitHub API. No verdict logic here on purpose —
 * this only reports what exists.
 */
export function fetchCensus(org, surfacePatterns) {
  const reposRaw = gh([
    "api",
    "--paginate",
    `orgs/${org}/repos?type=public&per_page=100`,
    "--jq",
    ".[] | {repo: .full_name, archived: .archived, private: .private, defaultBranch: .default_branch}",
  ]);
  const repos = reposRaw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (repos.length === 0) throw new Error(`no public repos returned for org ${org}`);

  const out = [];
  for (const r of repos) {
    if (r.archived || r.private) {
      out.push({ ...r, surfaces: [], workflows: [] });
      continue;
    }
    let treeRaw;
    try {
      treeRaw = gh([
        "api",
        `repos/${r.repo}/git/trees/${r.defaultBranch}?recursive=1`,
        "--jq",
        ".tree[] | select(.type==\"blob\") | .path",
      ]);
    } catch (e) {
      // A degraded read is a failure, not an empty repo (see FAIL-CLOSED).
      throw new Error(`cannot read the tree of ${r.repo}@${r.defaultBranch}: ${e.message}`);
    }
    const paths = treeRaw.split("\n").filter(Boolean);
    out.push({
      ...r,
      surfaces: paths.filter((p) => matchesAny(p, surfacePatterns)),
      workflows: paths.filter((p) => CALLER_WORKFLOWS.has(p)),
    });
  }
  return { org, fetchedAt: new Date().toISOString().slice(0, 10), repos: out };
}

/* ---------------------------------- main ---------------------------------- */

function parseArgs(argv) {
  const out = { inventory: DEFAULT_INVENTORY, org: DEFAULT_ORG, census: null, live: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--inventory") out.inventory = argv[++i];
    else if (argv[i] === "--census-json") out.census = argv[++i];
    else if (argv[i] === "--org") out.org = argv[++i];
    else if (argv[i] === "--live") out.live = true;
    else if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: meta-commentary-surface-coverage (--live [--org <org>] | --census-json <file>) [--inventory <path>] [--json]"
    );
    process.exit(0);
  }
  if (args.live === Boolean(args.census)) {
    console.error("[surface-coverage] ERROR: pass exactly one of --live or --census-json <file>.");
    process.exit(2);
  }

  let inventory;
  try {
    inventory = JSON.parse(readFileSync(args.inventory, "utf8"));
  } catch (e) {
    console.error(`[surface-coverage] ERROR: cannot read inventory ${args.inventory}: ${e.message}`);
    process.exit(2);
  }

  let census;
  try {
    census = args.live
      ? fetchCensus(args.org, inventory.surfacePatterns)
      : JSON.parse(readFileSync(args.census, "utf8"));
  } catch (e) {
    console.error(`[surface-coverage] ERROR: ${e.message}`);
    process.exit(2);
  }

  let result;
  try {
    result = reconcile(inventory, census);
  } catch (e) {
    console.error(`[surface-coverage] ERROR: ${e.message}`);
    process.exit(2);
  }

  if (args.json) {
    console.log(JSON.stringify({ checked: result.checked, findings: result.findings }, null, 2));
  }

  if (result.findings.length === 0) {
    console.log(
      `[surface-coverage] OK — ${result.checked} public, non-archived repo(s) reconciled against ` +
        `${args.inventory} (recordedAt ${inventory.recordedAt}); every published surface is accounted for.`
    );
    return;
  }

  console.error(`[surface-coverage] FAIL — ${result.findings.length} finding(s) across ${result.checked} repo(s):\n`);
  for (const f of result.findings) {
    console.error(`  [${f.kind}] ${f.repo}${f.path ? `:${f.path}` : ""} — ${f.detail}`);
  }
  console.error(
    `\nEvery published, user-facing surface must be recorded in ${args.inventory} and scanned by a gate caller. ` +
      `Fix by adding the repo/surface to the inventory (with a class, and a rationale for any exemption), ` +
      `adding the pinned caller from templates/meta-commentary-gate.yml, or — where a repo-local blocking check ` +
      `already covers the surface — recording that as "coverage" on the surface. Refresh "recordedAt" when you do. ` +
      `See cinatra-ai/docs#160.`
  );
  process.exitCode = 1;
}

// Importable for tests; only the CLI entry point runs main().
if (process.argv[1] && process.argv[1].endsWith("meta-commentary-surface-coverage.mjs")) main();
