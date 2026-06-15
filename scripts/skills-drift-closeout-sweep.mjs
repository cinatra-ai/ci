#!/usr/bin/env node
/**
 * skills-drift-closeout-sweep — RELEASE-closeout companion to the per-PR
 * skills-drift-gate (scripts/skills-drift-gate.mjs).
 *
 * WHY a sweep in addition to the per-PR gate. The per-PR gate flags a cinatra
 * PR that touches an assistant-skills watched surface and clears it with a live
 * PR-body / commit trailer ack. But:
 *   - Those live trailers DO NOT survive a squash-merge — by the time a release
 *     is cut, the per-PR acknowledgement evidence is gone from the squashed
 *     commit, so nothing re-proves at release time that the whole release range
 *     left no watched surface unreviewed.
 *   - A release also re-pins assistant-skills to a newer ref whose `cinatra-watches`
 *     declarations may have GROWN (a skill that did not watch a surface during a
 *     mid-release PR may watch it by release time). The release-current pin is
 *     the authority for what to reconcile against — not whatever pin each PR saw.
 *
 * The sweep, run at release closeout, therefore:
 *   1. BUMPS THE PIN FIRST — reconciles against the assistant-skills tree at the
 *      release-current `--skills-ref` (verified to be exactly what `--skills-dir`
 *      is checked out at), so it sees the release-current watch declarations, not
 *      a stale snapshot.
 *   2. DIFFS THE RELEASE RANGE — the watched/referenced surface intersection
 *      across `--base..--head` (previous release tag -> release head; first
 *      release: the empty tree -> head). base/head are EXPLICIT INPUTS, never
 *      auto-resolved to a moving ref — release tags are owner-gated, so the sweep
 *      must be handed the exact endpoints (it never guesses origin/main).
 *   3. HARVESTS ACKS FROM DURABLE RELEASE METADATA — NOT live per-PR trailers
 *      (which the squash dropped). Acks come from (a) the merged-commit messages
 *      in the `base..head` range (a squash-merge commit message DOES carry the PR
 *      title/number/body merged via GitHub's squash flow) and (b) a committed
 *      decision-log file READ FROM `--head` (`git show <head>:<path>`, never the
 *      mutable workspace copy — an uncommitted local ack must not satisfy the
 *      sweep), scoped to the current release section so a stale cumulative ack
 *      from an older release cannot mask a new finding.
 *   4. APPLIES THE SAME ACK SET as the per-PR gate (parseAcks): a linked
 *      assistant-skills update PR named in the bumped pin (`Skills-PR: <pr>
 *      covers: <slug>`), `Skills-reviewed: <note>`, or `Skills-unaffected:
 *      <reason>` (a reason is REQUIRED — never `Skills-unaffected:` alone).
 *      BUT the sweep is STRICTER than the per-PR gate about the run-global forms:
 *      over a whole release a single blanket `Skills-reviewed:` must NOT silently
 *      clear every flagged surface, so the sweep requires each finding's ack to be
 *      ATTRIBUTED to that finding's surface/skill (see findingResolved).
 *   5. BLOCKS — lists every unresolved flagged surface and exits non-zero until
 *      each is resolved (covered by a linked Skills-PR) or carries a recorded
 *      decision (a surface-scoped Skills-reviewed/Skills-unaffected). Fail-loud
 *      (exit 2) on any unresolvable input (bad ref, empty skill index, mismatched
 *      pin, malformed watches, git failure, missing required decision log).
 *
 * Engine REUSE (no duplicated matching logic): all identifier extraction, watch
 * parsing/indexing, intersection, and ack PARSING come from
 * scripts/skills-drift-gate.mjs. This file adds ONLY release-range git plumbing
 * (exact base..head, empty-tree first release) and a stricter, per-surface ack
 * RESOLUTION suited to a whole-release sweep.
 *
 * Zero runtime dependencies (node builtins + the shared engine only).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  extractIdentifiers,
  pathDerivedRoutes,
  buildSkillIndex,
  buildWatchIndex,
  intersectWatches,
  intersect,
  parseAcks,
  skillSlug,
  DEFAULT_PRIMITIVE_STOPWORDS,
} from "./skills-drift-gate.mjs";

const SWEEP_VERSION = "0.1.0";
// git's canonical empty tree — the base for a FIRST release (no previous tag).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const VALUE_FLAGS = new Set([
  "skills-dir", "skills-ref", "base", "head", "decision-log",
  "decision-log-section", "format", "config",
]);
const BOOLEAN_FLAGS = new Set(["quiet", "first-release"]);
const VALID_FORMATS = ["text", "json"];

// ---------------------------------------------------------------------------
// Release-range git plumbing (exact endpoints — distinct from the per-PR gate's
// `<base>...HEAD` merge-base semantics; the sweep must compare the EXACT release
// endpoints it is handed, never a working-tree HEAD or a guessed default ref).
// ---------------------------------------------------------------------------

function git(args, { cwd = process.cwd(), maxBuffer } = {}) {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    encoding: "utf8",
    cwd,
    maxBuffer: maxBuffer || 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Verify a ref resolves to a commit in `cwd`; throw loud (caller exits 2). */
