import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCANNER = path.join(import.meta.dirname, "..", "source-leak-gate.mjs");
// A marker payload assembled so this test file carries no intact example outside
// the strings it builds at runtime.
const MARKER = "see " + "Phase " + "530 here";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function setupRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slg-rat-")));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}
function commit(dir, files, msg) {
  for (const [p, content] of Object.entries(files)) {
    const abs = path.join(dir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}
function runGate(dir, base, extraArgs) {
  const res = spawnSync(
    "node",
    [SCANNER, "--exit-on-match", "--quiet", "--diff-base-env", "TESTBASE", ...extraArgs],
    { cwd: dir, encoding: "utf8", env: { ...process.env, TESTBASE: base || "" } },
  );
  return res.status;
}
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test("line ratchet: new finding on a PR-added line blocks", () => {
  const dir = setupRepo();
  try {
    const base = commit(dir, { "a.txt": "hello\n" }, "init");
    commit(dir, { "b.md": MARKER + "\n" }, "add b");
    assert.equal(runGate(dir, base, ["--ratchet-mode", "line"]), 1);
  } finally { rm(dir); }
});

test("line ratchet: pre-existing finding on an untouched line is tolerated", () => {
  const dir = setupRepo();
  try {
    const base = commit(dir, { "c.md": MARKER + "\nclean line\n" }, "init");
    commit(dir, { "c.md": MARKER + "\nclean line\nanother clean line\n" }, "append");
    assert.equal(runGate(dir, base, ["--ratchet-mode", "line"]), 0);
  } finally { rm(dir); }
});

test("off mode blocks even pre-existing findings", () => {
  const dir = setupRepo();
  try {
    const base = commit(dir, { "c.md": MARKER + "\nclean line\n" }, "init");
    commit(dir, { "c.md": MARKER + "\nclean line\nanother\n" }, "append");
    assert.equal(runGate(dir, base, ["--ratchet-mode", "off"]), 1);
  } finally { rm(dir); }
});

test("file ratchet: non-allowlisted finding blocks", () => {
  const dir = setupRepo();
  try {
    const base = commit(dir, { "a.txt": "hello\n" }, "init");
    commit(dir, { "d.md": MARKER + "\n" }, "add d");
    assert.equal(runGate(dir, base, ["--ratchet-mode", "file"]), 1);
  } finally { rm(dir); }
});

test("file ratchet: allowlisted + untouched is tolerated; stale entry blocks", () => {
  const dir = setupRepo();
  try {
    const base = commit(dir, { "d.md": MARKER + "\n", "e.txt": "x\n" }, "init");
    commit(dir, { "e.txt": "x\ny\n" }, "touch e only");
    fs.writeFileSync(path.join(dir, "allow.json"), JSON.stringify({ files: ["d.md"] }));
    assert.equal(runGate(dir, base, ["--ratchet-mode", "file", "--legacy-allowlist", "allow.json"]), 0);

    // Stale: allowlist a clean file -> blocks.
    fs.writeFileSync(path.join(dir, "allow.json"), JSON.stringify({ files: ["d.md", "e.txt"] }));
    assert.equal(runGate(dir, base, ["--ratchet-mode", "file", "--legacy-allowlist", "allow.json"]), 1);
  } finally { rm(dir); }
});

test("bad explicit diff base fails loud (exit 2)", () => {
  const dir = setupRepo();
  try {
    commit(dir, { "b.md": MARKER + "\n" }, "init");
    assert.equal(runGate(dir, "does-not-exist", ["--ratchet-mode", "line"]), 2);
  } finally { rm(dir); }
});

test("empty diff base is strict (does not silently tolerate)", () => {
  const dir = setupRepo();
  try {
    commit(dir, { "b.md": MARKER + "\n" }, "init");
    // A local origin/main at HEAD would tolerate everything under a naive
    // fallback; an explicitly-empty base must instead gate strictly.
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    assert.equal(runGate(dir, "", ["--ratchet-mode", "line"]), 1);
  } finally { rm(dir); }
});

test("baseline mode tolerates accepted counts and blocks increases", () => {
  const dir = setupRepo();
  const MARKER2 = "see " + "Phase " + "531 here";
  try {
    commit(dir, { "a.md": MARKER + "\n" }, "init");
    fs.writeFileSync(path.join(dir, "baseline.json"),
      JSON.stringify({ perRuleFile: { ["SLG_MILESTONE_NUMBER\ta.md"]: 1 } }));
    assert.equal(runGate(dir, "", ["--ratchet-mode", "baseline", "--gate-baseline", "baseline.json"]), 0);
    fs.writeFileSync(path.join(dir, "a.md"), MARKER + "\n" + MARKER2 + "\n");
    assert.equal(runGate(dir, "", ["--ratchet-mode", "baseline", "--gate-baseline", "baseline.json"]), 1);
  } finally { rm(dir); }
});

test("caller files at the gate's own paths are NOT exempt", () => {
  const dir = setupRepo();
  try {
    fs.mkdirSync(path.join(dir, "scripts/__fixtures__"), { recursive: true });
    // A caller file at the gate's own relative path, even with a sentinel block,
    // must still be scanned (exemption is keyed to the real running gate file).
    fs.writeFileSync(
      path.join(dir, "scripts/source-leak-gate.mjs"),
      "// " + "SOURCE_LEAK_RULES" + "_BEGIN\n" + MARKER + "\n// " + "SOURCE_LEAK_RULES" + "_END\n",
    );
    fs.writeFileSync(path.join(dir, "scripts/__fixtures__/caller.fixture.txt"), MARKER + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "caller files");
    assert.equal(runGate(dir, "", ["--ratchet-mode", "off"]), 1);
  } finally { rm(dir); }
});

test("private-eng-ref: NET-NEW line blocks, pre-existing line is tolerated (line ratchet)", () => {
  // The new SLG_PRIVATE_ENG_REF rule must ride the same line ratchet as every
  // other content rule: a pre-existing private-tracker ref on an untouched line
  // does NOT red an already-unclean repo before the sweep finishes; only a
  // NET-NEW ref on a PR-added line blocks. (Use a .ts file so the doc-basename
  // exemption for *.md does not drop the finding.)
  const ENG = "// see " + "eng#" + "231 for rationale";
  const ENG2 = "// see " + "eng#" + "232 for rationale";

  // (a) pre-existing ref on an untouched line -> tolerated
  const a = setupRepo();
  try {
    const base = commit(a, { "note.ts": ENG + "\nconst clean = 1;\n" }, "init");
    commit(a, { "note.ts": ENG + "\nconst clean = 1;\nconst more = 2;\n" }, "append clean");
    assert.equal(runGate(a, base, ["--ratchet-mode", "line"]), 0);
  } finally { rm(a); }

  // (b) NET-NEW ref on a PR-added line -> blocks
  const b = setupRepo();
  try {
    const base = commit(b, { "note.ts": "const clean = 1;\n" }, "init");
    commit(b, { "note.ts": "const clean = 1;\n" + ENG2 + "\n" }, "add eng ref");
    assert.equal(runGate(b, base, ["--ratchet-mode", "line"]), 1);
  } finally { rm(b); }
});

test("manifest include/negation scopes the scan", () => {
  const dir = setupRepo();
  try {
    commit(dir, { "a.md": "clean\n", "b.md": MARKER + "\n" }, "init");
    fs.writeFileSync(path.join(dir, "m-all.txt"), "a.md\nb.md\n");
    fs.writeFileSync(path.join(dir, "m-neg.txt"), "a.md\nb.md\n!b.md\n");
    assert.equal(runGate(dir, "", ["--ratchet-mode", "off", "--manifest", "m-all.txt"]), 1);
    assert.equal(runGate(dir, "", ["--ratchet-mode", "off", "--manifest", "m-neg.txt"]), 0);
  } finally { rm(dir); }
});
