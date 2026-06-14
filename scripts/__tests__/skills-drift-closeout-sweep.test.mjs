import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseScopedDecisions,
  findingResolved,
  SWEEP_VERSION,
  EMPTY_TREE,
} from "../skills-drift-closeout-sweep.mjs";

const SWEEP = path.join(import.meta.dirname, "..", "skills-drift-closeout-sweep.mjs");

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdcs-")));
}
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function git(cwd, ...a) {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0 && a[0] !== "rev-parse") {
    // rev-parse used in assertions; other git must succeed for the fixture
    throw new Error(`git ${a.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r;
}

// A minimal assistant-skills checkout: one declared-watch skill at a known SHA.
function makeSkillsRepo(watchBlock) {
  const dir = tmpDir();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  const skillDir = path.join(dir, "skills", "demo-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: demo-skill\n${watchBlock}---\nBody\n`,
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "skills");
  const sha = git(dir, "rev-parse", "HEAD").stdout.trim();
  return { dir, skillsDir: path.join(dir, "skills"), sha };
}

// A release repo (stands in for cinatra) with a base commit (tag v1) and a head
// commit whose diff touches a surface, plus controllable commit messages.
function makeReleaseRepo({ baseSrc, headSrc, headMsg = "feat: change", tagBase = true }) {
  const dir = tmpDir();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "src.ts"), baseSrc);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base release");
  if (tagBase) git(dir, "tag", "v1.0.0");
  fs.writeFileSync(path.join(dir, "src.ts"), headSrc);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", headMsg);
  git(dir, "tag", "v2.0.0");
  return dir;
}

function runSweep(cwd, extraArgs) {
  return spawnSync("node", [SWEEP, "--format", "json", ...extraArgs], {
    cwd, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" },
  });
}

const WATCH = "cinatra-watches:\n  primitives: [agent_run]\n";

// --- Pure: parseScopedDecisions ---------------------------------------------

test("parseScopedDecisions: surface-scoped reviewed/unaffected parse with attribution", () => {
  const ds = parseScopedDecisions(
    "Skills-reviewed: demo-skill — checked and updated\nSkills-unaffected: agent_run — only docs moved\n",
  );
  assert.equal(ds.length, 2);
  const reviewed = ds.find((d) => d.kind === "reviewed");
  assert.ok(reviewed.tokens.has("demo-skill"));
  const unaffected = ds.find((d) => d.kind === "unaffected");
  assert.ok(unaffected.tokens.has("agent_run"));
});

test("parseScopedDecisions: Skills-unaffected with NO reason is dropped (bare reason satisfies nothing)", () => {
  const ds = parseScopedDecisions("Skills-unaffected: demo-skill\n");
  assert.equal(ds.length, 0);
});

test("parseScopedDecisions: a SKILL.md relpath attribution normalizes to its slug", () => {
  const ds = parseScopedDecisions("Skills-reviewed: skills/demo-skill/SKILL.md — done\n");
  assert.ok(ds[0].tokens.has("demo-skill"));
});

// --- Pure: findingResolved (stricter, per-surface) ---------------------------

const finding = { class: "primitives", identifier: "agent_run", skills: ["demo-skill"] };

test("findingResolved: linked Skills-PR covering the skill resolves", () => {
  const linkedPRs = [{ ref: "#42", covers: new Set(["demo-skill"]) }];
  assert.equal(findingResolved(finding, { linkedPRs, scoped: [] }).resolved, true);
});

test("findingResolved: surface-scoped reviewed naming the skill resolves", () => {
  const scoped = parseScopedDecisions("Skills-reviewed: demo-skill — checked\n");
  assert.equal(findingResolved(finding, { linkedPRs: [], scoped }).resolved, true);
});

test("findingResolved: scoped decision naming the surface identifier resolves", () => {
  const scoped = parseScopedDecisions("Skills-unaffected: agent_run — renamed back, no net change\n");
  assert.equal(findingResolved(finding, { linkedPRs: [], scoped }).resolved, true);
});

test("findingResolved: a BLANKET reviewed with NO surface attribution clears NOTHING (stricter than per-PR)", () => {
  // "reviewed everything" with an attribution token that names neither the skill,
  // the surface, nor the class must NOT resolve this finding.
  const scoped = parseScopedDecisions("Skills-reviewed: all-good — release looks fine\n");
  assert.equal(findingResolved(finding, { linkedPRs: [], scoped }).resolved, false);
});

test("findingResolved: a Skills-PR NOT covering the skill does not resolve", () => {
  const linkedPRs = [{ ref: "#9", covers: new Set(["other-skill"]) }];
  assert.equal(findingResolved(finding, { linkedPRs, scoped: [] }).resolved, false);
});

// --- Integration: engine reuse + release-range diff + blocking ---------------

