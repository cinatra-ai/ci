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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
