// Tests for the reusable meta-commentary gate engine (cinatra-ai/docs#119): the
// CLI driver against clean / violating / allowlisted docs-tree fixtures, and the
// OPTIONAL line-pinned allowlist semantics (live suppresses, expired does not,
// wrong-line snippet does not). Node builtins only.
//
// The gate uses `git ls-files` scoped to --docs, so it must run with cwd = the
// repo root (fixtures are tracked here); the child processes below set that cwd
// and pass repo-relative --docs paths, exactly as the self-check and the
// reusable workflow invoke it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CLI = join(REPO_ROOT, "scripts", "check-meta-commentary.mjs");

const CLEAN = "scripts/__fixtures__/meta-commentary/clean/docs";
const VIOLATING = "scripts/__fixtures__/meta-commentary/violating/docs";
const ALLOWLISTED = "scripts/__fixtures__/meta-commentary/allowlisted/docs";
const ALLOWLISTED_FILE = "scripts/__fixtures__/meta-commentary/allowlisted/docs/overview.md";
const ALLOWLISTED_LINE = "Cinatra treats your connected CRM as the canonical source of truth for contacts.";

function run(args) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function withAllowlist(entries, fn) {
  const dir = mkdtempSync(join(tmpdir(), "mcg-allow-"));
  const path = join(dir, "allow.json");
  writeFileSync(path, JSON.stringify({ entries }, null, 2));
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Core scan.

test("clean docs tree passes (exit 0)", () => {
  const { code, out } = run(["--docs", CLEAN]);
  assert.equal(code, 0, out);
  assert.match(out, /OK — 0 violations/);
});

test("violating docs tree fails (exit 1) and reports the offending patterns", () => {
  const { code, out } = run(["--docs", VIOLATING]);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL — \d+ violation/);
  // A representative spread of the meta-commentary patterns the fixture trips.
  for (const id of ["compiled_from", "canonical_source_label", "overwritten_next_sync", "do_not_hand_edit", "forthcoming", "todo_marker"]) {
    assert.match(out, new RegExp(`\\[${id}\\]`), `expected pattern ${id} in output`);
  }
});

test("a missing docs directory is a usage error (exit 2)", () => {
  const { code, out } = run(["--docs", "scripts/__fixtures__/meta-commentary/does-not-exist"]);
  assert.equal(code, 2, out);
  assert.match(out, /docs directory not found/);
});

test("an absent allowlist file is treated as empty (default path, no file present)", () => {
  // The repo ships no .github/meta-commentary-gate-allowlist.json, so the default
  // path resolves to a missing file — which must scan as an empty allowlist, not error.
  const { code } = run(["--docs", CLEAN]);
  assert.equal(code, 0);
});

