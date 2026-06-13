#!/usr/bin/env node
/**
 * truthful-attribution-gate — reusable CI gate (org-wide; re-scopes eng#116).
 *
 * Ratified spec: cinatra-engineering#119 (converged spec comment
 * issuecomment-4692554529, AS AMENDED by the ratification comment
 * issuecomment-4694404775). This gate REPLACES the paused/closed #116
 * no-AI-attribution gate: its semantics flip from *banning* AI records to
 * *requiring truthful ones* (presence + anti-fabrication). The record is the
 * truthful verification-record model — `Assisted-by` (transparency: what
 * produced the change) plus a verification arm (honest: what checked it —
 * a named human who read it, or the audited gate suite with a named
 * Accountable engineer).
 *
 * "We never put a human's name on a change they did not read." The core
 * anti-fabrication invariant: a `Reviewed-by: <login>` must match a REAL,
 * non-self, non-stale GitHub PR approval by that login at the reviewed head;
 * a `Gate-suite: <id>@<ver>` must match the committed gate-suite registry at
 * the merged SHA AND every required context must have concluded green on the
 * reviewed head. Lying in the verification record is the one thing the gate
 * works hardest to catch — that is where a lie does damage.
 *
 * ============================ STAGE 2 — WARN MODE ============================
 * This build runs in WARN mode: it COMPUTES every finding (presence,
 * anti-fabrication, high-risk-without-maintainer, known-agent-without-record)
 * and emits them as GitHub annotations + a step summary, but ALWAYS exits 0.
 * No PR is ever failed in WARN. The enforce upgrade is a single `--mode enforce`
 * flag — but flipping ENFORCE is NOT a gate-build action: per spec §7 it is
 * gated on the dedicated machine identity for agent-opened PRs ([owner] issue,
 * spec §8.5). Do not flip enforcement from here.
 *
 * ============================ DETECTION LIMITS ==============================
 * Per spec §5 "Detection limits, honestly":
 *  - Pre-merge cannot read the synthesized squash message. This arm truth-checks
 *    the CLAIMS that exist before merge (branch-commit `Assisted-by`, approvals,
 *    contexts, high-risk mapping); the RECORD itself (the squash trailer block)
 *    is verified post-merge. Detection + forward correction + a blocked line
 *    until corrected — not prevention of a bad message ever landing.
 *  - `Assisted-by` truthfulness is unverifiable server-side. An agent-produced
 *    commit under a clean human identity is undetectable unless the actor
 *    matches the known-agent list (check 5). The gate verifies *verification*
 *    claims, which is where lying does damage.
 *  - `Reviewed-by` verifies the approval event, not the reading. Approval on the
 *    exact SHA + verified repo standing is the strongest mechanical proxy for
 *    "a named human read this." The gate cannot prove eyeballs.
 *
 * Two arms are exercised by the workflow (pre-merge on PRs; post-merge on the
 * default-branch push); a third org watchdog lives in its own scheduled
 * workflow. This script implements the per-run analysis for the pre-merge and
 * post-merge arms; the arm is selected by --arm.
 *
 * Zero runtime dependencies (node builtins only). GitHub API access is via an
 * injectable client (default: `gh api` through execFileSync), so the entire
 * analysis is unit-testable offline with a stub client.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GATE_VERSION = "0.1.0";

const VALID_MODES = ["warn", "enforce"];
const VALID_ARMS = ["pre-merge", "post-merge"];
const VALID_FORMATS = ["text", "json"];

const VALUE_FLAGS = new Set([
  "arm", "mode", "format", "config", "high-risk-defaults", "gate-suite",
  "diff-base", "diff-base-env", "commit", "repo", "pr", "head-sha",
]);
const BOOLEAN_FLAGS = new Set(["quiet"]);

const DEFAULT_DIFF_BASE_ENV = "TRUTHFUL_ATTR_DIFF_BASE";

// ===========================================================================
// §1 — Trailer grammar (flat, git interpret-trailers-compatible Key: value)
//
// The spec drops the literal `Verified-by:` umbrella (git trailers are flat;
// nesting breaks interpret-trailers); the verification ARM is identified by
// which keys appear. The keys:
//   Assisted-by:  <display-name> [ (<model-id>) ]   | "none" (reserved, solo)
//   Reviewed-by:  <full-name> <<email>> (@<login>, tier=<maintainer|peer>)
//   Gate-suite:   <suite-id>@<version>
//   Accountable:  <full-name> <<email>> (@<login>)
//   Correction-for: <40-hex sha>                    (corrections only, §5)
// ===========================================================================

const TIERS = new Set(["maintainer", "peer"]);

// display-name: 1..64 chars, no , ( ) < >  (so agent names avoid them), and
// MUST contain at least one non-whitespace char (a blank name is not a name —
// it would otherwise let a known-agent commit carry an empty `Assisted-by:` and
// satisfy check 5 with a non-`none` assistant). The leading `\S` anchor forces
// a real character; `.trim()` on the captured value then cleans trailing space.
const ASSISTED_RE =
  /^Assisted-by:[ \t]+(none|(?<name>\S[^,()<>\n]{0,63}?)(?:[ \t]+\((?<model>[A-Za-z0-9._/:-]{1,64})\))?)[ \t]*$/;

// Reviewed-by: <full-name> <<email>> (@<login>, tier=<tier>)
// full-name: no < >. email: addr-spec (one line, no display name). gh-login:
// alnum with internal single hyphens, <=39 (syntax preliminary; API identity
// resolution in §5 is authoritative).
const REVIEWED_RE =
  /^Reviewed-by:[ \t]+(?<name>\S[^<>\n]{0,127}?)[ \t]+<(?<email>[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>[ \t]+\(@(?<login>[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}),[ \t]*tier=(?<tier>maintainer|peer)\)[ \t]*$/;

// Gate-suite: <suite-id>@<version>   suite-id lowercase; version CalVer YYYY.MM[.N]
const GATE_SUITE_RE =
  /^Gate-suite:[ \t]+(?<suite>[a-z0-9-]+)@(?<version>\d{4}\.\d{2}(?:\.\d{1,2})?)[ \t]*$/;

// Accountable: <full-name> <<email>> (@<login>)
const ACCOUNTABLE_RE =
  /^Accountable:[ \t]+(?<name>\S[^<>\n]{0,127}?)[ \t]+<(?<email>[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>[ \t]+\(@(?<login>[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})\)[ \t]*$/;

const CORRECTION_RE = /^Correction-for:[ \t]+(?<sha>[0-9a-fA-F]{40})[ \t]*$/;

// Lines we own (any malformed instance of one of these keys is an error, not an
// "unknown trailer"). Unknown keys (ticket refs etc.) are ignored, not errors.
const OWNED_KEY_RE = /^(Assisted-by|Reviewed-by|Gate-suite|Accountable|Correction-for):/;

/**
 * Parse a commit message into a structured trailer-block analysis.
 *
 * Returns { errors, assisted, reviewed, gateSuite, accountable, correctionFor }.
 * `errors` is a list of grammar/structural violations (spec §1 strict parsing).
 * This is PURE — no git, no fs, no network — so every §1 rule is unit-testable.
 *
 * Note: per spec §1, extraction = `git interpret-trailers --parse` semantics on
 * the FINAL trailer block. We extract the trailing run of trailer-shaped lines
 * (the last paragraph that is all `Key: value` / continuation-free lines), which
 * matches interpret-trailers' trailer-block detection for our flat keys.
 */
export function parseTrailers(message) {
  const errors = [];
  const src = String(message);
  // §1 strict: LF line endings. A bare CR (or CRLF) in the message is a grammar
  // violation, not silently normalized — the record must be exactly as the spec
  // prescribes. We still split on \n after flagging so the rest can be analyzed.
  if (/\r/.test(src)) errors.push(`record uses non-LF line endings (CR present) — §1 requires LF`);
  const allLines = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  // Identify the trailing trailer block: the final contiguous run of non-blank
  // lines at the end of the message. interpret-trailers treats the last
  // paragraph as the trailer block ONLY when its lines are all trailer-shaped;
  // a non-trailer line in that final paragraph means there is NO valid trailer
  // block (a record cannot hide behind prose in the final paragraph).
  let end = allLines.length;
  while (end > 0 && allLines[end - 1].trim() === "") end--;
  let start = end;
  while (start > 0 && allLines[start - 1].trim() !== "") start--;
  const block = allLines.slice(start, end);

  const assisted = []; // { name, model, isNone, raw }
  const reviewed = []; // { name, email, login, tier, raw }
  let gateSuite = null; // { suite, version, raw } | null
  let accountable = null; // { name, email, login, raw } | null
  let correctionFor = null; // sha | null
  let gateSuiteCount = 0;
  let accountableCount = 0;
  let correctionCount = 0;
  let noneCount = 0;
  let sawNone = false;
  let sawNamedAssisted = false;

  // A trailer-block line that is neither an owned trailer nor a well-formed
  // unknown `Key: value` trailer means the final paragraph is NOT a trailer
  // block (interpret-trailers semantics). Track them so we can fail the record.
  // git interpret-trailers' own heuristic: a line is "trailer-shaped" if it
  // matches `^<token>: ` where token has no whitespace. Real trailer keys use
  // hyphen/underscore/dot (e.g. `Signed-off-by`, `X.Ref`, `co_author`), so the
  // token class allows them — false-rejecting a legitimate unknown trailer
  // would wrongly invalidate an otherwise-good record.
  const UNKNOWN_TRAILER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*:[ \t]/;

  for (const raw of block) {
    // Control chars / continuation lines are invalid in the trailer block.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) {
      errors.push(`control character in trailer line: ${JSON.stringify(raw)}`);
      continue;
    }
    if (/^[ \t]/.test(raw)) {
      // A leading-whitespace line is a folded continuation — forbidden (§1: no
      // continuation lines) IF it falls inside the trailer block.
      errors.push(`continuation/folded line not allowed in trailer block: ${JSON.stringify(raw)}`);
      continue;
    }

    let m;
    if ((m = raw.match(ASSISTED_RE))) {
      if (m[1] === "none" || /^none$/i.test(m[1].trim())) {
        // "none" is reserved: must be the ONLY Assisted-by line, exact casing.
        if (m[1] !== "none") {
          errors.push(`Assisted-by "none" must be lowercase exactly: ${JSON.stringify(raw)}`);
        }
        sawNone = true;
        noneCount++;
        assisted.push({ name: null, model: null, isNone: true, raw });
      } else {
        sawNamedAssisted = true;
        const name = m.groups.name.trim();
        if (/^none$/i.test(name)) {
          errors.push(`"none" is a reserved Assisted-by value and forbidden as a display-name`);
        }
        assisted.push({ name, model: m.groups.model || null, isNone: false, raw });
      }
      continue;
    }
    if ((m = raw.match(REVIEWED_RE))) {
      reviewed.push({
        name: m.groups.name.trim(),
        email: m.groups.email,
        login: m.groups.login,
        tier: m.groups.tier,
        raw,
      });
      continue;
    }
    if ((m = raw.match(GATE_SUITE_RE))) {
      gateSuiteCount++;
      gateSuite = { suite: m.groups.suite, version: m.groups.version, raw };
      continue;
    }
    if ((m = raw.match(ACCOUNTABLE_RE))) {
      accountableCount++;
      accountable = { name: m.groups.name.trim(), email: m.groups.email, login: m.groups.login, raw };
      continue;
    }
    if ((m = raw.match(CORRECTION_RE))) {
      correctionCount++;
      correctionFor = m.groups.sha.toLowerCase();
      continue;
    }
    // A line that uses an OWNED key but did not match its strict grammar is an
    // error (malformed owned trailer), not an ignorable unknown trailer.
    if (OWNED_KEY_RE.test(raw)) {
      errors.push(`malformed ${raw.split(":")[0]} trailer: ${JSON.stringify(raw)}`);
      continue;
    }
    // Unknown trailer keys (e.g. ticket refs) are ignored, not errors (§1) —
    // BUT only when the line is actually trailer-shaped. A non-trailer line in
    // the final paragraph means there is no valid trailer block at all.
    if (!UNKNOWN_TRAILER_RE.test(raw)) {
      errors.push(`non-trailer line in the final trailer block (a record cannot hide behind prose): ${JSON.stringify(raw)}`);
    }
    // else: a well-formed unknown trailer — ignored, not an error (§1).
  }

  // §1 structural rules.
  if (sawNone && sawNamedAssisted) {
    errors.push(`Assisted-by: none must be the ONLY Assisted-by line — cannot mix "none" with assistants`);
  }
  if (noneCount > 1) {
    errors.push(`Assisted-by: none must appear at most once (it is the ONLY Assisted-by line for human-only changes)`);
  }
  if (assisted.length === 0) {
    errors.push(`missing Assisted-by — mandatory on every merge ("Assisted-by: none" for human-only changes)`);
  }
  if (gateSuiteCount > 1) errors.push(`duplicate Gate-suite trailer (only one allowed)`);
  if (accountableCount > 1) errors.push(`duplicate Accountable trailer (only one allowed)`);
  if (correctionCount > 1) errors.push(`duplicate Correction-for trailer (only one allowed)`);
  // Gate arm: Gate-suite and Accountable must both appear, and Accountable must
  // immediately follow Gate-suite.
  if (gateSuite && !accountable) errors.push(`Gate-suite present without Accountable (gate arm requires both)`);
  if (accountable && !gateSuite) errors.push(`Accountable present without Gate-suite (gate arm requires both)`);
  if (gateSuite && accountable) {
    const gi = block.indexOf(gateSuite.raw);
    const ai = block.indexOf(accountable.raw);
    if (ai !== gi + 1) errors.push(`Accountable must immediately follow Gate-suite`);
  }

  return {
    errors,
    assisted,
    reviewed,
    gateSuite,
    accountable,
    correctionFor,
    hasHumanArm: reviewed.length > 0,
    hasGateArm: Boolean(gateSuite && accountable),
  };
}

