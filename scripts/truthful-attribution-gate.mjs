#!/usr/bin/env node
/**
 * truthful-attribution-gate — reusable CI gate (org-wide).
 *
 * Ratified truthful-attribution spec (converged spec comment
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
 * ======================= §6 — CORRECTION DISCOVERY ==========================
 * The spec defines `Correction-for: <sha>` repair commits, but re-checking an old
 * commit used to read only that commit's OWN message — so a landed repair was
 * INERT and the re-verify verdict never moved. When (and only when) a specific
 * commit is named with --commit — the re-verify path — the post-merge arm now
 * discovers `Correction-for: X` records that later landed on the default
 * branch's first-parent history and validates the LATEST valid one IN X's STEAD,
 * using X's own verification context (X's PR, approvals, reviewed head,
 * check-runs), because a correction RESTATES X's record. The push-HEAD default
 * path does not opt in and is unchanged. Fail-closed throughout: a correction can
 * only move a verdict by being a fully VALID record whose own claims verify
 * against X's context. See the §6 sections below for the rule and its edges.
 * That discovery is the LANDED path — records already on the default branch.
 * The same repair read IN A BRANCH, before merge, is §6b below.
 *
 * ==================== §7 — MULTI-COMMIT REBASE LANDING =====================
 * A REBASE merge lands the PR's commits INDIVIDUALLY and reports the LAST of
 * them as the PR's merge_commit_sha. The push arm therefore validated that one
 * commit and compared its one-commit diff against the PR's WHOLE reviewed
 * change: a `content-mismatch` BY CONSTRUCTION, even when every record was true
 * and the approval real (ci#94; the live cinatra#2709 six-commit repair
 * landing) — and precisely on the shape the §5 `Correction-for` repair
 * mechanism requires, since repairs must land as individual first-parent
 * commits to be discoverable at all. When the pushed commit is POSITIVELY
 * classified as the tip of a verbatim rebase of the reviewed commits, the
 * content binding is taken over the whole landed range (base..tip) against the
 * PR's full reviewed change, and each landed commit's OWN record is judged
 * per-commit — the same per-commit judgement check 5 has always applied. The
 * squash and single-commit paths are untouched: anything unproven classifies as
 * "single" and binds exactly as before (fail closed), and a tampered rebased
 * range still has to re-derive the reviewed fingerprint over the whole range.
 *
 * ============ §5b — THE TOOL-MADE DEPENDENCY BUMP (engineering#679) ========
 * Check 5 reads a commit by a known agent or bot identity as agent work and
 * demands a named `Assisted-by` on it. ONE narrow class is exempt: the
 * tool-made dependency bump — a commit whose author AND committer are class
 * identities (the org's agent bot, dependabot, renovate, github-actions; the
 * committer `GitHub <noreply@github.com>` counts as the author's identity,
 * which is how an API-made commit looks), whose diff touches ONLY dependency
 * files (manifests, lockfiles, container image references) and which, outside a
 * lockfile (whose whole diff is accepted as-is), changes ONLY lines carrying a
 * version or an image digest — each changed line pairing with the line it
 * replaced once that token is blanked, so adding or removing a dependency name,
 * a script, a stage or a command is NOT a bump. Nobody changed the code there:
 * the tool rewrote a version line, so the truthful record is
 * `Assisted-by: none` (or no line, normalizing to none), and such a commit
 * contributes no named assistant to a squash record's union. Everything else
 * keeps the rule unchanged — a bot-identity commit touching anything outside
 * the class still needs a named agent, and workflow files, gate suites and
 * every other high-risk path stay outside the class by construction. The class
 * is DATA: config/tool-made-bump-class.json (`excludeGlobs` keeps .github/**
 * out of the class explicitly, so a manifest that lives beside the workflows is
 * never a bump). The pairing is PER HUNK — a dependency line moved from one
 * section to another is a membership change, not a bump — and a commit whose own
 * message NAMES an agent is never exempted (the exemption spares a record from
 * inventing an agent; it never erases a declared one). Fail closed throughout:
 * an unparseable config, a pattern that will not compile or does not capture its
 * token, an unreadable diff, a merge commit, a rename, a copy, a binary file, an
 * added or deleted file, a mode change, a changed path the read diff does not
 * cover, a REST payload at the API's 300-file cap or without its patch, and any
 * unrecognized line => not a bump, and today's rule applies.
 *
 * ========= §6b — THE IN-BRANCH CORRECTION COVER (pre-merge check 5) ========
 * A commit's message is fixed the moment the commit exists, so a historical
 * bot-identity commit that landed with no named `Assisted-by` could never
 * satisfy check 5 — the missing record cannot be written into it, and rewriting
 * the branch's history to fix it discards every review and every green check a
 * long-lived pull request already earned. The pre-merge arm therefore reads the
 * record where it CAN be supplied: in the branch. A flagged commit is covered —
 * no finding, an `agent-commit-corrected` NOTICE instead — when a LATER commit
 * of the SAME range carries a well-formed `Correction-for:` line (CORRECTION_RE,
 * on a line of its own, in the subject or the trailer block) naming that
 * commit's FULL 40-hex sha AND carries a named, non-`none` `Assisted-by` of its
 * own. This MIRRORS the coordinator's merge road (its `4-assisted-union`
 * check), which has accepted exactly this since 2026-09-14, so the
 * CI engine and the merge road now agree on the same branch. Nothing else is
 * relaxed: a prose mention of the sha, an abbreviated sha, a correction whose
 * own record names no agent, one earlier in the range than the commit it names,
 * one naming a different commit, and one outside the range all leave check 5
 * exactly as it was. A correction need not be an empty commit (the merge road
 * reads identities and message lines, never the correction's tree). See the §6b
 * section below for the rule, its order contract and its edges.
 *
 * Zero runtime dependencies (node builtins only). GitHub API access is via an
 * injectable client (default: `gh api` through execFileSync), so the entire
 * analysis is unit-testable offline with a stub client.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical as canonicalAuthorization, parseAuthorization, verifyDelegatedReceipt } from "./delegated-merge-receipt.mjs";

export const GATE_VERSION = "0.4.0";

const VALID_MODES = ["warn", "enforce"];
const VALID_ARMS = ["pre-merge", "post-merge", "merge-group"];
const VALID_FORMATS = ["text", "json"];

const VALUE_FLAGS = new Set([
  "arm", "mode", "format", "config", "high-risk-defaults", "gate-suite",
  "diff-base", "diff-base-env", "commit", "repo", "pr", "head-sha",
  // This gate's own Actions run id (defaults to GITHUB_RUN_ID) and the re-poll
  // budget for required contexts that have not concluded yet.
  "self-run-id", "gate-arm-wait-ms",
  // Optional override for the branch whose first-parent history the §6
  // correction discovery scans (default: auto-resolved origin/HEAD -> main).
  "default-branch",
  // The merge_group event's candidate commit and the base the queue built it
  // on (github.event.merge_group.head_sha / .base_sha).
  "merge-group-head", "merge-group-base",
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
const OWNED_KEY_RE = /^(Assisted-by|Reviewed-by|Gate-suite|Accountable|Correction-for|Merge-authorization):/;

// Git-standard auto-generated IDENTITY trailers. On `gh pr merge
// --squash`, GitHub auto-appends a `Co-authored-by:` line as its OWN trailer
// paragraph (a blank line separating it from the real record block). A
// `Signed-off-by:` may likewise be appended as a terminal identity paragraph.
// These are NOT the AI/verification record (`Assisted-by` is); they must not be
// allowed to displace a truthful record by sitting in the final paragraph.
// git treats these keys case-insensitively; require a non-empty value.
const IDENTITY_TRAILER_RE = /^(Co-authored-by|Signed-off-by):[ \t]+\S.*$/i;

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
  //
  // Helper: locate the paragraph that ends at `to` (exclusive). Returns
  // { start, end } where allLines.slice(start, end) is the paragraph's lines,
  // skipping any trailing blank lines below `to` first. `end === start` (and 0)
  // means there is no further paragraph.
  const paragraphEndingAt = (to) => {
    let e = to;
    while (e > 0 && allLines[e - 1].trim() === "") e--;
    let s = e;
    while (s > 0 && allLines[s - 1].trim() !== "") s--;
    return { start: s, end: e };
  };
  const isPureIdentityParagraph = (s, e) =>
    e > s && allLines.slice(s, e).every((l) => IDENTITY_TRAILER_RE.test(l));

  // terminal-identity-paragraph fold. GitHub's squash machinery can
  // append one or more git-standard IDENTITY trailer paragraphs
  // (`Co-authored-by:` / `Signed-off-by:`) AFTER the real record block, each as
  // its own paragraph (blank-separated). Reading only the final paragraph would
  // miss the record. So: peel off a TERMINAL SUFFIX of pure-identity paragraphs,
  // then fold in EXACTLY ONE immediately-preceding paragraph as the candidate
  // record paragraph (bounded — no unbounded backward scan, no resurrecting an
  // arbitrary earlier `Key: value` paragraph). If the final paragraph is itself
  // NOT pure-identity, nothing is folded and current behavior stands (the
  // no-hiding-behind-prose protection is fully preserved).
  let { start: recStart, end: recEnd } = paragraphEndingAt(allLines.length);
  const identityLines = [];
  // Peel terminal pure-identity paragraphs (one or more).
  while (recEnd > recStart && isPureIdentityParagraph(recStart, recEnd)) {
    // Prepend this identity paragraph's lines (preserve overall order) and step
    // back to the paragraph that precedes its blank separator.
    identityLines.unshift(...allLines.slice(recStart, recEnd));
    const prev = paragraphEndingAt(recStart);
    if (prev.end === prev.start) {
      // No preceding paragraph at all — this is a record-less commit whose only
      // content is identity trailers. Do NOT rescue it; leave the (empty) record
      // paragraph so the missing-Assisted-by error stands. Drop the peeled
      // identity lines from `block` (they are not a record).
      recStart = prev.start;
      recEnd = prev.end;
      identityLines.length = 0;
      break;
    }
    recStart = prev.start;
    recEnd = prev.end;
  }
  // `block` = the candidate record paragraph's lines followed by the peeled
  // terminal identity lines, WITHOUT the blank separators (a blank line in
  // `block` would be treated as a non-trailer line and wrongly invalidate it).
  // If no identity suffix was peeled this collapses to the plain final paragraph.
  const block =
    identityLines.length > 0
      ? [...allLines.slice(recStart, recEnd), ...identityLines]
      : allLines.slice(recStart, recEnd);

  const assisted = []; // { name, model, isNone, raw }
  const reviewed = []; // { name, email, login, tier, raw }
  let gateSuite = null; // { suite, version, raw } | null
  let accountable = null; // { name, email, login, raw } | null
  let correctionFor = null; // sha | null
  let authorization = null;
  let authorizationCount = 0;
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
    if ((m = parseAuthorization(raw))) {
      authorizationCount++;
      authorization = m;
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
  if (authorizationCount > 1) errors.push(`duplicate Merge-authorization trailer (only one allowed)`);
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
    authorization,
    hasHumanArm: reviewed.length > 0,
    hasGateArm: Boolean(gateSuite && accountable),
    hasDelegatedArm: Boolean(authorization),
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
  if (!parsed.hasHumanArm && !parsed.hasGateArm && !parsed.hasDelegatedArm) {
    errors.push(`no verification arm — need a Reviewed-by (human arm), a Gate-suite+Accountable (gate arm), or a verified Merge-authorization`);
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
 *
 * §5b (engineering#679): `opts.bumps` is an optional array of booleans parallel
 * to `messages` flagging the TOOL-MADE DEPENDENCY BUMP commits. A flagged commit
 * contributes NOTHING to the union and counts as `none` (its own record may be
 * `Assisted-by: none` or no line at all, normalizing to none) — so a squash that
 * mixes a bump with agent work still names the agent, and an all-bump squash
 * aggregates to the single truthful `Assisted-by: none`. The flag only ever
 * REMOVES an invented agent, never a declared one: a flagged commit whose own
 * message NAMES an agent is aggregated exactly as any other commit is.
 *
 * §5c (engineering#680): `opts.contentFree` is the same kind of parallel array
 * for CONTENT-FREE CLEAN MERGES (a bring-up-to-date merge whose tree is the
 * clean merge of its parents). Nobody wrote a line in one, so it contributes
 * nothing and counts as `none` — a forward that carries only such merges
 * aggregates to the single truthful `Assisted-by: none`, and one alongside agent
 * work leaves the agent named. The same never-erase rule applies.
 */