test("sweep BLOCKS (exit 1) on an unresolved watched surface changed across the release", () => {
  const sk = makeSkillsRepo(WATCH);
  // base references agent_run; head renames it -> the diff carries agent_run on
  // the removed line, intersecting the watch.
  const rel = makeReleaseRepo({
    baseSrc: "export const x = agent_run();\n",
    headSrc: "export const x = agent_run_v2();\n",
  });
  try {
    const r = runSweep(rel, ["--skills-dir", sk.skillsDir, "--skills-ref", sk.sha, "--base", "v1.0.0", "--head", "v2.0.0"]);
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.watchFindingCount, 1);
    assert.equal(out.unresolvedCount, 1);
    assert.equal(out.unresolved[0].identifier, "agent_run");
  } finally { rm(sk.dir); rm(rel); }
});

test("sweep PASSES (exit 0) when a merged-commit message carries a surface-scoped decision (durable, post-squash)", () => {
  const sk = makeSkillsRepo(WATCH);
  const rel = makeReleaseRepo({
    baseSrc: "export const x = agent_run();\n",
    headSrc: "export const x = agent_run_v2();\n",
    headMsg: "feat: rename primitive\n\nSkills-reviewed: demo-skill — updated SKILL.md\n",
  });
  try {
    const r = runSweep(rel, ["--skills-dir", sk.skillsDir, "--skills-ref", sk.sha, "--base", "v1.0.0", "--head", "v2.0.0"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.unresolvedCount, 0);
  } finally { rm(sk.dir); rm(rel); }
});

test("sweep reads the decision log from the COMMITTED head, not the mutable workspace", () => {
  const sk = makeSkillsRepo(WATCH);
  const rel = makeReleaseRepo({
    baseSrc: "export const x = agent_run();\n",
    headSrc: "export const x = agent_run_v2();\n",
  });
  try {
    // First: an UNCOMMITTED workspace decision log must NOT satisfy the sweep.
    fs.writeFileSync(path.join(rel, "DECISIONS.md"), "## v2.0.0\nSkills-reviewed: demo-skill — local only\n");
    let r = runSweep(rel, ["--skills-dir", sk.skillsDir, "--skills-ref", sk.sha, "--base", "v1.0.0", "--head", "v2.0.0", "--decision-log", "DECISIONS.md", "--decision-log-section", "v2.0.0"]);
    // The file is absent at v2.0.0 (uncommitted) -> fail-loud exit 2.
    assert.equal(r.status, 2, `expected fail-loud on uncommitted log; got ${r.status}: ${r.stdout}`);

    // Now commit it on a NEW head and re-tag; the committed ack resolves.
    git(rel, "add", "-A");
    git(rel, "commit", "-q", "-m", "chore: record decision");
    git(rel, "tag", "-f", "v2.0.0");
    r = runSweep(rel, ["--skills-dir", sk.skillsDir, "--skills-ref", sk.sha, "--base", "v1.0.0", "--head", "v2.0.0", "--decision-log", "DECISIONS.md", "--decision-log-section", "v2.0.0"]);
    assert.equal(r.status, 0, r.stderr);
  } finally { rm(sk.dir); rm(rel); }
});

test("decision-log section scoping: an ack under an OLDER section does not mask a new finding", () => {
  const sk = makeSkillsRepo(WATCH);
  const rel = makeReleaseRepo({
    baseSrc: "export const x = agent_run();\n",
    headSrc: "export const x = agent_run_v2();\n",
  });
  try {
    fs.writeFileSync(path.join(rel, "DECISIONS.md"), "## v1.0.0\nSkills-reviewed: demo-skill — old release\n## v2.0.0\nnothing relevant here\n");
    git(rel, "add", "-A");
    git(rel, "commit", "-q", "-m", "chore: decisions");
    git(rel, "tag", "-f", "v2.0.0");
    const r = runSweep(rel, ["--skills-dir", sk.skillsDir, "--skills-ref", sk.sha, "--base", "v1.0.0", "--head", "v2.0.0", "--decision-log", "DECISIONS.md", "--decision-log-section", "v2.0.0"]);
    assert.equal(r.status, 1, `stale v1 ack must not clear a v2 finding: ${r.stdout}`);
  } finally { rm(sk.dir); rm(rel); }
});

test("first-release: --first-release uses the empty tree as base", () => {
  const sk = makeSkillsRepo(WATCH);
  const dir = tmpDir();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "src.ts"), "export const x = agent_run();\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feat: first release");
  git(dir, "tag", "v0.1.0");
  try {
    const r = runSweep(dir, ["--skills-dir", sk.skillsDir, "--skills-ref", sk.sha, "--first-release", "--head", "v0.1.0"]);
    assert.equal(r.status, 1, r.stderr); // agent_run is added vs empty tree -> flagged, unresolved
    const out = JSON.parse(r.stdout);
    assert.equal(out.firstRelease, true);
    assert.equal(out.base, "EMPTY_TREE");
    assert.equal(out.watchFindingCount, 1);
  } finally { rm(sk.dir); rm(dir); }
});