test("a docs dir that exists but is outside the git work tree is a clean config error (exit 2), not a crash", () => {
  // Simulates a `git ls-files` failure (pathspec outside the repo): the guard
  // must surface it as exit 2 with a readable message, never an opaque stack trace.
  const outside = mkdtempSync(join(tmpdir(), "mcg-outside-"));
  try {
    const { code, out } = run(["--docs", outside]);
    assert.equal(code, 2, out);
    assert.match(out, /git ls-files failed/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Allowlist semantics.

test("a live allowlist entry pinned to the exact line suppresses that violation", () => {
  // Without an allowlist the single product-context "canonical source" match fails.
  assert.equal(run(["--docs", ALLOWLISTED]).code, 1);

  withAllowlist(
    [{
      file: ALLOWLISTED_FILE,
      pattern: "canonical_source_label",
      snippet: ALLOWLISTED_LINE,
      owner: "groganz",
      reviewBy: "2099-01-01",
      note: "Product content: CRM as system of record, not docs mechanics.",
    }],
    (allowPath) => {
      const { code, out } = run(["--docs", ALLOWLISTED, "--allowlist", allowPath]);
      assert.equal(code, 0, out);
      assert.match(out, /1 live entries/);
    }
  );
});

test("an EXPIRED allowlist entry (reviewBy in the past) stops suppressing", () => {
  withAllowlist(
    [{
      file: ALLOWLISTED_FILE,
      pattern: "canonical_source_label",
      snippet: ALLOWLISTED_LINE,
      owner: "groganz",
      reviewBy: "2000-01-01",
      note: "Product content: CRM as system of record, not docs mechanics.",
    }],
    (allowPath) => {
      const { code, out } = run(["--docs", ALLOWLISTED, "--allowlist", allowPath, "--now", "2026-07-22"]);
      assert.equal(code, 1, out);
      assert.match(out, /EXPIRED/);
    }
  );
});

test("an allowlist entry pinned to a DIFFERENT line does not suppress (line pinning)", () => {
  withAllowlist(
    [{
      file: ALLOWLISTED_FILE,
      pattern: "canonical_source_label",
      snippet: "Some other line that happens to mention the canonical source elsewhere.",
      owner: "groganz",
      reviewBy: "2099-01-01",
      note: "Wrong line — must not cover the real occurrence.",
    }],
    (allowPath) => {
      assert.equal(run(["--docs", ALLOWLISTED, "--allowlist", allowPath]).code, 1);
    }
  );
});

test("a present-but-unreadable allowlist path (a directory) is a config error, not silently empty (exit 2)", () => {
  // Only an ABSENT file means empty; pointing --allowlist at a directory is a
  // misconfiguration that must surface rather than be swallowed as "no exceptions".
  const { code, out } = run(["--docs", ALLOWLISTED, "--allowlist", "scripts"]);
  assert.equal(code, 2, out);
  assert.match(out, /not readable/);
});

test("a malformed allowlist entry (missing required key) is a config error (exit 2)", () => {
  withAllowlist(
    [{ file: ALLOWLISTED_FILE, pattern: "canonical_source_label" }],
    (allowPath) => {
      const { code, out } = run(["--docs", ALLOWLISTED, "--allowlist", allowPath]);
      assert.equal(code, 2, out);
      assert.match(out, /missing "snippet"|missing "owner"|missing "reviewBy"|missing "note"/);
    }
  );
});

// ---------------------------------------------------------------------------
// Multi-path mode (cinatra-ai/docs#156): --paths widens the scan to a
// configurable SET of directories and/or single Markdown files. --docs alone
// keeps the original single-directory scope — the multipath fixture pairs a
// clean docs/ tree with a violating sibling README.md, so the single-dir case
// passing here IS the proof that existing callers' scope is unchanged.

const MULTIPATH = "scripts/__fixtures__/meta-commentary/multipath";
const MULTIPATH_README = `${MULTIPATH}/README.md`;
const MULTIPATH_README_LINE = "This README is generated from the docs monorepo — edit it there, not here.";

test("single-dir mode does NOT scan a sibling README (existing callers pass unchanged)", () => {
  const { code, out } = run(["--docs", `${MULTIPATH}/docs`]);
  assert.equal(code, 0, out);
  assert.match(out, /OK — 0 violations/);
});

test("--paths catches the violating README next to a clean docs tree", () => {
  const { code, out } = run(["--paths", `${MULTIPATH}/docs,${MULTIPATH_README}`]);
  assert.equal(code, 1, out);
  assert.match(out, /\[generated_from\]/);
  assert.match(out, /multipath\/README\.md:3/);
});

test("--paths with only clean surfaces passes and names the configured paths", () => {
  const { code, out } = run(["--paths", `${MULTIPATH}/docs,${MULTIPATH}/CHANGELOG.md`]);
  assert.equal(code, 0, out);
  assert.match(out, /OK — 0 violations/);
  assert.match(out, /configured paths/);
});

test("a newline-separated --paths spec parses (the YAML block-scalar shape a caller passes)", () => {
  const { code, out } = run(["--paths", `${MULTIPATH}/docs\n${MULTIPATH}/CHANGELOG.md\n`]);
  assert.equal(code, 0, out);
});

test("a missing configured path is a config error (exit 2)", () => {
  const { code, out } = run(["--paths", `${MULTIPATH}/docs,${MULTIPATH}/does-not-exist.md`]);
  assert.equal(code, 2, out);
  assert.match(out, /configured path not found/);
});

test("a configured path with no tracked Markdown is a config error (exit 2), not a silent no-op", () => {
  const { code, out } = run(["--paths", `${MULTIPATH}/docs,package.json`]);
  assert.equal(code, 2, out);
  assert.match(out, /matched no tracked Markdown/);
});

test("overlapping --paths entries scan a file once (no duplicate violations)", () => {
  const { code, out } = run(["--paths", `${MULTIPATH_README},${MULTIPATH}`]);
  assert.equal(code, 1, out);
  const hits = out.match(/\[generated_from\]/g) ?? [];
  assert.equal(hits.length, 1, out);
});

test("the line-pinned allowlist works identically in multi-path mode (live entry suppresses)", () => {
  withAllowlist(
    [{
      file: MULTIPATH_README,
      pattern: "generated_from",
      snippet: MULTIPATH_README_LINE,
      owner: "groganz",
      reviewBy: "2099-01-01",
      note: "Fixture: proves allowlist parity in multi-path mode.",
    }],
    (allowPath) => {
      const { code, out } = run(["--paths", `${MULTIPATH}/docs,${MULTIPATH_README}`, "--allowlist", allowPath]);
      assert.equal(code, 0, out);
      assert.match(out, /1 live entries/);
    }
  );
});

test("an EXPIRED allowlist entry stops suppressing in multi-path mode too", () => {
  withAllowlist(
    [{
      file: MULTIPATH_README,
      pattern: "generated_from",
      snippet: MULTIPATH_README_LINE,
      owner: "groganz",
      reviewBy: "2000-01-01",
      note: "Fixture: expiry parity in multi-path mode.",
    }],
    (allowPath) => {
      const { code, out } = run([
        "--paths", `${MULTIPATH}/docs,${MULTIPATH_README}`,
        "--allowlist", allowPath,
        "--now", "2026-07-29",
      ]);
      assert.equal(code, 1, out);
      assert.match(out, /EXPIRED/);
    }
  );
});

test("a separator-only --paths spec is a config error (exit 2), never a silent fallback to --docs", () => {
  const { code, out } = run(["--paths", ",,  \n", "--docs", CLEAN]);
  assert.equal(code, 2, out);
  assert.match(out, /parsed to zero entries/);
});

test("a valueless trailing --paths is a config error (exit 2)", () => {
  const { code, out } = run(["--docs", CLEAN, "--paths"]);
  assert.equal(code, 2, out);
  assert.match(out, /parsed to zero entries/);
});

test("--paths takes precedence over an explicit --docs", () => {
  // --docs points at the clean tree, --paths at the violating README: the
  // violation must be reported, proving --paths won.
  const { code, out } = run(["--docs", CLEAN, "--paths", MULTIPATH_README]);
  assert.equal(code, 1, out);
  assert.match(out, /\[generated_from\]/);
});

test("a glob-looking --paths entry is treated literally, not expanded (exit 2)", () => {
  const { code, out } = run(["--paths", `${MULTIPATH}/*.md`]);
  assert.equal(code, 2, out);
  assert.match(out, /configured path not found/);
});

// ---------------------------------------------------------------------------
// docs#156 AC5 pattern classes: TRANSITION / in-flight narration, and PLANNING
// PROVENANCE (internal decision-process vocabulary in published prose). Both
// are precision-sensitive — "landed" and "ratified" are ordinary words — so
// every positive is paired with the negative prose the RULED OUT policy pins.

test("AC5 class 1: the staged-listing asset-production phrasings are caught (line-wrapped 'generated …ly from', 'never hand-edit')", () => {
  // The two evasions the docs#156 staged-listing sweep actually found:
  // "generated deterministically\nfrom the design system" (an adverb plus a
  // hard wrap between the two words) and "never hand-edit the PNGs" (a
  // negation the "do not" spelling missed). Ruling: those notes are REMOVED
  // from a published surface, so the pattern has to be able to see them.
  const { code, out } = run(["--docs", VIOLATING]);
  assert.equal(code, 1, out);
  assert.match(out, /\[generated_from\]/);
  // Two distinct do_not_hand_edit hits: the original "do not" line and the
  // "never hand-edit" line.
  assert.equal((out.match(/\[do_not_hand_edit\]/g) ?? []).length, 2, out);
});

test("AC5 class 1 rule-out: 'no need to hand-edit' is advisory product prose, not a production instruction", () => {
  const { code, out } = run(["--docs", CLEAN]);
  assert.equal(code, 0, out);
});

test("AC5 class 1 negatives: ordinary 'generated' and 'hand-edit' product prose stays green", () => {
  // "Reports are generated on demand" and "Records you hand-edit in Example"
  // are product behaviour, not production instructions — the widened spellings
  // must not reach them.
  const { code, out } = run(["--docs", CLEAN]);
  assert.equal(code, 0, out);
});

test("AC5 class 2 (transition/in-flight): every rephrased 'still landing' pattern trips the violating fixture", () => {
  const { code, out } = run(["--docs", VIOLATING]);
  assert.equal(code, 1, out);
  for (const id of ["still_landing", "not_yet_landed", "landing_separately"]) {
    assert.match(out, new RegExp(`\\[${id}\\]`), `expected transition pattern ${id} in output`);
  }
  // Both landing_separately spellings: the bare adverb and the lifecycle-noun
  // form ("landing in a later release").
  assert.equal((out.match(/\[landing_separately\]/g) ?? []).length, 2, out);
});

test("AC5 precision: the dropped transition candidates and the runtime-object phrasings stay green", () => {
  // "yet to land" and "still in flight" were rejected as patterns (commoner in
  // runtime prose than roadmap prose) and "landing in a separate bucket" lacks
  // the required lifecycle noun. The clean fixture carries all three.
  const { code, out } = run(["--docs", CLEAN]);
  assert.equal(code, 0, out);
});

test("AC5 precision: proximity alone is not a planning-provenance violation", () => {
  // "See issue #123 for troubleshooting. If the webhook has not landed after
  // five minutes, retry it." and its reverse are in the clean fixture: a
  // work-item number and the word "landed" on one line must NOT fail without
  // the explicit binding relation.
  const { code, out } = run(["--docs", CLEAN]);
  assert.equal(code, 0, out);
});

test("AC5 precision: external-standards ratification, decision compounds, and list markers stay green", () => {
  // The round-3 precision set, all in the clean fixture: "only ratified
  // algorithms run in FIPS mode", the same claim across a hard wrap
  // ("algorithms ratified\nby NIST"), "following the decision returned by the
  // policy engine" (no finite compound blacklist can cover that — the pattern
  // requires the reference to TERMINATE), and adjacent "+" / "1)" list items,
  // which the "-"/"*"-only wrap guard would have joined.
  const { code, out } = run(["--docs", CLEAN]);
  assert.equal(code, 0, out);
});

test("AC5 precision: external-standards ratification and 'the decision tree' stay green", () => {
  // "the ratified W3C proposal", "the security policy was ratified by the
  // standards committee", "following the decision tree", and two adjacent
  // bullets ("Access is ratified by administrators" / "Policy changes are
  // logged") that a newline-crossing gap would otherwise join.
  const { code, out } = run(["--docs", CLEAN]);
  assert.equal(code, 0, out);
});

test("AC5 class 3 (planning provenance): work-item history and decision vocabulary trip the violating fixture", () => {
  const { code, out } = run(["--docs", VIOLATING]);
  assert.equal(code, 1, out);
  for (const id of [
    "planning_workitem_landed",
    "planning_landed_workitem",
    "ratified_decision_vocab",
    "decision_was_ratified",
    "ruling_reference",
  ]) {
    assert.match(out, new RegExp(`\\[${id}\\]`), `expected planning-provenance pattern ${id} in output`);
  }
  // Both relating-preposition spellings ("shipped under epic #N", "landed with
  // issue #N") and both ruling spellings ("per the ruling", "per the owner
  // ruling <date>").
  assert.equal((out.match(/\[planning_landed_workitem\]/g) ?? []).length, 2, out);
  assert.equal((out.match(/\[ruling_reference\]/g) ?? []).length, 2, out);
  // Three forward-form spellings: the Markdown-linked reference, "Epic #123 was
  // implemented", and "Epic #456, which was merged".
  assert.equal((out.match(/\[planning_workitem_landed\]/g) ?? []).length, 3, out);
});

test("AC5 patterns are linear on adversarial input (no catastrophic backtracking)", () => {
  // The planning-provenance patterns chain several optional groups; unbounded
  // `\s*` runs between them backtrack quadratically. Every gap is a bounded
  // space/tab run, so a 200k-space payload must complete in milliseconds.
  const src = readFileSync(join(REPO_ROOT, "scripts", "check-meta-commentary.mjs"), "utf8");
  const i = src.indexOf("const PATTERNS = [");
  const j = src.indexOf("\n];", i) + 3;
  // Reads the gate's OWN list so this guard cannot drift from it.
  const patterns = (0, eval)(src.slice(i, j).replace("const PATTERNS =", "").replace(/;\s*$/, ""));
  for (const payload of [`epic #1${" ".repeat(200_000)}x`, `landed in epic #1${" ".repeat(200_000)}x`]) {
    const started = Date.now();
    for (const [, rx] of patterns) new RegExp(rx.source, "gi").exec(payload);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `pattern scan took ${elapsed}ms on a 200k-space payload`);
  }
});

test("AC5 class 3: the ratified/mode match survives a hard wrap between the two words", () => {
  // The real docs instance is "the ratified **claim-only**\nmode" — the gap
  // must cross one wrap, and the fixture reproduces the wrap exactly.
  const { code, out } = run(["--docs", VIOLATING]);
  assert.equal(code, 1, out);
  assert.match(out, /\[ratified_decision_vocab\]/);
});

test("AC5 negatives: ordinary product prose using land/landed/ratified/not-yet stays green", () => {
  // The clean fixture carries the sentences a broader pattern would have
  // failed — "tells you when it lands", "if you are landing here", "an approval
  // landed", "the ratified OAuth 2.1 specification", "not yet supported", a
  // bare issue link, "per the settings". Green here IS the precision proof.
  const { code, out } = run(["--docs", CLEAN]);
  assert.equal(code, 0, out);
  assert.match(out, /OK — 0 violations/);
});

test("AC5 ruling: released-version history in a CHANGELOG (non-guide context) is OUT of the class", () => {
  // "Streaming support landed in 1.1" names a version a reader can install,
  // not an internal work item — deliberately not a violation. Scanned in
  // multi-path mode, which is how a caller covers a CHANGELOG at all.
  const { code, out } = run(["--paths", `${MULTIPATH}/CHANGELOG.md`]);
  assert.equal(code, 0, out);
  assert.match(out, /OK — 0 violations/);
});

// ---------------------------------------------------------------------------
// docs#160 AC4: the REPO-QUALIFIED work-item citation class, and the narrowed
// rule-out on the bare `#123` form it replaces. Precision here is structural —
// the pattern must separate a citation from a file anchor, a heading slug, a
// palette entry and a bare cross-reference — so every positive is paired with
// the negative the rule-out pins.

const CITATION_CLEAN = "scripts/__fixtures__/meta-commentary/html-clean/docs";
const CITATION_VIOLATING = "scripts/__fixtures__/meta-commentary/html-violating/docs";

test("AC4 class: repo-qualified work-item citations, criteria and numbered rulings fire", () => {
  const { code, out } = run(["--docs", CITATION_VIOLATING]);
  assert.equal(code, 1, out);
  for (const id of [
    "qualified_workitem_citation",
    "acceptance_criterion_citation",
    "numbered_ruling_citation",
    "publish_decision",
    "spec_status_annotation",
    "design_note_annotation",
    "owner_gated_publish",
  ]) {
    assert.match(out, new RegExp(`\\[${id}\\]`), `expected docs#160 pattern ${id} in output`);
  }
  // Both spellings of the citation: bare-repo and org/repo-qualified.
  assert.match(out, /qualified_workitem_citation\] matched[^\n]*"cinatra#1607"/);
  assert.match(out, /qualified_workitem_citation\] matched[^\n]*"cinatra-ai\/cinatra#1795"/);
});

test("AC4 precision: a display label beside a run number is not a citation", () => {
  // The real false positive this narrowing came from: a published components
  // page renders an agent-run cell as two adjacent inline spans, and inline
  // tags are transparent, so `Outreach` + `#2,318` arrives as one token.
  const { code, out } = run(["--docs", CITATION_CLEAN]);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /Outreach#/, out);
});

test("AC4 rule-out preserved: a bare #123, a file anchor and a heading slug stay green", () => {
  // The clean HTML fixture carries "See issue #123 for troubleshooting",
  // `overview.md#12`, `setup.html#3-install`, `0xAC12` and a `#1607` palette
  // entry. Green here IS the proof that narrowing the docs#156 rule-out to the
  // qualified form did not widen it to the bare form.
  const { code, out } = run(["--docs", CITATION_CLEAN]);
  assert.equal(code, 0, out);
});

// ---------------------------------------------------------------------------
// docs#160 AC12: the boundary regression guard. The exemption of an
// implementation-facing tree comes from EXACT PATH SELECTION and nothing else —
// the engine must never learn a semantic notion of an "internal" tree.

const GUARD = "scripts/__fixtures__/meta-commentary/boundary-guard";

test("AC12: a caller configured with only README.md + CHANGELOG.md is green despite a planted docs/** violation", () => {
  const { code, out } = run(["--paths", `${GUARD}/README.md,${GUARD}/CHANGELOG.md`]);
  assert.equal(code, 0, out);
  assert.match(out, /OK — 0 violations/);
});

test("AC12: the planted docs/** tree is never SELECTED, therefore never read", () => {
  // --print-files prints the exact read set. The engine opens only files in that
  // set, so a path absent from it is a path never opened.
  const { code, out } = run(["--print-files", "--paths", `${GUARD}/README.md,${GUARD}/CHANGELOG.md`]);
  assert.equal(code, 0, out);
  const selected = [...out.matchAll(/selected: (.+)/g)].map((m) => m[1].trim());
  assert.deepEqual(selected, [`${GUARD}/README.md`, `${GUARD}/CHANGELOG.md`]);
  assert.equal(selected.some((f) => f.includes("/docs/")), false, out);
});

test("AC12: the same planted tree IS red the moment a caller selects it (the guard is not vacuous)", () => {
  // Without this, a guard that passed because the fixture had no violation would
  // look identical to one that passed because path selection worked.
  const { code, out } = run(["--docs", `${GUARD}/docs`]);
  assert.equal(code, 1, out);
  assert.match(out, /internals\.md:\d+\s+\[compiled_from\]/, out);
  assert.match(out, /internals\.html:\d+\s+\[qualified_workitem_citation\]/, out);
});

test("AC12: read-proof — the planted tree stays unread even when it is unreadable", () => {
  // A stronger form of the claim above: make the planted files impossible to
  // read, and the configured run must still be green. If selection ever leaked
  // into the read set, this would throw instead. Skipped for root (which
  // bypasses the permission bits) and on platforms without POSIX modes.
  if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
    return;
  }
  const planted = [
    join(REPO_ROOT, GUARD, "docs", "internals.md"),
    join(REPO_ROOT, GUARD, "docs", "internals.html"),
  ];
  const modes = planted.map((p) => statSync(p).mode);
  try {
    for (const p of planted) chmodSync(p, 0o000);
    // Sanity: the tree really is unreadable now.
    assert.throws(() => readFileSync(planted[0], "utf8"));
    const { code, out } = run(["--paths", `${GUARD}/README.md,${GUARD}/CHANGELOG.md`]);
    assert.equal(code, 0, out);
  } finally {
    planted.forEach((p, i) => chmodSync(p, modes[i]));
  }
});