function verifyRef(ref, cwd, label) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
      cwd, stdio: "ignore",
    });
  } catch {
    throw new SweepError(`${label} '${ref}' does not resolve to a commit in the release repo (fetch-depth / tag name?)`);
  }
}

/** Resolve a ref to its full 40-hex commit SHA in `cwd`. */
function revParse(ref, cwd) {
  return git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd }).trim();
}

/**
 * Changed/added file paths over the EXACT release range (both rename sides),
 * `base..head`. For a first release `base` is the empty tree (every file is
 * "added") — `git diff <empty-tree> <head>` is valid; a commit RANGE
 * (`<empty-tree>..<head>`) would not be, hence the two-arg diff form.
 */
function rangeTouchedPaths(base, head, cwd) {
  const out = git(
    ["diff", "--name-status", "-z", "-M", "-C", "--end-of-options", base, head],
    { cwd },
  );
  const parts = out.split("\0");
  const paths = new Set();
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (!status) { i += 1; continue; }
    if (status.startsWith("R") || status.startsWith("C")) {
      if (parts[i + 1]) paths.add(parts[i + 1]); // old (rename-from)
      if (parts[i + 2]) paths.add(parts[i + 2]); // new
      i += 3;
    } else {
      if (parts[i + 1]) paths.add(parts[i + 1]);
      i += 2;
    }
  }
  return [...paths];
}

/**
 * The changed text (both `+` and `-` lines, headers stripped) over the EXACT
 * release range `base..head`. Both sides matter — a rename drops the OLD
 * identifier on the `-` side and the SKILL.md still references the old name, so
 * the strongest drift signal lives on a removed line (same rationale as the
 * per-PR gate). Fail-loud on a diff error (a release sweep that silently reports
 * a clean range when the diff actually failed would let real drift ship).
 */
