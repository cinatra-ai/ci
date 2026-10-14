// Regression lock for the secret-scan-gate's fail-open on scan errors.
//
// The bug: every TruffleHog engine tested (3.95.5 to 3.99.2) logs an error and exits 0 when the
// --since-commit base or the --branch head does not resolve, unless --fail-on-scan-errors is passed.
// The gate did not pass it, so an unresolvable range scanned 0 chunks and the required check was
// green. On push that happens on every force-push (the `before` commit is in no fetched ref) and,
// for callers that pass `github.event.before`, on the first push (an all-zero `before`).
//
// The fix has two parts, both pinned here:
//   1. the TruffleHog step passes --fail-on-scan-errors, so a scan error fails the check;
//   2. a "Resolve scan range" step (id `range`) decides the range per event, so the flag does not
//      turn a legitimate force-push or first push red:
//        - pull_request / pull_request_target / merge_group: base and head must resolve (a missing
//          commit is fetched once by SHA); otherwise the step fails. Never a silent pass.
//        - push: all-zero or empty `before` => a logged full-history scan of the pushed head;
//          a force-push => scan from merge-base(before, head) when `before` can be fetched by SHA,
//          else a logged full-history scan; a rewind to an ancestor or a ref deletion => a logged
//          notice and no scan (nothing new was pushed).
//        - any other event without a base => a logged full-history scan of the head.
// The behavioural tests run the step's `run:` block from the workflow file itself, so they test
// what ships.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { load } from "../lib/vendor/js-yaml/js-yaml.mjs";

const HERE = import.meta.dirname;
const WORKFLOW = path.join(HERE, "..", "..", ".github", "workflows", "secret-scan-gate.yml");
// Temp dir lives under the lane scratch dir, never /tmp (sandbox + memory rule).
const SCRATCH = path.join(HERE, "..", "..", ".claude", "scratch", "secret-scan-scan-errors-test");
const ZERO = "0".repeat(40);
const ABSENT = "0123456789abcdef0123456789abcdef01234567";

after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

function steps() {
  const wf = load(fs.readFileSync(WORKFLOW, "utf8"));
  return wf.jobs["secret-scan-gate"].steps;
}
const scanIndex = s => s.findIndex(x => typeof x.uses === "string" && x.uses.startsWith("trufflesecurity/trufflehog@"));
const rangeIndex = s => s.findIndex(x => x.id === "range");

// ---------------------------------------------------------------- static: the workflow wiring

test("the TruffleHog step passes --fail-on-scan-errors (a scan error must fail the check)", () => {
  const s = steps();
  const scan = s[scanIndex(s)];
  assert.ok(scan, "no trufflesecurity/trufflehog step");
  const args = String(scan.with.extra_args).split(/\s+/);
  assert.ok(args.includes("--fail-on-scan-errors"),
    `extra_args ${JSON.stringify(scan.with.extra_args)} lacks --fail-on-scan-errors: an unresolvable base or head exits 0`);
  assert.ok(args.includes("--results=verified,unknown"), "the result filter changed");
});

test("the TruffleHog step scans the resolved range, never the raw inputs", () => {
  const s = steps();
  const scan = s[scanIndex(s)];
  assert.equal(scan.with.base, "${{ steps.range.outputs.base }}");
  assert.equal(scan.with.head, "${{ steps.range.outputs.head }}");
  // Only an explicit `none` skips the scan; a missing or unexpected mode still scans (fail-closed).
  assert.equal(scan.if, "steps.range.outputs.mode != 'none'");
});

test("the range step runs after the full-history checkout and before the scan, reading the event only through env", () => {
  const s = steps();
  const r = rangeIndex(s);
  assert.ok(r >= 0, "no step with id `range`");
  assert.ok(r < scanIndex(s), "the range step must run before the scan");
  const checkout = s.findIndex(x => typeof x.uses === "string" && x.uses.startsWith("actions/checkout@"));
  assert.ok(checkout >= 0 && checkout < r, "the range step must run after the checkout");
  assert.equal(s[checkout].with["fetch-depth"], 0, "the checkout must keep full history");
  assert.equal(s[r].shell, "bash");
  assert.ok(!s[r].run.includes("${{"), "the run block must not interpolate expressions (injection); use env");
  const env = s[r].env;
  assert.equal(env.EVENT_NAME, "${{ github.event_name }}");
  assert.equal(env.IN_BASE, "${{ inputs.base_sha }}");
  assert.equal(env.IN_HEAD, "${{ inputs.head_sha }}");
  assert.equal(env.PR_BASE, "${{ github.event.pull_request.base.sha }}");
  assert.equal(env.PR_HEAD, "${{ github.event.pull_request.head.sha }}");
  assert.equal(env.MG_BASE, "${{ github.event.merge_group.base_sha }}");
  assert.equal(env.MG_HEAD, "${{ github.event.merge_group.head_sha }}");
  assert.equal(env.PUSH_BEFORE, "${{ github.event.before }}");
  assert.equal(env.PUSH_AFTER, "${{ github.event.after }}");
});

