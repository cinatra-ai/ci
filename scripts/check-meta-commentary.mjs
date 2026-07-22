#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-meta-commentary — the reusable meta-commentary gate engine
// (cinatra-ai/docs#119, promoting cinatra-ai/docs#114's repo-local check to a
// SHA-pinnable org-wide reusable in cinatra-ai/ci).
//
// Published, user-facing integration docs pages must not carry meta/
// implementation commentary about how the DOCS THEMSELVES are produced,
// compiled, mirrored, or maintained — generation mechanics ("this page is
// compiled from…"), "forthcoming"/placeholder transition notes, maintenance-
// process references, and editorial TODOs. Product content that happens to use
// words like "compiled" or "generated" to describe how CINATRA (the product)
// works is explicitly NOT in scope — that is what the optional allowlist covers.
//
// This is the ci-vendored twin of docs' scripts/check-meta-commentary.mjs. The
// pattern list, the line-pinned allowlist semantics, and the expired-entry
// handling are IDENTICAL — the only adaptation is directory scoping: instead of
// deriving a fixed repo root from its own location and scanning the whole tree,
// it scans a caller-supplied `--docs <dir>` (default "docs") relative to the
// process cwd (the caller repo checkout), so an integration repo runs it over
// just its own `docs/` tree. The docs-repo's contributor-docs SKIP_PATHS
// exception does not apply here: integration `docs/` is the product-only 6-page
// contract with no docs-about-docs pages, so nothing is skipped (this is
// stricter, never weaker, than the source gate on the same files).
//
// Deliberately "cheap", not exhaustive:
//   - Pattern-based phrase matching, not real NLP; a rephrased violation can
//     slip through, and a legitimate sentence can coincidentally match.
//   - An OPTIONAL, small hand-maintained allowlist file covers verified
//     exceptions, each pinned to the exact full source line the match sits on
//     (so a second, unrelated line matching the same phrase is NOT silently
//     covered by the first line's sign-off) and carrying an owner and a
//     reviewBy date. Once reviewBy passes, the entry stops suppressing — it does
//     not silently become permanent. The allowlist is OPTIONAL: an absent file
//     means an empty allowlist (integration docs are product-only and need
//     none), so a repo with nothing to exempt simply omits the file.
//
// SELF-CONTAINED: Node builtins only, zero runtime npm deps. Uses `git ls-files`
// so untracked/gitignored scratch never trips the gate.
//
// Usage (after checkout; run from the caller repo root):
//   node check-meta-commentary.mjs [--docs <dir>] [--allowlist <path>] [--now <ISO-date>]
//
// Exit codes: 0 = clean, 1 = violation(s), 2 = usage/config error.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

// The caller repo root: the cwd the gate is invoked from (the reusable workflow
// runs it from the caller checkout's workspace root; the ci self-check runs it
// from this repo root against fixtures). NOT derived from this file's location,
// which — when vendored into a nested ci checkout — would point at the gate
// engine, not the docs under test.
const CWD = process.cwd();

const DEFAULT_DOCS_DIR = "docs";
const DEFAULT_ALLOWLIST_PATH = ".github/meta-commentary-gate-allowlist.json";

// The docs-repo gate skips contributor-docs pages (its owner-sanctioned
// exception, docs#114). Integration `docs/` is product-only — the fixed 6-page
// contract, no docs-about-docs pages — so there is nothing to skip here. Kept
// as an explicit empty set to document the deliberate difference: a stricter,
// never-weaker scope than the source gate on the same files.
const SKIP_PATHS = new Set([]);

