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

// ===========================================================================
// THE RE-RUN TRAP — the pull_request arm must read the PR's CURRENT description.
//
// `github.event.pull_request.body` is a snapshot frozen when the run was
// triggered. Re-running a failed check replays that payload, so an author who
// reads "add `Skills-unaffected: <reason>` to the PR description", adds exactly
// that, and hits "Re-run failed jobs" is judged against the PRE-EDIT
// description: the check stays red no matter what they write, and only a new
// push or a close/reopen (a fresh event) clears it. resolve-pr-body.sh reads the
// description from the API at run time so a plain re-run sees the edit, and it
// FAILS CLOSED — it never falls back to the frozen copy, because that fallback
// is the trap itself.
// ===========================================================================

const RESOLVE = path.join(HERE, "..", "resolve-pr-body.sh");

// The acknowledgement the author ADDS to the description after the first red run.
const EDITED_BODY =
  "fix: rename the workflow draft primitive\n\n" +
  "Skills-unaffected: the identifier moved, every watching skill reads the same contract\n";
// What the frozen event payload still carries: the description as it was BEFORE
// the edit. Every live-arm assertion below is written so that reading this copy
// instead would flip the result — the tests cannot pass by accident.
const PRE_EDIT_BODY = "fix: rename the workflow draft primitive\n\nNo acknowledgement here yet.\n";

// A `gh` on PATH standing in for the API. It records its argv (so the request
// this resolver makes is pinned) and prints $MOCK_BODY, or fails like a real
// denied/missing read.
function stubGh(dir, script) {
  const bin = path.join(dir, "stub-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), script, { mode: 0o755 });
  return bin;
}
const GH_OK = "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > \"$GH_ARGV_FILE\"\nprintf '%s' \"$MOCK_BODY\"\n";
const GH_FAILS = "#!/usr/bin/env bash\necho 'gh: Resource not accessible by integration (HTTP 403)' >&2\nexit 1\n";

// Run the resolver exactly as the workflow's pull_request step does: env only,
// with the stub first on PATH.
function runResolve(dir, { ghScript = GH_OK, body = EDITED_BODY, mode = "enforce", repo = "cinatra-ai/cinatra", prNumber = "4212", out } = {}) {
  const bin = stubGh(dir, ghScript);
  const outFile = out ?? path.join(dir, "pr-body-live.txt");
  const argvFile = path.join(dir, "gh-argv.txt");
  const r = spawnSync("bash", [RESOLVE], {
    cwd: dir, encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GH_TOKEN: "stub-token", REPO: repo, PR_NUMBER: prNumber, MODE: mode, OUT: outFile,
      MOCK_BODY: body, GH_ARGV_FILE: argvFile,
    },
  });
  return { ...r, outFile, argvFile };
}

// Invoke the shared collector on the PULL_REQUEST arm.
function collectPR(cwd, env) {
  return spawnSync("bash", [COLLECT], {
    cwd, encoding: "utf8",
    env: { ...process.env, EVENT_NAME: "pull_request", BASE_REF: "main", PR_BODY: "", PR_BODY_FILE: "", ACK_SOURCE: "", ...env },
  });
}

// A PR whose head renames the declared watch `workflow_draft_create` (so the
// gate fires a declared-watch finding), with origin/main present so the
// collector's real commit-range read runs. The commit messages carry NO marker,
// so the description is the only thing that can clear the finding.
function prRepo() {
  const { dir, baseSha } = repoWithSquash(NO_MARKER);
  git(dir, "update-ref", "refs/remotes/origin/main", baseSha);
  return { dir, baseSha };
}