// ---------------------------------------------------------------- behaviour: the run block itself

const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
let n = 0;
function commit(cwd, file, text) {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", `c${++n}`, "--date", `2026-01-0${(n % 9) + 1}T00:00:00Z`);
  return git(cwd, "rev-parse", "HEAD");
}

// Origin main: c1 - c2 (old tip). Force-push rewrites main to c1 - c4 - c5. A fork-style head (c6) is
// only on refs/pull/1/head. The runner clone (as actions/checkout with fetch-depth: 0) has c1, c4, c5
// only. `served` keeps the force-pushed-away tip and answers a want for it by SHA (as GitHub does);
// `pruned` has garbage-collected it, so it cannot be fetched at all.
function fixture() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "repo-")));
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  const c1 = commit(work, "a.txt", "a\n");
  const c2 = commit(work, "b.txt", "b\n");
  const origins = {};
  for (const name of ["served", "pruned"]) {
    const o = path.join(dir, `${name}.git`);
    git(dir, "init", "-q", "--bare", "-b", "main", o);
    git(work, "push", "-q", o, "main");
    origins[name] = o;
  }
  git(work, "reset", "-q", "--hard", c1);
  const c4 = commit(work, "c.txt", "c\n");
  const c5 = commit(work, "d.txt", "d\n");
  git(work, "checkout", "-q", "-b", "fork");
  const c6 = commit(work, "e.txt", "e\n");
  for (const o of Object.values(origins)) {
    git(work, "push", "-q", "-f", o, `${c5}:refs/heads/main`);
    git(work, "push", "-q", "-f", o, `${c6}:refs/pull/1/head`);
  }
  git(origins.served, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(origins.pruned, "reflog", "expire", "--expire=now", "--all");
  git(origins.pruned, "gc", "-q", "--prune=now");
  assert.throws(() => git(origins.pruned, "cat-file", "-e", `${c2}^{commit}`), "old tip must be pruned from `pruned`");
  const clones = {};
  for (const [name, o] of Object.entries(origins)) {
    clones[name] = path.join(dir, `clone-${name}`);
    git(dir, "clone", "-q", "--no-local", o, clones[name]);
    assert.throws(() => git(clones[name], "cat-file", "-e", `${c2}^{commit}`), "old tip must be absent from the clone");
    assert.throws(() => git(clones[name], "cat-file", "-e", `${c6}^{commit}`), "fork head must be absent from the clone");
  }
  return { dir, c1, c2, c4, c5, c6, clones };
}
const F = fixture();

const RUN = (() => {
  const s = steps();
  return s[rangeIndex(s)]?.run;
})();

// Run the range step in a fresh clone (fetches are side effects) and return its outputs.
function resolve(env, { origin = "pruned" } = {}) {
  const clone = fs.mkdtempSync(path.join(F.dir, "run-"));
  git(F.dir, "clone", "-q", "--no-local", path.join(F.dir, `${origin}.git`), clone);
  const out = path.join(clone, ".gh-output");
  fs.writeFileSync(out, "");
  const script = path.join(F.dir, "range-step.sh");
  fs.writeFileSync(script, RUN ?? "echo '::error::no range step'; exit 97\n");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd: clone,
    env: { ...GIT_ENV, GITHUB_OUTPUT: out, EVENT_NAME: "", IN_BASE: "", IN_HEAD: "", PR_BASE: "", PR_HEAD: "",
      MG_BASE: "", MG_HEAD: "", PUSH_BEFORE: "", PUSH_AFTER: "", ...env },
    encoding: "utf8",
  });
  const outputs = {};
  for (const line of fs.readFileSync(out, "utf8").split("\n")) {
    const m = /^([a-z]+)=(.*)$/.exec(line);
    if (m) outputs[m[1]] = m[2];
  }
  return { status: r.status, log: r.stdout + r.stderr, ...outputs };
}

function assertFails(r, what) {
  assert.notEqual(r.status, 0, `${what}: must fail, got status 0 (mode=${r.mode})\n${r.log}`);
  assert.match(r.log, /::error/, `${what}: must log an ::error annotation`);
  assert.equal(r.mode, undefined, `${what}: must not write a scan mode`);
}
function assertMode(r, mode, base, head, what) {
  assert.equal(r.status, 0, `${what}: status ${r.status}\n${r.log}`);
  assert.equal(r.mode, mode, `${what}: mode\n${r.log}`);
  assert.equal(r.base, base, `${what}: base`);
  assert.equal(r.head, head, `${what}: head`);
}

test("pull_request: a resolvable range scans base..head (inputs, or the event when inputs are empty)", () => {
  assertMode(resolve({ EVENT_NAME: "pull_request", IN_BASE: F.c1, IN_HEAD: F.c5 }), "range", F.c1, F.c5, "inputs");
  assertMode(resolve({ EVENT_NAME: "pull_request", PR_BASE: F.c1, PR_HEAD: F.c5 }), "range", F.c1, F.c5, "event");
});

