// Regression lock for the diff-base resolver shared by the working-tree gates
// (source-leak and skills-drift). The resolver is the SINGLE source of
// truth for the base a gate diffs HEAD against; the reusable workflows invoke
// scripts/resolve-diff-base.sh verbatim, so proving it here proves what ships.
//
// The bug this closes: a GitHub merge-queue candidate runs the required gates
// under the `merge_group` event, whose payload has NEITHER `pull_request` NOR
// `before`. The prior inline logic resolved an EMPTY base on merge_group, so the
// gate silently full-scanned the synthetic candidate instead of diffing the
// incremental change — losing ratchet-line semantics on the very commit that
// decides the merge. These tests pin the merge_group arm AND lock the
// pull_request/push arms to their prior byte-for-byte behaviour (no weakening),
// and prove the resolver never shell-interprets an attacker-influenceable ref.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const RESOLVE = path.join(HERE, "..", "resolve-diff-base.sh");
// Temp dir lives under the lane scratch dir, never /tmp (sandbox + memory rule).
const SCRATCH = path.join(HERE, "..", "..", ".claude", "scratch", "resolve-diff-base-test");

const ZERO = "0".repeat(40);

// Invoke the resolver with an EXPLICIT env (spawn does not inherit process.env,
// so an ambient PR_BASE_REF/EVENT_BEFORE cannot leak into a case), and return
// stdout verbatim (callers assert the exact bytes incl. the trailing newline).
function resolve(env, opts = {}) {
  const r = spawnSync("bash", [RESOLVE], { env: env ?? {}, encoding: "utf8", cwd: opts.cwd });
  assert.equal(r.status, 0, `resolver exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

test("pull_request: PR_BASE_REF => origin/<base.ref>", () => {
  assert.equal(resolve({ PR_BASE_REF: "main", EVENT_NAME: "pull_request" }), "origin/main\n");
  assert.equal(resolve({ PR_BASE_REF: "release/v2", EVENT_NAME: "pull_request" }), "origin/release/v2\n");
});

test("merge_group: MG_BASE_SHA => the base_sha verbatim (the NEW arm)", () => {
  const sha = "a".repeat(40);
  assert.equal(resolve({ MG_BASE_SHA: sha, EVENT_NAME: "merge_group" }), `${sha}\n`);
});

test("merge_group: an all-zero MG_BASE_SHA falls through to empty (fail-safe full scan)", () => {
  assert.equal(resolve({ MG_BASE_SHA: ZERO, EVENT_NAME: "merge_group" }), "\n");
});

test("push: EVENT_BEFORE (a real ancestor SHA) => the before SHA verbatim", () => {
  const sha = "b".repeat(40);
  assert.equal(resolve({ EVENT_BEFORE: sha, EVENT_NAME: "push" }), `${sha}\n`);
});

test("push: an all-zero EVENT_BEFORE (branch-create) => empty", () => {
  assert.equal(resolve({ EVENT_BEFORE: ZERO, EVENT_NAME: "push" }), "\n");
});

test("no context at all => empty base (full-tree scan)", () => {
  assert.equal(resolve({ EVENT_NAME: "schedule" }), "\n");
  assert.equal(resolve({}), "\n");
});

test("precedence is deterministic even if arms impossibly overlap", () => {
  const mg = "c".repeat(40);
  const before = "d".repeat(40);
  // pull_request wins over everything.
  assert.equal(resolve({ PR_BASE_REF: "main", MG_BASE_SHA: mg, EVENT_BEFORE: before }), "origin/main\n");
  // merge_group wins over push.
  assert.equal(resolve({ MG_BASE_SHA: mg, EVENT_BEFORE: before }), `${mg}\n`);
});

test("an attacker-influenceable ref is NEVER shell-interpreted (env-only, no injection)", () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  const marker = path.join(SCRATCH, "pwned");
  // A branch name crafted to break out of a shell line if it were interpolated.
  const evil = `main;touch ${marker};echo `;
  const out = resolve({ PR_BASE_REF: evil }, { cwd: SCRATCH });
  // Echoed literally as a single value; the metacharacters are inert data.
  assert.equal(out, `origin/${evil}\n`);
  assert.equal(fs.existsSync(marker), false, "the injected `touch` must NOT have run");
  // And via the merge_group arm too.
  const evil2 = `$(touch ${marker})`;
  const out2 = resolve({ MG_BASE_SHA: evil2 }, { cwd: SCRATCH });
  assert.equal(out2, `${evil2}\n`);
  assert.equal(fs.existsSync(marker), false, "command substitution must NOT have run");
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});
