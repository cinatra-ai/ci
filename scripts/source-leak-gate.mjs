#!/usr/bin/env node
/**
 * source-leak-gate — reusable CI gate that detects internal process markers
 * that should not ship in source (numbered milestones, internal IDs,
 * review labels, history breadcrumbs, internal artifact names, etc.).
 *
 * Design:
 *   - Generic, repo-agnostic default rules ship here. Project-specific token
 *     lists (single-prefix IDs, host/handle/channel lists, repo-private names)
 *     are supplied by each consuming repo via `--config <json>`.
 *   - Ratchet modes: line (default, no-new-rot), file (allowlist), baseline
 *     (per rule+file count), off.
 *   - Self-exemption: the definition region (which necessarily contains the
 *     very markers it detects) is bracketed by sentinel comments and skipped on
 *     the gate's own file; dedicated fixtures + baselines are path-exempt.
 *
 * Repository-visibility detection runs in ONE of two modes:
 *   - OFFLINE (the default, and what `--offline` forces): the hard-coded
 *     PRIVATE_REPO_NAMES list is the whole authority. Chosen automatically when
 *     no token is present, because unauthenticated API calls are rate-limited
 *     hard enough that a fail-closed probe would red every caller. This is also
 *     the only mode that can judge the BARE-name forms, which carry no org path
 *     for an API to resolve.
 *   - PROBE (a token in GITHUB_TOKEN / GH_TOKEN, or `--probe` to force it
 *     unauthenticated): the list still runs, and every OTHER `<org>/<name>`
 *     token on a gated line is additionally resolved against the GitHub API —
 *     so a repository created after the last list edit is caught. Public => no
 *     finding. Private, 404 (what a private-or-absent repo returns to a token
 *     without access), or ANY unresolved answer => a finding. The probe never
 *     guesses "public": a network error, a rate limit and a malformed response
 *     are all fail-closed, reported with their cause. The lane runs inside a
 *     per-run BUDGET (a cap on distinct names, a wall-clock deadline, bounded
 *     concurrency); a candidate the budget leaves unasked is reported too, so
 *     "we ran out of budget" can never read as "we checked it and it was fine".
 *     `config/public-repos.json` is a latency cache of names confirmed public,
 *     each stamped with the day it was confirmed and ignored once past its TTL.
 *     `--verify-cache` re-confirms every entry and rewrites those stamps.
 *
 * Zero runtime dependencies (node builtins only).
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBaseRef, buildRenameMap, getAddedLineNumbers, getIntroducedPaths } from "./lib/touch-ratchet.mjs";

const SCANNER_VERSION = "0.1.0";
const DEFAULT_DIFF_BASE_ENV = "SOURCE_LEAK_DIFF_BASE";

// Exemptions are keyed to the ACTUAL running gate file (and its sibling fixture)
// by real path — never by a relative path a scanned (caller) repo could also
// have. So the sentinel/fixture carve-outs apply only to this gate's own files.
const SCANNER_REAL = (() => {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return ""; }
})();
const FIXTURE_REAL = (() => {
  try { return fs.realpathSync(path.join(path.dirname(SCANNER_REAL), "__fixtures__", "source-leak.fixture.txt")); }
  catch { return ""; }
})();
function realPathOf(p) {
  try { return fs.realpathSync(path.resolve(p)); } catch { return ""; }
}
const VALID_PROFILES = ["default", "ts-monorepo", "php-wp-plugin", "drupal-module", "ops-docs", "public-strict"];
const VALID_RATCHET_MODES = ["line", "file", "baseline", "off"];

const DEFAULT_SKIP_DIRS = new Set([
  ".git", ".next", ".turbo", "node_modules", "dist", "build", "coverage",
  "public", ".cache", ".vercel", ".pnpm-store", "vendor",
  // The reusable workflow checks this gate out under this dir inside the caller
  // repo; never scan our own checked-out copy.
  ".source-leak-gate",
]);
const DEFAULT_SKIP_DIR_PREFIXES = [];
const DEFAULT_SKIP_FILE_PATTERNS = [
  /^pnpm-lock\.yaml$/, /^package-lock\.json$/, /^yarn\.lock$/,
  /\.tsbuildinfo$/, /\.min\.(js|css)$/, /\.d\.m?ts$/,
];
const DEFAULT_SCAN_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".rb", ".php", ".module", ".install", ".inc", ".sh", ".bash", ".zsh",
  ".json", ".jsonc", ".yml", ".yaml", ".toml", ".ini",
  ".md", ".mdx", ".css", ".scss", ".sass", ".less", ".sql", ".txt", ".html",
]);

// ===================== SOURCE_LEAK_RULES_BEGIN =====================
// Everything in this region may contain the markers it describes. It is
// self-exempt on the gate's own file (see readRuleDefRange) so the gate stays
// clean when scanning itself. Keep marker-bearing constants inside this block.

// Internal-only working areas: never scanned.
const PRIVATE_PREFIXES = [".planning/", ".claude/", ".agents/", ".gsd/"];
const PRIVATE_EXACT = new Set([".github/CODEOWNERS"]);

// Doc files are scanned but findings dropped (they legitimately reference history).
const EXEMPT_FILE_BASENAMES = new Set(["CLAUDE.md", "AGENTS.md", "MEMORY.md", "README.md", "CHANGELOG.md"]);
const EXEMPT_DIR_PREFIXES = ["docs/"];

// DECLASSIFICATION STATEMENT — read this before adding or removing a name.
//
// This file is PUBLIC and has always carried private repository NAMES: a
// detector cannot match what it may not spell. That is a deliberate position,
// not an oversight. A repository NAME is not a secret — it leaks nothing about
// what the repository holds — while its CONTENTS, its issue text and its issue
// NUMBERS are, and none of those appear here or may be added. The list below is
// therefore published on purpose so every consuming repository can run the same
// check offline. Keep it to bare names; if a name ever does encode something
// confidential, that is a reason to rename the repository, not to weaken the
// gate by dropping it from this list.
//
// The OFFLINE authority for repository visibility. It is ONE list: the probe
// lane subtracts it mechanically (PROBE_EXEMPT_NAMES) rather than trusting a
// second hand-maintained copy to stay in step.
const PRIVATE_REPO_NAMES = [
  "design", "marketplace", "website", "cinatra-business", "create-cinatra-extension",
  "dev-skills-store", "extension-release-tooling", "legal-archive-skills", "renovate-config",
  "dev-internal-archive", "cinatra-poc", "cinatra-oss-transit", "cinatra-claude-memory",
  "engineering-claude-plugin", "engineering-proofs-private", "marketing-explainer-video",
  "major-release-workflow", "blog-content-workflow", "ops", "wp-theme",
];
const PRIVATE_REPO_NAME_SET = new Set(PRIVATE_REPO_NAMES);

// FUNCTIONAL references: the exact machine forms the organization's own
// automation REQUIRES, for private repositories that are also dispatch targets.
// These are the ONLY forms excused, and they are excused per MATCH, not per name
// and not per line — so ordinary prose, an `#<n>` issue citation and a
// `/issues/` or `/blob/` URL naming the same repository all still flag, even on
// a line that also carries a legitimate functional reference. A name-wide
// exemption would have hidden exactly those.
//
// Each pattern is transcribed from the real automation:
//   - `uses:` — a reusable-workflow path; the job cannot run without it.
//   - `repository:` / `repositories:` — a checkout target, and the key that
//     scopes a short-lived installation token to one repository.
//   - the `.git` clone URL — the remote a pinned tree is fetched from.
// Everything else about those repositories (prose, operator error text, input
// descriptions) is REPHRASEABLE and must be rephrased, not exempted.
const FUNCTIONAL_REPO_REFS = [
  { name: "ops", label: "reusable-workflow path (`uses:`)", re: /\buses:\s*["']?cinatra-ai\/ops\//g },
  { name: "ops", label: "checkout / token-scope key", re: /\brepositor(?:y|ies):\s*\[?\s*["']?cinatra-ai\/ops(?![A-Za-z0-9_-])/g },
  { name: "wp-theme", label: "git clone URL", re: /cinatra-ai\/wp-theme\.git(?![A-Za-z0-9_-])/g },
  { name: "wp-theme", label: "checkout / token-scope key", re: /\brepositor(?:y|ies):\s*\[?\s*["']?cinatra-ai\/wp-theme(?![A-Za-z0-9_-])/g },
];

// ONE tokenizer for BOTH lanes. The static rule and the probe must agree on
// where a repository name starts and ends, or the same text is a finding in one
// lane and a different finding in the other. Sharing the source string makes
// that agreement structural instead of a thing two regexes have to remember.
//
// The `@` in the lookbehind is LOAD-BEARING: the vendored npm workspace packages
// are named `@cinatra-ai/<x>` — package scopes, not repository references.
// A leading `.` is allowed because GitHub allows it (`<org>/.github-private`).
// The name may CONTAIN dots but may not END in one, so a sentence-final period
// ("… see <org>/<repo>.") stays punctuation instead of being read into the name
// and 404-ing as a repository that does not exist. The trailing
// `(?![A-Za-z0-9_-])` still admits the `#<n>` and `/issues/<n>` tails.
const ORG_PATH_TOKEN_SOURCE =
  "(?<![@A-Za-z0-9_-])cinatra-ai\\/(\\.?[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)(?![A-Za-z0-9_-])";

// Names the visibility PROBE must never resolve: every PRIVATE_REPO_NAMES member
// (SLG_PRIVATE_REPO_REF already owns it offline, so probing would double-flag the
// same token) plus `engineering`, owned by SLG_PRIVATE_ENG_REF for the same
// reason. The functional dispatch targets are NOT here — they are on the private
// list now, and their carve-out is the per-match one above.
const PROBE_EXEMPT_NAMES = new Set([...PRIVATE_REPO_NAMES, "engineering"]);

const RULES = [
  {
    id: "SLG_MILESTONE_NUMBER",
    description: "Numbered planning milestone reference",
    re: /\bphase[\s:=\-_]+(?:[A-Z]?\d{2,4}(?:\.\d+)*[a-z]?)\b/gi,
    pathScan: true, // e.g. a dir `phase-553/`
    contextExclude(line) {
      if (line.includes("NEXT_PHASE=phase-production-build")) return true;
      if (/\bphased rollout\b/i.test(line)) return true;
      if (/\bbuild phase\b/i.test(line) && /\bproduction\b/i.test(line)) return true;
      return false;
    },
  },
  {
    id: "SLG_MILESTONE_SHORTHAND",
    description: "Milestone shorthand token",
    re: /\bP\d{3}(?:[-_.][A-Za-zβ\d]+)?\b/g,
    contextExclude(line) {
      if (/\bp-\d/i.test(line)) return true; // padding utilities
      if (/\bP-?(?:256|384|521)\b/.test(line)) return true; // ECC curves
      return false;
    },
  },
  {
    id: "SLG_VERSIONED_MILESTONE",
    description: "Versioned milestone reference",
    re: /\bv\d+\.\d+(?:\.\d+)?[\s:_/-]+(?:Phase|P)[\s:_#-]*\d{2,4}\b/gi,
    pathScan: true, // per-segment scan avoids matching across a real `/` (e.g. api/v1.2/P12)
  },
  {
    id: "SLG_MILESTONE_REF",
    description: "Milestone version reference",
    re: /\bmilestone\s+v\d+\.\d+(?:\.\d+)?\b|\bv\d+\.\d+(?:\.\d+)?\s+milestone\b/gi,
  },
  {
    id: "SLG_METHODOLOGY",
    description: "Internal methodology acronym",
    re: /\b(gsd|GSD)\b/g,
    contextExclude(line) {
      return /\b(getsubject|get-subject|gsdoc)\b/i.test(line);
    },
  },
  {
    id: "SLG_PLANNING_DOC",
    description: "Internal planning artifact filename",
    re: /\b(?:drift[-_ ]?gate|ROADMAP\.md|MILESTONE\.md|STATE\.md|PLAN\.md|REQUIREMENTS\.md|LEARNINGS\.md|MILESTONE-AUDIT\.md)\b/g,
  },
  {
    id: "SLG_PLANNING_DOC_VERSIONED",
    description: "Milestone-prefixed planning doc name",
    re: /\bv\d+\.\d+(?:\.\d+){0,2}[\s.-]+(?:MILESTONE(?:-AUDIT)?|PLAN|ROADMAP|PHASE|REQUIREMENTS|RESEARCH|REVIEW|VALIDATION|VERIFICATION|SECURITY|LEARNINGS|NYQUIST|PATTERNS)(?:\.md)?\b/g,
    pathScan: true, // e.g. a file `v6.13-ROADMAP.md` (the bare unversioned SLG_PLANNING_DOC is NOT path-scanned: legit OSS PLAN.md/ROADMAP.md)
  },
  {
    id: "SLG_PLANNING_PATH",
    description: "Reference to an internal planning directory",
    re: /(?:^|[\s"'`(])\.planning\//g,
    contextExclude(line) {
      return /^\s*-\s*['"]?\.planning\/\*\*['"]?\s*$/.test(line); // CI paths filter entry
    },
  },
  {
    id: "SLG_REQ_ID_BROAD",
    description: "Multi-segment requirement/workstream ID",
    re: /\b[A-Z]{2,8}\d{0,3}(?:-[A-Z0-9]{2,16}){1,4}-\d{2,3}\b/g,
  },
  {
    id: "SLG_WORKSTREAM_NUMERIC",
    description: "Numeric workstream ID",
    re: /\bGSD-?\d{3,4}\b/g,
    pathScan: true, // e.g. a file/dir `GSD-001-notes/`
  },
  {
    id: "SLG_WORKSTREAM_SLUG",
    description: "Numeric workstream slug",
    re: /\b\d{6}-[a-z0-9]{3}\b/g,
  },
  {
    id: "SLG_REVIEW_LABEL",
    description: "Adversarial-review label",
    re: /\b(?:[Cc]odex\s+[Rr]\d+|owner\s+note|review\s+round\s*\d+)\b/g,
  },
  {
    id: "SLG_PULL_REQUEST_ROUND",
    description: "Pull-request + review-round reference",
    re: /\bPR\s+#?\d{3,5}\s+[Rr]\d+\b/g,
  },
  {
    id: "SLG_PROVENANCE",
    description: "Provenance annotation referencing internal milestones",
    re: /\b(?:added|introduced|landed|shipped|fixed|removed|deprecated|migrated)\s+in\s+(?:Phase\s+\d|milestone\s+v|v\d+\.\d+\s+(?:Phase|milestone))/gi,
  },
  {
    id: "SLG_HISTORICAL",
    description: "History breadcrumb prose",
    re: /\b(?:renamed\s+from|used\s+to\s+be\s+called|before\s+the\s+refactor|prior\s+to\s+the\s+refactor|pre[\s-]refactor|formerly\s+(?:known\s+as|called))\b/gi,
  },
  {
    id: "SLG_DECISION_RECORD",
    description: "Internal decision-record pointer",
    re: /\bADR[\s-]?\d+\b/g,
  },
  {
    id: "SLG_AGENT_MEMORY",
    description: "Agent-memory provenance pointer",
    re: /\[\[(?:feedback|project|reference|user|memory)[_-][a-z0-9][a-z0-9_-]*\]\]|\b(?:generalized memory entry|agent memory|memory entry|save to memory)\b|\bMEMORY\.md\b/gi,
  },
  {
    id: "SLG_MILESTONE_VERSION",
    description: "Bare milestone version marker in planning context",
    re: /\bv\d+\.\d+(?:\.\d+)?\b/g,
    contextExclude(line) {
      if (/^\s*"(version|node|engines|peerDependencies)"\s*:/.test(line)) return true;
      if (/^\s*"@?[a-z0-9_\-/]+"\s*:\s*"[\^~>=<*]?\d/.test(line)) return true;
      if (/^\s*##\s+v?\d+\.\d+/.test(line)) return true; // changelog headers
      if (/openapi|oas|jsonschema|\$schema|jsonrpc|swagger/i.test(line)) return true;
      if (/(integrity|resolution|tarball|registry\.npmjs\.org)/i.test(line)) return true;
      if (/\b(tailscale|postgres|redis|nginx|node|alpine|bullseye|bookworm|debian|ubuntu)\b.*v?\d+\.\d+/i.test(line)) return true;
      if (/\bv?\d+\.\d+.*(docker|image|container|node|alpine|debian|ubuntu)/i.test(line)) return true;
      if (/\b(A2UI|AG-UI|OpenAPI|OAS|JSON-RPC|jsonrpc)\b/i.test(line)) return true;
      if (/\bv\d+\.\d+(?:\.\d+)?\s+(spec|protocol|schema|format|wire)\b/i.test(line)) return true;
      if (/version\s*:\s*['"`]v?\d+\.\d+/i.test(line)) return true;
      if (/\b[A-Z][A-Z0-9_]*_(REF|VERSION|TAG)\s*[:=]\s*['"]?v?\d+\.\d+/.test(line)) return true;
      if (/\.(toBe|toEqual|toContain|toMatch)\(['"`]v?\d+\.\d+/i.test(line)) return true;
      if (/v\d+\.\d+\.\d+/.test(line) && /(github\.com|@v\d+|ref\s*:\s*['"]v\d+|git\+|\.git)/i.test(line)) return true;
      if (/@[0-9a-f]{7,40}\b[^\n]*#\s*v?\d+\.\d+/.test(line)) return true; // SHA-pinned action with version comment
      if (/--save-(dev|exact)/.test(line)) return true;
      if (/\b(release|tag|ship(?:ped)?|target|require|min(?:imum)?)\b/i.test(line)) {
        return !/(milestone|phase|roadmap)/i.test(line);
      }
      return false;
    },
  },
  {
    // Reference to the PRIVATE cinatra-ai/engineering tracker leaking into a
    // public repo. Covers the `eng#<n>` / `cinatra-engineering#<n>` shorthands
    // (the latter also catches the `cinatra-ai/cinatra-engineering#<n>` legacy
    // form), the full `cinatra-ai/engineering` repo path (incl. `#<n>` and
    // `/issues/<n>` URL forms), and the bare `engineering/issues/` URL tail.
    // It must NOT match public-repo refs (`cinatra#231`, `cinatra-cli#61`,
    // `cinatra-ai/cinatra#231`): those are deliberately public and stay. The
    // boundaries are repo-token-aware (a `-`/`_`/alnum on either side is NOT a
    // boundary) so look-alikes like `cinatra-ai/engineering-foo`,
    // `reverse-engineering/issues/`, and `myeng#5` do NOT trip — JS `\b` treats
    // `-` as a boundary and would false-positive on those. `#` and `/` after
    // `engineering` ARE allowed (they are the `#<n>` / `/issues/` URL forms).
    // Deliberately-public references go in a per-repo allowlist via
    // config.lineExcludes / config.exemptFileBasenames (the same mechanism the
    // other rules use); the org-wide attribution-protocol citation is rephrased
    // to a public-safe name rather than allowlisted.
    id: "SLG_PRIVATE_ENG_REF",
    description: "Reference to the private cinatra-ai/engineering tracker",
    re: /(?<![A-Za-z0-9_-])(?:eng#\d+|cinatra-engineering#\d+|cinatra-ai\/engineering(?![A-Za-z0-9_-])|engineering\/issues\/)/gi,
  },
  {
    // PUBLIC-STRICT-ONLY sibling of SLG_PRIVATE_ENG_REF (profiles: ["public-strict"]).
    // It closes the one gap the universal rule deliberately leaves open EVERYWHERE:
    // the bare-NAME full form `engineering#<n>` (no org / no `cinatra-` prefix) and
    // the bare legacy repo name `cinatra-engineering` (with no `#`). That bare
    // `engineering#<n>` form is the org-SANCTIONED cross-repo citation style for
    // PRIVATE repos' committed content (issue-placement policy), so it MUST keep
    // passing under every other profile — therefore this rule activates ONLY under
    // the `public-strict` profile that PUBLIC repos opt into, where a private
    // tracker must not be referenced at all. (Scoping is enforced by buildRules,
    // which — unlike the legacy behavior — does NOT force profile-scoped rules into
    // the `default` profile that several PRIVATE repos run.)
    //
    // Boundaries are LOAD-BEARING. The negative lookbehind `(?<![@A-Za-z0-9_/-])`
    // rejects a `-`/`_`/`/`/`@`/alnum immediately before the token, so the prefixed
    // forms the universal rule already owns (`cinatra-ai/engineering#<n>`,
    // `cinatra-engineering#<n>`) are NOT double-flagged, and look-alikes
    // (`reverse-engineering#5`, `re-engineering#5`, `bioengineering#5`,
    // `@cinatra-ai/engineering`) do NOT trip. The `engineering#<n>` branch requires
    // `#<digit>`, so the ordinary English word "engineering" never matches; the
    // `cinatra-engineering` branch's trailing `(?![A-Za-z0-9_#-])` keeps
    // `cinatra-engineering-foo` from tripping AND excludes a trailing `#`, so the
    // `cinatra-engineering#<n>` ISSUE-ref form is left SOLELY to the universal
    // SLG_PRIVATE_ENG_REF (this rule owns only the bare NAME) — no double-flag,
    // the same principle SLG_PRIVATE_REPO_REF follows by omitting `engineering`.
    // Deliberately-public references (if any ever arise) use the same
    // config.lineExcludes / config.exemptFileBasenames allowlist mechanism every
    // other rule honors.
    id: "SLG_PRIVATE_ENG_REF_STRICT",
    description: "Full-form private engineering-tracker reference (public-repo strict)",
    re: /(?<![@A-Za-z0-9_/-])(?:engineering#\d+|cinatra-engineering(?![A-Za-z0-9_#-]))/gi,
    profiles: ["public-strict"],
  },
  {
    // Sibling of SLG_PRIVATE_ENG_REF: catches the GitHub path-form of OTHER
    // private cinatra-ai repositories leaking into a public repo, incl. the
    // `#<n>` and `/issues/<n>` URL tails the shared tokenizer admits.
    //
    // Membership is decided in matchExclude against PRIVATE_REPO_NAME_SET, not
    // by an alternation baked into the regex. That is what lets this rule and
    // the probe share ONE tokenizer: a name the tokenizer reads as
    // `<listed-name>.something` is never silently truncated back to the listed
    // prefix here while the probe reads it whole — the two lanes cannot disagree
    // about where a name ends, so nothing is double-flagged and nothing is
    // flagged as the wrong repository. A trailing `.git` is normalized away, so
    // a clone URL resolves to the repository it clones.
    //
    // DELIBERATELY EXCLUDED:
    //   - `engineering` — already owned by SLG_PRIVATE_ENG_REF (avoid double-flag).
    //   - the PUBLIC proof-image host — public repos cite it constantly, so only
    //     its private twin (the same name plus a `-private` suffix) is listed.
    //     Membership is exact-match, so the public name can never resolve to the
    //     private entry.
    // A name that merely BEGINS with the tracker's name is not the tracker:
    // SLG_PRIVATE_ENG_REF closes that name with `(?![A-Za-z0-9_-])`, so it never
    // claims a hyphen-extended sibling. Those repositories belong here.
    //
    // The dispatch targets ARE listed, and their required machine forms are
    // excused per match by FUNCTIONAL_REPO_REFS — see there for why a name-wide
    // exemption was the wrong shape. Deliberately-public refs (if any ever arise)
    // use the same config.lineExcludes / config.exemptFileBasenames allowlist
    // mechanism the other rules honor.
    id: "SLG_PRIVATE_REPO_REF",
    description: "Reference to a private cinatra-ai repository (bare GitHub path-form)",
    re: new RegExp(ORG_PATH_TOKEN_SOURCE, "gi"),
    matchExclude(match, line, index) {
      const name = orgPathRepoName(match);
      if (!name || !PRIVATE_REPO_NAME_SET.has(name)) return true;
      return functionalRefCovers(name, line, index);
    },
  },
  {
    // The DYNAMIC lane. The list above can only know the repositories someone
    // remembered to add; this rule nominates EVERY other org path token and asks
    // GitHub whether that repository is actually public, so a repository created
    // after the last list edit is still caught.
    //
    // The regex only NOMINATES — it deliberately matches public repositories
    // too. Nothing here is a finding until resolveProbeFindings() has a verdict,
    // and a candidate that resolves PUBLIC is dropped. See that function for the
    // fail-closed contract and the per-run budget.
    //
    // It shares ORG_PATH_TOKEN_SOURCE with the static rule (see there), so the
    // two lanes tokenize identically; matchExclude subtracts the names the
    // offline rules already own, which is also what keeps the functional
    // dispatch targets out of this lane without a second carve-out.
    id: "SLG_PRIVATE_REPO_PROBE",
    description: "Reference to a repository this token cannot see as public",
    re: new RegExp(ORG_PATH_TOKEN_SOURCE, "gi"),
    matchExclude(match) {
      const name = orgPathRepoName(match);
      return !name || PROBE_EXEMPT_NAMES.has(name);
    },
    probe: true,
  },
  {
    // Bare-NAME form of the private proof-image repository, with no org prefix —
    // the sibling of SLG_PRIVATE_REPO_REF's path form, and the reason that form
    // alone is not enough. The org runs a TWIN pair: a PUBLIC image host that
    // public repos cite constantly, and a PRIVATE repository whose name is the
    // public one plus a `-private` suffix. Only the private name is a leak, and
    // unlike the bare `engineering#<n>` tracker citation that
    // SLG_PRIVATE_ENG_REF_STRICT has to confine to `public-strict`, this name has
    // NO sanctioned use that writes it into committed source anywhere. So the
    // rule is UNIVERSAL — every profile runs it — and needs no strict-only twin.
    //
    // Boundaries are LOAD-BEARING and follow SLG_PRIVATE_ENG_REF_STRICT exactly.
    // The negative lookbehind `(?<![@A-Za-z0-9_/-])` rejects an alnum / `_` / `-`
    // immediately before the token, so a longer identifier that merely ENDS in
    // the name does not trip; it also rejects `/` and `@`, which is what leaves
    // the org-path form SOLELY to SLG_PRIVATE_REPO_REF (no double-flag) and keeps
    // the vendored `@cinatra-ai/<x>` npm scope out, the same carve-out that rule
    // documents. The trailing `(?![A-Za-z0-9_-])` keeps a longer name that merely
    // STARTS with it from tripping, while still admitting the `#<n>` and
    // `/issues/<n>` tails. Because the regex demands the whole `-private` suffix,
    // the PUBLIC twin never matches — citing it stays free, which is the point of
    // splitting the pair. A deliberately-public reference (if one ever arises)
    // uses the same config.lineExcludes / config.exemptFileBasenames allowlist
    // mechanism every other rule honors.
    //
    // The FIRST alternative is the one deliberate exception to the npm-scope
    // carve-out, and it is written as a LITERAL rather than as a hole in the
    // lookbehind: the carve-out exists because `@<org>/<x>` names a real vendored
    // workspace package, and no package will ever carry THIS name. Spelling the
    // one exception out leaves the general rule — every other `@<org>/<x>` is a
    // package scope, never a repo reference — exactly as strict as it was. It
    // shares the trailing lookahead, so `@<org>/<name>-foo` still does not trip,
    // and because it consumes the whole token the bare alternative cannot also
    // match inside it: one form, one finding.
    id: "SLG_PRIVATE_PROOFS_REF",
    description: "Bare name of the private proof-image repository",
    re: /(?:@cinatra-ai\/engineering-proofs-private|(?<![@A-Za-z0-9_/-])engineering-proofs-private)(?![A-Za-z0-9_-])/gi,
  },
  {
    // Descriptive prose naming the private design repository (the human-readable
    // form a scrub would otherwise miss). Rephrase to "the Cinatra design system".
    id: "SLG_PRIVATE_DESIGN_PHRASE",
    description: "Descriptive phrase naming the private design repository",
    re: /\bdesign reposit(?:or|ri)y\b|\bthe design repo\b/gi,
  },
];
// Single-prefix requirement IDs are project-specific; supply via config.reqIdSinglePrefixes.
const REQ_ID_SINGLE_RULE_ID = "SLG_REQ_ID_SINGLE";
// The organization the probe resolves names against. Held as a constant so no
// literal org path form appears OUTSIDE this self-exempt region.
const PROBE_ORG = "cinatra-ai";
// ===================== SOURCE_LEAK_RULES_END =====================

// ---------------------------------------------------------------------------
// Shared repository-name tokenization. Both lanes call these, so "which
// repository does this text name?" has exactly ONE answer in the whole gate.
// ---------------------------------------------------------------------------

// Canonical form of a repository name: case-folded (GitHub names are
// case-insensitive) with a trailing `.git` removed, so the remote in a clone URL
// resolves to the repository it clones rather than to a name that does not exist.
function normalizeRepoName(name) {
  const n = String(name || "").toLowerCase();
  return n.endsWith(".git") ? n.slice(0, -4) : n;
}

// The repository half of an `<org>/<name>` token the shared tokenizer matched.
function orgPathRepoName(match) {
  const parts = String(match || "").split("/");
  return parts.length > 1 ? normalizeRepoName(parts[1]) : "";
}

// True when the match at `index` sits INSIDE one of the required machine forms
// for `name`. Span-based on purpose: a line may carry a functional reference and
// a leaked one at once, and only the functional one is excused.
function functionalRefCovers(name, line, index) {
  for (const f of FUNCTIONAL_REPO_REFS) {
    if (f.name !== name) continue;
    const re = new RegExp(f.re.source, f.re.flags.includes("g") ? f.re.flags : `${f.re.flags}g`);
    let m;
    while ((m = re.exec(line)) !== null) {
      if (index >= m.index && index < m.index + m[0].length) return true;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return false;
}

const RULE_DEFS_MARKER_BEGIN = "SOURCE_LEAK_RULES" + "_BEGIN";
const RULE_DEFS_MARKER_END = "SOURCE_LEAK_RULES" + "_END";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    if (eq !== -1) {
      args[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { args[key] = next; i++; }
      else args[key] = true;
    }
  }
  return args;
}

function fail(msg) {
  console.error(`[source-leak-gate] ${msg}`);
  process.exit(2);
}

function loadConfig(configPath) {
  if (!configPath) return {};
  let raw;
  try { raw = fs.readFileSync(configPath, "utf8"); }
  catch { return fail(`config not found or unreadable: ${configPath}`); }
  try { return JSON.parse(raw); }
  catch (e) { return fail(`config is not valid JSON (${configPath}): ${e.message}`); }
}

// `options.probe` opts the DYNAMIC lane in. Probe rules are gated by MODE, not
// by profile: they are useless without a resolver, and their regex nominates
// public repositories too, so leaving them in the static rule set would turn
// every ordinary public reference into a finding.
function buildRules(config, profile, onlyRules, options = {}) {
  const rules = RULES
    .filter((r) => (options.probe ? true : !r.probe))
    .map((r) => ({ ...r, profiles: r.profiles || VALID_PROFILES }));

  const singlePrefixes = Array.isArray(config.reqIdSinglePrefixes) ? config.reqIdSinglePrefixes : [];
  if (singlePrefixes.length) {
    const alt = singlePrefixes.map((p) => String(p).replace(/[^A-Z0-9-]/gi, "")).filter(Boolean).join("|");
    if (alt) {
      rules.push({
        id: REQ_ID_SINGLE_RULE_ID,
        description: "Single-segment requirement ID (project-specific prefixes)",
        re: new RegExp(`\\b(?:${alt})-\\d{1,4}\\b`, "g"),
        profiles: VALID_PROFILES,
      });
    }
  }

  for (const er of Array.isArray(config.extraRules) ? config.extraRules : []) {
    if (!er || !er.id || !er.regex) continue;
    let re;
    try { re = new RegExp(er.regex, er.flags || "g"); }
    catch (e) { return fail(`config extraRule ${er.id} has an invalid regex: ${e.message}`); }
    const lineExcludes = (er.lineExcludes || []).map((s) => new RegExp(s));
    const pathExcludes = (er.pathExcludes || []).map((s) => new RegExp(s));
    rules.push({
      id: er.id,
      description: er.description || er.id,
      re,
      profiles: Array.isArray(er.profiles) && er.profiles.length ? er.profiles : VALID_PROFILES,
      contextExclude: lineExcludes.length ? (line) => lineExcludes.some((rx) => rx.test(line)) : undefined,
      pathExclude: pathExcludes.length ? (p) => pathExcludes.some((rx) => rx.test(p)) : undefined,
    });
  }

  const globalLineExcludes = (Array.isArray(config.lineExcludes) ? config.lineExcludes : []).map((s) => new RegExp(s));

  // A rule is active when its profiles list includes the requested profile, or
  // when it is a base rule (its profiles include "default"). We deliberately do
  // NOT treat profile === "default" as "activate every rule": that legacy
  // short-circuit forced a profile-scoped rule (e.g. a public-strict-only rule)
  // to ALSO fire under the `default` profile, which several repos run — leaking a
  // stricter check where it must not apply. Base rules keep "default" in their
  // profiles, so the `default` profile still runs the complete base set, unchanged.
  let active = rules.filter((r) => r.profiles.includes(profile) || r.profiles.includes("default"));
  if (onlyRules) {
    const set = new Set(onlyRules.split(",").map((s) => s.trim()).filter(Boolean));
    active = active.filter((r) => set.has(r.id));
  }
  if (globalLineExcludes.length) {
    active = active.map((r) => {
      const base = r.contextExclude;
      return { ...r, contextExclude: (line) => (base ? base(line) : false) || globalLineExcludes.some((rx) => rx.test(line)) };
    });
  }
  return active;
}

// ---------------------------------------------------------------------------
// The visibility probe (the DYNAMIC lane).
//
// A caller runs this gate with its OWN repository's GITHUB_TOKEN, which cannot
// enumerate the organization's private repositories — so there is no list to
// fetch. The probe asks a different, answerable question, once per distinct
// name: "can this token see that repository as public?". Only an explicit
// public answer clears a reference.
// ---------------------------------------------------------------------------
const PROBE_RULE_ID = "SLG_PRIVATE_REPO_PROBE";
const PROBE_ERROR_RULE_ID = "SLG_PRIVATE_REPO_PROBE_ERROR";
const PROBE_BUDGET_RULE_ID = "SLG_PRIVATE_REPO_PROBE_BUDGET";
const DEFAULT_API_BASE = "https://api.github.com";
// A gate that hangs is worse than a gate that blocks: an unanswered request
// times out into the same fail-closed branch as a refused one.
const PROBE_TIMEOUT_MS = 10_000;
// Per-run BUDGET. A gate must have a predictable worst case, so the probe has a
// hard ceiling on distinct names, a wall-clock deadline for the whole lane, and
// bounded concurrency. Every candidate the budget prevents us from asking about
// becomes a `probe budget` finding: unasked is never treated as clean.
const PROBE_MAX_NAMES = 40;
const PROBE_DEADLINE_MS = 60_000;
const PROBE_CONCURRENCY = 4;
// A cached public verdict older than this is not trusted: a repository can be
// flipped to private at any time, and a stale entry would keep clearing it.
const PUBLIC_CACHE_TTL_DAYS = 7;
const REPO_NAME_RE = /^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Module-level injection point for the probe's one HTTP call. Production leaves
// it null and uses the global fetch; the tests install a stub so the suite stays
// hermetic and dependency-free.
let probeFetchImpl = null;
function setProbeFetch(fn) { probeFetchImpl = fn || null; }
function probeFetch(url, init) {
  const impl = probeFetchImpl || globalThis.fetch;
  if (typeof impl !== "function") throw new Error("no fetch implementation available");
  return impl(url, init);
}

function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }

// The committed known-PUBLIC cache, consulted BEFORE any call. It is a LATENCY
// cache, never an authority for "private": a name absent from it — or present
// but past its TTL — is resolved live. Each entry carries the day it was last
// confirmed public, because a cache entry that cannot go stale is a permanent
// fail-open: a repository turned private later would keep clearing forever.
// Names are validated strictly, so a malformed or `.git`-suffixed entry is a
// hard error rather than an entry that silently never matches anything. It
// THROWS rather than exiting: the caller decides what a bad cache means (main()
// turns it into the usual gate failure), and the loader stays testable.
function loadKnownPublicRepos(explicitPath, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const p = explicitPath
    || (SCANNER_REAL ? path.join(path.dirname(SCANNER_REAL), "..", "config", "public-repos.json") : "");
  if (!p) return { names: new Set(), entries: [], path: "", note: "no cache path resolved" };
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); }
  catch { return { names: new Set(), entries: [], path: p, note: "cache absent (every reference resolves live)" }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`public-repos cache is not valid JSON (${p}): ${e.message}`); }
  if (!parsed || !Array.isArray(parsed.public)) {
    throw new Error(`public-repos cache must be an object with a "public" array (${p})`);
  }
  const ttlDays = Number.isFinite(parsed.ttlDays) ? parsed.ttlDays : PUBLIC_CACHE_TTL_DAYS;
  const entries = [];
  const fresh = new Set();
  let stale = 0;
  for (const raw of parsed.public) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`public-repos cache entries must be objects with "name" and "verifiedAt" (${p})`);
    }
    const name = normalizeRepoName(raw.name);
    if (!REPO_NAME_RE.test(String(raw.name || "")) || name !== String(raw.name || "").toLowerCase()) {
      throw new Error(`public-repos cache has an invalid repository name: ${JSON.stringify(raw.name)} (${p})`);
    }
    if (!ISO_DAY_RE.test(String(raw.verifiedAt || ""))) {
      throw new Error(`public-repos cache entry ${JSON.stringify(raw.name)} needs a YYYY-MM-DD "verifiedAt" (${p})`);
    }
    const verifiedAt = new Date(`${raw.verifiedAt}T00:00:00Z`);
    if (Number.isNaN(verifiedAt.getTime())) {
      throw new Error(`public-repos cache entry ${JSON.stringify(raw.name)} has an unparseable "verifiedAt" (${p})`);
    }
    entries.push({ name, verifiedAt: raw.verifiedAt });
    const ageDays = (now.getTime() - verifiedAt.getTime()) / 86_400_000;
    if (ageDays <= ttlDays) fresh.add(name); else stale++;
  }
  const note = `${fresh.size} fresh cached public name(s)`
    + (stale ? `, ${stale} past the ${ttlDays}-day TTL (resolved live)` : "");
  return { names: fresh, entries, path: p, ttlDays, note };
}

function makeProbeContext({ token, knownPublic, apiBase, timeoutMs, maxNames, deadlineMs, concurrency }) {
  return {
    token: token || "", knownPublic: knownPublic || new Set(),
    apiBase: apiBase || DEFAULT_API_BASE, timeoutMs: timeoutMs || PROBE_TIMEOUT_MS,
    maxNames: Number.isFinite(maxNames) ? maxNames : PROBE_MAX_NAMES,
    deadlineMs: Number.isFinite(deadlineMs) ? deadlineMs : PROBE_DEADLINE_MS,
    concurrency: Number.isFinite(concurrency) ? concurrency : PROBE_CONCURRENCY,
    cache: new Map(), calls: 0, skipped: 0,
  };
}

// One verdict per distinct name: { state: "public" | "private" | "error", reason }.
// Every non-public branch — including every branch that failed to produce an
// answer — is a blocking state. There is no path that returns "public" without
// the API having said so (or a FRESH cache entry vouching for it).
async function resolveRepoVisibility(name, ctx) {
  if (ctx.knownPublic.has(name)) return { state: "public", reason: "a fresh entry in the committed public-repos cache" };
  if (ctx.cache.has(name)) return ctx.cache.get(name);

  let verdict;
  try {
    ctx.calls++;
    const headers = { accept: "application/vnd.github+json", "user-agent": "source-leak-gate" };
    if (ctx.token) headers.authorization = `Bearer ${ctx.token}`;
    const res = await probeFetch(`${ctx.apiBase}/repos/${PROBE_ORG}/${encodeURIComponent(name)}`, {
      headers,
      signal: AbortSignal.timeout(ctx.timeoutMs || PROBE_TIMEOUT_MS),
    });
    const status = res && typeof res.status === "number" ? res.status : null;
    if (status === 200) {
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!body || typeof body.private !== "boolean") {
        verdict = { state: "error", reason: "malformed API response (200 without a boolean `private`)" };
      } else {
        verdict = body.private
          ? { state: "private", reason: "the API reports the repository private" }
          : { state: "public", reason: "the API reports the repository public" };
      }
    } else if (status === 404) {
      // What a private repository returns to a token without access — and what
      // a name that does not exist returns. Both block: a gate that cannot see
      // a repository must not vouch for it.
      verdict = { state: "private", reason: "404 — private or nonexistent for this token" };
    } else if (status === 401 || status === 403 || status === 429) {
      verdict = { state: "error", reason: `not resolvable (HTTP ${status} — credentials or rate limit)` };
    } else {
      verdict = { state: "error", reason: `unexpected API status ${status === null ? "(no response)" : status}` };
    }
  } catch (e) {
    verdict = { state: "error", reason: `network error: ${e.message}` };
  }
  ctx.cache.set(name, verdict);
  return verdict;
}

// Resolves distinct names with bounded concurrency inside a wall-clock deadline,
// up to a hard ceiling. Returns the set of names the budget left UNASKED.
async function resolveNamesWithinBudget(names, ctx) {
  const unasked = new Map();
  const queue = [];
  for (const n of names) {
    if (ctx.knownPublic.has(n) || ctx.cache.has(n)) continue; // free: already answered
    if (queue.length >= ctx.maxNames) { unasked.set(n, `over the ${ctx.maxNames}-name per-run cap`); continue; }
    queue.push(n);
  }
  const deadline = Date.now() + ctx.deadlineMs;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= queue.length) return;
      const name = queue[i];
      if (Date.now() >= deadline) { unasked.set(name, `past the ${ctx.deadlineMs}ms per-run deadline`); continue; }
      await resolveRepoVisibility(name, ctx);
    }
  };
  const lanes = Math.max(1, Math.min(ctx.concurrency, queue.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  ctx.skipped = unasked.size;
  return unasked;
}

// Turns nominated candidates into findings. A candidate the offline rules
// already own is dropped by the rule's own matchExclude before it ever gets
// here. A public verdict is dropped. Everything else becomes a finding — an
// unresolved one, or a budget-skipped one, under its own rule id and carrying
// the cause, so a rate-limited or over-budget run reads as "could not verify",
// never as a leak and never as a pass.
async function resolveProbeFindings(candidates, ctx) {
  const order = [];
  const seen = new Set();
  for (const f of candidates) {
    const name = orgPathRepoName(f.match);
    if (!name || PROBE_EXEMPT_NAMES.has(name)) continue;
    if (!seen.has(name)) { seen.add(name); order.push(name); }
  }
  const unasked = await resolveNamesWithinBudget(order, ctx);

  const out = [];
  for (const f of candidates) {
    const name = orgPathRepoName(f.match);
    if (!name || PROBE_EXEMPT_NAMES.has(name)) continue;
    if (unasked.has(name)) {
      const why = unasked.get(name);
      out.push({ ...f, rule: PROBE_BUDGET_RULE_ID, reason: why, snippet: `unverified (probe budget: ${why}): ${f.snippet}` });
      continue;
    }
    const verdict = await resolveRepoVisibility(name, ctx);
    if (verdict.state === "public") continue;
    if (verdict.state === "private") {
      out.push({ ...f, reason: verdict.reason });
    } else {
      out.push({ ...f, rule: PROBE_ERROR_RULE_ID, reason: verdict.reason, snippet: `unresolved (${verdict.reason}): ${f.snippet}` });
    }
  }
  return out;
}

// The ONE canonical serialization of the cache file. Exported so a test can
// assert the committed file is already in it (the gate-suite index uses the same
// trick): a hand-edit that reflows the file is then caught here, not by a
// scheduled job opening a pull request for whitespace.
function serializePublicRepoCache(obj) {
  const entries = (obj.public || []).map((e) => `    { "name": ${JSON.stringify(e.name)}, "verifiedAt": ${JSON.stringify(e.verifiedAt)} }`);
  const head = { ...obj };
  delete head.public;
  const headJson = JSON.stringify(head, null, 2).slice(1, -1).replace(/\n$/, "").replace(/\s+$/, "");
  return `{${headJson},\n  "public": [\n${entries.join(",\n")}\n  ]\n}\n`;
}

// `--verify-cache`: re-confirm every committed cache entry against the API and
// rewrite its timestamp, dropping any entry that is no longer explicitly public.
// An entry that cannot be resolved is left EXACTLY as it was and reported as an
// error — a refresh run must never launder an unanswered request into a fresh
// timestamp. Returns a summary; the caller decides the exit code.
async function verifyPublicRepoCache(cachePath, ctx, options = {}) {
  const loaded = loadKnownPublicRepos(cachePath, { now: options.now });
  if (!loaded.path) return { error: "no public-repos cache path resolved" };
  const today = isoDay(options.now || Date.now());
  const bare = makeProbeContext({ token: ctx.token, apiBase: ctx.apiBase, timeoutMs: ctx.timeoutMs, knownPublic: new Set() });
  const refreshed = [], dropped = [], unresolved = [];
  for (const entry of loaded.entries) {
    const verdict = await resolveRepoVisibility(entry.name, bare);
    if (verdict.state === "public") refreshed.push({ name: entry.name, verifiedAt: today, changed: entry.verifiedAt !== today });
    else if (verdict.state === "private") dropped.push({ name: entry.name, reason: verdict.reason });
    else { refreshed.push({ name: entry.name, verifiedAt: entry.verifiedAt, changed: false }); unresolved.push({ name: entry.name, reason: verdict.reason }); }
  }
  // Serialize in the generator's CANONICAL form. The committed file must already
  // be in it, or every scheduled refresh would "drift" on formatting alone and
  // open a pull request that changes nothing.
  const raw = JSON.parse(fs.readFileSync(loaded.path, "utf8"));
  raw.public = refreshed.map((r) => ({ name: r.name, verifiedAt: r.verifiedAt }));
  const next = serializePublicRepoCache(raw);
  const changed = next !== fs.readFileSync(loaded.path, "utf8");
  if (changed && !options.dryRun) fs.writeFileSync(loaded.path, next);
  return { path: loaded.path, changed, dropped, unresolved, calls: bare.calls, checked: loaded.entries.length };
}


function listTrackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return walk(process.cwd());
  }
}

function walk(dir, acc = [], relBase = "") {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const e of entries) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (DEFAULT_SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), acc, rel);
    } else if (e.isFile()) {
      acc.push(rel);
    }
  }
  return acc;
}

function applyManifest(files, manifestPath) {
  if (!manifestPath) return files;
  let lines;
  try { lines = fs.readFileSync(manifestPath, "utf8").split("\n"); }
  catch { return fail(`manifest not found or unreadable: ${manifestPath}`); }
  const includesDir = [], includesExact = new Set(), negDirs = [], negExact = new Set();
  for (let l of lines) {
    l = l.trim();
    if (!l || l.startsWith("#")) continue;
    let neg = false;
    if (l.startsWith("!")) { neg = true; l = l.slice(1); }
    if (l.endsWith("/")) (neg ? negDirs : includesDir).push(l);
    else (neg ? negExact : includesExact).add(l);
  }
  const isNeg = (f) => negExact.has(f) || negDirs.some((d) => f === d.slice(0, -1) || f.startsWith(d));
  const isInc = (f) => includesExact.has(f) || includesDir.some((d) => f === d.slice(0, -1) || f.startsWith(d));
  return files.filter((f) => !isNeg(f) && isInc(f));
}

function isPrivate(p) {
  return PRIVATE_EXACT.has(p) || PRIVATE_PREFIXES.some((pre) => p.startsWith(pre));
}
function shouldScan(p, scanExtensions, skipDirs, skipDirPrefixes, skipFilePatterns) {
  if (p.split("/").some((seg) => skipDirs.has(seg))) return false;
  if (skipDirPrefixes.some((pre) => p === pre.replace(/\/$/, "") || p.startsWith(pre))) return false;
  const base = p.split("/").pop();
  if (skipFilePatterns.some((rx) => rx.test(base))) return false;
  if (["package.json", "tsconfig.json", "Dockerfile"].includes(base)) return true;
  const ext = path.extname(p);
  if (scanExtensions.has(ext)) return true;
  return ["Makefile", "README", "AGENTS", "LICENSE", "NOTICE", "CHANGELOG"].some((n) => base.startsWith(n));
}

function readRuleDefRange(text) {
  const lines = text.split("\n");
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && lines[i].includes(RULE_DEFS_MARKER_BEGIN)) start = i + 1;
    else if (start !== -1 && lines[i].includes(RULE_DEFS_MARKER_END)) { end = i + 1; break; }
  }
  return { start, end };
}

function scanFile(relPath, rules) {
  let stat;
  try { stat = fs.statSync(relPath); } catch { return []; }
  if (!stat.isFile() || stat.size > 2_000_000) return [];
  let text;
  try { text = fs.readFileSync(relPath, "utf8"); } catch { return []; }
  if (text.includes("\0")) return [];
  const isSelf = SCANNER_REAL !== "" && realPathOf(relPath) === SCANNER_REAL;
  const defRange = isSelf ? readRuleDefRange(text) : { start: -1, end: -1 };
  const lines = text.split(/\r?\n/);
  const findings = [];
  for (const rule of rules) {
    if (rule.pathExclude && rule.pathExclude(relPath)) continue;
    for (let i = 0; i < lines.length; i++) {
      const lineno = i + 1;
      if (isSelf && defRange.start !== -1 && lineno >= defRange.start && lineno <= defRange.end) continue;
      const line = lines[i];
      const localRe = new RegExp(rule.re.source, rule.re.flags);
      let m;
      while ((m = localRe.exec(line)) !== null) {
        if (rule.contextExclude && rule.contextExclude(line)) break;
        // matchExclude is per MATCH (contextExclude is per LINE): a rule that
        // excuses one specific form must not excuse every other token that
        // happens to share the line with it.
        if (!(rule.matchExclude && rule.matchExclude(m[0], line, m.index))) {
          findings.push({ rule: rule.id, file: relPath, line: lineno, column: m.index + 1, match: m[0], snippet: line.trim().slice(0, 200) });
        }
        if (!localRe.global) break;
        if (m.index === localRe.lastIndex) localRe.lastIndex++;
      }
    }
  }
  return findings;
}

// File-name (path) scan: a leaky FILE or DIRECTORY name is a leak even when the
// file's content is clean (or unscanned, e.g. a binary). Scans the path
// PER-SEGMENT with the rule subset flagged `pathScan` — per-segment so one
// benign segment's contextExclude (e.g. ECC `P-256`) can't suppress a leaky
// sibling segment, and so segment-spanning regex separators (`/`) don't create
// cross-directory false positives. Path findings carry line:0 (the marker that
// routes them through the path ratchet, never the line ratchet).
function scanPath(relPath, pathRules) {
  if (!pathRules.length) return [];
  const segments = relPath.split("/");
  const findings = [];
  for (const rule of pathRules) {
    for (const seg of segments) {
      const localRe = new RegExp(rule.re.source, rule.re.flags);
      let m;
      while ((m = localRe.exec(seg)) !== null) {
        if (rule.contextExclude && rule.contextExclude(seg)) break;
        if (!(rule.matchExclude && rule.matchExclude(m[0], seg, m.index))) {
          findings.push({ rule: rule.id, file: relPath, line: 0, column: 0, match: m[0], snippet: `path: ${relPath}` });
        }
        if (!localRe.global) break;
        if (m.index === localRe.lastIndex) localRe.lastIndex++;
      }
    }
  }
  return findings;
}

function applyLineRatchet(findings, diffBaseEnv) {
  const base = resolveBaseRef(diffBaseEnv);
  if (!base) return findings;
  const renameMap = buildRenameMap(base);
  const cache = new Map();
  return findings.filter((f) => {
    if (!cache.has(f.file)) cache.set(f.file, getAddedLineNumbers(f.file, base, renameMap));
    const added = cache.get(f.file);
    if (added === null) return true;
    return added.has(f.line);
  });
}

// Ratchet for path (line:0) findings: block only on paths the PR ADDED, RENAMED-
// to, or COPIED-to; tolerate pre-existing leaky paths. Strict / fail-closed
// (block all) when there is no base or the diff cannot be computed — never
// silently tolerate a rename into a leaky name.
function applyPathRatchet(pathFindings, diffBaseEnv) {
  if (!pathFindings.length) return [];
  const base = resolveBaseRef(diffBaseEnv);
  const introduced = getIntroducedPaths(base);
  if (introduced === null) return pathFindings; // strict / fail-closed
  return pathFindings.filter((f) => introduced.has(f.file));
}

function resolveTouchedFiles(diffBaseEnv) {
  const base = resolveBaseRef(diffBaseEnv);
  if (!base) return null;
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--end-of-options", `${base}...HEAD`], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {
    return null; // fail closed: file ratchet treats null as strict (all allowlisted entries block)
  }
}

function applyFileRatchet(findings, args, diffBaseEnv) {
  const allowlistPath = args["legacy-allowlist"];
  let allow = new Set();
  if (allowlistPath && fs.existsSync(allowlistPath)) {
    try { allow = new Set(JSON.parse(fs.readFileSync(allowlistPath, "utf8")).files || []); }
    catch (e) { return { error: `legacy-allowlist is not valid JSON (${allowlistPath}): ${e.message}` }; }
  }
  const findingFiles = new Set(findings.map((f) => f.file));
  let touched;
  try { touched = resolveTouchedFiles(diffBaseEnv); }
  catch (e) { return { error: e.message }; }
  const blockers = [];
  for (const f of findings) {
    if (!allow.has(f.file)) { blockers.push(f); continue; }
    if (touched === null || touched.has(f.file)) blockers.push(f);
  }
  const stale = [...allow].filter((p) => !findingFiles.has(p));
  for (const p of stale) blockers.push({ rule: "SLG_STALE_ALLOWLIST", file: p, line: 0, column: 0, match: p, snippet: "stale allowlist entry" });
  return { blockers, note: `file ratchet: ${allow.size} allowlisted, ${stale.length} stale` };
}

function gateBaselineKey(f) { return `${f.rule}\t${f.file}`; }
function applyBaselineRatchet(findings, args) {
  const baselinePath = args["gate-baseline"];
  if (!baselinePath) return { blockers: findings, note: "baseline mode without --gate-baseline (all findings gated)" };
  if (!fs.existsSync(baselinePath)) return { error: `gate baseline not found or unreadable: ${baselinePath}` };
  let base;
  try { base = JSON.parse(fs.readFileSync(baselinePath, "utf8")).perRuleFile || {}; }
  catch (e) { return { error: `gate baseline is not valid JSON (${baselinePath}): ${e.message}` }; }
  const current = {};
  for (const f of findings) current[gateBaselineKey(f)] = (current[gateBaselineKey(f)] || 0) + 1;
  const blockers = [];
  for (const [k, count] of Object.entries(current)) {
    if (count > (base[k] || 0)) {
      const [rule, file] = k.split("\t");
      blockers.push({ rule, file, line: 0, column: 0, match: `${count} > ${base[k] || 0}`, snippet: "new finding beyond baseline" });
    }
  }
  return { blockers, note: `baseline ratchet: ${Object.keys(base).length} accepted group(s)` };
}
function writeGateBaseline(findings, outPath) {
  const perRuleFile = {};
  for (const f of findings) perRuleFile[gateBaselineKey(f)] = (perRuleFile[gateBaselineKey(f)] || 0) + 1;
  let gitHead = null;
  try { gitHead = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch { /* no head */ }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ gitHead, perRuleFile }, null, 2) + "\n");
}

