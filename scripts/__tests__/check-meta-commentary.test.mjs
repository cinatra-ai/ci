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
