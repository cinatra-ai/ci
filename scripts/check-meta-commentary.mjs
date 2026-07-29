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
// line-pinned allowlist semantics and the expired-entry handling are IDENTICAL,
// and the pattern list is the twin's plus the docs#156 AC5 additions (see TWIN
// RELATIONSHIP below) — the only other adaptation is directory scoping: instead of
// deriving a fixed repo root from its own location and scanning the whole tree,
// it scans a caller-supplied `--docs <dir>` (default "docs") relative to the
// process cwd (the caller repo checkout), so an integration repo runs it over
// just its own `docs/` tree. The docs-repo's contributor-docs SKIP_PATHS
// exception does not apply here: integration `docs/` is the product-only 6-page
// contract with no docs-about-docs pages, so nothing is skipped (this is
// stricter, never weaker, than the source gate on the same files).
//
// MULTI-PATH MODE (cinatra-ai/docs#156): published Markdown lives outside
// `docs/` too — a top-level README.md, a CHANGELOG.md, staged listing copy — so
// the gate also accepts a configurable SET of paths via `--paths <spec>`, where
// <spec> is a newline- and/or comma-separated list of directories and/or single
// Markdown files (e.g. "docs,README.md"). SUPPLYING `--paths` selects
// multi-path mode and takes precedence over `--docs`; when it is absent the
// gate behaves exactly as before (single `--docs` directory, default "docs"),
// so existing callers pass unchanged. Multi-path mode is deliberately
// FAIL-CLOSED where being new lets it be: a supplied spec that normalizes to
// zero entries is a config error (never a silent fallback to `--docs`), every
// configured path must exist AND yield at least one tracked Markdown file (a
// typo'd or empty entry is a config error, exit 2, never a silent no-op scan),
// and entries are LITERAL paths, never globs. Files listed twice (e.g.
// "docs,docs/overview.md") are scanned once. Pattern list, allowlist pinning,
// and reviewBy expiry are identical in both modes.
//
// WHAT THE PATTERN LIST COVERS, AND WHAT IT DELIBERATELY DOES NOT (docs#156
// AC5). Three violation classes are enforced; the rule-outs are as much a part
// of the policy as the patterns, because a pattern that fires on ordinary
// product prose costs more than the violation it catches.
//
//   1. DOCS-PRODUCTION META (the original docs#114/#119 class) — how the page
//      itself is produced: "compiled from", "published from", "do not
//      hand-edit", "this page is generated…", "canonical source".
//      This class covers ASSET-PRODUCTION notes too ("the banner PNGs are
//      generated from the brand kit — never hand-edit them"): staged listing
//      copy is a published surface, so a production note there is REMOVED, not
//      exempted, and needs no separate pattern (`generated from` /
//      `do not hand-edit` already match it).
//
//   2. TRANSITION / IN-FLIGHT NOTES — prose that narrates work in flight
//      rather than the capability as it stands: "forthcoming", "coming soon",
//      "(pending)", "to be added", and the rephrasings AC5 adds — "still
//      landing", "not yet landed", "is landing separately/in a later release".
//      A published page states what the product does; a roadmap state ages into
//      a lie the moment the work ships.
//
//   3. PLANNING PROVENANCE — internal decision-process vocabulary in published
//      prose: a capability described by the work item that produced it or the
//      decision that approved it ("epic #123 … landed", "the ratified
//      claim-only mode", "the decisions below are ratified", "per the
//      ruling") instead of by what it does. A reader of a published guide is
//      not a participant in the planning process and cannot resolve those
//      references.
//
// These are lexical heuristics, not semantic judgements. The engine cannot know
// that "#1620" names a work item, that "landed" describes it, or that a
// "decision" is internal. What it requires instead is a BOUND ADJACENCY — a
// planning noun directly against the number, a history verb reachable from that
// reference across only punctuation and auxiliaries or a linking preposition,
// "ratified" inside a short unbroken window of internal decision vocabulary.
// That is a proxy for the relation, not proof of it; bare same-line proximity
// was rejected because it fails benign prose ("See issue #123 for
// troubleshooting. If the webhook has not landed after five minutes, retry.").
//
// RULED OUT — candidates considered for classes 2 and 3 and deliberately NOT
// patterned, each because it fires on legitimate published product prose:
//   - Bare "land"/"landed"/"landing". Real published pages say "the run tells
//     you when it lands", "an approval landed", "if you are landing here for
//     the first time". Class 3 therefore requires the bound work-item relation
//     described above; class 2 requires the explicit transition phrase.
//   - "still in flight", "yet to land" and bare "landing later" — commoner in
//     runtime prose ("requests still in flight are allowed to complete during
//     shutdown", "events yet to land remain queued", "delayed events are
//     landing later") than in roadmap prose.
//   - "no need to hand-edit X" — advisory product prose, not a production
//     instruction; only the prohibition spellings ("do not"/"never") are class 1.
//   - A CHANGELOG entry naming a released version — "streaming support landed
//     in 2.0" — is OUT (product history of the SOFTWARE, tied to a version a
//     reader can install), and a negative fixture pins that. What stays IN,
//     on a CHANGELOG as much as on a guide, is history tied to an INTERNAL
//     work item ("landed with epic #123"): the reference is unresolvable to a
//     reader either way.
//   - A BARE work-item link with no history claim (a "see #123 for the design"
//     cross-reference) is OUT: too many reference pages link an issue
//     legitimately, and the violation is the historical narration, not the
//     link. Such a link is still worth removing from a published guide in
//     review — it is simply below the precision bar for a blocking pattern.
//   - Bare "ratified", and "ratified" next to EXTERNAL-standards vocabulary.
//     "The connector implements the ratified OAuth 2.1 specification" and "the
//     security policy was ratified by the standards committee" are ordinary
//     technical prose, so class 3 fires only when "ratified" sits within two
//     tokens of INTERNAL decision vocabulary (mode / decision / ruling), across
//     at most one hard wrap that does not cross into another list item,
//     heading, quote or table row. "Only ratified algorithms run in FIPS mode"
//     and "algorithms ratified\nby NIST run in FIPS mode" both stay green.
//   - Any compound noun starting "the decision …": "following the decision
//     tree, pick the matching branch", "following the decision returned by the
//     policy engine". The ruling pattern requires the reference to TERMINATE
//     at the noun (punctuation, end of line, "that", or a date), so every such
//     continuation stays green.
//   - CAPABILITY-BOUNDARY statements — "X is not yet supported", "not yet
//     available", "not yet shipped". These describe what the product does
//     TODAY, which is exactly what a published page is for; only the in-flight
//     narration ("… because the work is still landing") is the violation.
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
//   node check-meta-commentary.mjs [--docs <dir>] [--paths <spec>] [--allowlist <path>] [--now <ISO-date>]
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
// mirroring, and the like).
//
// TWIN RELATIONSHIP: docs' repo-local scripts/check-meta-commentary.mjs carries
// a DIFFERENT list as of this commit. It was byte-identical through docs#119;
// the docs#156 AC5
// additions below (the transition and planning-provenance classes) land HERE
// first, because this engine is what every caller repo runs. The docs twin
// carries the pre-AC5 list until it is synced, exactly as caller repos enforce
// the pattern list at the SHA they pin — a widened list changes what any given
// consumer enforces only once that consumer moves to it.
const PATTERNS = [
  // docs#156 AC5: tolerate a single -ly adverb and AT MOST ONE hard wrap between
  // the two words — "generated deterministically\nfrom the design system" is the
  // same claim as "generated from", and hard-wrapped Markdown splits it
  // routinely. The gap is spaces/tabs plus at most one newline (never `\s+`,
  // which would join "## Generated" to a following block starting with "From").
  // This widens the SAME phrase; the adverb form does newly fail sentences like
  // "generated dynamically from the OpenAPI schema" whose un-adverbed twin the
  // pattern already failed — a genuine one goes in the allowlist, as before.
  ["generated_from", /\bgenerated(?:[ \t]+\w+ly)?(?:[ \t]+|[ \t]*\r?\n[ \t]*)from\b/i, '"generated (…ly) from"'],
  ["compiled_from", /\bcompiled from\b/i, '"compiled from"'],
  ["compiled_into_chapter", /\bcompiled into (?:this|the) chapter\b/i, '"compiled into (this|the) chapter"'],
  ["published_from", /\bpublished from\b/i, '"published from"'],
  ["published_mirror", /\bpublished mirror\b/i, '"published mirror"'],
  ["byte_for_byte_copy", /\bbyte-for-byte copy\b/i, '"byte-for-byte copy"'],
  // docs#156 AC5: "never hand-edit the PNGs" is the same PROHIBITION as "do not
  // hand-edit" and was the exact phrasing the staged-listing sweep found; the
  // ruling removes such notes rather than exempting them, so the pattern has to
  // be able to see them. "no need to hand-edit" is deliberately NOT included —
  // that is advisory product prose ("no need to hand-edit field mappings; the
  // connector maintains them"), not a production instruction.
  ["do_not_hand_edit", /\b(?:do not|don't|does not|never) hand-edit\b/i, '"do not / never hand-edit"'],
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

  // --- Class: TRANSITION / in-flight notes (docs#156 AC5) -------------------
  // The same family as "forthcoming" / "coming soon" / "to be added" above, in
  // the rephrasings those literal patterns miss: prose that narrates work IN
  // FLIGHT ("what you can write today versus what is still landing").
  // Anchored on the transition phrase, never on bare "land"/"landed"/
  // "landing" — published product prose legitimately says "the run tells you
  // when it lands", "an approval landed", "if you are landing here for the
  // first time".
  //
  // RESIDUAL RISK, recorded rather than hidden: "still landing" / "not yet
  // landed" are lexical, so a sentence about RUNTIME objects rather than work
  // ("if events are still landing in the old destination", "if the webhook has
  // not yet landed, retry") would also fail. No such sentence exists on any of
  // the 202 inventoried published surfaces today; one that appears later is a
  // line-pinned allowlist entry, which is exactly what that mechanism is for.
  // Two further candidates were dropped for being commoner in runtime prose
  // than in roadmap prose: "still in flight" ("requests still in flight are
  // allowed to complete during shutdown") and "yet to land" ("events yet to
  // land remain queued").
  ["still_landing", /\bstill landing\b/i, '"still landing"'],
  ["not_yet_landed", /\bnot yet landed\b/i, '"not yet landed"'],
  [
    // Either the literal "landing separately", or "landing in a <lifecycle
    // noun>" — the noun is REQUIRED there, or "audit events are landing in a
    // separate bucket" would fail. Bare "landing later" was dropped: "delayed
    // events are landing later" is ordinary runtime prose.
    "landing_separately",
    /\b(?:is|are|will be) landing (?:separately\b|in a (?:later|future|separate|subsequent) (?:release|version|rollout|phase|milestone|update|wave)\b)/i,
    '"is/are/will be landing separately | landing in a later release"',
  ],

  // --- Class: PLANNING PROVENANCE (docs#156 AC5) ---------------------------
  // Internal decision-process vocabulary in published prose: a capability
  // described by the work item that produced it or the decision that approved
  // it, rather than by what it does.
  //
  // These are LEXICAL PROXIMITY HEURISTICS, not semantic guarantees — the gate
  // cannot know that "#1620" is a work item or that "ratified" refers to an
  // internal decision. What it CAN require, and does, is an explicit relation:
  // a planning noun immediately bound to the number, and a history verb bound
  // to that reference by punctuation or a linking preposition. Bare proximity
  // on one physical line was deliberately rejected — it fails benign prose
  // like "See issue #123 for troubleshooting. If the webhook has not landed
  // after five minutes, retry it."
  [
    // "epic [#1620](https://…/1620), landed in S1/S2" — the work-item
    // reference, an optional Markdown link target, optional punctuation, up to
    // two auxiliaries, then the history verb. Nothing else may intervene, and
    // every gap is a BOUNDED run of spaces/tabs: never `\s*` (which would cross
    // a blank line and join "See issue #123" to a following paragraph starting
    // "Landed events…"), and never an unbounded run of adjacent optional
    // quantifiers (which backtracks quadratically on a long space run).
    "planning_workitem_landed",
    /\b(?:epic|issue|ticket|milestone|slice|phase|workstream)s?[ \t]{0,3}\[?[ \t]{0,3}#[ \t]{0,3}\d+\]?(?:\([^)\s]{0,200}\))?[ \t]{0,4}[,;:—–-]?[ \t]{0,4}(?:(?:has|had|is|are|was|were|which)[ \t]{1,4}){0,2}(?:landed|shipped|merged|implemented|delivered)\b/i,
    'work-item reference narrating implementation history, e.g. "epic #123, landed"',
  ],
  [
    // The reverse order, bound by an explicit relating preposition:
    // "landed with epic #1448", "shipped under epic #1620".
    "planning_landed_workitem",
    /\b(?:landed|shipped|merged|implemented|delivered)[ \t]{1,4}(?:in|with|under|via|as part of)[ \t]{1,4}(?:the[ \t]{1,4})?(?:epic|issue|ticket|milestone|slice|phase|workstream)s?[ \t]{0,3}\[?[ \t]{0,3}#[ \t]{0,3}\d+/i,
    'implementation history pinned to a work item, e.g. "landed with epic #123"',
  ],
  [
    // "ratified" bound to INTERNAL decision vocabulary only. `plan`,
    // `proposal`, `policy` and `scope` were dropped: "the ratified W3C
    // proposal" and "the security policy was ratified by the standards
    // committee" are ordinary prose about an EXTERNAL standards process.
    //
    // The gap is bounded by TOKENS, not characters: at most two intervening
    // words (a Markdown-emphasised modifier such as `**claim-only**` is one),
    // then the decision noun. A character window was tried first and rejected
    // — 24 characters still let "only ratified algorithms run in FIPS mode"
    // through, and no window both admits the real wrapped instance and
    // excludes that sentence. The gap may cross at most one hard wrap, and the
    // wrap guard runs BEFORE the indentation is consumed (and covers `-`, `*`,
    // `+`, `>`, `|`, `1.` and `1)` markers), so adjacent list items, headings,
    // quotes and table rows cannot be joined.
    "ratified_decision_vocab",
    /\bratified\b(?:[ \t]{1,2}[^\s.!?]{1,24}){0,2}(?:[ \t]{1,2}|[ \t]*\r?\n(?![ \t]*(?:[-*+>|]|\d+[.)]))[ \t]*)(?:mode|decision|decisions|ruling)\b/i,
    '"ratified" next to internal decision vocabulary, e.g. "the ratified claim-only mode"',
  ],
  [
    "decision_was_ratified",
    /\b(?:mode|decision|decisions|ruling)\b(?:[ \t]{1,2}[^\s.!?]{1,24}){0,2}(?:[ \t]{1,2}|[ \t]*\r?\n(?![ \t]*(?:[-*+>|]|\d+[.)]))[ \t]*)(?:is|are|was|were)[ \t]{1,4}ratified\b/i,
    '"the decision(s) … is/are/was/were ratified"',
  ],
  [
    // The reference must TERMINATE at the noun — punctuation, end of line, a
    // following "that", or a date. A finite blacklist of compound nouns was
    // tried first and rejected: it can never enumerate "the decision tree",
    // "the decision diagram", "the decision returned by the policy engine".
    // Requiring the phrase to end is structural, so all of those stay green
    // while "per the ruling," and "per the owner ruling 2026-07-22," fail.
    "ruling_reference",
    /\b(?:per|as per|following|under) the (?:owner |product )?(?:ruling|decision)\b(?=[ \t]{0,4}[,;:.)]|[ \t]{1,4}(?:that\b|\d{4}-\d{2}-\d{2})|[ \t]*(?:\r?\n|$))/i,
    '"per the ruling" / "per the decision"',
  ],
];

// A --paths spec is a newline- and/or comma-separated list of entries;
// whitespace around entries is trimmed and empty entries are dropped (a YAML
// block scalar arrives with a trailing newline). Repeating --paths appends.
function parsePathsSpec(spec) {
  return String(spec ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = { docs: DEFAULT_DOCS_DIR, paths: [], pathsSupplied: false, allowlist: DEFAULT_ALLOWLIST_PATH, now: new Date() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--docs" || argv[i] === "-d") out.docs = argv[++i];
    else if (argv[i] === "--paths") {
      out.pathsSupplied = true;
      out.paths.push(...parsePathsSpec(argv[++i]));
    }
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

// Tracked Markdown files under one scan root (a directory, or — in multi-path
// mode — possibly a single file; `git ls-files` handles both pathspec shapes).
// `git ls-files` respects gitignore and returns only tracked files (so an
// untracked scratch file can never trip the gate); scoping the pathspec
// confines the scan to the configured tree. Paths are returned relative to
// CWD. `-z` handles unusual filenames robustly.
function listMarkdownFiles(docsDir) {
  let out;
  try {
    // --literal-pathspecs: configured entries are LITERAL paths, never globs —
    // a "*"/"?"/"[" in an entry must not silently widen or shift the scan.
    out = execFileSync("git", ["--literal-pathspecs", "ls-files", "-z", "--", docsDir], {
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
  const { docs, paths, pathsSupplied, allowlist: allowlistPath, now, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(
      "Usage: check-meta-commentary [--docs <dir>] [--paths <newline/comma-separated dirs and/or .md files>] [--allowlist <path>] [--now <ISO-date>]"
    );
    console.log("A non-empty --paths takes precedence over --docs; without it the gate scans the single --docs directory.");
    process.exit(0);
  }

  // Multi-path mode: SUPPLYING --paths selects it; a supplied spec that
  // normalizes to zero entries (",," / whitespace / a missing value) is a
  // config error, NEVER a silent fallback to the --docs scan (fail closed —
  // a caller that asked for the widened scope must get it or fail loudly).
  const multiPath = pathsSupplied;
  if (multiPath && paths.length === 0) {
    console.error(`[meta-commentary-gate] ERROR: --paths was supplied but parsed to zero entries — fix the paths spec.`);
    process.exit(2);
  }
  if (multiPath) {
    for (const p of paths) {
      if (!existsSync(resolveInCwd(p))) {
        console.error(`[meta-commentary-gate] ERROR: configured path not found: ${p}`);
        process.exit(2);
      }
    }
  } else {
    const docsAbs = resolveInCwd(docs);
    if (!existsSync(docsAbs) || !statSync(docsAbs).isDirectory()) {
      console.error(`[meta-commentary-gate] ERROR: docs directory not found: ${docs}`);
      process.exit(2);
    }
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
    if (multiPath) {
      // Union of tracked Markdown under every configured path, dedup'd (an
      // entry may be a directory or a single file; overlapping entries — e.g.
      // "docs,docs/overview.md" — scan a file once). FAIL CLOSED per entry: a
      // configured path that yields no tracked Markdown at all is a config
      // error (a typo'd, untracked, or Markdown-free entry must surface, never
      // silently narrow the scan).
      const seen = new Set();
      markdownFiles = [];
      for (const p of paths) {
        const files = listMarkdownFiles(p);
        if (files.length === 0) {
          console.error(
            `[meta-commentary-gate] ERROR: configured path "${p}" matched no tracked Markdown files — fix the entry or drop it.`
          );
          process.exit(2);
        }
        for (const f of files) {
          if (!seen.has(f)) {
            seen.add(f);
            markdownFiles.push(f);
          }
        }
      }
    } else {
      markdownFiles = listMarkdownFiles(docs);
    }
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

  const scopeLabel = multiPath
    ? `across ${markdownFiles.length} tracked Markdown file(s) under the configured paths (${paths.join(", ")})`
    : `across tracked Markdown pages under "${docs}/"`;

  if (violations.length === 0) {
    console.log(`[meta-commentary-gate] OK — 0 violations ${scopeLabel} (allowlist: ${live.length} live entries).`);
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
    `\nPublished integration docs describe Cinatra the product and how to use this integration: ` +
      `not how the documentation or its assets are authored, generated, compiled, mirrored or maintained; ` +
      `not what is still in flight ("still landing", "forthcoming"); and not the internal work item or ` +
      `decision a capability came from ("epic #123, landed", "the ratified <X> mode"). ` +
      `Remove the meta/transition/provenance content from the page and state the capability as it stands.` +
      `\nA genuine false positive (real product content this pattern misfires on) goes in ` +
      `${allowlistPath} with an owner, a reviewBy date, and the exact full line as the snippet — see cinatra-ai/docs#119.`
  );
  process.exitCode = 1;
}

main();