test("RE-RUN TRAP: the live-read description clears the gate that the frozen payload copy keeps red", () => {
  const { dir, baseSha } = prRepo();
  try {
    // 1. The trap, reproduced: the payload copy is the PRE-EDIT description, so
    //    the finding reds — this is every re-run for an author who fixed the
    //    description and pressed the button.
    const legacy = collectPR(dir, { PR_BODY: PRE_EDIT_BODY });
    assert.equal(legacy.status, 0);
    const legacyAcks = path.join(dir, "legacy.txt");
    fs.writeFileSync(legacyAcks, legacy.stdout);
    assert.equal(runGate(dir, baseSha, legacyAcks).status, 1,
      "the pre-edit description carries no acknowledgement, so the finding gates");

    // 2. The fix: the resolver reads the CURRENT description and the collector
    //    uses it. Same event payload, same commits — only freshness differs.
    const res = runResolve(dir, { body: EDITED_BODY });
    assert.equal(res.status, 0, `the live read must succeed; stderr: ${res.stderr}`);
    assert.match(res.stdout, /^source=live$/m, "the resolver reports how the description was obtained");
    assert.equal(fs.readFileSync(res.outFile, "utf8"), EDITED_BODY);
    assert.match(fs.readFileSync(res.argvFile, "utf8"), /api \/repos\/cinatra-ai\/cinatra\/pulls\/4212/,
      "the read is addressed by the identity from the event payload (repo + number), which no edit can change");

    const live = collectPR(dir, { PR_BODY: PRE_EDIT_BODY, PR_BODY_FILE: res.outFile, ACK_SOURCE: "live" });
    assert.equal(live.status, 0, `the collector must succeed; stderr: ${live.stderr}`);
    assert.match(live.stdout, /Skills-unaffected: the identifier moved/, "the edited description is collected");
    const liveAcks = path.join(dir, "live.txt");
    fs.writeFileSync(liveAcks, live.stdout);
    const pass = runGate(dir, baseSha, liveAcks);
    assert.equal(pass.status, 0, `the edited description must clear the finding; stderr: ${pass.stderr}`);
    assert.equal(JSON.parse(pass.stdout).unacknowledgedWatchFindingCount, 0);
  } finally { rm(dir); }
});

test("RE-RUN TRAP: with ACK_SOURCE=live the frozen payload copy is IGNORED, even when it is the copy carrying a marker", () => {
  // The author REMOVED the acknowledgement from the description. The live read
  // is the record of what the PR says now; the stale copy must not resurrect a
  // withdrawn attestation (and mixing the two would reintroduce the trap).
  const { dir, baseSha } = prRepo();
  try {
    const res = runResolve(dir, { body: PRE_EDIT_BODY });
    assert.equal(res.status, 0);
    const out = collectPR(dir, { PR_BODY: EDITED_BODY, PR_BODY_FILE: res.outFile, ACK_SOURCE: "live" });
    assert.equal(out.status, 0);
    assert.doesNotMatch(out.stdout, /Skills-unaffected:/, "the payload copy must not be read on the live arm");
    const ackFile = path.join(dir, "acks.txt");
    fs.writeFileSync(ackFile, out.stdout);
    assert.equal(runGate(dir, baseSha, ackFile).status, 1);
  } finally { rm(dir); }
});

test("RE-RUN TRAP: ACK_SOURCE=live with a missing staged file FAILS CLOSED — it never falls back to the payload copy", () => {
  const { dir } = prRepo();
  try {
    const out = collectPR(dir, {
      PR_BODY: EDITED_BODY, // the stale copy would clear the finding — must not be used
      PR_BODY_FILE: path.join(dir, "does-not-exist.txt"),
      ACK_SOURCE: "live",
    });
    assert.notEqual(out.status, 0, "a live read reported but not staged must fail the step, not degrade silently");
    assert.match(out.stderr, /::error::/);
    assert.doesNotMatch(out.stdout, /Skills-unaffected:/);
  } finally { rm(dir); }
});

test("RE-RUN TRAP: ACK_SOURCE=unavailable reads the (empty) staged file, never the payload copy", () => {
  const { dir, baseSha } = prRepo();
  try {
    const res = runResolve(dir, { ghScript: GH_FAILS, mode: "warn" });
    assert.equal(res.status, 0, "a failed read must not gate a non-gating run");
    assert.match(res.stdout, /^source=unavailable$/m);
    const out = collectPR(dir, { PR_BODY: EDITED_BODY, PR_BODY_FILE: res.outFile, ACK_SOURCE: "unavailable" });
    assert.equal(out.status, 0);
    assert.doesNotMatch(out.stdout, /Skills-unaffected:/, "an unreadable description must not silently become the stale one");
    const ackFile = path.join(dir, "acks.txt");
    fs.writeFileSync(ackFile, out.stdout);
    assert.equal(runGate(dir, baseSha, ackFile).status, 1);
  } finally { rm(dir); }
});

test("COMPAT: with no ACK_SOURCE the payload copy is still read — a caller pinned to a pre-live-read workflow keeps working", () => {
  // The scripts are checked out at the caller's `ref` input while the workflow
  // comes from its `uses:` pin; if those diverge, a newer collector can be driven
  // by an older workflow that only sets PR_BODY. Dropping that arm would lose
  // every description marker and red correctly-acknowledged PRs.
  const { dir, baseSha } = prRepo();
  try {
    const out = collectPR(dir, { PR_BODY: EDITED_BODY });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /Skills-unaffected: the identifier moved/);
    const ackFile = path.join(dir, "acks.txt");
    fs.writeFileSync(ackFile, out.stdout);
    assert.equal(runGate(dir, baseSha, ackFile).status, 0);
  } finally { rm(dir); }
});

