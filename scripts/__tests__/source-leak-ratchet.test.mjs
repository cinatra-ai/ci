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