/**
 * Classify the verification arm of a parsed trailer block per §1.
 *   human-arm [ gate-arm ] / gate-arm  — at least one arm must be present.
 * If both appear, the human arm is the verification of record AND the gate
 * claims must also verify true (never a way to weaken). Returns the list of
 * arm-presence errors (no arm at all is the only structural error here).
 */
export function classifyArm(parsed) {
  const errors = [];
  if (!parsed.hasHumanArm && !parsed.hasGateArm) {
    errors.push(`no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)`);
  }
  return { errors, hasHumanArm: parsed.hasHumanArm, hasGateArm: parsed.hasGateArm };
}

/**
 * §1 squash aggregation: the union of per-commit Assisted-by lines, deduped on
 * (display-name, model-id), in first-appearance order. "none" collapses to a
 * single line and is dropped if any named assistant is present (a squash that
 * mixes human-only commits with agent commits is agent-assisted overall).
 * Input: array of commit messages (branch commits). Output: array of canonical
 * "Assisted-by: ..." lines for the squash record.
 */
export function aggregateAssisted(messages) {
  const seen = new Set();
  const lines = [];
  let sawNamed = false;
  let sawNone = false;
  for (const msg of messages) {
    const p = parseTrailers(msg);
    for (const a of p.assisted) {
      if (a.isNone) { sawNone = true; continue; }
      const key = `${a.name} ${a.model || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sawNamed = true;
      lines.push(a.model ? `Assisted-by: ${a.name} (${a.model})` : `Assisted-by: ${a.name}`);
    }
  }
  if (!sawNamed && sawNone) return ["Assisted-by: none"];
  return lines;
}

// ===========================================================================
// §3 — High-risk classification (fail-closed, mechanical, config-driven)
//
// Normative source is machine config ONLY: cinatra-ai/ci/config/
// high-risk-defaults.json (exact globs) plus the repo's .github/gate-suite.json
// highRiskPaths, which may EXTEND but never remove defaults (gate verifies the
// effective set is a superset of defaults). Parse failure of either config =>
// the entire change is treated high-risk (fail closed).
// ===========================================================================

/**
 * Compile a minimatch-style glob to a RegExp. Supports: `**` (any path
 * segments incl. /), `*` (any chars except /), `?` (one char except /), and
 * literal segments. Anchored full-path match. Documented in the config schema.
 */
export function globToRegExp(glob) {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` — any number of path segments (incl. zero) and the following slash.
        i += 2;
        if (glob[i] === "/") { re += "(?:.*/)?"; i++; }
        else re += ".*";
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") { re += "[^/]"; i++; continue; }
    if ("\\^$.|+()[]{}".includes(c)) { re += "\\" + c; i++; continue; }
    re += c;
    i++;
  }
  return new RegExp("^" + re + "$");
}

/**
 * Load a JSON config; on ANY failure return { ok:false } so the caller can fail
 * closed (treat as high-risk). Never throws — fail-closed is the contract.
 */
export function loadJsonSafe(p) {
  if (!p) return { ok: false, reason: "no path" };
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch (e) { return { ok: false, reason: `unreadable: ${e.message}` }; }
  try { return { ok: true, value: JSON.parse(raw) }; } catch (e) { return { ok: false, reason: `invalid JSON: ${e.message}` }; }
}

/**
 * Compute the effective high-risk glob set and whether the change is high-risk.
 *
 * @param changedFiles list of paths (both old+new for renames; §3 mechanics)
 * @param defaults     { ok, value:{ highRiskGlobs:[...] } } from high-risk-defaults.json
 * @param repoSuite    { ok, value:{ highRiskPaths:[...] } } from .github/gate-suite.json (optional)
 *
 * Fail-closed rules (§3):
 *  - defaults parse failure => high-risk (and a hardError).
 *  - repoSuite present but parse failure => high-risk.
 *  - repoSuite highRiskPaths NOT a superset of defaults => high-risk + error
 *    (a repo may extend, never remove defaults).
 */
export function classifyHighRisk(changedFiles, defaults, repoSuite) {
  const errors = [];
  if (!defaults || !defaults.ok || !Array.isArray(defaults.value?.highRiskGlobs)) {
    errors.push(`high-risk-defaults config unparseable (${defaults?.reason || "missing highRiskGlobs"}) — failing CLOSED, treating change as high-risk`);
    return { highRisk: true, errors, effectiveGlobs: [], matched: [], failClosed: true };
  }
  const defaultGlobs = defaults.value.highRiskGlobs.map(String);

  let repoGlobs = [];
  if (repoSuite && repoSuite.ok) {
    const hr = repoSuite.value?.highRiskPaths;
    if (hr !== undefined) {
      if (!Array.isArray(hr)) {
        errors.push(`gate-suite.json highRiskPaths is not an array — failing CLOSED`);
        return { highRisk: true, errors, effectiveGlobs: defaultGlobs, matched: [], failClosed: true };
      }
      repoGlobs = hr.map(String);
      // Superset check: every default must be present in the repo set (extend-only).
      const repoSet = new Set(repoGlobs);
      const missing = defaultGlobs.filter((g) => !repoSet.has(g));
      if (missing.length) {
        errors.push(`gate-suite.json highRiskPaths must be a SUPERSET of central defaults; missing: ${missing.join(", ")} — failing CLOSED`);
        return { highRisk: true, errors, effectiveGlobs: defaultGlobs, matched: [], failClosed: true };
      }
    }
  } else if (repoSuite && !repoSuite.ok) {
    errors.push(`gate-suite.json present but unparseable (${repoSuite.reason}) — failing CLOSED`);
    return { highRisk: true, errors, effectiveGlobs: defaultGlobs, matched: [], failClosed: true };
  }

  const effectiveGlobs = [...new Set([...defaultGlobs, ...repoGlobs])];
  const compiled = effectiveGlobs.map((g) => ({ glob: g, re: globToRegExp(g) }));
  const matched = [];
  for (const f of changedFiles) {
    for (const { glob, re } of compiled) {
      if (re.test(f)) { matched.push({ file: f, glob }); break; }
    }
  }
  return { highRisk: matched.length > 0, errors, effectiveGlobs, matched, failClosed: false };
}

// ===========================================================================
// git plumbing — changed files + commit messages (PR range / first-parent)
// ===========================================================================

function verifyGitRef(ref, cwd = process.cwd()) {
  execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", ref], { stdio: "ignore", cwd });
}

export function resolveDiffBase({ explicit, envVarName } = {}, cwd = process.cwd()) {
  if (explicit) { verifyGitRef(explicit, cwd); return explicit; }
  if (envVarName && Object.prototype.hasOwnProperty.call(process.env, envVarName)) {
    const v = process.env[envVarName];
    if (!v) return null;
    try { verifyGitRef(v, cwd); return v; }
    catch { throw new Error(`${envVarName}='${v}' does not resolve to a git ref. Check CI fetch-depth and the base ref name.`); }
  }
  for (const c of ["origin/main", "main"]) { try { verifyGitRef(c, cwd); return c; } catch { /* next */ } }
  return null;
}

/**
 * Changed-file set for §3 mechanics: includes added/modified/deleted/renamed
 * files, matching BOTH old and new paths for renames. Pre-merge = base...HEAD;
 * post-merge = first-parent diff of the given commit.
 */
export function changedFilesForRange(base, cwd = process.cwd()) {
  const args = base
    ? ["diff", "--name-status", "-z", "-M", "-C", "--end-of-options", `${base}...HEAD`]
    : ["ls-files", "-z"];
  let out;
  try {
    out = execFileSync("git", ["--literal-pathspecs", ...args], { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    throw new Error(`git diff ${base}...HEAD failed: ${e.message}. Cannot compute the changed-file set; fix fetch-depth/base.`);
  }
  if (!base) return out.split("\0").map((s) => s.trim()).filter(Boolean);
  return parseNameStatusZ(out);
}

/**
 * Changed files for a post-merge commit (first-parent diff: commit^..commit,
 * i.e. what the squash introduced relative to the base it landed on).
 */
export function changedFilesForCommit(commit, cwd = process.cwd()) {
  let out;
  try {
    out = execFileSync(
      "git",
      ["--literal-pathspecs", "diff", "--name-status", "-z", "-M", "-C", "--end-of-options", `${commit}^!`],
      { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (e) {
    throw new Error(`git diff ${commit}^! failed: ${e.message}`);
  }
  return parseNameStatusZ(out);
}

/** Parse `git diff --name-status -z` output into a path list (old+new for renames). */
export function parseNameStatusZ(out) {
  const parts = out.split("\0");
  const paths = new Set();
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (!status) { i += 1; continue; }
    if (status.startsWith("R") || status.startsWith("C")) {
      if (parts[i + 1]) paths.add(parts[i + 1]); // old path
      if (parts[i + 2]) paths.add(parts[i + 2]); // new path
      i += 3;
    } else {
      if (parts[i + 1]) paths.add(parts[i + 1]);
      i += 2;
    }
  }
  return [...paths];
}

// `--no-merges`: the pre-merge arm runs on the GitHub-generated PR merge ref
// (refs/pull/N/merge), so HEAD is a synthetic 2-parent merge commit that GitHub
// authors as the acting App/actor identity (cinatra-agent-bot[bot]) with no
// trailers. That commit is integration machinery, not authored branch content —
// it must NOT be subjected to check 5 (`agent-commit-no-assisted`), or every
// enforce PR from the dedicated agent identity would self-trip on its own merge
// ref now that the bot is a recognized agent (eng#119 §5). Check 5 cares about
// the real branch commits' attribution; merge commits carry no authored change.
/** Commit messages (full %B) for the PR range base..HEAD, newest-first. */
export function rangeCommitMessages(base, cwd = process.cwd()) {
  if (!base) return [];
  let out;
  try {
    out = execFileSync(
      "git",
      ["--literal-pathspecs", "log", "--no-merges", "--format=%B%x00", "--end-of-options", `${base}..HEAD`],
      { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch { return []; }
  return out.split("\0").map((s) => s.replace(/^\n+|\n+$/g, "")).filter(Boolean);
}

/** Author/committer identity (name + email + login-ish) for each range commit. */
export function rangeCommitIdentities(base, cwd = process.cwd()) {
  if (!base) return [];
  let out;
  try {
    out = execFileSync(
      "git",
      ["--literal-pathspecs", "log", "--no-merges", "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x00", "--end-of-options", `${base}..HEAD`],
      { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch { return []; }
  return out.split("\0").map((r) => r.replace(/^\n+/, "")).filter(Boolean).map((rec) => {
    const [sha, an, ae, cn, ce] = rec.split("\x1f");
    return { sha, authorName: an, authorEmail: ae, committerName: cn, committerEmail: ce };
  });
}

/** Full commit message for a single commit (post-merge arm). */
export function commitMessage(commit, cwd = process.cwd()) {
  return execFileSync("git", ["--literal-pathspecs", "log", "-1", "--format=%B", "--end-of-options", commit], {
    encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Read a file's contents at a git ref as a loadJsonSafe-shaped result. Used by
 * the §4 version-bump rule to obtain the PARENT gate-suite.json (the suite as it
 * stood on the base the PR's changed-file range was computed against — NOT a
 * remote registry, so no TOCTOU).
 *
 * It DISTINGUISHES (codex round-2 HIGH — must not collapse to "absent" and fail
 * open):
 *  - genuine absence: the ref resolves but the path is not in its tree (a NEW
 *    suite on this PR) => { ok:false, reason:"absent-at-ref", absent:true }.
 *    The bump rule treats this as vacuously satisfied (nothing to bump against).
 *  - operational failure: the ref does not resolve (base not fetched / bad ref),
 *    or the blob is not valid JSON => { ok:false, reason, operational:true }.
 *    The bump rule must FAIL CLOSED on these, never pass.
 * Never throws.
 */
export function jsonFileAtRef(ref, filePath, cwd = process.cwd()) {
  if (!ref) return { ok: false, reason: "no ref", operational: true };
  // 1. Does the ref resolve at all? An unresolvable ref is operational, not absence.
  try {
    execFileSync("git", ["--literal-pathspecs", "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { stdio: "ignore", cwd });
  } catch { return { ok: false, reason: `base ref '${ref}' does not resolve (not fetched?) — cannot read the parent suite`, operational: true }; }
  // 2. Is the path present in that ref's tree? If not, it is genuinely a NEW file.
  try {
    execFileSync("git", ["--literal-pathspecs", "cat-file", "-e", "--end-of-options", `${ref}:${filePath}`], { stdio: "ignore", cwd });
  } catch { return { ok: false, reason: "absent-at-ref", absent: true }; }
  // 3. Read + parse. A present-but-unparseable parent is operational (fail closed).
  let raw;
  try {
    raw = execFileSync("git", ["--literal-pathspecs", "show", "--end-of-options", `${ref}:${filePath}`], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) { return { ok: false, reason: `could not read ${filePath} at ${ref}: ${e.message}`, operational: true }; }
  try { return { ok: true, value: JSON.parse(raw) }; } catch (e) { return { ok: false, reason: `invalid JSON at ${ref}: ${e.message}`, operational: true }; }
}

/** tree object id of a commit (for the tree-identity bridge, §5). */
export function treeOf(commitish, cwd = process.cwd()) {
  try {
    return execFileSync("git", ["--literal-pathspecs", "rev-parse", "--end-of-options", `${commitish}^{tree}`], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return null; }
}

// ===========================================================================
// §5 — Known-agent identity (check 5)
//
// AI-vendor tokens are public; INTERNAL agent codenames stay in private per-repo
// config (inherited from #116). The denylist is name/email substring tokens; an
// allowlist of non-AI bots prevents dependabot/renovate/github-actions from
// being treated as agents.
// ===========================================================================

export const DEFAULT_AGENT_NAME_TOKENS = [
  "claude", "anthropic", "copilot", "cursor", "devin", "gemini",
  "gpt", "codex", "openai", "ossgtm",
  // The org's dedicated agent identity that authors all agent-opened PRs
  // (cinatra-agent-bot[bot], App 4040322; eng#119 §5/§8.5, eng#137). Its
  // name/email contain none of the vendor tokens above, so without this the
  // gate's check 5 would NOT recognize the exact identity that authors every
  // agent PR — an Assisted-by omission on a bot-authored commit would slip
  // past. The bot login is PUBLIC (visible on every PR it opens), the same
  // category as dependabot/renovate, so it belongs in the public source
  // default (not private internalAgentTokens, which is for internal codenames
  // that must not appear in public source). The substring "cinatra-agent"
  // matches the current bot AND any future cinatra-agent-* identity while
  // being specific enough not to false-positive on humans, and covers all org
  // repos automatically during the §7 step 6 rollout (no per-repo config).
  "cinatra-agent",
];
export const DEFAULT_NONAI_BOT_ALLOW = [
  "dependabot[bot]", "renovate[bot]", "github-actions[bot]",
  "dependabot", "renovate",
];

/**
 * Does an identity (name or email) look like a known AI agent? Allowlisted
 * non-AI bots never qualify. `extraTokens` carries internal codenames from
 * private per-repo config (never in the public default).
 */
export function looksLikeAgent({ name, email }, { tokens = DEFAULT_AGENT_NAME_TOKENS, allow = DEFAULT_NONAI_BOT_ALLOW } = {}) {
  const n = (name || "").toLowerCase();
  const e = (email || "").toLowerCase();
  for (const a of allow) {
    const al = a.toLowerCase();
    if (n === al || e === al || n.includes(al)) return false;
  }
  for (const t of tokens) {
    const tl = t.toLowerCase();
    if (n.includes(tl) || e.includes(tl)) return true;
  }
  return false;
}

// ===========================================================================
// GitHub API client (injectable; default uses `gh api`). Anti-fabrication
// (§5 checks 2 & 3) needs: PR reviews, the actor's repo permission, and the
// check-runs for a head SHA. All network access funnels through this object so
// the analysis core is unit-testable offline with a stub.
// ===========================================================================

export function makeGhClient({ repo } = {}) {
  // shape: "array"  -> endpoint returns a JSON array (e.g. /reviews); with
  //                    --paginate, gh concatenates one array per page.
  //        "object" -> endpoint returns a JSON object whose payload lives under
  //                    a named field (e.g. /check-runs -> { check_runs: [...] });
  //                    with --paginate, gh concatenates one object per page and
  //                    we must merge that field across pages.
  function ghApi(endpoint, { shape = "object", arrayField = null } = {}) {
    const args = ["api"];
    if (shape === "array" || arrayField) args.push("--paginate");
    args.push("-H", "Accept: application/vnd.github+json", endpoint);
    const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (shape === "array") {
      // One JSON array per page; concatenated. Split on a newline that begins a
      // new top-level array and flatten.
      const docs = out.split(/\n(?=\[)/).map((s) => s.trim()).filter(Boolean).map((s) => JSON.parse(s));
      return docs.flat();
    }
    if (arrayField) {
      // One JSON OBJECT per page; concatenated. Merge the named array field.
      const docs = out.split(/\n(?=\{)/).map((s) => s.trim()).filter(Boolean).map((s) => JSON.parse(s));
      const merged = [];
      for (const d of docs) for (const x of (d[arrayField] || [])) merged.push(x);
      return merged;
    }
    return JSON.parse(out);
  }
  return {
    repo,
    listReviews(pr) { return ghApi(`/repos/${repo}/pulls/${pr}/reviews`, { shape: "array" }); },
    permissionOf(login) { return ghApi(`/repos/${repo}/collaborators/${login}/permission`); },
    // /check-runs returns { total_count, check_runs:[...] }; merge check_runs
    // across pages so callers ALWAYS receive a flat array of run objects.
    // `filter=all`: the API default is `filter=latest`, which returns only the
    // single latest check-run per NAME (by completed_at) — that would let the
    // server hide a newer queued/in-progress/unverifiable rerun BEFORE the gate's
    // own freshness logic ever sees it, so an older success could rescue a
    // context that has an in-flight rerun (codex-converge round 2 HIGH). We pull
    // ALL runs and do the freshness/identity selection ourselves, fail-closed.
    checkRunsFor(sha) { return ghApi(`/repos/${repo}/commits/${sha}/check-runs?filter=all`, { arrayField: "check_runs" }); },
    pr(pr) { return ghApi(`/repos/${repo}/pulls/${pr}`); },
    // GET /actions/runs/{run_id} — the Actions workflow RUN behind a check-run.
    // Used by the §5 check-3 workflow-identity resolution: a reusable-workflow
    // check-run's html_url/details_url carries no workflow path, so we resolve
    // the run id to its run and read `referenced_workflows[]` (each entry's
    // `path` = "<owner>/<repo>/.github/workflows/<file>@<ref>", `sha` = the
    // resolved commit) plus the binding fields (`head_sha`, `check_suite_id`)
    // that prove the run produced THIS check-run on THIS reviewed head.
    //
    // Also reads the LATEST-ATTEMPT job set (GET /actions/runs/{id}/jobs, default
    // filter=latest = the most recent execution). The job `id` EQUALS the
    // check-run `id` (a github-actions check-run's url is .../runs/<run>/job/<job>
    // and that job id == check_run.id). This is the AUTHORITATIVE discriminator
    // between "a later run-ATTEMPT of a job" (supersedes earlier attempts) and a
    // "concurrent decoy sibling job in the SAME attempt" (must all pass): on a
    // "Re-run failed jobs", `filter=all` check-runs return BOTH the stale
    // attempt-1 (failure) and attempt-2 (success) under one run_id; restricting
    // candidates to the LATEST attempt's job ids drops the stale failure (closing
    // the false-negative that re-created human-approval-on-every-merge) while a
    // genuine concurrent decoy — which lives in the SAME latest attempt — stays
    // in the set and is still required to pass. This holds regardless of whether
    // a re-run mints a new check_suite per attempt (undocumented) or updates the
    // check-run in place. The jobs list is PAGINATED (arrayField) so a failed
    // current job on a later page can never be silently omitted, then excluded as
    // "stale", and a same-name success rescued (codex-converge HIGH).
    //
    // CRITICAL: the run id is the only thing taken from the (App-controllable)
    // check-run URL; the GET is bound to THIS gate's `repo` (never an owner/repo
    // parsed from the URL), so a foreign run id simply 404s -> fail closed.
    // Requires `actions: read` on the workflow token. Returns a narrow,
    // resolver-shaped object; null on any failure (run OR jobs fetch) so the
    // caller fails CLOSED.
    workflowRun(runId) {
      let data;
      try { data = ghApi(`/repos/${repo}/actions/runs/${encodeURIComponent(runId)}`); }
      catch { return null; }
      if (!data || typeof data !== "object") return null;
      let jobs;
      try { jobs = ghApi(`/repos/${repo}/actions/runs/${encodeURIComponent(runId)}/jobs`, { arrayField: "jobs" }); }
      catch { return null; }
      if (!Array.isArray(jobs)) return null;
      const latestAttemptJobIds = new Set(jobs.map((j) => String(j.id)));
      return {
        headSha: data.head_sha || null,
        checkSuiteId: data.check_suite_id ?? null,
        referencedWorkflows: Array.isArray(data.referenced_workflows) ? data.referenced_workflows : null,
        runAttempt: data.run_attempt ?? null,
        path: typeof data.path === "string" ? data.path : null,
        event: typeof data.event === "string" ? data.event : null,
        workflowId: data.workflow_id ?? null,
        // The run's OVERALL status/conclusion (latest attempt aggregate). A run is
        // conclusion=success ONLY if EVERY job (incl. the genuine reusable job)
        // succeeded — so re-running ONLY a same-name LOCAL DECOY job while the
        // genuine reusable job stays failed leaves conclusion != success. This is
        // the authoritative all-jobs-passed gate that the latest-attempt job-id
        // restriction alone cannot provide (referenced_workflows is run-level, so a
        // surviving decoy would otherwise inherit the pin) — codex-converge HIGH.
        status: typeof data.status === "string" ? data.status : null,
        conclusion: typeof data.conclusion === "string" ? data.conclusion : null,
        latestAttemptJobIds,
      };
    },
    // The PR's source commits (the real branch range a squash collapsed) — the
    // authoritative input for check 5 on a squash merge, where the merge
    // commit's own first-parent diff is NOT the branch commits.
    prCommits(pr) { return ghApi(`/repos/${repo}/pulls/${pr}/commits`, { shape: "array" }); },
  };
}

/** Map a GitHub repo-permission ("admin"/"maintain"/"write"/"read") to a tier. */
export function permissionMeetsTier(permission, tier) {
  // maintainer tier requires admin/maintain; peer requires write (or higher).
  const order = { read: 0, triage: 1, write: 2, maintain: 3, admin: 4 };
  const have = order[permission] ?? -1;
  if (tier === "maintainer") return have >= order.maintain;
  if (tier === "peer") return have >= order.write;
  return false;
}

/**
 * §5 check 2 — verify ONE Reviewed-by line against the real PR approvals.
 * Pure given the API data (reviews list, the reviewer's permission, PR author,
 * reviewedHeadSha). Returns { ok, reasons:[...] }.
 *
 * Latest-review semantics (exact, §5): from GET /pulls/{n}/reviews, the login's
 * review with the greatest submitted_at; DISMISSED approvals do not count; that
 * latest review must be APPROVED with commit_id == reviewedHeadSha.
 */
export function verifyReviewedLine(line, { reviews, permission, prAuthorLogin, reviewedHeadSha }) {
  const reasons = [];
  const login = line.login;
  if (prAuthorLogin && login.toLowerCase() === prAuthorLogin.toLowerCase()) {
    reasons.push(`self-approval: @${login} is the PR author (a named human cannot review their own change)`);
  }
  const mine = reviews
    .filter((r) => (r.user?.login || "").toLowerCase() === login.toLowerCase() && r.state !== "DISMISSED")
    .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
  const latest = mine[mine.length - 1];
  if (!latest) {
    reasons.push(`no non-dismissed review by @${login} on this PR`);
  } else if (latest.state !== "APPROVED") {
    reasons.push(`@${login}'s latest review is ${latest.state}, not APPROVED`);
  } else if (reviewedHeadSha && latest.commit_id !== reviewedHeadSha) {
    reasons.push(`@${login}'s approval is STALE (approved ${String(latest.commit_id).slice(0, 8)}, head is ${String(reviewedHeadSha).slice(0, 8)} — re-approval required)`);
  }
  if (!permissionMeetsTier(permission, line.tier)) {
    reasons.push(`@${login} repo permission '${permission || "none"}' does not meet claimed tier=${line.tier}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * §5 check 3 — verify the gate arm against the committed gate-suite.json and the
 * actual check-runs on reviewedHeadSha. Pure given the API data.
 *
 * @param parsed.gateSuite   { suite, version }
 * @param parsed.accountable { login, name, email }
 * @param suiteFile          parsed .github/gate-suite.json at the merged SHA
 * @param checkRuns          array of check-run objects for reviewedHeadSha
 * @param now                injectable epoch-ms "current time" (default Date.now()),
 *                           so the §4 staleness window is deterministic in tests.
 *
 * Returns { ok, reasons, warnings }. `warnings` carries the §4 35-day staleness
 * NOTICE — a gate-arm merge with a 35–65-day-old audit is still verifiable (ok),
 * but the audit is going stale and the engineer is being told. `reasons` carries
 * hard gate-arm failures (incl. the §4 65-day lapse and a missing audit record).
 * Staleness applies to the GATE ARM ONLY: a lapsed audit stops machine
 * verification, never a human-arm merge (the human arm doesn't call this).
 */
export const AUDIT_STALE_WARN_DAYS = 35;
export const AUDIT_STALE_FAIL_DAYS = 65;
const DAY_MS = 24 * 60 * 60 * 1000;

export function verifyGateArm(parsed, { suiteFile, checkRuns, now = Date.now(), reviewedHeadSha = null, runWorkflow = null }) {
  const reasons = [];
  const warnings = [];
  if (!suiteFile || !suiteFile.ok) {
    reasons.push(`cannot read .github/gate-suite.json at the merged SHA (${suiteFile?.reason || "missing"}) — gate arm cannot be verified`);
    return { ok: false, reasons, warnings };
  }
  const suite = suiteFile.value;
  if (parsed.gateSuite.suite !== suite.suiteId || parsed.gateSuite.version !== suite.version) {
    reasons.push(`Gate-suite trailer '${parsed.gateSuite.suite}@${parsed.gateSuite.version}' != committed suite '${suite.suiteId}@${suite.version}'`);
  }
  // Accountable trailer must match the file's accountable on ALL of login, name,
  // and email — a matching login with a forged name/email is still a fabricated
  // record (§5 check3: "Accountable trailer != the file's accountable"). The
  // suite MUST declare all three fields; a suite that omits name/email cannot
  // accept a free-text name/email (fail closed — the comparison is meaningless
  // otherwise, which is exactly the gap a forger would exploit).
  const acc = suite.accountable || {};
  if (acc.github === undefined || acc.name === undefined || acc.email === undefined) {
    reasons.push(`gate-suite.json accountable is incomplete (needs github + name + email) — cannot verify the Accountable trailer (fail closed)`);
    return { ok: false, reasons, warnings };
  }
  if (parsed.accountable.login !== acc.github) {
    reasons.push(`Accountable @${parsed.accountable.login} != gate-suite.json accountable @${acc.github}`);
  }
  if (parsed.accountable.name !== acc.name) {
    reasons.push(`Accountable name '${parsed.accountable.name}' != gate-suite.json accountable name '${acc.name}'`);
  }
  if (parsed.accountable.email !== acc.email) {
    reasons.push(`Accountable email '${parsed.accountable.email}' != gate-suite.json accountable email '${acc.email}'`);
  }
  // requiredContexts MUST be a non-empty array — a suite file with matching
  // id/version/accountable but no required contexts cannot bless a merge (fail
  // closed: an empty suite is not "machine verification").
  if (!Array.isArray(suite.requiredContexts) || suite.requiredContexts.length === 0) {
    reasons.push(`gate-suite.json declares no requiredContexts — an empty gate suite is not machine verification (fail closed)`);
    return { ok: false, reasons, warnings };
  }
  // Required-context resolution. A context NAME alone is spoofable (any check
  // run can claim that display name), so when the suite pins an app/workflow
  // identity we verify it too. Two-stage, fail-closed:
  //
  //  1. CANDIDACY (`runIsCandidate`) — the "claims this context" envelope that
  //     drives freshness selection. Name must equal ctx.context; if appSlug is
  //     pinned the run's app.slug must match; if a WORKFLOW is pinned the run
  //     MUST be a github-actions check-run (a reusable-workflow context is only
  //     ever produced by the github-actions app — a third-party App's check-run
  //     with the same display name is NOT this context). These are check-run-
  //     LOCAL properties (no network), so excluding a non-candidate can never
  //     mask a real run (codex-converge: candidacy must not be a fail-open).
  //
  //  2. VERIFICATION (`verifyWorkflowIdentity`) — for a workflow-pinned context,
  //     the freshest candidate must additionally PROVE its identity by resolving
  //     the Actions RUN behind the check-run and confirming, fail-closed, that
  //     (a) a run id is extractable from the check-run url, (b) the run resolves
  //     via the gate-repo-bound resolver, (c) the run's head_sha is the reviewed
  //     head, (d) the run's check_suite_id equals THIS check-run's check_suite.id
  //     (binds the App-controllable url to the real Actions run — a forged
  //     check-run cannot make its check_suite.id equal the github-actions run's),
  //     and (e) some referenced_workflows entry is EXACTLY ctx.workflow@ctx.pinned
  //     with sha === ctx.pinned. This is STRICTLY STRONGER than the old html_url
  //     substring match (which verified nothing about the pinned commit). A
  //     verification failure on the freshest run FAILS the context — it is never
  //     dropped in favour of an older success (closes the candidate-ordering
  //     fail-open, codex-converge round 1 finding 5/G).
  const PINNED_RE = /^[0-9a-fA-F]{40}$/;
  function runIsCandidate(run, ctx) {
    if (run.name !== ctx.context) return false;
    if (ctx.appSlug && (run.app?.slug || "") !== ctx.appSlug) return false;
    // A workflow-pinned context is produced by the github-actions app only.
    if (ctx.workflow && (run.app?.slug || "") !== "github-actions") return false;
    return true;
  }
  // Extract the numeric Actions run id from a check-run url. Only the run id is
  // taken from the (App-supplied) url; the resolver re-binds the GET to the gate
  // repo, so the url cannot point the lookup at a foreign repo. Returns null if
  // no /actions/runs/<digits> segment is present (then the context fails closed).
  function extractRunId(run) {
    for (const u of [run.html_url, run.details_url]) {
      const m = String(u || "").match(/\/actions\/runs\/(\d+)(?:[/?#]|$)/);
      if (m) return m[1];
    }
    return null;
  }
  // Verify a workflow-pinned context against the resolved Actions run. Pure given
  // the injected `runWorkflow` resolver. Returns { ok, reason } — fail closed on
  // every gap. `runWorkflow(runId)` must return
  // { headSha, checkSuiteId, referencedWorkflows:[{path,sha},...],
  //   runAttempt, path, event, workflowId, latestAttemptJobIds:Set<string> }
  // or null. (latestAttemptJobIds is consumed by the grouping/attempt-restriction
  // in the per-context loop, not here; here we use headSha/checkSuiteId/
  // referencedWorkflows + the optional caller fields path/event.)
  function verifyWorkflowIdentity(run, ctx) {
    if (!ctx.pinned || !PINNED_RE.test(String(ctx.pinned))) {
      return { ok: false, reason: `required context '${ctx.context}' pins workflow '${ctx.workflow}' but gate-suite.json has no valid 40-hex 'pinned' SHA — cannot verify the workflow commit (fail closed)` };
    }
    if (typeof runWorkflow !== "function") {
      return { ok: false, reason: `required context '${ctx.context}' pins workflow '${ctx.workflow}@${ctx.pinned}' but no workflow-run resolver is available to verify it (fail closed)` };
    }
    const runId = extractRunId(run);
    if (!runId) {
      return { ok: false, reason: `required context '${ctx.context}' check-run has no resolvable Actions run id in its url — cannot verify the pinned workflow '${ctx.workflow}@${ctx.pinned}' (fail closed)` };
    }
    let wr;
    try { wr = runWorkflow(runId); } catch { wr = null; }
    if (!wr) {
      return { ok: false, reason: `required context '${ctx.context}' — could not resolve Actions run ${runId} to verify the pinned workflow '${ctx.workflow}@${ctx.pinned}' (fail closed)` };
    }
    // Bind the resolved run to THIS reviewed head and THIS check-run's suite, so
    // the App-controllable url cannot point at an unrelated but legitimate run.
    // A workflow-pinned context with NO valid reviewed head cannot be bound to a
    // specific commit, so it FAILS CLOSED (codex-converge round 2 HIGH — never
    // pass a workflow context whose head we cannot pin). In production both arms
    // always supply reviewedHeadSha (the PR head); a missing head is degenerate.
    if (!reviewedHeadSha || !/^[0-9a-fA-F]{40}$/.test(String(reviewedHeadSha))) {
      return { ok: false, reason: `required context '${ctx.context}' — no valid reviewed head SHA to bind Actions run ${runId} to; a workflow-pinned context cannot be verified without it (fail closed)` };
    }
    if (String(wr.headSha || "").toLowerCase() !== String(reviewedHeadSha).toLowerCase()) {
      return { ok: false, reason: `required context '${ctx.context}' — resolved Actions run ${runId} is for head ${String(wr.headSha || "?").slice(0, 8)}, not the reviewed head ${String(reviewedHeadSha).slice(0, 8)} (fail closed)` };
    }
    const csId = run.check_suite?.id;
    if (csId === undefined || csId === null || wr.checkSuiteId === null || String(wr.checkSuiteId) !== String(csId)) {
      return { ok: false, reason: `required context '${ctx.context}' — check-run does not belong to resolved Actions run ${runId} (check_suite mismatch) — the run url cannot be trusted to identify the workflow (fail closed)` };
    }
    if (!Array.isArray(wr.referencedWorkflows)) {
      return { ok: false, reason: `required context '${ctx.context}' — Actions run ${runId} exposes no referenced_workflows; cannot confirm the pinned reusable workflow '${ctx.workflow}@${ctx.pinned}' (fail closed)` };
    }
    // The referenced_workflows entry path is "<workflow-path>@<ref>". Split on the
    // FINAL "@" and compare: the workflow PATH portion EXACTLY (case-SENSITIVE —
    // GitHub paths are case-sensitive, so a same-pinned-commit file at a different
    // case must NOT satisfy, codex-converge round 2 MEDIUM), and the ref/sha
    // case-INSENSITIVELY (git hex is case-insensitive). The matched ref must be a
    // full 40-hex equal to ctx.pinned — rejects @branch/@tag/@short-sha refs.
    const pinnedLower = String(ctx.pinned).toLowerCase();
    const matched = wr.referencedWorkflows.some((e) => {
      if (!e || typeof e.path !== "string") return false;
      const at = e.path.lastIndexOf("@");
      if (at <= 0) return false;
      const ePath = e.path.slice(0, at);
      const eRef = e.path.slice(at + 1);
      if (ePath !== ctx.workflow) return false;                       // path EXACT, case-sensitive
      if (eRef.toLowerCase() !== pinnedLower) return false;           // ref == pinned (case-insensitive hex)
      return typeof e.sha === "string" && e.sha.toLowerCase() === pinnedLower; // and the resolved sha agrees
    });
    if (!matched) {
      return { ok: false, reason: `required context '${ctx.context}' — Actions run ${runId} did not reference the pinned reusable workflow '${ctx.workflow}@${ctx.pinned}' (no referenced_workflows entry with that exact path AND sha) (fail closed)` };
    }
    // OPTIONAL CALLER verification (F1, backward-compatible). The referenced_workflows
    // check proves the CALLEE (the pinned reusable workflow ran at the pinned
    // commit) but NOT the CALLER — any workflow run on the reviewed head that
    // referenced the pin satisfies it. If — and only if — the required context
    // DECLARES an expected caller, also verify it, fail closed:
    //   - callerPath: the caller workflow file the run executed (GET
    //     /actions/runs/{id}.path). GitHub returns either a BARE path
    //     ".github/workflows/x.yml" or a "<path>@<ref>" form; we compare the PATH
    //     portion case-sensitively (paths are case-sensitive) and ignore a
    //     trailing @ref (the ref is not part of the caller identity here — the
    //     CALLEE pin already binds the executed reusable-workflow commit).
    //   - allowedEvents: the trigger events the caller may have run under
    //     (GET .../{id}.event), e.g. ["pull_request","push"].
    // A context that OMITS a key (undefined) is unchanged (backward compatible —
    // repos that have not adopted a caller declaration must not start failing).
    // But a key that is PRESENT-but-MALFORMED must FAIL CLOSED, never silently
    // behave like "undeclared" (codex-converge MEDIUM: e.g. `allowedEvents:
    // "pull_request"` (a string, not an array) or `callerPath: []` would
    // otherwise disable the check the engineer intended to add).
    if (ctx.callerPath !== undefined) {
      if (typeof ctx.callerPath !== "string" || ctx.callerPath === "") {
        return { ok: false, reason: `required context '${ctx.context}' declares a malformed 'callerPath' (must be a non-empty string) — failing closed rather than skipping the caller check it was meant to add` };
      }
      const wrPath = typeof wr.path === "string" ? wr.path : "";
      const at = wrPath.lastIndexOf("@");
      const wrPathBare = at > 0 ? wrPath.slice(0, at) : wrPath;
      if (wrPathBare !== ctx.callerPath) {
        return { ok: false, reason: `required context '${ctx.context}' — Actions run ${runId} caller workflow '${wrPathBare || "?"}' != the declared callerPath '${ctx.callerPath}' (fail closed)` };
      }
    }
    if (ctx.allowedEvents !== undefined) {
      if (!Array.isArray(ctx.allowedEvents) || ctx.allowedEvents.length === 0 || !ctx.allowedEvents.every((e) => typeof e === "string" && e !== "")) {
        return { ok: false, reason: `required context '${ctx.context}' declares a malformed 'allowedEvents' (must be a non-empty array of non-empty strings) — failing closed rather than skipping the caller-event check it was meant to add` };
      }
      if (typeof wr.event !== "string" || !ctx.allowedEvents.includes(wr.event)) {
        return { ok: false, reason: `required context '${ctx.context}' — Actions run ${runId} event '${wr.event || "?"}' is not in the declared allowedEvents [${ctx.allowedEvents.join(", ")}] (fail closed)` };
      }
    }
    return { ok: true, reason: null };
  }
  // Latest run per context by the freshest available timestamp. A newer
  // queued/in-progress rerun (which may have only created_at/updated_at, no
  // started_at/completed_at) must NOT be masked by an older success — so the
  // timestamp considers all of started_at/completed_at/updated_at/created_at.
  // Returns -Infinity (NEVER NaN, and NEVER a coerced epoch-0) when no timestamp
  // is usable. Two fail-open traps this closes (F4):
  //   - NaN compares false against everything (NaN > maxTs === false), so a newer
  //     candidate with a MALFORMED timestamp would be silently dropped so an
  //     OLDER success wins; and
  //   - `new Date(field || 0)` coerces an ABSENT/null/empty field to epoch 0
  //     (finite!), so a candidate with ALL timestamp fields missing would order as
  //     1970 — older than any real run — and again be dropped in favour of an
  //     older success (codex-converge HIGH).
  // So we only consider fields that are actually PRESENT and parse to a finite
  // epoch; if NONE do, the candidate is unorderable (-Infinity) and the caller
  // fails the context closed (see runTsUsable).
  function runTs(r) {
    let max = -Infinity;
    for (const f of [r.started_at, r.completed_at, r.updated_at, r.created_at]) {
      if (f === undefined || f === null || f === "") continue;
      const t = new Date(f).getTime();
      if (Number.isFinite(t) && t > max) max = t;
    }
    return max;
  }
  function runTsUsable(r) { return Number.isFinite(runTs(r)); }
  // Evaluate the freshest set of candidates for a context. Every member must
  // conclude success, and (for a workflow-pinned context) verify workflow
  // identity. Any failure pushes a reason and returns true ("failed"). A single
  // non-success / non-verifying member fails the context — an older success can
  // never rescue it.
  function evaluateFreshest(ctx, members) {
    for (const r of members) {
      if (!(r.status === "completed" && r.conclusion === "success")) {
        reasons.push(`required context '${ctx.context}' did not conclude success (status=${r.status}, conclusion=${r.conclusion || "n/a"}; skipped/neutral/cancelled/in-progress/queued count as failure)`);
        return true;
      }
      if (ctx.workflow) {
        const wid = verifyWorkflowIdentity(r, ctx);
        if (!wid.ok) { reasons.push(wid.reason); return true; }
      }
    }
    return false;
  }
  // For a workflow-pinned context, take the selected freshest run group(s) and,
  // per group, restrict its check-run members to the run's LATEST-attempt job set
  // (so a "Re-run failed jobs" stale-attempt failure is superseded, F2), then
  // evaluate the union of current-attempt members (all must pass + verify). Fails
  // CLOSED if a selected run cannot be resolved (no resolver, no run id, fetch
  // failure) or if, after restriction, a selected run has ZERO current-attempt
  // members for the context (the freshest run no longer carries this context in
  // its latest attempt — cannot confirm a current pass). Returns true if a reason
  // was pushed (the context failed), false if the restricted set passed.
  function restrictAndEvaluateRunGroups(ctx, selectedGroups) {
    const currentMembers = [];
    for (const g of selectedGroups) {
      // All members of a group share one runId (grouped by extractRunId); a
      // `__norun__` group has no resolvable run id -> fail closed.
      const runId = extractRunId(g.members[0]);
      if (!runId) {
        reasons.push(`required context '${ctx.context}' check-run has no resolvable Actions run id in its url — cannot verify the pinned workflow '${ctx.workflow}@${ctx.pinned}' (fail closed)`);
        return true;
      }
      if (typeof runWorkflow !== "function") {
        reasons.push(`required context '${ctx.context}' pins workflow '${ctx.workflow}@${ctx.pinned}' but no workflow-run resolver is available to verify it (fail closed)`);
        return true;
      }
      let wr;
      try { wr = runWorkflow(runId); } catch { wr = null; }
      if (!wr || !(wr.latestAttemptJobIds instanceof Set)) {
        reasons.push(`required context '${ctx.context}' — could not resolve Actions run ${runId} (incl. its latest-attempt job set) to verify the pinned workflow '${ctx.workflow}@${ctx.pinned}' (fail closed)`);
        return true;
      }
      // RUN-LEVEL all-jobs-passed gate (codex-converge HIGH — closes the partial-
      // rerun decoy false-positive): the resolved run must itself be completed and
      // conclusion=success. A run where the genuine reusable job FAILED (and only a
      // same-name local DECOY job was re-run to green in the latest attempt) is
      // conclusion != success, even though the decoy check-run survives the
      // latest-attempt restriction and would otherwise inherit the run-level
      // referenced_workflows pin. Conversely a genuine "Re-run failed jobs" that
      // turns the run green (F2) has conclusion=success and PASSES. An in-flight
      // rerun has status != completed (or conclusion null) -> fail closed.
      //
      // KNOWN LIMITATION (out of MACHINE-ARM scope, codex-converge accepted): the
      // run conclusion is GitHub's authoritative all-jobs-passed signal in every
      // ordinary case, but `jobs.<job_id>.continue-on-error: true` in the CALLER
      // workflow lets a run conclude success even though that job failed (GitHub
      // reports the job as success too). There is NO API signal that separates a
      // legit "re-run the failed genuine job to green" from "re-run only a decoy
      // while the genuine job stays failed" — GitHub exposes no stable per-attempt
      // job identity and no per-job "this is the reusable-workflow call" marker
      // (referenced_workflows is run-level), so any stale-failure heuristic would
      // re-introduce the F2 false-negative (human approval on every rerun-to-green).
      // This residual is NOT machine-arm-reachable: making the gate job
      // continue-on-error requires editing .github/** — a HIGH-RISK path that
      // requires the MAINTAINER HUMAN ARM (a real Reviewed-by), never this machine
      // arm; a maintainer who approves a non-blocking gate owns that configuration.
      // A repo that wants to additionally pin the trusted caller can declare the
      // optional callerPath/allowedEvents on the required context (see
      // verifyWorkflowIdentity), which bounds which caller workflow/events satisfy it.
      if (wr.status !== "completed" || wr.conclusion !== "success") {
        reasons.push(`required context '${ctx.context}' — Actions run ${runId} did not conclude success overall (run status=${wr.status || "n/a"}, conclusion=${wr.conclusion || "n/a"}) — a same-run job (e.g. the genuine reusable job) is non-passing, so a surviving same-name success cannot bless the context (fail closed)`);
        return true;
      }
      // Restrict to the run's LATEST attempt: check-run id == job id. Stale
      // prior-attempt check-runs (id NOT in the latest job set) are superseded.
      const current = g.members.filter((r) => wr.latestAttemptJobIds.has(String(r.id)));
      if (current.length === 0) {
        reasons.push(`required context '${ctx.context}' — Actions run ${runId} has no check-run for this context in its LATEST attempt (the freshest run's current attempt does not carry this context) (fail closed)`);
        return true;
      }
      for (const r of current) currentMembers.push(r);
    }
    // Every current-attempt member across the selected run group(s) must pass +
    // verify identity (verifyWorkflowIdentity re-resolves via the memoized
    // resolver — same wr — and binds head + check_suite + referenced_workflows).
    return evaluateFreshest(ctx, currentMembers);
  }
  for (const ctx of suite.requiredContexts) {
    const candidates = checkRuns.filter((r) => runIsCandidate(r, ctx));
    if (candidates.length === 0) { reasons.push(`required context '${ctx.context}' has no matching check-run on the reviewed head`); continue; }
    // F4: a candidate with a non-finite timestamp (no usable started/completed/
    // updated/created_at) is an ORDERING AMBIGUITY — runTs returns -Infinity, so
    // it can never be "freshest" and would be silently dropped, letting an OLDER
    // success win (fail-open). The fail-open only EXISTS when there is something
    // to order against (>= 2 candidates): with a single candidate there is no
    // freshness decision, so a missing timestamp is harmless and the candidate is
    // evaluated directly. With multiple candidates, fail the context CLOSED if ANY
    // is unorderable rather than dropping it (real github-actions check-runs
    // always carry valid timestamps, so this never fires in production; a
    // malformed one routes to the human arm instead of being silently ignored).
    if (candidates.length > 1 && candidates.some((r) => !runTsUsable(r))) {
      reasons.push(`required context '${ctx.context}' has multiple matching check-runs and at least one has no usable timestamp — cannot order them to pick the freshest; failing closed rather than letting an older success win (fail closed). The human arm stays available.`);
      continue;
    }
    if (ctx.workflow) {
      // RE-RUN / job-collision selection (codex-converge round 2/3 HIGH + F2):
      // a legitimate cross-run RE-RUN is a NEW Actions run (new run id), and a
      // "Re-run failed jobs" is the SAME run id with an incremented run_attempt
      // (filter=all then returns BOTH the stale attempt's failure check-run AND
      // the new attempt's success check-run under one run id). We must:
      //   - across DIFFERENT runs: the freshest run supersedes older failed runs;
      //   - within ONE run: the genuine LATEST attempt supersedes stale earlier
      //     attempts (F2 — requiring EVERY check-run incl. the stale failure
      //     re-created human-approval-on-every-merge), WHILE a concurrent decoy
      //     job in the SAME (latest) attempt must still all-pass (round-3 HIGH).
      // Mechanism: group by resolved Actions run id, take the freshest GROUP(s),
      // then within the selected runs RESTRICT to check-runs whose id is in that
      // run's LATEST-attempt job set (resolver's latestAttemptJobIds; check-run
      // id == job id for github-actions). Stale prior-attempt check-runs are
      // superseded (dropped); current-attempt members (incl. any genuine decoy,
      // and incl. a current FAILURE or in-flight job — which stay in the latest
      // job set and so are never hidden) are ALL required to pass + verify.
      const groups = new Map(); // runId -> { members:[], maxTs }
      for (const r of candidates) {
        const key = extractRunId(r) || `__norun__${groups.size}`;
        let g = groups.get(key);
        if (!g) { g = { members: [], maxTs: -Infinity }; groups.set(key, g); }
        g.members.push(r);
        g.maxTs = Math.max(g.maxTs, runTs(r));
      }
      let freshestGroup = null;
      for (const g of groups.values()) if (!freshestGroup || g.maxTs > freshestGroup.maxTs) freshestGroup = g;
      // Tie on timestamp across DIFFERENT runs: be strict — evaluate every tied
      // group's members (cannot prefer one run over another). Each group is
      // restricted to its OWN run's latest-attempt job set (codex: never share
      // one resolved run across tied groups).
      const tied = [...groups.values()].filter((g) => g.maxTs === freshestGroup.maxTs);
      const selectedGroups = tied.length > 1 ? tied : [freshestGroup];
      if (restrictAndEvaluateRunGroups(ctx, selectedGroups)) continue;
      continue;
    }
    // Non-workflow context: freshest check-run(s) by timestamp; any-fail tie-break.
    let maxTs = -Infinity;
    for (const r of candidates) maxTs = Math.max(maxTs, runTs(r));
    const freshest = candidates.filter((r) => runTs(r) === maxTs);
    evaluateFreshest(ctx, freshest);
  }
  // §4 audit RECORD shape — gate-arm ONLY. A gate-arm record must carry BOTH a
  // recent `lastAuditedAt` AND an `auditEvidence` pointer (§4: "bumps
  // lastAuditedAt AND auditEvidence in the same commit"). A fresh lastAuditedAt
  // with no evidence is exactly the half-fabrication the coupling exists to
  // catch, so a missing/empty auditEvidence fails the gate arm closed (the
  // version-bump arm separately enforces the lastAuditedAt→auditEvidence COUPLING
  // on change; this is the presence floor at verification time). `lastAuditedAt`
  // is self-asserted (an honesty limit, §5-class), but a MISSING or STALE record
  // cannot bless a gate-arm merge. A human-arm merge is unaffected — staleness
  // stops machine verification, not the org.
  // auditEvidence must be a NON-EMPTY STRING (a URL pointer per §4). A non-string
  // (object/array) must NOT pass via String() coercion (codex round-3 HIGH:
  // `String({})` is "[object Object]", non-empty).
  if (typeof suite.auditEvidence !== "string" || suite.auditEvidence.trim() === "") {
    reasons.push(`gate-suite.json auditEvidence must be a non-empty string URL pointer — §4 requires recorded evidence alongside lastAuditedAt (a fresh audit date with no/invalid evidence is not an audit); the gate arm fails closed. The human arm (tier=maintainer Reviewed-by) stays available.`);
  }
  const staleErr = checkAuditStaleness(suite.lastAuditedAt, now);
  if (staleErr.fail) reasons.push(staleErr.message);
  else if (staleErr.warn) warnings.push(staleErr.message);
  return { ok: reasons.length === 0, reasons, warnings };
}

/**
 * §4 staleness classification for a gate suite's `lastAuditedAt`. Pure.
 * Returns { fail, warn, message }:
 *  - missing/unparseable lastAuditedAt  => fail (no audit record; fail closed)
 *  - age > 65 days                      => fail (gate-arm merges blocked)
 *  - age > 35 days                      => warn (audit going stale)
 *  - otherwise                          => clean
 * `lastAuditedAt` is an ISO date (YYYY-MM-DD) or full ISO timestamp. A FUTURE
 * date (beyond a small clock-skew tolerance) FAILS CLOSED — a fabricated future
 * date would otherwise suppress both the WARN and FAIL windows indefinitely
 * (codex round-2 HIGH); "the audit happens tomorrow" is not "the audit happened".
 */
const AUDIT_FUTURE_SKEW_DAYS = 1;
export function checkAuditStaleness(lastAuditedAt, now = Date.now()) {
  if (lastAuditedAt === undefined || lastAuditedAt === null || lastAuditedAt === "") {
    return { fail: true, warn: false, message: `gate-suite.json has no lastAuditedAt — the monthly audit obligation (§4) is unmet; a gate suite with no recorded audit cannot machine-verify a merge (fail closed)` };
  }
  const t = new Date(lastAuditedAt).getTime();
  if (!Number.isFinite(t)) {
    return { fail: true, warn: false, message: `gate-suite.json lastAuditedAt '${lastAuditedAt}' is not a valid date — cannot establish audit recency (fail closed)` };
  }
  const ageDays = (now - t) / DAY_MS;
  if (ageDays < -AUDIT_FUTURE_SKEW_DAYS) {
    return { fail: true, warn: false, message: `gate-suite.json lastAuditedAt '${lastAuditedAt}' is in the FUTURE (${Math.ceil(-ageDays)} days ahead) — a future audit date cannot certify a completed audit; failing closed so a fabricated date cannot suppress the staleness window. The human arm (tier=maintainer Reviewed-by) stays available.` };
  }
  if (ageDays > AUDIT_STALE_FAIL_DAYS) {
    return { fail: true, warn: false, message: `gate-suite audit is ${Math.floor(ageDays)} days old (> ${AUDIT_STALE_FAIL_DAYS}) — the audit has lapsed; gate-arm merges are blocked until the Accountable engineer re-audits and bumps lastAuditedAt + auditEvidence (§4). The human arm (tier=maintainer Reviewed-by) stays available.` };
  }
  if (ageDays > AUDIT_STALE_WARN_DAYS) {
    return { fail: false, warn: true, message: `gate-suite audit is ${Math.floor(ageDays)} days old (> ${AUDIT_STALE_WARN_DAYS}) — going stale; the Accountable engineer should re-audit before day ${AUDIT_STALE_FAIL_DAYS} (§4) or gate-arm merges will block.` };
  }
  return { fail: false, warn: false, message: "" };
}

/**
 * §4 version-bump + audit-coupling rule (gate-checked). On any PR that changes
 * `.github/gate-suite.json`:
 *  - if `requiredContexts` (incl. any context `pinned` SHA) or `highRiskPaths`
 *    changed against the PARENT (base-ref) suite and `version` did NOT bump =>
 *    finding (defeats the "which suite version applied" audit);
 *  - if `lastAuditedAt` changed but `auditEvidence` did NOT change => finding
 *    (§4: lastAuditedAt and auditEvidence are bumped IN THE SAME COMMIT — a new
 *    audit date with stale evidence is the half-fabrication the coupling exists
 *    to catch).
 * Pure; the caller supplies the parsed parent and head suites.
 *
 * @param parentSuite  jsonFileAtRef-shaped result of the base-ref blob.
 *                     A GENUINELY ABSENT parent (`absent:true` — a NEW suite on
 *                     this PR) is vacuously OK (nothing to bump against). An
 *                     OPERATIONAL failure (`operational:true` — base not
 *                     fetched / unparseable parent) FAILS CLOSED: the gate
 *                     cannot prove the change was non-material, so it must not
 *                     pass it (codex round-2 HIGH — no fail-open).
 * @param headSuite    { ok, value } of the head blob.
 * Returns { ok, reason }.
 */
export function checkSuiteVersionBump(parentSuite, headSuite) {
  // Head must be parseable to even reason about it; an unparseable head suite is
  // already fail-closed via classifyHighRisk, so here we only guard the diff.
  if (!headSuite || !headSuite.ok) return { ok: true, reason: null };
  // A genuinely NEW suite (ref resolved, path absent) has nothing to bump against.
  if (parentSuite && parentSuite.absent) return { ok: true, reason: null };
  // Any other non-ok parent is an OPERATIONAL failure — fail closed.
  if (!parentSuite || !parentSuite.ok) {
    return { ok: false, reason: `cannot read the parent .github/gate-suite.json to verify the §4 version-bump/audit-coupling rule (${parentSuite?.reason || "unavailable"}) — failing closed (a material suite change must not pass unverified)` };
  }
  const a = parentSuite.value || {};
  const b = headSuite.value || {};
  // Normalize the version-relevant fields so an order-only or whitespace diff is
  // not mistaken for a material change (codex round-1 LOW).
  const norm = (v) => JSON.stringify(canonicalizeForBump(v));
  const materialChanged =
    norm(a.requiredContexts) !== norm(b.requiredContexts) ||
    norm(a.highRiskPaths) !== norm(b.highRiskPaths);
  if (materialChanged && a.version === b.version) {
    return { ok: false, reason: `gate-suite.json requiredContexts/pinned/highRiskPaths changed but version did not bump (still '${b.version}') — a material suite change must bump version (CalVer YYYY.MM[.N]) so the audit can tell which suite applied (§4)` };
  }
  // §4 audit coupling: a changed lastAuditedAt with unchanged auditEvidence is
  // an uncoupled audit-date bump. Compare by canonical VALUE (not `===`, which
  // is reference-equality for structured evidence — codex round-3 HIGH) so a
  // changed date paired with an unchanged object/array pointer is still caught.
  if (norm(a.lastAuditedAt) !== norm(b.lastAuditedAt) && norm(a.auditEvidence) === norm(b.auditEvidence)) {
    return { ok: false, reason: `gate-suite.json lastAuditedAt changed ('${a.lastAuditedAt}' → '${b.lastAuditedAt}') but auditEvidence did not — §4 requires both to be bumped in the same commit (a new audit date must point at new evidence)` };
  }
  return { ok: true, reason: null };
}

// Canonicalize a requiredContexts/highRiskPaths value for order-insensitive,
// whitespace-insensitive comparison: sort arrays of strings; sort arrays of
// context objects by a stable key (context+workflow+pinned+appSlug); recurse.
function canonicalizeForBump(v) {
  if (Array.isArray(v)) {
    const items = v.map(canonicalizeForBump);
    const keyed = items.map((it) => [JSON.stringify(it), it]);
    keyed.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    return keyed.map((k) => k[1]);
  }
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalizeForBump(v[k]);
    return out;
  }
  return v;
}

// ===========================================================================
// Analysis orchestration (per-arm). Network calls go through the injected
// client; all decision logic is pure and reachable from tests.
// ===========================================================================

/**
 * Pre-merge analysis: branch-commit Assisted-by presence (check 5 for
 * known-agent commits), approvals (check 2), gate arm (check 3) where the PR
 * carries enough claim to verify, and high-risk mapping (check 4). The squash
 * RECORD itself is NOT readable pre-merge (detection limit) — that is the
 * post-merge arm's job; here we truth-check the claims that exist.
 *
 * `ctx` is a plain object of already-collected inputs (so this is unit-testable
 * without git or network):
 *   { changedFiles, rangeIdentities, rangeMessages, agentTokens, agentAllow,
 *     defaults, repoSuite,
 *     // optional API-derived (when a client + PR are available):
 *     reviews, prAuthorLogin, reviewedHeadSha, permissionByLogin, suiteFile,
 *     checkRuns, declaredReviewedBy }
 */
export function analyzePreMerge(ctx) {
  const findings = [];

  // check 4 + §3: high-risk mapping (always computable from the diff + config).
  const hr = classifyHighRisk(ctx.changedFiles || [], ctx.defaults, ctx.repoSuite);
  for (const e of hr.errors) findings.push({ code: "high-risk-config", severity: "error", message: e });

  // check 5: any range commit authored/committed by a known agent must carry a
  // matching Assisted-by in its OWN message (branch-commit attribution).
  for (const id of ctx.rangeIdentities || []) {
    const agentAuthor = looksLikeAgent({ name: id.authorName, email: id.authorEmail }, { tokens: ctx.agentTokens, allow: ctx.agentAllow });
    const agentCommitter = looksLikeAgent({ name: id.committerName, email: id.committerEmail }, { tokens: ctx.agentTokens, allow: ctx.agentAllow });
    if (agentAuthor || agentCommitter) {
      // Read THIS commit's own message by SHA — never a heuristic substring
      // scan of the range (a later commit mentioning this SHA in its body must
      // not satisfy this commit's missing Assisted-by).
      const msg = (ctx.messageBySha && ctx.messageBySha[id.sha]) || "";
      const p = parseTrailers(msg);
      const named = p.assisted.some((a) => !a.isNone);
      if (!named) {
        findings.push({
          code: "agent-commit-no-assisted",
          severity: "error",
          message: `commit ${String(id.sha).slice(0, 8)} is authored/committed by a known agent identity (${agentAuthor ? id.authorName : id.committerName}) but carries no Assisted-by`,
        });
      }
    }
  }

  // check 4: high-risk requires a tier=maintainer human approval. Pre-merge we
  // can evaluate this when the API gave us the declared Reviewed-by claim +
  // reviews. (The squash record's Reviewed-by is post-merge; here the gate uses
  // the PR's actual approvals as the proxy for what the record will assert.)
  if (hr.highRisk) {
    if (!ctx.apiBound || !ctx.reviews) {
      // High-risk change but no API to verify a maintainer approval — cannot
      // pass it (fail closed). The PR carries a high-risk surface; without the
      // approval data the gate must not call it satisfied.
      findings.push({
        code: "high-risk-unverifiable",
        severity: "error",
        message: `change touches a high-risk path (${hr.matched.slice(0, 3).map((m) => m.glob).join(", ")}${hr.matched.length > 3 ? ", …" : ""}) but the PR approvals could not be fetched to confirm a maintainer review — failing closed`,
      });
    } else {
      const maintainerOk = (ctx.declaredReviewedBy || [])
        .filter((l) => l.tier === "maintainer")
        .some((l) => verifyReviewedLine(l, {
          reviews: ctx.reviews,
          permission: (ctx.permissionByLogin || {})[l.login],
          prAuthorLogin: ctx.prAuthorLogin,
          reviewedHeadSha: ctx.reviewedHeadSha,
        }).ok);
      // Fallback when no declared Reviewed-by claim is available pre-merge: is
      // there ANY real maintainer-standing, non-self, non-stale APPROVED review?
      const anyMaintainerApproval = !maintainerOk && (ctx.approverLogins || []).some((login) => verifyReviewedLine({ login, tier: "maintainer" }, {
        reviews: ctx.reviews,
        permission: (ctx.permissionByLogin || {})[login],
        prAuthorLogin: ctx.prAuthorLogin,
        reviewedHeadSha: ctx.reviewedHeadSha,
      }).ok);
      if (!maintainerOk && !anyMaintainerApproval) {
        findings.push({
          code: "high-risk-without-maintainer",
          severity: "error",
          message: `change touches a high-risk path (${hr.matched.slice(0, 3).map((m) => m.glob).join(", ")}${hr.matched.length > 3 ? ", …" : ""}) — requires a non-self maintainer-tier approval at the reviewed head; none found`,
        });
      }
    }
  }

  // check 2: each DECLARED Reviewed-by line must verify true. A declared claim
  // we cannot verify (API unbound) is unverifiable — fail closed, never a
  // silent pass (round-2: pre-merge declared arms must not fail open).
  if ((ctx.declaredReviewedBy || []).length) {
    if (!ctx.apiBound || !ctx.reviews) {
      findings.push({ code: "reviewed-by-unverifiable", severity: "error", message: `the PR declares a Reviewed-by claim but the approvals could not be fetched to verify it — failing closed` });
    } else {
      for (const l of ctx.declaredReviewedBy) {
        const v = verifyReviewedLine(l, {
          reviews: ctx.reviews,
          permission: (ctx.permissionByLogin || {})[l.login],
          prAuthorLogin: ctx.prAuthorLogin,
          reviewedHeadSha: ctx.reviewedHeadSha,
        });
        if (!v.ok) findings.push({ code: "reviewed-by-fabricated", severity: "error", message: `Reviewed-by @${l.login} (tier=${l.tier}) fails verification: ${v.reasons.join("; ")}` });
      }
    }
  }

  // check 3: a DECLARED gate arm must verify. Unverifiable (API unbound / no
  // suite / no check-runs) is a finding, not a skip.
  if (ctx.declaredGateArm) {
    if (!ctx.apiBound || !ctx.checkRuns) {
      findings.push({ code: "gate-suite-unverifiable", severity: "error", message: `the PR declares a Gate-suite claim but suite/check-run data isn't available to verify it — failing closed` });
    } else {
      const v = verifyGateArm(ctx.declaredGateArm, { suiteFile: ctx.suiteFile || { ok: false, reason: "no committed gate-suite.json" }, checkRuns: ctx.checkRuns, now: ctx.now, reviewedHeadSha: ctx.reviewedHeadSha, runWorkflow: ctx.runWorkflow });
      if (!v.ok) findings.push({ code: "gate-suite-fabricated", severity: "error", message: `Gate-suite arm fails verification: ${v.reasons.join("; ")}` });
      for (const w of v.warnings || []) findings.push({ code: "gate-suite-audit-stale", severity: "warning", message: w });
    }
  }

  // §4 version-bump rule: when this PR changes .github/gate-suite.json, a
  // material change (requiredContexts/pinned/highRiskPaths) must bump version.
  // The parent (base-ref) suite is supplied by main() when the API is bound;
  // a NEW suite has no parent, so the rule is vacuous (handled in the function).
  if ((ctx.changedFiles || []).some((f) => f === ".github/gate-suite.json" || f.endsWith("/.github/gate-suite.json"))) {
    const vb = checkSuiteVersionBump(ctx.parentSuiteFile, ctx.repoSuite);
    if (!vb.ok) findings.push({ code: "gate-suite-version-not-bumped", severity: "error", message: vb.reason });
  }

  return { findings, highRisk: hr.highRisk, highRiskMatched: hr.matched };
}

/**
 * Post-merge analysis: validate the synthesized squash message — the RECORD
 * itself. §5 checks 1–4 on the merge commit. The tree-identity bridge (§5) and
 * the live API checks are passed in via ctx (collected by main()).
 *
 * ctx: { message, changedFiles, defaults, repoSuite, treeMatch,
 *        reviews, prAuthorLogin, reviewedHeadSha, permissionByLogin,
 *        suiteFile, checkRuns }
 */
export function analyzePostMerge(ctx) {
  const findings = [];
  const parsed = parseTrailers(ctx.message);
  const arm = classifyArm(parsed);
  // apiBound: were the anti-fabrication inputs (PR reviews, permissions, the
  // reviewed head, check-runs, committed suite) actually available? When a
  // record MAKES a verification claim but apiBound is false, we CANNOT silently
  // pass it — that is the fail-open hole. We emit an "unverifiable-claim"
  // finding so the record is never blessed without its claims being checked.
  const apiBound = Boolean(ctx.apiBound);
  // A correction (§5) skips the tree bridge ONLY when it is a genuine NON-PR
  // correction: an empty/direct-push attestation with NO associated PR (no
  // reviewedHeadSha to compare a tree against). A correction that DOES carry a
  // PR + reviewed head (a "PR-merge correction", §5) is validated exactly like
  // a merge record — tree identity included. So `Correction-for:` alone never
  // buys a tree-bridge bypass; only the absence of a reviewed head does.
  const isNonPrCorrection = Boolean(parsed.correctionFor) && !ctx.reviewedHeadSha;

  // check 1: a valid §1 record must be present (grammar + structure + an arm).
  for (const e of parsed.errors) findings.push({ code: "no-record", severity: "error", message: `record invalid: ${e}` });
  for (const e of arm.errors) findings.push({ code: "no-record", severity: "error", message: `record invalid: ${e}` });

  // tree-identity bridge (§5): what landed must be byte-identical to what was
  // reviewed/checked. A mismatch invalidates the binding of approvals/contexts.
  // Only a genuine non-PR correction (no reviewed head exists) is exempt.
  if (!isNonPrCorrection) {
    if (ctx.treeMatch === false) {
      findings.push({ code: "tree-mismatch", severity: "error", message: `tree(merged) != tree(reviewed head) — the landed tree is not what was reviewed; approvals/contexts do not bind` });
    } else if (apiBound && ctx.treeMatch === undefined && (parsed.hasHumanArm || parsed.hasGateArm)) {
      // API was bound but the tree could not be resolved on BOTH sides — we
      // cannot confirm what landed == what was reviewed. Fail closed.
      findings.push({ code: "tree-unverifiable", severity: "error", message: `cannot resolve tree(merged) and tree(reviewed head) to confirm the landed tree was the reviewed one — failing closed` });
    }
  }

  // check 4 + §3: high-risk requires a passing tier=maintainer Reviewed-by.
  const hr = classifyHighRisk(ctx.changedFiles || [], ctx.defaults, ctx.repoSuite);
  for (const e of hr.errors) findings.push({ code: "high-risk-config", severity: "error", message: e });

  // check 2: each Reviewed-by in the RECORD must verify against the PR approvals.
  // If the record asserts a human arm but the API isn't bound, that claim is
  // UNVERIFIABLE — a finding, never a silent pass (fail-open hole closed).
  const passingMaintainer = [];
  if (parsed.hasHumanArm) {
    if (!apiBound || !ctx.reviews) {
      findings.push({ code: "reviewed-by-unverifiable", severity: "error", message: `record asserts a human verification arm (Reviewed-by) but the PR approvals could not be fetched to verify it — failing closed (record not blessed unverified)` });
    } else {
      for (const l of parsed.reviewed) {
        const v = verifyReviewedLine(l, {
          reviews: ctx.reviews,
          permission: (ctx.permissionByLogin || {})[l.login],
          prAuthorLogin: ctx.prAuthorLogin,
          reviewedHeadSha: ctx.reviewedHeadSha,
        });
        if (!v.ok) findings.push({ code: "reviewed-by-fabricated", severity: "error", message: `Reviewed-by @${l.login} (tier=${l.tier}) fails verification: ${v.reasons.join("; ")}` });
        else if (l.tier === "maintainer") passingMaintainer.push(l.login);
      }
    }
  }
  if (hr.highRisk && passingMaintainer.length === 0) {
    findings.push({ code: "high-risk-without-maintainer", severity: "error", message: `high-risk change but no passing tier=maintainer Reviewed-by in the record (high-risk requires the human arm; the gate arm alone is rejected)` });
  }

  // check 3: gate arm in the record must verify. A declared gate arm we cannot
  // verify (no suite file, no check-runs, API unbound) is UNVERIFIABLE — fail
  // closed, never a silent pass.
  if (parsed.hasGateArm) {
    if (!apiBound) {
      findings.push({ code: "gate-suite-unverifiable", severity: "error", message: `record asserts a gate arm (Gate-suite) but the API isn't bound to verify suite + check-runs — failing closed` });
    } else if (!ctx.checkRuns) {
      findings.push({ code: "gate-suite-unverifiable", severity: "error", message: `record asserts a gate arm but the check-runs for the reviewed head could not be fetched — failing closed` });
    } else {
      const v = verifyGateArm(parsed, { suiteFile: ctx.suiteFile || { ok: false, reason: "no committed gate-suite.json at the merged SHA" }, checkRuns: ctx.checkRuns, now: ctx.now, reviewedHeadSha: ctx.reviewedHeadSha, runWorkflow: ctx.runWorkflow });
      if (!v.ok) findings.push({ code: "gate-suite-fabricated", severity: "error", message: `Gate-suite arm fails verification: ${v.reasons.join("; ")}` });
      for (const w of v.warnings || []) findings.push({ code: "gate-suite-audit-stale", severity: "warning", message: w });
    }
  }

  // check 5 (post-merge): the spec keys check 5 on PR-RANGE commit identities,
  // but the post-merge record itself must also reflect agent assistance. When
  // the PR range identities are available (passed via ctx for the merged PR),
  // a known-agent commit whose work landed must be represented by a non-`none`
  // Assisted-by line in the aggregated record. A squash of agent work that
  // carries `Assisted-by: none` is a missing record.
  if (Array.isArray(ctx.rangeIdentities) && ctx.rangeIdentities.length) {
    const anyAgent = ctx.rangeIdentities.some((id) =>
      looksLikeAgent({ name: id.authorName, email: id.authorEmail }, { tokens: ctx.agentTokens, allow: ctx.agentAllow }) ||
      looksLikeAgent({ name: id.committerName, email: id.committerEmail }, { tokens: ctx.agentTokens, allow: ctx.agentAllow }));
    const recordHasNamedAssisted = parsed.assisted.some((a) => !a.isNone);
    if (anyAgent && !recordHasNamedAssisted) {
      findings.push({ code: "agent-commit-no-assisted", severity: "error", message: `the squash range contains commits by a known agent identity but the record's Assisted-by does not name any agent (Assisted-by: none / human-only is untrue here)` });
    }
  }

  return { findings, parsed, highRisk: hr.highRisk, highRiskMatched: hr.matched };
}

// ===========================================================================
// CLI
// ===========================================================================

function fail(msg) { console.error(`[truthful-attribution-gate] ${msg}`); process.exit(2); }

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) fail(`unexpected argument: ${tok}`);
    const eq = tok.indexOf("=");
    const key = eq !== -1 ? tok.slice(2, eq) : tok.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq !== -1) fail(`--${key} takes no value`);
      args[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      const value = eq !== -1 ? tok.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq === -1 && String(value).startsWith("--"))) fail(`--${key} requires a value`);
      args[key] = value;
    } else fail(`unknown flag --${key}`);
  }
  return args;
}

const GH = process.env.GITHUB_ACTIONS === "true";
function annotate(level, msg) { if (GH) process.stdout.write(`::${level}::${msg.replace(/\n/g, " ")}\n`); }
function emitStepSummary(lines) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  try { fs.appendFileSync(f, lines.join("\n") + "\n"); } catch { /* non-fatal */ }
}

function defaultsPath(args) {
  if (args["high-risk-defaults"]) return args["high-risk-defaults"];
  // Co-located default: this script lives in <ci>/scripts; config in <ci>/config.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "high-risk-defaults.json");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const arm = args.arm || "pre-merge";
  if (!VALID_ARMS.includes(arm)) fail(`unknown --arm '${arm}' (valid: ${VALID_ARMS.join(", ")})`);
  const mode = args.mode || "warn";
  if (!VALID_MODES.includes(mode)) fail(`unknown --mode '${mode}' (valid: ${VALID_MODES.join(", ")})`);
  const format = args.format || "text";
  if (!VALID_FORMATS.includes(format)) fail(`unknown --format '${format}' (valid: ${VALID_FORMATS.join(", ")})`);
  const quiet = Boolean(args.quiet);

  const defaults = loadJsonSafe(defaultsPath(args));
  const repoSuite = fs.existsSync(args["gate-suite"] || ".github/gate-suite.json")
    ? loadJsonSafe(args["gate-suite"] || ".github/gate-suite.json")
    : null;

  // Optional API client (anti-fabrication). Without a token/PR, the gate runs
  // the offline checks only and ANNOTATES that anti-fabrication was skipped —
  // honest about its own detection limits rather than silently passing.
  const repo = args.repo || process.env.GITHUB_REPOSITORY || "";
  let client = null;
  if (repo && (args.pr || arm === "post-merge")) {
    try { client = makeGhClient({ repo }); } catch { client = null; }
  }

  let result;
  let apiSkippedReason = null;

  if (arm === "pre-merge") {
    const base = resolveDiffBase({ explicit: args["diff-base"], envVarName: args["diff-base-env"] || DEFAULT_DIFF_BASE_ENV });
    const changedFiles = changedFilesForRange(base);
    const rangeIdentities = rangeCommitIdentities(base);
    // map sha->message for check 5 (range messages keyed loosely; collect both)
    const messages = rangeCommitMessages(base);
    const ctx = {
      changedFiles, rangeIdentities, rangeMessages: messages,
      agentTokens: loadAgentTokens(args), agentAllow: DEFAULT_NONAI_BOT_ALLOW,
      defaults, repoSuite,
    };
    // §4 version-bump rule: the PARENT gate-suite.json is the file as it stood at
    // the diff base the changed-file range was computed against (local git, no
    // TOCTOU). Absent at the base => a NEW suite, bump rule is vacuous.
    ctx.parentSuiteFile = base ? jsonFileAtRef(base, ".github/gate-suite.json") : { ok: false, reason: "no diff base" };
    // Per-commit message lookup by SHA (so check 5 reads the right commit body).
    ctx.messageBySha = {};
    if (base) for (const id of rangeIdentities) { try { ctx.messageBySha[id.sha] = commitMessage(id.sha); } catch { /* skip */ } }

    if (client && args.pr) {
      try {
        const pr = client.pr(args.pr);
        ctx.prAuthorLogin = pr.user?.login;
        ctx.reviewedHeadSha = args["head-sha"] || pr.head?.sha;
        ctx.reviews = client.listReviews(args.pr);
        ctx.approverLogins = [...new Set(ctx.reviews.filter((r) => r.state === "APPROVED").map((r) => r.user?.login).filter(Boolean))];

        // DECLARED record: when the PR BODY carries a §1 trailer block (the
        // intended squash record — the spec's recommended merge tooling composes
        // and validates the message before merge, and a PR can carry it in its
        // body so the pre-merge arm can truth-check it before it lands), parse it
        // and verify it pre-merge. This is the production source that makes the
        // declared-arm fail-closed checks reachable. Absent a body record, the
        // gate still truth-checks the actual approvals via approverLogins (above).
        const declared = parseTrailers(pr.body || "");
        if (declared.reviewed.length) ctx.declaredReviewedBy = declared.reviewed;
        if (declared.hasGateArm) ctx.declaredGateArm = declared;

        ctx.permissionByLogin = {};
        const loginsToResolve = [...ctx.approverLogins, ...(ctx.declaredReviewedBy || []).map((r) => r.login)];
        for (const login of loginsToResolve) {
          if (!login || ctx.permissionByLogin[login] !== undefined) continue;
          try { ctx.permissionByLogin[login] = client.permissionOf(login).permission; } catch { /* unknown */ }
        }
        if (ctx.reviewedHeadSha) { ctx.checkRuns = client.checkRunsFor(ctx.reviewedHeadSha); }
        ctx.runWorkflow = makeRunWorkflowResolver(client);
        ctx.suiteFile = repoSuite;
        ctx.apiBound = true;
      } catch (e) { apiSkippedReason = `GitHub API unavailable (${e.message}) — anti-fabrication checks skipped; offline checks only`; ctx.apiBound = false; }
    } else {
      apiSkippedReason = `no PR context (--pr / GITHUB_REPOSITORY) — anti-fabrication (approval/gate-arm) checks skipped; offline checks only`;
      ctx.apiBound = false;
    }
    result = analyzePreMerge(ctx);
  } else {
    // post-merge: validate the squash record on the given commit (default HEAD).
    const commit = args.commit || "HEAD";
    const message = commitMessage(commit);
    const changedFiles = changedFilesForCommit(commit);
    const ctx = {
      message, changedFiles, defaults, repoSuite,
      agentTokens: loadAgentTokens(args), agentAllow: DEFAULT_NONAI_BOT_ALLOW,
    };
    // Range identities for check 5 (the squash's source commits): the merge
    // commit is a squash, so its first parent is the base it landed on; the
    // range base..merge^ gives the PR's branch commits via the PR head when
    // available. We collect them from the associated PR when bound; otherwise
    // best-effort from the merge commit's first-parent range.
    // tree-identity + API anti-fabrication require knowing the PR + reviewed head.
    if (client && args.pr) {
      try {
        const pr = client.pr(args.pr);
        ctx.prAuthorLogin = pr.user?.login;
        ctx.reviewedHeadSha = args["head-sha"] || pr.head?.sha;
        ctx.reviews = client.listReviews(args.pr);
        ctx.approverLogins = [...new Set(ctx.reviews.filter((r) => r.state === "APPROVED").map((r) => r.user?.login).filter(Boolean))];
        ctx.permissionByLogin = {};
        for (const login of [...ctx.approverLogins, ...parseTrailers(message).reviewed.map((r) => r.login)]) {
          if (!login || ctx.permissionByLogin[login] !== undefined) continue;
          try { ctx.permissionByLogin[login] = client.permissionOf(login).permission; } catch { /* unknown */ }
        }
        ctx.checkRuns = client.checkRunsFor(ctx.reviewedHeadSha);
        ctx.runWorkflow = makeRunWorkflowResolver(client);
        ctx.suiteFile = repoSuite;
        const tm = treeOf(commit); const tr = treeOf(ctx.reviewedHeadSha);
        ctx.treeMatch = tm && tr ? tm === tr : undefined;
        // check 5 (squash-correct): the PR's SOURCE commits via the API — NOT
        // the squash commit's first-parent diff (which is base→squash, not the
        // branch commits). Each API commit carries author/committer identity, so
        // a known-agent commit in the squashed range is detected even though it
        // never appears as its own commit on the default branch.
        const prCommits = client.prCommits(args.pr);
        ctx.rangeIdentities = (prCommits || []).map((c) => ({
          sha: c.sha,
          authorName: c.commit?.author?.name,
          authorEmail: c.commit?.author?.email,
          committerName: c.commit?.committer?.name,
          committerEmail: c.commit?.committer?.email,
          // also consider the GitHub-resolved login (a bot/app identity)
          ghAuthorLogin: c.author?.login,
          ghCommitterLogin: c.committer?.login,
        }));
        ctx.apiBound = true;
      } catch (e) { apiSkippedReason = `GitHub API unavailable (${e.message}) — anti-fabrication checks skipped; record grammar/structure only`; ctx.apiBound = false; }
    } else {
      apiSkippedReason = `no PR context — anti-fabrication + tree-identity skipped; record grammar/structure only`;
      ctx.apiBound = false;
    }
    result = analyzePostMerge(ctx);
  }

  const findings = result.findings;
  const report = {
    gateVersion: GATE_VERSION,
    arm,
    mode,
    repo: repo || null,
    highRisk: Boolean(result.highRisk),
    apiSkippedReason,
    findingCount: findings.length,
    findings,
  };

  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else if (!quiet) {
    if (apiSkippedReason) process.stderr.write(`truthful-attribution-gate [${arm}/${mode}]: ${apiSkippedReason}\n`);
    if (findings.length === 0) {
      process.stderr.write(`truthful-attribution-gate [${arm}/${mode}]: clean — record present and no fabrication detected${result.highRisk ? " (high-risk path: maintainer review verified)" : ""}.\n`);
    } else {
      process.stderr.write(`truthful-attribution-gate [${arm}/${mode}]: ${findings.length} finding(s):\n`);
      for (const f of findings) process.stderr.write(`  [${f.severity}] ${f.code}: ${f.message}\n`);
    }
  }

  // GitHub annotations + step summary. WARN keeps the check green regardless.
  for (const f of findings) annotate(f.severity === "error" ? "warning" : "notice", `truthful-attribution [${f.code}] ${f.message}`);
  if (apiSkippedReason) annotate("notice", `truthful-attribution: ${apiSkippedReason}`);
  const summary = [`## truthful-attribution-gate (${mode.toUpperCase()})`, "", `Arm: \`${arm}\`${result.highRisk ? " · **high-risk path touched**" : ""}`, ""];
  if (apiSkippedReason) summary.push(`> ${apiSkippedReason}`, "");
  if (findings.length === 0) summary.push("Clean — a truthful verification record is present and no fabrication was detected.");
  else {
    summary.push(`${findings.length} finding(s):`, "", "| Severity | Code | Detail |", "| --- | --- | --- |");
    for (const f of findings) summary.push(`| ${f.severity} | \`${f.code}\` | ${f.message.replace(/\|/g, "\\|")} |`);
  }
  summary.push("", "_WARN mode (spec §7 step 4): findings are advisory; the check stays green. The ENFORCE flip is gated on the machine-identity [owner] issue (spec §8.5), not this gate._");
  emitStepSummary(summary);

  // WARN: always exit 0. ENFORCE would exit 1 on any error-severity finding.
  if (mode === "enforce" && findings.some((f) => f.severity === "error")) process.exit(1);
  process.exit(0);
}

/**
 * Agent name tokens = public defaults + optional internal codenames from a
 * private per-repo config (path via --config; never in the public default).
 * The config's internalAgentTokens are merged in; they never appear here.
 */
function loadAgentTokens(args) {
  const cfg = args.config ? loadJsonSafe(args.config) : { ok: false };
  const extra = (cfg.ok && Array.isArray(cfg.value?.internalAgentTokens)) ? cfg.value.internalAgentTokens.map(String) : [];
  return [...DEFAULT_AGENT_NAME_TOKENS, ...extra];
}

/**
 * A per-invocation memoizing wrapper around client.workflowRun(runId) — the
 * resolver the §5 check-3 workflow-identity verification calls. Caches by runId
 * within a single gate run so multiple required contexts that resolve the same
 * Actions run (or repeated lookups) don't refetch. The cache stores the resolver
 * RESULT (which is null on fetch failure — fail-closed); a cached null is a real
 * "could not resolve", never silently treated as an empty referenced_workflows
 * (the resolver itself returns null vs. { referencedWorkflows: [] } distinctly).
 */
export function makeRunWorkflowResolver(client) {
  if (!client || typeof client.workflowRun !== "function") return null;
  const cache = new Map();
  return (runId) => {
    const key = String(runId);
    if (cache.has(key)) return cache.get(key);
    let v = null;
    try { v = client.workflowRun(runId); } catch { v = null; }
    cache.set(key, v);
    return v;
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); }
  catch { return false; }
}
if (isMainModule()) {
  try { main(); }
  catch (e) { console.error("[truthful-attribution-gate] gate failed:", e.message); process.exit(2); }
}