test("pull_request: an unresolvable base or head fails the step (no silent empty scan)", () => {
  assertFails(resolve({ EVENT_NAME: "pull_request", IN_BASE: ABSENT, IN_HEAD: F.c5 }), "absent base");
  assertFails(resolve({ EVENT_NAME: "pull_request", IN_BASE: F.c1, IN_HEAD: ABSENT }), "absent head");
  assertFails(resolve({ EVENT_NAME: "pull_request", IN_BASE: ZERO, IN_HEAD: F.c5 }), "all-zero base");
  assertFails(resolve({ EVENT_NAME: "pull_request", IN_BASE: "", IN_HEAD: F.c5 }), "no base at all");
  assertFails(resolve({ EVENT_NAME: "pull_request", IN_BASE: F.c5, IN_HEAD: F.c5 }), "base equals head");
});

test("pull_request_target: a fork head missing from the clone is fetched once by SHA", () => {
  assertMode(resolve({ EVENT_NAME: "pull_request_target", PR_BASE: F.c5, PR_HEAD: F.c6 }, { origin: "served" }),
    "range", F.c5, F.c6, "served");
});

test("merge_group: the queue's base_sha..head_sha, and a missing base fails", () => {
  assertMode(resolve({ EVENT_NAME: "merge_group", MG_BASE: F.c4, MG_HEAD: F.c5 }), "range", F.c4, F.c5, "merge_group");
  assertFails(resolve({ EVENT_NAME: "merge_group", MG_BASE: ABSENT, MG_HEAD: F.c5 }), "absent base");
  assertFails(resolve({ EVENT_NAME: "merge_group", MG_HEAD: F.c5 }), "no base");
});

test("push fast-forward: scans before..after", () => {
  assertMode(resolve({ EVENT_NAME: "push", PUSH_BEFORE: F.c4, PUSH_AFTER: F.c5 }), "range", F.c4, F.c5, "event");
  // callers that pass `github.event.before` / `github.sha` as inputs
  assertMode(resolve({ EVENT_NAME: "push", IN_BASE: F.c4, IN_HEAD: F.c5, PUSH_BEFORE: F.c4, PUSH_AFTER: F.c5 }),
    "range", F.c4, F.c5, "inputs");
});

test("push with an all-zero before (first push / new ref): a logged full-history scan, in both caller shapes", () => {
  for (const env of [
    { EVENT_NAME: "push", PUSH_BEFORE: ZERO, PUSH_AFTER: F.c5 },
    { EVENT_NAME: "push", IN_BASE: ZERO, IN_HEAD: F.c5, PUSH_BEFORE: ZERO, PUSH_AFTER: F.c5 },
  ]) {
    const r = resolve(env);
    assertMode(r, "full", "", F.c5, "all-zero before");
    assert.match(r.log, /::warning[^\n]*full history/, "the full-history fallback must be logged");
  }
});

test("push after a force-push, before fetchable by SHA: scans from merge-base(before, after), logged", () => {
  const r = resolve({ EVENT_NAME: "push", PUSH_BEFORE: F.c2, PUSH_AFTER: F.c5 }, { origin: "served" });
  assertMode(r, "range", F.c1, F.c5, "force-push, served");
  assert.match(r.log, /::warning[^\n]*force-push/);
});

test("push after a force-push, before gone: a logged full-history scan (never a silent skip)", () => {
  const r = resolve({ EVENT_NAME: "push", PUSH_BEFORE: F.c2, PUSH_AFTER: F.c5 });
  assertMode(r, "full", "", F.c5, "force-push, gone");
  assert.match(r.log, /::warning[^\n]*full history/);
});

test("push that only rewinds the ref, or deletes it: no new commits, a logged notice and no scan", () => {
  const rewind = resolve({ EVENT_NAME: "push", PUSH_BEFORE: F.c5, PUSH_AFTER: F.c4 });
  assertMode(rewind, "none", "", F.c4, "rewind");
  assert.match(rewind.log, /::notice/);
  const del = resolve({ EVENT_NAME: "push", PUSH_BEFORE: F.c5, PUSH_AFTER: ZERO });
  assertMode(del, "none", "", "", "delete");
  assert.match(del.log, /::notice/);
});

test("push with an unresolvable head fails", () => {
  assertFails(resolve({ EVENT_NAME: "push", PUSH_BEFORE: F.c4, PUSH_AFTER: ABSENT }), "absent head");
});

test("other events without a base: a logged full-history scan of HEAD", () => {
  const r = resolve({ EVENT_NAME: "workflow_dispatch" });
  assertMode(r, "full", "", F.c5, "workflow_dispatch");
  assert.match(r.log, /::notice[^\n]*full history/);
});

test("an option-like revision is refused, never passed to git", () => {
  const marker = path.join(F.dir, "pwned");
  for (const env of [
    { EVENT_NAME: "pull_request", IN_BASE: `--upload-pack=touch ${marker}`, IN_HEAD: F.c5 },
    { EVENT_NAME: "push", PUSH_BEFORE: `--output=${marker}`, PUSH_AFTER: F.c5 },
  ]) {
    assertFails(resolve(env), "option-like value");
    assert.equal(fs.existsSync(marker), false);
  }
});