function rangeDiffText(base, head, cwd) {
  let out;
  try {
    out = git(
      ["diff", "--unified=0", "--no-color", "--end-of-options", base, head],
      { cwd, maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (e) {
    throw new SweepError(`git diff ${base} ${head} failed: ${e.message}. The sweep cannot compute the release surface; fix the base/head endpoints (fetch-depth / tag names) rather than skipping the scan.`);
  }
  const lines = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) lines.push(line.slice(1));
  }
  return lines.join("\n");
}

/**
 * Every commit message body in the release range. For a first release (base =
 * empty tree) there is no commit range, so we log everything reachable from head.
 * Squash-merge commit messages carry the merged PR's title/number/body, so a
 * Skills-* trailer authored in the PR description survives INTO the squashed
 * commit message — that is the durable post-squash ack source.
 */
function rangeCommitMessages(base, head, cwd, { firstRelease }) {
  const rev = firstRelease ? [head] : [`${base}..${head}`];
  let out;
  try {
    out = git(["log", "--no-color", "--format=%B%x00", "--end-of-options", ...rev], { cwd, maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    throw new SweepError(`git log over the release range failed: ${e.message}`);
  }
  // %x00 separates messages; join with blank lines for parseAcks (line-anchored).
  return out.split("\0").map((s) => s.trim()).filter(Boolean).join("\n\n");
}

/**
 * Read a committed decision-log file at the release HEAD (`git show <head>:<path>`)
 * — NEVER the mutable workspace copy. A local/uncommitted ack must not be able to
 * satisfy a release-blocking finding (rev-1 item 3). Returns the committed file
 * content, or null if the path does not exist at head.
 */
function readCommittedDecisionLog(head, relPath, cwd) {
  try {
    return git(["show", "--end-of-options", `${head}:${relPath}`], { cwd, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null; // absent at head — caller decides whether that is fatal
  }
}

/**
 * Scope a cumulative decision log to the CURRENT release section so a stale ack
 * from an OLDER release cannot mask a new finding (rev-1 item 4). The log is a
 * markdown file with `## <section>` headings (e.g. `## current-release`); given
 * `--decision-log-section`, return only the lines under that exact heading (up to
 * the next `## ` heading). With no section flag the whole file is used (the
 * caller is then explicitly opting into cumulative semantics).
 */
function sliceDecisionSection(text, section) {
  if (!section) return text;
  const lines = text.split(/\r?\n/);
  const wanted = `## ${section}`;
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inSection = line.trim() === wanted;
      continue;
    }
    if (inSection) out.push(line);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Sweep-specific ack RESOLUTION (stricter than the per-PR gate)
//
// The per-PR engine's `findingSatisfied` treats a single `Skills-reviewed:` /
// `Skills-unaffected:` as run-GLOBAL — correct when the run IS one PR. Over a
// whole release that is too loose: one blanket trailer in one merged commit must
// not silently clear EVERY flagged surface (rev-1 item 5). So the sweep requires
// each finding to be ATTRIBUTED to its own surface/skill:
//   - a linked `Skills-PR: <pr> covers: <slug>` whose covers-set includes EVERY
//     skill of the finding (per-skill — the same as the engine); OR
//   - a surface-scoped decision-log entry: `Skills-reviewed: <skill-or-surface> …`
//     or `Skills-unaffected: <skill-or-surface> — <reason>` whose leading token
//     names this finding's EXACT surface identifier, or every impacted skill slug.
// A bare release-wide `Skills-reviewed:`/`Skills-unaffected:`, OR a whole-CLASS
// token (`primitives`/`path`/…), with no EXACT-surface/all-skills attribution
// clears NOTHING in the sweep (a whole release can be all-one-class — a class
// token must never blanket-clear it).
// ---------------------------------------------------------------------------

const SCOPED_REVIEWED_RE = /^Skills-reviewed:[^\S\r\n]*(.+)$/gim;
const SCOPED_UNAFFECTED_RE = /^Skills-unaffected:[^\S\r\n]*(.+)$/gim;

/**
 * Extract surface-scoped reviewed/unaffected attributions. Each line's value is
 * split into a leading attribution head (before an ` — `, ` -- `, ` - `, or ` : `
 * separator) and the rest (the note/reason). The head is tokenized into slugs;
 * a `Skills-unaffected:` MUST still carry a non-empty reason after the separator
 * (a bare `Skills-unaffected: <skill>` with no reason satisfies nothing).
 * Returns [{ kind, tokens:Set<string>, raw }].
 */
export function parseScopedDecisions(text) {
  const out = [];
  if (!text) return out;
  const harvest = (re, kind, requireReason) => {
    for (const m of text.matchAll(re)) {
      const value = m[1].trim();
      // Split off the attribution head from the note/reason.
      const sep = value.match(/\s+(?:—|--|-|:)\s+/);
      const head = sep ? value.slice(0, sep.index).trim() : value;
      const tail = sep ? value.slice(sep.index + sep[0].length).trim() : "";
      if (requireReason && tail === "") continue; // unaffected needs a reason
      const tokens = new Set();
      for (const part of head.split(/[,\s]+/)) {
        const t = part.trim();
        if (t) { tokens.add(t); tokens.add(skillSlug(t)); }
      }
      if (tokens.size) out.push({ kind, tokens, raw: value });
    }
  };
  harvest(SCOPED_REVIEWED_RE, "reviewed", false);
  harvest(SCOPED_UNAFFECTED_RE, "unaffected", true);
  return out;
}

/**
 * Decide whether a single WATCH finding is RESOLVED for the sweep:
 *   (a) a linked Skills-PR whose unioned covers-set includes EVERY skill of the
 *       finding (engine semantics, per-skill); OR
 *   (b) a surface-scoped decision whose attribution tokens name THIS finding —
 *       by the EXACT surface identifier (the changed primitive/package/route/path
 *       glob), or by EVERY skill the finding impacts. Resolution is PER-SURFACE —
 *       a decision must point at this specific surface (or all its skills), NEVER
 *       a release-wide blanket and NEVER a whole CLASS. A class-level token
 *       (`primitives`, `path`, …) is deliberately NOT honored: one
 *       `Skills-reviewed: primitives` would otherwise clear every primitive
 *       finding in the release, which is exactly the blanket-pass the sweep must
 *       prevent (a whole release can be all-one-class).
 */
export function findingResolved(finding, { linkedPRs, scoped }) {
  // (a) linked assistant-skills PR coverage (per-skill).
  const covered = new Set();
  for (const pr of linkedPRs) for (const slug of pr.covers) covered.add(slug);
  if (finding.skills.map(skillSlug).every((slug) => covered.has(slug))) return { resolved: true, via: "skills-pr" };

  // (b) surface-scoped reviewed/unaffected decision — EXACT surface identifier or
  // every impacted skill ONLY. Class-level and blanket tokens resolve nothing.
  const skillSlugs = finding.skills.map(skillSlug);
  for (const d of scoped) {
    if (d.tokens.has(finding.identifier)) return { resolved: true, via: `${d.kind}:surface` };
    if (skillSlugs.length && skillSlugs.every((s) => d.tokens.has(s))) return { resolved: true, via: `${d.kind}:skill` };
  }
  return { resolved: false, via: null };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export class SweepError extends Error {}

function failLoud(msg) {
  console.error(`[skills-drift-closeout-sweep] ${msg}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) failLoud(`unexpected argument: ${tok}`);
    const eq = tok.indexOf("=");
    const key = eq !== -1 ? tok.slice(2, eq) : tok.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq !== -1) failLoud(`--${key} takes no value`);
      args[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      const value = eq !== -1 ? tok.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (eq === -1 && String(value).startsWith("--"))) {
        failLoud(`--${key} requires a value`);
      }
      args[key] = value;
    } else {
      failLoud(`unknown flag --${key}`);
    }
  }
  return args;
}

function loadConfig(p) {
  if (!p) return {};
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch { failLoud(`--config not readable: ${p}`); }
  try { return JSON.parse(raw); } catch (e) { failLoud(`--config is not valid JSON (${p}): ${e.message}`); }
  return {};
}

function emitStepSummary(lines) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  try { fs.appendFileSync(f, lines.join("\n") + "\n"); } catch { /* non-fatal */ }
}

/** Walk up from a dir to the enclosing git work-tree root, or null. */
function locateGitRoot(dir) {
  try {
    return git(["rev-parse", "--show-toplevel"], { cwd: dir }).trim() || null;
  } catch {
    return null;
  }
}

/** rev-parse that returns the input on failure (report-only, never gates). */
function revParseSafe(ref, cwd) {
  try { return revParse(ref, cwd); } catch { return ref; }
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const format = args.format || "text";
  if (!VALID_FORMATS.includes(format)) failLoud(`unknown --format '${format}' (valid: ${VALID_FORMATS.join(", ")})`);
  const quiet = Boolean(args.quiet);

  // --- (1) BUMP THE PIN FIRST: reconcile against the release-current skills ---
  const skillsDir = args["skills-dir"];
  if (!skillsDir) failLoud("--skills-dir is required (the assistant-skills tree checked out at the release-current --skills-ref)");
  const skillsRef = args["skills-ref"];
  if (!skillsRef) failLoud("--skills-ref is required (the release-current assistant-skills ref the pin is being bumped to)");
  let sStat;
  try { sStat = fs.statSync(skillsDir); } catch { sStat = null; }
  if (!sStat || !sStat.isDirectory()) failLoud(`--skills-dir does not resolve to a directory: ${skillsDir} (assistant-skills pin unresolved?)`);

  // The skills-dir MUST be checked out at exactly --skills-ref. A stale/wrong
  // checkout silently passing is the headline silent-pass risk (rev-1 item 1):
  // resolve both to commit SHAs and require equality.
  const skillsRepo = locateGitRoot(skillsDir);
  if (!skillsRepo) failLoud(`--skills-dir ${skillsDir} is not inside a git checkout — cannot verify it is pinned at --skills-ref`);
  let pinnedSha, wantSha;
  try { pinnedSha = revParse("HEAD", skillsRepo); } catch (e) { failLoud(`cannot resolve the assistant-skills checkout HEAD: ${e.message}`); }
  try { verifyRef(skillsRef, skillsRepo, "--skills-ref"); wantSha = revParse(skillsRef, skillsRepo); }
  catch (e) { failLoud(e instanceof SweepError ? e.message : String(e.message || e)); }
  if (pinnedSha !== wantSha) {
    failLoud(`--skills-dir is checked out at ${pinnedSha} but --skills-ref resolves to ${wantSha} — the sweep must reconcile against the release-current pin. Check out assistant-skills at the bumped ref before sweeping.`);
  }

  const config = loadConfig(args.config);
  const extractOpts = config.primitiveStopwords
    ? { primitiveStopwords: new Set([...DEFAULT_PRIMITIVE_STOPWORDS, ...config.primitiveStopwords]) }
    : {};

  // Build the watch + heuristic indexes from the BUMPED pin (engine reuse).
  let watchIndex, declaredSkills, skillFiles, index;
  try {
    ({ watchIndex, declaredSkills } = buildWatchIndex(skillsDir, extractOpts));
    ({ files: skillFiles, index } = buildSkillIndex(skillsDir, { ...extractOpts, declaredSkills }));
  } catch (e) {
    // A malformed cinatra-watches block (WatchParseError) is a hard fail (codex #6).
    failLoud(`failed to build the skills index from ${skillsDir} (ref ${skillsRef}): ${e.message}`);
  }
  if (!skillFiles || skillFiles.length === 0) {
    failLoud(`no SKILL.md found under ${skillsDir} at ${skillsRef} — assistant-skills pin looks wrong (fail loud, not a silent pass)`);
  }

  // --- (2/3) DIFF THE RELEASE RANGE: exact base..head, owner-gated endpoints ---
  const cwd = process.cwd(); // the release repo (cinatra) working tree
  const firstRelease = Boolean(args["first-release"]);
  let base = args.base;
  // --head is REQUIRED: the sweep must compare the EXACT owner-supplied release
  // endpoints, never a mutable workspace HEAD (a silent-pass if the workspace is
  // ahead of / behind the release head). No default.
  const head = args.head;
  if (!head) failLoud("--head is required (the exact release head tag/commit). The sweep never falls back to the mutable workspace HEAD.");
  if (firstRelease) {
    if (base) failLoud("--first-release and --base are mutually exclusive (a first release has no previous tag; the base is the empty tree)");
    base = EMPTY_TREE;
  } else if (!base) {
    failLoud("--base is required (the previous release tag/commit). For the very first release pass --first-release (base = the empty tree). Tags are owner-gated, so the sweep never guesses a base.");
  } else {
    try { verifyRef(base, cwd, "--base"); } catch (e) { failLoud(e.message); }
  }
  try { verifyRef(head, cwd, "--head"); } catch (e) { failLoud(e.message); }

  let touched, diffText, diffIds, commitMessages;
  try {
    touched = rangeTouchedPaths(base, head, cwd);
    diffText = rangeDiffText(base, head, cwd) + "\n" + pathDerivedRoutes(touched);
    diffIds = extractIdentifiers(diffText, extractOpts);
    commitMessages = rangeCommitMessages(base, head, cwd, { firstRelease });
  } catch (e) {
    failLoud(e instanceof SweepError ? e.message : `release-range diff failed: ${e.message}`);
  }

  // Engine intersection: watch findings gate; heuristic findings advisory.
  const watchFindings = intersectWatches(diffIds, touched, watchIndex);
  const heuristicFindings = intersect(diffIds, index);

  // --- (4) HARVEST ACKS FROM DURABLE RELEASE METADATA (not live trailers) ---
  // (a) merged-commit messages in the range; (b) a committed decision log at head.
  let decisionText = "";
  const decisionLogPath = args["decision-log"];
  if (decisionLogPath) {
    const committed = readCommittedDecisionLog(head, decisionLogPath, cwd);
    if (committed == null) {
      failLoud(`--decision-log ${decisionLogPath} does not exist at --head (${head}). An ack must be COMMITTED at the release head, never read from the mutable workspace.`);
    }
    decisionText = sliceDecisionSection(committed, args["decision-log-section"]);
  }
  const ackSource = [commitMessages, decisionText].filter(Boolean).join("\n\n");

  // Engine parse for the linked-PR form (covers: is already per-skill); the
  // sweep's stricter per-surface scoped resolver reads reviewed/unaffected.
  const acks = parseAcks(ackSource);
  const scoped = parseScopedDecisions(ackSource);

  // --- (5) APPLY THE SAME ACK SET, per-surface (stricter than per-PR) ---
  const annotated = watchFindings.map((f) => {
    const r = findingResolved(f, { linkedPRs: acks.linkedPRs, scoped });
    return { ...f, resolved: r.resolved, via: r.via };
  });
  const unresolved = annotated.filter((f) => !f.resolved);

  const report = {
    sweepVersion: SWEEP_VERSION,
    skillsRef: wantSha,
    base: firstRelease ? "EMPTY_TREE" : revParseSafe(base, cwd),
    head: revParseSafe(head, cwd),
    firstRelease,
    skillsScanned: skillFiles.length,
    skillsWithWatches: declaredSkills.size,
    watchFindingCount: watchFindings.length,
    heuristicFindingCount: heuristicFindings.length,
    unresolvedCount: unresolved.length,
    watchFindings: annotated,
    heuristicFindings,
    unresolved,
    acknowledgements: { linkedPRs: acks.linkedPRs, scoped: scoped.map((d) => ({ kind: d.kind, tokens: [...d.tokens], raw: d.raw })) },
  };

  // --- (6) BLOCK: list every unresolved flagged surface; fail until resolved ---
  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else if (!quiet) {
    const note = `${skillFiles.length} SKILL.md scanned, ${declaredSkills.size} with declared watches, pin ${wantSha.slice(0, 12)}, range ${String(report.base).slice(0, 12)}..${String(report.head).slice(0, 12)}`;
    if (watchFindings.length === 0) {
      process.stderr.write(`skills-drift-closeout-sweep: clean — no release change touched a declared assistant-skills watch (${note}).\n`);
    } else {
      process.stderr.write(`skills-drift-closeout-sweep: ${watchFindings.length} declared-watch surface(s) changed across the release; ${unresolved.length} UNRESOLVED (${note}).\n`);
      for (const f of annotated) {
        process.stderr.write(`  [watch${f.resolved ? `, resolved via ${f.via}` : ", UNRESOLVED"}] ${f.class}: ${f.identifier}  ->  ${f.skills.join(", ")}\n`);
      }
      for (const f of heuristicFindings) {
        process.stderr.write(`  [heuristic, advisory] ${f.class}: ${f.identifier}  ->  ${f.skills.join(", ")}\n`);
      }
      if (unresolved.length) {
        process.stderr.write("\nResolve each UNRESOLVED surface by ONE of (recorded in a merged-commit message or the committed decision log):\n");
        process.stderr.write("  (a) 'Skills-PR: <url-or-#n> covers: <skill-slug>[, ...]' — a linked assistant-skills PR (in the bumped pin) naming the impacted skill(s); or\n");
        process.stderr.write("  (b) 'Skills-reviewed: <skill-or-surface> — <note>' — a surface-scoped recorded review; or\n");
        process.stderr.write("  (c) 'Skills-unaffected: <skill-or-surface> — <reason>' — a surface-scoped recorded override (reason REQUIRED).\n");
        process.stderr.write("  A bare release-wide Skills-reviewed:/Skills-unaffected: with no surface attribution clears NOTHING in the release sweep.\n");
      }
    }
  }

  const summary = [`## skills-drift-closeout-sweep`, "", `pin: \`${wantSha}\` · range: \`${report.base}\`..\`${report.head}\`${firstRelease ? " (first release — empty-tree base)" : ""}`, "", `${watchFindings.length} declared-watch surface(s) changed; ${unresolved.length} unresolved; ${heuristicFindings.length} heuristic (advisory).`];
  if (watchFindings.length) {
    summary.push("", "| Surface | Class | Skill(s) | Status |", "| --- | --- | --- | --- |");
    for (const f of annotated) summary.push(`| \`${f.identifier}\` | ${f.class} | ${f.skills.map((s) => `\`${s}\``).join(", ")} | ${f.resolved ? `resolved (${f.via})` : "**UNRESOLVED — blocking**"} |`);
  }
  emitStepSummary(summary);

  if (unresolved.length > 0) {
    if (!quiet && format !== "json") process.stderr.write(`\nclose-out BLOCKED: ${unresolved.length} unresolved declared-watch surface(s) over the release. Resolve or record a surface-scoped decision for each before tagging.\n`);
    process.exit(1);
  }
  process.exit(0);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); }
  catch { return false; }
}
if (isMainModule()) {
  try { run(); }
  catch (e) {
    if (e instanceof SweepError) failLoud(e.message);
    console.error("[skills-drift-closeout-sweep] sweep failed:", e.message);
    process.exit(2);
  }
}

export { SWEEP_VERSION, EMPTY_TREE };