function countBy(arr, keyFn) {
  const out = {};
  for (const x of arr) out[keyFn(x)] = (out[keyFn(x)] || 0) + 1;
  return out;
}
function buildSummary(findings, gateFindings, profile, scannedFileCount) {
  return {
    scannerVersion: SCANNER_VERSION, profile, scannedFileCount,
    totalFindings: findings.length, gatedFindings: gateFindings.length,
    perRule: countBy(gateFindings, (f) => f.rule), samples: gateFindings.slice(0, 50),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = args.profile || "default";
  if (!VALID_PROFILES.includes(profile)) fail(`unknown --profile '${profile}' (valid: ${VALID_PROFILES.join(", ")})`);
  const ratchetMode = args["ratchet-mode"] || "line";
  if (!VALID_RATCHET_MODES.includes(ratchetMode)) fail(`unknown --ratchet-mode '${ratchetMode}' (valid: ${VALID_RATCHET_MODES.join(", ")})`);
  const format = args.format || "text";
  const quiet = Boolean(args.quiet);
  const exitOnMatch = Boolean(args["exit-on-match"]);
  const includeTests = args["include-tests"] !== "false";
  const diffBaseEnv = args["diff-base-env"] || DEFAULT_DIFF_BASE_ENV;
  const config = loadConfig(args.config);

  // Mode selection (see the header). `--offline` always wins; otherwise a token
  // enables the probe, and `--probe` forces it on unauthenticated.
  const probeToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const probeEnabled = !args.offline && (Boolean(probeToken) || Boolean(args.probe));
  let knownPublic = null;
  if (probeEnabled) {
    try { knownPublic = loadKnownPublicRepos(args["public-repos"]); }
    catch (e) { return fail(e.message); }
  }
  const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));
  const probeCtx = probeEnabled
    ? makeProbeContext({
      token: probeToken, knownPublic: knownPublic.names,
      apiBase: args["api-base"] || DEFAULT_API_BASE,
      maxNames: num("probe-max-names", undefined),
      deadlineMs: num("probe-deadline-ms", undefined),
      concurrency: num("probe-concurrency", undefined),
    })
    : null;

  // `--verify-cache` is a MAINTENANCE mode, not a scan: it re-confirms every
  // committed cache entry and rewrites the timestamps. It needs a resolver, so
  // it refuses to run offline rather than quietly rubber-stamping the file.
  if (args["verify-cache"]) {
    if (!probeEnabled) fail("--verify-cache needs the probe (a token in GITHUB_TOKEN/GH_TOKEN, or --probe)");
    let r;
    try { r = await verifyPublicRepoCache(args["public-repos"], probeCtx, { dryRun: Boolean(args["dry-run"]) }); }
    catch (e) { return fail(e.message); }
    if (r.error) fail(r.error);
    const verb = r.changed ? (args["dry-run"] ? "WOULD BE REWRITTEN (dry run)" : "REWRITTEN") : "unchanged";
    process.stderr.write(`public-repos cache: ${r.checked} entry(ies) checked, ${r.calls} API call(s), ${verb}\n`);
    for (const d of r.dropped) process.stderr.write(`  dropped ${d.name}: ${d.reason}\n`);
    for (const u of r.unresolved) process.stderr.write(`  UNRESOLVED ${u.name}: ${u.reason} (entry left untouched)\n`);
    process.exit(r.unresolved.length ? 2 : 0);
  }

  const rules = buildRules(config, profile, args.rules || null, { probe: probeEnabled });

  const scanExtensions = new Set([...DEFAULT_SCAN_EXTENSIONS, ...((config.scanExtensions) || [])]);
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...((config.skipDirs) || [])]);
  const skipDirPrefixes = [...DEFAULT_SKIP_DIR_PREFIXES, ...((config.skipDirPrefixes) || [])];
  const skipFilePatterns = [...DEFAULT_SKIP_FILE_PATTERNS, ...((config.skipFilePatterns) || []).map((s) => new RegExp(s))];
  const exemptDirs = [...EXEMPT_DIR_PREFIXES, ...((config.exemptDirPrefixes) || [])];
  const exemptFiles = new Set([...EXEMPT_FILE_BASENAMES, ...((config.exemptFileBasenames) || [])]);

  // The gate's own config / legacy-allowlist / baseline artifacts necessarily
  // contain the very tokens (and leaky path strings) they describe — never scan
  // them, or a regenerated allowlist would flag itself.
  const gateArtifacts = new Set(
    [args.config, args["legacy-allowlist"], args["gate-baseline"]].filter(Boolean).map((p) => realPathOf(p)).filter(Boolean),
  );

  let files = listTrackedFiles();
  files = applyManifest(files, args.manifest);
  const candidates = files.filter((p) => {
    const real = realPathOf(p);
    if (real && real === SCANNER_REAL) return true; // the running gate (rule-def region is sentinel-exempt)
    if (real && FIXTURE_REAL && real === FIXTURE_REAL) return false; // this gate's own marker fixture
    if (real && gateArtifacts.has(real)) return false; // gate's own config/allowlist/baseline
    if (isPrivate(p)) return false;
    if (!includeTests && /(^|\/)(__tests__|\.test\.|\.spec\.)/.test(p)) return false;
    return shouldScan(p, scanExtensions, skipDirs, skipDirPrefixes, skipFilePatterns);
  });

  let findings = [];
  for (const f of candidates) {
    const fileFindings = scanFile(f, rules);
    if (!fileFindings.length) continue;
    const base = f.split("/").pop();
    if (exemptFiles.has(base) || exemptDirs.some((pre) => f.startsWith(pre))) continue;
    findings.push(...fileFindings);
  }

  // File-name (path) scan: extension-INDEPENDENT candidate set (a leaky-named
  // binary counts), re-applying every exclusion (private/skip/exempt/gate-own)
  // up front. Path findings (line:0) merge into `findings` so file/baseline
  // ratchets key on path consistently.
  const pathRules = rules.filter((r) => r.pathScan);
  if (pathRules.length) {
    for (const p of files) {
      const real = realPathOf(p);
      if (real && (real === SCANNER_REAL || (FIXTURE_REAL && real === FIXTURE_REAL) || gateArtifacts.has(real))) continue;
      if (isPrivate(p)) continue;
      if (!includeTests && /(^|\/)(__tests__|\.test\.|\.spec\.)/.test(p)) continue;
      if (p.split("/").some((seg) => skipDirs.has(seg))) continue;
      if (skipDirPrefixes.some((pre) => p === pre.replace(/\/$/, "") || p.startsWith(pre))) continue;
      const base = p.split("/").pop();
      if (exemptFiles.has(base) || exemptDirs.some((pre) => p.startsWith(pre))) continue;
      findings.push(...scanPath(p, pathRules));
    }
  }

  // The probe lane is kept OUT of `findings` until it has verdicts: a nominated
  // candidate is not a finding (most are ordinary public references), so it must
  // never reach the summary total, the baseline writer or the file allowlist as
  // one.
  const probeCandidates = findings.filter((f) => f.rule === PROBE_RULE_ID);
  findings = findings.filter((f) => f.rule !== PROBE_RULE_ID);

  // Resolve BEFORE the ratchets, so a resolved probe finding is an ordinary
  // finding by the time they run: the file allowlist can cover it, a
  // probe-only allowlist entry does not read as stale, and a baseline can
  // record it. Only LINE mode filters first — there the ratchet verdict is
  // already known per line, so dropping tolerated candidates up front saves the
  // API calls without changing any outcome. The other modes cannot know what
  // they will tolerate until they have counted, so they resolve everything.
  let probeNote = "";
  if (probeEnabled) {
    const toResolve = ratchetMode === "line"
      ? applyLineRatchet(probeCandidates.filter((f) => f.line > 0), diffBaseEnv)
      : probeCandidates;
    const resolved = await resolveProbeFindings(toResolve, probeCtx);
    findings = [...findings, ...resolved];
    probeNote = `visibility probe: ${toResolve.length} reference(s), ${probeCtx.cache.size} name(s) resolved, `
      + `${probeCtx.calls} API call(s), ${probeCtx.skipped} over budget; ${knownPublic.note}`;
  } else {
    probeNote = `visibility probe: offline (${args.offline ? "--offline" : "no token in GITHUB_TOKEN/GH_TOKEN"}) — the built-in private-repository list is the only authority`;
  }

  let gateFindings = findings;
  let ratchetNote = "";
  if (ratchetMode === "line") {
    // Content findings (line>0) ride the line ratchet; path findings (line:0)
    // ride the path ratchet (a rename into a leaky name has no "added line").
    const contentFindings = findings.filter((f) => f.line > 0);
    const pathFindings = findings.filter((f) => f.line === 0);
    gateFindings = [...applyLineRatchet(contentFindings, diffBaseEnv), ...applyPathRatchet(pathFindings, diffBaseEnv)];
    ratchetNote = `line ratchet: ${findings.length - gateFindings.length} pre-existing finding(s) tolerated`;
  } else if (ratchetMode === "file") {
    const r = applyFileRatchet(findings, args, diffBaseEnv);
    if (r.error) fail(r.error);
    gateFindings = r.blockers; ratchetNote = r.note;
  } else if (ratchetMode === "baseline") {
    const r = applyBaselineRatchet(findings, args);
    if (r.error) fail(r.error);
    gateFindings = r.blockers; ratchetNote = r.note;
  }
  if (args["write-gate-baseline"]) writeGateBaseline(findings, args["write-gate-baseline"]);

  if (format === "json") {
    process.stdout.write(JSON.stringify(buildSummary(findings, gateFindings, profile, candidates.length), null, 2) + "\n");
  } else if (!quiet) {
    for (const f of gateFindings) process.stdout.write(`${f.rule}\t${f.file}:${f.line}:${f.column}\t${f.match}\t${f.snippet}\n`);
    process.stderr.write(`Scanned ${candidates.length} files, ${gateFindings.length} gated finding(s)` + (ratchetNote ? ` (${ratchetNote})` : "") + "\n");
    process.stderr.write(`  ${probeNote}\n`);
    for (const [r, c] of Object.entries(countBy(gateFindings, (f) => f.rule)).sort((a, b) => b[1] - a[1])) {
      process.stderr.write(`  ${r}: ${c}\n`);
    }
    if (gateFindings.length === 0) process.stderr.write("source-leak-gate: clean.\n");
  }

  if (exitOnMatch && gateFindings.length > 0) process.exit(1);
  process.exit(0);
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
  main().catch((e) => { console.error("[source-leak-gate] scanner failed:", e.message); process.exit(2); });
}

export {
  buildRules, scanFile, RULES, readRuleDefRange,
  setProbeFetch, makeProbeContext, resolveRepoVisibility, resolveProbeFindings,
  loadKnownPublicRepos, verifyPublicRepoCache, serializePublicRepoCache,
  normalizeRepoName, orgPathRepoName, functionalRefCovers,
  PRIVATE_REPO_NAMES, PROBE_EXEMPT_NAMES, FUNCTIONAL_REPO_REFS,
  PROBE_RULE_ID, PROBE_ERROR_RULE_ID, PROBE_BUDGET_RULE_ID,
  PROBE_MAX_NAMES, PUBLIC_CACHE_TTL_DAYS,
};
