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
// line-pinned allowlist semantics, the expired-entry handling and the pattern
// list are IDENTICAL (see TWIN RELATIONSHIP below for what holds the two lists
// together, and for why neither side is the privileged one) — the adaptation is
// directory scoping: instead of
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
// files (e.g. "docs,README.md"). SUPPLYING `--paths` selects multi-path mode
// and takes precedence over `--docs`; when it is absent the gate behaves
// exactly as before (single `--docs` directory, default "docs"), so existing
// callers pass unchanged. Multi-path mode is deliberately FAIL-CLOSED where
// being new lets it be: a supplied spec that normalizes to zero entries is a
// config error (never a silent fallback to `--docs`), every configured path
// must exist AND yield at least one tracked scannable file (a typo'd or empty
// entry is a config error, exit 2, never a silent no-op scan), and entries are
// LITERAL paths, never globs. Files listed twice (e.g. "docs,docs/overview.md")
// are scanned once. Pattern list, allowlist pinning, and reviewBy expiry are
// identical in both modes.
//
// PATH SELECTION IS THE ONLY SCOPING MECHANISM (docs#160 AC12). The gate has no
// semantic notion of an "implementation-facing" or "internal" tree and must
// never acquire one: it does not discover a repository root, does not infer an
// audience from a filename, and does not read anything outside the literal paths
// it was handed. A tree is exempt exactly when the caller does not list it. That
// is why a caller configured with `README.md,CHANGELOG.md` is green even with a
// planted violation under `docs/**` — `docs/**` is never selected, so it is
// never read. `--print-files` prints the selection so that claim is checkable.
//
// HTML SURFACES (cinatra-ai/docs#160). Published documentation is not only
// Markdown: reference pages ship as HTML too, and the same policy applies to
// them word for word. The gate therefore scans tracked `.html` / `.htm` files
// under the configured paths alongside `.md`. HTML is not matched as raw source
// — it is first reduced to its PROSE by scripts/lib/html-text.mjs, whose header
// carries the full per-construct contract (visible text and HTML comments in
// scope; `<script>`/`<style>` and machine attributes out; human-readable
// attributes such as `title`/`alt`/`aria-label` in; entities decoded before
// matching; inline tags transparent so a phrase split by `<b>` still matches;
// block tags a hard separator so prose from two blocks is never joined).
// Reporting stays deterministic on the SOURCE file and line: every extracted
// character carries the source offset it came from, so a violation names a line
// a human can open, and the allowlist still pins the full SOURCE line.
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
//      Since cinatra-ai/docs#171 the same class also covers DERIVATION
//      provenance — the numbered review or convergence round a constraint came
//      out of, with or without the tool or agent that ran it ("<agent> round-12
//      lesson", "lesson from round 3", "<agent> found in round 7"). It is the
//      same defect one step earlier in the process: the sentence says where the
//      constraint came from instead of stating the constraint.
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
//   - An UNQUALIFIED work-item link with no history claim (a "see #123 for the
//     design" cross-reference) stays OUT: a bare `#123` is ambiguous — it is
//     also a heading anchor, a CSS colour, a footnote — so a blocking pattern on
//     it would fire on ordinary text. The violation there is the historical
//     narration, not the link.
//     SUPERSEDED IN PART (docs#160 AC4): the REPO-QUALIFIED spelling
//     (`cinatra#1607`, `cinatra-ai/cinatra#1795`) is now IN — see
//     `qualified_workitem_citation` below. docs#156 ruled the whole class out
//     on precision grounds; docs#160 re-decided it on evidence. The qualified
//     form is structurally unambiguous (a slug, `#`, digits, and nothing that
//     continues the token), it is the exact form every real occurrence took
//     across the corpus, and a reader of a published page cannot resolve it —
//     which is the same defect that makes an acceptance-criterion or ruling
//     citation a violation. The rule-out is therefore NARROWED to the bare
//     `#123` form, not reaffirmed wholesale.
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
//   - A TOOL OR AGENT NAME on its own (docs#171). Integration docs name coding
//     assistants in ordinary product prose — a page on connecting one to
//     Cinatra, a comparison of two of them, a quick-start that opens by naming
//     the assistant it is written for. A name is never the violation: only a
//     NUMBERED review round BOUND to it is.  // source-leak-allow: detector vocabulary
//   - An UNNUMBERED review round ("approval rounds repeat until the reviewer  // source-leak-allow: detector vocabulary
//     signs off") and a NUMBERED round carrying no derivation claim ("round 2
//     of the rollout adds the CRM connector"). Unnumbered, it is an ordinary
//     process noun; unclaimed, a numbered round is an ordinary programme noun.
//     It is the derivation claim that makes either one provenance.
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
import { extractHtmlText, isHtmlPath } from "./lib/html-text.mjs";

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
// TWIN RELATIONSHIP: docs' repo-local scripts/check-meta-commentary.mjs is this
// engine's twin. The two files are NOT byte-identical — they were only through
// docs#119, and their scan scopes, CLIs and operator messages have differed
// since — but they carry the SAME pattern list, and
// scripts/check-meta-commentary-parity.mjs is what keeps them honest about it:
// each repo runs its OWN engine over one byte-identical corpus and must
// reproduce one byte-identical verdict.
//
// THAT IS BEHAVIOURAL EVIDENCE ON A FINITE CORPUS, not a proof the two lists are
// identical: a pattern added to one side that no corpus line exercises would
// still pass on both. Widening the list therefore means widening the CORPUS in
// the same change — that is what makes the evidence worth anything, and it is
// why the corpus travels with every widening, this one included.
//
// WHICH SIDE A WIDENING LANDS ON FIRST VARIES, and neither order is privileged.
// The docs#156 AC5 additions below (the transition and planning-provenance
// classes) landed HERE first, because this engine is what every caller repo
// runs. The docs#171 derivation-provenance patterns landed in the DOCS twin
// first, because the page that slipped through was a docs page, and are
// mirrored here with the shared corpus in the same change. Either way a caller
// repo enforces the pattern list at the SHA it pins — a widened list changes
// what any given consumer enforces only once that consumer moves to it.
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

  // --- Class: PLANNING PROVENANCE, docs#160 additions -----------------------
  // The three citation shapes the HTML reference pages actually carried, and the
  // in-page annotation vocabulary that sat beside them. Each names a capability
  // by the internal artefact behind it — a work item, an acceptance criterion, a
  // decision — instead of by what the product does; none is resolvable by a
  // reader of the published site.
  [
    // REPO-QUALIFIED work-item citation: a slug (optionally org/repo-qualified),
    // "#", digits, and nothing that continues the token. This is the docs#160
    // AC4 decision, narrowing the docs#156 rule-out (see RULED OUT above).
    //
    // Precision is structural, not statistical. Five exclusions carry it:
    //   - The leading negative LOOKBEHIND refuses a "#" that is already inside a
    //     token or preceded by "/" or "." — so `cinatra-ai/cinatra#1795` matches
    //     ONCE, at the start, rather than again at each path segment.
    //   - The negative LOOKBEHIND IMMEDIATELY BEFORE THE "#" refuses a FILE
    //     ANCHOR (`overview.md#12`, `docs/guide.html#3`, `deck.pdf#7`): a
    //     fragment into a document is addressing, not a citation. It sits at the
    //     "#" rather than at the start of the token because the path depth is
    //     unbounded — a lookahead anchored at the token start cannot see past
    //     the first "/", so `docs/overview.md#12` slipped through it.
    //     The trailing `(?![\w-])` refuses a heading slug (`#12-installation`)
    //     on the same grounds.
    //   - The slug is LOWERCASE-only, and the pattern is case-SENSITIVE. A repo
    //     slug is written lowercase everywhere in this corpus; a Capitalised
    //     token immediately before a "#number" is a DISPLAY LABEL, not a repo.
    //     The real false positive that forced this: a published components page
    //     renders an agent-run table cell as `<span>Outreach</span><span>#2,318
    //     </span>`, and inline tags are transparent by the extraction contract,
    //     so the two cells arrive as the single token `Outreach#2,318`.
    //   - `(?!,\d)` refuses a THOUSANDS SEPARATOR after the digits, the other
    //     half of that same run-number shape.
    //   - AT LEAST TWO DIGITS. `label#2` / `run#7` is a display ordinal, not a
    //     work item; the lowest work-item number cited anywhere in this corpus is
    //     three digits, and this org's issue numbering passed 99 long ago.
    // RESIDUAL RISKS, recorded not hidden: a genuinely upper-case repo slug
    // (`cinatra-ai/Cinatra#123`), a one- or two-digit work item, and a lower-case
    // display label beside a 2+-digit ordinal (`invoice#42`) are all mis-called.
    // That is the deliberate trade this whole pattern list makes — a pattern that
    // fires on ordinary product prose costs more than the violation it catches.
    // A bare `#123` cannot match at all — there is no slug before the "#" — so
    // the deliberate docs#156 rule-out on the unqualified form is preserved
    // exactly. Every gap is a BOUNDED character run, so the pattern stays linear
    // on adversarial input.
    "qualified_workitem_citation",
    /(?<![\w./#-])[a-z][a-z0-9.-]{0,60}(?:\/[a-z0-9._-]{1,60}){0,2}(?<!\.(?:md|html?|json|ya?ml|toml|txt|pdf|zip|png|jpe?g|gif|svg|webp|css|js|mjs|cjs|ts|tsx|sh|py|rb|go|rs))#\d{2,}(?![\w-])(?!,\d)/,
    'repo-qualified work-item citation, e.g. "cinatra#1607" / "cinatra-ai/cinatra#1795"',
  ],
  [
    // ACCEPTANCE-CRITERION citation: "AC6", "AC2–AC5". Case-SENSITIVE and
    // digit-terminated, which keeps it off ordinary words and off hex-ish
    // identifiers (`0xAC12` has no word boundary before "AC"). An acceptance
    // criterion is an artefact of the review that approved the work; naming one
    // on a published page tells a reader nothing they can act on.
    // RESIDUAL RISK, recorded: a product/model code spelled the same way ("the
    // AC12 controller") would misfire. Nothing on the 202 inventoried surfaces
    // does today; one that appears later is a line-pinned allowlist entry, which
    // is exactly what that mechanism is for.
    "acceptance_criterion_citation",
    /\bAC\d{1,3}\b/,
    'acceptance-criterion citation, e.g. "AC6"',
  ],
  [
    // NUMBERED RULING citation: "ruling 4", "rulings 1–2". The unnumbered
    // "per the ruling" spelling is already covered by ruling_reference above;
    // this covers the numbered form those pages used as a shorthand index into
    // an internal decision log. RESIDUAL RISK, recorded: a page citing an
    // EXTERNAL numbered ruling (a regulator's "Ruling 4") would misfire; these
    // are technical product pages, and no such citation exists on the corpus.
    "numbered_ruling_citation",
    /\brulings?[ \t]{1,3}\d{1,3}\b/i,
    'numbered ruling citation, e.g. "ruling 4" / "rulings 1–2"',
  ],

  // --- Class: TOOL / REVIEW-ROUND PROVENANCE (docs#171) --------------------
  // The planning-provenance class one step earlier in the process: not the work
  // item or decision a capability came from, but the numbered review or
  // convergence round a CONSTRAINT ON THE PAGE was derived in — "(<agent>
  // round-12 lesson — …)", "lesson from round 3", "<agent> found in round 7".
  // Same defect, same remedy: the sentence describes where the guidance came
  // from rather than stating it, and a reader of a published page has no round
  // 12 to consult.
  //
  // THE BINDING IS THE ROUND CITATION, NOT THE NAME. A tool or agent name on its
  // own is ordinary published product prose on the surfaces this engine scans —
  // integration docs explain connecting a named assistant to Cinatra, compare
  // named assistant products, and open quick-starts by naming one. None of that
  // can match, because a NUMBERED review round has to be bound to the name: the  // source-leak-allow: detector vocabulary
  // same BOUND-ADJACENCY proxy the work-item and ruling patterns use, never bare
  // same-line proximity.
  //
  // AND "ROUND" ALONE IS NEVER ENOUGH. "round trip", "round-robin", "rounded",
  // "approval rounds repeat until…" are ordinary technical prose, so every
  // pattern here requires DIGITS directly against the round noun, and then
  // EITHER a named tool/agent bound to it by adjacency or an explicit credit, OR
  // a derivation noun ("lesson", "learning", "takeaway", "finding", "verdict")
  // bound to it by adjacency or a derivational preposition. A numbered round
  // with neither stays green.
  //
  // SINGLE LINE ONLY, deliberately. The `generated_from` and `ratified` patterns
  // tolerate one hard wrap with a lookahead that rejects a continuation line
  // starting with a list, quote or table marker. That guard cannot be reused
  // honestly here: it only inspects the START of the SECOND line, so it cannot
  // see that the FIRST line was a heading or a table row, and a wrap-tolerant
  // `review_round_lesson` really does join "# Round 2" to a following paragraph
  // beginning "Findings are displayed…". Rather than ship a guard whose comment
  // would have to overclaim, this class does not cross a newline at all. Every
  // gap is a bounded run of spaces/tabs, so the patterns stay linear.
  //
  // RESIDUAL RISKS, recorded rather than hidden:
  //   - The name list is a CLOSED enumeration of publicly named coding agents
  //     and assistants. An unlisted or newly named one in the bare
  //     "<agent> round-N" shape is missed — unless a derivation noun is present,
  //     in which case `review_round_lesson` catches it whatever the name was.
  //     A closed list is the deliberate trade: the alternative (any capitalised
  //     token before a round citation) fires on ordinary product prose.
  //   - A PRODUCT-OWNED numbered round bound to a derivation noun would misfire:
  //     "the evaluation dashboard displays review round 2 findings" is about a  // source-leak-allow: detector vocabulary
  //     product surface, not about how the page was written, and it is
  //     structurally identical to "round-12 lesson". No local lexical rule
  //     separates them. This engine runs over CALLER repos' surfaces, which are
  //     not swept from here, so nothing is claimed about how many are phrased
  //     that way today: a genuine one is a line-pinned allowlist entry, which is
  //     exactly what that mechanism is for. The same goes for an EXTERNAL
  //     numbered round ("the standards body's round 2 findings").
  //   - A violation SPLIT ACROSS A HARD WRAP ("The learnings\nfrom round 11 …")
  //     is missed, per the single-line decision above.
  //   - Rephrasings outside the three shapes are missed — "round 12 produced a
  //     lesson", "what round 7 taught us". Widening to those means matching a
  //     numbered round against an open verb phrase, which is where the
  //     product-owned-round misfire above stops being hypothetical. Caught in
  //     review, not here, exactly as this list trades everywhere else.
  [
    // The named-agent shapes: the name, then EITHER nothing but the round
    // citation ("<agent> round-12") or an EXPLICIT CREDIT — a crediting verb,
    // optionally an object, optionally a preposition ("<agent> found in round
    // 7", "<agent> flagged this in review round 2").  // source-leak-allow: detector vocabulary
    //
    // The preposition lives INSIDE the verb branch on purpose. Allowing a bare
    // preposition made "use <agent-a> in round 2 and <agent-b> in round 3" fail,
    // and that sentence credits nobody with anything — it assigns a model to a
    // numbered round, which is ordinary product prose for an AI workspace. With
    // the verb required, adjacency ("<agent> round-12") or a credit is the only
    // way in, and the bare-adjacency form is the one the docs#171 live miss used.
    //
    // Case-SENSITIVE, because these are proper nouns in the crediting shape.
    // Lower-case handles that a product surface may list (`@claude`, `@chatgpt`,
    // `@gemini`) are display identifiers, not a credit, and they do not carry a
    // round citation either way.
    //
    // Every gap is a BOUNDED run of spaces/tabs — never `\s*`, which would cross
    // a blank line and join a sentence ending on an agent name to a following
    // paragraph starting "Round 3 of the rollout…".
    "tool_review_round_citation",
    /\b(?:Codex|Claude(?:[ \t]Code)?|ChatGPT|Gemini|Copilot|Cursor|Devin|Aider)\b[ \t]{0,3}[,;:—–-]?[ \t]{0,3}(?:(?:found|flagged|caught|raised|noted|spotted|surfaced|rejected|challenged|suggested|recommended|reviewed|converged|discovered|identified|observed)[ \t]{1,3}(?:(?:this|it|that|them)[ \t]{1,3})?(?:(?:in|at|during|on)[ \t]{1,3})?)?(?:the[ \t]{1,3})?(?:(?:review|convergence|feedback|audit|grading)[ \t-]{1,2})?rounds?[ \t-]{1,2}#?\d{1,3}\b/,
    'tool/agent credited with a numbered review round, e.g. "<agent> round-12" / "<agent> found in round 7"',
  ],
  [
    // The round citation carrying its derivation noun, directly or across one
    // separator glyph: "round-12 lesson", "Round-4 finding:", "convergence
    // round 9 takeaway", "Round 12's lesson". No name is required — the
    // derivation claim is the violation, and the commonest spelling of it
    // credits no tool at all.
    "review_round_lesson",
    /\b(?:(?:review|convergence|feedback|audit|grading)[ \t-]{1,2})?rounds?[ \t-]{1,2}#?\d{1,3}(?:['’]s)?\b[ \t]{0,3}[,;:—–-]?[ \t]{1,3}(?:lessons?|learnings?|takeaways?|findings?|verdicts?)\b/i,
    'numbered review round cited as the source of the guidance, e.g. "round-12 lesson"',
  ],
  [
    // The reverse order, bound by a DERIVATIONAL preposition: "lesson from
    // round 3", "the takeaway from convergence round 9", "the lesson came from
    // round 3".
    //
    // Only `from` / `during` / `after` — never `in`, `of` or `at`. Those are
    // CONTAINMENT prepositions: "compare findings in review round 2 with  // source-leak-allow: detector vocabulary
    // findings in review round 3" locates product findings, it does not claim  // source-leak-allow: detector vocabulary
    // published guidance was derived from them. Requiring a derivational
    // preposition is what keeps "Lessons from earlier releases are captured as
    // reusable skills" and "the findings list" green too — the noun has to point
    // AT a numbered round, not merely precede one.
    "lesson_from_review_round",
    /\b(?:lessons?|learnings?|takeaways?|findings?|verdicts?)\b(?:[ \t]{1,3}(?:learned|captured|recorded|carried|came|come|comes|emerged|resulted))?[ \t]{1,3}(?:from|during|after)[ \t]{1,3}(?:the[ \t]{1,3})?(?:(?:review|convergence|feedback|audit|grading)[ \t-]{1,2})?rounds?[ \t-]{1,2}#?\d{1,3}\b/i,
    'guidance pinned to a numbered review round, e.g. "lesson from round 3"',
  ],

  // --- Class: IN-PAGE AUTHORING / PUBLISH-STATUS ANNOTATION (docs#160) ------
  // Editorial scaffolding that survived into the published bytes: a note about
  // what the page decides to publish, what state the spec is in, what is
  // "outside the mock", or how the next publish is scheduled. It is the same
  // family as the class-1 production notes ("this page is compiled from…") —
  // prose about the page rather than about the product — in the vocabulary a
  // design spec accumulates.
  //
  // ALL THREE ARE DELIBERATELY NARROWED to the ANNOTATION form, because the bare
  // phrases are ordinary product vocabulary in a product that itself publishes,
  // reviews and versions things. "The publish decision is recorded on the run",
  // "review each publish decision before release", "check the spec status before
  // deploying" and "the design notes for this integration are in the appendix"
  // are all legitimate published prose, and every one of them fails an
  // unqualified pattern.
  //
  // The narrowing is POSITIVE, not a blacklist of continuations. A blacklist was
  // tried first and rejected: any finite list of following words still leaves
  // "…decision before release" and "…status before deploying" failing, and the
  // list can never be completed. What actually separates the two is STRUCTURAL —
  // an annotation TERMINATES (end of line, a separator glyph, a closing bracket,
  // an em/en dash introducing its value) or POINTS at a location in the document
  // ("publish decision in §VII"), whereas a sentence CONTINUES with the phrase as
  // an ordinary noun. That is checkable rather than enumerable. A rephrased
  // annotation is caught in review, not here — the same trade this list makes
  // everywhere else.
  //
  // RESIDUAL RISK, recorded rather than hidden (Codex review, docs#160). The
  // narrowing constrains what may FOLLOW the phrase, not what precedes it, so a
  // sentence that ENDS on the phrase still fails:
  //     "Before release, review the publish decision."
  //     "Before deploying, check spec status."
  //     "Please review the design notes for the mock."
  // No local lexical rule separates those from an annotation, because a terminal
  // noun phrase is exactly what an annotation is. They are left failing on
  // purpose: the escape is a line-pinned allowlist entry — reviewed, owned, and
  // expiring — which is preferable to an unenforced class. Nothing on the 202
  // inventoried published surfaces is phrased this way today.
  [
    "publish_decision",
    /\bpublish(?:ing)? decisions?(?=[ \t]*(?:[·•|)\]}—–─:]|\r?\n|$)|[ \t]+(?:in|per|recorded in)[ \t]*(?:§|section\b))/i,
    '"publish decision" as a page annotation',
  ],
  [
    "spec_status_annotation",
    /\bspec status(?=[ \t]*(?:[·•|)\]}—–─:]|\r?\n|$))/i,
    '"spec status" as a page annotation',
  ],
  [
    // "design note, outside the page mock" and its authoring twin. Deliberately
    // NOT extended to "review note" — a review note is a real Cinatra product
    // object, and a pattern that fires on the product's own vocabulary costs
    // more than the annotation it catches.
    "design_note_annotation",
    /\b(?:design|authoring) notes?\b[ \t]*[,;:—–-]?[ \t]*(?:outside\b|not (?:in|part of)\b|excluded from\b|for the mock\b)/i,
    '"design note / authoring note, outside …" (page-scoping authoring annotation)',
  ],
  [
    // Internal scheduling of a docs publish, stated on the published page ("a
    // separate, owner-gated publish"). The gating NOUN is required: "owner" is
    // an ordinary Cinatra role and "owner-gated" alone would reach real product
    // prose about owner-approved actions.
    "owner_gated_publish",
    /\bowner-gated[ \t]{1,3}(?:publish|release|rollout|deploy|deployment|decision)\b/i,
    '"owner-gated publish" (internal publish scheduling)',
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
  const out = {
    docs: DEFAULT_DOCS_DIR,
    paths: [],
    pathsSupplied: false,
    allowlist: DEFAULT_ALLOWLIST_PATH,
    now: new Date(),
    printFiles: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--docs" || argv[i] === "-d") out.docs = argv[++i];
    else if (argv[i] === "--paths") {
      out.pathsSupplied = true;
      out.paths.push(...parsePathsSpec(argv[++i]));
    }
    else if (argv[i] === "--print-files") out.printFiles = true;
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

// Tracked published-surface files under one scan root (a directory, or — in
// multi-path mode — possibly a single file; `git ls-files` handles both pathspec
// shapes). `git ls-files` respects gitignore and returns only tracked files (so
// an untracked scratch file can never trip the gate); scoping the pathspec
// confines the scan to the configured tree. Paths are returned relative to
// CWD. `-z` handles unusual filenames robustly.
//
// Both published formats are selected: Markdown (`.md`) and HTML (`.html` /
// `.htm`, docs#160). Nothing else — an image, a stylesheet or a script is not a
// prose surface, and a scan that guessed would be a scan nobody can predict.
function listScanFiles(docsDir) {
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
    .filter((f) => f.toLowerCase().endsWith(".md") || isHtmlPath(f));
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

// The text a file's patterns are matched against, plus the map back to source
// offsets. Markdown IS its own prose, so the map is the identity (returned as
// null, which the caller reads as "extracted index === source index"). HTML is
// reduced by the documented extraction contract in lib/html-text.mjs, and the
// returned map carries each extracted character's source offset so reporting
// and allowlist pinning stay on the SOURCE line.
function scannableText(file, source) {
  if (!isHtmlPath(file)) return { text: source, map: null };
  return extractHtmlText(source);
}

function main() {
  const { docs, paths, pathsSupplied, allowlist: allowlistPath, now, help, printFiles } = parseArgs(
    process.argv.slice(2)
  );
  if (help) {
    console.log(
      "Usage: check-meta-commentary [--docs <dir>] [--paths <newline/comma-separated dirs and/or .md/.html files>] [--allowlist <path>] [--print-files] [--now <ISO-date>]"
    );
    console.log("A non-empty --paths takes precedence over --docs; without it the gate scans the single --docs directory.");
    console.log("--print-files lists the files the configured paths selected (the exact read set) before scanning.");
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

  let scanFiles;
  try {
    if (multiPath) {
      // Union of tracked Markdown/HTML under every configured path, dedup'd (an
      // entry may be a directory or a single file; overlapping entries — e.g.
      // "docs,docs/overview.md" — scan a file once). FAIL CLOSED per entry: a
      // configured path that yields no tracked page at all is a config
      // error (a typo'd, untracked, or prose-free entry must surface, never
      // silently narrow the scan).
      const seen = new Set();
      scanFiles = [];
      for (const p of paths) {
        const files = listScanFiles(p);
        if (files.length === 0) {
          console.error(
            `[meta-commentary-gate] ERROR: configured path "${p}" matched no tracked Markdown or HTML files — fix the entry or drop it.`
          );
          process.exit(2);
        }
        for (const f of files) {
          if (!seen.has(f)) {
            seen.add(f);
            scanFiles.push(f);
          }
        }
      }
    } else {
      scanFiles = listScanFiles(docs);
    }
  } catch (e) {
    console.error(`[meta-commentary-gate] ERROR: ${e.message}`);
    process.exit(2);
  }

  // The exact read set the configured paths selected. Printed on request so the
  // path-selection scoping rule (docs#160 AC12) is checkable rather than
  // asserted: a path that does not appear here is never opened.
  if (printFiles) {
    for (const f of scanFiles) {
      if (SKIP_PATHS.has(f)) continue;
      console.log(`[meta-commentary-gate] selected: ${f}`);
    }
  }

  const violations = [];
  for (const file of scanFiles) {
    if (SKIP_PATHS.has(file)) continue;
    const source = readFileSync(resolveInCwd(file), "utf8");
    // For HTML the patterns run over the extracted PROSE; `map` translates a
    // match position back to the source offset so the report and the allowlist
    // key stay on the real file and line.
    const { text, map } = scannableText(file, source);
    for (const [id, regex, description] of PATTERNS) {
      const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
      const re = new RegExp(regex.source, flags);
      let match;
      while ((match = re.exec(text)) !== null) {
        const sourceIndex = map ? (map[match.index] ?? source.length) : match.index;
        const lineText = lineTextAt(source, sourceIndex);
        if (!allowed.has(`${file} ${id} ${lineText}`)) {
          violations.push({
            file,
            line: lineNumberAt(source, sourceIndex),
            id,
            description,
            // The matched text is reported from the EXTRACTED prose, so an
            // entity-encoded or tag-split match reads as the phrase it is.
            snippet: match[0].replace(/\s+/g, " ").trim(),
          });
        }
        if (match.index === re.lastIndex) re.lastIndex++; // zero-width guard
      }
    }
  }

  // Deterministic order regardless of pattern-list order: file, then source
  // line, then pattern id. An HTML page yields matches out of line order
  // otherwise (each pattern sweeps the whole page in turn).
  violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id)
  );

  const scopeLabel = multiPath
    ? `across ${scanFiles.length} tracked Markdown/HTML file(s) under the configured paths (${paths.join(", ")})`
    : `across tracked Markdown/HTML pages under "${docs}/"`;

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
      `not what is still in flight ("still landing", "forthcoming"); and not the internal work item, ` +
      `acceptance criterion or decision a capability came from ("epic #123, landed", "cinatra#1607 AC6", ` +
      `"ruling 4", "the ratified <X> mode"); and not the review round a constraint came out of ` +
      `("<agent> round-12 lesson", "lesson from round 3"). ` +
      `This holds for HTML pages exactly as for Markdown, comments included. ` +
      `Remove the meta/transition/provenance content from the page and state the capability as it stands.` +
      `\nA genuine false positive (real product content this pattern misfires on) goes in ` +
      `${allowlistPath} with an owner, a reviewBy date, and the exact full line as the snippet — see cinatra-ai/docs#119.`
  );
  process.exitCode = 1;
}

main();
