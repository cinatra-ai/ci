// Tests for the HTML arm of the meta-commentary gate engine (cinatra-ai/docs#160).
//
// Two halves, and both are the gate:
//   - the EXTRACTION CONTRACT (scripts/lib/html-text.mjs) — one positive and one
//     negative fixture for every construct the contract decides explicitly:
//     visible text, comments, attributes (human-readable vs machine),
//     <script>/<style>, entity decoding, an inline-tag boundary, a hard wrap,
//     and a block boundary that must NOT be joined;
//   - the SOURCE-FIDELITY guarantee — a violation found in extracted prose is
//     reported at the line of the real source file, which is also what the
//     line-pinned allowlist keys on.
//
// Node builtins only. The gate uses `git ls-files`, so the child processes run
// with cwd = the repo root and pass repo-relative paths, exactly as the
// self-check and the reusable workflow invoke it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractHtmlText } from "../lib/html-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CLI = join(REPO_ROOT, "scripts", "check-meta-commentary.mjs");

const HTML_CLEAN = "scripts/__fixtures__/meta-commentary/html-clean/docs";
const HTML_VIOLATING = "scripts/__fixtures__/meta-commentary/html-violating/docs";
const HTML_VIOLATING_FILE = `${HTML_VIOLATING}/reference.html`;

