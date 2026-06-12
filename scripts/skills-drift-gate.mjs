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
 * STAGE 1 — WARN MODE (this build): heuristic match. Extract identifiers from
 * the cinatra PR diff (added/changed lines, new side), intersect them with the
 * identifiers that appear verbatim in any SKILL.md, and emit a clear report as
 * a NON-FAILING warning (neutral/success with annotations). The documented
 * graduation path is skill-declared watches for enforcement (cinatra#188 §2).
 *
 * Acknowledgement markers (`Skills-reviewed:` / `Skills-unaffected: <reason>`)
 * are parsed and reported when present, but in warn mode they never change the
 * exit code — they exist so the enforce-mode upgrade is a one-flag change and so
 * the warn report already tells authors how to resolve a flag.
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

const GATE_VERSION = "0.1.0";
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

  // Collect packages first, then STRIP their spans before the primitive pass so
  // a slug's underscore tail (e.g. `@cinatra-ai/foo_bar`) is never re-read as a
  // phantom primitive `foo_bar`.
  for (const m of text.matchAll(PACKAGE_RE)) packages.add(m[0]);
  const working = text.replace(PACKAGE_RE, " ");

  for (const m of text.matchAll(ROUTE_RE)) {
    // Trim a trailing punctuation a sentence might append (`/api/agents/run.`).
    routes.add(m[0].replace(/[.,:;)]+$/, ""));
  }

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
 * Build an index: identifier -> Set(skill relative paths) that reference it,
 * keyed by class. Reads every SKILL.md once and extracts the same identifier
 * classes used on the diff, so matching is symmetric.
 */