test("RESOLVER FAIL-CLOSED: an API failure in enforce exits 1 with an error annotation and leaves NO body staged", () => {
  const { dir } = prRepo();
  try {
    const res = runResolve(dir, { ghScript: GH_FAILS, mode: "enforce" });
    assert.equal(res.status, 1, "enforce must go red on a failed read rather than judge against a stale description");
    assert.match(res.stderr, /::error::.*could not read the pull request description/);
    assert.match(res.stderr, /pull-requests: read/, "the message must name the likeliest cause");
    assert.equal(fs.readFileSync(res.outFile, "utf8"), "", "no partial or stale body may be left behind");
    assert.doesNotMatch(res.stdout, /source=live/);
  } finally { rm(dir); }
});

test("RESOLVER FAIL-CLOSED: an UNRECOGNIZED mode is treated as gating; only the explicit non-gating mode degrades to a warning", () => {
  const { dir } = prRepo();
  try {
    // A typo'd or renamed mode must not buy a fail-open read.
    assert.equal(runResolve(dir, { ghScript: GH_FAILS, mode: "enfroce" }).status, 1);
    // Unset follows the same default as the mode input and the engine: warn,
    // which never gates — hard-failing there would turn a non-gating check into
    // a gate on an unrelated API hiccup.
    assert.equal(runResolve(dir, { ghScript: GH_FAILS, mode: "" }).status, 0);
  } finally { rm(dir); }
});

test("RESOLVER FAIL-CLOSED: a missing or non-numeric PR number never reaches the API", () => {
  const { dir } = prRepo();
  try {
    for (const prNumber of ["", "12; rm -rf /", "abc"]) {
      const res = runResolve(dir, { prNumber, mode: "enforce" });
      assert.equal(res.status, 1, `PR number ${JSON.stringify(prNumber)} must fail closed`);
      assert.ok(!fs.existsSync(res.argvFile), "the stub must never have been invoked");
    }
  } finally { rm(dir); }
});

test("RESOLVER: an EMPTY description is a successful live read, not a failure", () => {
  const { dir } = prRepo();
  try {
    const res = runResolve(dir, { body: "", mode: "enforce" });
    assert.equal(res.status, 0, "a PR with no description is a legitimate answer: no acknowledgement");
    assert.match(res.stdout, /^source=live$/m);
    assert.equal(fs.readFileSync(res.outFile, "utf8"), "");
  } finally { rm(dir); }
});

// --- WORKFLOW LOCK: the live-read wiring itself can't silently regress --------

