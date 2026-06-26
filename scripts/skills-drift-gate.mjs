#!/usr/bin/env node
/**
 * skills-drift-gate — reusable CI gate (cinatra repo ONLY; see cinatra#188)
 * that flags when a cinatra change touches a surface an `assistant-skills`
 * SKILL.md depends on, so the impacted skill is reviewed before it goes stale.
 *
 * The assistant-skills SKILL.md files encode behavioral knowledge about the
 * cinatra codebase: MCP primitive names + params (e.g. `agent_run`), package
 * names (`@cinatra-ai/email-outreach-agent`), and route strings. When cinatra
 * renames or re-params one of those surfaces, the dependent skill silently goes
 * stale. Nothing today links a cinatra change to the skills that depend on it.
 *
 * ── v2 — WATCHES-FIRST WITH HEURISTIC FALLBACK (cinatra#188 §2 graduation) ──
 *
 * Two-tier matching:
 *
 *  1. DECLARED WATCHES (preferred, low false-positive). A SKILL.md MAY declare a
 *     `cinatra-watches:` block in its YAML frontmatter naming the cinatra
 *     surfaces it actually depends on:
 *
 *         cinatra-watches:
 *           primitives: [agent_run, agent_run_get]
 *           packages: ["@cinatra-ai/trigger-agent"]
 *           routes: ["/api/agents/passthrough"]
 *           paths: ["packages/agents/src/a2a-actions.ts"]
 *
 *     `primitives|packages|routes` are EXACT-STRING watches intersected against
 *     the diff-extracted identifiers (same three classes as the heuristic).
 *     `paths` are source-path GLOBS matched against the PR's touched file paths
 *     (both rename sides) — this catches the documented v1 false-negative where a
 *     param-shape change leaves the watched STRING (`agent_run`) untouched but
 *     edits a watched SOURCE FILE. A skill that declares ANY non-empty watch
 *     class is "declared": only its declared surfaces flag it (heuristic noise is
 *     SUPPRESSED for that skill). Findings carry `source: "watch"`.
 *
 *  2. HEURISTIC FALLBACK (zero skill-side work, noisier). A skill with NO
 *     `cinatra-watches` block (or a present-but-EMPTY one) is matched the v1 way:
 *     identifiers that appear verbatim in the SKILL.md, intersected with the diff.
 *     Findings carry `source: "heuristic"`. So adoption is incremental — undeclared
 *     skills keep coverage until they add watches.
 *
 * ENFORCEMENT (cinatra#188: "graduate to declared watches FOR enforcement"):
 *   - warn mode: exit 0 always; report watch + heuristic findings + acks + gaps.
 *   - enforce mode: exit 1 IFF there is at least one unacknowledged `source:watch`
 *     finding. `source:heuristic` findings are ADVISORY in EVERY mode — they are
 *     reported but NEVER gate, so the warn→enforce flip can never hard-fail on
 *     heuristic noise from an undeclared skill.
 *   - fail-loud (exit 2) — bad/unresolvable assistant-skills pin, zero SKILL.md,
 *     unresolvable diff base, or a MALFORMED `cinatra-watches` block — runs BEFORE
 *     the mode decision and exits 2 regardless of warn|enforce.
 *
 * ACKNOWLEDGEMENT / OVERRIDE (cinatra#188 §Acknowledgement) — a flagged PR clears
 * an enforce finding with ONE of:
 *   (a) `Skills-PR: <url-or-#n> covers: <skill-slug>[, ...]` — a linked
 *       assistant-skills PR that NAMES the impacted skill(s) it updates. A bare PR
 *       link with no `covers:` list satisfies nothing (coverage can't be verified
 *       offline; documented honest-limitation — only the recorded decision is
 *       enforced, never content correctness). This ack is PER-SKILL.
 *   (b) `Skills-reviewed: <note>` — a recorded "checked + updated" assertion over
 *       the whole PR (covers all impacted skills).
 *   (c) `Skills-unaffected: <reason>` — a recorded override; REASON REQUIRED (the
 *       issue: "not `Skills-unaffected:` only"). A bare/empty reason satisfies
 *       nothing. Covers all impacted skills.
 *
 * Scope: this gate is wired ONLY into the cinatra repo. It is NOT part of the
 * org-wide min-repo-config rollout; no other repo calls it (cinatra#188 §Scope).
 *
 * Zero runtime dependencies (node builtins only).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATE_VERSION = "0.2.0";
const DEFAULT_DIFF_BASE_ENV = "SKILLS_DRIFT_DIFF_BASE";
const VALID_FORMATS = ["text", "json"];
const VALID_MODES = ["warn", "enforce"];

const VALUE_FLAGS = new Set([
  "skills-dir", "diff-base", "diff-base-env", "format", "ack-file", "config",
]);
const BOOLEAN_FLAGS = new Set(["quiet"]);

// ---------------------------------------------------------------------------
// Identifier extraction
//
// Three identifier classes, each shaped so prose does not match (cinatra#188's
// "false positives to tame"). The classes are deliberately conservative — warn
// mode tolerates a missed conceptual reference (a documented false negative)
// far better than it tolerates noise that trains authors to ignore the gate.
// ---------------------------------------------------------------------------

// MCP primitive names: lower_snake_case, >=2 segments. A leading-dollar/word
// boundary keeps `foo_bar` out of `xfoo_bar`. Real primitives in the skills are
// e.g. agent_run, agent_run_get, agent_source_publish, workflow_draft_create.
// The 2-segment floor (one underscore) is what separates a primitive from a
// plain English word; a single bare word never qualifies.
const PRIMITIVE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

// Package names: the canonical @cinatra-ai/<slug> scope. The scope is the guard
// — a bare slug like `email-outreach-agent` is too generic to match on, but
// `@cinatra-ai/email-outreach-agent` is an unambiguous dependency surface. The
// trailing boundary (no a-z0-9 follows) keeps `@cinatra-ai/foo_bar` from being
// truncated to `@cinatra-ai/foo` (the `_bar` tail then never re-reads as a
// primitive — the matched span is stripped before the primitive pass).
const PACKAGE_RE = /@cinatra-ai\/[a-z0-9][a-z0-9_-]*[a-z0-9](?![a-z0-9_-])/g;

// Route strings: an app/api route path. Anchored to the known route roots so a
// generic `/agents` mention in prose, or a filesystem path, does not match; we
// require >=2 path segments under a recognized root. Bracketed dynamic segments
// (`[agentId]`) are allowed so a Next.js dynamic route matches as a whole rather
// than truncating at the bracket.
const ROUTE_ROOTS = ["api", "app", "agents", "campaigns", "workflows", "artifacts", "accounts"];
const ROUTE_RE = new RegExp(
  String.raw`(?<![\w./-])/(?:${ROUTE_ROOTS.join("|")})(?:/(?:\[[a-z0-9_]+\]|[a-z0-9][a-z0-9_:.-]*))+`,
  "gi",
);

// Primitive tokens that are common-enough lower_snake_case words to be prose
// rather than a real cinatra surface. Kept tight: only tokens that genuinely
// recur as English/identifier noise, never a real MCP primitive. Tunable via
// --config { "primitiveStopwords": [...] }.
const DEFAULT_PRIMITIVE_STOPWORDS = new Set([
  "e_g", "i_e", "etc_", "no_op", "no_ops",
]);

/**
 * Extract the distinct identifier set from a block of text (PR-added lines).
 * Returns { primitives, packages, routes } as Sets of strings.
 */