function run(args) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function withAllowlist(entries, fn) {
  const dir = mkdtempSync(join(tmpdir(), "mcg-html-allow-"));
  const path = join(dir, "allow.json");
  writeFileSync(path, JSON.stringify({ entries }, null, 2));
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every [id, sourceLine] the violating HTML fixture is built to trip, one per
// enforced construct/class. Line numbers are asserted too: a violation that
// cannot be located in the source is not actionable.
const EXPECTED_HTML_VIOLATIONS = [
  ["compiled_from", 6], // <meta name="description"> — a human-readable attribute
  ["design_note_annotation", 10], // an HTML comment
  ["canonical_source_label", 15], // a plain visible text node
  ["generated_from", 18], // split by an inline <b> — the tag is transparent
  ["generated_from", 21], // wrapped mid-sentence inside one text node
  ["compiled_from", 25], // written with a named entity (&nbsp;)
  ["canonical_source_label", 26], // written with a numeric entity (&#32;)
  ["published_from", 29], // an alt="" attribute
  ["coming_soon", 30], // a title="" attribute
  ["still_landing", 30], // an aria-label="" attribute
  ["publish_decision", 42],
  ["qualified_workitem_citation", 42],
  ["acceptance_criterion_citation", 42],
  ["qualified_workitem_citation", 43], // the org/repo-qualified spelling
  ["numbered_ruling_citation", 44],
  ["spec_status_annotation", 49],
  ["owner_gated_publish", 50],
];

// ---------------------------------------------------------------------------
// End-to-end: the gate over HTML fixtures.

test("HTML pages are scanned: the violating fixture fails and names every construct", () => {
  const { code, out } = run(["--docs", HTML_VIOLATING]);
  assert.equal(code, 1, out);
  for (const [id, line] of EXPECTED_HTML_VIOLATIONS) {
    assert.match(
      out,
      new RegExp(`reference\\.html:${line}\\s+\\[${id}\\]`),
      `expected ${id} at source line ${line}\n${out}`
    );
  }
});

test("the benign HTML twin of every construct stays green", () => {
  // <script> and <style> bodies, machine attributes (class/id/data-*/style/href),
  // file and heading anchors, a bare "#123", "0xAC12", ordinary product prose,
  // and adjacent blocks that must not be joined — all in one clean fixture.
  const { code, out } = run(["--docs", HTML_CLEAN]);
  assert.equal(code, 0, out);
  assert.match(out, /OK — 0 violations/);
});

test("HTML violations are reported in source order, deterministically", () => {
  const { out } = run(["--docs", HTML_VIOLATING]);
  const lines = [...out.matchAll(/reference\.html:(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(lines.length > 0, out);
  const sorted = [...lines].sort((a, b) => a - b);
  assert.deepEqual(lines, sorted, `violations were not in source order: ${lines.join(",")}`);
});

test("the line-pinned allowlist keys on the SOURCE line of an HTML page", () => {
  // The allowlist snippet is the full trimmed SOURCE line — the raw markup —
  // not the extracted prose. Pinning on the source is what makes an exception
  // reviewable against the file a human opens.
  const source = readFileSync(join(REPO_ROOT, HTML_VIOLATING_FILE), "utf8");
  const sourceLine = source.split("\n")[25 - 1].trim(); // the &nbsp; line
  assert.match(sourceLine, /compiled&nbsp;from/);

  withAllowlist(
    [{
      file: HTML_VIOLATING_FILE,
      pattern: "compiled_from",
      snippet: sourceLine,
      owner: "groganz",
      reviewBy: "2099-01-01",
      note: "Fixture: proves HTML allowlist entries pin to the raw source line.",
    }],
    (allowPath) => {
      const { out } = run(["--docs", HTML_VIOLATING, "--allowlist", allowPath]);
      assert.doesNotMatch(out, /reference\.html:25\s+\[compiled_from\]/, out);
      // The other occurrences of the same pattern id are untouched.
      assert.match(out, /reference\.html:15\s+\[compiled_from\]/, out);
    }
  );
});

test("an HTML allowlist entry pinned to the extracted prose (not the source line) does NOT suppress", () => {
  withAllowlist(
    [{
      file: HTML_VIOLATING_FILE,
      pattern: "compiled_from",
      snippet: "The chapter body is compiled from the upstream repository.",
      owner: "groganz",
      reviewBy: "2099-01-01",
      note: "Wrong key: the extracted text, not the source line.",
    }],
    (allowPath) => {
      const { code, out } = run(["--docs", HTML_VIOLATING, "--allowlist", allowPath]);
      assert.equal(code, 1, out);
      assert.match(out, /reference\.html:25\s+\[compiled_from\]/, out);
    }
  );
});

// ---------------------------------------------------------------------------
// The extraction contract itself, unit level. Each case is one documented
// decision; a change to the contract must change a test here.

function extract(html) {
  return extractHtmlText(html).text;
}

test("contract: visible text is in scope; script and style bodies are not", () => {
  assert.match(extract("<p>compiled from the kit</p>"), /compiled from the kit/);
  assert.doesNotMatch(extract("<script>// compiled from the kit</script>"), /compiled from/);
  assert.doesNotMatch(extract('<style>.a{content:"compiled from"}</style>'), /compiled from/);
  // The closing tag may carry whitespace, and the element may span lines.
  assert.doesNotMatch(extract("<script>\ncompiled from\n</script  >"), /compiled from/);
});

test("contract: an unterminated script swallows the rest of the document rather than leaking its body", () => {
  assert.doesNotMatch(extract("<script>compiled from the kit"), /compiled from/);
});

test("contract: HTML comments are in scope", () => {
  assert.match(extract("<!-- design note, outside the page mock -->"), /design note/);
});

test("contract: human-readable attributes are in scope, machine attributes are not", () => {
  assert.match(extract('<img alt="published from the deck">'), /published from/);
  assert.match(extract('<b title="coming soon">x</b>'), /coming soon/);
  assert.match(extract('<b aria-label="still landing">x</b>'), /still landing/);
  assert.match(extract('<meta name="description" content="compiled from the kit">'), /compiled from/);

  assert.doesNotMatch(extract('<div class="compiled from"></div>'), /compiled from/);
  assert.doesNotMatch(extract('<div id="compiled-from" data-x="compiled from"></div>'), /compiled from/);
  assert.doesNotMatch(extract('<div style="--x:\'compiled from\'"></div>'), /compiled from/);
  assert.doesNotMatch(extract('<a href="/x?q=compiled from">y</a>'), /compiled from/);
  // `content` is only prose on a description/keywords meta, never elsewhere.
  assert.doesNotMatch(extract('<meta name="viewport" content="compiled from">'), /compiled from/);
});

test("contract: entities are decoded before matching, and nbsp becomes a plain space", () => {
  assert.match(extract("<p>compiled&nbsp;from</p>"), /compiled from/);
  assert.match(extract("<p>canonical&#32;source</p>"), /canonical source/);
  assert.match(extract("<p>canonical&#x20;source</p>"), /canonical source/);
  assert.match(extract("<p>compiled&#160;from</p>"), /compiled from/);
  assert.equal(extract("<p>a&amp;b</p>").includes("a&b"), true);
  // An unknown entity is left literal rather than dropped.
  assert.match(extract("<p>a&notarealentity;b</p>"), /&notarealentity;/);
  // A stray "&" that is not an entity is untouched.
  assert.match(extract("<p>Q &amp A</p>"), /Q &amp A/);
});

test("contract: inline tags are transparent, block tags are a hard separator", () => {
  assert.match(extract("<p>this page is <b>compiled</b> from the kit</p>"), /is compiled from the kit/);
  // Two blocks must never be joined into one phrase: the separator is a double
  // newline, and every pattern gap tolerates at most one.
  const blocks = extract("<li>ratified</li>\n<li>mode</li>");
  assert.doesNotMatch(blocks, /ratified[ \t]*\r?\n[ \t]*mode/);
  assert.match(blocks, /ratified[\s\S]*mode/);
});

test("contract: a hard wrap inside one text node is preserved verbatim", () => {
  assert.match(
    extract("<p>generated deterministically\n   from the kit</p>"),
    /generated deterministically\n\s*from the kit/
  );
});

test("contract: a literal '<' in prose is not mistaken for a tag", () => {
  assert.match(extract("<p>if a < b then compiled from applies</p>"), /compiled from/);
  assert.match(extract("<p>3 < 4</p>"), /3 < 4/);
});

test("contract: every extracted character maps to a real source offset", () => {
  const html = readFileSync(join(REPO_ROOT, HTML_VIOLATING_FILE), "utf8");
  const { text, map } = extractHtmlText(html);
  assert.equal(text.length, map.length);
  for (const idx of map) {
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx <= html.length, `bad source index ${idx}`);
  }
  // The map is monotonically non-decreasing: extraction never reorders the page.
  for (let i = 1; i < map.length; i++) {
    assert.ok(map[i] >= map[i - 1], `map went backwards at ${i}: ${map[i - 1]} -> ${map[i]}`);
  }
});

test("contract: extraction is linear on a large page (no quadratic scan)", () => {
  const page = `<html><body>${"<p>Ordinary product prose about widgets.</p>\n".repeat(20_000)}</body></html>`;
  const started = Date.now();
  extractHtmlText(page);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `extraction took ${elapsed}ms on a ${page.length}-byte page`);
});
