import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkGitignore, countEntries } from "../gitignore-gate.mjs";

const GATE = path.join(import.meta.dirname, "..", "gitignore-gate.mjs");
const BASELINE = path.join(import.meta.dirname, "..", "..", "config", "baseline.gitignore");

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gig-")));
}
function runGate(extraArgs, opts = {}) {
  return spawnSync("node", [GATE, ...extraArgs], { encoding: "utf8", ...opts });
}
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test("missing .gitignore fails (exit 1)", () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(checkGitignore(dir), { ok: false, status: "missing", file: path.join(dir, ".gitignore"), entryCount: 0 });
    assert.equal(runGate(["--root", dir, "--quiet"]).status, 1);
  } finally { rm(dir); }
});

test("empty .gitignore fails (exit 1)", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), "");
    assert.equal(checkGitignore(dir).status, "empty");
    assert.equal(runGate(["--root", dir, "--quiet"]).status, 1);
  } finally { rm(dir); }
});

test("whitespace-only .gitignore fails (exit 1)", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), " \t\n\r\n  \n");
    assert.equal(checkGitignore(dir).status, "whitespace-only");
    assert.equal(runGate(["--root", dir, "--quiet"]).status, 1);
  } finally { rm(dir); }
});

test("symlinked .gitignore fails: git >= 2.32 does not follow it", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "real-ignore.txt"), "node_modules/\n");
    fs.symlinkSync(path.join(dir, "real-ignore.txt"), path.join(dir, ".gitignore"));
    assert.equal(checkGitignore(dir).status, "not-a-file");
    assert.equal(runGate(["--root", dir, "--quiet"]).status, 1);
  } finally { rm(dir); }
});

test("real entries pass with the effective entry count", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), "# deps\nnode_modules/\n\n*.log\n");
    const result = checkGitignore(dir);
    assert.equal(result.ok, true);
    assert.equal(result.status, "ok");
    assert.equal(result.entryCount, 2); // comments and blank lines do not count
    assert.equal(runGate(["--root", dir, "--quiet"]).status, 0);
  } finally { rm(dir); }
});

test("comment-only .gitignore passes (presence is the contract) with zero entries", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), "# nothing ignored yet\n");
    const result = checkGitignore(dir);
    assert.equal(result.ok, true);
    assert.equal(result.entryCount, 0);
    assert.equal(runGate(["--root", dir, "--quiet"]).status, 0);
  } finally { rm(dir); }
});

test("default root is the working directory", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
    assert.equal(runGate(["--quiet"], { cwd: dir }).status, 0);
  } finally { rm(dir); }
});

test("nonexistent --root fails loud (exit 2)", () => {
  assert.equal(runGate(["--root", path.join(os.tmpdir(), "gig-does-not-exist"), "--quiet"]).status, 2);
});

test("invalid usage fails loud (exit 2), never a silently weaker run", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
    assert.equal(runGate(["--root", dir, "--format", "yaml"]).status, 2, "unknown --format");
    assert.equal(runGate(["--root", dir, "--format="]).status, 2, "empty --format value");
    assert.equal(runGate(["--root", dir, "--format"]).status, 2, "bare --format without a value");
    assert.equal(runGate(["--root"]).status, 2, "bare --root without a value");
    assert.equal(runGate(["--root="]).status, 2, "empty --root value");
    assert.equal(runGate(["--root", "--quiet"]).status, 2, "--root consuming a flag as value");
    assert.equal(runGate(["--root", dir, "--frmat", "json"]).status, 2, "unknown flag");
    assert.equal(runGate(["--quiet", dir]).status, 2, "operand after a boolean flag");
    assert.equal(runGate(["--quiet=1", "--root", dir]).status, 2, "value on a boolean flag");
    assert.equal(runGate([dir]).status, 2, "positional argument");
  } finally { rm(dir); }
});

test("json format reports gate version, status, and entry count", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
    const res = runGate(["--root", dir, "--format", "json"]);
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.equal(out.status, "ok");
    assert.equal(out.entryCount, 1);
    assert.ok(out.gateVersion, "should report a gate version");
  } finally { rm(dir); }
});

test("the org baseline template itself satisfies the gate", () => {
  const dir = tmpDir();
  try {
    fs.copyFileSync(BASELINE, path.join(dir, ".gitignore"));
    const result = checkGitignore(dir);
    assert.equal(result.ok, true);
    assert.ok(result.entryCount >= 15, `baseline should carry real entries, got ${result.entryCount}`);
  } finally { rm(dir); }
});

test("countEntries skips blanks, comments, and CRLF padding", () => {
  assert.equal(countEntries("# a\r\n\r\nnode_modules/\r\n  \t\r\n*.log\r\n"), 2);
  assert.equal(countEntries("   # indented comment\n"), 0);
  assert.equal(countEntries("!keep-me\n"), 1);
});