export function extractIdentifiers(text, opts = {}) {
  const stopwords = opts.primitiveStopwords || DEFAULT_PRIMITIVE_STOPWORDS;
  const primitives = new Set();
  const packages = new Set();
  const routes = new Set();

  for (const m of text.matchAll(ROUTE_RE)) {
    // Trim a trailing punctuation a sentence might append (`/api/agents/run.`).
    routes.add(m[0].replace(/[.,:;)]+$/, ""));
  }

  // Collect packages, then STRIP BOTH package AND route spans before the
  // primitive pass: a slug's underscore tail (`@cinatra-ai/foo_bar`) or a route
  // segment that happens to be snake_case (`/api/agents/agent_run`) must NOT be
  // re-read as a phantom primitive (codex r4 MED — a route-only change otherwise
  // falsely matches a `primitives: [agent_run]` watch). Mask routes first, then
  // packages, so neither leaks into the primitive scan.
  for (const m of text.matchAll(PACKAGE_RE)) packages.add(m[0]);
  const working = text.replace(ROUTE_RE, " ").replace(PACKAGE_RE, " ");

  for (const m of working.matchAll(PRIMITIVE_RE)) {
    const tok = m[0];
    if (stopwords.has(tok)) continue;
    primitives.add(tok);
  }

  return { primitives, packages, routes };
}

// ---------------------------------------------------------------------------
// Diff: the cinatra PR's added/changed lines (new side, merge-base..head)
// ---------------------------------------------------------------------------

function verifyGitRef(ref) {
  execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", ref], { stdio: "ignore" });
}

/**
 * Resolve the diff base. Explicit --diff-base wins; else the env var (verified,
 * fail-loud on an unresolvable value — a CI fetch-depth bug must never silently
 * widen the scan); else origin/main, main. null = no base (treat whole tree as
 * added — strict, used only when nothing resolves, e.g. a first push).
 */
export function resolveDiffBase({ explicit, envVarName } = {}) {
  if (explicit) {
    verifyGitRef(explicit); // throws loud if a passed base does not resolve
    return explicit;
  }
  if (envVarName && Object.prototype.hasOwnProperty.call(process.env, envVarName)) {
    const v = process.env[envVarName];
    if (!v) return null;
    try { verifyGitRef(v); return v; }
    catch {
      throw new Error(`${envVarName}='${v}' does not resolve to a git ref. Check CI fetch-depth and the base ref name.`);
    }
  }
  for (const c of ["origin/main", "main"]) {
    try { verifyGitRef(c); return c; } catch { /* next */ }
  }
  return null;
}

/**
 * The set of cinatra-side files touched by the PR (added/modified/renamed),
 * new-side path. Used to attribute identifiers to a changed file in the report.
 */