export function aggregateAssisted(messages, opts = {}) {
  const bumps = Array.isArray(opts.bumps) ? opts.bumps : [];
  const contentFree = Array.isArray(opts.contentFree) ? opts.contentFree : [];
  const seen = new Set();
  const lines = [];
  let sawNamed = false;
  let sawNone = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const p = parseTrailers(msg);
    // A flagged bump or content-free merge contributes `none` — UNLESS its own
    // message names an agent, which the union never erases (see below).
    if ((bumps[i] || contentFree[i]) && !p.assisted.some((a) => !a.isNone)) { sawNone = true; continue; }
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
// ref now that the bot is a recognized agent (spec §5). Check 5 cares about
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

// ===========================================================================
// §6 — CORRECTION DISCOVERY: the git-walking collector (the impure half).
//
// The spec defines `Correction-for: <sha>` repair commits, but nothing DISCOVERS
// them: re-checking an old commit X read only X's OWN message, so a landed
// repair was inert — the re-verify verdict never moved. This collector walks the
// default branch's FIRST-PARENT history AFTER X and hands the candidate commits
// to the pure selector (selectGoverningCorrection), which owns every rule.
//
// BOUNDED, and bounded at the RIGHT END. A correction lands shortly AFTER the
// commit it repairs, i.e. at the OLD end of `X..<default>`. `git log --max-count`
// truncates from the TIP, which would drop exactly the commits we need whenever X
// is old, so the window here is taken from the X end (oldest-first) instead.
// Consequence, disclosed rather than hidden: when the range exceeds the bound,
// "latest-wins" is latest-WITHIN-THE-WINDOW, and the caller emits a
// `correction-scan-truncated` warning naming the bound.
//
// Every failure path returns an EMPTY candidate list with a reason: no discovery
// means X's own verdict stands unchanged, which is the fail-closed direction.
// ===========================================================================

/**
 * How many commits after X are scanned for corrections. Generous: a repair that
 * lands more than this many first-parent commits after its target is beyond the
 * window (and the truncation is reported, never silently assumed absent).
 */
export const CORRECTION_SCAN_MAX_COMMITS = 1000;

/** 40-hex or null (lowercased). The only sha shape this engine will act on. */
function asFullSha(v) {
  const s = String(v ?? "");
  return /^[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}

/** Short display form for findings; falls back to the raw value. */
function shortSha(v) {
  const s = String(v ?? "");
  return /^[0-9a-fA-F]{7,}$/.test(s) ? s.slice(0, 8) : s;
}

/**
 * The ref whose first-parent history a correction must land on to govern.
 * Explicit override first (--default-branch), then the remote's own HEAD
 * symref, then the conventional names. Returns null when none resolves (=> no
 * discovery, X's own verdict stands).
 */
export function resolveDefaultBranchRef({ explicit } = {}, cwd = process.cwd()) {
  if (explicit) {
    try { verifyGitRef(explicit, cwd); return explicit; } catch { return null; }
  }
  try {
    const out = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) { verifyGitRef(out, cwd); return out; }
  } catch { /* fall through to the conventional names */ }
  for (const c of ["origin/main", "origin/master", "main", "master"]) {
    try { verifyGitRef(c, cwd); return c; } catch { /* next */ }
  }
  return null;
}

/**
 * Collect the commits that could correct `targetSha`: the default branch's
 * first-parent commits AFTER it, OLDEST-FIRST (the order the pure selector
 * treats as authoritative — the last entry is nearest the branch tip).
 *
 * Returns { candidates: [{ sha, message }], scanned, truncated, reason }.
 * Candidates are NOT filtered here — whether a commit is a correction for X (and
 * whether it is well-formed, self-referential, or superseded) is decided by
 * selectGoverningCorrection, so every rule stays unit-testable without git.
 * Never throws.
 */
export function collectCorrectionCandidates({
  targetSha, defaultRef, maxCommits = CORRECTION_SCAN_MAX_COMMITS, cwd = process.cwd(),
} = {}) {
  const empty = (reason) => ({ candidates: [], scanned: 0, truncated: false, reason });
  const target = asFullSha(targetSha);
  if (!target) return empty("the target commit did not resolve to a full sha — correction discovery skipped");
  if (!defaultRef) return empty("no default-branch ref resolved — correction discovery skipped");

  // X must be ON the default branch's history. Without this an off-branch commit
  // (a PR head, a dropped branch) would make `X..<default>` enumerate the WHOLE
  // branch — an unbounded walk that could also surface commits that do not
  // descend from X at all.
  try {
    execFileSync("git", ["--literal-pathspecs", "merge-base", "--is-ancestor", "--end-of-options", target, defaultRef], { stdio: "ignore", cwd });
  } catch {
    return empty(`commit ${shortSha(target)} is not an ancestor of ${defaultRef} — no landed correction can govern it`);
  }

  // Shas only (cheap, ~41 bytes/commit) so the window can be taken from the X
  // end BEFORE any message is read. --reverse => oldest-first.
  let shas;
  try {
    const out = execFileSync(
      "git",
      ["--literal-pathspecs", "rev-list", "--first-parent", "--reverse", "--end-of-options", `${target}..${defaultRef}`],
      { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );
    shas = out.split("\n").map((s) => s.trim()).filter((s) => asFullSha(s));
  } catch (e) {
    return empty(`git rev-list ${shortSha(target)}..${defaultRef} failed (${e.message}) — correction discovery skipped`);
  }
  if (!shas.length) return { candidates: [], scanned: 0, truncated: false, reason: null };

  const truncated = shas.length > maxCommits;
  const window = truncated ? shas.slice(0, maxCommits) : shas;

  // One batched read for the window. `--no-walk=unsorted` keeps git from
  // re-ordering by date; we re-key by %H anyway so the output order is not load-
  // bearing — the returned order is the first-parent order computed above.
  let out;
  try {
    out = execFileSync(
      "git",
      ["--literal-pathspecs", "log", "--no-walk=unsorted", "--format=%H%x1f%B%x00", "--end-of-options", ...window],
      { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    return empty(`git log for the correction window failed (${e.message}) — correction discovery skipped`);
  }
  const messageBySha = new Map();
  for (const rec of out.split("\0")) {
    const r = rec.replace(/^\n+/, "");
    if (!r) continue;
    const sep = r.indexOf("\x1f");
    if (sep === -1) continue;
    const sha = asFullSha(r.slice(0, sep).trim());
    if (sha) messageBySha.set(sha, r.slice(sep + 1).replace(/\n+$/, ""));
  }
  const candidates = window
    .filter((sha) => messageBySha.has(sha))
    .map((sha) => ({ sha, message: messageBySha.get(sha) }));
  return { candidates, scanned: window.length, truncated, reason: null };
}

// ===========================================================================
// §7 — MULTI-COMMIT REBASE LANDING: the git-walking collector (the impure half).
//
// A REBASE merge does not synthesize a commit: it replays the PR's commits onto
// the base INDIVIDUALLY and reports the LAST of them as the PR's
// merge_commit_sha. The push arm then validated that one commit and compared its
// one-commit diff against the PR's WHOLE reviewed change — a content-mismatch by
// construction (ci#94; the live cinatra#2709 six-commit repair landing), and the
// Correction-for repair mechanism REQUIRES that shape (repairs must land as
// individual first-parent commits to be discoverable by §6, and cannot be
// squashed without collapsing to one Correction-for). This collector hands the
// pure classifier the local first-parent facts it needs to decide whether the
// pushed commit is the TIP of such a landing: each candidate commit's sha,
// parent count, identity and message.
//
// `--max-count` truncates from the TIP, which is exactly right here (unlike the
// §6 scan, whose window must be taken from the OLD end): a rebase's landed set
// is the newest N commits ending at the pushed one. Never throws — an empty
// chain means the shape is not classified and the single-commit binding stands,
// which is the fail-closed direction (the pre-ci#94 behavior).
// ===========================================================================

/**
 * GitHub's `/pulls/{n}/commits` returns at most 250 commits. A PR at or over
 * that cap cannot have its reviewed set enumerated exactly, so a landed set
 * cannot be bound to it — the classifier refuses (fail closed) rather than bind
 * against a truncated list. The same number bounds the local first-parent walk.
 */
export const PR_COMMITS_API_CAP = 250;

/**
 * The first-parent chain ending at `commit`, NEWEST-FIRST, at most `depth`
 * entries: [{ sha, parentCount, message, authorName, authorEmail,
 * committerName, committerEmail }].
 *
 * Merge commits are NOT excluded here (unlike the pre-merge range walks): their
 * presence in a candidate landed set is precisely what disproves a rebase
 * landing, so the parent count must REACH the classifier rather than be filtered
 * away. Returns { chain, reason }; never throws.
 */
export function collectLandedChain({ commit, depth, cwd = process.cwd() } = {}) {
  const empty = (reason) => ({ chain: [], reason });
  if (!commit) return empty("no commit given — the landing shape was not classified");
  const want = Number(depth);
  if (!Number.isFinite(want) || want < 1) return empty("a non-positive walk depth was requested — the landing shape was not classified");
  const max = Math.min(Math.trunc(want), PR_COMMITS_API_CAP + 1);
  let out;
  try {
    out = execFileSync(
      "git",
      ["--literal-pathspecs", "log", "--first-parent", `--max-count=${max}`, "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x00", "--end-of-options", commit],
      { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    return empty(`git log --first-parent for ${shortSha(commit)} failed (${e.message}) — the landing shape was not classified`);
  }
  const chain = [];
  for (const rec of out.split("\0")) {
    const r = rec.replace(/^\n+/, "");
    if (!r) continue;
    // The message is the LAST field and may contain anything; everything past the
    // six fixed fields is re-joined, so a body carrying a literal \x1f can never
    // shift the identity columns — and identity is what check 5 keys on.
    const parts = r.split("\x1f");
    if (parts.length < 7) continue;
    const sha = asFullSha(parts[0].trim());
    if (!sha) continue;
    chain.push({
      sha,
      parentCount: parts[1].trim() ? parts[1].trim().split(/\s+/).filter(Boolean).length : 0,
      authorName: parts[2],
      authorEmail: parts[3],
      committerName: parts[4],
      committerEmail: parts[5],
      message: parts.slice(6).join("\x1f").replace(/\n+$/, ""),
    });
  }
  return { chain, reason: null };
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

/**
 * Full 40-hex sha of a commit-ish via local git, or null. Used to compare a
 * merge commit against a PR's merge_commit_sha (which is always a full sha).
 */
export function resolveCommitSha(commitish, cwd = process.cwd()) {
  if (!commitish) return null;
  try {
    const out = execFileSync("git", ["--literal-pathspecs", "rev-parse", "--verify", "--quiet", "--end-of-options", `${commitish}^{commit}`], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch { return null; }
}

/**
 * tree object id of a commit (for the tree-identity bridge, §5), or null.
 *
 * `--verify` is REQUIRED here, not decoration. Plain `git rev-parse` ECHOES the
 * arguments it does not itself consume, and `--end-of-options` is one of them, so
 * `git rev-parse --end-of-options <rev>^{tree}` prints TWO lines:
 *     --end-of-options
 *     <40-hex tree sha>
 * A trimmed capture of that is not a tree id. Local-vs-local comparisons happened
 * to survive (both sides carried the same prefix), but the moment ONE side was
 * resolved through the commits API — a FORK head, or any head this checkout does
 * not have (a deleted branch after merge) — the prefixed string could never equal
 * the API's bare sha, so the fork/deleted-head fallback reported tree-MISMATCH on
 * byte-identical trees. `--verify` puts rev-parse in single-revision mode (no
 * echo) and `--quiet` keeps a genuinely unresolvable object silent; the explicit
 * 40-hex assertion then fails CLOSED to "unresolvable" if any future git ever
 * decorates the output again, rather than emitting a value that silently compares
 * unequal to a real tree id.
 */
export function treeOf(commitish, cwd = process.cwd()) {
  if (!commitish) return null;
  try {
    const out = execFileSync("git", ["--literal-pathspecs", "rev-parse", "--verify", "--quiet", "--end-of-options", `${commitish}^{tree}`], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch { return null; }
}

/**
 * Tree-identity for the post-merge bridge (spec §5). LOCAL git first
 * (fast, offline, unchanged for in-repo PRs); API fallback ONLY when local
 * can't resolve the object — i.e. a FORK head whose commit lives only on the
 * fork but whose tree the base repo's commits API can still resolve. Returns
 * true | false | undefined (undefined => still fail-closed in analyzePostMerge).
 */
export function resolveTreeMatch({ client, commit, reviewedHeadSha, treeOf: treeOfFn = treeOf }) {
  let tm = treeOfFn(commit);
  if (!tm && client?.commitTree) tm = client.commitTree(commit);
  let tr = reviewedHeadSha ? treeOfFn(reviewedHeadSha) : null;
  if (!tr && reviewedHeadSha && client?.commitTree) tr = client.commitTree(reviewedHeadSha);
  return tm && tr ? tm === tr : undefined;
}

/**
 * The heads a LIVE, QUALIFIED approval actually sits on at merge time.
 *
 * "Live" is not just `state === "APPROVED"` on some historical row. GitHub
 * rewrites a dismissed review's state to DISMISSED, so that filter removes
 * dismissals — but an approval the SAME reviewer later superseded with
 * CHANGES_REQUESTED is still an APPROVED row in the list, and honouring it would
 * bind the record to a head its reviewer stopped vouching for (codex-converge
 * HIGH). So this applies the gate's own §5 latest-review semantics and the same
 * standing rules verifyReviewedLine enforces:
 *   - per LOGIN, take that login's LATEST non-dismissed review; keep the head only
 *     if that latest review is APPROVED;
 *   - never the PR author's own approval (a self-approval is not a review);
 *   - the login's repo permission must meet at least the peer tier, when the
 *     permission data is available — an unknown permission does NOT qualify
 *     (fail closed).
 * Newest first, de-duplicated.
 */
export function resolveApprovedHeads(reviews, { prAuthorLogin = null, permissionByLogin = null } = {}) {
  const byLogin = new Map();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    const login = r?.user?.login;
    if (!login || !r.state || r.state === "DISMISSED") continue;
    // COMMENTED reviews do not change an approval's standing (GitHub keeps the
    // APPROVED row live), so they are not "latest-review" candidates.
    if (r.state === "COMMENTED") continue;
    const t = new Date(r.submitted_at).getTime();
    const prev = byLogin.get(login.toLowerCase());
    const pt = prev ? prev.t : -Infinity;
    if (!prev || (Number.isFinite(t) ? t : -Infinity) >= pt) byLogin.set(login.toLowerCase(), { r, t: Number.isFinite(t) ? t : -Infinity, login });
  }
  const rows = [];
  for (const { r, t, login } of byLogin.values()) {
    if (r.state !== "APPROVED") continue;
    if (typeof r.commit_id !== "string" || r.commit_id === "") continue;
    if (prAuthorLogin && login.toLowerCase() === String(prAuthorLogin).toLowerCase()) continue;
    if (permissionByLogin) {
      if (!permissionMeetsTier(permissionByLogin[login], "peer")) continue;
    }
    rows.push({ sha: r.commit_id, t });
  }
  rows.sort((a, b) => b.t - a.t);
  return [...new Set(rows.map((r) => r.sha))];
}

/**
 * Reviewed head for the post-merge bindings.
 *
 * The PR head at merge stays PRIMARY: resolving the reviewed head to an older
 * approval would let commits pushed AFTER that approval be blessed by it, which
 * is the fail-open this whole gate exists to prevent. The live approved heads
 * (state APPROVED, never DISMISSED) are returned alongside for the tree-equality
 * fallback below. Only when there is no PR head at all does the latest LIVE
 * approval become the reviewed head — never a dismissed review's commit.
 */
export function resolveReviewedHead({ prHeadSha, reviews, prAuthorLogin = null, permissionByLogin = null }) {
  const approvedHeads = resolveApprovedHeads(reviews, { prAuthorLogin, permissionByLogin });
  if (prHeadSha) return { headSha: prHeadSha, approvedHeads, source: "pr-head" };
  if (approvedHeads.length) return { headSha: approvedHeads[0], approvedHeads, source: "latest-live-approval" };
  return { headSha: null, approvedHeads, source: "none" };
}

/**
 * TREE-EQUALITY FALLBACK against the live approvals (§5).
 *
 * A squash whose TREE is byte-identical to a commit a maintainer actually
 * approved landed exactly the reviewed bytes — the intermediate commit ids on the
 * branch (a rebase, a force-push reconcile, an approval dismissed and re-cast)
 * are irrelevant to that fact. Byte-identical trees are the STRONGEST proof this
 * gate has; weaker than nothing it is not. Returns:
 *   true      — tree(merged) equals the tree of at least one LIVE approved head;
 *   false     — every approved head resolved and NONE matched;
 *   undefined — nothing to compare (no approvals) or a side is unresolvable.
 * `false`/`undefined` never pass on their own: the caller falls through to the
 * existing tree/content bridge, which is unchanged and still fail-closed.
 */
export function resolveApprovedTreeMatch({ client, commit, approvedHeads, treeOf: treeOfFn = treeOf }) {
  const heads = Array.isArray(approvedHeads) ? approvedHeads.filter(Boolean) : [];
  if (!commit || heads.length === 0) return undefined;
  let tm = treeOfFn(commit);
  if (!tm && client?.commitTree) tm = client.commitTree(commit);
  if (!tm) return undefined;
  let anyResolved = false;
  for (const h of heads) {
    let th = treeOfFn(h);
    if (!th && client?.commitTree) th = client.commitTree(h);
    if (!th) continue;
    anyResolved = true;
    if (th === tm) return true;
  }
  return anyResolved ? false : undefined;
}

/**
 * Authoritative PR resolution for the post-merge arm.
 *
 * The PR a merge commit came from must be resolved from data that BINDS the two:
 * a fuzzy code/issue SEARCH for the merge SHA can return any PR that merely
 * mentions or contains that commit, and the first hit is not stable — binding the
 * reviewed head, the approvals and the required contexts to a DIFFERENT PR
 * produces an internally consistent verdict against the wrong change (its
 * approvals verify, its contexts are green) and then red-flags the tree, which is
 * exactly the false red this replaces. Resolution order, each candidate accepted
 * ONLY if its merge_commit_sha equals this commit:
 *   1. the commit→PR association API (GET /commits/{sha}/pulls);
 *   2. the "(#N)" reference GitHub writes into the squash subject;
 *   3. the caller-supplied hint (--pr).
 * No candidate binds => null (the arm runs record-grammar-only and any
 * unverifiable CLAIM in the record is still a fail-closed finding).
 */
export function resolveMergedPr({ commitSha, message, declaredPr, listPullsForCommit, getPr }) {
  const want = String(commitSha || "").toLowerCase();
  // merge_commit_sha alone is NOT proof of a merge: for an OPEN pull request
  // GitHub reports the synthetic TEST-merge commit there, and that value changes
  // once the PR merges (codex-converge). So the PR must also be MERGED — `merged`
  // on the single-PR resource, `merged_at` on list/association entries.
  const isMerged = (pr) => pr?.merged === true || typeof pr?.merged_at === "string";
  const bound = (pr) => Boolean(
    pr && want !== "" &&
    typeof pr.merge_commit_sha === "string" && pr.merge_commit_sha.toLowerCase() === want &&
    isMerged(pr),
  );
  if (want && typeof listPullsForCommit === "function") {
    let pulls = null;
    try { pulls = listPullsForCommit(want); } catch { pulls = null; }
    for (const p of Array.isArray(pulls) ? pulls : []) {
      if (bound(p)) return { number: p.number, pr: p, source: "commit-association" };
    }
  }
  const candidates = [];
  const subject = String(message || "").split("\n", 1)[0];
  const m = /\(#(\d+)\)\s*$/.exec(subject);
  if (m) candidates.push({ n: Number(m[1]), source: "squash-subject" });
  if (declaredPr !== undefined && declaredPr !== null && String(declaredPr) !== "") {
    candidates.push({ n: Number(declaredPr), source: "declared" });
  }
  for (const c of candidates) {
    if (!Number.isFinite(c.n) || typeof getPr !== "function") continue;
    let pr = null;
    try { pr = getPr(c.n); } catch { pr = null; }
    if (bound(pr)) return { number: c.n, pr, source: c.source };
  }
  return { number: null, pr: null, source: "none" };
}


// ===========================================================================
// MERGE-QUEUE ARM (the `merge_group` event).
//
// GitHub's merge queue builds a CANDIDATE commit — the queued pull request's
// head merged onto the queue's base — and asks the required checks to judge THAT
// commit. The gate's other two arms cannot: the pre-merge arm is handed a pull
// request number by the event, and the post-merge arm is handed a commit that is
// already on the default branch. So the queue arm must first answer "which pull
// request is this group?" — and it must answer it from data that BINDS the two,
// never from a guess (the same failure `resolveMergedPr` exists to prevent: a
// wrong pull request produces an internally consistent verdict about a different
// change). The binding here is structural: the candidate's PARENTS are the base
// and the enqueued head, and the queue's pull-request list says which pull
// requests GitHub itself associates with the candidate. A pull request qualifies
// only when it appears in BOTH. Exactly one qualifier => resolved; none or more
// than one => the group is unresolvable/ambiguous and the arm FAILS CLOSED.
//
// The head the arm then judges is the head AT ENQUEUE — the group head's own
// parent — never the pull request's live head, which may have moved since the
// queue took the entry. That is precisely what makes "the review's commit id
// equals the pull request's head at enqueue" a checkable statement.
// ===========================================================================

/** Parent commit shas of a commit, in order (local git). Empty on any failure. */
export function parentsOf(commit, cwd = process.cwd()) {
  if (!commit) return [];
  try {
    const out = execFileSync("git", ["--literal-pathspecs", "rev-parse", "--end-of-options", `${commit}^@`], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{40}$/.test(s));
  } catch { return []; }
}

/**
 * The TREE a merge of `headSha` onto `baseSha` produces, without touching the
 * working tree (`git merge-tree --write-tree`). A conflict, an unknown object or
 * any other failure returns null — which the caller reports as UNVERIFIABLE, the
 * fail-closed direction, never as a match.
 */
export function mergedTreeOf(baseSha, headSha, cwd = process.cwd()) {
  if (!baseSha || !headSha) return null;
  try {
    const out = execFileSync("git", ["--literal-pathspecs", "merge-tree", "--write-tree", "--end-of-options", baseSha, headSha], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    });
    const first = String(out).split("\n", 1)[0].trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(first) ? first : null;
  } catch { return null; }
}

/**
 * Resolve the pull request a merge group is FOR, from the group head's parents
 * and the queue's pull-request list. Returns
 *   { status: "resolved", number, pr, headAtEnqueue, candidates }
 *   { status: "ambiguous", number: null, ..., candidates }   (> 1 qualifier)
 *   { status: "unresolved", number: null, ..., candidates: [] }
 * Ambiguity and absence are NOT resolved by preference of any kind: a queue entry
 * that does not resolve to exactly one pull request is a queue entry this gate
 * refuses to bless.
 */
export function resolveQueuedPr({ groupHeadSha = null, parents = [], queuePulls = [] } = {}) {
  const parentSet = new Set((Array.isArray(parents) ? parents : [])
    .filter((s) => typeof s === "string" && s !== "").map((s) => s.toLowerCase()));
  const candidates = [];
  for (const p of Array.isArray(queuePulls) ? queuePulls : []) {
    const number = Number(p?.number);
    const head = typeof p?.head?.sha === "string" ? p.head.sha.toLowerCase() : null;
    if (!Number.isFinite(number) || !head) continue;
    if (!parentSet.has(head)) continue;
    if (candidates.some((c) => c.number === number)) continue;
    candidates.push({ number, pr: p, headAtEnqueue: head });
  }
  if (candidates.length === 1) return { status: "resolved", ...candidates[0], groupHeadSha, candidates };
  if (candidates.length > 1) return { status: "ambiguous", number: null, pr: null, headAtEnqueue: null, groupHeadSha, candidates };
  return { status: "unresolved", number: null, pr: null, headAtEnqueue: null, groupHeadSha, candidates: [] };
}

/**
 * The approved head of a queued pull request: a LIVE, QUALIFIED approval (the
 * §5 latest-review semantics `resolveApprovedHeads` already owns — non-self,
 * non-dismissed, not superseded, peer standing at least) must sit on the head
 * the queue enqueued. An approval on an older head means the head moved after
 * the approval, and the queue candidate is not the reviewed change.
 */
export function verifyQueuedApprovedHead({ headAtEnqueue, reviews, prAuthorLogin = null, permissionByLogin = null } = {}) {
  const want = typeof headAtEnqueue === "string" && headAtEnqueue !== "" ? headAtEnqueue.toLowerCase() : null;
  if (!want) return { ok: false, approvedHeads: [], reason: `the queued pull request's head at enqueue is unknown — failing closed` };
  if (!Array.isArray(reviews)) return { ok: false, approvedHeads: [], reason: `the queued pull request's reviews could not be read — failing closed` };
  const approvedHeads = resolveApprovedHeads(reviews, { prAuthorLogin, permissionByLogin });
  if (approvedHeads.length === 0) {
    return { ok: false, approvedHeads, reason: `no live, qualified approval stands on the queued pull request (enqueued head ${want.slice(0, 8)})` };
  }
  if (!approvedHeads.some((h) => String(h).toLowerCase() === want)) {
    return {
      ok: false,
      approvedHeads,
      reason: `the standing approval sits at ${String(approvedHeads[0]).slice(0, 8)} but the enqueued head is ${want.slice(0, 8)} — the head moved after the approval`,
    };
  }
  return { ok: true, approvedHeads, reason: null };
}

/**
 * The QUEUE CANDIDATE predicate: the merge-group head's tree must equal the tree
 * of the queued pull request head merged onto the group's base. Anything the
 * local git cannot resolve (an unfetched object, a conflicted merge) is
 * `ok: undefined` — unverifiable, which the arm reports as a finding.
 */
export function resolveQueueCandidate({
  groupHeadSha, baseSha, prHeadSha,
  treeOf: treeOfFn = treeOf, mergedTreeOf: mergedTreeOfFn = mergedTreeOf,
  cwd = process.cwd(),
} = {}) {
  if (!groupHeadSha || !baseSha || !prHeadSha) {
    return { ok: undefined, groupTree: null, expectedTree: null, reason: `the merge group's head, base or enqueued head is unknown — the queue candidate cannot be verified` };
  }
  const groupTree = treeOfFn(groupHeadSha, cwd);
  if (!groupTree) return { ok: undefined, groupTree: null, expectedTree: null, reason: `the merge-group head ${String(groupHeadSha).slice(0, 8)} could not be resolved to a tree — the queue candidate cannot be verified` };
  const expectedTree = mergedTreeOfFn(baseSha, prHeadSha, cwd);
  if (!expectedTree) return { ok: undefined, groupTree, expectedTree: null, reason: `the queued head ${String(prHeadSha).slice(0, 8)} merged onto the group base ${String(baseSha).slice(0, 8)} could not be resolved to a tree — the queue candidate cannot be verified` };
  if (groupTree === expectedTree) return { ok: true, groupTree, expectedTree, reason: null };
  return {
    ok: false, groupTree, expectedTree,
    reason: `the merge-group head's tree ${groupTree.slice(0, 8)} is not the tree of the queued head merged onto the group's base (${expectedTree.slice(0, 8)}) — the candidate carries something the queued pull request does not`,
  };
}

// ===========================================================================
// §5 — content/diff binding (engineering#483 keystone). Rebinds an approval's
// staleness from tree-exact to the reviewed CHANGE's content fingerprint, so a
// mechanical update-branch / non-up-to-date merge / merge_group synthetic
// commit that replays the SAME change on a moved base no longer invalidates a
// real approval — while a materially CHANGED diff still does. Tree-identity
// (resolveTreeMatch, above) stays the strongest FAST-PATH proof; content
// binding is the fallback. FAIL CLOSED on anything unresolvable (null => STALE
// / content-unverifiable, never a silent pass). The mandatory post-merge verify
// on the REAL merged SHA remains the backstop for a semantic conflict (same
// diff, different behavior on a moved base) — content binding is intentionally
// weaker than tree binding.
//
// contentFingerprint is deliberately NOT `git patch-id`: patch-id coalesces
// whitespace (empirically a 2-space vs a tab deletion collide to one id — a
// fabrication hole for whitespace-significant files) and is blind to binary and
// filemode. Instead we hash a canonical, base-move-invariant representation:
//   T = the -U0 diff hashed VERBATIM with only the two base-move-volatile bits
//       removed (the `index <old>..<new>` line, and the `@@ -a,b +c,d @@` line
//       NUMBERS). The +/- hunk bytes (whitespace-exact, so the pre-image of the
//       removed content and the exact added content are both bound) survive; a
//       benign base move that only shifts surrounding line numbers does not.
//   S = a structural digest (status/newmode/path[/newpath]) carrying the
//       post-image blob sha ONLY for BINARY destination paths (where T is
//       blind); for TEXT files newsha is EXCLUDED so a same-file outside-hunk
//       base move on main does not churn the fingerprint. Submodule
//       (`Subproject commit <sha>`) + symlink target changes appear as text
//       hunks in T, so they carry no newsha either.
// Both sides of any comparison are computed by the SAME local git for byte-
// parity; a fork/merge_group head must be locally resolvable (ci#55 refetch)
// else the fingerprint is null => content-unverifiable (same fail-closed
// posture as today's tree-unverifiable).
// ===========================================================================

/** First parent (M^1) of a commit — the base tip a squash/merge landed on. */
export function firstParentOf(commit, cwd = process.cwd()) {
  try {
    return execFileSync("git", ["--literal-pathspecs", "rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}^1`], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}

/** merge-base (fork point) of two commits, or null if unresolvable. */
export function mergeBaseOf(a, b, cwd = process.cwd()) {
  if (!a || !b) return null;
  try {
    return execFileSync("git", ["--literal-pathspecs", "merge-base", "--end-of-options", a, b], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}

/**
 * Binary DESTINATION-path set for a diff, via `git diff --numstat -z`. A binary
 * entry is `-\t-\t<path>`; a rename/copy entry is `<a>\t<d>\t\0<old>\0<new>`, so
 * the content path is the DESTINATION (the binary sha must attach to the raw
 * destination path/status, never the old path). Returns null (FAIL CLOSED) on a
 * git error or a malformed/truncated walk — the caller then returns null so a
 * binary post-image is never silently dropped from the fingerprint.
 */
export function binaryPathsOf(base, head, cwd = process.cwd()) {
  const set = new Set();
  let out;
  try {
    out = execFileSync("git", ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--find-renames", "--numstat", "-z", "--end-of-options", base, head, "--"], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { return null; }                          // fail closed
  const toks = out.split("\0");
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i];
    if (tok === "") { i += 1; continue; }           // trailing split artifact
    const parts = tok.split("\t");                  // [added, deleted, inlinePathOrEmpty]
    if (parts.length < 3) return null;              // malformed numstat row => fail closed
    const isBinary = parts[0] === "-" && parts[1] === "-";
    const inlinePath = parts.slice(2).join("\t");
    let destPath;
    if (inlinePath === "") {                         // rename/copy form: next two toks = old, new
      if (toks[i + 2] === undefined) return null;    // truncated rename walk => fail closed
      destPath = toks[i + 2]; i += 3;                // destination path
    } else {
      destPath = inlinePath; i += 1;
    }
    if (isBinary && destPath) set.add(destPath);
  }
  return set;
}

/**
 * Canonical content fingerprint of the change base..head, or null (fail closed)
 * when base/head is unresolvable or any git error occurs.
 */
export function contentFingerprint(base, head, cwd = process.cwd()) {
  if (!base || !head) return null;
  for (const ref of [base, head]) {                 // both endpoints must resolve locally
    try {
      execFileSync("git", ["--literal-pathspecs", "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { stdio: "ignore", cwd });
    } catch { return null; }
  }
  // T — verbatim, base-move-invariant text-patch hash.
  let diffOut;
  try {
    diffOut = execFileSync("git", ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--diff-algorithm=histogram", "--find-renames", "-U0", "--end-of-options", base, head, "--"], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { return null; }
  const canonical = diffOut.split("\n").filter((l) => {
    if (l.startsWith("index ")) return false;              // oldsha..newsha — base-move volatile
    if (l.startsWith("similarity index ")) return false;   // rename heuristic, mildly base-dependent
    if (l.startsWith("dissimilarity index ")) return false;
    return true;
  }).map((l) => (l.startsWith("@@") ? l.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/, "@@") : l)).join("\n");
  const T = createHash("sha256").update(canonical).digest("hex");
  // S — structural digest; post-image newsha only for binary destination paths.
  let rawOut;
  try {
    rawOut = execFileSync("git", ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--find-renames", "--raw", "--abbrev=40", "-z", "--end-of-options", base, head, "--"], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { return null; }
  const binarySet = binaryPathsOf(base, head, cwd);
  if (binarySet === null) return null;              // numstat failed — cannot prove binary binding => fail closed
  const toks = rawOut.split("\0");
  const rows = [];
  let i = 0;
  while (i < toks.length) {
    const meta = toks[i];
    if (!meta) { i += 1; continue; }                // trailing split artifact
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(meta);
    if (!m) return null;                            // unexpected raw shape => fail closed (never under-bind S)
    const oldsha = m[3];
    const newmode = m[2];
    const newsha = m[4];
    const statusLetter = m[5];
    let path, newpath = null, destPath;
    if (statusLetter === "R" || statusLetter === "C") {
      path = toks[i + 1]; newpath = toks[i + 2]; destPath = newpath; i += 3;
    } else {
      path = toks[i + 1]; destPath = path; i += 2;
    }
    if (path === undefined || destPath === undefined) return null;   // truncated raw walk => fail closed
    let row = `${statusLetter}\t${newmode}\t${path}`;
    if (newpath !== null) row += `\t${newpath}`;
    // Bind a blob sha only where T is blind (binary). Post-image (newsha) for
    // add/modify/rename; for a binary DELETION newsha is all-zeros, so bind the
    // pre-image (oldsha) — else two different deleted binary blobs at one path
    // would collide (a fabrication hole T cannot see).
    if (binarySet.has(destPath)) row += `\t${statusLetter === "D" ? oldsha : newsha}`;
    rows.push(row);
  }
  rows.sort();
  const S = createHash("sha256").update(rows.join("\n")).digest("hex");
  if (!canonical && rows.length === 0) return "empty";     // degenerate no-op change
  return createHash("sha256").update(`patch:${T}\nstruct:${S}`).digest("hex");
}

/**
 * Post-merge content bridge (analog of resolveTreeMatch): does the LANDED squash
 * commit M carry the SAME change as the reviewed head H? baseM = firstParent(M);
 * baseH = merge-base(baseM, H). true | false | undefined (undefined => a side is
 * unresolvable => fail closed in analyzePostMerge). Helpers injectable for tests.
 *
 * §7 (ci#94): `rangeBase` overrides baseM with the commit a MULTI-COMMIT REBASE
 * landing was replayed onto, so the comparison is the PR's full reviewed change
 * against the FULL landed range rather than one landed commit's own diff (which
 * can never equal a multi-commit reviewed change — a mismatch by construction).
 * Absent it, this is byte-for-byte the squash/single-commit bridge it has always
 * been.
 */
export function resolveContentMatch({ commit, reviewedHeadSha, rangeBase = null, cwd = process.cwd(),
  fingerprint = contentFingerprint, firstParent = firstParentOf, mergeBase = mergeBaseOf } = {}) {
  if (!commit || !reviewedHeadSha) return undefined;
  const baseM = rangeBase || firstParent(commit, cwd);
  if (!baseM) return undefined;
  const fpM = fingerprint(baseM, commit, cwd);
  const baseH = mergeBase(baseM, reviewedHeadSha, cwd);
  const fpH = baseH ? fingerprint(baseH, reviewedHeadSha, cwd) : null;
  return (fpM && fpH) ? (fpM === fpH) : undefined;
}

/**
 * Staleness resolver factory for verifyReviewedLine. Given an on-main `anchor`
 * (pre-merge: the diff base; post-merge: firstParent(M)), returns
 * (approvedSha, reviewedSha) => true | false | undefined: does the commit an
 * approval was cast on carry the SAME change as the current reviewed head? Each
 * side re-based to its own merge-base(anchor, sha), so an update-branch /
 * mechanical rebase re-derives EQUAL. undefined (either side unresolvable) =>
 * STALE (fail closed) at the call site. Returns null when no anchor is
 * available, so the caller falls back to exact-SHA staleness (back-compat).
 */
export function makeContentBinds({ anchor, cwd = process.cwd(),
  fingerprint = contentFingerprint, mergeBase = mergeBaseOf } = {}) {
  if (!anchor) return null;
  return (approvedSha, reviewedSha) => {
    if (!approvedSha || !reviewedSha) return undefined;
    if (approvedSha === reviewedSha) return true;
    const baseA = mergeBase(anchor, approvedSha, cwd);
    const fpA = baseA ? fingerprint(baseA, approvedSha, cwd) : null;
    const baseR = mergeBase(anchor, reviewedSha, cwd);
    const fpR = baseR ? fingerprint(baseR, reviewedSha, cwd) : null;
    return (fpA && fpR) ? (fpA === fpR) : undefined;
  };
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
  // (cinatra-agent-bot[bot], App 4040322; spec §5/§8.5). Its
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
  // The LOOP's own bot login (engineering#680). `groganz-bot[bot]` is the
  // identity that authors and opens every lane pull request; it carries none of
  // the vendor tokens above, so without this the gate's check 5 never fires for
  // the loop's own commits and the fence lives in the wrong place. The login is
  // PUBLIC (visible on every pull request it opens), the same category as the
  // "cinatra-agent" token above, so it belongs in this public default rather
  // than in private internalAgentTokens. looksLikeAgent tests name AND email
  // against the same tokens, so the API committer form
  // (293224031+groganz-bot[bot]@users.noreply.github.com) matches through this
  // one token too.
  "groganz-bot",
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
// §5c — The CONTENT-FREE CLEAN MERGE (engineering#680)
//
// With the loop's bot login a known agent (§5 above), every bring-up-to-date
// merge the bot makes through the API ("Merge branch 'main' into …": two
// parents, no conflict of its own, no record and never one) would read as agent
// work and turn every forwarded branch red. Such a merge CONTRIBUTED NOTHING:
// its tree is exactly the tree merging its two parents produces, so nobody
// wrote a line in it. Check 5 (pre-merge on the range, post-merge on the landed
// commit) therefore reads a two-parent commit whose tree equals `git merge-tree`
// of its parents as CONTENT-FREE: no identity reading, no record demanded, and
// nothing contributed to a squash record's union.
//
// The boundary is the tree, not the message: a merge whose tree DIFFERS from the
// clean merge resolved a conflict or carries an edit made in the merge — a hand
// chose those bytes — and keeps today's rule untouched. Fail closed in every
// other direction too: a commit that is not a two-parent merge, an unreadable
// parent list, an unreadable tree and an unreadable merge-tree (a conflict makes
// `git merge-tree` fail) are NOT content-free, so the unchanged rule applies.
// The reading goes through the same git road the gate already reads commits with
// (parentsOf / treeOf / mergedTreeOf).
// ===========================================================================

/**
 * The merge facts of ONE commit: its parents, its own tree, and the tree a
 * clean merge of its two parents produces. `parents` / `tree` may be supplied by
 * a caller that already read them (the post-merge arm reads both from the PR
 * commits payload); anything else is read from local git. Returns null for a
 * commit that is not a two-parent merge; an unreadable tree or merge-tree stays
 * null INSIDE the record, which isContentFreeMerge fails closed on.
 */
export function mergeInfoOf(commit, { cwd = process.cwd(), parents = null, tree = null } = {}) {
  const given = Array.isArray(parents) && parents.length ? parents : null;
  const ps = (given || parentsOf(commit, cwd)).map((x) => asFullSha(x && x.sha ? x.sha : x)).filter(Boolean);
  if (ps.length !== 2) return null;
  return {
    parents: ps,
    tree: asFullSha(tree) || treeOf(commit, cwd),
    cleanTree: mergedTreeOf(ps[0], ps[1], cwd),
  };
}

/**
 * Is this commit a CONTENT-FREE clean merge — a two-parent commit whose tree is
 * exactly what merging its two parents produces? Anything the gate could not
 * read in full (no record, not two parents, an unreadable tree or merge-tree)
 * is NOT content-free: today's rule applies.
 */
export function isContentFreeMerge(info) {
  if (!info || !Array.isArray(info.parents) || info.parents.length !== 2) return false;
  const tree = asFullSha(info.tree);
  const clean = asFullSha(info.cleanTree);
  if (!tree || !clean) return false;                                  // unreadable => fail closed
  return tree === clean;
}

/** Is this commit object present in THIS checkout (the merge-tree read needs it)? */
export function hasCommitLocally(sha, cwd = process.cwd()) {
  if (!/^[0-9a-f]{7,40}$/.test(String(sha || "").toLowerCase())) return false;
  try {
    const out = execFileSync("git", ["--literal-pathspecs", "rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`], {
      encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(out);
  } catch { return false; }
}

/**
 * Fetch a pull request's OWN head ref (`refs/pull/N/head`) into this checkout.
 *
 * The post-merge arm runs on the default branch after the landing, where a
 * SQUASHED pull request's source commits are unreachable — and the branch is
 * usually deleted with the merge, so no `refs/heads/*` fetch brings them back.
 * Without those objects `git merge-tree` cannot be run for a bring-up-to-date
 * merge in the range and the §5c reading is simply never available, which would
 * leave every forward landing demanding a record for a merge nobody wrote a line
 * in. GitHub keeps `refs/pull/N/head` after the merge, and it carries the merge
 * AND both of its parents. A failure returns false and changes nothing: the
 * reading stays unreadable, which is NOT content-free (fail closed).
 */
export function fetchPrHeadRef(prNumber, { cwd = process.cwd(), remote = "origin" } = {}) {
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    execFileSync("git", ["--literal-pathspecs", "fetch", "--no-tags", "--quiet", remote, `+refs/pull/${n}/head:refs/remotes/pr/${n}/head`], {
      cwd, stdio: ["ignore", "ignore", "ignore"], timeout: 120000,
    });
    return true;
  } catch { return false; }
}

/** Is THIS range/landed commit a content-free clean merge, per ctx's readings? */
function ctxCommitIsCleanMerge(ctx, identity) {
  if (!ctx || !identity) return false;
  return isContentFreeMerge((ctx.mergeInfoBySha || {})[identity.sha]);
}

// ===========================================================================
// §5b — The TOOL-MADE DEPENDENCY BUMP class (engineering#679)
//
// The ONE narrow exemption from check 5. The class is DATA — the identities,
// the file globs and the line patterns live in config/tool-made-bump-class.json
// (so the merge road's preflight can read the SAME definition at the engine's
// ref); this is the one rule that reads it. A commit is a bump when:
//   - its author AND its committer are class identities (the API committer
//     `GitHub <noreply@github.com>` counts as the author's identity), and
//   - its diff touches ONLY class files, and
//   - outside a lockfile (whose whole diff is accepted as-is) every added and
//     removed line matches a class line pattern AND pairs with the line it
//     replaced once the captured version/digest token is blanked.
// Fail closed everywhere: an unparseable config, an unreadable diff, a rename,
// a binary file, a deleted file or an unrecognized line => NOT a bump, and
// today's rule applies untouched.
// ===========================================================================

/** Does a path match any of these minimatch-style globs (§3 dialect)? */
function matchesAnyGlob(p, globs) {
  return (globs || []).some((g) => globToRegExp(String(g)).test(p));
}

/** Unwrap a loadJsonSafe envelope ({ok,value}); a plain object is taken as-is. */
function bumpClassValue(cls) {
  if (!cls || typeof cls !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(cls, "ok")) return cls.ok ? (cls.value || null) : null;
  return cls;
}

/** Case-insensitive identity match; a pattern containing `*` is a glob. */
function identityPatternMatches(pattern, value) {
  const pat = String(pattern || "").toLowerCase();
  const val = String(value || "").toLowerCase();
  if (!pat || !val) return false;
  if (pat.includes("*")) return globToRegExp(pat).test(val);
  return pat === val;
}

/**
 * Are BOTH the author and the committer of this commit class identities? The
 * committer `GitHub <noreply@github.com>` (how an API-made commit looks) counts
 * as the same identity when the AUTHOR is one of them.
 */
export function identityInBumpClass(identity, bumpClass) {
  const cls = bumpClassValue(bumpClass);
  if (!cls || !Array.isArray(cls.identities) || !identity) return false;
  const anyPattern = (...values) => values.some((v) => cls.identities.some((pat) => identityPatternMatches(pat, v)));
  if (!anyPattern(identity.authorName, identity.authorEmail, identity.ghAuthorLogin)) return false;
  const api = cls.apiCommitter || null;
  const committerIsApi = Boolean(api)
    && identityPatternMatches(api.name, identity.committerName)
    && identityPatternMatches(api.email, identity.committerEmail);
  return committerIsApi || anyPattern(identity.committerName, identity.committerEmail, identity.ghCommitterLogin);
}

/**
 * Compile the class's line patterns ONCE, atomically: every pattern must compile
 * AND carry exactly one capture group (the version/digest token). A single
 * unusable pattern disables the WHOLE class (null) — a class definition the gate
 * cannot read in full never exempts anything.
 */
export function compileBumpPatterns(linePatterns) {
  if (!Array.isArray(linePatterns) || linePatterns.length === 0) return null;
  const out = [];
  for (const src of linePatterns) {
    let re;
    try { re = new RegExp(String(src), "d"); } catch { return null; }  // unusable pattern => fail closed
    let groups;
    try { groups = new RegExp(`${re.source}|`).exec("").length - 1; } catch { return null; }
    // At least ONE capture: the token must be identifiable. A pattern may carry
    // MORE than one (engineering#680) when a single line pins the same version
    // or digest twice — the app's upgrade matrix writes the pinned image
    // reference and the `digest` field beside it on one line — and every capture
    // is blanked separately, so the text BETWEEN them (a `major` policy field)
    // still has to match for two lines to pair.
    if (groups < 1) return null;
    out.push(re);
  }
  return out;
}

/**
 * The line with its version/digest token blanked, or null when the line matches
 * no class pattern. Two lines that normalize EQUAL differ only in that token —
 * which is exactly what a bump is allowed to change. The token is located by the
 * capture's own INDICES (never by searching its text, which would blank an
 * earlier identical run of characters in the dependency name instead).
 */
export function normalizeBumpLine(line, linePatterns) {
  const res = Array.isArray(linePatterns) && linePatterns.length && linePatterns.every((r) => r instanceof RegExp)
    ? linePatterns
    : compileBumpPatterns(linePatterns);
  if (!res) return null;
  for (const re of res) {
    const m = re.exec(line);
    if (!m || m[1] === undefined) continue;
    // EVERY participating capture is blanked, each at its own indices (a pattern
    // may pin the same token twice on one line — engineering#680). Everything
    // between two captures is left standing, so a line that changes there does
    // not pair with the line it replaced.
    const spans = [];
    let readable = true;
    for (let g = 1; g < m.length; g++) {
      if (m[g] === undefined) continue;
      const at = m.indices && m.indices[g];
      if (!at) { readable = false; break; }
      spans.push(at);
    }
    if (!readable || spans.length === 0) continue;
    spans.sort((a, b) => a[0] - b[0]);
    let sane = true;
    for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) { sane = false; break; }
    if (!sane) continue;                                               // overlapping captures prove nothing
    let out = line;
    for (let i = spans.length - 1; i >= 0; i--) out = out.slice(0, spans[i][0]) + "\u0000VERSION\u0000" + out.slice(spans[i][1]);
    return out;
  }
  return null;
}

/** The hunks of ONE file entry, or null when the diff evidence is missing. */
function hunksOfEntry(file) {
  return file && Array.isArray(file.hunks) ? file.hunks : null;
}

/**
 * Is this commit a tool-made dependency bump?
 *
 * @param identity     { authorName, authorEmail, committerName, committerEmail, ... }
 * @param changedFiles the commit's changed-path list (the authoritative set)
 * @param fileLines    [{ path, hunks: [{ added:[line], removed:[line] }] }] — the
 *                     hunk line CONTENT without the leading +/-, GROUPED BY HUNK
 *                     (a version bump replaces a line where it stands; a line
 *                     moved from one hunk to another is a section change, not a
 *                     bump). Every changed path must appear here with at least
 *                     one hunk: missing evidence (a mode change, a truncated or
 *                     patch-less payload) => NOT a bump.
 */
export function isToolMadeBump({ identity, changedFiles, fileLines }, bumpClass) {
  const cls = bumpClassValue(bumpClass);
  if (!cls || !Array.isArray(cls.fileGlobs) || !Array.isArray(cls.linePatterns)) return false;
  const patterns = compileBumpPatterns(cls.linePatterns);
  if (!patterns) return false;                                        // unusable class definition => fail closed
  if (!identityInBumpClass(identity, cls)) return false;
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  if (!Array.isArray(fileLines) || fileLines.length === 0) return false;   // unreadable diff => fail closed
  const excluded = cls.excludeGlobs || [];
  const inClassFile = (p) => !matchesAnyGlob(p, excluded) && matchesAnyGlob(p, cls.fileGlobs);
  const wanted = new Set((changedFiles || []).map((f) => String(f)));
  for (const f of wanted) if (!inClassFile(f)) return false;
  const covered = new Set();
  for (const file of fileLines) {
    const p = String((file && file.path) || "");
    if (!p || covered.has(p) || !wanted.has(p)) return false;         // an unexpected or repeated path => fail closed
    covered.add(p);
    if (!inClassFile(p)) return false;
    const hunks = hunksOfEntry(file);
    if (!Array.isArray(hunks) || hunks.length === 0) return false;    // no readable evidence => fail closed
    if (matchesAnyGlob(p, cls.lockfileGlobs || [])) continue;         // the tool's own lockfile write
    const norm = (lines) => {
      if (!Array.isArray(lines)) return null;
      const out = [];
      for (const l of lines) {
        const n = normalizeBumpLine(l, patterns);
        if (n === null) return null;                                  // a script / stage / command / setting line
        out.push(n);
      }
      return out.sort();
    };
    for (const h of hunks) {
      const added = norm(h && h.added);
      const removed = norm(h && h.removed);
      if (added === null || removed === null) return false;
      if (added.length === 0 && removed.length === 0) return false;   // an empty hunk proves nothing
      if (added.length !== removed.length) return false;              // an ADDED or REMOVED dependency name
      for (let i = 0; i < added.length; i++) if (added[i] !== removed[i]) return false;
    }
  }
  if (covered.size !== wanted.size) return false;                     // a changed path the diff did not cover
  return true;
}

/** Is THIS range/landed commit a bump, given the diffs collected into ctx? */
function ctxCommitIsBump(ctx, identity) {
  if (!ctx || !ctx.bumpClass || !identity) return false;
  const d = (ctx.commitDiffBySha || {})[identity.sha];
  if (!d) return false;
  // A commit whose OWN message NAMES an agent is never exempt. The exemption
  // exists so a record need not invent an agent that never existed — never to
  // erase one the commit itself declares (that would make the record untrue in
  // the other direction).
  const msg = (ctx.messageBySha && ctx.messageBySha[identity.sha]) || identity.message || "";
  if (msg && parseTrailers(msg).assisted.some((a) => !a.isNone)) return false;
  return isToolMadeBump({ identity, changedFiles: d.changedFiles, fileLines: d.fileLines }, ctx.bumpClass);
}

/**
 * Added/removed line content of a unified diff body, GROUPED BY HUNK (no file
 * header). null when the text carries no hunk header at all — text that is not a
 * diff proves nothing and must not read as an empty, and therefore clean, change.
 */
function hunkLinesOf(patch) {
  const hunks = [];
  let cur = null;
  for (const raw of String(patch).split("\n")) {
    if (raw.startsWith("@@")) { cur = { added: [], removed: [] }; hunks.push(cur); continue; }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) { if (!cur) return null; cur.added.push(raw.slice(1)); continue; }
    if (raw.startsWith("-")) { if (!cur) return null; cur.removed.push(raw.slice(1)); continue; }
  }
  return hunks.length ? hunks : null;
}

/**
 * Parse a unified diff into [{path, hunks:[{added,removed}]}] — or null (FAIL
 * CLOSED) on a rename/copy, a binary file, a MODE change, a deleted file, an
 * ADDED file or an unexpected header shape. Only a modification of an existing
 * class file, read line by line, can establish a bump.
 */
export function parseUnifiedDiffLines(diffText) {
  const files = [];
  let cur = null;
  let hunk = null;
  for (const raw of String(diffText == null ? "" : diffText).split("\n")) {
    if (raw.startsWith("diff --git ")) { cur = null; hunk = null; continue; }
    if (raw.startsWith("rename from ") || raw.startsWith("rename to ")) return null;
    if (raw.startsWith("copy from ") || raw.startsWith("copy to ")) return null;
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) return null;
    if (raw.startsWith("old mode ") || raw.startsWith("new mode ")) return null;   // a mode change is not a bump
    if (raw.startsWith("--- ")) {
      if (raw.slice(4) === "/dev/null") return null;                  // an ADDED file is not a bump
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4);
      if (p === "/dev/null") return null;                             // a deleted file is not a bump
      if (!p.startsWith("b/")) return null;                           // unexpected header => fail closed
      cur = { path: p.slice(2), hunks: [] };
      hunk = null;
      files.push(cur);
      continue;
    }
    if (raw.startsWith("@@")) {
      if (!cur) return null;
      hunk = { added: [], removed: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (raw.startsWith("+")) { if (!hunk) return null; hunk.added.push(raw.slice(1)); continue; }
    if (raw.startsWith("-")) { if (!hunk) return null; hunk.removed.push(raw.slice(1)); continue; }
  }
  return files;
}

/**
 * ONE commit's own hunk lines (`<sha>^!`), read by the SAME git road the range's
 * commits are read by (and the same -U0 no-textconv diff the content
 * fingerprint uses). null on any git error => not a bump.
 */
export function commitDiffLines(commit, cwd = process.cwd()) {
  // A MERGE (or a root) commit is never a bump: `<sha>^!` against several parents
  // is not one commit's own change. Prove exactly one parent first.
  try {
    const parents = execFileSync(
      "git",
      ["rev-list", "--parents", "-n", "1", "--end-of-options", commit],
      { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] },
    ).trim().split(/\s+/).filter(Boolean);
    if (parents.length !== 2) return null;
  } catch { return null; }
  let out;
  try {
    out = execFileSync(
      "git",
      ["--literal-pathspecs", "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0", "--end-of-options", `${commit}^!`, "--"],
      { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch { return null; }
  return parseUnifiedDiffLines(out);
}

/**
 * The same reading from the REST commit-files payload — the road the post-merge
 * arm reads a SQUASHED PR's source-commit identities by (those commits are not
 * in the default-branch checkout). FAIL CLOSED on everything that is not a plain
 * modification with a readable patch: a rename/copy/removal/addition, an unknown
 * status, a `patch` GitHub omitted (too large or binary — a lockfile included:
 * "the whole diff is accepted" means the whole diff was READ), or a file list at
 * the API's 300-entry cap, which may be truncated and so cannot be shown to
 * contain only class files. null => not a bump.
 */
export const API_COMMIT_FILES_CAP = 300;
export function bumpLinesFromApiFiles(files) {
  if (!Array.isArray(files)) return null;
  if (files.length >= API_COMMIT_FILES_CAP) return null;              // possibly truncated => fail closed
  const out = [];
  for (const f of files) {
    const p = f && f.filename;
    if (typeof p !== "string" || !p) return null;
    if (f.previous_filename) return null;
    if (f.status !== "modified" && f.status !== "changed") return null;
    if (typeof f.patch !== "string") return null;                     // no readable evidence => fail closed
    const hunks = hunkLinesOf(f.patch);
    if (!hunks) return null;
    out.push({ path: p, hunks });
  }
  return out;
}

// ===========================================================================
// GitHub API client (injectable; default uses `gh api`). Anti-fabrication
// (§5 checks 2 & 3) needs: PR reviews, the actor's repo permission, and the
// check-runs for a head SHA. All network access funnels through this object so
// the analysis core is unit-testable offline with a stub.
// ===========================================================================

/**
 * Combine a `gh api --paginate --slurp` payload into the flat shape callers
 * expect. `--slurp` guarantees ONE valid JSON document: a top-level array whose
 * elements are the per-page response bodies. So there is never more than one
 * JSON value to parse — the exact failure the pre-slurp code hit, which split
 * gh's separator-less concatenation of page bodies on a newline and JSON.parsed
 * each fragment (breaking the instant a response spanned >1 page). PURE +
 * exported so the combine is unit-testable offline with synthetic slurp docs.
 *   - shape:"array" -> each page is itself an array; return their concatenation.
 *                      `.flat()` combines pages one level only; page ELEMENTS
 *                      (review/commit objects) are never arrays, so a real
 *                      element is never wrongly flattened.
 *   - arrayField    -> each page is an object; return the concatenation of every
 *                      page's `arrayField` array.
 *
 * FAIL CLOSED (codex-converge): a page whose shape is not the expected
 * array (array endpoints) / object-carrying-an-array-field (object endpoints) is
 * a MALFORMED / error-shaped response, NOT "no items" — it THROWS, so the
 * caller's anti-fabrication block treats it as an unreadable API response (fail
 * closed for high-risk) exactly as a JSON.parse error would, never as an empty
 * (risk-free) result. Silently skipping such a page would fail OPEN — turning
 * "could not understand the API response" into "no risky items found."
 */
export function combinePaginatedSlurp(out, { shape = "object", arrayField = null } = {}) {
  const parsed = JSON.parse(out);
  // --slurp yields a top-level array of per-page bodies; defensively treat a
  // non-array (a hypothetical single unwrapped page) as one page.
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  if (shape === "array") {
    for (let i = 0; i < pages.length; i++) {
      if (!Array.isArray(pages[i])) {
        throw new Error(`paginated array endpoint: page ${i} is not an array (malformed response) — failing closed`);
      }
    }
    return pages.flat();
  }
  if (arrayField) {
    const merged = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (!p || typeof p !== "object" || Array.isArray(p)) {
        throw new Error(`paginated object endpoint: page ${i} is not an object (malformed response) — failing closed`);
      }
      const field = p[arrayField];
      if (!Array.isArray(field)) {
        throw new Error(`paginated object endpoint: page ${i} missing array field "${arrayField}" (malformed response) — failing closed`);
      }
      for (const x of field) merged.push(x);
    }
    return merged;
  }
  return pages;
}

export function makeGhClient({ repo } = {}) {
  // shape: "array"  -> endpoint returns a JSON array (e.g. /reviews); with
  //                    --paginate, gh concatenates one array per page.
  //        "object" -> endpoint returns a JSON object whose payload lives under
  //                    a named field (e.g. /check-runs -> { check_runs: [...] });
  //                    with --paginate, gh concatenates one object per page and
  //                    we must merge that field across pages.
  function ghApi(endpoint, { shape = "object", arrayField = null } = {}) {
    const paginated = shape === "array" || Boolean(arrayField);
    // The merged-PR binding below needs merge_commit_sha, removed in API2026.
    // Explicitly retain the supported response contract previously supplied by default.
    const args = ["api", "-H", "X-GitHub-Api-Version: 2022-11-28"];
    // `--paginate --slurp`: gh follows every Link `next` and emits ONE valid JSON
    // document — a top-level array whose elements are the per-page response
    // bodies (an array of the page-arrays for array endpoints; an array of the
    // page-objects for object endpoints). This REPLACES string-splitting gh's raw
    // concatenated page bodies on a newline-before-bracket: gh inserts NO
    // separator between pages, so `[...][...]` / `{...}{...}` collapsed into a
    // single un-parseable blob once a response exceeded one page (~>100 items),
    // and JSON.parse threw "Unexpected non-whitespace character after JSON at
    // position N" — which caught in the anti-fabrication try/catch as "GitHub API
    // unavailable" and failed the high-risk approval check CLOSED on exactly the
    // heavily-reviewed / many-check-run PRs the gate most needs to verify. With
    // `--slurp`, JSON.parse never sees more than one top-level value; combining is
    // a pure, offline-unit-tested transform (combinePaginatedSlurp).
    if (paginated) args.push("--paginate", "--slurp");
    args.push("-H", "Accept: application/vnd.github+json", endpoint);
    const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (paginated) return combinePaginatedSlurp(out, { shape, arrayField });
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
    // §5b: ONE commit's file list + patches — the same REST road prCommits reads
    // the range's identities by, so the bump reading sits beside the identity
    // reading rather than opening a second one. null on ANY miss => fail closed
    // (the commit is simply not classified as a bump).
    commitFiles(sha) {
      try {
        const c = ghApi(`/repos/${repo}/commits/${sha}`);
        if (!c || !Array.isArray(c.files)) return null;
        if (!Array.isArray(c.parents) || c.parents.length !== 1) return null;  // a merge commit is not a bump
        return c.files;
      } catch { return null; }
    },
    // Tree object sha of a commit via the API. The BASE repo can resolve a FORK
    // head commit's tree (the local checkout cannot — fork heads aren't fetched),
    // closing the post-merge fork-PR false negative. Bound to THIS gate's
    // `repo`, so a foreign sha 404s -> null -> fail-closed. ghApi throws on 404/403,
    // so wrap in try/catch and return null on ANY miss (codex note).
    commitTree(sha) {
      try { return ghApi(`/repos/${repo}/commits/${sha}`)?.commit?.tree?.sha ?? null; }
      catch { return null; }
    },
    // GET /repos/{repo}/commits/{sha}/pulls — the PRs GitHub itself associates
    // with a commit. This is the AUTHORITATIVE binding the post-merge arm needs
    // (a merge-SHA text search can return any PR that merely mentions or contains
    // the commit); the caller still requires merge_commit_sha === the commit, so
    // an association that is merely "this commit is in that PR's branch" cannot
    // bind. Paginated; bound to THIS gate's repo.
    pullsForCommit(sha) { return ghApi(`/repos/${repo}/commits/${sha}/pulls`, { shape: "array" }); },
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
export function verifyReviewedLine(line, { reviews, permission, prAuthorLogin, reviewedHeadSha, contentBinds }) {
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
    // §5 content binding (engineering#483): a differing approval SHA is no longer
    // automatically stale. If the approved commit re-derives the SAME reviewed
    // CHANGE as the current head (a mechanical update-branch / rebase / non-up-to-
    // date merge), the approval still binds (bind === true). A materially changed
    // diff (false) or an unresolvable one (undefined) stays STALE — fail closed.
    // With NO resolver injected we keep the exact-SHA behavior (differs => STALE),
    // so offline callers and existing tests are unchanged.
    const bind = typeof contentBinds === "function" ? contentBinds(latest.commit_id, reviewedHeadSha) : false;
    if (bind !== true) {
      reasons.push(`@${login}'s approval is STALE (approved ${String(latest.commit_id).slice(0, 8)}, head is ${String(reviewedHeadSha).slice(0, 8)}${bind === undefined ? " — content unverifiable" : ""} — re-approval required)`);
    }
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
 * @param selfRunId          the Actions run id of THIS gate run (GITHUB_RUN_ID).
 *                           A required context whose ONLY check-run is produced by
 *                           this very run is SELF-REFERENTIAL — see below.
 * @param waitedMs           how long the caller already re-polled for an unconcluded
 *                           context (null = no wait window). Only shapes the message.
 *
 * Returns { ok, reasons, warnings, pending, pendingOnly }. `warnings` carries the
 * §4 35-day staleness NOTICE — a gate-arm merge with a 35–65-day-old audit is
 * still verifiable (ok), but the audit is going stale and the engineer is being
 * told. `reasons` carries hard gate-arm failures (incl. the §4 65-day lapse and a
 * missing audit record). Staleness applies to the GATE ARM ONLY: a lapsed audit
 * stops machine verification, never a human-arm merge (the human arm doesn't
 * call this).
 *
 * `pending` lists the required contexts that have NOT CONCLUDED yet (a check-run
 * or its Actions run still queued/in_progress). Those are TRANSIENT — a sibling
 * gate that goes green two seconds later must not red-flag the record — so the
 * caller (makeSettlingGateArmVerifier) re-polls them within a bounded window and
 * only the final verdict is reported. `pendingOnly` is true when EVERY reason is
 * an unconcluded-context reason, i.e. waiting can still change the verdict; a
 * concluded non-success, a suite mismatch or a stale audit never becomes green by
 * waiting, so those short-circuit the wait.
 */
export const AUDIT_STALE_WARN_DAYS = 35;
export const AUDIT_STALE_FAIL_DAYS = 65;
const DAY_MS = 24 * 60 * 60 * 1000;

// Message halves that MUST stay distinguishable (the operator has to be able to
// tell "this context reported a failure" from "this context never finished"):
//   - CONCLUDED_NON_SUCCESS: the context RAN and reported a non-success result.
//   - NEVER_CONCLUDED:       the context never reported at all inside the window.
export const CONCLUDED_NON_SUCCESS_PHRASE = "did not conclude success";
export const NEVER_CONCLUDED_PHRASE = "never concluded";

/** Human-readable tail describing how long we waited for a conclusion. */
function waitedPhrase(waitedMs) {
  if (waitedMs === null || waitedMs === undefined) return "no re-poll window was available in this run";
  if (waitedMs <= 0) return "the re-poll window was exhausted before it could re-poll";
  return `it was still unconcluded after re-polling for ${Math.round(waitedMs / 1000)}s`;
}

export function verifyGateArm(parsed, { suiteFile, checkRuns, now = Date.now(), reviewedHeadSha = null, runWorkflow = null, selfRunId = null, waitedMs = null }) {
  const reasons = [];
  const warnings = [];
  // Contexts that have not concluded yet (transient — the caller may re-poll).
  const pending = [];
  const pendingReasons = new Set();
  // Non-failure observations the operator should still see in the run log (today:
  // the self-reference exclusion). Kept OUT of `warnings`, which is the §4 audit-
  // staleness channel, so the two are never reported under one finding code.
  const notes = [];
  const finish = () => ({
    ok: reasons.length === 0,
    reasons,
    warnings,
    notes,
    pending,
    // Waiting can only help when EVERY reason is an unconcluded-context reason.
    pendingOnly: pending.length > 0 && reasons.every((r) => pendingReasons.has(r)),
  });
  if (!suiteFile || !suiteFile.ok) {
    reasons.push(`cannot read .github/gate-suite.json at the merged SHA (${suiteFile?.reason || "missing"}) — gate arm cannot be verified`);
    return finish();
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
    return finish();
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
    return finish();
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
  // Record an unconcluded (queued/in_progress) context: the reason is pushed like
  // any other failure — the verdict is still fail-closed on this pass — but it is
  // ALSO registered as pending so the settling caller knows re-polling may change
  // it, and so `pendingOnly` can distinguish "waiting can help" from "waiting is
  // pointless" (a concluded failure / a suite mismatch never becomes green).
  function pushPending(ctx, reason, status) {
    reasons.push(reason);
    pendingReasons.add(reason);
    pending.push({ context: ctx.context, status });
  }
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
  // Does a resolved Actions run reference EXACTLY ctx.workflow@ctx.pinned? The
  // referenced_workflows entry path is "<workflow-path>@<ref>"; we split on the
  // FINAL "@" and compare the workflow PATH portion EXACTLY (case-SENSITIVE —
  // GitHub paths are case-sensitive, so a same-pinned-commit file at a different
  // case must NOT satisfy) and the ref/sha case-INSENSITIVELY (git hex). The
  // matched ref must be a full 40-hex equal to ctx.pinned — @branch/@tag/@short-sha
  // are rejected. Shared by the candidate verification and the self-run identity
  // proof so the two can never drift apart.
  function referencesPinnedWorkflow(wr, ctx) {
    if (!wr || !Array.isArray(wr.referencedWorkflows)) return false;
    if (!ctx.pinned || !PINNED_RE.test(String(ctx.pinned))) return false;
    const pinnedLower = String(ctx.pinned).toLowerCase();
    return wr.referencedWorkflows.some((e) => {
      if (!e || typeof e.path !== "string") return false;
      const at = e.path.lastIndexOf("@");
      if (at <= 0) return false;
      const ePath = e.path.slice(0, at);
      const eRef = e.path.slice(at + 1);
      if (ePath !== ctx.workflow) return false;                       // path EXACT, case-sensitive
      if (eRef.toLowerCase() !== pinnedLower) return false;           // ref == pinned (case-insensitive hex)
      return typeof e.sha === "string" && e.sha.toLowerCase() === pinnedLower; // and the resolved sha agrees
    });
  }
  // The OUTCOME-INDEPENDENT caller constraints a required context may declare.
  // Shared by verifyWorkflowIdentity AND the self-run identity proof: the self
  // exclusion skips a context's OUTCOME, never its IDENTITY, so every predicate
  // that says "this is the run the suite meant" must hold there too. Skipping
  // these in the self proof would let an already-existing alternate caller or
  // trigger event satisfy a context the suite pinned to one caller/event without
  // touching .github/** (codex-converge round 2 HIGH).
  //   - callerPath: the caller workflow file the run executed (run.path). GitHub
  //     returns a BARE path or a "<path>@<ref>" form; we compare the PATH portion
  //     case-sensitively and ignore a trailing @ref (the CALLEE pin already binds
  //     the executed reusable-workflow commit).
  //   - allowedEvents: the trigger events the caller may have run under (run.event).
  // A context that OMITS a key (undefined) is unchanged (backward compatible).
  // A key that is PRESENT-but-MALFORMED FAILS CLOSED, never silently behaving
  // like "undeclared" (e.g. `allowedEvents: "pull_request"` as a string, or
  // `callerPath: []`, would otherwise disable the check it was meant to add).
  function verifyCallerConstraints(wr, ctx, runId) {
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
    const matched = referencesPinnedWorkflow(wr, ctx);
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
    const caller = verifyCallerConstraints(wr, ctx, runId);
    if (!caller.ok) return caller;
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
      // EVAL-TIMING: a check-run that has not CONCLUDED is not a failure — it is
      // an answer we do not have yet. Record it as pending (the caller re-polls
      // within a bounded window) and phrase it so the operator can never confuse
      // "it never finished" with "it finished and reported a failure".
      if (r.status !== "completed") {
        pushPending(ctx, `required context '${ctx.context}' ${NEVER_CONCLUDED_PHRASE} (check-run status=${r.status || "unknown"}, conclusion=${r.conclusion || "n/a"}) — ${waitedPhrase(waitedMs)}; an unconcluded context cannot bless a merge (fail closed)`, r.status || "unknown");
        return true;
      }
      if (r.conclusion !== "success") {
        reasons.push(`required context '${ctx.context}' ${CONCLUDED_NON_SUCCESS_PHRASE} (status=${r.status}, conclusion=${r.conclusion || "n/a"}; skipped/neutral/cancelled count as failure)`);
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
      //
      // EVAL-TIMING split: a run that is still queued/in_progress has not
      // ANSWERED yet. Sibling required gates start within the same second as this
      // one, so reading their run mid-flight and calling it a failure red-flags a
      // record whose contexts go green moments later. Unconcluded => pending (the
      // caller re-polls, bounded); only a CONCLUDED non-success is a real failure.
      if (wr.status !== "completed") {
        pushPending(ctx, `required context '${ctx.context}' — Actions run ${runId} ${NEVER_CONCLUDED_PHRASE} (run status=${wr.status || "n/a"}, conclusion=${wr.conclusion || "n/a"}) — ${waitedPhrase(waitedMs)}; an unconcluded run cannot bless the context (fail closed)`, wr.status || "unknown");
        return true;
      }
      if (wr.conclusion !== "success") {
        reasons.push(`required context '${ctx.context}' — Actions run ${runId} ${CONCLUDED_NON_SUCCESS_PHRASE} overall (run status=${wr.status || "n/a"}, conclusion=${wr.conclusion || "n/a"}) — a same-run job (e.g. the genuine reusable job) is non-passing, so a surviving same-name success cannot bless the context (fail closed)`);
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
  // SELF-REFERENCE (this gate is itself a required context in every repo suite
  // that gates on it). While THIS run is the one evaluating, its own check-run is
  // by definition status=in_progress: it cannot have concluded inside itself, and
  // no amount of waiting changes that — the wait would just burn the job timeout
  // and then red-flag the record anyway. So the gate's OWN check-run is excluded
  // from the candidate set. ONLY ITS OUTCOME is skipped; its IDENTITY is proved
  // FIRST, with the same bindings every other candidate must satisfy:
  //   - the run id in the check-run url equals GITHUB_RUN_ID (never the context
  //     NAME — a same-name check-run from any other run stays fully verified, so a
  //     surviving same-name success can still never bless a run whose genuine job
  //     is non-passing);
  //   - the check-run comes from the github-actions App;
  //   - the resolved run's head_sha is the reviewed head, its check_suite_id is
  //     THIS check-run's check_suite.id, and this check-run's id is in the run's
  //     LATEST-attempt job set. The url is App-controllable, so url-agreement
  //     alone is NOT identity: without these binds any App with checks:write could
  //     point a forged check-run's details_url at this run and have a required
  //     context skipped (codex-converge HIGH — reproduced as a fail-open);
  //   - for a workflow-pinned context, the run must additionally reference the
  //     pinned reusable workflow at the pinned SHA.
  // A candidate that does not PROVE all of that is not "ours": it stays in the set
  // and is verified normally (fail closed). Only when every remaining candidate is
  // a proven job of this very run is the context satisfied by THIS run — its real
  // outcome IS this run's own conclusion, which branch protection enforces
  // directly, so blessing it here cannot make a red gate look green.
  // RESIDUAL, on record: a caller workflow could add a SECOND job to this same run
  // whose name impersonates ANOTHER required context. That requires editing
  // .github/** — a high-risk path that requires the MAINTAINER HUMAN ARM, never
  // this machine arm (the same residual class as the continue-on-error note above).
  const selfId = (selfRunId === null || selfRunId === undefined || String(selfRunId).trim() === "") ? null : String(selfRunId).trim();
  function isOwnRunCheckRun(run, ctx) {
    if (!selfId || extractRunId(run) !== selfId) return false;
    if ((run.app?.slug || "") !== "github-actions") return false;
    if (typeof runWorkflow !== "function") return false;
    if (!reviewedHeadSha || !/^[0-9a-fA-F]{40}$/.test(String(reviewedHeadSha))) return false;
    let wr;
    try { wr = runWorkflow(selfId); } catch { wr = null; }
    if (!wr) return false;
    if (String(wr.headSha || "").toLowerCase() !== String(reviewedHeadSha).toLowerCase()) return false;
    const csId = run.check_suite?.id;
    if (csId === undefined || csId === null || wr.checkSuiteId === null || String(wr.checkSuiteId) !== String(csId)) return false;
    if (!(wr.latestAttemptJobIds instanceof Set) || !wr.latestAttemptJobIds.has(String(run.id))) return false;
    if (ctx.workflow && !referencesPinnedWorkflow(wr, ctx)) return false;
    // The suite's declared caller/event constraints are part of the context's
    // IDENTITY, not its outcome — enforce them here exactly as the normal path
    // does, malformed-declaration fail-closed included.
    if (!verifyCallerConstraints(wr, ctx, selfId).ok) return false;
    return true;
  }
  for (const ctx of suite.requiredContexts) {
    const allCandidates = checkRuns.filter((r) => runIsCandidate(r, ctx));
    const selfCandidates = allCandidates.filter((r) => isOwnRunCheckRun(r, ctx));
    const candidates = selfCandidates.length ? allCandidates.filter((r) => !selfCandidates.includes(r)) : allCandidates;
    if (candidates.length === 0 && selfCandidates.length > 0) {
      notes.push(`required context '${ctx.context}' resolves ONLY to check-run(s) proven to belong to this gate's own Actions run ${selfId} (head + check_suite + latest-attempt job id${ctx.workflow ? " + the pinned reusable workflow" : ""} all bind) — a run cannot have concluded inside itself; the context's outcome is this run's own conclusion (enforced by branch protection), so it is not re-verified here (self-reference)`);
      continue;
    }
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
  return finish();
}

// ===========================================================================
// EVAL-TIMING — bounded re-poll of unconcluded required contexts.
//
// The required contexts of a suite are SIBLING workflow runs that start within
// the same second as this gate. Reading them while they are still queued/
// in_progress and calling that a failure red-flags records whose contexts go
// green seconds later — a false red on a truthful record. The fix is to WAIT for
// an answer, bounded, and to fail only on:
//   - a CONCLUDED non-success (immediately — waiting cannot change it), or
//   - the window expiring with the context still unconcluded (a distinct
//     "never concluded" message, never confusable with a reported failure).
// Everything stays fail-CLOSED: an unconcluded context never passes, it is only
// given a bounded chance to conclude first.
// ===========================================================================

/** Total re-poll budget for unconcluded required contexts (10 minutes). */
export const GATE_ARM_SETTLE_MAX_MS = 10 * 60 * 1000;
/** Backoff schedule; the last entry repeats until the budget is spent. */
export const GATE_ARM_SETTLE_BACKOFF_MS = [15_000, 30_000, 60_000, 90_000];

/**
 * Synchronous sleep. The whole gate is synchronous (execFileSync/`gh api`), so
 * the re-poll cannot use timers without rewriting every call site as async.
 * Atomics.wait on a private SharedArrayBuffer blocks this thread only.
 */
export function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Wrap verifyGateArm in the bounded re-poll. Returns a function with the SAME
 * (parsed, opts) signature as verifyGateArm, so every call site is unchanged and
 * offline/unit callers keep the pure single-shot behavior.
 *
 * @param refresh   () => { checkRuns, runWorkflow } — re-fetches the check-runs
 *                  for the reviewed head and a FRESH run resolver (the resolver
 *                  memoizes per invocation, so a stale one would replay the old
 *                  in_progress run forever). Returns null/throws on failure.
 * @param sleep     injectable blocking sleep (tests pass a recorder).
 * @param maxWaitMs total budget; 0 disables waiting (single-shot).
 * @param nowMs     injectable clock so tests are deterministic.
 *
 * The loop only runs while `pendingOnly` — every reason is an unconcluded
 * context. A concluded non-success, a suite/accountable mismatch or a stale audit
 * returns immediately (waiting is pointless and would burn the job budget).
 */
export function makeSettlingGateArmVerifier({
  refresh,
  sleep = sleepSync,
  maxWaitMs = GATE_ARM_SETTLE_MAX_MS,
  backoff = GATE_ARM_SETTLE_BACKOFF_MS,
  verify = verifyGateArm,
  onWait = null,
} = {}) {
  return (parsed, opts) => {
    let waited = 0;
    let attempt = 0;
    let v = verify(parsed, { ...opts, waitedMs: null });
    if (typeof refresh !== "function" || !(maxWaitMs > 0)) return v;
    while (!v.ok && v.pendingOnly && waited < maxWaitMs) {
      const step = backoff[Math.min(attempt, backoff.length - 1)];
      const delay = Math.min(step, maxWaitMs - waited);
      if (!(delay > 0)) break;
      if (typeof onWait === "function") onWait({ attempt, delay, waited, pending: v.pending });
      sleep(delay);
      waited += delay;
      attempt += 1;
      let fresh = null;
      try { fresh = refresh(); } catch { fresh = null; }
      // A refresh failure keeps the LAST verdict (fail closed) rather than
      // inventing a pass; the message already says how long we waited.
      if (!fresh || !Array.isArray(fresh.checkRuns)) break;
      v = verify(parsed, {
        ...opts,
        checkRuns: fresh.checkRuns,
        runWorkflow: fresh.runWorkflow === undefined ? opts.runWorkflow : fresh.runWorkflow,
        waitedMs: waited,
      });
    }
    return v;
  };
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
// §6b — the IN-BRANCH CORRECTION COVER (pre-merge check 5).
//
// THE GAP. Check 5 reads each range commit's OWN message, and a message is
// fixed the moment the commit exists: a historical bot-identity commit that
// landed without a named `Assisted-by` could therefore NEVER go green, because
// the record it is missing cannot be written into it. The only escape the
// engine left was rewriting the branch's history — which on a long-lived pull
// request discards every review and every green check it already earned.
//
// THE RULE, mirrored from the coordinator's merge road (its `4-assisted-union`
// check, rule "a Correction-for record (2026-09-14)"), which has accepted
// exactly this since that date: a flagged commit is COVERED when a
// LATER commit in the SAME pull-request range carries a well-formed
// `Correction-for:` line naming that commit's FULL 40-hex sha AND carries a
// named (non-`none`) `Assisted-by` of its own. The record is then IN THE
// BRANCH, where a reviewer reads it before approving, and check 5 stops
// demanding the one thing that cannot be supplied.
//
// WHAT IT DOES NOT RELAX — every one of these still raises the finding, each
// with its own test:
//   - a PROSE mention of the sha counts for nothing. The pointer must be a
//     LINE matching CORRECTION_RE — the same §1 grammar the trailer parser
//     uses — so a body that merely talks about the commit is not a record;
//   - an ABBREVIATED sha counts for nothing (full 40 hex, as the merge road
//     requires a 40-character token or nothing);
//   - a correction whose OWN `Assisted-by` is `none` or absent covers nothing:
//     it would replace one missing record with another;
//   - a correction EARLIER in the range than the commit it names covers
//     nothing (see ORDER);
//   - a correction naming a DIFFERENT commit covers only that commit;
//   - a correction OUTSIDE the range is not read at all. The cover is
//     IN-BRANCH, exactly like the merge road's, whose rows are the pull
//     request's own commits and nothing else.
//
// WHERE THE POINTER MAY SIT: anywhere in the message. The real correction
// records carry `Correction-for: <sha>` as the SUBJECT line (both of
// cinatra#3079's), and an earlier example carried it in the trailer block; the
// merge road reads any line of the message that starts with the key, so this
// reads any line too. `parseTrailers().correctionFor` alone would see only the
// trailer block and miss the subject — it is deliberately not the reader here.
//
// ORDER. The pre-merge range array is `git log <base>..HEAD` order — NEWEST
// FIRST (rangeCommitIdentities) — so a LATER commit sits at a LOWER index. The
// merge road's own rule sentence says "a later commit" while its python builds
// the corrected set over every row without testing order; this mirrors the
// SENTENCE, which can never refuse a real record: a commit's sha is fixed by its
// whole history, so no commit can name a sha that does not exist yet, and every
// real correction is later than what it corrects. Strictly-later also means a
// commit can never correct ITSELF, which is §6's rule for the landed path.
//
// EMPTINESS. A correction is NOT required to be a content-free (empty) commit:
// the merge road reads identities and message lines only, never the
// correction's tree, and this mirrors it. (The real records happen to be empty.)
//
// FAIL-CLOSED DIRECTION. The cover can only ever REMOVE check 5's finding for a
// commit that a valid, named, in-range, later correction claims — and it is
// DISCLOSED as an `agent-commit-corrected` notice, never silent. No other check
// reads it and nothing else is relaxed.
// ===========================================================================

/**
 * Map each range commit that a LATER in-range correction covers to that
 * correction's sha. Pure: `{ rangeIdentities, messageBySha }` in, Map out
 * (lower-cased full shas both sides). An unreadable message reads as no
 * correction, which leaves check 5 exactly as it was (fail closed).
 */
export function inBranchCorrectionCover({ rangeIdentities = [], messageBySha = {} } = {}) {
  const cover = new Map();
  const ids = Array.isArray(rangeIdentities) ? rangeIdentities : [];
  const positionOf = new Map();
  ids.forEach((id, i) => {
    const sha = asFullSha(id && id.sha);
    if (sha && !positionOf.has(sha)) positionOf.set(sha, i);
  });
  ids.forEach((id, i) => {
    const msg = (messageBySha && messageBySha[id && id.sha]) || "";
    if (!msg) return;
    // The correction's OWN record must name an agent — read exactly the way
    // check 5 reads every other commit's (the trailer block's Assisted-by).
    if (!parseTrailers(msg).assisted.some((a) => !a.isNone)) return;
    for (const line of String(msg).split(/\r?\n/)) {
      const m = line.match(CORRECTION_RE);
      if (!m) continue;
      const target = asFullSha(m.groups.sha);
      if (!target) continue;
      const at = positionOf.get(target);
      if (at === undefined) continue;   // names a commit outside this range
      if (!(at > i)) continue;          // newest-first: the correction must be LATER (self excluded)
      if (!cover.has(target)) cover.set(target, asFullSha(id && id.sha) || String(id && id.sha));
    }
  });
  return cover;
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
 *     mergeInfoBySha (§5c: sha -> { parents, tree, cleanTree }),
 *     defaults, repoSuite,
 *     // optional API-derived (when a client + PR are available):
 *     reviews, prAuthorLogin, reviewedHeadSha, permissionByLogin, suiteFile,
 *     checkRuns, declaredReviewedBy }
 */
export function analyzePreMerge(ctx) {
  const findings = [];
  const delegationRequested = Boolean(ctx.delegationRequested || ctx.declaredAuthorization);
  const delegated = delegationRequested && ctx.apiBound === true && ctx.delegation?.ok === true;
  if (delegationRequested && !delegated) findings.push({ code: "merge-authorization-unverifiable", severity: "error",
    message: "scoped merge authorization failed: " + (ctx.delegation?.reasons || ["authenticated receipt unavailable"]).join("; ") });

  // check 4 + §3: high-risk mapping (always computable from the diff + config).
  const hr = classifyHighRisk(ctx.changedFiles || [], ctx.defaults, ctx.repoSuite);
  for (const e of hr.errors) findings.push({ code: "high-risk-config", severity: "error", message: e });

  // check 5: any range commit authored/committed by a known agent must carry a
  // matching Assisted-by in its OWN message (branch-commit attribution) — or,
  // §6b, be covered by a LATER in-branch `Correction-for` record that names it
  // in full and names its own agent (the merge road's rule since 2026-09-14).
  const correctionCover = inBranchCorrectionCover(ctx);
  for (const id of ctx.rangeIdentities || []) {
    // §5b: a TOOL-MADE DEPENDENCY BUMP is not agent work — no agent produced it,
    // so `Assisted-by: none` (or no line) is the truthful record and this commit
    // is not read as agent work at all. Every other commit falls through to the
    // rule below, unchanged.
    if (ctxCommitIsBump(ctx, id)) continue;
    // §5c: a CONTENT-FREE CLEAN MERGE (a bring-up-to-date merge whose tree is
    // the clean merge of its parents) contributed no line — it is not read as
    // agent work at all. A merge whose tree differs (a conflict resolved by
    // hand) and an unreadable one fall through to the rule below, unchanged.
    if (ctxCommitIsCleanMerge(ctx, id)) continue;
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
        // §6b: the record may instead be in the BRANCH — a later commit of this
        // same range whose `Correction-for:` line names this commit in full and
        // which names its own agent. Disclosed, never silent.
        const coveredBy = correctionCover.get(asFullSha(id.sha));
        if (coveredBy) {
          findings.push({
            code: "agent-commit-corrected",
            severity: "notice",
            message: `commit ${shortSha(id.sha)} carries no named Assisted-by of its own, but the LATER in-range commit ${shortSha(coveredBy)} is a Correction-for record naming it in full and naming its agent — the record is in the branch (§6b; the merge road has accepted this since 2026-09-14)`,
          });
          continue;
        }
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
  if (hr.highRisk && !delegated) {
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
          contentBinds: ctx.contentBinds,
        }).ok);
      // Fallback when no declared Reviewed-by claim is available pre-merge: is
      // there ANY real maintainer-standing, non-self, non-stale APPROVED review?
      const anyMaintainerApproval = !maintainerOk && (ctx.approverLogins || []).some((login) => verifyReviewedLine({ login, tier: "maintainer" }, {
        reviews: ctx.reviews,
        permission: (ctx.permissionByLogin || {})[login],
        prAuthorLogin: ctx.prAuthorLogin,
        reviewedHeadSha: ctx.reviewedHeadSha,
        contentBinds: ctx.contentBinds,
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
          contentBinds: ctx.contentBinds,
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
      // ctx.verifyGateArm (when main() supplies it) is the settling wrapper: it
      // re-polls unconcluded required contexts within a bounded window before
      // reporting. Absent it, the pure single-shot verifier is used unchanged.
      const verifyArm = ctx.verifyGateArm || verifyGateArm;
      const v = verifyArm(ctx.declaredGateArm, { suiteFile: ctx.suiteFile || { ok: false, reason: "no committed gate-suite.json" }, checkRuns: ctx.checkRuns, now: ctx.now, reviewedHeadSha: ctx.reviewedHeadSha, runWorkflow: ctx.runWorkflow, selfRunId: ctx.selfRunId });
      if (!v.ok) findings.push({ code: "gate-suite-fabricated", severity: "error", message: `Gate-suite arm fails verification: ${v.reasons.join("; ")}` });
      for (const w of v.warnings || []) findings.push({ code: "gate-suite-audit-stale", severity: "warning", message: w });
      for (const n of v.notes || []) findings.push({ code: "gate-suite-self-reference", severity: "warning", message: n });
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
 * QUEUE ARM analysis (the `merge_group` event).
 *
 * Three queue-specific facts, then the record itself. The record is NOT judged
 * by a second implementation: `analyzePreMerge` is called with the queued pull
 * request's context (its declared record parsed by the SAME `parseTrailers`, its
 * approvals, its check-runs, and the reviewed head pinned to the head AT
 * ENQUEUE), so a record that fails in the queue fails with exactly the codes it
 * would have failed with pre-merge.
 *
 * ctx (beyond everything analyzePreMerge reads):
 *   membership        — resolveQueuedPr's verdict (required);
 *   approvedHeadCheck — verifyQueuedApprovedHead's verdict;
 *   queueCandidate    — resolveQueueCandidate's verdict.
 * A missing verdict is a FAILED verdict: this arm never passes on absence.
 */
// An authenticated v1 receipt authorizes one frozen queue candidate. It does
// not authorize rebasing onto a later queue base or adding another pull request.
function queuedDelegation(ctx) {
  const t = ctx.delegation?.receipt?.target, q = ctx.queueBinding, m = ctx.membership;
  const bound = ctx.apiBound === true && ctx.delegation?.ok === true && t && q
    && m?.status === "resolved" && m.candidates?.length === 1
    && q.pulls?.length === 1 && q.pulls[0].number === m.number
    && q.pulls[0].head?.sha === m.headAtEnqueue
    && t.repository === q.repository && t.pullRequest === m.number
    && t.headSha === m.headAtEnqueue && t.headSha === ctx.reviewedHeadSha
    && q.pr?.number === t.pullRequest && q.pr.head?.sha === t.headSha
    && q.pr.head?.ref === t.headRef && q.pr.head?.repo?.full_name === t.repository
    && Number.isSafeInteger(t.repositoryId) && t.repositoryId > 0
    && q.pr.head?.repo?.id === t.repositoryId && q.pr.base?.repo?.id === t.repositoryId
    && q.pr.base?.ref === t.base.ref && q.pr.base?.repo?.full_name === t.repository
    && q.baseSha === t.base.sha && q.headIsCheckout === true
    && q.parents?.length === 2 && q.parents[0] === t.base.sha && q.parents[1] === t.headSha
    && ctx.queueCandidate?.ok === true && ctx.queueCandidate.groupTree === t.mergeTree
    && ctx.queueCandidate.expectedTree === t.mergeTree
    && canonicalAuthorization(queuePrIdentity(q.pr)) === canonicalAuthorization(queuePrIdentity(q.finalPr));
  return { ok: Boolean(bound), reason: bound ? null : "authenticated delegation does not bind exactly this pull request, current head, frozen base and queue tree" };
}
function queuePrIdentity(pr) {
  if (!pr) return null;
  return { number: pr.number, body: pr.body, state: pr.state, merged: pr.merged,
    comments: pr.comments, changedFiles: pr.changed_files, draft: pr.draft,
    head: { sha: pr.head?.sha, ref: pr.head?.ref, repository: pr.head?.repo?.full_name, repositoryId: pr.head?.repo?.id },
    base: { ref: pr.base?.ref, repository: pr.base?.repo?.full_name, repositoryId: pr.base?.repo?.id } };
}
// A current API-bound result for callers, never an alternate authority input.
// The review path permits a fork head; the delegated predicate already requires
// both repositories to be the receipt's exact repository.
function verifiedQueueBinding(ctx, groupHeadSha) {
  const q = ctx.queueBinding, m = ctx.membership, candidate = ctx.queueCandidate;
  const delegated = Boolean(ctx.delegationRequested || ctx.declaredAuthorization);
  const authority = delegated ? queuedDelegation(ctx) : ctx.approvedHeadCheck;
  const full = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
  const positive = value => Number.isSafeInteger(value) && value > 0;
  if (!(ctx.apiBound === true && authority?.ok === true && candidate?.ok === true
    && m?.status === "resolved" && m.candidates?.length === 1 && positive(m.number)
    && q?.headIsCheckout === true && q.pulls?.length === 1
    && q.pulls[0].number === m.number && q.pulls[0].head?.sha === m.headAtEnqueue
    && full(groupHeadSha) && full(q.baseSha) && full(m.headAtEnqueue)
    && q.parents?.length === 2 && q.parents[0] === q.baseSha && q.parents[1] === m.headAtEnqueue
    && full(candidate.groupTree) && candidate.groupTree === candidate.expectedTree
    && q.pr?.number === m.number && q.pr.state === "open" && q.pr.merged === false && q.pr.draft === false
    && q.pr.head?.sha === m.headAtEnqueue && typeof q.pr.head?.ref === "string" && q.pr.head.ref.length > 0
    && positive(q.pr.head?.repo?.id) && typeof q.pr.head.repo.full_name === "string"
    && positive(q.pr.base?.repo?.id) && q.pr.base.repo.full_name === q.repository
    && typeof q.pr.base?.ref === "string" && q.pr.base.ref.length > 0
    && canonicalAuthorization(queuePrIdentity(q.pr)) === canonicalAuthorization(queuePrIdentity(q.finalPr)))) return null;
  return { schema: "cinatra.queue-binding/v1", repository: q.repository, repositoryId: q.pr.base.repo.id,
    pullRequest: m.number, headSha: m.headAtEnqueue, headRepositoryId: q.pr.head.repo.id,
    baseRef: q.pr.base.ref, baseSha: q.baseSha, groupHeadSha, parents: [...q.parents],
    groupTree: candidate.groupTree, authority: delegated ? "delegated-v1" : "review" };
}
export function analyzeMergeGroup(ctx) {
  const findings = [];
  const delegationRequested = Boolean(ctx.delegationRequested || ctx.declaredAuthorization);
  const authority = delegationRequested ? queuedDelegation(ctx) : ctx.approvedHeadCheck;
  const membership = ctx.membership || { status: "unresolved", number: null, candidates: [] };

  if (membership.status === "ambiguous") {
    const names = (membership.candidates || []).map((c) => `#${c.number}`).join(", ");
    findings.push({
      code: "queue-membership-ambiguous",
      severity: "error",
      message: `the merge group binds to ${(membership.candidates || []).length} candidate pull requests (${names}) — a queue entry must resolve to exactly one; failing closed rather than picking one`,
    });
  } else if (membership.status !== "resolved") {
    findings.push({
      code: "queue-membership-unresolved",
      severity: "error",
      message: `no pull request could be bound to this merge group from the group head's parents and the queue's pull-request list — failing closed`,
    });
  } else {
    const ah = authority;
    if (!ah || ah.ok !== true) {
      findings.push({
        code: "queue-approved-head",
        severity: "error",
        message: `pull request #${membership.number}: ${(ah && ah.reason) || "the approved head at enqueue could not be verified — failing closed"}`,
      });
    }
    const qc = ctx.queueCandidate;
    if (!qc || qc.ok === undefined) {
      findings.push({
        code: "queue-candidate-unverifiable",
        severity: "error",
        message: `pull request #${membership.number}: ${(qc && qc.reason) || "the queue candidate could not be verified — failing closed"}`,
      });
    } else if (qc.ok === false) {
      findings.push({ code: "queue-candidate-mismatch", severity: "error", message: `pull request #${membership.number}: ${qc.reason}` });
    }
  }

  // A valid receipt for a different group must not satisfy the delegated
  // high-risk alternative; invalid declared authority never falls back to review.
  const record = analyzePreMerge(delegationRequested && !authority?.ok
    ? { ...ctx, delegation: { ok: false, reasons: [authority?.reason || "queue authority unavailable"] } } : ctx);
  return {
    findings: [...findings, ...record.findings],
    highRisk: record.highRisk,
    highRiskMatched: record.highRiskMatched,
    membership,
  };
}

// ===========================================================================
// §6 — CORRECTION DISCOVERY: the pure selection rule (the testable half).
//
// THE RULE. When the engine re-verifies an EXPLICITLY GIVEN commit X, a
// `Correction-for: X` record that later landed on the default branch governs X's
// verdict IN X'S STEAD — validated with X's OWN verification context (X's
// resolved PR, approvals, reviewed head, check-runs). That context substitution
// is the whole point: a correction RESTATES X's record, so its Reviewed-by /
// Gate-suite claims are claims ABOUT X and must verify against X's PR, not
// against whatever trivial PR merged the correction itself.
//
// DIRECT-ONLY (the chained-correction rule). Discovery follows ONLY records
// whose Correction-for equals X. It NEVER walks a chain: a commit that corrects
// a CORRECTION (Correction-for: C, where C corrects X) is not a candidate for X.
// Two consequences, both intended:
//   - a corrected correction loses latest-wins NATURALLY — to supersede C as X's
//     record, a commit must name X itself, and then it simply wins on recency;
//   - no traversal means no cycle, no depth bound, and no transitive trust: the
//     record that governs X is always one a human/gate wrote ABOUT X.
//
// FAIL-CLOSED. Selection can only ever REPLACE the record text that gets
// validated; it never relaxes a check. The governing correction is re-validated
// through the full post-merge machinery in X's context, so discovery cannot turn
// an invalid verdict valid except through a fully VALID correction record whose
// own claims verify. A malformed correction does not govern; a self-referential
// pointer is ignored; an unknown target matches nothing.
// ===========================================================================

/**
 * Select the correction record that governs `targetSha`, purely.
 *
 * `candidates` are `{ sha, message }` (or a pre-`parsed` record) in FIRST-PARENT
 * OLDEST-FIRST order — the order collectCorrectionCandidates emits. That order is
 * authoritative and is the whole of "latest": the LAST valid direct correction
 * wins. First-parent history is a total order, so this is deterministic; ties are
 * impossible by construction (a commit appears once).
 *
 * Returns { governing, superseded, findings } where `governing` is
 * { sha, message, parsed } | null, `superseded` lists the valid corrections that
 * lost latest-wins (reported, never silently dropped), and `findings` carries the
 * warnings for the records that were REFUSED (malformed / self-referential).
 */
export function selectGoverningCorrection({ targetSha, targetParsed = null, candidates = [] } = {}) {
  const findings = [];
  const target = asFullSha(targetSha);
  if (!target) return { governing: null, superseded: [], findings };

  // Self-reference on the TARGET's own record: a record cannot correct itself.
  // Ignored with a warning (and, at the call site, denied the non-PR-correction
  // tree-bridge exemption — "ignored" means the pointer buys nothing).
  if (targetParsed && targetParsed.correctionFor === target) {
    findings.push({
      code: "correction-self-reference",
      severity: "warning",
      message: `commit ${shortSha(target)} carries Correction-for pointing at ITSELF — a record cannot correct itself; the pointer is ignored`,
    });
  }

  const valid = [];
  for (const c of candidates || []) {
    if (!c) continue;
    const sha = asFullSha(c.sha);
    const parsed = c.parsed || parseTrailers(c.message ?? "");
    const points = parsed.correctionFor;
    if (!points) continue; // an ordinary commit, not a correction — not a candidate.
    if (sha && points === sha) {
      findings.push({
        code: "correction-self-reference",
        severity: "warning",
        message: `commit ${shortSha(sha)} carries Correction-for pointing at ITSELF — a record cannot correct itself; ignored`,
      });
      continue;
    }
    // Direct-only: a correction aimed at a DIFFERENT commit (a chained
    // correction, or a repair whose target sha is unknown/never landed) has no
    // effect on THIS commit's verdict.
    if (points !== target) continue;
    // A correction whose OWN record is not a valid §1 record cannot be the record
    // of truth for X. It does not govern; the next-latest valid one is tried, and
    // failing that X's own verdict stands.
    const errors = [...parsed.errors, ...classifyArm(parsed).errors];
    if (errors.length) {
      findings.push({
        code: "correction-malformed",
        severity: "warning",
        message: `correction ${shortSha(sha || c.sha)} names ${shortSha(target)} but its own record is invalid (${errors[0]}) — it does NOT govern`,
      });
      continue;
    }
    valid.push({ sha, message: c.message ?? "", parsed });
  }

  if (!valid.length) return { governing: null, superseded: [], findings };
  return {
    governing: valid[valid.length - 1],
    superseded: valid.slice(0, -1).map((v) => v.sha),
    findings,
  };
}

// ===========================================================================
// §7 — MULTI-COMMIT REBASE LANDING: the pure classifier (the testable half).
//
// THE GAP (ci#94). A rebase merge lands the PR's commits individually and names
// the LAST of them as merge_commit_sha. The push arm bound that one commit and
// compared its own diff to the PR's whole reviewed change, so a multi-commit
// rebase reported `content-mismatch` even when every record was true and the
// approval real — a false red BY CONSTRUCTION, on exactly the shape the §5
// `Correction-for` repair mechanism requires.
//
// THE RULE. When the pushed commit is the TIP of a verbatim rebase of the PR's
// reviewed commits, the content binding is taken over the WHOLE landed range
// (base..tip) against the PR's full reviewed change, and each landed commit's
// OWN record is judged per-commit — the same per-commit judgement check 5 has
// always applied to branch commits, and the same judgement the §6 re-verify path
// will later apply to each of those commits individually.
//
// POSITIVE DETECTION, or nothing. The shape is asserted, never assumed:
//   - the PR's merge_commit_sha IS the pushed commit (it merged HERE);
//   - the PR has >= 2 commits (one commit is already bound by the existing
//     single-commit path, byte-identically) and fewer than the 250-commit API
//     cap (a truncated reviewed set cannot be bound at all);
//   - the local first-parent walk yields the N landed commits AND the commit
//     they landed on;
//   - every landed commit has exactly ONE parent (a rebase never lands a merge);
//   - each landed commit carries, in order, the VERBATIM message of the
//     corresponding reviewed commit (a rebase preserves messages; a squash
//     synthesizes a new one). This is what separates a rebase landing from a
//     squash landing, and it is why a squash's behavior cannot change.
// Anything unproven => `single`, i.e. the pre-ci#94 binding, unchanged.
//
// FAIL-CLOSED. Classification only ever chooses WHICH change gets compared; it
// never relaxes a comparison. A tampered rebased range still has to re-derive
// the reviewed fingerprint over base..tip, so any commit whose content differs
// from the reviewed set still reds with `content-mismatch`.
// ===========================================================================

/** Message equality for the shape test: line-ending- and trailing-space-blind. */
function normalizeCommitMessage(m) {
  return String(m ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "");
}

/**
 * Classify how a merged PR LANDED on the default branch, purely.
 *
 * Inputs are already-collected facts: the pushed commit, the PR's
 * merge_commit_sha, the PR's reviewed commit messages OLDEST-FIRST (the
 * `/pulls/{n}/commits` order), and the local first-parent chain NEWEST-FIRST
 * (collectLandedChain).
 *
 * Returns { shape: "rebase" | "single", base, head, commits, reason }, where for
 * a rebase `commits` are the landed commits OLDEST-FIRST (each carrying the
 * collector's sha/identity/message) and `base` is the commit they landed on. For
 * every other shape — squash, single-commit, ordinary merge, anything
 * unresolvable — `shape` is "single" and `reason` says why, so a caller can
 * disclose it instead of guessing.
 */
export function classifyLandedShape({ mergedSha, prMergeCommitSha, prCommitMessages = [], landedChain = [] } = {}) {
  const single = (reason) => ({ shape: "single", base: null, head: null, commits: [], reason });
  const head = asFullSha(mergedSha);
  if (!head) return single("the pushed commit did not resolve to a full sha");
  const mergeSha = asFullSha(prMergeCommitSha);
  if (!mergeSha) return single("the PR reports no merge commit sha");
  if (mergeSha !== head) return single(`the PR merged at ${shortSha(mergeSha)}, not at this commit — not a rebase tip`);

  const reviewed = Array.isArray(prCommitMessages) ? prCommitMessages : [];
  const n = reviewed.length;
  if (n < 2) return single("the PR carries fewer than two commits — the single-commit binding already compares like with like");
  if (n >= PR_COMMITS_API_CAP) {
    return single(`the PR reports ${n} commits, at or over GitHub's ${PR_COMMITS_API_CAP}-commit list cap — the reviewed set cannot be enumerated exactly, so no landed set can be bound to it`);
  }

  const chain = Array.isArray(landedChain) ? landedChain : [];
  // N landed commits PLUS the commit they landed on: without the base there is
  // no range to bind, so a short walk (shallow checkout) is not a rebase here.
  if (chain.length < n + 1) {
    return single(`only ${chain.length} first-parent commit(s) resolved locally; ${n + 1} are needed to bind a ${n}-commit rebase (shallow checkout?)`);
  }
  const landed = chain.slice(0, n);                       // newest-first
  if (asFullSha(landed[0] && landed[0].sha) !== head) return single("the first-parent walk does not start at the pushed commit");
  for (const c of landed) {
    if (!asFullSha(c && c.sha)) return single("a candidate landed commit did not resolve to a full sha");
    if (c.parentCount !== 1) {
      return single(`landed commit ${shortSha(c.sha)} has ${c.parentCount} parent(s) — a rebase lands only single-parent commits`);
    }
  }
  const base = asFullSha(chain[n] && chain[n].sha);
  if (!base) return single("the commit the candidate range landed on did not resolve to a full sha");

  // Verbatim message identity, in order: the landed set read oldest-first must be
  // the reviewed set read oldest-first. A squash's synthesized message fails this
  // at the first position, which is what keeps the squash path untouched.
  const oldestFirst = [...landed].reverse();
  for (let i = 0; i < n; i += 1) {
    if (normalizeCommitMessage(oldestFirst[i].message) !== normalizeCommitMessage(reviewed[i])) {
      return single(`landed commit ${shortSha(oldestFirst[i].sha)} does not carry reviewed commit ${i + 1}/${n}'s message verbatim — the landed set is not a rebase of the reviewed commits`);
    }
  }
  return { shape: "rebase", base, head, commits: oldestFirst, reason: null };
}

/**
 * Post-merge analysis: validate the synthesized squash message — the RECORD
 * itself. §5 checks 1–4 on the merge commit. The tree-identity bridge (§5) and
 * the live API checks are passed in via ctx (collected by main()).
 *
 * ctx: { message, changedFiles, defaults, repoSuite, treeMatch, approvedTreeMatch,
 *        reviews, prAuthorLogin, reviewedHeadSha, permissionByLogin,
 *        suiteFile, checkRuns, selfRunId, verifyGateArm,
 *        // §6 correction discovery (re-verify path ONLY — see the scope guard):
 *        correctionDiscovery, targetSha, correctionCandidates, correctionScan,
 *        // §7 multi-commit rebase landing (set only when positively classified):
 *        landedRange: { shape:"rebase", base, head, commits:[{ sha, message,
 *          changedFiles, authorName, authorEmail, committerName, committerEmail }] },
 *        landedSiblingPass }
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
  const delegated = parsed.hasDelegatedArm && apiBound && ctx.delegation?.ok === true
    && canonicalAuthorization(parsed.authorization) === canonicalAuthorization(ctx.delegation.reference);
  if (parsed.hasDelegatedArm && !delegated) findings.push({ code: "merge-authorization-unverifiable", severity: "error",
    message: "scoped merge authorization failed: " + (ctx.delegation?.reasons?.length ? ctx.delegation.reasons : ["authenticated exact receipt unavailable"]).join("; ") });

  // §6 SCOPE GUARD. Correction discovery runs ONLY when main() explicitly opted
  // this analysis in — i.e. the re-verify path, where a specific commit was named
  // with --commit. On the push-HEAD default path ctx.correctionDiscovery is never
  // set, so every line below is inert and that arm's behavior is byte-for-byte
  // what it was: a bad record on the pushed commit is never rescued by anything.
  const discoveryInScope = ctx.correctionDiscovery === true;
  const targetSha = discoveryInScope ? asFullSha(ctx.targetSha) : null;
  const discovery = discoveryInScope
    ? selectGoverningCorrection({ targetSha, targetParsed: parsed, candidates: ctx.correctionCandidates || [] })
    : null;
  // "Ignored" for a self-referential pointer is literal: it does not even buy the
  // non-PR-correction exemption below. (Scope-guarded, so the push arm is
  // untouched; and inert in practice, since a record with no reviewed head has no
  // tree to bridge to in the first place.)
  const selfCorrecting = Boolean(targetSha && parsed.correctionFor === targetSha);

  // A correction (§5) skips the tree bridge ONLY when it is a genuine NON-PR
  // correction: an empty/direct-push attestation with NO associated PR (no
  // reviewedHeadSha to compare a tree against). A correction that DOES carry a
  // PR + reviewed head (a "PR-merge correction", §5) is validated exactly like
  // a merge record — tree identity included. So `Correction-for:` alone never
  // buys a tree-bridge bypass; only the absence of a reviewed head does.
  const isNonPrCorrection = Boolean(parsed.correctionFor) && !selfCorrecting && !ctx.reviewedHeadSha;

  // §7 MULTI-COMMIT REBASE LANDING (ci#94). Set by main() only when the pushed
  // commit was positively classified as the TIP of a verbatim rebase of the PR's
  // reviewed commits. The physical binding in ctx (contentMatch / contentBinds)
  // was then taken over the WHOLE landed range — the range is what the approval
  // covers — and `head` names which landed commit THIS pass is the record of.
  // Absent it every §7 line below is inert and the squash / single-commit
  // behavior is byte-for-byte what it was.
  const landing = (ctx.landedRange && ctx.landedRange.shape === "rebase"
    && Array.isArray(ctx.landedRange.commits) && ctx.landedRange.commits.length >= 2
    && asFullSha(ctx.landedRange.head)) ? ctx.landedRange : null;
  const landedSelf = landing
    ? (landing.commits.find((c) => asFullSha(c && c.sha) === asFullSha(landing.head)) || null)
    : null;
  const landingSummary = landing
    ? { shape: "rebase", base: landing.base, head: landing.head, commits: landing.commits.length }
    : null;

  // check 1: a valid §1 record must be present (grammar + structure + an arm).
  for (const e of parsed.errors) findings.push({ code: "no-record", severity: "error", message: `record invalid: ${e}` });
  for (const e of arm.errors) findings.push({ code: "no-record", severity: "error", message: `record invalid: ${e}` });

  // tree-identity bridge (§5): what landed must be byte-identical to what was
  // reviewed/checked. A mismatch invalidates the binding of approvals/contexts.
  // Only a genuine non-PR correction (no reviewed head exists) is exempt — and,
  // under §7, a SIBLING pass: the physical binding is the RANGE's single fact,
  // judged once on the pushed commit's pass, so re-judging it per landed commit
  // would report that one fact N times (it can never be skipped: the range pass
  // always runs, and a failed binding reds the whole check).
  if (!isNonPrCorrection && !ctx.landedSiblingPass) {
    if (ctx.treeMatch === true) {
      // Byte-identical tree — the strongest proof; pass without a content recompute.
    } else if (ctx.contentMatch === true) {
      // Tree differs (or was unresolvable) but the LANDED change re-derives to the
      // SAME content fingerprint as the reviewed change (engineering#483): a
      // mechanical rebase / update-branch / non-up-to-date merge / merge_group
      // synthetic commit. The approval binds. (A semantic conflict — same diff,
      // different behavior on a moved base — is caught by the mandatory post-merge
      // verify on the REAL merged SHA, the intended backstop for content binding's
      // intentionally weaker proof.)
    } else if (ctx.contentMatch === false) {
      // A PROVEN content divergence is never overridden — not even by a tree that
      // equals some other approved head (codex-converge HIGH: that would bless a
      // tree approved at head A while the approvals/contexts bound to head B).
      findings.push({ code: "content-mismatch", severity: "error", message: `the landed change is not the reviewed change (content fingerprint differs) — the landed tree is not what was reviewed; approvals/contexts do not bind` });
    } else if (ctx.approvedTreeMatch === true) {
      // Neither bridge could DECIDE (the reviewed head is not resolvable in this
      // checkout — a fork head, or a branch deleted at merge — so the content
      // fingerprint is undefined), but the landed tree is BYTE-IDENTICAL to a
      // commit a qualified LIVE approval was cast on (state APPROVED not
      // DISMISSED, that reviewer's latest review, non-self, peer standing). The
      // landed bytes ARE bytes a reviewer vouched for, whatever the branch's
      // intermediate commit ids were. Used only where the alternative is
      // "cannot tell" — never to overrule a proven mismatch above.
    } else if (ctx.treeMatch === false) {
      // Tree resolved and differs, and content could NOT be re-derived on both
      // sides to prove equivalence — preserve the tree-mismatch signal (fail closed).
      findings.push({ code: "tree-mismatch", severity: "error", message: `tree(merged) != tree(reviewed head) — the landed tree is not what was reviewed; approvals/contexts do not bind` });
    } else if (apiBound && (parsed.hasHumanArm || parsed.hasGateArm || parsed.hasDelegatedArm)) {
      // API bound but NEITHER tree NOR content could be resolved on both sides —
      // cannot confirm what landed == what was reviewed. Fail closed.
      findings.push({ code: "tree-unverifiable", severity: "error", message: `cannot resolve tree(merged) and tree(reviewed head), nor re-derive the content fingerprint on both sides, to confirm the landed change was the reviewed one — failing closed` });
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
          contentBinds: ctx.contentBinds,
        });
        if (!v.ok) findings.push({ code: "reviewed-by-fabricated", severity: "error", message: `Reviewed-by @${l.login} (tier=${l.tier}) fails verification: ${v.reasons.join("; ")}` });
        else if (l.tier === "maintainer") passingMaintainer.push(l.login);
      }
    }
  }
  if (hr.highRisk && passingMaintainer.length === 0 && !delegated) {
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
      const verifyArm = ctx.verifyGateArm || verifyGateArm;
      const v = verifyArm(parsed, { suiteFile: ctx.suiteFile || { ok: false, reason: "no committed gate-suite.json at the merged SHA" }, checkRuns: ctx.checkRuns, now: ctx.now, reviewedHeadSha: ctx.reviewedHeadSha, runWorkflow: ctx.runWorkflow, selfRunId: ctx.selfRunId });
      if (!v.ok) findings.push({ code: "gate-suite-fabricated", severity: "error", message: `Gate-suite arm fails verification: ${v.reasons.join("; ")}` });
      for (const w of v.warnings || []) findings.push({ code: "gate-suite-audit-stale", severity: "warning", message: w });
      for (const n of v.notes || []) findings.push({ code: "gate-suite-self-reference", severity: "warning", message: n });
    }
  }

  // check 5 (post-merge): the spec keys check 5 on PR-RANGE commit identities,
  // but the post-merge record itself must also reflect agent assistance. When
  // the PR range identities are available (passed via ctx for the merged PR),
  // a known-agent commit whose work landed must be represented by a non-`none`
  // Assisted-by line in the aggregated record. A squash of agent work that
  // carries `Assisted-by: none` is a missing record.
  //
  // §7: under a REBASE landing the record of truth for a landed commit is its
  // OWN message, so check 5 is keyed on THAT commit's own identity instead of the
  // PR's whole source range. The aggregate rule is the SQUASH rule (one record
  // answering for N commits); applying it to a rebase would red a human-authored
  // tip commit carrying a truthful `Assisted-by: none` because some OTHER landed
  // commit was agent-made. Nothing escapes: every landed commit is judged, each
  // against its own record (the loop below), which is also exactly what the §6
  // re-verify path will conclude for each of them individually.
  // §5b: tool-made dependency bumps are dropped from the reading first — a bump
  // is not agent work, so it neither demands a named Assisted-by on its own
  // landed record nor makes a squash record's `none` untrue.
  // §5c: a content-free clean merge is dropped with them — a bring-up-to-date
  // merge the bot made through the API contributed no line, so it neither
  // demands a record of its own nor makes a squash record's `none` untrue.
  const check5All = landedSelf ? [landedSelf] : ctx.rangeIdentities;
  const check5Identities = Array.isArray(check5All)
    ? check5All.filter((id) => !ctxCommitIsBump(ctx, id) && !ctxCommitIsCleanMerge(ctx, id))
    : check5All;
  if (Array.isArray(check5Identities) && check5Identities.length) {
    const anyAgent = check5Identities.some((id) =>
      looksLikeAgent({ name: id.authorName, email: id.authorEmail }, { tokens: ctx.agentTokens, allow: ctx.agentAllow }) ||
      looksLikeAgent({ name: id.committerName, email: id.committerEmail }, { tokens: ctx.agentTokens, allow: ctx.agentAllow }));
    const recordHasNamedAssisted = parsed.assisted.some((a) => !a.isNone);
    if (anyAgent && !recordHasNamedAssisted) {
      findings.push({ code: "agent-commit-no-assisted", severity: "error", message: landedSelf
        ? `this landed commit is authored/committed by a known agent identity but its own record's Assisted-by does not name any agent (Assisted-by: none / human-only is untrue here)`
        : `the squash range contains commits by a known agent identity but the record's Assisted-by does not name any agent (Assisted-by: none / human-only is untrue here)` });
    }
  }

  // ---- §7: the landing disclosure + each OTHER landed commit's own record ----
  if (landing) {
    findings.push({
      code: "rebase-landing",
      severity: "notice",
      message: `this commit is the tip of a ${landing.commits.length}-commit rebase landing: the content binding compares the PR's full reviewed change against the whole landed range ${shortSha(landing.base)}..${shortSha(landing.head)}, and every landed commit's record is judged on its own`,
    });
  }
  if (landing && !ctx.landedSiblingPass) {
    for (const c of landing.commits) {
      if (asFullSha(c && c.sha) === asFullSha(landing.head)) continue;   // this pass IS that commit's judgement
      // The SAME verification context — the PR's approvals, reviewed head,
      // check-runs, and the range's already-judged physical binding — with only
      // this commit's own record, own changed files and own identity substituted.
      // (Own changed files, not the range's: high-risk answers for what THIS
      // record covers, which is what the §6 re-verify path will judge it on. When
      // a per-commit set is missing the pass falls back to this pass's own set
      // rather than to an empty one, so an unknown surface is never "not
      // high-risk".)
      const sibling = analyzePostMerge({
        ...ctx,
        message: c.message,
        changedFiles: Array.isArray(c.changedFiles) ? c.changedFiles : (ctx.changedFiles || []),
        rangeIdentities: null,
        landedRange: { ...landing, head: c.sha },
        landedSiblingPass: true,
        correctionDiscovery: false,
        correctionCandidates: null,
        correctionScan: null,
      });
      for (const f of sibling.findings) {
        if (f.code === "rebase-landing") continue;                       // one disclosure per landing
        findings.push({ ...f, message: `landed commit ${shortSha(c.sha)}: ${f.message}` });
      }
    }
  }

  if (!discoveryInScope) return { findings, parsed, highRisk: hr.highRisk, highRiskMatched: hr.matched, landing: landingSummary };

  // ---- §6 correction discovery: applied AFTER X's own verdict is computed ----
  const discoveryFindings = [...discovery.findings];
  if (ctx.correctionScan && ctx.correctionScan.truncated) {
    discoveryFindings.push({
      code: "correction-scan-truncated",
      severity: "warning",
      message: `the correction scan was bounded to the first ${ctx.correctionScan.scanned} first-parent commit(s) after ${shortSha(targetSha)} — a correction landing beyond that window would not be seen, so "latest" here is latest-within-the-window`,
    });
  }
  if (ctx.correctionScan && ctx.correctionScan.reason) {
    // A DISCLOSURE, not a defect in the record: the scan could not run, so this
    // verdict is the commit's own — the pre-discovery behavior. Kept at `notice`
    // so it never adds noise to a verdict it did not change (and so the push
    // arm, which also passes --commit but has an empty range, stays quiet).
    discoveryFindings.push({ code: "correction-scan-skipped", severity: "notice", message: ctx.correctionScan.reason });
  }

  if (!discovery.governing) {
    // Nothing governs: X's own verdict stands, plus any refusal warnings.
    return { findings: [...findings, ...discoveryFindings], parsed, highRisk: hr.highRisk, highRiskMatched: hr.matched, governedBy: null, supersededCorrections: [], landing: landingSummary };
  }

  // The correction's record is validated IN X's STEAD but IN X's CONTEXT: the
  // same ctx (X's PR, approvals, reviewed head, check-runs, changed files, tree
  // and content bridges) with only the MESSAGE substituted. Discovery is switched
  // off for that pass — the governing record is evaluated on its own terms, and
  // direct-only selection already means there is no chain left to follow.
  const governed = analyzePostMerge({
    ...ctx,
    message: discovery.governing.message,
    correctionDiscovery: false,
    correctionCandidates: null,
    correctionScan: null,
  });
  const supersededNote = discovery.superseded.length
    ? `; superseded by recency: ${discovery.superseded.map(shortSha).join(", ")}`
    : "";
  return {
    findings: [
      {
        code: "correction-governs",
        severity: "notice",
        message: `the record for ${shortSha(targetSha)} is governed by correction ${shortSha(discovery.governing.sha)}, validated against ${shortSha(targetSha)}'s own PR/approval/check-run context (${shortSha(targetSha)}'s own record produced ${findings.length} finding(s), superseded by the correction)${supersededNote}`,
      },
      ...discoveryFindings,
      ...governed.findings,
    ],
    parsed: governed.parsed,
    highRisk: governed.highRisk,
    highRiskMatched: governed.highRiskMatched,
    governedBy: discovery.governing.sha,
    supersededCorrections: discovery.superseded,
    landing: landingSummary,
    ownFindings: findings,
  };
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
function annotate(level, msg, stream = process.stdout) { if (GH) stream.write(`::${level}::${msg.replace(/\n/g, " ")}\n`); }
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

/**
 * §5b: the tool-made-dependency-bump class definition. Co-located with the
 * high-risk defaults (<ci>/config) and read the same fail-closed way — there is
 * no CLI flag for it, so the reusable workflow's interface is unchanged.
 */
function bumpClassPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "tool-made-bump-class.json");
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
  if (repo && (args.pr || arm === "post-merge" || arm === "merge-group")) {
    try { client = makeGhClient({ repo }); } catch { client = null; }
  }

  let result;
  let queueBinding = null;
  let apiSkippedReason = null;

  // This gate's own Actions run id — the self-reference exclusion key (§5 check3).
  const selfRunId = args["self-run-id"] || process.env.GITHUB_RUN_ID || null;
  // Re-poll budget for unconcluded required contexts. `0` disables waiting.
  const gateArmWaitMs = args["gate-arm-wait-ms"] !== undefined
    ? Number(args["gate-arm-wait-ms"])
    : GATE_ARM_SETTLE_MAX_MS;
  // Build the settling verifier for a given reviewed head: each re-poll re-fetches
  // the check-runs AND mints a FRESH run resolver (the resolver memoizes per
  // invocation, so reusing it would replay the same in-flight run forever).
  const settlingVerifier = (headSha) => makeSettlingGateArmVerifier({
    maxWaitMs: Number.isFinite(gateArmWaitMs) ? gateArmWaitMs : GATE_ARM_SETTLE_MAX_MS,
    refresh: () => ({ checkRuns: client.checkRunsFor(headSha), runWorkflow: makeRunWorkflowResolver(client) }),
    onWait: ({ delay, pending }) => {
      const names = [...new Set(pending.map((p) => p.context))].join(", ");
      process.stderr.write(`truthful-attribution-gate: required context(s) not concluded yet [${names}] — re-polling in ${Math.round(delay / 1000)}s\n`);
    },
  });

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
    // §5 content binding (engineering#483): the staleness resolver injected into
    // every verifyReviewedLine below. anchor = the on-main diff base; an approval
    // whose commit re-derives the SAME change as the reviewed head (a mechanical
    // update-branch / rebase) is no longer stale. null when there is no base
    // (offline) => verifyReviewedLine falls back to exact-SHA staleness.
    ctx.contentBinds = makeContentBinds({ anchor: base });
    // §4 version-bump rule: the PARENT gate-suite.json is the file as it stood at
    // the diff base the changed-file range was computed against (local git, no
    // TOCTOU). Absent at the base => a NEW suite, bump rule is vacuous.
    ctx.parentSuiteFile = base ? jsonFileAtRef(base, ".github/gate-suite.json") : { ok: false, reason: "no diff base" };
    // Per-commit message lookup by SHA (so check 5 reads the right commit body).
    ctx.messageBySha = {};
    if (base) for (const id of rangeIdentities) { try { ctx.messageBySha[id.sha] = commitMessage(id.sha); } catch { /* skip */ } }
    // §5b: the class definition, plus — for the range commits whose identity is
    // IN the class — that commit's own changed files and hunk lines, read by the
    // SAME git road as the identities above. Anything unreadable stays absent,
    // so the commit is simply not a bump (fail closed).
    ctx.bumpClass = loadJsonSafe(bumpClassPath());
    ctx.commitDiffBySha = {};
    if (base) for (const id of rangeIdentities) {
      if (!identityInBumpClass(id, ctx.bumpClass)) continue;
      try { ctx.commitDiffBySha[id.sha] = { changedFiles: changedFilesForCommit(id.sha), fileLines: commitDiffLines(id.sha) }; } catch { /* not a bump */ }
    }
    // §5c: the merge facts of each range commit, read by the SAME git road. A
    // single-parent commit collects nothing; anything unreadable stays absent,
    // so the commit is simply not content-free (fail closed).
    ctx.mergeInfoBySha = {};
    if (base) for (const id of rangeIdentities) {
      try { const info = mergeInfoOf(id.sha); if (info) ctx.mergeInfoBySha[id.sha] = info; } catch { /* not content-free */ }
    }

    if (client && args.pr) {
      try {
        const pr = client.pr(args.pr);
        ctx.delegationRequested = /^Merge authorization:|^Merge-authorization:/im.test(pr.body || "");
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
        ctx.declaredAuthorization = declared.authorization;
        if (ctx.delegationRequested) {
          const hasTrailer = /^Merge-authorization:/im.test(pr.body || "");
          ctx.delegation = hasTrailer && (!declared.authorization || declared.errors.length)
            ? { ok: false, reasons: ["declared authorization record is malformed"] }
            : verifyDelegatedReceipt({ repository: repo, pullRequest: Number(args.pr), expectedHead: ctx.reviewedHeadSha,
              arm: "pre-merge", record: declared.authorization, mergeTree: mergedTreeOf });
        }
        if (declared.reviewed.length) ctx.declaredReviewedBy = declared.reviewed;
        if (declared.hasGateArm) ctx.declaredGateArm = declared;

        ctx.permissionByLogin = {};
        const loginsToResolve = [...ctx.approverLogins, ...(ctx.declaredReviewedBy || []).map((r) => r.login)];
        for (const login of loginsToResolve) {
          if (!login || ctx.permissionByLogin[login] !== undefined) continue;
          try { ctx.permissionByLogin[login] = client.permissionOf(login).permission; } catch { /* unknown */ }
        }
        if (ctx.reviewedHeadSha) {
          ctx.checkRuns = client.checkRunsFor(ctx.reviewedHeadSha);
          ctx.verifyGateArm = settlingVerifier(ctx.reviewedHeadSha);
        }
        ctx.runWorkflow = makeRunWorkflowResolver(client);
        ctx.selfRunId = selfRunId;
        ctx.suiteFile = repoSuite;
        ctx.apiBound = true;
      } catch (e) { apiSkippedReason = `GitHub API unavailable (${e.message}) — anti-fabrication checks skipped; offline checks only`; ctx.apiBound = false; }
    } else {
      apiSkippedReason = `no PR context (--pr / GITHUB_REPOSITORY) — anti-fabrication (approval/gate-arm) checks skipped; offline checks only`;
      ctx.apiBound = false;
    }
    result = analyzePreMerge(ctx);
  } else if (arm === "merge-group") {
    // QUEUE ARM. The group's pull request is resolved from the group head's
    // PARENTS and the queue's pull-request list; everything below hangs off that
    // binding, and an unresolvable or ambiguous group produces findings rather
    // than a verdict about some pull request the queue never enqueued.
    const groupHeadArg = args["merge-group-head"] || process.env.GITHUB_SHA || "HEAD";
    const groupHeadSha = resolveCommitSha(groupHeadArg) || groupHeadArg;
    const groupBaseArg = args["merge-group-base"] || null;
    const groupBaseSha = groupBaseArg ? (resolveCommitSha(groupBaseArg) || groupBaseArg) : null;
    const ctx = {
      changedFiles: [], rangeIdentities: [], messageBySha: {},
      agentTokens: loadAgentTokens(args), agentAllow: DEFAULT_NONAI_BOT_ALLOW,
      bumpClass: loadJsonSafe(bumpClassPath()), commitDiffBySha: {}, mergeInfoBySha: {},
      defaults, repoSuite, apiBound: false,
      membership: { status: "unresolved", number: null, candidates: [] },
      parentSuiteFile: { ok: false, reason: "no merge-group base" },
    };
    // The candidate's own changed set / branch identities, measured base..HEAD —
    // and ONLY when the checkout's HEAD is the group head (what actions/checkout
    // gives on a merge_group event). Anything else leaves them empty rather than
    // measuring a different tree and calling it this candidate.
    let headIsCheckout = false;
    try { headIsCheckout = resolveCommitSha("HEAD") === groupHeadSha; } catch { headIsCheckout = false; }
    if (groupBaseSha && headIsCheckout) {
      try {
        ctx.changedFiles = changedFilesForRange(groupBaseSha);
        ctx.rangeIdentities = rangeCommitIdentities(groupBaseSha);
        for (const id of ctx.rangeIdentities) { try { ctx.messageBySha[id.sha] = commitMessage(id.sha); } catch { /* skip */ } }
        // §5b: the candidate's own bump diffs, same git road (see the pre-merge arm).
        for (const id of ctx.rangeIdentities) {
          if (!identityInBumpClass(id, ctx.bumpClass)) continue;
          try { ctx.commitDiffBySha[id.sha] = { changedFiles: changedFilesForCommit(id.sha), fileLines: commitDiffLines(id.sha) }; } catch { /* not a bump */ }
        }
        // §5c: the candidate's own merge facts, same git road (see the pre-merge arm).
        for (const id of ctx.rangeIdentities) {
          try { const info = mergeInfoOf(id.sha); if (info) ctx.mergeInfoBySha[id.sha] = info; } catch { /* not content-free */ }
        }
        ctx.parentSuiteFile = jsonFileAtRef(groupBaseSha, ".github/gate-suite.json");
      } catch { /* leave the empty, fail-closed defaults */ }
    }
    if (!client) {
      apiSkippedReason = `no API context (--repo / GITHUB_REPOSITORY) — the queue membership could not be resolved; failing closed`;
    } else {
      try {
        ctx.queueBinding = { repository: repo, baseSha: groupBaseSha, headIsCheckout,
          parents: parentsOf(groupHeadSha), pulls: client.pullsForCommit(groupHeadSha) };
        ctx.membership = resolveQueuedPr({
          groupHeadSha,
          parents: ctx.queueBinding.parents,
          queuePulls: ctx.queueBinding.pulls,
        });
      } catch (e) {
        apiSkippedReason = `GitHub API unavailable (${e.message}) — the queue membership could not be resolved; failing closed`;
      }
    }
    if (client && ctx.membership.status === "resolved") {
      try {
        const prNumber = ctx.membership.number;
        const pr = client.pr(prNumber);
        ctx.prAuthorLogin = pr.user?.login;
        // The head AT ENQUEUE (the group head's own parent), never the live PR
        // head — a head that moved after the approval must surface as exactly
        // that, not be quietly adopted as the reviewed head.
        ctx.reviewedHeadSha = ctx.membership.headAtEnqueue;
        ctx.reviews = client.listReviews(prNumber);
        ctx.approverLogins = [...new Set(ctx.reviews.filter((r) => r.state === "APPROVED").map((r) => r.user?.login).filter(Boolean))];
        // The verification-boundary record is read off the pull request body by
        // the SAME parser the pre-merge arm uses.
        const declared = parseTrailers(pr.body || "");
        ctx.delegationRequested = /^Merge authorization:|^Merge-authorization:/im.test(pr.body || "");
        ctx.declaredAuthorization = declared.authorization;
        if (declared.reviewed.length) ctx.declaredReviewedBy = declared.reviewed;
        if (declared.hasGateArm) ctx.declaredGateArm = declared;
        ctx.permissionByLogin = {};
        for (const login of [...ctx.approverLogins, ...(ctx.declaredReviewedBy || []).map((r) => r.login)]) {
          if (!login || ctx.permissionByLogin[login] !== undefined) continue;
          try { ctx.permissionByLogin[login] = client.permissionOf(login).permission; } catch { /* unknown */ }
        }
        ctx.contentBinds = makeContentBinds({ anchor: groupBaseSha });
        ctx.checkRuns = client.checkRunsFor(ctx.reviewedHeadSha);
        ctx.verifyGateArm = settlingVerifier(ctx.reviewedHeadSha);
        ctx.runWorkflow = makeRunWorkflowResolver(client);
        ctx.selfRunId = selfRunId;
        ctx.suiteFile = repoSuite;
        ctx.approvedHeadCheck = verifyQueuedApprovedHead({
          headAtEnqueue: ctx.membership.headAtEnqueue,
          reviews: ctx.reviews,
          prAuthorLogin: ctx.prAuthorLogin,
          permissionByLogin: ctx.permissionByLogin,
        });
        ctx.queueCandidate = resolveQueueCandidate({
          groupHeadSha, baseSha: groupBaseSha, prHeadSha: ctx.membership.headAtEnqueue,
        });
        if (ctx.delegationRequested) {
          const hasTrailer = /^Merge-authorization:/im.test(pr.body || "");
          ctx.delegation = hasTrailer && (!declared.authorization || declared.errors.length)
            ? { ok: false, reasons: ["declared authorization record is malformed"] }
            : verifyDelegatedReceipt({ repository: repo, pullRequest: prNumber, expectedHead: ctx.reviewedHeadSha,
              arm: "pre-merge", record: declared.authorization, mergeTree: mergedTreeOf });
        }
        ctx.queueBinding.pr = pr;
        ctx.queueBinding.finalPr = client.pr(prNumber);
        ctx.apiBound = true;
      } catch (e) {
        apiSkippedReason = `GitHub API unavailable (${e.message}) — the queued pull request could not be verified; failing closed`;
        ctx.apiBound = false;
      }
    }
    result = analyzeMergeGroup(ctx);
    if (mode === "enforce" && !apiSkippedReason && result.findings.length === 0) {
      queueBinding = verifiedQueueBinding(ctx, groupHeadSha);
      if (!queueBinding) result.findings.push({ code: "queue-binding-unverifiable", severity: "error",
        message: "a complete current pull-request identity and ordered group tree could not be bound" });
    }
  } else {
    // post-merge: validate the squash record on the given commit (default HEAD).
    const commit = args.commit || "HEAD";
    const message = commitMessage(commit);
    const changedFiles = changedFilesForCommit(commit);
    const ctx = {
      message, changedFiles, defaults, repoSuite,
      agentTokens: loadAgentTokens(args), agentAllow: DEFAULT_NONAI_BOT_ALLOW,
      bumpClass: loadJsonSafe(bumpClassPath()), commitDiffBySha: {},
    };
    // Range identities for check 5 (the squash's source commits): the merge
    // commit is a squash, so its first parent is the base it landed on; the
    // range base..merge^ gives the PR's branch commits via the PR head when
    // available. We collect them from the associated PR when bound; otherwise
    // best-effort from the merge commit's first-parent range.
    // tree-identity + API anti-fabrication require knowing the PR + reviewed head.
    //
    // The PR is resolved AUTHORITATIVELY from the merge commit itself (the
    // commit→PR association, the squash subject's "(#N)", or the --pr hint — each
    // accepted only when its merge_commit_sha IS this commit). A PR that does not
    // bind to this commit is never used: binding the reviewed head, the approvals
    // and the required contexts to the wrong PR yields an internally consistent
    // verdict about a different change.
    const mergedSha = resolveCommitSha(commit) || commit;

    // §6 CORRECTION DISCOVERY — collected here beside the other post-merge
    // collectors, and SCOPE-GUARDED to the re-verify path: only when --commit was
    // EXPLICITLY given. The push-HEAD default (`args.commit` absent => "HEAD")
    // never opts in, so that arm keeps its exact previous behavior.
    //
    // Honest note on the push arm: the reusable workflow's push job also passes
    // --commit (GITHUB_SHA), so it is "explicit" by this test. Discovery is
    // nonetheless inert there — the scan range is `<pushed commit>..<default
    // branch>`, which at push time is empty, so there is nothing to discover. The
    // guard below is the mechanical one the rule specifies; the empty-range
    // property is what makes it safe in practice.
    const commitExplicit = Object.prototype.hasOwnProperty.call(args, "commit");
    if (commitExplicit) {
      const defaultRef = resolveDefaultBranchRef({ explicit: args["default-branch"] });
      const scan = collectCorrectionCandidates({ targetSha: mergedSha, defaultRef });
      ctx.correctionDiscovery = true;
      ctx.targetSha = mergedSha;
      ctx.correctionCandidates = scan.candidates;
      ctx.correctionScan = { ...scan, defaultRef };
    }

    const prResolution = client
      ? resolveMergedPr({
        commitSha: mergedSha,
        message,
        declaredPr: args.pr,
        listPullsForCommit: (sha) => client.pullsForCommit(sha),
        getPr: (n) => client.pr(n),
      })
      : { number: null, pr: null, source: "none" };
    if (client && args.pr && prResolution.number === null) {
      apiSkippedReason = `the PR hint --pr ${args.pr} does not merge this commit (${String(mergedSha).slice(0, 8)}) and no PR could be bound to it authoritatively — anti-fabrication + tree-identity skipped rather than bound to the wrong PR`;
    }
    if (client && prResolution.number !== null) {
      try {
        const prNumber = prResolution.number;
        const pr = prResolution.pr;
        ctx.prAuthorLogin = pr.user?.login;
        ctx.reviews = client.listReviews(prNumber);
        // Reviewed head: the PR head at merge stays primary (an older approval
        // must never bless commits pushed after it); the LIVE approved heads
        // (state APPROVED — GitHub rewrites a dismissed review's state, so this
        // excludes dismissed ones) feed the tree-equality fallback below.
        ctx.approverLogins = [...new Set(ctx.reviews.filter((r) => r.state === "APPROVED").map((r) => r.user?.login).filter(Boolean))];
        ctx.permissionByLogin = {};
        for (const login of [...ctx.approverLogins, ...parseTrailers(message).reviewed.map((r) => r.login)]) {
          if (!login || ctx.permissionByLogin[login] !== undefined) continue;
          try { ctx.permissionByLogin[login] = client.permissionOf(login).permission; } catch { /* unknown */ }
        }
        // Reviewed head + the qualified live approvals (permissions resolved
        // above, so the peer-standing filter can be applied).
        const rh = resolveReviewedHead({
          prHeadSha: args["head-sha"] || pr.head?.sha,
          reviews: ctx.reviews,
          prAuthorLogin: ctx.prAuthorLogin,
          permissionByLogin: ctx.permissionByLogin,
        });
        ctx.reviewedHeadSha = rh.headSha;
        const authorization = parseTrailers(message).authorization;
        if (authorization) {
          // A deleted branch may require the immutable pull head ref for the
          // mechanical tree proof. This fetch cannot grant authorization.
          if (!hasCommitLocally(ctx.reviewedHeadSha)) fetchPrHeadRef(prNumber);
          ctx.delegation = verifyDelegatedReceipt({ repository: repo, pullRequest: prNumber, expectedHead: ctx.reviewedHeadSha,
            arm: "post-merge", record: authorization, mergedSha, mergeTree: mergedTreeOf });
        }
        ctx.approvedHeads = rh.approvedHeads;
        ctx.checkRuns = client.checkRunsFor(ctx.reviewedHeadSha);
        ctx.runWorkflow = makeRunWorkflowResolver(client);
        ctx.verifyGateArm = settlingVerifier(ctx.reviewedHeadSha);
        ctx.selfRunId = selfRunId;
        ctx.suiteFile = repoSuite;
        // Tree-identity bridge: local git first, GitHub commits-API fallback for
        // FORK heads (whose commit lives only on the contributor's fork and so is
        // unresolvable from this origin-only checkout). The resolved sha
        // is the SAME reviewed head SHA the anti-fabrication checks already bind
        // approvals/contexts to, and commitTree is bound to the gate's own repo
        // (a foreign sha 404s -> null -> fail-closed). false => tree-mismatch,
        // undefined (apiBound + arm) => tree-unverifiable — both preserved.
        ctx.treeMatch = resolveTreeMatch({ client, commit, reviewedHeadSha: ctx.reviewedHeadSha });
        // TREE-EQUALITY against the LIVE approvals: a squash whose tree is
        // byte-identical to a commit a non-dismissed APPROVED review was cast on
        // landed exactly the reviewed bytes, whatever the branch's intermediate
        // commit ids were. Same resolution path as the bridge above (local git
        // first, repo-bound commits API for heads this checkout cannot resolve).
        ctx.approvedTreeMatch = resolveApprovedTreeMatch({ client, commit, approvedHeads: ctx.approvedHeads });
        // §5 content binding (engineering#483): the content bridge + the record's
        // Reviewed-by staleness resolver, anchored at firstParent(M) (the on-main
        // base the squash landed on). contentMatch lets a landed change that
        // re-derives EQUAL to the reviewed change bind even when the tree differs
        // (a mechanical rebase / non-up-to-date merge) or is unresolvable (a fork
        // head); a differing change => content-mismatch. Fork / merge_group heads
        // need the ci#55 refetch to resolve locally, else undefined => fail closed
        // (the same posture as tree-unverifiable).
        ctx.contentMatch = resolveContentMatch({ commit, reviewedHeadSha: ctx.reviewedHeadSha });
        ctx.contentBinds = makeContentBinds({ anchor: firstParentOf(commit) });
        // check 5 (squash-correct): the PR's SOURCE commits via the API — NOT
        // the squash commit's first-parent diff (which is base→squash, not the
        // branch commits). Each API commit carries author/committer identity, so
        // a known-agent commit in the squashed range is detected even though it
        // never appears as its own commit on the default branch.
        const prCommits = client.prCommits(prNumber);
        ctx.rangeIdentities = (prCommits || []).map((c) => ({
          sha: c.sha,
          authorName: c.commit?.author?.name,
          authorEmail: c.commit?.author?.email,
          committerName: c.commit?.committer?.name,
          committerEmail: c.commit?.committer?.email,
          // also consider the GitHub-resolved login (a bot/app identity)
          ghAuthorLogin: c.author?.login,
          ghCommitterLogin: c.committer?.login,
          // §5c: the merge facts this payload already carries — a source commit
          // is not in this checkout after a squash, but its PARENTS (the branch
          // commit and the default-branch commit it merged) are.
          parents: (c.parents || []).map((p) => p && p.sha).filter(Boolean),
          tree: c.commit?.tree?.sha,
        }));
        // §7 MULTI-COMMIT REBASE LANDING (ci#94). A rebase merge lands the PR's
        // commits INDIVIDUALLY and reports the LAST of them as merge_commit_sha,
        // so the bindings above compare ONE landed commit's diff against the PR's
        // whole reviewed change — a content-mismatch by construction, on exactly
        // the shape the §5 Correction-for repair mechanism requires. When the
        // pushed commit is positively classified as the tip of a VERBATIM rebase
        // of the reviewed commits, the content bridge is retaken over the whole
        // landed range (base..tip) and each landed commit's own record is judged
        // per-commit inside analyzePostMerge. Anything unproven leaves the
        // single-commit binding exactly as it was (fail closed): the classifier
        // returns "single" and nothing below runs.
        // §5b: each class-identity source commit's own files + hunk lines, read
        // by the SAME REST road these identities came from (after a squash the
        // branch commits are not in this checkout at all).
        // The source commits' OWN messages, from the SAME payload: a commit that
        // names an agent is never exempted (see ctxCommitIsBump).
        ctx.messageBySha = ctx.messageBySha || {};
        for (const c of prCommits || []) { if (c && c.sha) ctx.messageBySha[c.sha] = c.commit?.message ?? ""; }
        for (const id of ctx.rangeIdentities) {
          if (!identityInBumpClass(id, ctx.bumpClass)) continue;
          const files = client.commitFiles(id.sha);
          ctx.commitDiffBySha[id.sha] = {
            changedFiles: (files || []).map((f) => f && f.filename).filter(Boolean),
            fileLines: bumpLinesFromApiFiles(files),
          };
        }
        // §5c: the clean-merge reading for each source commit that IS a merge —
        // the parents and tree from the payload above, the merge-tree from local
        // git. An object this checkout cannot read leaves the record unreadable,
        // which is not content-free (fail closed).
        ctx.mergeInfoBySha = ctx.mergeInfoBySha || {};
        // A squash landing leaves the source commits — and the branch-side parent
        // of a bring-up-to-date merge — outside this checkout, and the branch is
        // usually deleted with the merge. The pull request's own head ref still
        // carries them, so it is fetched ONCE, and only when a two-parent source
        // commit is actually unreadable here. A failed fetch changes nothing: the
        // merge-tree read fails and the merge is not content-free (fail closed).
        let prHeadFetched = false;
        for (const id of ctx.rangeIdentities) {
          try {
            const ps = (Array.isArray(id.parents) ? id.parents : []).filter(Boolean);
            if (ps.length === 2 && !ps.every((sha) => hasCommitLocally(sha)) && !prHeadFetched) {
              prHeadFetched = true;
              fetchPrHeadRef(prNumber);
            }
            const info = mergeInfoOf(id.sha, { parents: id.parents, tree: id.tree });
            if (info) ctx.mergeInfoBySha[id.sha] = info;
          } catch { /* not content-free */ }
        }
        const prCommitMessages = (prCommits || []).map((c) => c.commit?.message ?? "");
        const landing = classifyLandedShape({
          mergedSha,
          prMergeCommitSha: pr.merge_commit_sha,
          prCommitMessages,
          landedChain: collectLandedChain({ commit: mergedSha, depth: prCommitMessages.length + 1 }).chain,
        });
        if (landing.shape === "rebase") {
          ctx.landedRange = {
            ...landing,
            // Each landed commit's OWN first-parent diff: high-risk answers for
            // what that commit's record covers (the same set the §6 re-verify path
            // would compute for it), and the union across the landed set leaves no
            // changed path unjudged.
            commits: landing.commits.map((c) => ({ ...c, changedFiles: changedFilesForCommit(c.sha) })),
          };
          // §5b: each landed commit's own bump diff (local git — a rebase landing
          // put these commits on the default branch), for the per-commit check 5.
          for (const c of ctx.landedRange.commits) {
            if (c && c.sha && typeof c.message === "string") { (ctx.messageBySha = ctx.messageBySha || {})[c.sha] = c.message; }
            if (!identityInBumpClass(c, ctx.bumpClass)) continue;
            try { ctx.commitDiffBySha[c.sha] = { changedFiles: c.changedFiles, fileLines: commitDiffLines(c.sha) }; } catch { /* not a bump */ }
          }
          // §5c: and each landed commit's own merge facts, for the per-commit check 5.
          for (const c of ctx.landedRange.commits) {
            try { const info = mergeInfoOf(c.sha); if (info) ctx.mergeInfoBySha[c.sha] = info; } catch { /* not content-free */ }
          }
          ctx.contentMatch = resolveContentMatch({ commit: mergedSha, reviewedHeadSha: ctx.reviewedHeadSha, rangeBase: landing.base });
          // The staleness anchor moves with the binding: the on-main commit the
          // RANGE landed on, not the tip's own parent (which is itself a landed
          // commit of this very range).
          ctx.contentBinds = makeContentBinds({ anchor: landing.base });
        }
        ctx.apiBound = true;
      } catch (e) { apiSkippedReason = `GitHub API unavailable (${e.message}) — anti-fabrication checks skipped; record grammar/structure only`; ctx.apiBound = false; }
    } else {
      apiSkippedReason = apiSkippedReason || `no PR bound to this commit — anti-fabrication + tree-identity skipped; record grammar/structure only`;
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
    queueBinding,
    // §6: the landed correction whose record governed this verdict (re-verify
    // path only; null when the commit's own record was the record of truth).
    governedBy: result.governedBy || null,
    // §7: the landed shape this verdict was bound over — null on the squash and
    // single-commit paths (i.e. everything but a multi-commit rebase merge).
    landing: result.landing || null,
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
  // Machine-readable stdout stays one JSON document under Actions as well.
  const annotationStream = format === "json" ? process.stderr : process.stdout;
  for (const f of findings) annotate(f.severity === "error" ? "warning" : "notice", `truthful-attribution [${f.code}] ${f.message}`, annotationStream);
  if (apiSkippedReason) annotate("notice", `truthful-attribution: ${apiSkippedReason}`, annotationStream);
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
