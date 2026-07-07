// Regression lock for eng#212 — the skills-drift acknowledgement collector's
// PUSH arm must read acknowledgement markers from the squash commit body.
//
// The bug: the workflow's `Collect acknowledgements` step was guarded with
// `if: github.event_name == 'pull_request'`, so on a push-to-main (squash
// merge) the step was SKIPPED, the ack file was empty, and the node gate — which
// reads acks ONLY from --ack-file — saw no marker and red main on any
// declared-watch finding even though the squash body carried `Skills-unaffected:`.
//
// These tests exercise the SHARED collector (scripts/collect-skills-acks.sh,
// invoked verbatim by the workflow's acks step) end-to-end against the node gate
// over a real git repo, so the fix is proven AND regression-locked:
//   - POSITIVE: a watched-surface diff with a squash-body marker => gate exit 0.
//   - NEGATIVE: the same diff with NO marker => gate exit 1 (enforcement intact).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const GATE = path.join(HERE, "..", "skills-drift-gate.mjs");
const COLLECT = path.join(HERE, "..", "collect-skills-acks.sh");
const SKILLS = path.join(HERE, "..", "__fixtures__", "skills-drift");
// Temp repos live under the lane scratch dir, never /tmp (sandbox + memory rule).
const SCRATCH = path.join(HERE, "..", "..", ".claude", "scratch", "collect-acks-test");

function git(cwd, ...a) {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function mkRepo() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "repo-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  return dir;
}
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

// Invoke the SHARED collector exactly as the workflow's push arm does: env-only,
// EVENT_NAME != pull_request, cwd = the (caller) repo. Returns its stdout.
function collectPush(cwd, env) {
  const r = spawnSync("bash", [COLLECT], {
    cwd, encoding: "utf8",
    env: { ...process.env, EVENT_NAME: "push", PR_BODY: "", BASE_REF: "", ...env },
  });
  assert.equal(r.status, 0, `collector must succeed; stderr: ${r.stderr}`);
  return r.stdout;
}

