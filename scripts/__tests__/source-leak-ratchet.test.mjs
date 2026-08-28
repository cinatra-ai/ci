import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
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
// The ratchet suite tests the RATCHET, so it always runs the gate offline: an
// ambient GH_TOKEN in the environment would otherwise switch the visibility
// probe on and make these outcomes depend on the network.
function gateEnv(base, extra = {}) {
  return { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "", TESTBASE: base || "", ...extra };
}
function runGate(dir, base, extraArgs) {
  const res = spawnSync(
    "node",
    [SCANNER, "--exit-on-match", "--quiet", "--diff-base-env", "TESTBASE", ...extraArgs],
    { cwd: dir, encoding: "utf8", env: gateEnv(base) },
  );
  return res.status;
}
// ASYNC on purpose: the probe tests answer the gate's API calls from a stub
// server running in THIS process, so a synchronous spawn would block the event
// loop and deadlock against the child waiting for a reply.
const execFileAsync = promisify(execFile);
async function runGateJson(dir, base, extraArgs, env = {}) {
  const { stdout } = await execFileAsync(
    "node",
    [SCANNER, "--format", "json", "--diff-base-env", "TESTBASE", ...extraArgs],
    { cwd: dir, encoding: "utf8", env: gateEnv(base, env), maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
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

// A localhost stand-in for the GitHub API, so the probe's end-to-end wiring is
// exercised by a real subprocess without a network call. Names are answered from
// a table; anything unlisted 404s, exactly as a private repository does to a
// token without access.
async function withApiStub(table, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split("/").pop());
    seen.push(name);
    const entry = table[name];
    res.writeHead(entry ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(entry ? { private: entry.private } : { message: "Not Found" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    // The gate's fetch keeps its sockets alive; close() alone would wait for them.
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test("probe (end to end): public clears, private blocks, and each reference is reported ONCE", async () => {
  const dir = setupRepo();
  try {
    commit(dir, {
      "note.ts": [
        'const a = "cinatra-ai/a-public-repo";',
        'const b = "cinatra-ai/a-private-repo";',
        'const c = "cinatra-ai/never-heard-of-it";',
        'import x from "@cinatra-ai/a-private-repo";',
        'const d = "cinatra-ai/ops";',
      ].join("\n") + "\n",
    }, "init");

    await withApiStub(
      { "a-public-repo": { private: false }, "a-private-repo": { private: true } },
      async (apiBase, seen) => {
        const out = await runGateJson(dir, "", ["--ratchet-mode", "off", "--probe", "--api-base", apiBase], {});
        const probe = out.samples.filter((f) => f.rule.startsWith("SLG_PRIVATE_REPO_PROBE"));
        const matches = probe.map((f) => f.match).sort();
        // In `off` mode the gated list and the total list are the same array —
        // a merge that mutated one would report every reference twice.
        assert.deepEqual(matches, ["cinatra-ai/a-private-repo", "cinatra-ai/never-heard-of-it"]);
        assert.equal(out.perRule.SLG_PRIVATE_REPO_PROBE, 2);
        // The npm scope was never nominated; the functional target was never probed.
        assert.deepEqual(seen.sort(), ["a-private-repo", "a-public-repo", "never-heard-of-it"]);
      },
    );
  } finally { rm(dir); }
});

test("probe (end to end): an unreachable API is fail-closed, never a pass", async () => {
  const dir = setupRepo();
  try {
    commit(dir, { "note.ts": 'const a = "cinatra-ai/a-public-repo";\n' }, "init");
    // Port 1 on loopback refuses instantly.
    const out = await runGateJson(dir, "", ["--ratchet-mode", "off", "--probe", "--api-base", "http://127.0.0.1:1"], {});
    assert.equal(out.perRule.SLG_PRIVATE_REPO_PROBE_ERROR, 1);
    assert.equal(out.perRule.SLG_PRIVATE_REPO_PROBE, undefined);
  } finally { rm(dir); }
});

test("probe (end to end): no token means OFFLINE — the built-in list only, and no calls", async () => {
  const dir = setupRepo();
  try {
    commit(dir, {
      "note.ts": [
        'const a = "cinatra-ai/never-heard-of-it";',
        'const b = "cinatra-ai/engineering-proofs-private";',
        'const c = "cinatra-ai/engineering-proofs";',
      ].join("\n") + "\n",
    }, "init");
    await withApiStub({}, async (apiBase, seen) => {
      const out = await runGateJson(dir, "", ["--ratchet-mode", "off", "--api-base", apiBase], {});
      const ids = out.samples.map((f) => f.rule);
      // The offline list still catches the private twin, and leaves the public one.
      assert.deepEqual(ids, ["SLG_PRIVATE_REPO_REF"]);
      assert.equal(out.samples[0].match, "cinatra-ai/engineering-proofs-private");
      assert.deepEqual(seen, [], "an offline run must not call the API at all");
    });
  } finally { rm(dir); }
});

test("probe (end to end): --offline forces the built-in list even WITH a token", async () => {
  const dir = setupRepo();
  try {
    commit(dir, { "note.ts": 'const a = "cinatra-ai/never-heard-of-it";\n' }, "init");
    await withApiStub({}, async (apiBase, seen) => {
      const out = await runGateJson(
        dir, "",
        ["--ratchet-mode", "off", "--offline", "--api-base", apiBase],
        { GH_TOKEN: "t0ken" },
      );
      assert.equal(out.gatedFindings, 0);
      assert.deepEqual(seen, []);
    });
  } finally { rm(dir); }
});

test("probe (end to end): the line ratchet bounds the probe to gated lines", async () => {
  const dir = setupRepo();
  try {
    const base = commit(dir, { "note.ts": 'const old = "cinatra-ai/pre-existing-repo";\n' }, "init");
    commit(dir, {
      "note.ts": 'const old = "cinatra-ai/pre-existing-repo";\nconst fresh = "cinatra-ai/newly-added-repo";\n',
    }, "add a line");
    await withApiStub({}, async (apiBase, seen) => {
      const out = await runGateJson(dir, base, ["--ratchet-mode", "line", "--probe", "--api-base", apiBase], {});
      assert.equal(out.gatedFindings, 1);
      assert.equal(out.samples[0].match, "cinatra-ai/newly-added-repo");
      assert.deepEqual(seen, ["newly-added-repo"], "the untouched line costs no API call");
    });
  } finally { rm(dir); }
});