function stepBlock(text, nameRe) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s+name:\\s+${nameRe}`).test(l));
  assert.ok(start >= 0, `the workflow must have a step named ${nameRe}`);
  const indent = lines[start].match(/^(\s*)-/)[1];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (new RegExp(`^${indent}-\\s+(name|uses):`).test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

test("PR ARM: the shipped step runs the resolver from the gate checkout, and says so plainly when the pin skews", () => {
  const { dir } = prRepo();
  try {
    const script = stepRunScript(stepBlock(fs.readFileSync(WORKFLOW, "utf8"), "Resolve PR description live"));
    const out = path.join(dir, "pr-body-live.txt");

    // A gate checkout pinned OLDER than this workflow has no resolver in it. The
    // step must name the pin, not die on a command-not-found.
    const skewed = runStepScript(dir, script, {
      ghScript: GH_OK,
      env: { GITHUB_WORKSPACE: dir, PR_NUMBER: "4212", MODE: "enforce", OUT: out, MOCK_BODY: EDITED_BODY },
    });
    assert.equal(skewed.status, 1, "a skewed pin must fail closed");
    assert.match(skewed.stderr, /::error::.*'ref' input points at a commit older than this workflow/);

    // With the matching checkout present the step resolves and publishes both
    // outputs the collector and the engine consume.
    const workspace = fs.mkdtempSync(path.join(dir, "workspace-"));
    fs.mkdirSync(path.join(workspace, ".skills-drift-gate", "scripts"), { recursive: true });
    fs.copyFileSync(RESOLVE, path.join(workspace, ".skills-drift-gate", "scripts", "resolve-pr-body.sh"));
    const ok = runStepScript(dir, script, {
      ghScript: GH_OK,
      env: { GITHUB_WORKSPACE: workspace, PR_NUMBER: "4212", MODE: "enforce", OUT: out, MOCK_BODY: EDITED_BODY, GH_ARGV_FILE: path.join(dir, "gh-argv-step.txt") },
    });
    assert.equal(ok.status, 0, `stderr: ${ok.stderr}`);
    assert.equal(ok.outputs.source, "live");
    assert.equal(ok.outputs.file, out);
    assert.equal(fs.readFileSync(out, "utf8"), EDITED_BODY);
  } finally { rm(dir); }
});

test("GATE STEP: an event with no PR to read reports `unavailable`, never the payload copy", () => {
  // On a merge-queue candidate neither resolver runs. The engine must be told no
  // description was read — falling through to its `event` default would print a
  // remediation about a payload copy this run never read.
  const { dir } = prRepo();
  try {
    const script = stepRunScript(stepBlock(fs.readFileSync(WORKFLOW, "utf8"), "Run skills-drift-gate"));
    // A `node` stub records the argv the step builds; no gate runs here.
    const argvFile = path.join(dir, "node-argv.txt");
    const nodeStub = "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > \"$NODE_ARGV_FILE\"\n";
    const bin = path.join(dir, "stub-bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "node"), nodeStub, { mode: 0o755 });

    // The step probes the ENGINE it is about to run; stage a checkout of it.
    const engineDir = path.join(dir, ".skills-drift-gate", "scripts");
    fs.mkdirSync(engineDir, { recursive: true });
    fs.copyFileSync(GATE, path.join(engineDir, "skills-drift-gate.mjs"));

    const run = (ackSource) => {
      const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        cwd: dir, encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          NODE_ARGV_FILE: argvFile,
          MODE: "enforce", CONFIG: "", ACK_FILE: path.join(dir, "acks.txt"),
          SKILLS_REPOS: "", SKILLS_REPO: "", ACK_SOURCE: ackSource,
        },
      });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      return { argv: fs.readFileSync(argvFile, "utf8"), stderr: r.stderr };
    };
    assert.match(run("").argv, /--ack-source unavailable/,
      "no resolver ran => no description was read; that is `unavailable`, not the frozen payload");
    assert.match(run("live").argv, /--ack-source live/);
    assert.match(run("unavailable").argv, /--ack-source unavailable/);

    // An ENGINE older than this workflow does not know the flag. Passing it
    // would abort the gate with "unknown flag" — on the arms that never gate,
    // the check must keep running on its old terms and say why.
    fs.writeFileSync(path.join(engineDir, "skills-drift-gate.mjs"), "// an engine that predates the flag\n");
    const old = run("unavailable");
    assert.doesNotMatch(old.argv, /--ack-source/, "an engine that cannot take the flag must not be handed it");
    assert.match(old.stderr, /::warning::.*'ref' input points at a commit older than this workflow/);
  } finally { rm(dir); }
});

test("WORKFLOW LOCK: a pull_request-only step reads the description live via the shared resolver", () => {
  const text = fs.readFileSync(WORKFLOW, "utf8");
  const block = stepBlock(text, "Resolve PR description live");
  assert.match(block, /if:\s*github\.event_name\s*==\s*'pull_request'/,
    "the live read belongs to the pull_request arm (push resolves its body from the commit->PR association)");
  assert.match(block, /resolve-pr-body\.sh/, "it must call the shared, tested resolver");
  assert.match(block, /PR_NUMBER:\s*\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/,
    "only the IDENTITY comes from the event payload");
  assert.match(block, /MODE:\s*\$\{\{\s*inputs\.mode\s*\}\}/,
    "the resolver needs the mode to decide whether a failed read gates");
  assert.doesNotMatch(block, /github\.event\.pull_request\.body/,
    "the live read must never re-introduce the frozen payload body");
});

test("WORKFLOW LOCK: the acks step forwards the live description AND the source to the collector", () => {
  const block = acksStepBlock();
  assert.match(block, /PR_BODY_FILE:.*steps\.prlive\.outputs\.file/,
    "the pull_request arm must receive the live-read description file");
  assert.match(block, /ACK_SOURCE:.*steps\.prlive\.outputs\.source/,
    "the collector must be told which description copy is authoritative");
});

// The push arm's resolution is inline shell in the workflow. Rather than assert
// its TEXT (an assertion that would still pass if an unguarded API call were
// added — under the `-e` shell GitHub runs, that alone would red the default
// branch), extract the shipped script and RUN it against a stubbed API. What is
// under test is exactly what ships.
function stepRunScript(block) {
  const lines = block.split("\n");
  const i = lines.findIndex((l) => /^\s*run:\s*\|\s*$/.test(l));
  assert.ok(i >= 0, "the step must carry a literal block `run: |` script");
  const body = lines.slice(i + 1);
  const indent = (body.find((l) => l.trim()) || "").match(/^\s*/)[0];
  return body.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n");
}

// Runs a workflow step's script the way the runner does: `bash -e -o pipefail`,
// with $RUNNER_TEMP / $GITHUB_OUTPUT provided and a stub `gh` first on PATH.
function runStepScript(dir, script, { ghScript, env = {} } = {}) {
  const bin = stubGh(dir, ghScript);
  const runnerTemp = fs.mkdtempSync(path.join(dir, "runner-temp-"));
  const outputs = path.join(dir, `step-outputs-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(outputs, "");
  const file = path.join(dir, `step-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, script);
  const r = spawnSync("bash", ["-e", "-o", "pipefail", file], {
    cwd: dir, encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: outputs,
      GH_TOKEN: "stub-token", REPO: "cinatra-ai/cinatra", MERGE_SHA: "f".repeat(40),
      ...env,
    },
  });
  const parsed = Object.fromEntries(
    fs.readFileSync(outputs, "utf8").split("\n").filter(Boolean).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
  return { ...r, outputs: parsed };
}

// A `gh` that answers the commit->PR association with one number and the PR read
// with $MOCK_BODY; `MOCK_FAIL` makes the chosen call fail like a denied read.
const GH_PUSH_ARM = `#!/usr/bin/env bash
case "$*" in
  *"/commits/"*)
    [ "$MOCK_FAIL" = association ] && { echo 'gh: denied' >&2; exit 1; }
    printf '%s\\n' "$MOCK_PR_NUMBER"
    ;;
  *"/pulls/"*)
    [ "$MOCK_FAIL" = body ] && { echo 'gh: denied' >&2; exit 1; }
    printf '%s' "$MOCK_BODY"
    ;;