// diffBase is the pre-squash commit (mirrors github.event.before on a push):
// the squash commit is the single commit ON main, so the gate's diff range is
// base..HEAD — exactly what the push arm evaluates after a squash-merge lands.
function runGate(cwd, diffBase, ackFile) {
  const args = [GATE, "--skills-dir", SKILLS, "--format", "json", "--diff-base", diffBase, "--mode", "enforce"];
  if (ackFile) args.push("--ack-file", ackFile);
  return spawnSync("node", args, { cwd, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" } });
}

// Build a base commit + a squash-style HEAD commit that renames the declared
// watch `workflow_draft_create` (so the gate fires a declared-watch finding) and
// whose BODY is `squashBody`. Returns { dir, baseSha }.
function repoWithSquash(squashBody) {
  const dir = mkRepo();
  fs.writeFileSync(path.join(dir, "src.ts"), "// initial\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const baseSha = git(dir, "rev-parse", "HEAD");
  // Single squash-style commit on main (mirrors a squash-merge landing on main).
  fs.writeFileSync(path.join(dir, "src.ts"), "renamed workflow_draft_create here\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", squashBody);
  return { dir, baseSha };
}

const MARKER = "feat: rename workflow draft primitive (#367)\n\n" +
  "Skills-unaffected: identifier only moved, skill-watched semantics unchanged\n";
const NO_MARKER = "feat: rename workflow draft primitive (#367)\n\n" +
  "No acknowledgement trailer in this body.\n";

// --- POSITIVE: push arm reads the squash-body marker; gate clears -----------

test("eng#212 PUSH arm (EVENT_BEFORE ancestor): squash-body marker is collected and clears the gate", () => {
  const { dir, baseSha } = repoWithSquash(MARKER);
  try {
    // Sanity: WITHOUT the collected acks the declared-watch finding gates.
    assert.equal(runGate(dir, baseSha).status, 1, "unacknowledged declared-watch finding must gate enforce");

    // The representative squash path: github.event.before is the real ancestor.
    const acks = collectPush(dir, { EVENT_BEFORE: baseSha });
    assert.match(acks, /Skills-unaffected: identifier only moved/, "collector must surface the squash-body marker");
    const ackFile = path.join(dir, "acks.txt");
    fs.writeFileSync(ackFile, acks);

    const pass = runGate(dir, baseSha, ackFile);
    assert.equal(pass.status, 0, `the collected squash-body ack must clear the push-arm gate; stderr: ${pass.stderr}`);
    const out = JSON.parse(pass.stdout);
    assert.equal(out.acknowledgements.unaffected, "identifier only moved, skill-watched semantics unchanged");
    assert.equal(out.unacknowledgedWatchFindingCount, 0);
  } finally { rm(dir); }
});

test("eng#212 PUSH arm (no/zero/non-ancestor EVENT_BEFORE): falls back to the HEAD squash body", () => {
  const { dir, baseSha } = repoWithSquash(MARKER);
  try {
    // Each of: unset before, the all-zero sentinel, and a non-ancestor sha must
    // fall back to `git log -1 %B HEAD` and still surface the marker.
    for (const env of [
      {},                                                                    // unset
      { EVENT_BEFORE: "0000000000000000000000000000000000000000" },          // zero sentinel
      { EVENT_BEFORE: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },          // non-ancestor
    ]) {
      const acks = collectPush(dir, env);
      assert.match(acks, /Skills-unaffected: identifier only moved/,
        `HEAD-body fallback must surface the marker for env ${JSON.stringify(env)}`);
      const ackFile = path.join(dir, "acks.txt");
      fs.writeFileSync(ackFile, acks);
      assert.equal(runGate(dir, baseSha, ackFile).status, 0, `fallback ack must clear the gate for env ${JSON.stringify(env)}`);
    }
  } finally { rm(dir); }
});

// --- NEGATIVE: enforcement is NOT weakened ----------------------------------

test("eng#212 PUSH arm: a squash body with NO marker still RED (enforcement intact)", () => {
  const { dir, baseSha } = repoWithSquash(NO_MARKER);
  try {
    const acks = collectPush(dir, { EVENT_BEFORE: baseSha });
    assert.doesNotMatch(acks, /Skills-(unaffected|reviewed|PR):/, "no marker should be present");
    const ackFile = path.join(dir, "acks.txt");
    fs.writeFileSync(ackFile, acks);

    const res = runGate(dir, baseSha, ackFile);
    assert.equal(res.status, 1, "an unacknowledged declared-watch finding must STILL gate on push (fix must not weaken enforcement)");
    const out = JSON.parse(res.stdout);
    assert.ok(out.watchFindings.some((f) => f.identifier === "workflow_draft_create" && !f.satisfied));
  } finally { rm(dir); }
});

// --- STATIC WORKFLOW LOCK: the wiring itself can't regress (codex r1 MED) ----
// The behavioural tests above exercise the shared collector, but they would
// still pass if someone re-introduced the ORIGINAL bug at the WORKFLOW layer:
// re-adding `if: github.event_name == 'pull_request'` to the acks step (which
// skips collection on push) or deleting the collector invocation. This static
// assertion locks the exact root-cause shape so the regression can't return via
// the workflow YAML.

const WORKFLOW = path.join(HERE, "..", "..", ".github", "workflows", "skills-drift-gate.yml");

// Extract the `Collect acknowledgements` step block (from its `- name:` line to
// the next top-level `- name:`/`- uses:` step at the same indentation).
function acksStepBlock() {
  const text = fs.readFileSync(WORKFLOW, "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*-\s+name:\s+Collect acknowledgements/.test(l));
  assert.ok(start >= 0, "the workflow must still have a `Collect acknowledgements` step");
  const indent = lines[start].match(/^(\s*)-/)[1];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (new RegExp(`^${indent}-\\s+(name|uses):`).test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

test("eng#212 WORKFLOW LOCK: the acks step runs on push (no pull_request-only `if:`)", () => {
  const block = acksStepBlock();
  // The root cause was exactly this guard skipping the step on push.
  assert.doesNotMatch(block, /^\s*if:\s*.*github\.event_name\s*==\s*'pull_request'/m,
    "the acks step must NOT be guarded to pull_request only — that was the eng#212 bug");
  // No `if:` at all on the step keeps it running on every triggering event.
  assert.doesNotMatch(block, /^\s{8}if:/m,
    "the acks step must have no step-level `if:` guard (runs on both pull_request and push)");
});

test("eng#212 WORKFLOW LOCK: the acks step invokes the shared collect-skills-acks.sh", () => {
  const block = acksStepBlock();
  assert.match(block, /collect-skills-acks\.sh/,
    "the acks step must call the shared collector script (the single source of truth under test)");
});

// ===========================================================================
// ci#56 — the PUSH arm must also read the merged PR body (PR_BODY_FILE), so an
// acknowledgement that lived ONLY in the PR body greens the post-merge run even
// when the squash body did not repeat it as a trailer. That was the #881 cosmetic
// red: the `Skills-unaffected:` ack was in the PR body; the squash body carried
// only other trailers; the push run saw the finding as unacknowledged and red
// main. PR_BODY_FILE is a RECOVERY source — empty/absent must stay fail-closed.
// ===========================================================================

// The PR body the workflow's "Resolve merged PR body (push)" step stages. The
// ack lives ONLY here (the squash body — NO_MARKER — does not repeat it).
const PR_BODY_MARKER =
  "batch: land the approved fixes in one squash (#881)\n\n" +
  "Skills-unaffected: reviewed all watching skills — agent_run internals only, tool contract unchanged\n";

function writePrBodyFile(dir, body) {
  const f = fs.realpathSync(dir) + path.sep + `pr-body-${Math.random().toString(36).slice(2)}.txt`;
  fs.writeFileSync(f, body);
  return f;
}

test("ci#56 PUSH arm: a PR-body-only ack (squash body has NO marker) is collected via PR_BODY_FILE and clears the gate", () => {
  const { dir, baseSha } = repoWithSquash(NO_MARKER);
  try {
    // Sanity: commit-trailers-only (no PR body staged) => the finding gates.
    // This is exactly the #881 cosmetic red the fix targets.
    const trailersOnly = collectPush(dir, { EVENT_BEFORE: baseSha });
    assert.doesNotMatch(trailersOnly, /Skills-(unaffected|reviewed|PR):/, "the squash body carries no marker");
    const trailerAck = path.join(dir, "trailers.txt");
    fs.writeFileSync(trailerAck, trailersOnly);
    assert.equal(runGate(dir, baseSha, trailerAck).status, 1,
      "without the PR body the push run reds — the #881 cosmetic red the fix targets");

    // With the resolved PR body staged in PR_BODY_FILE the ack is collected and
    // the gate clears — the SAME trust source the pull_request arm reads.
    const prBodyFile = writePrBodyFile(dir, PR_BODY_MARKER);
    const acks = collectPush(dir, { EVENT_BEFORE: baseSha, PR_BODY_FILE: prBodyFile });
    assert.match(acks, /Skills-unaffected: reviewed all watching skills/,
      "the collector must fold the PR-body ack into the push arm");
    const ackFile = path.join(dir, "acks.txt");
    fs.writeFileSync(ackFile, acks);
    const pass = runGate(dir, baseSha, ackFile);
    assert.equal(pass.status, 0, `the PR-body ack must clear the push-arm gate; stderr: ${pass.stderr}`);
    const out = JSON.parse(pass.stdout);
    assert.equal(out.unacknowledgedWatchFindingCount, 0);
  } finally { rm(dir); }
});

test("ci#56 PUSH arm: an empty/absent/marker-less PR_BODY_FILE is inert — an unacknowledged finding STILL reds (recovery source must not weaken enforcement)", () => {
  const { dir, baseSha } = repoWithSquash(NO_MARKER);
  try {
    const cases = [
      { EVENT_BEFORE: baseSha },                                                     // PR_BODY_FILE unset
      { EVENT_BEFORE: baseSha, PR_BODY_FILE: "" },                                   // empty value
      { EVENT_BEFORE: baseSha, PR_BODY_FILE: path.join(dir, "does-not-exist.txt") }, // missing path
      { EVENT_BEFORE: baseSha, PR_BODY_FILE: writePrBodyFile(dir, "no marker in this PR body\n") }, // present, no marker
    ];
    for (const env of cases) {
      const acks = collectPush(dir, env);
      assert.doesNotMatch(acks, /Skills-(unaffected|reviewed|PR):/,
        `no marker anywhere for env ${JSON.stringify(env)}`);
      const ackFile = path.join(dir, "acks.txt");
      fs.writeFileSync(ackFile, acks);
      assert.equal(runGate(dir, baseSha, ackFile).status, 1,
        `an unacknowledged finding must STILL gate for env ${JSON.stringify(env)}`);
    }
  } finally { rm(dir); }
});

test("ci#56 PUSH arm: PR body is emitted BEFORE the commit range and both are readable", () => {
  // A squash-body marker AND a distinct PR-body marker: both must survive into
  // the collected blob (the gate reads whichever satisfies the finding).
  const { dir, baseSha } = repoWithSquash(MARKER);
  try {
    const prBodyFile = writePrBodyFile(dir, PR_BODY_MARKER);
    const acks = collectPush(dir, { EVENT_BEFORE: baseSha, PR_BODY_FILE: prBodyFile });
    assert.match(acks, /Skills-unaffected: reviewed all watching skills/, "PR-body marker present");
    assert.match(acks, /Skills-unaffected: identifier only moved/, "squash-body marker present");
    // PR body first.
    assert.ok(
      acks.indexOf("reviewed all watching skills") < acks.indexOf("identifier only moved"),
      "the PR body must be emitted before the commit range",
    );
  } finally { rm(dir); }
});

// --- WORKFLOW LOCK: the push PR-body wiring itself can't silently regress -----

test("ci#56 WORKFLOW LOCK: the acks step forwards PR_BODY_FILE to the shared collector", () => {
  const block = acksStepBlock();
  assert.match(block, /PR_BODY_FILE:\s*\$\{\{\s*steps\.prbody\.outputs\.file\s*\}\}/,
    "the acks step must pass the resolved merged-PR body file to the collector");
});

test("ci#56 WORKFLOW LOCK: a push-only step resolves the merged PR body via the commit->PR association, and pull-requests:read is granted", () => {
  const text = fs.readFileSync(WORKFLOW, "utf8");
  assert.match(text, /^\s*pull-requests:\s*read\s*$/m,
    "the reusable workflow must request pull-requests:read for the commit->PR body resolution");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*-\s+name:\s+Resolve merged PR body/.test(l));
  assert.ok(start >= 0, "a `Resolve merged PR body (push)` step must exist");
  const indent = lines[start].match(/^(\s*)-/)[1];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (new RegExp(`^${indent}-\\s+(name|uses):`).test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start, end).join("\n");
  assert.match(block, /if:\s*github\.event_name\s*==\s*'push'/,
    "the resolve step must be push-only (the pull_request event already carries the body)");
  assert.match(block, /commits\/\$MERGE_SHA\/pulls/,
    "the resolve step must use the commit->PR association GET /commits/{sha}/pulls");
  assert.match(block, /merge_commit_sha == env\.MERGE_SHA/,
    "must select the PR whose merge_commit_sha is the pushed SHA (no blind first PR); the SHA reaches jq via env");
});