export function buildSkillIndex(skillsDir, opts = {}) {
  const files = listSkillFiles(skillsDir);
  const index = { primitives: new Map(), packages: new Map(), routes: new Map() };
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const rel = path.relative(skillsDir, file);
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
// Core: intersect PR-diff identifiers with the skill index
// ---------------------------------------------------------------------------

/**
 * Given identifiers extracted from the PR diff and a skill index, return the
 * findings: each is { class, identifier, skills: [relpaths] }. Pure — no git,
 * no fs — so it is unit-testable from fixtures.
 */
export function intersect(diffIds, skillIndex) {
  const findings = [];
  for (const cls of ["primitives", "packages", "routes"]) {
    const idx = skillIndex[cls];
    for (const id of diffIds[cls]) {
      const skills = idx.get(id);
      if (skills && skills.size) {
        findings.push({ class: cls, identifier: id, skills: [...skills].sort() });
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

const SKILLS_REVIEWED_RE = /^Skills-reviewed:\s*(.+)$/im;
const SKILLS_UNAFFECTED_RE = /^Skills-unaffected:\s*(.+)$/im;

/** Parse ack markers from a text blob (PR body / commit messages / ack file). */
export function parseAcks(text) {
  if (!text) return { reviewed: null, unaffected: null };
  const r = text.match(SKILLS_REVIEWED_RE);
  const u = text.match(SKILLS_UNAFFECTED_RE);
  return {
    reviewed: r ? r[1].trim() : null,
    unaffected: u ? u[1].trim() : null,
  };
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

function buildReport(findings, { mode, skillCount, acks, skillsRef }) {
  const bySkill = new Map();
  for (const f of findings) for (const s of f.skills) {
    if (!bySkill.has(s)) bySkill.set(s, []);
    bySkill.get(s).push(`${f.identifier} (${f.class})`);
  }
  return {
    gateVersion: GATE_VERSION,
    mode,
    skillsRef: skillsRef || null,
    skillsScanned: skillCount,
    findingCount: findings.length,
    findings,
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

  const { files: skillFiles, index } = buildSkillIndex(skillsDir, extractOpts);
  if (skillFiles.length === 0) {
    fail(`no SKILL.md found under ${skillsDir} — assistant-skills pin looks wrong (fail loud, not a silent pass)`);
  }

  const base = resolveDiffBase({ explicit: args["diff-base"], envVarName: args["diff-base-env"] || DEFAULT_DIFF_BASE_ENV });
  // Content diff (added + removed lines) PLUS routes derived from touched/renamed
  // Next.js route file paths — so a pure route-file rename (string only in the
  // path) is still flagged. changedDiffText fail-louds on a diff error.
  const diffText = changedDiffText(base) + "\n" + pathDerivedRoutes(touchedPaths(base));
  const diffIds = extractIdentifiers(diffText, extractOpts);
  const findings = intersect(diffIds, index);

  // Acknowledgements: parse from an optional ack-file (PR body + commit trailers
  // concatenated by the caller). Reported; never gates in warn mode.
  let ackText = "";
  if (args["ack-file"]) {
    try { ackText = fs.readFileSync(args["ack-file"], "utf8"); } catch { ackText = ""; }
  }
  const acks = parseAcks(ackText);

  const skillsRef = process.env.SKILLS_DRIFT_PINNED_REF || null;
  const report = buildReport(findings, { mode, skillCount: skillFiles.length, acks, skillsRef });

  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else if (!quiet) {
    if (findings.length === 0) {
      process.stderr.write(`skills-drift-gate: clean — no cinatra change touched an assistant-skills surface (${skillFiles.length} SKILL.md scanned${skillsRef ? `, pin ${skillsRef}` : ""}).\n`);
    } else {
      process.stderr.write(`skills-drift-gate [${mode}]: ${findings.length} watched surface(s) changed; ${report.impactedSkills.length} skill(s) may be stale (${skillFiles.length} SKILL.md scanned${skillsRef ? `, pin ${skillsRef}` : ""}).\n`);
      for (const f of findings) {
        process.stderr.write(`  ${f.class}: ${f.identifier}  ->  ${f.skills.join(", ")}\n`);
      }
      process.stderr.write("\nResolve by one of:\n");
      process.stderr.write("  (a) link an assistant-skills PR that updates the impacted skill(s); or\n");
      process.stderr.write("  (b) add a 'Skills-reviewed: <note>' trailer (skills checked + updated); or\n");
      process.stderr.write("  (c) add a 'Skills-unaffected: <reason>' trailer (recorded override).\n");
      if (acks.reviewed) process.stderr.write(`  [ack] Skills-reviewed: ${acks.reviewed}\n`);
      if (acks.unaffected) process.stderr.write(`  [ack] Skills-unaffected: ${acks.unaffected}\n`);
    }
  }

  // GitHub annotations + step summary (warn level keeps the check green).
  if (findings.length > 0) {
    for (const s of report.impactedSkills) {
      annotate("warning", `skills-drift: ${s.skill} may be stale — changed surfaces: ${s.surfaces.join(", ")}. Resolve via linked assistant-skills PR, 'Skills-reviewed:', or 'Skills-unaffected: <reason>'.`);
    }
    const summary = ["## skills-drift-gate (WARN)", "", `Mode: \`${mode}\`${skillsRef ? ` · assistant-skills pin: \`${skillsRef}\`` : ""}`, "", `${findings.length} watched surface(s) changed; ${report.impactedSkills.length} skill(s) may be stale.`, "", "| Skill | Changed surface(s) |", "| --- | --- |"];
    for (const s of report.impactedSkills) summary.push(`| \`${s.skill}\` | ${s.surfaces.map((x) => `\`${x}\``).join(", ")} |`);
    summary.push("", "Resolve by: linked `assistant-skills` PR, a `Skills-reviewed:` trailer, or a `Skills-unaffected: <reason>` trailer.");
    if (acks.reviewed) summary.push("", `Acknowledged: \`Skills-reviewed: ${acks.reviewed}\``);
    if (acks.unaffected) summary.push("", `Acknowledged: \`Skills-unaffected: ${acks.unaffected}\``);
    emitStepSummary(summary);
  } else {
    emitStepSummary(["## skills-drift-gate (WARN)", "", `Clean — no cinatra change touched an assistant-skills surface. ${skillFiles.length} SKILL.md scanned.`]);
  }

  // WARN mode: always exit 0 (neutral/success). enforce mode would gate on an
  // unacknowledged finding — wired but intentionally unused in Stage 1.
  if (mode === "enforce") {
    const acked = Boolean(acks.reviewed || acks.unaffected);
    if (findings.length > 0 && !acked) process.exit(1);
  }
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
};