esac
`;

test("PUSH ARM: the shipped step reads the merged PR body and reports source=live", () => {
  const { dir } = prRepo();
  try {
    const script = stepRunScript(stepBlock(fs.readFileSync(WORKFLOW, "utf8"), "Resolve merged PR body"));
    const res = runStepScript(dir, script, {
      ghScript: GH_PUSH_ARM,
      env: { MOCK_PR_NUMBER: "881", MOCK_BODY: EDITED_BODY },
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(res.outputs.source, "live", "a post-merge run that DID read the description must not be described as reading the frozen payload");
    assert.equal(fs.readFileSync(res.outputs.file, "utf8"), EDITED_BODY);
  } finally { rm(dir); }
});

test("PUSH ARM: every API failure stays FAIL-OPEN — exit 0, empty body, source=unavailable (the default branch must never red on a failed description read)", () => {
  const { dir } = prRepo();
  try {
    const script = stepRunScript(stepBlock(fs.readFileSync(WORKFLOW, "utf8"), "Resolve merged PR body"));
    const cases = [
      { name: "association read denied", env: { MOCK_FAIL: "association", MOCK_PR_NUMBER: "881", MOCK_BODY: EDITED_BODY } },
      { name: "body read denied", env: { MOCK_FAIL: "body", MOCK_PR_NUMBER: "881", MOCK_BODY: EDITED_BODY } },
      { name: "no PR associated with the commit", env: { MOCK_PR_NUMBER: "", MOCK_BODY: EDITED_BODY } },
    ];
    for (const c of cases) {
      const res = runStepScript(dir, script, { ghScript: GH_PUSH_ARM, env: c.env });
      assert.equal(res.status, 0, `${c.name} must not fail the step; stderr: ${res.stderr}`);
      assert.equal(res.outputs.source, "unavailable", `${c.name} must report an unavailable description`);
      assert.equal(fs.readFileSync(res.outputs.file, "utf8"), "", `${c.name} must leave no body staged`);
      if (c.env.MOCK_FAIL === "body") {
        // A description that EXISTS but could not be read is the case where an
        // acknowledgement silently stops counting — that must be visible.
        assert.match(res.stderr, /::warning::could not read the merged pull request's description/,
          "a failed description read must be reported, not swallowed");
      }
    }
  } finally { rm(dir); }
});

test("WORKFLOW LOCK: the gate step forwards --ack-source so the remediation hint matches the run", () => {
  const text = fs.readFileSync(WORKFLOW, "utf8");
  const block = stepBlock(text, "Run skills-drift-gate");
  assert.match(block, /ACK_SOURCE:.*steps\.prlive\.outputs\.source/);
  assert.match(block, /ACK_SOURCE:.*steps\.prbody\.outputs\.source/,
    "a post-merge run reports its own source too — it must not be described as reading the frozen payload");
  assert.match(block, /--ack-source/);
});