export function changedFiles(base, cwd = process.cwd()) {
  const args = base
    ? ["--literal-pathspecs", "diff", "--name-only", "--diff-filter=ACMRT", "--end-of-options", `${base}...HEAD`]
    : ["--literal-pathspecs", "ls-files"];
  let out;
  try { out = execFileSync("git", args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return []; }
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * The changed text of the PR diff — BOTH added (`+`) and removed (`-`) lines
 * (excluding the `+++`/`---` headers). Removed lines matter as much as added
 * ones: a primitive/route RENAME drops the old identifier on the `-` side and
 * the new one on the `+` side, and the SKILL.md still references the OLD name —
 * so the strongest drift signal lives on a removed line (cinatra#188: "a
 * primitive/route/schema change's effect often isn't on the exact identifier
 * line"). Scanning both sides catches rename, re-param, and removal. With no
 * base, fall back to the full tracked-file content.
 */
export function changedDiffText(base, cwd = process.cwd()) {
  if (!base) {
    // No base: union of all tracked file contents is too broad and slow; the
    // strict-no-base path is only hit on a first push, where flagging the whole
    // surface is acceptable. Read tracked files' content.
    const files = changedFiles(null, cwd);
    let acc = "";
    for (const f of files) {
      try { acc += fs.readFileSync(path.join(cwd, f), "utf8") + "\n"; } catch { /* skip */ }
    }
    return acc;
  }
  let out;
  try {
    out = execFileSync(
      "git",
      ["--literal-pathspecs", "diff", "--unified=0", "--no-color", "--end-of-options", `${base}...HEAD`],
      { encoding: "utf8", cwd, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (e) {
    // FAIL LOUD: a diff failure with a resolved base (bad merge-base, unrelated
    // history, buffer overrun) must NOT be reported as a clean PR — that would
    // silently miss every surface change in the PR. Surface it so main() exits 2.
    throw new Error(`git diff ${base}...HEAD failed: ${e.message}. The gate cannot compute the changed surface; fix the diff base (fetch-depth / merge-base) rather than skipping the scan.`);
  }
  const lines = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) lines.push(line.slice(1));
  }
  return lines.join("\n");
}

/**
 * Every file path the PR touched OR renamed-FROM (old side), so a route whose
 * string lives only in a Next.js file path is still seen. `--name-status -M`
 * yields rename pairs; we take both the old and new path. With no base, all
 * tracked files. Fails closed to [] on error (the content diff already
 * fail-louds, so this is a best-effort supplement, not the primary signal).
 */
export function touchedPaths(base, cwd = process.cwd()) {
  if (!base) return changedFiles(null, cwd);
  let out;
  try {
    out = execFileSync(
      "git",
      ["--literal-pathspecs", "diff", "--name-status", "-z", "-M", "-C", "--end-of-options", `${base}...HEAD`],
      { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch { return []; }
  const parts = out.split("\0");
  const paths = new Set();
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (!status) { i += 1; continue; }
    if (status.startsWith("R") || status.startsWith("C")) {
      if (parts[i + 1]) paths.add(parts[i + 1]); // old path (rename-from)
      if (parts[i + 2]) paths.add(parts[i + 2]); // new path
      i += 3;
    } else {
      if (parts[i + 1]) paths.add(parts[i + 1]);
      i += 2;
    }
  }
  return [...paths];
}

/**
 * Derive route strings from Next.js-style route file paths so a pure route-file
 * RENAME (string only in the path, file contents unchanged) is still flagged.
 * `(src/)?app/api/agents/[id]/route.ts` -> `/api/agents/[id]`. Only `route.*`
 * files under an `app/` segment are mapped; everything else returns nothing.
 * Returned as a newline-joined blob so the same ROUTE_RE pass picks them up.
 */
export function pathDerivedRoutes(paths) {
  const out = [];
  for (const p of paths) {
    const m = p.match(/(?:^|\/)app\/(.+?)\/route\.[a-z]+$/i);
    if (!m) continue;
    // Strip Next route groups `(group)` (they don't appear in the URL) and join.
    const segs = m[1].split("/").filter((s) => s && !/^\(.*\)$/.test(s));
    if (!segs.length) continue;
    out.push("/" + segs.join("/"));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// SKILL.md index: which identifiers each skill references
// ---------------------------------------------------------------------------

/** Recursively list every SKILL.md under a directory. */
export function listSkillFiles(skillsDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === "SKILL.md") out.push(full);
    }
  }
  walk(skillsDir);
  return out.sort();
}

/**
 * Build the HEURISTIC index: identifier -> Set(skill relpaths) that reference it
 * verbatim, keyed by class. Reads every SKILL.md once and extracts the same
 * identifier classes used on the diff, so matching is symmetric.
 *
 * v2: a skill that DECLARES a non-empty `cinatra-watches` block is EXCLUDED from
 * the heuristic index (its declared watches are authoritative; the verbatim
 * heuristic would only re-introduce the noise the watches exist to silence). The
 * caller passes `declaredSkills` (a Set of rel paths) so the exclusion is decided
 * once, centrally, in main(). Undeclared skills (no block, or an empty block) are
 * indexed exactly as v1.
 */
export function buildSkillIndex(skillsDir, opts = {}) {
  const declared = opts.declaredSkills instanceof Set ? opts.declaredSkills : null;
  const files = listSkillFiles(skillsDir);
  const index = { primitives: new Map(), packages: new Map(), routes: new Map() };
  for (const file of files) {
    const rel = path.relative(skillsDir, file);
    if (declared && declared.has(rel)) continue; // declared => watches-only, no heuristic
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const { primitives, packages, routes } = extractIdentifiers(text, opts);
    for (const [cls, set] of [["primitives", primitives], ["packages", packages], ["routes", routes]]) {
      for (const id of set) {
        if (!index[cls].has(id)) index[cls].set(id, new Set());
        index[cls].get(id).add(rel);
      }
    }
  }
  return { files, index };
}

// ---------------------------------------------------------------------------
// Skill-declared watches (cinatra#188 §2 — preferred, low false-positive)
//
// A SKILL.md MAY declare, in its YAML frontmatter, the cinatra surfaces it
// depends on. We do NOT pull in a YAML library (zero-dep contract). The block
// is shallow and shaped exactly — `cinatra-watches:` with up to four list-of-
// string keys — so a tiny, STRICT, fail-loud parser is both sufficient and
// safer than a permissive YAML load (a typo'd key must break, not silently parse
// to "no watches" and create a false negative).
//
// DUAL-READ (Skills cluster Wave-0). The upstream Anthropic SKILL.md validator
// (`quick_validate.py`) only permits these TOP-LEVEL frontmatter keys: name,
// description, license, allowed-tools, metadata. A bare top-level
// `cinatra-watches:` key trips it, so skills migrate the declaration UNDER
// `metadata:`:
//
//     metadata:
//       cinatra-watches:
//         primitives: [agent_run]
//
// `parseWatches` therefore reads `metadata.cinatra-watches` PREFERRED and FALLS
// BACK to the legacy top-level `cinatra-watches:` — so already-migrated skills
// and not-yet-migrated skills both keep precise coverage. A later wave removes
// the legacy fallback. The strict, fail-loud child-mapping grammar is identical
// in both locations (only the base indentation differs). A skill declaring the
// block in BOTH locations is AMBIGUOUS and fails loud (keep exactly one).
// ---------------------------------------------------------------------------

const WATCH_KEYS = ["primitives", "packages", "routes", "paths"];

export class WatchParseError extends Error {}

/**
 * Extract the raw frontmatter block (between the first two `---` fences) from a
 * SKILL.md. Returns the inner text, or null if there is no frontmatter.
 */
export function extractFrontmatter(text) {
  // Frontmatter must start at the very top of the file.
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  return m ? m[1] : null;
}

// A blank or comment-only frontmatter line carries no structure. Such lines are
// skipped when determining mapping membership / child indentation so a `# note`
// can never be mistaken for a key (and never sets the metadata child indent).
function isBlankOrComment(line) {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

// Strip a trailing `# comment` from a value, mirroring how unquoteScalar treats
// comments. A value that IS a comment (starts with `#`, after the key's `\s*`
// has consumed the separating space) collapses to empty — so a comment-only
// value such as `cinatra-watches: # note` is treated as "no inline value" in the
// metadata location exactly as the legacy top-level regex already does.
function stripTrailingComment(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return "";
  const hash = trimmed.indexOf(" #");
  return (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim();
}

/**
 * Locate the `cinatra-watches:` mapping in the frontmatter lines, supporting
 * dual-read: PREFER `metadata.cinatra-watches` (nested under a top-level
 * `metadata:` block, the upstream-validator-compatible location), and FALL BACK
 * to the legacy TOP-LEVEL `cinatra-watches:`. Returns the index of the
 * `cinatra-watches:` line and the indentation width of that key (0 for the
 * legacy top-level location, the metadata child indent for the nested one), so
 * the child-mapping grammar below can run identically in either spot.
 *
 * FAIL-LOUD (codex convergence). Both locations are ALWAYS scanned and the
 * legacy inline-value guard still runs even when a metadata block is present, so
 * a malformed legacy declaration can never silently slip past the gate. If BOTH
 * a valid `metadata.cinatra-watches` block AND a legacy top-level
 * `cinatra-watches:` key are present, that is an AMBIGUOUS declaration and we
 * refuse to guess — fail loud and require the author to keep exactly one. A
 * `cinatra-watches:` key (in either location) carrying an inline value also
 * fails loud (it must be a block mapping).
 *
 * Returns null when no `cinatra-watches:` key exists in either location.
 */
function locateWatchesBlock(lines, skillLabel) {
  const inlineError = () =>
    new WatchParseError(`${skillLabel}: \`cinatra-watches:\` must be a mapping (a block of indented keys), not an inline value`);

  // Preferred location: `metadata:` (top-level mapping) -> `cinatra-watches:`.
  // `metadata:` may carry a trailing comment (`metadata: # ...`).
  let metadataHit = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^metadata:\s*(#.*)?$/.test(lines[i])) continue;
    // Scan metadata's child lines for `cinatra-watches:`. A non-indented line
    // ends the metadata mapping. Determine the child indent from the first
    // STRUCTURAL (non-blank, non-comment) child so a `# note` line never sets it.
    let childIndent = null;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (isBlankOrComment(line)) continue;
      const indent = line.length - line.replace(/^\s+/, "").length;
      if (indent === 0) break; // end of metadata mapping
      if (childIndent === null) childIndent = indent;
      if (indent !== childIndent) continue; // deeper nesting — not a direct child
      const m = /^(\s+)cinatra-watches:\s*(.*)$/.exec(line);
      if (m) {
        if (stripTrailingComment(m[2]) !== "") throw inlineError();
        metadataHit = { keyIdx: j, keyIndent: m[1].length };
        break;
      }
    }
    break; // only the first top-level `metadata:` mapping is considered
  }

  // Legacy location: top-level `cinatra-watches:` (no indentation). ALWAYS scan
  // — even when a metadata block exists — so the legacy inline-value guard runs
  // and a co-present legacy block is detected (ambiguity below).
  let legacyHit = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^cinatra-watches:\s*(#.*)?$/.test(lines[i])) { legacyHit = { keyIdx: i, keyIndent: 0 }; break; }
    if (/^cinatra-watches:\s*\S/.test(lines[i])) throw inlineError();
  }

  if (metadataHit && legacyHit) {
    throw new WatchParseError(`${skillLabel}: \`cinatra-watches:\` is declared in BOTH \`metadata.cinatra-watches\` and a legacy top-level \`cinatra-watches:\` — keep exactly one (prefer \`metadata.cinatra-watches\`)`);
  }
  return metadataHit ?? legacyHit;
}

/**
 * Parse a `cinatra-watches:` block from a SKILL.md's frontmatter. STRICT and
 * fail-loud (throws WatchParseError) on anything malformed, so a typo can never
 * silently disable a watch (HIGH-2). Recognizes two list syntaxes under each
 * watch key: a flow array (`primitives: [a, b]`) and a YAML block sequence
 * (`primitives:` then `  - a`). Both yield a list of trimmed, unquoted strings.
 *
 * Dual-read (Skills cluster Wave-0): the block is read from
 * `metadata.cinatra-watches` PREFERRED, falling back to the legacy top-level
 * `cinatra-watches:`. The grammar is identical in both locations.
 *
 * Returns:
 *   - null            => no `cinatra-watches:` key at all (skill is UNDECLARED).
 *   - { primitives, packages, routes, paths } (each a string[]; possibly empty)
 *
 * An all-empty result is returned as-is; main() treats "declared but all classes
 * empty" as UNDECLARED (falls back to heuristic — HIGH-2), but a block with at
 * least one non-empty class makes the skill "declared".
 */
export function parseWatches(text, { skillLabel = "SKILL.md" } = {}) {
  const fm = extractFrontmatter(text);
  if (fm == null) return null;
  const lines = fm.split(/\r?\n/);

  const located = locateWatchesBlock(lines, skillLabel);
  if (located == null) return null; // no cinatra-watches key in either location
  // The watch-key mapping is nested under `cinatra-watches:`. Its child keys
  // (primitives/…) must be indented strictly MORE than the `cinatra-watches:`
  // key itself, so the grammar works at top-level (keyIndent 0) and nested under
  // `metadata:` (keyIndent = the metadata child indent) alike.
  const baseIndent = located.keyIndent;

  const watches = { primitives: [], packages: [], routes: [], paths: [] };
  const seen = new Set();
  let seenAny = false;
  let i = located.keyIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i += 1; continue; }
    const indent = line.length - line.replace(/^\s+/, "").length;
    // A line at or below the `cinatra-watches:` indent ends its mapping.
    if (indent <= baseIndent) break;
    // A watch key, indented under cinatra-watches. Capture the key and either an
    // inline flow array or the following block sequence.
    const keyMatch = /^(\s+)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!keyMatch) {
      throw new WatchParseError(`${skillLabel}: cannot parse \`cinatra-watches\` line: ${JSON.stringify(line)}`);
    }
    const key = keyMatch[2];
    const inline = keyMatch[3];
    if (!WATCH_KEYS.includes(key)) {
      throw new WatchParseError(`${skillLabel}: unknown cinatra-watches key \`${key}\` (allowed: ${WATCH_KEYS.join(", ")})`);
    }
    if (seen.has(key)) throw new WatchParseError(`${skillLabel}: cinatra-watches \`${key}\` declared more than once`);
    seen.add(key);
    seenAny = true;
    let values;
    if (inline !== "") {
      // Inline flow array: `[a, "b", 'c']`. Anything else is malformed.
      const fa = /^\[(.*)\]$/.exec(inline.trim());
      if (!fa) {
        throw new WatchParseError(`${skillLabel}: cinatra-watches \`${key}\` must be a list (a flow array \`[...]\` or a block sequence of \`- item\` lines), got: ${JSON.stringify(inline)}`);
      }
      values = fa[1].trim() === "" ? [] : fa[1].split(",").map((s) => unquoteScalar(s, key, skillLabel));
      i += 1;
    } else {
      // Block sequence: subsequent more-indented `- item` lines.
      values = [];
      i += 1;
      const itemIndent = keyMatch[1].length;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") { i += 1; continue; }
        const im = /^(\s+)-\s+(.*)$/.exec(l);
        if (!im || im[1].length <= itemIndent) break;
        values.push(unquoteScalar(im[2], key, skillLabel));
        i += 1;
      }
    }
    // A PRESENT watch key with ZERO items is MALFORMED — fail loud (HIGH-1). If
    // you declared `paths:` you must list at least one glob; an empty key must
    // never silently collapse a real (e.g. path-only) watch to "no watches" and
    // fall back to the heuristic. The only "undeclared" case is the COMPLETE
    // ABSENCE of a `cinatra-watches:` block.
    if (values.length === 0) {
      throw new WatchParseError(`${skillLabel}: cinatra-watches \`${key}\` is present but empty — list at least one item or remove the key (an empty watch class is a silent false-negative)`);
    }
    for (const v of values) {
      if (v === "") throw new WatchParseError(`${skillLabel}: cinatra-watches \`${key}\` has an empty list item`);
      watches[key].push(v);
    }
  }

  if (!seenAny) {
    // `cinatra-watches:` present but with NO recognized child keys — malformed.
    throw new WatchParseError(`watches block under \`cinatra-watches:\` has no recognized keys (allowed: ${WATCH_KEYS.join(", ")})`);
  }
  return watches;
}

/**
 * Parse a single scalar list item into its string value. STRICT — rejects
 * anything that is not a plain (optionally quoted) scalar so a structured YAML
 * item can never be silently swallowed as a literal (HIGH-2) and a quoted item
 * with a trailing comment is read correctly (MED-1). Throws WatchParseError on a
 * malformed item rather than guessing.
 */
function unquoteScalar(raw, key, skillLabel) {
  const s = raw.trim();
  const bad = () => new WatchParseError(`${skillLabel}: cinatra-watches \`${key}\` has a malformed list item: ${JSON.stringify(raw)} (expected a plain string, optionally quoted)`);

  if (s === "") return "";
  // Quoted scalar: `"value"` or `'value'`, optionally followed by an inline
  // `# comment`. Read the quoted body; reject any non-comment trailing text.
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    const m = new RegExp(`^${q}((?:[^${q}\\\\]|\\\\.)*)${q}\\s*(?:#.*)?$`).exec(s);
    if (!m) throw bad();
    return m[1].replace(/\\(["'\\])/g, "$1");
  }
  // Unquoted scalar. Strip a trailing ` # comment`, then validate. A nested
  // mapping (`glob: foo`), a flow collection (`[`, `{`), or any YAML structure
  // is NOT a scalar — fail loud (HIGH-2) rather than index a bogus literal.
  let v = s;
  const hash = v.indexOf(" #");
  if (hash !== -1) v = v.slice(0, hash).trim();
  if (v === "") throw bad();
  // A `key: value` shape (a nested mapping) or a leading flow char is structured.
  if (/[[\]{}]/.test(v) || /^[A-Za-z0-9_.@/*?-]+:\s/.test(v) || /:\s*$/.test(v)) throw bad();
  return v;
}

/** True iff a parsed watches object has at least one non-empty watch class. */
export function hasDeclaredWatches(watches) {
  return Boolean(watches) && WATCH_KEYS.some((k) => watches[k] && watches[k].length > 0);
}

/**
 * Validate a declared watch value for the string classes (primitives / packages
 * / routes) against the SAME grammar `extractIdentifiers` uses, by round-trip:
 * the value must extract back out as exactly itself in its class. A value the
 * extractor can NEVER produce (e.g. `agent-run` with a hyphen, `cinatra-ai/foo`
 * without the `@` scope, `api/foo` without the leading `/`) would parse fine but
 * silently never match the diff — and because the skill is "declared" it would
 * also lose heuristic fallback, fully disabling its coverage. So such a value is
 * MALFORMED: throw (codex r2 HIGH). `paths` are globs (a different grammar) and
 * are validated separately (non-empty, no `paths`-specific round-trip).
 */
export function validateWatchSurface(cls, value, skillLabel, extractOpts = {}) {
  // Use the SAME extractOpts (e.g. config primitiveStopwords) the diff extractor
  // uses (codex r3 MED): if a configured stopword would suppress this primitive
  // on the diff side, the value can never match — so it must fail validation here
  // too (the round-trip below extracts to empty and throws).
  const { primitives, packages, routes } = extractIdentifiers(value, extractOpts);
  const set = cls === "primitives" ? primitives : cls === "packages" ? packages : routes;
  if (!(set.size === 1 && set.has(value))) {
    throw new WatchParseError(`${skillLabel}: cinatra-watches \`${cls}\` value ${JSON.stringify(value)} is not a valid ${cls.replace(/s$/, "")} surface the gate can match — it can never match the diff (a typo, or a configured primitiveStopword, would silently disable this skill's drift coverage). Use an exact ${cls === "packages" ? "@cinatra-ai/<slug> package name" : cls === "routes" ? "/<root>/<segment> route string" : "lower_snake_case primitive name (and not a configured stopword)"}.`);
  }
}

// ---------------------------------------------------------------------------
// Path globs (the `paths:` watch class) — matched against the PR's touched files
// ---------------------------------------------------------------------------

/**
 * Compile a single path glob into a RegExp. Supports:
 *   - `**` => any number of path segments (including zero) / any chars across `/`
 *   - `*`  => any chars within a single path segment (does not cross `/`)
 *   - `?`  => a single non-`/` char
 *   - everything else is a literal (regex-escaped)
 * Globs and paths are normalized to repo-root-relative POSIX (leading `./`
 * stripped) before matching.
 */
export function globToRegExp(glob) {
  const g = glob.replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**` — optionally followed by `/` to mean "any depth, or nothing".
        if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Given a list of `paths` globs and the PR's touched file paths (both rename
 * sides — touchedPaths already returns old+new), return the SET of globs that
 * matched at least one touched path. Returned per-glob so the report can name
 * exactly which declared path surface changed.
 */
export function matchPathGlobs(globs, touched) {
  const norm = touched.map((p) => p.replace(/^\.\//, ""));
  const hits = new Set();
  for (const glob of globs) {
    const re = globToRegExp(glob);
    if (norm.some((p) => re.test(p))) hits.add(glob);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Watch index: declared surface -> skills, across all skills with watches
// ---------------------------------------------------------------------------

/**
 * Build the WATCH index from every SKILL.md that declares a non-empty
 * `cinatra-watches` block. Returns:
 *   - watchIndex: { primitives, packages, routes, paths } each a Map(surface ->
 *     Set(skill relpaths)) — string classes for exact intersect, `paths` for glob
 *     matching against touched files.
 *   - declaredSkills: Set(rel) of skills that are "declared" (suppress heuristic).
 *
 * FAIL-LOUD: a malformed `cinatra-watches` block throws (caller exits 2).
 */
export function buildWatchIndex(skillsDir, extractOpts = {}) {
  const files = listSkillFiles(skillsDir);
  const watchIndex = { primitives: new Map(), packages: new Map(), routes: new Map(), paths: new Map() };
  const declaredSkills = new Set();
  for (const file of files) {
    const rel = path.relative(skillsDir, file);
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    let watches;
    try { watches = parseWatches(text, { skillLabel: rel }); }
    catch (e) {
      // Re-throw with the skill path so main() can fail loud with a clear pointer.
      throw new WatchParseError(`${rel}: ${e.message}`);
    }
    if (!hasDeclaredWatches(watches)) continue; // undeclared / empty => heuristic
    declaredSkills.add(rel);
    for (const cls of WATCH_KEYS) {
      for (const surface of watches[cls]) {
        // Validate string-class surfaces against the extractor grammar (with the
        // SAME extractOpts the diff side uses) — a value the extractor can never
        // produce would silently never match (codex r2 HIGH / r3 MED). `paths`
        // are globs (validated by non-emptiness in parseWatches).
        if (cls !== "paths") validateWatchSurface(cls, surface, rel, extractOpts);
        if (!watchIndex[cls].has(surface)) watchIndex[cls].set(surface, new Set());
        watchIndex[cls].get(surface).add(rel);
      }
    }
  }
  return { watchIndex, declaredSkills };
}

/**
 * Intersect the PR-diff identifiers AND touched paths with the watch index.
 * Returns watch findings: { class, identifier, skills, source: "watch" }.
 * `primitives|packages|routes` intersect exact strings; `paths` glob-matches the
 * touched file list. Pure given (diffIds, touched, watchIndex).
 */
export function intersectWatches(diffIds, touched, watchIndex) {
  const findings = [];
  for (const cls of ["primitives", "packages", "routes"]) {
    const idx = watchIndex[cls];
    if (!idx || idx.size === 0) continue;
    for (const id of diffIds[cls]) {
      const skills = idx.get(id);
      if (skills && skills.size) {
        findings.push({ class: cls, identifier: id, skills: [...skills].sort(), source: "watch" });
      }
    }
  }
  if (watchIndex.paths && watchIndex.paths.size) {
    const globs = [...watchIndex.paths.keys()];
    const matched = matchPathGlobs(globs, touched);
    for (const glob of matched) {
      const skills = watchIndex.paths.get(glob);
      findings.push({ class: "path", identifier: glob, skills: [...skills].sort(), source: "watch" });
    }
  }
  findings.sort((a, b) => (a.class === b.class ? a.identifier.localeCompare(b.identifier) : a.class.localeCompare(b.class)));
  return findings;
}

// ---------------------------------------------------------------------------
// Core: intersect PR-diff identifiers with the skill index
// ---------------------------------------------------------------------------

/**
 * Given identifiers extracted from the PR diff and the HEURISTIC skill index,
 * return findings: { class, identifier, skills: [relpaths], source: "heuristic" }.
 * Pure — no git, no fs — so it is unit-testable from fixtures. Heuristic findings
 * are ADVISORY only: they are reported in every mode but never gate enforce.
 */
export function intersect(diffIds, skillIndex) {
  const findings = [];
  for (const cls of ["primitives", "packages", "routes"]) {
    const idx = skillIndex[cls];
    for (const id of diffIds[cls]) {
      const skills = idx.get(id);
      if (skills && skills.size) {
        findings.push({ class: cls, identifier: id, skills: [...skills].sort(), source: "heuristic" });
      }
    }
  }
  // Stable order: class, then identifier.
  findings.sort((a, b) => (a.class === b.class ? a.identifier.localeCompare(b.identifier) : a.class.localeCompare(b.class)));
  return findings;
}

// ---------------------------------------------------------------------------
// Acknowledgements (parsed, reported; do not gate in warn mode)
// ---------------------------------------------------------------------------

// `[^\S\r\n]*` = horizontal whitespace ONLY. A plain `\s*` would consume the
// newline, so `Skills-unaffected:\n<next line>` would wrongly parse <next line>
// as the reason and clear the gate (codex r3 MED). The value is the REST OF THE
// SAME LINE only.
const SKILLS_REVIEWED_RE = /^Skills-reviewed:[^\S\r\n]*(.+)$/im;
const SKILLS_UNAFFECTED_RE = /^Skills-unaffected:[^\S\r\n]*(.+)$/im;
// Linked assistant-skills PR ack. Format (the `covers:` list is REQUIRED for it
// to satisfy anything — HIGH-3): `Skills-PR: <url-or-#n> covers: <slug>[, <slug>]`.
// Multiple `Skills-PR:` lines are allowed (one per linked PR).
const SKILLS_PR_RE = /^Skills-PR:[^\S\r\n]*(.+)$/gim;
const COVERS_RE = /\bcovers:\s*(.+)$/i;
// A Skills-PR ref must be a REAL assistant-skills PR reference, not arbitrary
// text — `#123`, `123`, `GH-123`, or an assistant-skills PR URL. Otherwise
// `Skills-PR: nonsense covers: <skill>` would clear the gate (codex LOW).
const SKILLS_PR_REF_RE = /^(?:#\d+|gh-\d+|\d+|https?:\/\/github\.com\/[^/\s]+\/assistant-skills\/pull\/\d+)$/i;

/**
 * Normalize a skill reference (a slug or a SKILL.md relpath) to its slug — the
 * directory name. `chat-agent-dispatch/SKILL.md` -> `chat-agent-dispatch`;
 * `chat-agent-dispatch` -> `chat-agent-dispatch`. Used to match `covers:` slugs
 * against impacted-skill relpaths.
 */
export function skillSlug(ref) {
  let s = String(ref).trim().replace(/^\.\//, "");
  s = s.replace(/\/SKILL\.md$/i, "");
  const parts = s.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/**
 * Parse ack markers from a text blob (PR body / commit messages / ack file).
 * Returns:
 *   - reviewed:   string|null  — non-empty note asserting checked+updated.
 *   - unaffected: string|null  — recorded override; only a NON-EMPTY reason counts
 *                                (the issue: not `Skills-unaffected:` only).
 *   - linkedPRs:  [{ ref, covers: Set<slug> }]  — linked assistant-skills PRs and
 *                 the skill slugs each declares it covers (empty covers => covers
 *                 nothing; recorded but satisfies no finding).
 */
export function parseAcks(text) {
  if (!text) return { reviewed: null, unaffected: null, linkedPRs: [] };
  const r = text.match(SKILLS_REVIEWED_RE);
  const u = text.match(SKILLS_UNAFFECTED_RE);
  const reviewed = r && r[1].trim() ? r[1].trim() : null;
  const unaffected = u && u[1].trim() ? u[1].trim() : null;

  const linkedPRs = [];
  for (const m of text.matchAll(SKILLS_PR_RE)) {
    const value = m[1].trim();
    const cm = COVERS_RE.exec(value);
    const ref = (cm ? value.slice(0, cm.index) : value).trim();
    const covers = new Set();
    if (cm) {
      for (const part of cm[1].split(",")) {
        const slug = skillSlug(part);
        if (slug) covers.add(slug);
      }
    }
    // Only record a linked PR whose ref is a REAL assistant-skills PR reference;
    // arbitrary text must not be able to satisfy a finding (codex LOW). An
    // invalid ref is dropped (reported as no linked PR) so the finding stays open.
    if (ref && SKILLS_PR_REF_RE.test(ref)) linkedPRs.push({ ref, covers });
  }
  return { reviewed, unaffected, linkedPRs };
}

/**
 * Decide whether a single WATCH finding is satisfied by the parsed acks:
 *   (b) Skills-reviewed (non-empty) OR (c) Skills-unaffected (non-empty reason)
 *       cover ALL impacted skills (explicit human assertions over the whole PR);
 *   (a) a Skills-PR whose `covers:` set includes EVERY impacted skill of this
 *       finding (per-skill coverage — HIGH-3). A finding can touch multiple
 *       skills; ALL must be covered for the linked-PR ack to clear it.
 * Returns true iff satisfied.
 */
export function findingSatisfied(finding, acks) {
  if (acks.reviewed || acks.unaffected) return true;
  // Union the `covers:` sets across ALL linked Skills-PR lines (MED-2): a
  // multi-skill finding can be covered by several PRs, one per skill.
  const covered = new Set();
  for (const pr of acks.linkedPRs) for (const slug of pr.covers) covered.add(slug);
  return finding.skills.map(skillSlug).every((slug) => covered.has(slug));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error(`[skills-drift-gate] ${msg}`);
  process.exit(2);
}

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
    } else if (VALUE_FLAGS.has(key) || key === "mode") {
      const value = eq !== -1 ? tok.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (eq === -1 && String(value).startsWith("--"))) {
        fail(`--${key} requires a value`);
      }
      args[key] = value;
    } else {
      fail(`unknown flag --${key}`);
    }
  }
  return args;
}

function loadConfig(p) {
  if (!p) return {};
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch { fail(`--config not readable: ${p}`); }
  try { return JSON.parse(raw); } catch (e) { fail(`--config is not valid JSON (${p}): ${e.message}`); }
}

const GH = process.env.GITHUB_ACTIONS === "true";
function annotate(level, msg) {
  // GitHub workflow command — surfaces as an annotation. Warning level keeps the
  // check neutral/green while still being visible in the PR Checks/Files tabs.
  if (GH) process.stdout.write(`::${level}::${msg}\n`);
}

function emitStepSummary(lines) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  try { fs.appendFileSync(f, lines.join("\n") + "\n"); } catch { /* non-fatal */ }
}

function buildReport({ watchFindings, heuristicFindings, mode, skillCount, declaredCount, acks, skillsRef }) {
  const allFindings = [...watchFindings, ...heuristicFindings];
  const bySkill = new Map();
  for (const f of allFindings) for (const s of f.skills) {
    if (!bySkill.has(s)) bySkill.set(s, []);
    bySkill.get(s).push(`${f.identifier} (${f.class}, ${f.source})`);
  }
  // Per-watch-finding satisfaction (only watch findings can gate enforce).
  const watchFindingsAnnotated = watchFindings.map((f) => ({ ...f, satisfied: findingSatisfied(f, acks) }));
  const unacknowledgedWatchFindings = watchFindingsAnnotated.filter((f) => !f.satisfied);
  return {
    gateVersion: GATE_VERSION,
    mode,
    skillsRef: skillsRef || null,
    skillsScanned: skillCount,
    skillsWithWatches: declaredCount,
    findingCount: allFindings.length,
    watchFindingCount: watchFindings.length,
    heuristicFindingCount: heuristicFindings.length,
    unacknowledgedWatchFindingCount: unacknowledgedWatchFindings.length,
    findings: [...watchFindingsAnnotated, ...heuristicFindings],
    watchFindings: watchFindingsAnnotated,
    heuristicFindings,
    impactedSkills: [...bySkill.entries()].map(([skill, surfaces]) => ({ skill, surfaces })).sort((a, b) => a.skill.localeCompare(b.skill)),
    acknowledgements: acks,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode || "warn";
  if (!VALID_MODES.includes(mode)) fail(`unknown --mode '${mode}' (valid: ${VALID_MODES.join(", ")})`);
  const format = args.format || "text";
  if (!VALID_FORMATS.includes(format)) fail(`unknown --format '${format}' (valid: ${VALID_FORMATS.join(", ")})`);
  const quiet = Boolean(args.quiet);

  const skillsDir = args["skills-dir"];
  if (!skillsDir) fail("--skills-dir is required (the checked-out assistant-skills working tree, or its skills/ dir)");
  let sStat;
  try { sStat = fs.statSync(skillsDir); } catch { sStat = null; }
  if (!sStat || !sStat.isDirectory()) {
    // Fail loud if the pinned assistant-skills checkout can't be resolved — a
    // missing/unresolvable pin must never silently pass (cinatra#188 §limitations).
    fail(`--skills-dir does not resolve to a directory: ${skillsDir} (assistant-skills pin unresolved?)`);
  }

  const config = loadConfig(args.config);
  const extractOpts = config.primitiveStopwords
    ? { primitiveStopwords: new Set([...DEFAULT_PRIMITIVE_STOPWORDS, ...config.primitiveStopwords]) }
    : {};

  // 1) DECLARED WATCHES (preferred). Fail loud on a malformed `cinatra-watches`
  //    block — a typo must break the gate, never silently disable a watch.
  let watchIndex, declaredSkills;
  try { ({ watchIndex, declaredSkills } = buildWatchIndex(skillsDir, extractOpts)); }
  catch (e) {
    if (e instanceof WatchParseError) fail(`malformed cinatra-watches block — ${e.message} (fix the watch declaration; the gate will not run on an ambiguous watch)`);
    throw e;
  }

  // 2) HEURISTIC FALLBACK for UNDECLARED skills only (declared skills are
  //    watches-only — passing declaredSkills suppresses their heuristic noise).
  const { files: skillFiles, index } = buildSkillIndex(skillsDir, { ...extractOpts, declaredSkills });
  if (skillFiles.length === 0) {
    fail(`no SKILL.md found under ${skillsDir} — assistant-skills pin looks wrong (fail loud, not a silent pass)`);
  }

  const base = resolveDiffBase({ explicit: args["diff-base"], envVarName: args["diff-base-env"] || DEFAULT_DIFF_BASE_ENV });
  // Content diff (added + removed lines) PLUS routes derived from touched/renamed
  // Next.js route file paths — so a pure route-file rename (string only in the
  // path) is still flagged. changedDiffText fail-louds on a diff error.
  const touched = touchedPaths(base);
  const diffText = changedDiffText(base) + "\n" + pathDerivedRoutes(touched);
  const diffIds = extractIdentifiers(diffText, extractOpts);

  // Watch findings (string classes intersect diff ids; `path` class glob-matches
  // touched files — catches param-shape changes that leave the string untouched).
  const watchFindings = intersectWatches(diffIds, touched, watchIndex);
  // Heuristic findings (undeclared skills) — advisory only, never gate.
  const heuristicFindings = intersect(diffIds, index);

  // Acknowledgements: parse from an optional ack-file (PR body + commit trailers
  // concatenated by the caller). Reported; gate ONLY unacknowledged WATCH findings.
  let ackText = "";
  if (args["ack-file"]) {
    try { ackText = fs.readFileSync(args["ack-file"], "utf8"); } catch { ackText = ""; }
  }
  const acks = parseAcks(ackText);

  const skillsRef = process.env.SKILLS_DRIFT_PINNED_REF || null;
  const report = buildReport({ watchFindings, heuristicFindings, mode, skillCount: skillFiles.length, declaredCount: declaredSkills.size, acks, skillsRef });

  const MODE_LABEL = mode.toUpperCase();
  const allFindings = report.findings;
  const unackWatch = report.unacknowledgedWatchFindingCount;
  const scannedNote = `${skillFiles.length} SKILL.md scanned, ${report.skillsWithWatches} with declared watches${skillsRef ? `, pin ${skillsRef}` : ""}`;
  // In enforce mode an UNACKNOWLEDGED watch finding is what gates; heuristic
  // findings (and acknowledged watch findings) never gate — they are advisory.
  const willFail = mode === "enforce" && unackWatch > 0;

  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else if (!quiet) {
    if (allFindings.length === 0) {
      process.stderr.write(`skills-drift-gate: clean — no cinatra change touched an assistant-skills surface (${scannedNote}).\n`);
    } else {
      process.stderr.write(`skills-drift-gate [${mode}]: ${report.watchFindingCount} declared-watch + ${report.heuristicFindingCount} heuristic surface(s) changed; ${report.impactedSkills.length} skill(s) may be stale (${scannedNote}).\n`);
      for (const f of report.watchFindings) {
        process.stderr.write(`  [watch${f.satisfied ? ", acknowledged" : ""}] ${f.class}: ${f.identifier}  ->  ${f.skills.join(", ")}\n`);
      }
      for (const f of report.heuristicFindings) {
        process.stderr.write(`  [heuristic, advisory] ${f.class}: ${f.identifier}  ->  ${f.skills.join(", ")}\n`);
      }
      process.stderr.write("\nResolve a declared-watch finding by one of:\n");
      process.stderr.write("  (a) 'Skills-PR: <url-or-#n> covers: <skill-slug>[, ...]' — a linked assistant-skills PR naming the impacted skill(s); or\n");
      process.stderr.write("  (b) 'Skills-reviewed: <note>' — recorded checked + updated assertion; or\n");
      process.stderr.write("  (c) 'Skills-unaffected: <reason>' — recorded override (reason REQUIRED).\n");
      if (acks.reviewed) process.stderr.write(`  [ack] Skills-reviewed: ${acks.reviewed}\n`);
      if (acks.unaffected) process.stderr.write(`  [ack] Skills-unaffected: ${acks.unaffected}\n`);
      for (const pr of acks.linkedPRs) process.stderr.write(`  [ack] Skills-PR: ${pr.ref} covers: ${[...pr.covers].join(", ") || "(none — covers nothing)"}\n`);
      if (mode === "enforce") {
        process.stderr.write(unackWatch > 0
          ? `\nenforce: ${unackWatch} unacknowledged declared-watch finding(s) — FAILING. Heuristic findings are advisory and do not gate.\n`
          : `\nenforce: all declared-watch findings acknowledged — passing. Heuristic findings are advisory and do not gate.\n`);
      }
    }
  }

  // GitHub annotations + step summary. Warn-level annotations keep the check
  // green; in enforce mode an unacknowledged watch finding is an ERROR annotation
  // and the process exits 1. Annotations write `::level::` lines to STDOUT — in
  // `--format json` mode the JSON report already owns stdout, so suppress the
  // stdout annotations there to avoid corrupting the machine-readable stream
  // (codex r4 MED). The step summary (a separate file) is always safe to emit.
  const emitAnnotations = format !== "json";
  if (allFindings.length > 0) {
    if (emitAnnotations) for (const f of report.watchFindings) {
      const level = (mode === "enforce" && !f.satisfied) ? "error" : "warning";
      annotate(level, `skills-drift [watch]: ${f.skills.join(", ")} depends on changed surface ${f.identifier} (${f.class})${f.satisfied ? " — acknowledged" : ""}. Resolve via 'Skills-PR: <pr> covers: <skill>', 'Skills-reviewed:', or 'Skills-unaffected: <reason>'.`);
    }
    if (emitAnnotations) for (const f of report.heuristicFindings) {
      annotate("warning", `skills-drift [heuristic, advisory]: ${f.skills.join(", ")} mentions changed identifier ${f.identifier} (${f.class}). Advisory only — does not gate. Add a cinatra-watches block to the skill to make this precise.`);
    }
    const summary = [`## skills-drift-gate (${MODE_LABEL})`, "", `Mode: \`${mode}\`${skillsRef ? ` · assistant-skills pin: \`${skillsRef}\`` : ""} · ${scannedNote}`, "", `${report.watchFindingCount} declared-watch + ${report.heuristicFindingCount} heuristic surface(s) changed; ${report.impactedSkills.length} skill(s) may be stale.`];
    if (report.watchFindings.length) {
      summary.push("", "### Declared-watch findings" + (mode === "enforce" ? " (gating)" : ""), "", "| Surface | Class | Skill(s) | Status |", "| --- | --- | --- | --- |");
      for (const f of report.watchFindings) summary.push(`| \`${f.identifier}\` | ${f.class} | ${f.skills.map((s) => `\`${s}\``).join(", ")} | ${f.satisfied ? "acknowledged" : (mode === "enforce" ? "**unacknowledged — failing**" : "unacknowledged")} |`);
    }
    if (report.heuristicFindings.length) {
      summary.push("", "### Heuristic findings (advisory — never gate)", "", "| Identifier | Class | Skill(s) |", "| --- | --- | --- |");
      for (const f of report.heuristicFindings) summary.push(`| \`${f.identifier}\` | ${f.class} | ${f.skills.map((s) => `\`${s}\``).join(", ")} |`);
    }
    summary.push("", "Resolve a declared-watch finding by: a linked `Skills-PR: <pr> covers: <skill>`, a `Skills-reviewed:` trailer, or a `Skills-unaffected: <reason>` trailer.");
    if (acks.reviewed) summary.push("", `Acknowledged: \`Skills-reviewed: ${acks.reviewed}\``);
    if (acks.unaffected) summary.push("", `Acknowledged: \`Skills-unaffected: ${acks.unaffected}\``);
    for (const pr of acks.linkedPRs) summary.push("", `Acknowledged: \`Skills-PR: ${pr.ref}\` covers ${[...pr.covers].map((s) => `\`${s}\``).join(", ") || "(none)"}`);
    emitStepSummary(summary);
  } else {
    emitStepSummary([`## skills-drift-gate (${MODE_LABEL})`, "", `Clean — no cinatra change touched an assistant-skills surface. ${scannedNote}.`]);
  }

  // Exit. Fail-loud (exit 2) paths already ran above. enforce gates ONLY on an
  // unacknowledged declared-watch finding; warn (and heuristic findings in any
  // mode) never change the exit code.
  if (willFail) process.exit(1);
  process.exit(0);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); }
  catch { return false; }
}
if (isMainModule()) {
  try { main(); }
  catch (e) { console.error("[skills-drift-gate] gate failed:", e.message); process.exit(2); }
}

export {
  GATE_VERSION,
  DEFAULT_PRIMITIVE_STOPWORDS,
  WATCH_KEYS,
};