// --- Fail-loud (exit 2) invariants ------------------------------------------

test("fail-loud (exit 2): --skills-dir not checked out at --skills-ref (stale pin)", () => {
  const sk = makeSkillsRepo(WATCH);
  const rel = makeReleaseRepo({ baseSrc: "a\n", headSrc: "b\n" });
  try {
    const r = runSweep(rel, ["--skills-dir", sk.skillsDir, "--skills-ref", "0000000000000000000000000000000000000000", "--base", "v1.0.0", "--head", "v2.0.0"]);
    assert.equal(r.status, 2, r.stdout);
  } finally { rm(sk.dir); rm(rel); }
});

test("fail-loud (exit 2): --base missing without --first-release", () => {
  const sk = makeSkillsRepo(WATCH);
  const rel = makeReleaseRepo({ baseSrc: "a\n", headSrc: "b\n" });
  try {
    const r = runSweep(rel, ["--skills-dir", sk.skillsDir, "--skills-ref", sk.sha, "--head", "v2.0.0"]);
    assert.equal(r.status, 2, r.stdout);
  } finally { rm(sk.dir); rm(rel); }
});

test("fail-loud (exit 2): --base and --first-release are mutually exclusive", () => {
  const sk = makeSkillsRepo(WATCH);
  const rel = makeReleaseRepo({ baseSrc: "a\n", headSrc: "b\n" });
  try {
    const r = runSweep(rel, ["--skills-dir", sk.skillsDir, "--skills-ref", sk.sha, "--first-release", "--base", "v1.0.0", "--head", "v2.0.0"]);
    assert.equal(r.status, 2, r.stdout);
  } finally { rm(sk.dir); rm(rel); }
});

test("fail-loud (exit 2): malformed cinatra-watches block in the bumped pin", () => {
  const sk = makeSkillsRepo("cinatra-watches:\n  primitives: []\n"); // empty class = malformed
  const rel = makeReleaseRepo({ baseSrc: "a\n", headSrc: "b\n" });
  try {
    const r = runSweep(rel, ["--skills-dir", sk.skillsDir, "--skills-ref", sk.sha, "--base", "v1.0.0", "--head", "v2.0.0"]);
    assert.equal(r.status, 2, r.stdout);
  } finally { rm(sk.dir); rm(rel); }
});

test("fail-loud (exit 2): unresolvable --base ref", () => {
  const sk = makeSkillsRepo(WATCH);
  const rel = makeReleaseRepo({ baseSrc: "a\n", headSrc: "b\n" });
  try {
    const r = runSweep(rel, ["--skills-dir", sk.skillsDir, "--skills-ref", sk.sha, "--base", "no-such-tag", "--head", "v2.0.0"]);
    assert.equal(r.status, 2, r.stdout);
  } finally { rm(sk.dir); rm(rel); }
});

test("sweep clean (exit 0): release range touches no watched surface", () => {
  const sk = makeSkillsRepo(WATCH);
  const rel = makeReleaseRepo({ baseSrc: "export const y = 1;\n", headSrc: "export const y = 2;\n" });
  try {
    const r = runSweep(rel, ["--skills-dir", sk.skillsDir, "--skills-ref", sk.sha, "--base", "v1.0.0", "--head", "v2.0.0"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.watchFindingCount, 0);
  } finally { rm(sk.dir); rm(rel); }
});

test("findingResolved: a CLASS-level token (e.g. 'primitives') clears NOTHING (codex r2 #1 — a whole release can be all-one-class)", () => {
  // `Skills-reviewed: primitives — ...` must NOT resolve a primitives finding;
  // otherwise one ack blanket-clears every primitive surface in the release.
  const scoped = parseScopedDecisions("Skills-reviewed: primitives — looked at all of them\n");
  assert.equal(findingResolved(finding, { linkedPRs: [], scoped }).resolved, false);
  const scoped2 = parseScopedDecisions("Skills-unaffected: primitive — class-level\n"); // singular too
  assert.equal(findingResolved(finding, { linkedPRs: [], scoped: scoped2 }).resolved, false);
});

test("fail-loud (exit 2): --head is REQUIRED — the sweep never falls back to workspace HEAD (codex r2 #2)", () => {
  const sk = makeSkillsRepo(WATCH);
  const rel = makeReleaseRepo({ baseSrc: "a\n", headSrc: "b\n" });
  try {
    const r = runSweep(rel, ["--skills-dir", sk.skillsDir, "--skills-ref", sk.sha, "--base", "v1.0.0"]);
    assert.equal(r.status, 2, r.stdout);
  } finally { rm(sk.dir); rm(rel); }
});

test("exports: SWEEP_VERSION + EMPTY_TREE are stable constants", () => {
  assert.equal(typeof SWEEP_VERSION, "string");
  assert.equal(EMPTY_TREE, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
});