// [id, regex, human description]. Case-insensitive unless noted. Every pattern
// is a multi-word phrase or a self-referential "this page … is generated/
// compiled/…" combination — a broad single-word match on "compiled"/
// "generated"/"sync"/"mirror" alone false-positives constantly against real
// product/technical content (OAS compilation, connector sync, dashboard
// mirroring, and the like). Kept byte-identical to docs' check-meta-commentary
// so the reusable enforces exactly what the source repo does.
const PATTERNS = [
  ["generated_from", /\bgenerated from\b/i, '"generated from"'],
  ["compiled_from", /\bcompiled from\b/i, '"compiled from"'],
  ["compiled_into_chapter", /\bcompiled into (?:this|the) chapter\b/i, '"compiled into (this|the) chapter"'],
  ["published_from", /\bpublished from\b/i, '"published from"'],
  ["published_mirror", /\bpublished mirror\b/i, '"published mirror"'],
  ["byte_for_byte_copy", /\bbyte-for-byte copy\b/i, '"byte-for-byte copy"'],
  ["do_not_hand_edit", /\b(?:do not|don't|does not) hand-edit\b/i, '"do not hand-edit"'],
  ["overwritten_next_sync", /\boverwritten the next time\b/i, '"overwritten the next time"'],
  ["republished_from", /\brepublished from\b/i, '"republished from"'],
  ["synced_from_canonical", /\bsynced from the canonical\b/i, '"synced from the canonical"'],
  ["canonical_source_label", /\bcanonical source\b/i, '"canonical source"'],
  ["forthcoming", /\bforthcoming\b/i, '"forthcoming"'],
  ["coming_soon", /\bcoming soon\b/i, '"coming soon"'],
  ["will_be_added_when", /\bwill be added when\b/i, '"will be added when"'],
  ["to_be_added", /\bto be added\b/i, '"to be added"'],
  ["todo_marker", /\bTODO[:(]/, '"TODO:" / "TODO("'],
  ["tbd_marker", /\bTBD\b/, '"TBD"'],
  [
    "parenthetical_transition_note",
    /\((?:forthcoming|coming soon|pending|tbd|todo)\)/i,
    'parenthetical transition note, e.g. "(hub forthcoming)"',
  ],
  ["work_in_progress", /\bwork[- ]in[- ]progress\b/i, '"work in progress"'],
  ["stub_page", /\bstub page\b/i, '"stub page"'],
  ["documentation_pending", /\b(?:documentation|doc) pending\b/i, '"documentation pending"'],
  ["pending_documentation", /\bpending documentation\b/i, '"pending documentation"'],
  ["editorial_note", /\beditorial (?:note|todo)\b/i, '"editorial note/TODO"'],
  ["internal_note", /\binternal note\b/i, '"internal note"'],
  ["process_note", /\bprocess note\b/i, '"process note"'],
  [
    "self_referential_production",
    /\bthis (?:page|document|file|guide|chapter|hub|section)\b[^.\n]{0,80}\b(?:is|was)\b[^.\n]{0,40}\b(?:generated|compiled|mirrored|synced|republished|maintained|created)\b/i,
    '"this page/document/… is generated/compiled/mirrored/synced/maintained/created"',
  ],
  [
    "self_referential_by",
    /\bthis (?:page|document|file|guide|chapter|hub|section)\b[^.\n]{0,60}\b(?:maintained|created|generated|compiled) by\b/i,
    '"this page/document/… maintained/created/generated/compiled by"',
  ],
];

function parseArgs(argv) {
  const out = { docs: DEFAULT_DOCS_DIR, allowlist: DEFAULT_ALLOWLIST_PATH, now: new Date() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--docs" || argv[i] === "-d") out.docs = argv[++i];
    else if (argv[i] === "--allowlist") out.allowlist = argv[++i];
    else if (argv[i] === "--now") out.now = new Date(argv[++i]); // testability only
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
  }
  return out;
}

function resolveInCwd(p) {
  return isAbsolute(p) ? p : join(CWD, p);
}

// Loads the OPTIONAL allowlist and splits entries into "live" (still
// suppressing) and "expired" (reviewBy has passed — an exception must not
// become permanent silently, so an expired entry stops protecting: the
// violation it used to cover starts failing the gate again until a human either
// fixes the content or renews the date). An absent file is an empty allowlist.
function loadAllowlist(path, now) {
  let raw;
  try {
    raw = readFileSync(resolveInCwd(path), "utf8");
  } catch (e) {
    // ONLY a genuinely absent file means "empty allowlist" (the OPTIONAL
    // contract). A present-but-unreadable path (a directory, a permission
    // error, …) is a misconfiguration and must surface, not be silently
    // swallowed as if no exceptions were declared.
    if (e && e.code === "ENOENT") return { live: [], expired: [] };
    throw new Error(`allowlist ${path} is not readable: ${e.message}`);
  }
  const parsed = JSON.parse(raw);
  const entries = parsed?.entries;
  if (!Array.isArray(entries)) throw new Error(`${path} must be a JSON object with an "entries" array`);
  const live = [];
  const expired = [];
  for (const entry of entries) {
    for (const key of ["file", "pattern", "snippet", "owner", "reviewBy", "note"]) {
      if (!entry[key]) {
        throw new Error(`${path}: allowlist entry missing "${key}": ${JSON.stringify(entry)}`);
      }
    }
    const reviewBy = new Date(entry.reviewBy);
    if (Number.isNaN(reviewBy.getTime())) {
      throw new Error(`${path}: entry for ${entry.file} has an unparseable reviewBy "${entry.reviewBy}"`);
    }
    (reviewBy < now ? expired : live).push(entry);
  }
  return { live, expired };
}

// Tracked Markdown files under the scoped docs dir. `git ls-files` respects
// gitignore and returns only tracked files (so an untracked scratch file can
// never trip the gate); scoping the pathspec to <docs> confines the scan to the
// caller's docs tree. Paths are returned relative to CWD. `-z` handles unusual
// filenames robustly.
function listMarkdownFiles(docsDir) {
  let out;
  try {
    out = execFileSync("git", ["ls-files", "-z", "--", docsDir], {
      cwd: CWD,
      encoding: "utf8",
    });
  } catch (e) {
    // e.g. run outside a git work tree, or a pathspec outside the repo — a
    // config error, surfaced cleanly (exit 2) rather than an opaque crash.
    throw new Error(`git ls-files failed for "${docsDir}": ${(e.stderr || e.message || "").toString().trim()}`);
  }
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => f.toLowerCase().endsWith(".md"));
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

// The full source line containing a match (trimmed), used as the allowlist
// pinning key instead of the bare matched phrase. Two DIFFERENT sentences in
// the same file can both legitimately contain e.g. "generated from", so pinning
// on the phrase alone would let one verified exception silently cover an
// unrelated, unverified second instance. Pinning on the whole line makes that
// collision require a byte-identical duplicate line, which an allowlist entry
// can then also list explicitly.
function lineTextAt(content, index) {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  let end = content.indexOf("\n", index);
  if (end === -1) end = content.length;
  return content.slice(start, end).trim();
}

function main() {
  const { docs, allowlist: allowlistPath, now, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log("Usage: check-meta-commentary [--docs <dir>] [--allowlist <path>] [--now <ISO-date>]");
    process.exit(0);
  }

  const docsAbs = resolveInCwd(docs);
  if (!existsSync(docsAbs) || !statSync(docsAbs).isDirectory()) {
    console.error(`[meta-commentary-gate] ERROR: docs directory not found: ${docs}`);
    process.exit(2);
  }

  let live, expired;
  try {
    ({ live, expired } = loadAllowlist(allowlistPath, now));
  } catch (e) {
    console.error(`[meta-commentary-gate] ERROR: ${e.message}`);
    process.exit(2);
  }

  // Keyed by file+pattern+the FULL LINE the match sits on — not just the bare
  // matched phrase — so an allowlist entry only suppresses the SPECIFIC
  // verified occurrence.
  const allowed = new Set(live.map((e) => `${e.file} ${e.pattern} ${e.snippet}`));

  let markdownFiles;
  try {
    markdownFiles = listMarkdownFiles(docs);
  } catch (e) {
    console.error(`[meta-commentary-gate] ERROR: ${e.message}`);
    process.exit(2);
  }

  const violations = [];
  for (const file of markdownFiles) {
    if (SKIP_PATHS.has(file)) continue;
    const content = readFileSync(resolveInCwd(file), "utf8");
    for (const [id, regex, description] of PATTERNS) {
      const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
      const re = new RegExp(regex.source, flags);
      let match;
      while ((match = re.exec(content)) !== null) {
        const lineText = lineTextAt(content, match.index);
        if (!allowed.has(`${file} ${id} ${lineText}`)) {
          violations.push({
            file,
            line: lineNumberAt(content, match.index),
            id,
            description,
            snippet: match[0],
          });
        }
        if (match.index === re.lastIndex) re.lastIndex++; // zero-width guard
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `[meta-commentary-gate] OK — 0 violations across tracked Markdown pages under "${docs}/" ` +
        `(allowlist: ${live.length} live entries).`
    );
    if (expired.length > 0) {
      console.log(
        `[meta-commentary-gate] NOTE — ${expired.length} allowlist entry(ies) past their reviewBy ` +
          `date but no longer matching anything (safe to delete or renew): ` +
          expired.map((e) => `${e.file}:${e.pattern} (reviewBy ${e.reviewBy})`).join(", ")
      );
    }
    return;
  }

  console.error(`[meta-commentary-gate] FAIL — ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.id}] matched ${v.description} — "${v.snippet}"`);
  }
  if (expired.length > 0) {
    console.error(`\n${expired.length} allowlist entry(ies) are EXPIRED (past reviewBy) and no longer suppress anything:`);
    for (const e of expired) {
      console.error(`  ${e.file} [${e.pattern}] reviewBy ${e.reviewBy} owner ${e.owner} — ${e.note}`);
    }
    console.error(`Renew (bump reviewBy) only after re-confirming the match is still legitimate product content, or remove the entry.`);
  }
  console.error(
    `\nPublished integration docs describe Cinatra the product and how to use this integration, ` +
      `not how the documentation itself is authored, generated, compiled, mirrored, or maintained. ` +
      `Remove the meta/process content from the page.` +
      `\nA genuine false positive (real product content this pattern misfires on) goes in ` +
      `${allowlistPath} with an owner, a reviewBy date, and the exact full line as the snippet — see cinatra-ai/docs#119.`
  );
  process.exitCode = 1;
}

main();
