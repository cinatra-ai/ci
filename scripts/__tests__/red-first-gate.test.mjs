import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "../lib/vendor/js-yaml/js-yaml.mjs";

// red-first-gate proves that the tests a pull request adds or changes fail on
// the code before the fix (for the right reason) and pass with the fix. These
// cases run the gate end to end on throwaway git repositories with real
// `node --test` runs, plus a stand-in for vitest that writes vitest's JSON
// report. Every failure mode must end RED (or SKIP) with a named reason; only a
// proven red-to-green run may PASS.

const SCRIPTS = path.join(import.meta.dirname, "..");
const ROOT = path.join(SCRIPTS, "..");
const GATE = path.join(SCRIPTS, "red-first-gate.mjs");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "red-first-gate.yml");
const SELF_CHECK = path.join(ROOT, ".github", "workflows", "self-check.yml");

const ENV = { ...process.env };
for (const key of Object.keys(ENV)) {
  if (key.startsWith("GIT_") || key.startsWith("GITHUB_") || key === "NODE_TEST_CONTEXT" || key === "NODE_OPTIONS") {
    delete ENV[key];
  }
}
Object.assign(ENV, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});

async function gateModule() {
  assert.ok(fs.existsSync(GATE), "scripts/red-first-gate.mjs is missing");
  return import(pathToFileURL(GATE).href);
}

function git(repo, ...args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: ENV });
  if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function writeFiles(repo, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(repo, rel);
    if (content === null) {
      fs.rmSync(file, { force: true });
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
}

function commitAll(repo, message) {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

// A repository with a base commit and a pull request head commit on top of it.
function scenario(t, { base, head, mainAfter }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "red-first-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFiles(repo, base);
  const baseSha = commitAll(repo, "base");
  git(repo, "checkout", "-q", "-b", "pr");
  writeFiles(repo, head);
  const headSha = commitAll(repo, "head");
  let tipSha = baseSha;
  if (mainAfter) {
    git(repo, "checkout", "-q", "main");
    writeFiles(repo, mainAfter);
    tipSha = commitAll(repo, "main moves on");
  }
  return { root, repo, base: tipSha, head: headSha, runs: 0 };
}

function runGate(sc, mode, extra = [], env = {}) {
  sc.runs += 1;
  const verdictFile = path.join(sc.root, `verdict-${sc.runs}.json`);
  const args = [GATE, mode, "--repo", sc.repo, "--base", sc.base, "--head", sc.head, "--verdict", verdictFile];
  if (mode === "run") args.push("--work", path.join(sc.root, `work-${sc.runs}`));
  const r = spawnSync(process.execPath, [...args, ...extra], { encoding: "utf8", env: { ...ENV, ...env }, timeout: 180_000 });
  const verdict = fs.existsSync(verdictFile) ? JSON.parse(fs.readFileSync(verdictFile, "utf8")) : null;
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", verdict };
}

function codes(result) {
  assert.ok(result.verdict, `no verdict file (exit ${result.code}): ${result.stderr.slice(0, 400)}`);
  return result.verdict.reasons.map((r) => r.code);
}

function assertRed(result, code) {
  assert.ok(result.verdict, `no verdict file (exit ${result.code}): ${result.stderr.slice(0, 400)}`);
  assert.equal(result.verdict.verdict, "RED", `expected RED, got ${result.verdict.verdict}: ${result.stdout.slice(-600)}`);
  assert.equal(result.code, 1);
  assert.ok(codes(result).includes(code), `expected reason ${code}, got ${codes(result).join(", ")}`);
  assert.doesNotMatch(result.stdout, /^RED-FIRST: PASS/m);
}

function assertPass(result) {
  assert.ok(result.verdict, `no verdict file (exit ${result.code}): ${result.stderr.slice(0, 400)}`);
  assert.deepEqual(codes(result), [], result.stdout.slice(-800));
  assert.equal(result.verdict.verdict, "PASS");
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^RED-FIRST: PASS/m);
}

const CALC_BUG = "export function add(a, b) {\n  return a - b;\n}\nexport function mul(a, b) {\n  return a * b;\n}\n";
const CALC_FIX = CALC_BUG.replace("a - b", "a + b");
const TEST_HEAD = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\n';
const ADD_TEST = `${TEST_HEAD}import { add } from "../src/calc.mjs";\n\ntest("add sums two numbers", () => {\n  assert.equal(add(1, 2), 3);\n});\n`;
const BASE = { "src/calc.mjs": CALC_BUG, "package.json": '{ "type": "module" }\n' };

// ---------------------------------------------------------------------------
// End to end with node:test
// ---------------------------------------------------------------------------

test("good: a new test fails by assertion before the fix and passes with it", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
  const summary = path.join(sc.root, "summary.md");
  const r = runGate(sc, "run", ["--summary", summary]);
  assertPass(r);
  assert.equal(r.verdict.files.length, 1);
  assert.equal(r.verdict.files[0].file, "test/calc.test.mjs");
  assert.equal(r.verdict.files[0].runner, "node");
  assert.equal(r.verdict.files[0].proven, true);
  assert.match(fs.readFileSync(summary, "utf8"), /red-first-gate: PASS[\s\S]*test\/calc\.test\.mjs/);
});

test("the tree before the fix is the merge base plus the tests, not the moved base tip", async (t) => {
  // main fixed the bug on its own after the branch point; with the base tip as
  // "before" the new test would already pass there.
  const sc = scenario(t, {
    base: BASE,
    head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST },
    mainAfter: { "src/calc.mjs": CALC_FIX, "NOTES.md": "fixed on main\n" },
  });
  assertPass(runGate(sc, "run"));
});

test("vacuous: a new test that already passes before the fix is RED (NOT-RED-BEFORE)", async (t) => {
  const mulTest = `${TEST_HEAD}import { mul } from "../src/calc.mjs";\n\ntest("mul multiplies", () => {\n  assert.equal(mul(2, 3), 6);\n});\n`;
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/mul.test.mjs": mulTest } });
  assertRed(runGate(sc, "run"), "NOT-RED-BEFORE");
});

test("vacuous: a pull request without a new test is skipped by plan and never passes in run", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX } });
  const plan = runGate(sc, "plan");
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.equal(plan.code, 0);
  assert.equal(plan.verdict.verdict, "skip");
  assert.equal(plan.verdict.reason, "NO-NEW-TESTS");
  const run = runGate(sc, "run");
  assert.ok(run.verdict, `no run verdict (exit ${run.code}): ${run.stderr.slice(0, 400)}`);
  assert.equal(run.verdict.verdict, "SKIP");
  assert.equal(run.verdict.reason, "NO-NEW-TESTS");
  assert.equal(run.code, 3, "a skip must never exit 0");
  assert.doesNotMatch(run.stdout, /^RED-FIRST: PASS/m);
});

test("a pull request that only adds tests is skipped (TESTS-ONLY): there is no fix to prove", async (t) => {
  const sc = scenario(t, { base: { ...BASE, "src/calc.mjs": CALC_FIX }, head: { "test/calc.test.mjs": ADD_TEST } });
  const plan = runGate(sc, "plan");
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.equal(plan.verdict.verdict, "skip");
  assert.equal(plan.verdict.reason, "TESTS-ONLY");
  assert.equal(runGate(sc, "run").code, 3);
});

test("plan says run for a pull request with a new test and a fix", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
  const out = path.join(sc.root, "github-output.txt");
  const plan = runGate(sc, "plan", ["--github-output", out]);
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.equal(plan.code, 0);
  assert.equal(plan.verdict.verdict, "run");
  assert.deepEqual(plan.verdict.newTests, ["test/calc.test.mjs"]);
  assert.ok(fs.existsSync(out), "no GitHub output written");
  assert.match(fs.readFileSync(out, "utf8"), /^verdict=run$/m);
});

test("repeat case (2): an install that stops before any test runs is RED (INSTALL-FAILED before)", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
  const r = runGate(sc, "run", ["--install", "echo installing; exit 7"]);
  assertRed(r, "INSTALL-FAILED");
  assert.equal(r.verdict.reasons.find((x) => x.code === "INSTALL-FAILED").phase, "before");
});

test("repeat case (2): an install that stops in the head tree is RED (INSTALL-FAILED head)", async (t) => {
  const sc = scenario(t, {
    base: { ...BASE, "tools/install.mjs": "process.exit(0);\n" },
    head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST, "tools/install.mjs": "process.exit(4);\n" },
  });
  const r = runGate(sc, "run", ["--install", `'${process.execPath}' tools/install.mjs`]);
  assertRed(r, "INSTALL-FAILED");
  assert.equal(r.verdict.reasons.find((x) => x.code === "INSTALL-FAILED").phase, "head");
});

test("an install that rewrites a test file is RED (TEST-CHANGED): the tests that ran are not the pull request's", async (t) => {
  const passing = `${TEST_HEAD}test("add sums two numbers", () => {\n  assert.ok(true);\n});\n`;
  const sc = scenario(t, {
    base: { ...BASE, "tools/install.mjs": "process.exit(0);\n" },
    head: {
      "test/calc.test.mjs": ADD_TEST,
      "tools/install.mjs": `import { writeFileSync } from "node:fs";\nwriteFileSync("test/calc.test.mjs", ${JSON.stringify(passing)});\n`,
    },
  });
  const r = runGate(sc, "run", ["--install", `'${process.execPath}' tools/install.mjs`]);
  assertRed(r, "TEST-CHANGED");
  assert.equal(r.verdict.reasons.find((x) => x.code === "TEST-CHANGED").phase, "head");
});

for (const [how, extra] of [
  ["staged", 'spawnSync("git", ["add", "test/calc.test.mjs"]);'],
  ["committed", 'spawnSync("git", ["add", "test/calc.test.mjs"]);\nspawnSync("git", ["commit", "-q", "--no-verify", "-m", "swap"]);'],
]) {
  test(`an install that rewrites a test file and leaves it ${how} is RED (TEST-CHANGED)`, async (t) => {
    const passing = `${TEST_HEAD}test("add sums two numbers", () => {\n  assert.ok(true);\n});\n`;
    const sc = scenario(t, {
      base: { ...BASE, "tools/install.mjs": "process.exit(0);\n" },
      head: {
        "test/calc.test.mjs": ADD_TEST,
        "tools/install.mjs": `import { writeFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nwriteFileSync("test/calc.test.mjs", ${JSON.stringify(passing)});\n${extra}\n`,
      },
    });
    const r = runGate(sc, "run", ["--install", `'${process.execPath}' tools/install.mjs`]);
    assertRed(r, "TEST-CHANGED");
    assert.equal(r.verdict.reasons.find((x) => x.code === "TEST-CHANGED").phase, "head");
    assert.equal(r.verdict.reasons.find((x) => x.code === "TEST-CHANGED").file, "test/calc.test.mjs");
  });
}

test("repeat case (3): a test file that never loads is RED (LOAD-ERROR), never counted as failing first", async (t) => {
  const broken = `${TEST_HEAD}import { add } from "../src/calculator.mjs";\n\ntest("add sums two numbers", () => {\n  assert.equal(add(1, 2), 3);\n});\n`;
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": broken } });
  const r = runGate(sc, "run");
  assertRed(r, "LOAD-ERROR");
  const phases = r.verdict.reasons.filter((x) => x.code === "LOAD-ERROR").map((x) => x.phase).sort();
  assert.deepEqual(phases, ["before", "head"]);
  assert.match(r.verdict.reasons.find((x) => x.code === "LOAD-ERROR").detail, /Cannot find module|ERR_MODULE_NOT_FOUND/);
});

const SUM_FILE_TEST = `${TEST_HEAD}import { sum } from "../src/sum.mjs";\n\ntest("sum adds", () => {\n  assert.equal(sum(1, 2), 3);\n});\n`;

test("repeat case (3): a test file that loads only with the fix is proven only when the load error names a module the fix adds", async (t) => {
  const sc = scenario(t, {
    base: BASE,
    head: { "src/calc.mjs": CALC_FIX, "src/sum.mjs": 'export { add as sum } from "./calc.mjs";\n', "test/sum.test.mjs": SUM_FILE_TEST },
  });
  const r = runGate(sc, "run");
  assertPass(r);
  assert.deepEqual(r.verdict.notes.map((n) => `${n.code}:${n.file}`), ["ADDED-BY-FIX:test/sum.test.mjs"]);
  assert.match(r.verdict.notes[0].detail, /the module src\/sum\.mjs is not there yet/);
});

test("repeat case (3): a load error before the fix that names nothing the fix adds stays RED (LOAD-ERROR), also when the file loads with the fix", async (t) => {
  // The file throws while it loads unless the fix is there: no module and no
  // export of the fix side is named, so this is not a red-first failure.
  const guarded = `${TEST_HEAD}import { existsSync } from "node:fs";\nimport { add } from "../src/calc.mjs";\n\nif (!existsSync(new URL("../src/FIXED", import.meta.url))) throw new Error("the setup is not ready");\ntest("add sums two numbers", () => {\n  assert.equal(add(1, 2), 3);\n});\n`;
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "src/FIXED": "", "test/calc.test.mjs": guarded } });
  const r = runGate(sc, "run");
  assertRed(r, "LOAD-ERROR");
  assert.deepEqual(r.verdict.reasons.map((x) => `${x.code}:${x.phase}`), ["LOAD-ERROR:before"]);
});

test("a module that exists before the fix is no evidence: a load error naming it stays RED (LOAD-ERROR)", async (t) => {
  // src/sum.mjs is there before the fix and the fix changes it; the test file
  // imports a path beside it that nothing adds.
  const sc = scenario(t, {
    base: { ...BASE, "src/sum.mjs": "export const sum = (a, b) => a - b;\n" },
    head: { "src/sum.mjs": "export const sum = (a, b) => a + b;\n", "test/sum.test.mjs": SUM_FILE_TEST.replace("../src/sum.mjs", "../src/sums.mjs") },
  });
  assertRed(runGate(sc, "run"), "LOAD-ERROR");
});

test("a named import of an export the fix adds: the load error before names it, and the file is proven", async (t) => {
  const named = `${TEST_HEAD}import { sum } from "../src/calc.mjs";\n\ntest("sum adds", () => {\n  assert.equal(sum(1, 2), 3);\n});\n`;
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": `${CALC_BUG}export function sum(a, b) {\n  return a + b;\n}\n`, "test/sum.test.mjs": named } });
  const r = runGate(sc, "run");
  assertPass(r);
  assert.match(r.verdict.notes[0].detail, /the export sum is not there yet/);
});

test("a module the fix adds: imported inside the test with a marker, the failure before is a test failure and is proven", async (t) => {
  const sumTest = `${TEST_HEAD}// red-first-expect: Cannot find module\n\ntest("sum adds", async () => {\n  const { sum } = await import("../src/sum.mjs");\n  assert.equal(sum(1, 2), 3);\n});\n`;
  const sc = scenario(t, {
    base: BASE,
    head: { "src/calc.mjs": CALC_FIX, "src/sum.mjs": 'export { add as sum } from "./calc.mjs";\n', "test/sum.test.mjs": sumTest },
  });
  assertPass(runGate(sc, "run"));
});

test("repeat case (3): a test file that collects no test is RED (NOT-COLLECTED)", async (t) => {
  const empty = `${TEST_HEAD}import { add } from "../src/calc.mjs";\n\nvoid add;\n`;
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": empty } });
  assertRed(runGate(sc, "run"), "NOT-COLLECTED");
});

test("repeat case (1): a marker that does not match the tool's wording is RED and shows the actual text", async (t) => {
  const marked = ADD_TEST.replace(TEST_HEAD, `${TEST_HEAD}// red-first-expect: expected 2 to equal 3\n`);
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": marked } });
  const r = runGate(sc, "run");
  assertRed(r, "TEXT-MISMATCH");
  const reason = r.verdict.reasons.find((x) => x.code === "TEXT-MISMATCH");
  assert.match(reason.detail, /expected 2 to equal 3/);
  assert.match(reason.detail, /Expected values to be strictly equal/);
});

test("a marker that matches the failure text proves a non-assertion failure", async (t) => {
  const sumTest = `${TEST_HEAD}// red-first-expect: calc.sum is not a function\nimport * as calc from "../src/calc.mjs";\n\ntest("sum adds", () => {\n  assert.equal(calc.sum(1, 2), 3);\n});\n`;
  const sc = scenario(t, {
    base: BASE,
    head: { "src/calc.mjs": `${CALC_BUG}export function sum(a, b) {\n  return a + b;\n}\n`, "test/sum.test.mjs": sumTest },
  });
  assertPass(runGate(sc, "run"));
});

const SUM_CALL_TEST = `${TEST_HEAD}import * as calc from "../src/calc.mjs";\n\ntest("sum adds", () => {\n  assert.equal(calc.sum(1, 2), 3);\n});\n`;

test("a call of an export the fix adds fails before with a TypeError that names it: proven without a marker, with a note", async (t) => {
  const sc = scenario(t, {
    base: BASE,
    head: { "src/calc.mjs": `${CALC_BUG}export function sum(a, b) {\n  return a + b;\n}\n`, "test/sum.test.mjs": SUM_CALL_TEST },
  });
  const r = runGate(sc, "run");
  assertPass(r);
  assert.deepEqual(r.verdict.notes.map((n) => n.code), ["ADDED-BY-FIX"]);
  assert.match(r.verdict.notes[0].detail, /the export sum is not there yet/);
});

test("a non-assertion failure without a marker is RED (WRONG-REASON) when it names nothing the fix adds", async (t) => {
  // The fix adds the export sum. The test fails before with a TypeError about
  // a helper of its own (tools.format), which the fix does not add.
  const unrelated = `${TEST_HEAD}import { existsSync } from "node:fs";\nimport * as calc from "../src/calc.mjs";\n\nconst tools = existsSync(new URL("../src/FIXED", import.meta.url)) ? { format: (n) => n } : {};\ntest("sum adds", () => {\n  assert.equal(tools.format(calc.sum(1, 2)), 3);\n});\n`;
  const sc = scenario(t, {
    base: { ...BASE, "src/calc.mjs": `${CALC_BUG}export function sum(a, b) {\n  return a + b;\n}\n` },
    head: { "src/calc.mjs": `${CALC_FIX}export function sum(a, b) {\n  return a + b;\n}\nexport function total(list) {\n  return list.length;\n}\n`, "src/FIXED": "", "test/sum.test.mjs": unrelated },
  });
  const r = runGate(sc, "run");
  assertRed(r, "WRONG-REASON");
  assert.match(r.verdict.reasons.find((x) => x.code === "WRONG-REASON").detail, /TypeError: tools\.format is not a function/);
});

test("an export whose line the fix only changes is not a new export: the TypeError stays RED (WRONG-REASON)", async (t) => {
  // calc.sum exists before the fix as a number, so the call throws; the fix
  // rewrites that export line. Nothing is added: no evidence.
  const sc = scenario(t, {
    base: { ...BASE, "src/calc.mjs": `${CALC_BUG}export const sum = 0;\n` },
    head: { "src/calc.mjs": `${CALC_BUG}export const sum = (a, b) => a + b;\n`, "test/sum.test.mjs": SUM_CALL_TEST },
  });
  assertRed(runGate(sc, "run"), "WRONG-REASON");
});

test("a fix that does not make the new test pass is RED (NOT-GREEN-AT-HEAD)", async (t) => {
  const sc = scenario(t, {
    base: BASE,
    head: { "src/calc.mjs": CALC_BUG.replace("a - b", "a * b"), "test/calc.test.mjs": ADD_TEST },
  });
  assertRed(runGate(sc, "run"), "NOT-GREEN-AT-HEAD");
});

test("a test that failed before must pass at head, not be skipped there", async (t) => {
  const skipping = `${TEST_HEAD}import { existsSync } from "node:fs";\nimport { add, mul } from "../src/calc.mjs";\n\nconst fixed = existsSync(new URL("../src/FIXED", import.meta.url));\ntest("add sums two numbers", { skip: fixed }, () => {\n  assert.equal(add(1, 2), 3);\n});\ntest("mul multiplies", () => {\n  assert.equal(mul(2, 3), 6);\n});\n`;
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "src/FIXED": "", "test/calc.test.mjs": skipping } });
  const r = runGate(sc, "run");
  assertRed(r, "NOT-GREEN-AT-HEAD");
  assert.match(r.verdict.reasons.find((x) => x.code === "NOT-GREEN-AT-HEAD").detail, /add sums two numbers/);
});

test("a test file that errors after its tests at head is RED (FILE-ERROR)", async (t) => {
  const late = `${ADD_TEST}import { existsSync } from "node:fs";\nif (existsSync(new URL("../src/FIXED", import.meta.url))) setTimeout(() => { throw new Error("late failure"); }, 5);\n`;
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "src/FIXED": "", "test/calc.test.mjs": late } });
  const r = runGate(sc, "run");
  assertRed(r, "FILE-ERROR");
  assert.equal(r.verdict.reasons.find((x) => x.code === "FILE-ERROR").phase, "head");
});

test("a new test file matching --exclude beside a unit test is a note, not a red: the unit test decides", async (t) => {
  const sc = scenario(t, {
    base: BASE,
    head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST, "e2e/flow.spec.mjs": `${TEST_HEAD}test("flow", () => {});\n` },
  });
  const summary = path.join(sc.root, "summary.md");
  const r = runGate(sc, "run", ["--exclude", "e2e/**", "--summary", summary]);
  assertPass(r);
  assert.deepEqual(r.verdict.files.map((f) => f.file), ["test/calc.test.mjs"]);
  assert.deepEqual(r.verdict.notes.map((n) => `${n.code} ${n.file}`), ["EXCLUDED e2e/flow.spec.mjs"]);
  assert.match(r.stdout, /^NOTE EXCLUDED plan e2e\/flow\.spec\.mjs: /m);
  assert.match(r.stdout, /^RED-FIRST: PASS \(1 new test file\(s\) fail before the fix and pass with it; 1 excluded new test file\(s\) not proven here\)/m);
  assert.match(fs.readFileSync(summary, "utf8"), /note `EXCLUDED` e2e\/flow\.spec\.mjs: /);
});

test("a unit test beside an excluded test still has to be red first: the excluded file hides nothing", async (t) => {
  const mulTest = `${TEST_HEAD}import { mul } from "../src/calc.mjs";\n\ntest("mul multiplies", () => {\n  assert.equal(mul(2, 3), 6);\n});\n`;
  const sc = scenario(t, {
    base: BASE,
    head: { "src/calc.mjs": CALC_FIX, "test/mul.test.mjs": mulTest, "e2e/flow.spec.mjs": `${TEST_HEAD}test("flow", () => {});\n` },
  });
  assertRed(runGate(sc, "run", ["--exclude", "e2e/**"]), "NOT-RED-BEFORE");
});

test("e2e and database tests without a unit test: neutral (skipped) with its reason, never red", async (t) => {
  const sc = scenario(t, {
    base: BASE,
    head: {
      "src/calc.mjs": CALC_FIX,
      "tests/e2e/flow.spec.mjs": `${TEST_HEAD}test("flow", () => {});\n`,
      "src/calc.integration.test.mjs": `${TEST_HEAD}test("db", () => {});\n`,
    },
  });
  const exclude = ["--exclude", "tests/e2e/**/*.spec.*, **/*.integration.test.*"];
  const out = path.join(sc.root, "github-output.txt");
  const summary = path.join(sc.root, "summary.md");
  const plan = runGate(sc, "plan", [...exclude, "--github-output", out, "--summary", summary]);
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.equal(plan.code, 0);
  assert.equal(plan.verdict.verdict, "skip");
  assert.equal(plan.verdict.reason, "EXCLUDED-ONLY");
  assert.deepEqual(plan.verdict.excluded, ["src/calc.integration.test.mjs", "tests/e2e/flow.spec.mjs"]);
  assert.match(fs.readFileSync(out, "utf8"), /^verdict=skip\nreason=EXCLUDED-ONLY\nnew_tests=2\nexcluded=2$/m);
  assert.match(fs.readFileSync(summary, "utf8"), /skip EXCLUDED-ONLY: .*neutral \(skipped\), not red/);
  const run = runGate(sc, "run", exclude);
  assert.ok(run.verdict, `no run verdict (exit ${run.code}): ${run.stderr.slice(0, 400)}`);
  assert.equal(run.verdict.verdict, "SKIP");
  assert.equal(run.verdict.reason, "EXCLUDED-ONLY");
  assert.equal(run.code, 3, "a skip must never exit 0");
});

test("a pull request whose only new tests match --exclude is skipped (EXCLUDED-ONLY), never passed", async (t) => {
  const sc = scenario(t, {
    base: BASE,
    head: { "src/calc.mjs": CALC_FIX, "e2e/flow.spec.mjs": `${TEST_HEAD}test("flow", () => {});\n` },
  });
  const plan = runGate(sc, "plan", ["--exclude", "e2e/**"]);
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.equal(plan.verdict.verdict, "skip");
  assert.equal(plan.verdict.reason, "EXCLUDED-ONLY");
  const run = runGate(sc, "run", ["--exclude", "e2e/**"]);
  assert.ok(run.verdict, `no run verdict (exit ${run.code}): ${run.stderr.slice(0, 400)}`);
  assert.equal(run.verdict.verdict, "SKIP");
  assert.equal(run.code, 3, "a skip must never exit 0");
});

test("the tree before the fix carries the pull request's test support files", async (t) => {
  const fixtureTest = `${TEST_HEAD}import { add } from "../src/calc.mjs";\nimport { CASES } from "./__fixtures__/cases.mjs";\n\ntest("add matches every case", () => {\n  for (const [a, b, sum] of CASES) assert.equal(add(a, b), sum);\n});\n`;
  const sc = scenario(t, {
    base: BASE,
    head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": fixtureTest, "test/__fixtures__/cases.mjs": "export const CASES = [[1, 2, 3], [2, 2, 4]];\n" },
  });
  assertPass(runGate(sc, "run"));
});

test("a deleted old test file is dropped from the tree before the fix too", async (t) => {
  const old = `${TEST_HEAD}import { mul } from "../src/calc.mjs";\n\ntest("mul multiplies", () => {\n  assert.equal(mul(2, 3), 6);\n});\n`;
  const sc = scenario(t, {
    base: { ...BASE, "test/old.test.mjs": old },
    head: { "src/calc.mjs": CALC_FIX, "test/old.test.mjs": null, "test/calc.test.mjs": ADD_TEST },
  });
  const r = runGate(sc, "run");
  assertPass(r);
  assert.deepEqual(r.verdict.files.map((f) => f.file), ["test/calc.test.mjs"]);
});

test("an install that does not finish in time is RED (TIMEOUT)", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
  const r = runGate(sc, "run", ["--install", "sleep 5", "--timeout-seconds", "1"]);
  assertRed(r, "TIMEOUT");
  assert.equal(r.verdict.reasons.find((x) => x.code === "TIMEOUT").phase, "before");
});

test("the job's time budget ends a slow install with TIMEOUT before the job limit", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
  // A 3-minute job that started 57 s ago, less the 120 s reserve, leaves about
  // 3 s of budget.
  const started = Math.floor(Date.now() / 1000) - 57;
  const t0 = Date.now();
  const r = runGate(sc, "run", ["--install", "sleep 20", "--job-started", String(started), "--job-minutes", "3"]);
  assertRed(r, "TIMEOUT");
  assert.ok(Date.now() - t0 < 15_000, "the install ran past the job's budget");
  assert.match(r.verdict.reasons.find((x) => x.code === "TIMEOUT").detail, /job's time budget/);
});

test("a job budget already spent stops with TIMEOUT before the install runs", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
  const mark = path.join(sc.root, "install-ran");
  // A 3-minute job that started 10 minutes ago: its budget is spent.
  const r = runGate(sc, "run", ["--install", `touch '${mark}'`, "--job-started", String(Math.floor(Date.now() / 1000) - 600), "--job-minutes", "3"]);
  assertRed(r, "TIMEOUT");
  // Every step after the budget is spent is refused, from the first git call
  // on (finding 6 of review 2), so the install is never reached.
  assert.match(r.verdict.reasons.find((x) => x.code === "TIMEOUT").detail, /time budget was spent before (the install|git )/);
  assert.equal(fs.existsSync(mark), false, "the install ran although the budget was spent");
});

test("run refuses a job budget given by halves or not as numbers, and a step limit beyond a day", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
  for (const extra of [["--job-started", "100"], ["--job-minutes", "5"], ["--job-started", "x", "--job-minutes", "5"], ["--job-started", "100", "--job-minutes", "0"], ["--timeout-seconds", "86401"], ["--timeout-seconds", "0"]]) {
    assert.equal(runGate(sc, "run", extra).code, 2, extra.join(" "));
  }
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

for (const [label, install, extra, code] of [
  // The background process lets go of the output pipes, so nothing waits for
  // it but the gate's own process-group kill.
  ["exits", "sleep 60 </dev/null >/dev/null 2>&1 & echo $! > \"$PIDFILE\"", [], null],
  ["times out", "sleep 60 </dev/null >/dev/null 2>&1 & echo $! > \"$PIDFILE\"; wait", ["--timeout-seconds", "1"], "TIMEOUT"],
]) {
  test(`a background process of the install is killed when the install ${label}`, async (t) => {
    const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
    const pidFile = path.join(sc.root, "bg.pid");
    let pid = 0;
    t.after(() => {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    });
    const r = runGate(sc, "run", ["--install", install, ...extra], { PIDFILE: pidFile });
    assert.ok(fs.existsSync(pidFile), `the install did not start: ${r.stderr.slice(0, 400)}`);
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(pid > 0);
    if (code) assertRed(r, code);
    else assertPass(r);
    assert.ok(await goneWithin(pid, 3000), "a background process of the install outlived the gate");
  });
}

test("a run removes its trees and reports, so the same work folder serves the next run", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
  const work = path.join(sc.root, "fixed-work");
  for (let i = 1; i <= 2; i += 1) {
    const verdictFile = path.join(sc.root, `fixed-${i}.json`);
    const r = spawnSync(process.execPath, [GATE, "run", "--repo", sc.repo, "--base", sc.base, "--head", sc.head, "--work", work, "--verdict", verdictFile], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 0, `run ${i}: ${r.stdout.slice(-400)} ${r.stderr.slice(-400)}`);
    assert.equal(JSON.parse(fs.readFileSync(verdictFile, "utf8")).verdict, "PASS");
    assert.ok(!fs.existsSync(work) || fs.readdirSync(work).length === 0, `run ${i} left ${fs.existsSync(work) ? fs.readdirSync(work).join(", ") : ""}`);
    assert.equal(git(sc.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, `run ${i} left a worktree registration`);
  }
  // A work folder that existed (empty) before the run is kept, empty.
  fs.mkdirSync(work);
  const r = spawnSync(process.execPath, [GATE, "run", "--repo", sc.repo, "--base", sc.base, "--head", sc.head, "--work", work], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.deepEqual(fs.readdirSync(work), []);
});

test("a changed existing test file must also fail first", async (t) => {
  const old = `${TEST_HEAD}import { mul } from "../src/calc.mjs";\n\ntest("mul multiplies", () => {\n  assert.equal(mul(2, 3), 6);\n});\n`;
  const sc = scenario(t, {
    base: { ...BASE, "test/calc.test.mjs": old },
    head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": `${old}\nimport { add } from "../src/calc.mjs";\ntest("add sums two numbers", () => {\n  assert.equal(add(1, 2), 3);\n});\n` },
  });
  assertPass(runGate(sc, "run"));
});

test("the install and the tests run with CI=true and without the runner's internal tokens", async (t) => {
  const envTest = `${TEST_HEAD}import { add } from "../src/calc.mjs";\n\ntest("add sums two numbers", () => {\n  assert.equal(add(1, 2), 3);\n  assert.equal(process.env.CI, "true");\n  for (const key of ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_CACHE_URL"]) {\n    assert.equal(process.env[key], undefined, key);\n  }\n});\n`;
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": envTest } });
  const install = 'test -z "${ACTIONS_RUNTIME_TOKEN-}" && test -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN-}"';
  const r = runGate(sc, "run", ["--install", install], {
    ACTIONS_RUNTIME_TOKEN: "x",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x",
    ACTIONS_ID_TOKEN_REQUEST_URL: "http://example.invalid/",
    ACTIONS_CACHE_URL: "http://example.invalid/",
  });
  assertPass(r);
});

test("run refuses a work folder that is not empty", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
  const work = path.join(sc.root, "busy");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "keep.txt"), "x");
  const r = spawnSync(process.execPath, [GATE, "run", "--repo", sc.repo, "--base", sc.base, "--head", sc.head, "--work", work], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 2, r.stderr);
  assert.ok(fs.existsSync(path.join(work, "keep.txt")));
});

test("plan refuses a base or head that is not a 40-hex commit", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX } });
  const r = spawnSync(process.execPath, [GATE, "plan", "--repo", sc.repo, "--base", "main", "--head", sc.head], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 2, r.stderr);
});

test("plan without a base and head (not a pull request) skips with NOT-A-PULL-REQUEST", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX } });
  const verdictFile = path.join(sc.root, "np.json");
  const out = path.join(sc.root, "github-output.txt");
  const r = spawnSync(process.execPath, [GATE, "plan", "--repo", sc.repo, "--base", "", "--head", "", "--verdict", verdictFile, "--github-output", out], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(out), "no GitHub output written");
  const lines = fs.readFileSync(out, "utf8");
  assert.match(lines, /^verdict=skip$/m);
  assert.match(lines, /^reason=NOT-A-PULL-REQUEST$/m);
});

// ---------------------------------------------------------------------------
// End to end with a vitest stand-in (writes vitest's JSON report shape)
// ---------------------------------------------------------------------------

const FAKE_VITEST = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const spec = JSON.parse(readFileSync(process.env.FAKE_VITEST_SPEC, "utf8"));
const cwd = process.cwd();
const phase = existsSync(join(cwd, "src", "FIXED")) ? "head" : "before";
const log = process.env.FAKE_VITEST_LOG;
const prior = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter((l) => l && JSON.parse(l).phase === phase).length : 0;
const texts = Object.fromEntries(args.filter((a) => !a.startsWith("-") && a !== "run" && existsSync(join(cwd, a))).map((a) => [a, readFileSync(join(cwd, a), "utf8")]));
appendFileSync(log, JSON.stringify({ phase, cwd, args, texts }) + "\\n");
// The second run in the tree with the fix is the run of the earlier versions.
const step = phase === "head" && prior > 0 && spec.earlier ? spec.earlier : spec[phase];
const out = args.find((a) => a.startsWith("--outputFile.json="));
if (out && step.report) writeFileSync(out.slice("--outputFile.json=".length), JSON.stringify(step.report).replaceAll("<cwd>", cwd));
process.exit(step.exit ?? 0);
`;

// vitest's report: success is false when any file failed (override with
// { success } to build a contradicting report).
function vitestReport(files, { success } = {}) {
  return {
    numTotalTests: files.reduce((n, f) => n + (f.tests ?? []).length, 0),
    success: success ?? !files.some((f) => f.status === "failed"),
    testResults: files.map((f) => ({
      name: `<cwd>/${f.rel}`,
      status: f.status,
      message: f.message ?? "",
      assertionResults: (f.tests ?? []).map((x) => ({
        ancestorTitles: [f.suite ?? "calc"],
        title: x.title,
        fullName: `${f.suite ?? "calc"} ${x.title}`,
        status: x.status,
        failureMessages: x.failure ? [x.failure] : [],
      })),
    })),
  };
}

const V_TEST = 'import { describe, it, expect } from "vitest";\nimport { add } from "./calc";\ndescribe("calc", () => { it("adds", () => { expect(add(1, 2)).toBe(3); }); });\n';
const V_BASE = { "packages/pkg/vitest.config.mjs": "export default {};\n", "packages/pkg/src/calc.ts": "export const add = (a: number, b: number) => a - b;\n" };
const V_HEAD = { "packages/pkg/src/calc.ts": "export const add = (a: number, b: number) => a + b;\n", "packages/pkg/src/FIXED": "", "packages/pkg/src/calc.test.ts": V_TEST };
const ASSERT_FAIL = "AssertionError: expected -1 to be 3 // Object.is equality\n    at /repo/packages/pkg/src/calc.test.ts:3:50";
const GOOD_BEFORE = vitestReport([{ rel: "src/calc.test.ts", status: "failed", tests: [{ title: "adds", status: "failed", failure: ASSERT_FAIL }] }]);
const GOOD_HEAD = vitestReport([{ rel: "src/calc.test.ts", status: "passed", tests: [{ title: "adds", status: "passed" }] }]);

function runVitest(t, spec, vitestTail = "", files = { base: V_BASE, head: V_HEAD }) {
  const sc = scenario(t, files);
  const fake = path.join(sc.root, "fake-vitest.mjs");
  const specFile = path.join(sc.root, "fake-spec.json");
  const log = path.join(sc.root, "fake-log.jsonl");
  fs.writeFileSync(fake, FAKE_VITEST);
  fs.writeFileSync(specFile, JSON.stringify(spec));
  ENV.FAKE_VITEST_SPEC = specFile;
  ENV.FAKE_VITEST_LOG = log;
  try {
    const r = runGate(sc, "run", ["--vitest", `'${process.execPath}' '${fake}' run${vitestTail}`]);
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    return { ...r, calls };
  } finally {
    delete ENV.FAKE_VITEST_SPEC;
    delete ENV.FAKE_VITEST_LOG;
  }
}

test("a setup file a vitest config names is test side: with no other change the pull request is TESTS-ONLY", async (t) => {
  const sc = scenario(t, {
    base: { ...V_BASE, "packages/pkg/vitest.config.mjs": 'export default { test: { setupFiles: ["./test/helpers/env.ts"], globalSetup: "test/global.ts" } };\n', "packages/pkg/test/helpers/env.ts": "export {};\n" },
    head: { "packages/pkg/test/helpers/env.ts": "globalThis.ready = true;\n", "packages/pkg/src/calc.test.ts": V_TEST },
  });
  const plan = runGate(sc, "plan");
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.equal(plan.verdict.verdict, "skip");
  assert.equal(plan.verdict.reason, "TESTS-ONLY");
  assert.deepEqual(plan.verdict.setupPaths, ["packages/pkg/test/global.ts", "packages/pkg/test/helpers/env.ts"]);
  assert.ok(plan.verdict.testSide.some((e) => e.path === "packages/pkg/test/helpers/env.ts"));
});

test("a setup file under another name is test side when it matches --test-support", async (t) => {
  const sc = scenario(t, {
    base: { ...BASE, "support/db-prep.mjs": "export {};\n" },
    head: { "support/db-prep.mjs": "export const ready = true;\n", "test/calc.test.mjs": ADD_TEST },
  });
  const plain = runGate(sc, "plan");
  assert.ok(plain.verdict, `no plan verdict (exit ${plain.code}): ${plain.stderr.slice(0, 400)}`);
  assert.equal(plain.verdict.verdict, "run");
  const plan = runGate(sc, "plan", ["--test-support", "support/**"]);
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.equal(plan.verdict.verdict, "skip");
  assert.equal(plan.verdict.reason, "TESTS-ONLY");
  assert.equal(runGate(sc, "run", ["--test-support", "support/**"]).code, 3);
  assert.equal(runGate(sc, "plan", ["--test-support", "(["]).code, 2);
});

test("vitest: runs from the nearest config folder with the files as arguments and reads the JSON report", async (t) => {
  const r = runVitest(t, { before: { report: GOOD_BEFORE, exit: 1 }, head: { report: GOOD_HEAD, exit: 0 } });
  assertPass(r);
  assert.equal(r.verdict.files[0].runner, "vitest");
  assert.equal(r.calls.length, 2);
  for (const call of r.calls) {
    assert.match(call.cwd, /\/packages\/pkg$/);
    assert.equal(call.args[0], "run");
    assert.ok(call.args.includes("src/calc.test.ts"), JSON.stringify(call.args));
    assert.ok(call.args.includes("--reporter=json"), JSON.stringify(call.args));
    assert.ok(call.args.some((a) => a.startsWith("--outputFile.json=")), JSON.stringify(call.args));
  }
});

test("vitest: a file-level load error before the fix is RED (LOAD-ERROR)", async (t) => {
  const before = vitestReport([{ rel: "src/calc.test.ts", status: "failed", message: "Failed to load url ./calc (resolved id: ./calc). Does the file exist?", tests: [] }]);
  assertRed(runVitest(t, { before: { report: before, exit: 1 }, head: { report: GOOD_HEAD, exit: 0 } }), "LOAD-ERROR");
});

test("vitest: a file missing from the head report is RED (NOT-COLLECTED)", async (t) => {
  const head = vitestReport([]);
  assertRed(runVitest(t, { before: { report: GOOD_BEFORE, exit: 1 }, head: { report: head, exit: 1 } }), "NOT-COLLECTED");
});

test("vitest: a run that writes no report is RED (NO-REPORT), never read as failing first", async (t) => {
  assertRed(runVitest(t, { before: { exit: 1 }, head: { report: GOOD_HEAD, exit: 0 } }), "NO-REPORT");
});

test("vitest: a non-assertion failure text without a marker is RED (WRONG-REASON)", async (t) => {
  const before = vitestReport([{ rel: "src/calc.test.ts", status: "failed", tests: [{ title: "adds", status: "failed", failure: "TypeError: add is not a function\n    at x" }] }]);
  assertRed(runVitest(t, { before: { report: before, exit: 1 }, head: { report: GOOD_HEAD, exit: 0 } }), "WRONG-REASON");
});

test("vitest: a non-zero exit at head with every test passing is RED (RUNNER-EXIT)", async (t) => {
  assertRed(runVitest(t, { before: { report: GOOD_BEFORE, exit: 1 }, head: { report: GOOD_HEAD, exit: 1 } }), "RUNNER-EXIT");
});

test("vitest: a head report with success false is RED (RUNNER-EXIT) although every test passed and vitest exited 0", async (t) => {
  const head = vitestReport([{ rel: "src/calc.test.ts", status: "passed", tests: [{ title: "adds", status: "passed" }] }], { success: false });
  const r = runVitest(t, { before: { report: GOOD_BEFORE, exit: 1 }, head: { report: head, exit: 0 } });
  assertRed(r, "RUNNER-EXIT");
  assert.match(r.verdict.reasons.find((x) => x.code === "RUNNER-EXIT").detail, /success: false/);
});

test("vitest: a head file reported as failed with only passed tests is RED (FILE-ERROR)", async (t) => {
  const head = vitestReport([{ rel: "src/calc.test.ts", status: "failed", tests: [{ title: "adds", status: "passed" }] }]);
  assertRed(runVitest(t, { before: { report: GOOD_BEFORE, exit: 1 }, head: { report: head, exit: 0 } }), "FILE-ERROR");
});

test("vitest: an unknown test status before the fix makes the report unreadable (NO-REPORT), never a pass", async (t) => {
  const before = vitestReport([{ rel: "src/calc.test.ts", status: "failed", tests: [{ title: "adds", status: "failed", failure: ASSERT_FAIL }, { title: "other", status: "weird" }] }]);
  const head = vitestReport([{ rel: "src/calc.test.ts", status: "passed", tests: [{ title: "adds", status: "passed" }, { title: "other", status: "passed" }] }]);
  const r = runVitest(t, { before: { report: before, exit: 1 }, head: { report: head, exit: 0 } });
  assertRed(r, "NO-REPORT");
  assert.match(r.verdict.reasons.find((x) => x.code === "NO-REPORT").detail, /unknown status "weird"/);
});

test("vitest: a malformed test entry makes the report unreadable (NO-REPORT), not a crash", async (t) => {
  const before = vitestReport([{ rel: "src/calc.test.ts", status: "failed", tests: [{ title: "adds", status: "failed", failure: ASSERT_FAIL }] }]);
  const entry = before.testResults[0].assertionResults[0];
  entry.ancestorTitles = 7;
  delete entry.fullName;
  const r = runVitest(t, { before: { report: before, exit: 1 }, head: { report: GOOD_HEAD, exit: 0 } });
  assertRed(r, "NO-REPORT");
  assert.match(r.verdict.reasons.find((x) => x.code === "NO-REPORT").detail, /ancestorTitles/);
});

test("vitest: two failing copies of a test before the fix need two passing copies with it (NOT-GREEN-AT-HEAD)", async (t) => {
  const failing = { rel: "src/calc.test.ts", status: "failed", tests: [{ title: "adds", status: "failed", failure: ASSERT_FAIL }] };
  const before = vitestReport([failing, failing]);
  const r = runVitest(t, { before: { report: before, exit: 1 }, head: { report: GOOD_HEAD, exit: 0 } });
  assertRed(r, "NOT-GREEN-AT-HEAD");
  assert.match(r.verdict.reasons.find((x) => x.code === "NOT-GREEN-AT-HEAD").detail, /calc adds \(1 of 2 passed\)/);
  const passing = { rel: "src/calc.test.ts", status: "passed", tests: [{ title: "adds", status: "passed" }] };
  assertPass(runVitest(t, { before: { report: before, exit: 1 }, head: { report: vitestReport([passing, passing]), exit: 0 } }));
});

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

test("classify: test files, test support paths (fixture test files are data) and the fix side", async () => {
  const { classifyPaths } = await gateModule();
  const c = classifyPaths([
    { status: "A", path: "src/a.test.ts" },
    { status: "M", path: "packages/x/src/b.spec.tsx" },
    { status: "M", path: "scripts/__tests__/c.test.mjs" },
    { status: "D", path: "src/old.test.ts" },
    { status: "A", path: "src/__fixtures__/data.json" },
    { status: "A", path: "src/__fixtures__/broken.test.ts" },
    { status: "A", path: "src/__snapshots__/a.test.ts.snap" },
    { status: "M", path: "src/a.ts" },
    { status: "A", path: "tests/e2e/flow.spec.ts" },
    { status: "M", path: "src/contest.ts" },
  ], { exclude: "tests/e2e/**" });
  assert.deepEqual(c.newTests, ["packages/x/src/b.spec.tsx", "scripts/__tests__/c.test.mjs", "src/a.test.ts"]);
  assert.deepEqual(c.excluded, ["tests/e2e/flow.spec.ts"]);
  assert.deepEqual(c.fixSide, ["src/a.ts", "src/contest.ts"]);
  assert.deepEqual(c.testSide.map((e) => e.path), [
    "packages/x/src/b.spec.tsx",
    "scripts/__tests__/c.test.mjs",
    "src/__fixtures__/broken.test.ts",
    "src/__fixtures__/data.json",
    "src/__snapshots__/a.test.ts.snap",
    "src/a.test.ts",
    "src/old.test.ts",
    "tests/e2e/flow.spec.ts",
  ]);
});

test("classify: the runner's configuration, setup and stub files are on the test side", async () => {
  const { classifyPaths } = await gateModule();
  const c = classifyPaths([
    { status: "M", path: "vitest.config.ts" },
    { status: "M", path: "packages/x/vitest.config.mts" },
    { status: "M", path: "vite.config.ts" },
    { status: "A", path: "vitest.setup.ts" },
    { status: "A", path: "tests/__stubs__/db.ts" },
    { status: "M", path: "src/vitest-utils.ts" },
    { status: "M", path: "src/config.ts" },
  ]);
  assert.deepEqual(c.testSide.map((e) => e.path), ["packages/x/vitest.config.mts", "tests/__stubs__/db.ts", "vite.config.ts", "vitest.config.ts", "vitest.setup.ts"]);
  assert.deepEqual(c.fixSide, ["src/config.ts", "src/vitest-utils.ts"]);
  assert.deepEqual(c.newTests, []);
});

test("classify: common setup names, config-named setup files and the --test-support pattern are test side", async () => {
  const { classifyPaths, setupPathsFromConfig } = await gateModule();
  const source = 'export default defineConfig({ test: { setupFiles: ["./test/setup-dom.ts", "@testing-library/jest-dom/vitest", "virtual:x"], globalSetup: \'/scripts/global.mjs\', other: ["src/a.ts"] } });\n';
  assert.deepEqual(setupPathsFromConfig("packages/web/vitest.config.ts", source), ["packages/web/scripts/global.mjs", "packages/web/test/setup-dom.ts"]);
  assert.deepEqual(setupPathsFromConfig("vitest.config.ts", 'export default { test: { setupFiles: ["../outside.ts"] } };'), []);
  const c = classifyPaths([
    { status: "M", path: "packages/web/test/setup-dom.ts" },
    { status: "M", path: "src/setupTests.ts" },
    { status: "M", path: "test/setup.ts" },
    { status: "M", path: "vitest.global-setup.ts" },
    { status: "M", path: "support/db-prep.ts" },
    { status: "M", path: "src/setup.ts" },
    { status: "M", path: "src/app.ts" },
    { status: "A", path: "tool.test.py" },
  ], { setupPaths: ["packages/web/test/setup-dom.ts"], testSupport: "support/**" });
  assert.deepEqual(c.fixSide, ["src/app.ts", "src/setup.ts", "tool.test.py"]);
  assert.deepEqual(c.newTests, []);
  assert.throws(() => classifyPaths([], { testSupport: "([" }));
});

test("platform: Windows runners are refused with a usage error, Linux and macOS run", async () => {
  const { checkPlatform } = await gateModule();
  assert.throws(() => checkPlatform("win32"), /Linux or macOS/);
  assert.doesNotThrow(() => checkPlatform("linux"));
  assert.doesNotThrow(() => checkPlatform("darwin"));
});

test("classify: an exclude pattern that is not a valid path pattern is refused", async () => {
  const { classifyPaths } = await gateModule();
  assert.throws(() => classifyPaths([{ status: "A", path: "a.test.ts" }], { exclude: "([" }));
});

test("markers: red-first-expect lines are read, trimmed and kept in order", async () => {
  const { readMarkers } = await gateModule();
  assert.deepEqual(readMarkers("// red-first-expect: expected 1 to be 2\n/* red-first-expect:  is not a function */\nconst x = 1;\n"), [
    "expected 1 to be 2",
    "is not a function",
  ]);
  assert.deepEqual(readMarkers("const s = 'no marker here';\n"), []);
  // A marker that is empty once normalized would match every failure text.
  assert.deepEqual(readMarkers("// red-first-expect: \u001b[0m\n// red-first-expect:\n"), []);
});

function asRepo(report) {
  return JSON.parse(JSON.stringify(report).replaceAll("<cwd>", "/repo"));
}

test("vitest report: a report without a testResults array or a boolean success is unreadable", async () => {
  const { parseVitestReport } = await gateModule();
  assert.equal(parseVitestReport({ success: true }, "/repo").ok, false);
  assert.equal(parseVitestReport(null, "/repo").ok, false);
  assert.equal(parseVitestReport([], "/repo").ok, false);
  assert.match(parseVitestReport({ testResults: [] }, "/repo").why, /success/);
});

test("vitest report: unknown statuses, malformed entries and contradictions are unreadable, never thrown", async () => {
  const { parseVitestReport } = await gateModule();
  const good = () => asRepo(vitestReport([{ rel: "a.test.ts", status: "failed", tests: [{ title: "x", status: "failed", failure: ASSERT_FAIL }] }]));
  const cases = {
    "unknown test status": (r) => { r.testResults[0].assertionResults[0].status = "weird"; },
    "inherited status name": (r) => { r.testResults[0].assertionResults[0].status = "constructor"; },
    "unknown file status": (r) => { r.testResults[0].status = "broken"; },
    "ancestorTitles not a list": (r) => { r.testResults[0].assertionResults[0].ancestorTitles = 7; },
    "ancestorTitles with a number": (r) => { r.testResults[0].assertionResults[0].ancestorTitles = [1]; },
    "title not text": (r) => { r.testResults[0].assertionResults[0].title = {}; },
    "failureMessages not a list": (r) => { r.testResults[0].assertionResults[0].failureMessages = "x"; },
    "assertion not an object": (r) => { r.testResults[0].assertionResults[0] = null; },
    "no test name": (r) => { Object.assign(r.testResults[0].assertionResults[0], { fullName: "", title: "", ancestorTitles: [] }); },
    "entry not an object": (r) => { r.testResults[0] = "x"; },
    "message not text": (r) => { r.testResults[0].message = 3; },
    "success with a failed file": (r) => { r.success = true; },
    "failed test in a passed file": (r) => { r.testResults[0].status = "passed"; },
  };
  assert.equal(parseVitestReport(good(), "/repo").ok, true);
  for (const [name, spoil] of Object.entries(cases)) {
    const report = good();
    spoil(report);
    let parsed;
    assert.doesNotThrow(() => { parsed = parseVitestReport(report, "/repo"); }, name);
    assert.equal(parsed.ok, false, name);
    assert.ok(parsed.why, name);
  }
});

test("vitest report: assertion failures, load errors and statuses are read per file", async () => {
  const { parseVitestReport } = await gateModule();
  const report = vitestReport([
    { rel: "a.test.ts", status: "failed", tests: [{ title: "x", status: "failed", failure: ASSERT_FAIL }, { title: "y", status: "skipped" }] },
    { rel: "b.test.ts", status: "failed", message: "SyntaxError: Unexpected token", tests: [] },
  ]);
  const parsed = parseVitestReport(asRepo(report), "/repo");
  assert.equal(parsed.ok, true, parsed.why);
  assert.equal(parsed.success, false);
  const a = parsed.files.get("a.test.ts");
  assert.equal(a.loaded, true);
  assert.deepEqual(a.tests.map((x) => [x.name, x.status, x.assertion]), [["calc x", "failed", true], ["calc y", "skipped", false]]);
  const b = parsed.files.get("b.test.ts");
  assert.equal(b.loaded, false);
  assert.match(b.loadError, /SyntaxError/);
});

test("vitest report: a file reported twice keeps both results, so a failing copy is not hidden", async () => {
  const { parseVitestReport } = await gateModule();
  const report = vitestReport([
    { rel: "a.test.ts", status: "failed", tests: [{ title: "x", status: "failed", failure: ASSERT_FAIL }] },
    { rel: "a.test.ts", status: "passed", tests: [{ title: "x", status: "passed" }] },
  ]);
  const parsed = parseVitestReport(asRepo(report), "/repo");
  assert.deepEqual(parsed.files.get("a.test.ts").tests.map((x) => x.status), ["failed", "passed"]);
});

test("workflow: two jobs, the red-first job runs only on a plan verdict of run", () => {
  assert.ok(fs.existsSync(WORKFLOW), ".github/workflows/red-first-gate.yml is missing");
  const wf = load(fs.readFileSync(WORKFLOW, "utf8"));
  assert.deepEqual(Object.keys(wf.jobs).sort(), ["plan", "red-first"]);
  assert.equal(wf.jobs["red-first"].needs, "plan");
  assert.match(String(wf.jobs["red-first"].if), /needs\.plan\.outputs\.verdict == 'run'/);
  assert.match(String(wf.jobs.plan.outputs.verdict), /steps\.plan\.outputs\.verdict/);
  assert.deepEqual(wf.permissions, { contents: "read" });
  for (const job of Object.values(wf.jobs)) {
    assert.equal(job.permissions, undefined, "a job must not widen the workflow permissions");
    assert.equal(job["continue-on-error"], undefined);
    assert.equal(job.secrets, undefined);
  }
});

test("workflow: inputs, runner, checkouts and the steps that run the gate", () => {
  assert.ok(fs.existsSync(WORKFLOW), ".github/workflows/red-first-gate.yml is missing");
  const source = fs.readFileSync(WORKFLOW, "utf8");
  const wf = load(source);
  const inputs = wf.on.workflow_call.inputs;
  const expected = {
    ref: ["string", "main"],
    runner: ["string", ""],
    install: ["string", ""],
    setup_pnpm: ["boolean", false],
    vitest: ["string", "npx --no-install vitest run"],
    exclude: ["string", ""],
    test_support: ["string", ""],
    node_version: ["string", "24"],
    timeout_minutes: ["number", 30],
  };
  assert.deepEqual(Object.keys(inputs).sort(), Object.keys(expected).sort());
  for (const [name, [type, def]] of Object.entries(expected)) {
    assert.equal(inputs[name].type, type, `${name} type`);
    assert.equal(inputs[name].default, def, `${name} default`);
    assert.ok(!inputs[name].required, `${name} must be optional`);
  }
  assert.equal(wf.on.workflow_call.secrets, undefined, "the gate takes no secret");
  for (const [id, job] of Object.entries(wf.jobs)) {
    const runsOn = String(job["runs-on"]);
    assert.match(runsOn, /inputs\.runner/);
    assert.doesNotMatch(runsOn, /\bvars\.|\bsecrets\.|\benv\.|\bgithub\./);
    for (const step of job.steps) {
      if (String(step.uses ?? "").startsWith("actions/checkout@")) {
        assert.equal(step.with?.["persist-credentials"], false, `${id}: a checkout keeps no credential`);
      }
      if (step.run) {
        assert.doesNotMatch(step.run, /\$\{\{/, `${id}: an expression inside run: (inputs reach the shell only through env)`);
        assert.equal(step.shell, "bash", `${id}: ${step.name}: the run step must name shell: bash (POSIX variables)`);
      }
    }
  }
  const planRun = wf.jobs.plan.steps.map((s) => s.run ?? "").join("\n");
  const gateRun = wf.jobs["red-first"].steps.map((s) => s.run ?? "").join("\n");
  assert.match(planRun, /red-first-gate\.mjs plan/);
  assert.match(gateRun, /red-first-gate\.mjs run/);
  assert.match(source, /github\.event\.pull_request\.base\.sha/);
  assert.match(source, /github\.event\.pull_request\.head\.sha/);
});

test("workflow: the red-first job starts its time budget first and hands it to the gate", () => {
  assert.ok(fs.existsSync(WORKFLOW), ".github/workflows/red-first-gate.yml is missing");
  const wf = load(fs.readFileSync(WORKFLOW, "utf8"));
  const job = wf.jobs["red-first"];
  assert.match(String(job["timeout-minutes"]), /inputs\.timeout_minutes/);
  assert.match(job.steps[0].run, /RED_FIRST_JOB_STARTED=\$\(date \+%s\)" >> "\$GITHUB_ENV"/);
  const gate = job.steps.find((s) => /red-first-gate\.mjs run/.test(s.run ?? ""));
  assert.match(String(gate.env.TIMEOUT_MINUTES), /inputs\.timeout_minutes/);
  assert.match(gate.run, /--job-started "\$RED_FIRST_JOB_STARTED" --job-minutes "\$TIMEOUT_MINUTES"/);
  for (const id of ["plan", "red-first"]) {
    const step = wf.jobs[id].steps.find((s) => /red-first-gate\.mjs/.test(s.run ?? ""));
    assert.match(String(step.env.TEST_SUPPORT), /inputs\.test_support/);
    assert.match(step.run, /--test-support "\$TEST_SUPPORT"/);
  }
});

test("self-check runs this test file", () => {
  assert.match(fs.readFileSync(SELF_CHECK, "utf8"), /scripts\/__tests__\/red-first-gate\.test\.mjs/);
});

// ---------------------------------------------------------------------------
// Review findings F1 to F9: one case each (each fails on the previous engine)
// ---------------------------------------------------------------------------

test("F1 vitest: a passed test in a file reported as skipped, pending or todo makes the report unreadable (NO-REPORT), never a pass", async (t) => {
  for (const status of ["skipped", "pending", "todo"]) {
    const head = vitestReport([{ rel: "src/calc.test.ts", status, tests: [{ title: "adds", status: "passed" }] }], { success: true });
    const r = runVitest(t, { before: { report: GOOD_BEFORE, exit: 1 }, head: { report: head, exit: 0 } });
    assertRed(r, "NO-REPORT");
    assert.match(r.verdict.reasons.find((x) => x.code === "NO-REPORT").detail, new RegExp(`a passed test in a file whose status is ${status}`));
  }
});

test("F2 node:test: tests named like the file are tests: a failed-before copy skipped at head is RED (NOT-GREEN-AT-HEAD)", async (t) => {
  const { parseNodeReport } = await gateModule();
  const ev = (o) => JSON.stringify({ kind: "test", nesting: 0, type: "test", skip: false, todo: false, error: null, ...o });
  const failure = { failureType: "testCodeFailure", name: "AssertionError", code: "ERR_ASSERTION", message: "x", causeName: null, causeCode: null, causeMessage: "" };
  const parsed = parseNodeReport([ev({ name: "f.test.mjs", ok: false, error: failure }), ev({ name: "f.test.mjs", ok: true }), ev({ name: "x", ok: true })].join("\n"), "f.test.mjs");
  assert.deepEqual(parsed.tests.map((x) => [x.name, x.status]), [["f.test.mjs", "failed"], ["f.test.mjs", "passed"], ["x", "passed"]]);
  // Only the final top-level result named like the file is the file itself.
  const wrapped = parseNodeReport([ev({ name: "x", ok: true }), ev({ name: "f.test.mjs", ok: false, error: failure })].join("\n"), "f.test.mjs");
  assert.deepEqual(wrapped.tests.map((x) => x.name), ["x"]);
  assert.ok(wrapped.fileError);
  const src = `${TEST_HEAD}import { existsSync } from "node:fs";\nimport { add } from "../src/calc.mjs";\n\nconst fixed = existsSync(new URL("../src/FIXED", import.meta.url));\ntest("test/calc.test.mjs", { skip: fixed }, () => {\n  assert.equal(add(1, 2), 3);\n});\ntest("add sums two numbers", () => {\n  assert.equal(add(1, 2), 3);\n});\ntest("test/calc.test.mjs", () => {});\n`;
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "src/FIXED": "", "test/calc.test.mjs": src } });
  const r = runGate(sc, "run");
  assertRed(r, "NOT-GREEN-AT-HEAD");
  assert.match(r.verdict.reasons.find((x) => x.code === "NOT-GREEN-AT-HEAD").detail, /test\/calc\.test\.mjs \(0 of 1 passed\)/);
});

test("F3 a setup file a vitest config names under a quoted or computed key is test side (TESTS-ONLY)", async (t) => {
  const { setupPathsFromConfig } = await gateModule();
  assert.deepEqual(setupPathsFromConfig("vitest.workspace.json", '[{ "test": { "setupFiles": ["./a.ts"], "globalSetup": "b.ts" } }]'), ["a.ts", "b.ts"]);
  const config = 'export default { "test": { "setupFiles": "./support.ts", \'globalSetup\': [`./gs.ts`], ["setupFiles"]: ["./more.ts"] } };\n';
  const sc = scenario(t, {
    base: { ...V_BASE, "packages/pkg/vitest.config.mjs": config, "packages/pkg/support.ts": "export {};\n" },
    head: { "packages/pkg/support.ts": "globalThis.ready = true;\n", "packages/pkg/src/calc.test.ts": V_TEST },
  });
  const plan = runGate(sc, "plan");
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.deepEqual(plan.verdict.setupPaths, ["packages/pkg/gs.ts", "packages/pkg/more.ts", "packages/pkg/support.ts"]);
  assert.equal(plan.verdict.verdict, "skip");
  assert.equal(plan.verdict.reason, "TESTS-ONLY");
});

test("F4 a new test that is a symlink, or a broken one, is RED (NOT-A-FILE): never followed, never a crash", async (t) => {
  const check = `${TEST_HEAD}import { add } from "./calc.mjs";\n\ntest("add sums two numbers", () => {\n  assert.equal(add(1, 2), 3);\n});\n`;
  // The link's target is fix side: before the fix it fails, at the head it is
  // rewritten to pass, with no fix of calc at all.
  const sc = scenario(t, { base: { ...BASE, "src/check.mjs": check }, head: { "src/check.mjs": `${TEST_HEAD}test("add sums two numbers", () => {\n  assert.ok(true);\n});\n` } });
  fs.mkdirSync(path.join(sc.repo, "test"), { recursive: true });
  fs.symlinkSync("../src/check.mjs", path.join(sc.repo, "test", "link.test.mjs"));
  sc.head = commitAll(sc.repo, "link");
  const r = runGate(sc, "run");
  assertRed(r, "NOT-A-FILE");
  assert.equal(r.verdict.reasons.find((x) => x.code === "NOT-A-FILE").file, "test/link.test.mjs");
  const broken = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX } });
  fs.mkdirSync(path.join(broken.repo, "test"), { recursive: true });
  fs.symlinkSync("../src/nowhere.mjs", path.join(broken.repo, "test", "broken.test.mjs"));
  broken.head = commitAll(broken.repo, "broken link");
  assertRed(runGate(broken, "run"), "NOT-A-FILE");
});

test("F5 a child whose group kill fails still settles as timed out after the grace time", async () => {
  const { spawnChild } = await gateModule();
  assert.equal(typeof spawnChild, "function", "spawnChild is not exported");
  const t0 = Date.now();
  const res = await spawnChild("sleep", ["4"], os.tmpdir(), 100, { kill: () => {}, graceMs: 300 });
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - t0 < 2500, `settled after ${Date.now() - t0} ms, not after the grace time`);
});

// The install is the only shell the gate starts. It starts bash at its own
// spawn call, so the argument lists the gate builds for node --test and vitest
// (which carry paths of the work folder) never reach a call that may start a
// shell with -c.
function functionText(source, name) {
  const start = [`\nfunction ${name}(`, `\nexport function ${name}(`].map((s) => source.indexOf(s)).find((i) => i >= 0);
  assert.ok(start !== undefined, `function ${name} not found`);
  return source.slice(start, source.indexOf("\n}\n", start));
}

test("F5b the install shell has its own spawn call: spawnChild never starts a shell", () => {
  const source = fs.readFileSync(GATE, "utf8");
  const spawns = source.split("\n").filter((line) => /(^|[^A-Za-z.])spawn\(/.test(line));
  assert.equal(spawns.length, 2, `spawn calls:\n${spawns.join("\n")}`);
  const shellText = functionText(source, "shell");
  assert.ok(!shellText.includes("spawnChild("), "the install shell runs through spawnChild");
  assert.ok(shellText.includes('spawn("bash", ["-c", script], '), "the install shell does not start bash itself");
  const childText = functionText(source, "spawnChild");
  assert.ok(childText.includes("spawn(command, args, "), "spawnChild does not start its command from the argument list");
  assert.ok(!childText.includes('"bash"') && !childText.includes('"-c"'), "spawnChild names a shell");
});

test("F5c the install shell runs in its folder, reports its exit and is killed when its time is up", async (t) => {
  const { shell } = await gateModule();
  assert.equal(typeof shell, "function", "shell is not exported");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfg-shell-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ok = await shell("printf here > marker; exit 3", dir, 10000);
  assert.deepEqual(ok, { status: 3, signal: null, timedOut: false, error: null });
  assert.equal(fs.readFileSync(path.join(dir, "marker"), "utf8"), "here");
  const t0 = Date.now();
  const slow = await shell("sleep 4", dir, 100);
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - t0 < 2500, `settled after ${Date.now() - t0} ms`);
});

test("F6 job budget: limits the reserve does not fit in are refused in plan and run; a hanging git step ends with TIMEOUT in time", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
  const now = Math.floor(Date.now() / 1000);
  for (const minutes of ["2", "2.5", "7201", "1e308"]) {
    assert.equal(runGate(sc, "run", ["--job-started", String(now), "--job-minutes", minutes]).code, 2, `run --job-minutes ${minutes}`);
    assert.equal(runGate(sc, "plan", ["--job-minutes", minutes]).code, 2, `plan --job-minutes ${minutes}`);
  }
  assert.equal(runGate(sc, "run", ["--job-started", String(now + 3600), "--job-minutes", "30"]).code, 2, "a start in the future");
  assert.equal(runGate(sc, "plan", ["--job-minutes", "30"]).code, 0, "plan takes a valid limit alone");
  const wf = load(fs.readFileSync(WORKFLOW, "utf8"));
  const planStep = wf.jobs.plan.steps.find((s) => /red-first-gate\.mjs plan/.test(s.run ?? ""));
  assert.match(String(planStep.env.TIMEOUT_MINUTES), /inputs\.timeout_minutes/);
  assert.match(planStep.run, /--job-minutes "\$TIMEOUT_MINUTES"/);
  // A git step that hangs (here: worktree add) is cut by the job's budget.
  const bin = path.join(sc.root, "bin");
  fs.mkdirSync(bin);
  const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8", env: ENV }).stdout.trim();
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/bash\ncase " $* " in *" worktree add "*) exec sleep 40 ;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const t0 = Date.now();
  const r = runGate(sc, "run", ["--job-started", String(Math.floor(Date.now() / 1000) - 57), "--job-minutes", "3"], { PATH: `${bin}:${ENV.PATH}` });
  assertRed(r, "TIMEOUT");
  assert.ok(Date.now() - t0 < 20_000, `the hanging git step ran past the job's budget (${Date.now() - t0} ms)`);
});

test("F7 a stop signal (a cancelled job) ends the run with STOPPED, kills the install and removes the trees", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
  const work = path.join(sc.root, "stop-work");
  const mark = path.join(sc.root, "started");
  const verdictFile = path.join(sc.root, "stop.json");
  const child = spawn(process.execPath, [GATE, "run", "--repo", sc.repo, "--base", sc.base, "--head", sc.head, "--work", work, "--verdict", verdictFile, "--install", `echo $$ > '${mark}'; sleep 60`], { env: ENV, stdio: "ignore" });
  const exited = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
  let installPid = 0;
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (installPid && alive(installPid)) process.kill(installPid, "SIGKILL");
  });
  const end = Date.now() + 30_000;
  while (!(fs.existsSync(mark) && fs.readFileSync(mark, "utf8").trim())) {
    assert.ok(Date.now() < end, "the install never started");
    await new Promise((r) => setTimeout(r, 50));
  }
  installPid = Number(fs.readFileSync(mark, "utf8").trim());
  child.kill("SIGTERM");
  const res = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 15_000))]);
  assert.ok(res, "the gate did not leave after SIGTERM");
  assert.equal(res.code, 143);
  assert.ok(!fs.existsSync(work) || fs.readdirSync(work).length === 0, `the stop left ${fs.existsSync(work) ? fs.readdirSync(work).join(", ") : ""}`);
  assert.equal(git(sc.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "the stop left a worktree registration");
  assert.ok(await goneWithin(installPid, 3000), "the install outlived the stop");
  const verdict = JSON.parse(fs.readFileSync(verdictFile, "utf8"));
  assert.equal(verdict.verdict, "RED");
  assert.ok(verdict.reasons.some((x) => x.code === "STOPPED"), JSON.stringify(verdict.reasons));
});

test("F8 a pull request whose only change is excluded new tests is EXCLUDED-ONLY, not TESTS-ONLY", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "e2e/flow.spec.mjs": `${TEST_HEAD}test("flow", () => {});\n` } });
  const plan = runGate(sc, "plan", ["--exclude", "e2e/**"]);
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.equal(plan.verdict.verdict, "skip");
  assert.equal(plan.verdict.reason, "EXCLUDED-ONLY");
  const run = runGate(sc, "run", ["--exclude", "e2e/**"]);
  assert.equal(run.verdict?.reason, "EXCLUDED-ONLY");
  assert.equal(run.code, 3);
});

test("F9 a path with a line break never starts a workflow command line in plan or run output", async (t) => {
  const evil = "e2e/x\n::warning title=INJECTED::boom.spec.mjs";
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST, [evil]: `${TEST_HEAD}test("flow", () => {});\n` } });
  for (const mode of ["plan", "run"]) {
    const r = runGate(sc, mode, ["--exclude", "e2e/**"], { GITHUB_ACTIONS: "true" });
    assert.equal(r.code, 0, `${mode}: ${r.stderr.slice(0, 400)}`);
    for (const line of `${r.stdout}\n${r.stderr}`.split(/\r\n|\n|\r/)) assert.doesNotMatch(line, /^\s*::warning/, `${mode} wrote an injected command line`);
    assert.match(r.stdout, /^NOTE EXCLUDED plan e2e\/x\\n::warning title=INJECTED::boom\.spec\.mjs: /m);
  }
});

// ---------------------------------------------------------------------------
// Code scanning findings S1 to S3: one case each (each fails on the previous engine)
// ---------------------------------------------------------------------------

test("S1 --exclude and --test-support are path patterns, never regular expressions: * ** ? match, regex syntax is refused", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST, "e2e/deep/flow.spec.mjs": `${TEST_HEAD}test("flow", () => {});\n` } });
  const plan = runGate(sc, "plan", ["--exclude", "e2e/**/*.spec.mjs"]);
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.deepEqual(plan.verdict.excluded, ["e2e/deep/flow.spec.mjs"]);
  assert.deepEqual(plan.verdict.newTests, ["test/calc.test.mjs"]);
  // Regular-expression syntax is refused (exit 2), never compiled; that
  // includes a pattern that would backtrack without end.
  for (const bad of ["^e2e/", "(a+)+$", "e2e/[x]/*", "src|e2e"]) {
    assert.equal(runGate(sc, "plan", ["--exclude", bad]).code, 2, `--exclude ${bad}`);
    assert.equal(runGate(sc, "plan", ["--test-support", bad]).code, 2, `--test-support ${bad}`);
  }
  const { globMatch } = await gateModule();
  const t0 = Date.now();
  assert.equal(globMatch(`${"*".repeat(40)}x`, "a".repeat(4000)), false);
  assert.equal(globMatch("**/**/**/**/**/x", `${"a/".repeat(500)}y`), false);
  assert.ok(Date.now() - t0 < 2000, `the matcher took ${Date.now() - t0} ms on a hostile pattern`);
});

test("S2 the summary escapes every Markdown character of a file name, the backslash included", async (t) => {
  const odd = "test/a`b\\|c*_<d>~&$.test.mjs";
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, [odd]: ADD_TEST } });
  const summary = path.join(sc.root, "summary.md");
  const plan = runGate(sc, "plan", ["--summary", summary]);
  assert.equal(plan.code, 0, plan.stderr.slice(0, 400));
  const text = fs.readFileSync(summary, "utf8");
  assert.ok(text.includes("New or changed test files: test/a\\`b\\\\\\|c\\*\\_\\<d\\>\\~\\&\\$.test.mjs\n"), text);
  const { cell } = await gateModule();
  assert.equal(cell("x\\|y"), "x\\\\\\|y");
  assert.equal(cell("a\n b\tc"), "a b c");
});

test("S3 the vitest command runs without a shell: shell syntax in it stays a plain argument", async (t) => {
  const mark = path.join(os.tmpdir(), `red-first-s3-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(mark, { force: true }));
  const r = runVitest(t, { before: { report: GOOD_BEFORE, exit: 1 }, head: { report: GOOD_HEAD, exit: 0 } }, ` "$(touch ${mark})" ';' 'x y'`);
  assertPass(r);
  assert.equal(fs.existsSync(mark), false, "a shell ran the vitest command");
  for (const call of r.calls) {
    assert.ok(call.args.includes(`$(touch ${mark})`), JSON.stringify(call.args));
    assert.ok(call.args.includes(";") && call.args.includes("x y"), JSON.stringify(call.args));
  }
});

test("S1b an empty **/ matches only where a folder name starts; long paths and habit patterns are safe", async (t) => {
  const { globMatch } = await gateModule();
  const cases = [
    ["**/calc.test.mjs", "src/mycalc.test.mjs", false],
    ["**/calc.test.mjs", "src/calc.test.mjs", true],
    ["**/calc.test.mjs", "calc.test.mjs", true],
    ["**/e2e/**", "apps/admin-e2e/src/a.test.ts", false],
    ["**/e2e/**", "apps/e2e/src/a.test.ts", true],
    ["**/e2e/**", "e2e/a.test.ts", true],
    ["a/**/b", "a/xb", false],
    ["a/**/b", "a/b", true],
    ["a/**/b", "a/x/y/b", true],
  ];
  for (const [glob, file, want] of cases) assert.equal(globMatch(glob, file), want, `${glob} on ${file}`);
  // A wrong match must not skip a unit test (exclude) or hide a fix (test_support).
  const sc = scenario(t, {
    base: { ...BASE, "apps/admin-e2e/helper.mjs": "export {};\n" },
    head: { "apps/admin-e2e/helper.mjs": "export const x = 1;\n", "src/mycalc.test.mjs": ADD_TEST.replace("../src/calc.mjs", "./calc.mjs") },
  });
  const plan = runGate(sc, "plan", ["--exclude", "**/calc.test.mjs", "--test-support", "**/e2e/**"]);
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.equal(plan.verdict.verdict, "run");
  assert.deepEqual(plan.verdict.newTests, ["src/mycalc.test.mjs"]);
  assert.deepEqual(plan.verdict.excluded, []);
  assert.deepEqual(plan.verdict.fixSide, ["apps/admin-e2e/helper.mjs"]);
  // A pattern ending in / never matches a file; an overlong pattern is refused.
  for (const bad of ["e2e/", "x".repeat(1025)]) assert.equal(runGate(sc, "plan", ["--exclude", bad]).code, 2, bad.slice(0, 20));
  // No recursion: a very long path cannot overflow the stack.
  assert.equal(globMatch("**/x", `${"a/".repeat(20000)}y`), false);
  assert.equal(globMatch("**/y", `${"a/".repeat(20000)}y`), true);
});

test("S1c README: the red-first Inputs table lists every workflow input, in one table", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## red-first-gate"));
  const lines = section.slice(section.indexOf("### Inputs")).split("\n");
  const start = lines.findIndex((l) => l.startsWith("| Input |"));
  assert.ok(start > 0, "no Inputs table");
  const names = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith("|"); i += 1) names.push(/^\| `([a-z_]+)` \|/.exec(lines[i])?.[1]);
  const wf = load(fs.readFileSync(WORKFLOW, "utf8"));
  assert.deepEqual(names.sort(), Object.keys(wf.on.workflow_call.inputs).sort());
});

// ---------------------------------------------------------------------------
// Honest shapes that make no red-first claim, and the tests that still must
// fail first. The first block runs real node:test files; the second rebuilds,
// with the vitest stand-in, the test-side changes and the report texts of
// three pull requests that the gate judged RED.
// ---------------------------------------------------------------------------

// A publisher that ignores a failed compile (the bug), and refuses it (the fix).
const PUB_BUG = 'export function publish(compile) {\n  const result = compile();\n  return result.ok ? "published with a compile" : "published";\n}\n';
const PUB_FIX = 'export function publish(compile) {\n  const result = compile();\n  if (!result.ok) throw new Error("compile failed");\n  return "published";\n}\n';
// The existing test file: its compile stub fails, which the bug tolerates.
const PUB_OLD = `${TEST_HEAD}import { publish } from "../src/publish.mjs";\n\nconst compile = () => ({ ok: false });\n\ntest("publishes the package", () => {\n  assert.match(publish(compile), /^published/);\n});\n`;
// The collateral edit: only the stub changes, so the old test keeps working.
const PUB_NEW = PUB_OLD.replace("({ ok: false })", "({ ok: true, value: {} })");
const REFUSE_TEST = `${TEST_HEAD}import { publish } from "../src/publish.mjs";\n\ntest("a failed compile refuses the publish", () => {\n  assert.throws(() => publish(() => ({ ok: false })), /compile failed/);\n});\n`;
const PUB_BASE = { "package.json": '{ "type": "module" }\n', "src/publish.mjs": PUB_BUG, "test/publish.test.mjs": PUB_OLD };

function noteCodes(result) {
  assert.ok(result.verdict, `no verdict file (exit ${result.code}): ${result.stderr.slice(0, 400)}`);
  return result.verdict.notes.map((n) => `${n.code}:${n.file}`);
}

test("shape 1: an edit that only keeps an existing test file working is a COLLATERAL note beside the proven new test", async (t) => {
  const sc = scenario(t, { base: PUB_BASE, head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": PUB_NEW, "test/refuse.test.mjs": REFUSE_TEST } });
  const summary = path.join(sc.root, "summary.md");
  const r = runGate(sc, "run", ["--summary", summary]);
  assertPass(r);
  assert.deepEqual(noteCodes(r), ["COLLATERAL:test/publish.test.mjs"]);
  assert.deepEqual(r.verdict.files.map((f) => `${f.file}:${f.kind}:${f.proven}`), ["test/publish.test.mjs:collateral:false", "test/refuse.test.mjs:proven:true"]);
  assert.match(r.stdout, /^RED-FIRST: PASS \(1 new test file\(s\) fail before the fix and pass with it; 1 changed test file\(s\) collateral, not proven here\)/m);
  assert.match(fs.readFileSync(summary, "utf8"), /publish\.test\.mjs \| node \| no \(collateral\)/);
});

test("shape 1 alone: a pull request whose only test change is a collateral edit proves nothing: RED (NOTHING-PROVEN), the note kept", async (t) => {
  const sc = scenario(t, { base: PUB_BASE, head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": PUB_NEW } });
  const r = runGate(sc, "run");
  assertRed(r, "NOTHING-PROVEN");
  assert.deepEqual(codes(r), ["NOTHING-PROVEN"]);
  assert.match(r.verdict.reasons[0].detail, /notes only .* which prove nothing; add a test that fails before the fix/);
  assert.deepEqual(noteCodes(r), ["COLLATERAL:test/publish.test.mjs"]);
  assert.deepEqual(r.verdict.files.map((f) => `${f.kind}:${f.proven}`), ["collateral:false"]);
  assert.doesNotMatch(r.stdout, /NEUTRAL/);
});

test("rubber stamp 1: a test added to an existing file that passes before the fix, with no marker, stays RED and is named", async (t) => {
  const added = `${PUB_NEW}\ntest("returns a text", () => {\n  assert.equal(typeof publish(compile), "string");\n});\n`;
  const sc = scenario(t, { base: PUB_BASE, head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": added, "test/refuse.test.mjs": REFUSE_TEST } });
  const r = runGate(sc, "run");
  assertRed(r, "NOT-RED-BEFORE");
  const reason = r.verdict.reasons.find((x) => x.code === "NOT-RED-BEFORE");
  assert.match(reason.detail, /all 2 test\(s\) already pass before the fix; 1 test\(s\) the pull request adds do not fail first: returns a text/);
  assert.match(reason.detail, /red-first-pin:/);
});

test("rubber stamp 2: a row added to a table of an existing file adds a test although no line declares one: RED", async (t) => {
  // The edit holds no `test(` and no assertion; the earlier version's run shows the new name.
  const table = (rows) => `${TEST_HEAD}import { publish } from "../src/publish.mjs";\n\nconst rows = [\n${rows.map((x) => `  ${JSON.stringify(x)},\n`).join("")}];\nfor (const [name, ok] of rows) {\n  test(name, () => {\n    assert.match(publish(() => ({ ok })), /^published/);\n  });\n}\n`;
  const sc = scenario(t, {
    base: { ...PUB_BASE, "test/publish.test.mjs": table([["with a good compile", true]]) },
    head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": table([["with a good compile", true], ["with another good compile", true]]) },
  });
  const r = runGate(sc, "run");
  assertRed(r, "NOT-RED-BEFORE");
  assert.match(r.verdict.reasons[0].detail, /1 test\(s\) the pull request adds do not fail first: with another good compile/);
});

test("rubber stamp 3: an assertion changed under an unchanged test name that passes on both sides is RED: a changed test must fail first", async (t) => {
  const loosened = PUB_NEW.replace("assert.match(publish(compile), /^published/);", "assert.ok(publish(compile).length > 0);");
  const sc = scenario(t, { base: PUB_BASE, head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": loosened } });
  const r = runGate(sc, "run");
  assertRed(r, "NOT-RED-BEFORE");
  assert.match(r.verdict.reasons[0].detail, /the edit adds no test but changes a test declaration or an assertion \(.*assert\.ok/);
});

test("a changed file whose earlier version cannot be read is not collateral: RED (NOT-RED-BEFORE) with the cause", async (t) => {
  // The earlier version imports a fixture the pull request deletes, so it does not load in the tree before the fix.
  const old = PUB_OLD.replace("import { publish }", 'import "./__fixtures__/env.mjs";\nimport { publish }');
  const sc = scenario(t, {
    base: { ...PUB_BASE, "test/publish.test.mjs": old, "test/__fixtures__/env.mjs": "export {};\n" },
    head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": PUB_NEW, "test/__fixtures__/env.mjs": null },
  });
  const r = runGate(sc, "run");
  assertRed(r, "NOT-RED-BEFORE");
  assert.match(r.verdict.reasons[0].detail, /earlier version could not be read to compare them \(it does not load/);
});

// Shape 2 adds to a file whose tests already pass with the fix (no collateral edit).
const PIN_BASE = { ...PUB_BASE, "test/publish.test.mjs": PUB_NEW };
// The pin of shape 2: the fix keeps this behaviour, so the test passes before and with the fix.
const PIN_TEST = 'test("a good compile still publishes", () => {\n  assert.match(publish(() => ({ ok: true })), /^published/);\n});\n';

test("shape 2: a test added to an existing file and declared with red-first-pin is a PIN note beside the proven new test", async (t) => {
  const pinned = `${PUB_NEW}\n// red-first-pin: a good compile still publishes\n${PIN_TEST}`;
  const sc = scenario(t, { base: PIN_BASE, head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": pinned, "test/refuse.test.mjs": REFUSE_TEST } });
  const r = runGate(sc, "run");
  assertPass(r);
  assert.deepEqual(noteCodes(r), ["PIN:test/publish.test.mjs"]);
  assert.match(r.stdout, /^RED-FIRST: PASS \(1 new test file\(s\) fail before the fix and pass with it; 1 test file\(s\) with declared pins only, not proven here\)/m);
  // The same pull request without the marker: the added test must fail first.
  const bare = scenario(t, { base: PIN_BASE, head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": `${PUB_NEW}\n${PIN_TEST}`, "test/refuse.test.mjs": REFUSE_TEST } });
  assertRed(runGate(bare, "run"), "NOT-RED-BEFORE");
});

test("shape 2: a pin marker never covers another added test, names a test of the file, and names a test that passes before", async (t) => {
  const head = (file) => ({ "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": file, "test/refuse.test.mjs": REFUSE_TEST });
  // one declared pin and one more added test without a marker
  const two = scenario(t, { base: PIN_BASE, head: head(`${PUB_NEW}\n// red-first-pin: a good compile still publishes\n${PIN_TEST}\ntest("returns a text", () => {\n  assert.equal(typeof publish(compile), "string");\n});\n`) });
  const r = runGate(two, "run");
  assertRed(r, "NOT-RED-BEFORE");
  assert.match(r.verdict.reasons[0].detail, /1 test\(s\) the pull request adds do not fail first: returns a text/);
  // a marker that names no test
  const stray = scenario(t, { base: PIN_BASE, head: head(`${PUB_NEW}\n// red-first-pin: a test that is not here\n${PIN_TEST}`) });
  assertRed(runGate(stray, "run"), "PIN-MISMATCH");
  // a marker on a test that fails before the fix
  const red = scenario(t, { base: PUB_BASE, head: { "src/publish.mjs": PUB_FIX, "test/refuse.test.mjs": REFUSE_TEST.replace(TEST_HEAD, `${TEST_HEAD}// red-first-pin: a failed compile refuses the publish\n`) } });
  const rr = runGate(red, "run");
  assertRed(rr, "PIN-MISMATCH");
  assert.match(rr.verdict.reasons[0].detail, /is failed before the fix/);
});

test("shape 2: a declared pin that does not pass with the fix is RED (NOT-GREEN-AT-HEAD)", async (t) => {
  const broken = `${PUB_NEW}\n// red-first-pin: a bad compile still publishes\ntest("a bad compile still publishes", () => {\n  assert.match(publish(() => ({ ok: false })), /^published/);\n});\n`;
  const sc = scenario(t, { base: PIN_BASE, head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": broken, "test/refuse.test.mjs": REFUSE_TEST } });
  assertRed(runGate(sc, "run"), "NOT-GREEN-AT-HEAD");
});

// --- the three pull requests, with the vitest stand-in ----------------------

const AG = "packages/agents";
const AG_CONFIG = { [`${AG}/vitest.config.mjs`]: "export default {};\n" };
const passedFile = (rel, suite, titles) => ({ rel, suite, status: "passed", tests: titles.map((title) => ({ title, status: "passed" })) });
const ASSERT_REJECT = 'AssertionError: promise resolved "{ ok: true }" instead of rejecting\n    at x';

// Pull request A: its fix makes the publisher refuse a failed compile, so it
// changed the compile mock of an existing test file (the three changed lines
// below are the pull request's) and added new test files.
const A_FILE = `${AG}/src/__tests__/publish-git-dir-run-declarations-3924.test.ts`;
const A_OLD = 'import { describe, expect, it, vi } from "vitest";\n\nvi.mock("../oas-compiler", () => ({\n  compileOasAgentJson: vi.fn(async () => ({ ok: false })),\n}));\n\nimport { publishAgentPackageFromGitDir } from "../verdaccio/client";\n\ndescribe("publish from a git dir", () => {\n  it("carries the run declarations", async () => {\n    expect(await publishAgentPackageFromGitDir({ agentDir: "a" })).toBeTruthy();\n  });\n  it("refuses a malformed declaration", async () => {\n    await expect(publishAgentPackageFromGitDir({ agentDir: "b" })).rejects.toThrow();\n  });\n});\n';
const A_NEW = A_OLD.replace(
  'vi.mock("../oas-compiler", () => ({\n  compileOasAgentJson: vi.fn(async () => ({ ok: false })),',
  '// cinatra#4264: the publisher refuses a failed compile, so the mock compiles.\nvi.mock("../oas-compiler", () => ({\n  compileOasAgentJson: vi.fn(async () => ({ ok: true, value: {} })),',
);
const A_TITLES = ["carries the run declarations", "refuses a malformed declaration"];
const A_REL = "src/__tests__/publish-git-dir-run-declarations-3924.test.ts";
const A_NEW_REL = "src/__tests__/publish-lifecycle-carry-4264.test.ts";
const A_FILES = {
  base: { ...AG_CONFIG, [`${AG}/src/verdaccio/client.ts`]: "export const refuse = false;\n", [A_FILE]: A_OLD },
  head: { [`${AG}/src/verdaccio/client.ts`]: "export const refuse = true;\n", [`${AG}/src/FIXED`]: "", [A_FILE]: A_NEW, [`${AG}/${A_NEW_REL}`]: "// the new test file\n" },
};
const A_QUIET = passedFile(A_REL, "publish from a git dir", A_TITLES);
const A_RED = { rel: A_NEW_REL, suite: "carry", status: "failed", tests: [{ title: "a failed compile refuses the publish", status: "failed", failure: ASSERT_REJECT }] };
const A_GREEN = passedFile(A_NEW_REL, "carry", ["a failed compile refuses the publish"]);
// The earlier version (compile mock { ok: false }) run with the fix: the publisher refuses, so it fails.
const A_EARLIER = {
  rel: A_REL,
  suite: "publish from a git dir",
  status: "failed",
  tests: [{ title: A_TITLES[0], status: "failed", failure: "Error: compile failed\n    at x" }, { title: A_TITLES[1], status: "passed" }],
};

test("pull request A (collateral mock edit): PASS with a COLLATERAL note; the earlier version runs once, in the tree with the fix, and fails there", async (t) => {
  const r = runVitest(
    t,
    {
      before: { report: vitestReport([A_QUIET, A_RED]), exit: 1 },
      head: { report: vitestReport([A_QUIET, A_GREEN]), exit: 0 },
      earlier: { report: vitestReport([A_EARLIER]), exit: 1 },
    },
    "",
    A_FILES,
  );
  assertPass(r);
  assert.deepEqual(noteCodes(r), [`COLLATERAL:${A_FILE}`]);
  assert.match(r.verdict.notes[0].detail, /earlier version fails with the fix \(publish from a git dir carries the run declarations\)/);
  assert.deepEqual(r.calls.map((c) => c.phase), ["before", "head", "head"]);
  const [first, , third] = r.calls;
  assert.match(first.texts[A_REL], /ok: true, value: \{\}/);
  assert.deepEqual(Object.keys(third.texts), [A_REL]);
  assert.match(third.texts[A_REL], /ok: false/, "the third run reads the file's earlier version");
});

test("pull request A: a test name that only the new version reports makes the edit a new test (NOT-RED-BEFORE)", async (t) => {
  const grown = passedFile(A_REL, "publish from a git dir", [...A_TITLES, "publishes after a good compile"]);
  const r = runVitest(
    t,
    {
      before: { report: vitestReport([grown, A_RED]), exit: 1 },
      head: { report: vitestReport([grown, A_GREEN]), exit: 0 },
      earlier: { report: vitestReport([A_EARLIER]), exit: 1 },
    },
    "",
    A_FILES,
  );
  assertRed(r, "NOT-RED-BEFORE");
  assert.match(r.verdict.reasons[0].detail, /publish from a git dir publishes after a good compile/);
});

test("pull request A: an earlier version with no readable report is not collateral (NOT-RED-BEFORE)", async (t) => {
  const r = runVitest(
    t,
    {
      before: { report: vitestReport([A_QUIET, A_RED]), exit: 1 },
      head: { report: vitestReport([A_QUIET, A_GREEN]), exit: 0 },
      earlier: { exit: 1 },
    },
    "",
    A_FILES,
  );
  assertRed(r, "NOT-RED-BEFORE");
  assert.match(r.verdict.reasons[0].detail, /its run gave no readable report/);
});

// Pull request B: it added one pin test to an existing file (the test passes
// before the fix by design) and a new test file for a new export, whose tests
// all failed before the fix with the TypeError below, none by an assertion.
const B_PIN_FILE = `${AG}/src/__tests__/import-agent-core-lifecycle-config.test.ts`;
const B_PIN_REL = "src/__tests__/import-agent-core-lifecycle-config.test.ts";
const B_NEW_REL = "src/__tests__/regenerate-declaration-check-4264.test.ts";
const B_SUITE = "importAgentTemplateCore compiles cinatra.lifecycle";
const B_PIN_TITLE = "cinatra#4264 A1a: a declared regenerate list is not stored on lifecycleConfig (A1b stores it)";
const B_OLD = 'import { describe, expect, it } from "vitest";\n\ndescribe("importAgentTemplateCore compiles cinatra.lifecycle", () => {\n  it("stores a declared block", async () => {\n    expect(1).toBe(1);\n  });\n\n  it("a MALFORMED block does not crash the import", async () => {\n    expect(1).toBe(1);\n  });\n});\n';
const B_ADDED = `  it("${B_PIN_TITLE}", async () => {\n    const regenerate = [{ artifactNode: "file_image", step: "image_flow", noteInput: "prompt" }];\n    await importZip({ lifecycle: { regenerate } });\n    expect(createInput().lifecycleConfig).toBeNull();\n  });\n\n`;
const bNew = (marker) => B_OLD.replace('  it("a MALFORMED block', `${marker}${B_ADDED}  it("a MALFORMED block`);
const B_TYPE_ERROR = "TypeError: (0 , __vite_ssr_import_1__.checkRegenerateDeclaration) is not a function\n    at x";
const B_CONTRACT = `${AG}/src/verdaccio/package-contract.ts`;
const B_CONTRACT_HEAD = "export const agentLifecycleDeclarationSchema = {};\nexport function checkRegenerateDeclaration(flow) {\n  return { ok: Boolean(flow) };\n}\n";
const bFiles = (marker, contract) => ({
  base: { ...AG_CONFIG, [B_CONTRACT]: "export const agentLifecycleDeclarationSchema = {};\n", [B_PIN_FILE]: B_OLD },
  head: { [B_CONTRACT]: contract, [`${AG}/src/FIXED`]: "", [B_PIN_FILE]: bNew(marker), [`${AG}/${B_NEW_REL}`]: 'import { checkRegenerateDeclaration } from "../verdaccio/package-contract";\n' },
});
const B_OLD_TITLES = ["stores a declared block", "a MALFORMED block does not crash the import"];
const B_CHECKS = ["accepts a wired declaration", "refuses an unknown step"];
const B_AT_HEAD = [B_OLD_TITLES[0], B_PIN_TITLE, B_OLD_TITLES[1]];
const bSpec = () => ({
  before: {
    report: vitestReport([
      passedFile(B_PIN_REL, B_SUITE, B_AT_HEAD),
      { rel: B_NEW_REL, suite: "checkRegenerateDeclaration", status: "failed", tests: B_CHECKS.map((title) => ({ title, status: "failed", failure: B_TYPE_ERROR })) },
    ]),
    exit: 1,
  },
  head: { report: vitestReport([passedFile(B_PIN_REL, B_SUITE, B_AT_HEAD), passedFile(B_NEW_REL, "checkRegenerateDeclaration", B_CHECKS)]), exit: 0 },
  earlier: { report: vitestReport([passedFile(B_PIN_REL, B_SUITE, B_OLD_TITLES)]), exit: 0 },
});
const B_MARKER = "  // red-first-pin: a declared regenerate list is not stored on lifecycleConfig\n";

test("pull request B as it was pushed: the new export's TypeError is the right reason now; the undeclared pin test is the one reason left", async (t) => {
  const r = runVitest(t, bSpec(), "", bFiles("", B_CONTRACT_HEAD));
  assertRed(r, "NOT-RED-BEFORE");
  assert.deepEqual(codes(r), ["NOT-RED-BEFORE"]);
  assert.equal(r.verdict.reasons[0].file, B_PIN_FILE);
  assert.match(r.verdict.reasons[0].detail, /1 test\(s\) the pull request adds do not fail first: .*a declared regenerate list is not stored/);
  assert.equal(r.verdict.files.find((f) => f.file === `${AG}/${B_NEW_REL}`).proven, true);
});

test("pull request B with its pin declared: PASS, the new export file proven with a note, the pin a PIN note", async (t) => {
  const r = runVitest(t, bSpec(), "", bFiles(B_MARKER, B_CONTRACT_HEAD));
  assertPass(r);
  assert.deepEqual(noteCodes(r).sort(), [`ADDED-BY-FIX:${AG}/${B_NEW_REL}`, `PIN:${B_PIN_FILE}`]);
  assert.match(r.verdict.notes.find((n) => n.code === "ADDED-BY-FIX").detail, /the export checkRegenerateDeclaration is not there yet/);
});

test("pull request B's TypeError without the export on the fix side is still RED (WRONG-REASON)", async (t) => {
  // Same reports, but the fix side does not add checkRegenerateDeclaration.
  const r = runVitest(t, bSpec(), "", bFiles(B_MARKER, "export const agentLifecycleDeclarationSchema = { strict: false };\n"));
  assertRed(r, "WRONG-REASON");
});

// Pull request C: a new test file imports, at its top, a module the fix adds;
// before the fix the file does not load, with the runner's message below.
const C_TEST = "scripts/extensions/__tests__/agent-hitl-screen-schema.test.mjs";
const C_MODULE = "scripts/extensions/agent-hitl-screen-schema.mjs";
const cFiles = (module) => ({
  base: { "vitest.config.mjs": "export default {};\n", "scripts/extensions/index.mjs": "export {};\n" },
  head: { [module]: "export const schema = {};\n", "src/FIXED": "", [C_TEST]: 'import { schema } from "../agent-hitl-screen-schema.mjs";\n' },
});
const cSpec = () => ({
  before: { report: vitestReport([{ rel: C_TEST, status: "failed", message: `Cannot find module '../agent-hitl-screen-schema.mjs' imported from <cwd>/${C_TEST}`, tests: [] }]), exit: 1 },
  head: { report: vitestReport([passedFile(C_TEST, "schema", ["accepts a screen", "refuses an unknown key"])]), exit: 0 },
});

test("pull request C (a new test file of a module the fix adds): the load error names that module, so the file is proven with a note", async (t) => {
  const r = runVitest(t, cSpec(), "", cFiles(C_MODULE));
  assertPass(r);
  assert.deepEqual(noteCodes(r), [`ADDED-BY-FIX:${C_TEST}`]);
  assert.ok(r.verdict.notes[0].detail.includes(`the module ${C_MODULE} is not there yet`), r.verdict.notes[0].detail);
});

test("pull request C's load error when the fix side adds another module is still RED (LOAD-ERROR)", async (t) => {
  assertRed(runVitest(t, cSpec(), "", cFiles("scripts/extensions/agent-hitl-screen-render.mjs")), "LOAD-ERROR");
});

// --- units -------------------------------------------------------------------

test("pins: red-first-pin lines are read like markers; an empty one is dropped", async () => {
  const { readPins, readMarkers } = await gateModule();
  const source = "// red-first-pin: keeps the old answer\n/* red-first-pin:  stays null */\n// red-first-pin:\n// red-first-expect: boom\n";
  assert.deepEqual(readPins(source), ["keeps the old answer", "stays null"]);
  assert.deepEqual(readMarkers(source), ["boom"]);
});

test("evidence: the name a not-a-function text calls, the exports of added lines, and the modules a text misses", async () => {
  const { missingCallable, exportNames, missingModules, parseRangeDiff, changedTestLine, addedByFix } = await gateModule();
  assert.equal(missingCallable("TypeError: (0 , __vite_ssr_import_1__.checkRegenerateDeclaration) is not a function"), "checkRegenerateDeclaration");
  assert.equal(missingCallable("TypeError: calc.sum is not a function"), "sum");
  assert.equal(missingCallable("TypeError: Widget is not a constructor"), "Widget");
  assert.equal(missingCallable("TypeError: (0 , _mod.default) is not a function"), null);
  assert.equal(missingCallable("TypeError: rows[0] is not a function"), null);
  assert.equal(missingCallable("Error: calc.sum is not a function"), null, "only a TypeError that starts the text");
  assert.equal(missingCallable("TypeError: Cannot read properties of undefined (reading 'sum')"), null);
  assert.deepEqual(
    exportNames(["export function a() {}", "export async function* b() {}", "  export const c = 1;", "export class D {}", "export { e, f as g, type H };", "exports.i = 1;", "module.exports.j = 2;", "export default function k() {}", "export type L = string;", "export interface M {}", "const n = 1;"]),
    ["a", "b", "c", "D", "e", "g", "i", "j"],
  );
  assert.deepEqual(missingModules("Error: Cannot find module '../x.mjs' imported from /t/test/a.test.mjs"), [{ spec: "../x.mjs", importer: "/t/test/a.test.mjs", kind: "node" }]);
  assert.deepEqual(missingModules('Failed to resolve import "./y" from "src/a.test.ts". Does the file exist?'), [{ spec: "./y", importer: "src/a.test.ts", kind: "node" }]);
  assert.deepEqual(missingModules("Failed to load url /src/z.ts (resolved id: /src/z.ts) in /t/src/a.test.ts. Does the file exist?"), [{ spec: "/src/z.ts", importer: "/t/src/a.test.ts", kind: "vite" }]);
  const diff = parseRangeDiff(
    'diff --git a/src/a.mjs b/src/a.mjs\nindex 1..2 100644\n--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1 +1,2 @@\n-export function old() {}\n+export function old(x) {}\n+export function fresh() {}\ndiff --git "a/src/q\\"uote.mjs" "b/src/q\\"uote.mjs"\n--- "a/src/q\\"uote.mjs"\n+++ "b/src/q\\"uote.mjs"\n@@ -0,0 +1 @@\n+export function hidden() {}\n',
  );
  // a quoted path is decoded (the gate reads exports from blobs, never from this diff)
  assert.deepEqual([...diff.keys()], ["src/a.mjs", 'src/q"uote.mjs']);
  assert.deepEqual(diff.get('src/q"uote.mjs').added, ["export function hidden() {}"]);
  assert.deepEqual(diff.get("src/a.mjs"), { added: ["export function old(x) {}", "export function fresh() {}"], removed: ["export function old() {}"] });
  // changed lines of a test file: declarations and assertions count, comments and other calls do not
  assert.equal(changedTestLine(["// expect(a).toBe(1) in a comment", ' * it("x")', "  compile: vi.fn(async () => ({ ok: true })),", "const hit = /x/.test(name);"]), null);
  for (const line of ['  it("x", () => {});', "test.each(rows)('x', fn);", "describe.skip(`x`, fn);", "  expect(a).toBe(1);", "  assert.equal(a, 1);", "    .toEqual({ a: 1 });", "  await expect(p).rejects.toThrow();", "/* note */ expect(a).toBe(1);"]) {
    assert.equal(changedTestLine([line]), line, line);
  }
  const source = 'import * as calc from "../src/calc.mjs";\nimport { sum } from "../src/calc.mjs";\nimport { x } from "../src/sum.js";\nimport kit from "../lib/kit";\n';
  const ctx = { source, exportsByFile: () => new Map([["src/calc.mjs", new Set(["sum"])]]), addedFix: new Set(["src/sum.ts", "lib/kit/index.mjs"]), roots: ["/t"], runnerDir: "pkg" };
  assert.equal(addedByFix("TypeError: calc.sum is not a function", "test/a.test.mjs", ctx), "the export sum");
  assert.equal(addedByFix("TypeError: calc.total is not a function", "test/a.test.mjs", ctx), null);
  assert.equal(addedByFix("SyntaxError: The requested module '../src/calc.mjs' does not provide an export named 'sum'", "test/a.test.mjs", ctx), "the export sum");
  assert.equal(addedByFix("Error: Cannot find module '/t/src/sum.js' imported from /t/test/a.test.mjs", "test/a.test.mjs", ctx), "the module src/sum.ts");
  assert.equal(addedByFix("Error: Cannot find module '../lib/kit' imported from /elsewhere/a.test.mjs", "test/a.test.mjs", ctx), "the module lib/kit/index.mjs");
  assert.equal(addedByFix("Error: Cannot find module '../../outside.mjs' imported from /t/test/a.test.mjs", "test/a.test.mjs", ctx), null);
  assert.equal(addedByFix("Error: Cannot find package 'left-pad' imported from /t/test/a.test.mjs", "test/a.test.mjs", ctx), null);
});

// Finding 3 of the review: what the fix adds is bound to the test file's own imports and to code.
test("evidence is bound: the export is new in the module the test file imports it from, the module is one the test file imports", async () => {
  const { addedByFix, exportNames, exportsOf, importsOf, missingModules, evidencePath } = await gateModule();
  // an export declared without a value, or in a declaration file, is no value
  assert.deepEqual(exportNames(["export declare function ghost(): void;", "export declare const c: number;"]), []);
  assert.equal(evidencePath("src/types.d.ts"), false);
  assert.equal(evidencePath("src/sum.ts"), true);
  // test code on the fix side by its place or name is never evidence
  for (const p of ["test/support.mjs", "src/__mocks__/x.ts", "tests/helpers/a.mjs", "src/test-utils/a.ts", "src/sum.fixture.ts", "src/mock-server.ts"]) assert.equal(evidencePath(p), false, p);
  // an export inside a comment, a template literal or a string is not an export
  assert.deepEqual([...exportsOf("/*\nexport function ghost() {}\n*/\nconst t = `\nexport function phantom() {}\n`;\nconst s = 'export function spook() {}';\nexport function real() {}\n")], ["real"]);
  assert.deepEqual([...exportsOf("a = /['\"]/; b = 1;\nexport const real = 1;\n")], ["real"]);
  // a regular expression after a keyword that holds a backtick: never a template that would expose a later one
  assert.deepEqual([...exportsOf("function f(x) {\n  return /`/.test(x);\n}\nconst t = `\nexport function ghost() {}\n`;\nexport const real = 1;\n")], ["real"]);
  assert.deepEqual([...exportsOf("function f(x) {\n  return /a+b/.test(x);\n}\nconst t = `\nexport function ghost() {}\n`;\nexport const real = 1;\n")], ["real"]);
  // a division is not a regular expression
  assert.deepEqual([...exportsOf("const half = total / 2;\nexport const real = half / 1;\n")], ["real"]);
  // imports: named, namespace, default, side effect, require; type imports bind no value
  assert.deepEqual(
    importsOf('import { a, b as c, type T } from "./m";\nimport * as ns from "./n";\nimport d from "./d";\nimport "./side";\nimport type { X } from "./types";\nconst { e } = require("./r");\nconst whole = require("./w");\n// import { ghost } from "./g";\n').map((x) => `${x.spec}:${[...x.names].join(",")}:${x.whole}`),
    ["./m:a,b:false", "./n::true", "./d::true", "./side::false", "./r:e:false", "./w::true"],
  );
  // an import written inside a string or a template literal binds nothing
  assert.deepEqual(importsOf('const s = \'import { ghost } from "../src/g"\';\nconst u = `import * as all from "../src/g"`;\n'), []);
  // a missing-module text inside another message is not the runner's error
  assert.deepEqual(missingModules(`Error: helper printed "Cannot find module './x.mjs'"`), []);
  assert.equal(missingModules("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/t/src/x.mjs' imported from /t/test/a.test.mjs").length, 1);
  const map = new Map([["src/other.mjs", new Set(["ghost"])], ["src/calc.mjs", new Set(["sum"])]]);
  const base = { exportsByFile: () => map, addedFix: new Set(["src/sum.mjs", "test/support.mjs"]), roots: ["/t"], runnerDir: "" };
  // the TypeError names an export that another module adds, not the module the test imports it from
  assert.equal(addedByFix("TypeError: helper.ghost is not a function", "test/a.test.mjs", { ...base, source: 'import * as helper from "../src/helper.mjs";\n' }), null);
  // the export's module bound by a named import: evidence; the same name imported from elsewhere: none
  assert.equal(addedByFix("TypeError: (0 , __vite_ssr_import_1__.sum) is not a function", "test/a.test.mjs", { ...base, source: 'import { sum } from "../src/calc.mjs";\n' }), "the export sum");
  assert.equal(addedByFix("TypeError: (0 , __vite_ssr_import_1__.sum) is not a function", "test/a.test.mjs", { ...base, source: 'import { sum } from "../src/math.mjs";\n' }), null);
  // the added module must be one the test file imports
  assert.equal(addedByFix("Error: Cannot find module '/t/src/sum.mjs' imported from /t/test/a.test.mjs", "test/a.test.mjs", { ...base, source: 'import "../src/other.mjs";\n' }), null);
  assert.equal(addedByFix("Error: Cannot find module '/t/src/sum.mjs' imported from /t/test/a.test.mjs", "test/a.test.mjs", { ...base, source: 'import { s } from "../src/sum.mjs";\n' }), "the module src/sum.mjs");
  // an absolute path outside the tree is not mapped into it
  assert.equal(addedByFix("Error: Cannot find module '/src/sum.mjs' imported from /t/test/a.test.mjs", "test/a.test.mjs", { ...base, source: 'import { s } from "../src/sum.mjs";\n' }), null);
  // a module in the test file's own folder is not evidence
  assert.equal(addedByFix("Error: Cannot find module '/t/src/sum.mjs' imported from /t/src/a.test.mjs", "src/a.test.mjs", { ...base, source: 'import { s } from "./sum.mjs";\n' }), null);
});

test("judgeFile without a context judges as before: no earlier version read means no collateral, and no evidence means WRONG-REASON", async () => {
  const { judgeFile } = await gateModule();
  const ok = (tests) => ({ run: "ok", result: { loaded: true, loadError: null, fileError: null, tests } });
  const quiet = [{ name: "a", status: "passed", text: null, assertion: false }];
  const changed = judgeFile({ file: "t.test.mjs", status: "M" }, ok(quiet), ok(quiet));
  assert.deepEqual(changed.reasons.map((r) => r.code), ["NOT-RED-BEFORE"]);
  assert.equal(changed.kind, null);
  const thrown = [{ name: "a", status: "failed", text: "TypeError: calc.sum is not a function", assertion: false }];
  assert.deepEqual(judgeFile({ file: "t.test.mjs" }, ok(thrown), ok(quiet)).reasons.map((r) => r.code), ["WRONG-REASON"]);
});

test("README: the red-first section names the notes, the pin marker and the NOTHING-PROVEN outcome, and never a NEUTRAL green", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## red-first-gate"), readme.indexOf("## Developing in this repo"));
  for (const word of ["`COLLATERAL`", "`PIN`", "`ADDED-BY-FIX`", "`PIN-MISMATCH`", "red-first-pin:", "`NOTHING-PROVEN`"]) {
    assert.ok(section.includes(word), `the README section does not name ${word}`);
  }
  assert.doesNotMatch(section, /NEUTRAL|NOTHING-TO-PROVE/);
  assert.match(section, /green only when at least one new test file is proven/);
});

test("judgeFile: every way an earlier version is unreadable keeps the file NOT-RED-BEFORE, and an unreadable diff counts as a changed test", async () => {
  const { judgeFile } = await gateModule();
  const ok = (tests, more = {}) => ({ run: "ok", result: { loaded: true, loadError: null, fileError: null, tests, ...more } });
  const quiet = [{ name: "a", status: "passed", text: null, assertion: false }];
  const judge = (context) => judgeFile({ file: "t.test.mjs", status: "M" }, ok(quiet), ok(quiet), context);
  const cases = [
    [{ run: "timeout" }, /its run did not finish in time/],
    [{ run: "no-report" }, /its run gave no readable report/],
    [{ run: "stopped" }, /its run gave no readable report/],
    [{ run: "ok", result: null }, /it is not in the runner's report/],
    [ok([], { loaded: false, loadError: "Cannot find module x" }), /it does not load: Cannot find module x/],
    [ok(quiet, { fileError: "late failure" }), /its run reports a file error: late failure/],
    [ok([{ name: "a", status: "weird", text: null, assertion: false }]), /its report gives an unknown status/],
  ];
  for (const [earlier, why] of cases) {
    const judged = judge({ earlier, changedTestLine: null });
    assert.deepEqual(judged.reasons.map((r) => r.code), ["NOT-RED-BEFORE"], String(why));
    assert.match(judged.reasons[0].detail, why);
    assert.equal(judged.kind, null);
    assert.deepEqual(judged.notes, []);
  }
  // the earlier version read with the fix: the same tests, one fails there (the fix breaks it), no changed test line: collateral
  const broken = [{ name: "a", status: "failed", text: "AssertionError: x", assertion: true }];
  const collateral = judge({ earlier: ok(broken), changedTestLine: null });
  assert.deepEqual([collateral.reasons.length, collateral.kind, collateral.proven, collateral.notes[0].code], [0, "collateral", false, "COLLATERAL"]);
  // the earlier version also passes with the fix: the fix does not need the edit, so it is not collateral
  const unneeded = judge({ earlier: ok(quiet), changedTestLine: null });
  assert.deepEqual(unneeded.reasons.map((r) => r.code), ["NOT-RED-BEFORE"]);
  assert.match(unneeded.reasons[0].detail, /earlier version also passes with the fix, so the fix does not need the edit/);
  // a runner whose exit contradicts its report is not read
  const contra = judge({ earlier: { run: "contradicts", detail: "vitest in pkg exited 1 although its report shows no failure" }, changedTestLine: null });
  assert.match(contra.reasons[0].detail, /its runner's exit does not match its report \(vitest in pkg exited 1/);
  // the same, but the file's diff could not be read (rangeReader says so): a changed test
  const unread = judge({ earlier: ok(broken), changedTestLine: "the file's diff is not readable" });
  assert.deepEqual(unread.reasons.map((r) => r.code), ["NOT-RED-BEFORE"]);
  assert.match(unread.reasons[0].detail, /the file's diff is not readable/);
  // a skipped test of the earlier version still counts as a test of that name
  const az = ok([...quiet, { name: "z", status: "passed", text: null, assertion: false }]);
  const skipped = judgeFile({ file: "t.test.mjs", status: "M" }, az, az, { earlier: ok([{ name: "a", status: "skipped", text: null, assertion: false }, { name: "z", status: "failed", text: "AssertionError: x", assertion: true }]), changedTestLine: null });
  assert.equal(skipped.kind, "collateral");
  // a collateral file must stay green: a test that passed before and is skipped with the fix is RED
  const lost = judgeFile({ file: "t.test.mjs", status: "M" }, ok([...quiet, { name: "b", status: "passed", text: null, assertion: false }]), ok([...quiet, { name: "b", status: "skipped", text: null, assertion: false }]), {
    earlier: ok([...broken, { name: "b", status: "passed", text: null, assertion: false }]),
    changedTestLine: null,
  });
  assert.deepEqual(lost.reasons.map((r) => r.code), ["NOT-GREEN-AT-HEAD"]);
  assert.match(lost.reasons[0].detail, /passed before the fix but did not pass with it: b/);
});

test("judgeFile: pins in a new file, pins alone, a pin on a skipped test, and pins in a file that does not load before the fix", async () => {
  const { judgeFile } = await gateModule();
  const ok = (tests) => ({ run: "ok", result: { loaded: true, loadError: null, fileError: null, tests } });
  const t = (name, status = "passed") => ({ name, status, text: status === "failed" ? "AssertionError: x" : null, assertion: status === "failed" });
  // a new file whose tests are all declared pins: a PIN note, not proven
  const all = judgeFile({ file: "n.test.mjs", status: "A", pins: ["keeps a", "keeps b"] }, ok([t("keeps a"), t("keeps b")]), ok([t("keeps a"), t("keeps b")]));
  assert.deepEqual([all.reasons.length, all.kind, all.proven, all.notes[0].code], [0, "pins", false, "PIN"]);
  // one test of the new file is not named by a pin: it must fail first
  const part = judgeFile({ file: "n.test.mjs", status: "A", pins: ["keeps a"] }, ok([t("keeps a"), t("does b")]), ok([t("keeps a"), t("does b")]));
  assert.deepEqual(part.reasons.map((r) => r.code), ["NOT-RED-BEFORE"]);
  assert.match(part.reasons[0].detail, /1 test\(s\) the pull request adds do not fail first: does b/);
  // a pin beside a red test: the file is proven by the red test, the pin is checked
  const beside = judgeFile({ file: "n.test.mjs", status: "A", pins: ["keeps a"] }, ok([t("keeps a"), t("does b", "failed")]), ok([t("keeps a"), t("does b")]));
  assert.deepEqual([beside.reasons.length, beside.kind, beside.proven], [0, "proven", true]);
  // a pin on a test that is skipped before the fix is not a pin that passes
  const skipped = judgeFile({ file: "n.test.mjs", status: "A", pins: ["keeps a"] }, ok([t("keeps a", "skipped"), t("does b", "failed")]), ok([t("keeps a"), t("does b")]));
  assert.deepEqual(skipped.reasons.map((r) => r.code), ["PIN-MISMATCH"]);
  // one marker names one test: a text that is in two test names (a describe name, a short word) is refused
  const broad = judgeFile({ file: "n.test.mjs", status: "A", pins: ["keeps"] }, ok([t("keeps a"), t("keeps b")]), ok([t("keeps a"), t("keeps b")]));
  assert.deepEqual(broad.reasons.map((r) => r.code), ["PIN-MISMATCH"]);
  assert.match(broad.reasons[0].detail, /is in more than one test name of the file/);
  // one marker names one test occurrence: a name reported twice (two tests of one title, two projects) is refused
  const twice = judgeFile({ file: "n.test.mjs", status: "A", pins: ["keeps a"] }, ok([t("keeps a"), t("keeps a")]), ok([t("keeps a"), t("keeps a")]));
  assert.deepEqual(twice.reasons.map((r) => r.code), ["PIN-MISMATCH"]);
  assert.match(twice.reasons[0].detail, /or in a name the report gives more than once/);
  // a file that does not load before the fix cannot hold a passing pin, also with evidence of what the fix adds
  const unloaded = { run: "ok", result: { loaded: false, loadError: "Cannot find module '../src/sum.mjs'", loadText: "Cannot find module '../src/sum.mjs'", fileError: null, tests: [] } };
  const withPin = judgeFile({ file: "n.test.mjs", status: "A", pins: ["keeps a"] }, unloaded, ok([t("keeps a")]), { addedByFix: () => "the module src/sum.mjs" });
  assert.deepEqual(withPin.reasons.map((r) => r.code), ["PIN-MISMATCH"]);
  const noPin = judgeFile({ file: "n.test.mjs", status: "A" }, unloaded, ok([t("keeps a")]), { addedByFix: () => "the module src/sum.mjs" });
  assert.deepEqual([noPin.reasons.length, noPin.kind, noPin.notes[0].code], [0, "proven", "ADDED-BY-FIX"]);
  // a file that loads with the fix but passes no test there is not proven by the load error
  const empty = judgeFile({ file: "n.test.mjs", status: "A" }, unloaded, ok([t("keeps a", "skipped")]), { addedByFix: () => "the module src/sum.mjs" });
  assert.deepEqual(empty.reasons.map((r) => `${r.code}:${r.phase}`), ["NOT-COLLECTED:head"]);
});

test("pins alone: a pull request whose only test change is a declared pin proves nothing: RED (NOTHING-PROVEN)", async (t) => {
  const pinned = `${PUB_NEW}\n// red-first-pin: a good compile still publishes\n${PIN_TEST}`;
  const sc = scenario(t, { base: PIN_BASE, head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": pinned } });
  const r = runGate(sc, "run");
  assertRed(r, "NOTHING-PROVEN");
  assert.deepEqual(codes(r), ["NOTHING-PROVEN"]);
  assert.deepEqual(noteCodes(r), ["PIN:test/publish.test.mjs"]);
});

test("judgeFile: a declared pin beside a red test must pass with the fix too; the range diff reads a path with a space", async () => {
  const { judgeFile, parseRangeDiff } = await gateModule();
  const ok = (tests) => ({ run: "ok", result: { loaded: true, loadError: null, fileError: null, tests } });
  const t = (name, status = "passed") => ({ name, status, text: status === "failed" ? "AssertionError: x" : null, assertion: status === "failed" });
  // the file is red first by "does b"; its pin "keeps a" passes before the fix but is skipped with it
  const lost = judgeFile({ file: "n.test.mjs", status: "A", pins: ["keeps a"] }, ok([t("keeps a"), t("does b", "failed")]), ok([t("keeps a", "skipped"), t("does b")]));
  assert.deepEqual(lost.reasons.map((r) => `${r.code}:${r.phase}`), ["NOT-GREEN-AT-HEAD:head"]);
  assert.match(lost.reasons[0].detail, /or is a declared pin, but did not pass with it: keeps a/);
  assert.equal(lost.proven, false);
  // git ends the file lines of a path with a space with a tab
  const diff = parseRangeDiff("diff --git a/src/my file.mjs b/src/my file.mjs\n--- a/src/my file.mjs\t\n+++ b/src/my file.mjs\t\n@@ -0,0 +1 @@\n+export const one = 1;\n");
  assert.deepEqual([...diff.keys()], ["src/my file.mjs"]);
  assert.deepEqual(diff.get("src/my file.mjs").added, ["export const one = 1;"]);
});

// ---------------------------------------------------------------------------
// Findings 1, 2, 3 and 4 of the review: shapes that must stay RED.
// ---------------------------------------------------------------------------

// A test file that passes before the fix and with it, unchanged by the fix.
const KEEP_OLD = `${TEST_HEAD}import { publish } from "../src/publish.mjs";\n\nconst compile = () => ({ ok: true, value: {} });\nconst expected = /^published/;\n\ntest("publishes the package", () => {\n  assert.match(publish(compile), expected);\n});\n`;

test("finding 1: a changed expected value on a line with no assertion word, which the fix does not need, is RED (NOT-RED-BEFORE)", async (t) => {
  const vacuous = KEEP_OLD.replace("const expected = /^published/;", "const expected = /./;");
  const sc = scenario(t, { base: { ...PUB_BASE, "test/publish.test.mjs": KEEP_OLD }, head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": vacuous, "test/refuse.test.mjs": REFUSE_TEST } });
  const r = runGate(sc, "run");
  assertRed(r, "NOT-RED-BEFORE");
  assert.equal(r.verdict.reasons[0].file, "test/publish.test.mjs");
  assert.match(r.verdict.reasons[0].detail, /earlier version also passes with the fix, so the fix does not need the edit/);
});

test("finding 1: a mock edit the fix does not need (the earlier version passes with the fix) is RED, also beside a proven file", async (t) => {
  const mocked = KEEP_OLD.replace("({ ok: true, value: {} })", "({ ok: true, value: { extra: 1 } })");
  const sc = scenario(t, { base: { ...PUB_BASE, "test/publish.test.mjs": KEEP_OLD }, head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": mocked, "test/refuse.test.mjs": REFUSE_TEST } });
  assertRed(runGate(sc, "run"), "NOT-RED-BEFORE");
});

test("finding 2: a marker the file already had declares nothing: a new test of that name must fail first", async (t) => {
  const withMarker = `${PUB_NEW}// red-first-pin: a good compile still publishes\n`;
  const sc = scenario(t, {
    base: { ...PUB_BASE, "test/publish.test.mjs": withMarker },
    head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": `${withMarker}\n${PIN_TEST}`, "test/refuse.test.mjs": REFUSE_TEST },
  });
  const r = runGate(sc, "run");
  assertRed(r, "NOT-RED-BEFORE");
  assert.match(r.verdict.reasons[0].detail, /1 test\(s\) the pull request adds do not fail first: a good compile still publishes/);
});

test("finding 2: one marker for two added tests of one name is PIN-MISMATCH", async (t) => {
  const twice = `${PUB_NEW}\n// red-first-pin: a good compile still publishes\n${PIN_TEST}${PIN_TEST}`;
  const sc = scenario(t, { base: PIN_BASE, head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": twice, "test/refuse.test.mjs": REFUSE_TEST } });
  const r = runGate(sc, "run");
  assertRed(r, "PIN-MISMATCH");
  assert.match(r.verdict.reasons[0].detail, /in a name the report gives more than once/);
});

test("finding 2: a pin beside an edit of an existing test (lines changed, not only added) is RED", async (t) => {
  const edited = `${KEEP_OLD.replace("const expected = /^published/;", "const expected = /./;")}\n// red-first-pin: a good compile still publishes\n${PIN_TEST}`;
  const sc = scenario(t, { base: { ...PUB_BASE, "test/publish.test.mjs": KEEP_OLD }, head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": edited, "test/refuse.test.mjs": REFUSE_TEST } });
  const r = runGate(sc, "run");
  assertRed(r, "NOT-RED-BEFORE");
  assert.match(r.verdict.reasons[0].detail, /declares pins but also changes or removes lines of the file/);
});

test("finding 2: pins added only by inserted lines to a file whose earlier version the fix breaks are RED", async (t) => {
  // Inserted lines only (nothing removed) make the old test pass with the fix.
  const inserted = PUB_OLD.replace("const compile = () => ({ ok: false });\n", "const compile = () => ({ ok: false });\nconst good = () => ({ ok: true });\n").replace(
    'test("publishes the package", () => {\n',
    'test("publishes the package", () => {\n  assert.match(publish(good), /^published/);\n  return;\n',
  );
  const sc = scenario(t, {
    base: PUB_BASE,
    head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": `${inserted}\n// red-first-pin: a good compile still publishes\n${PIN_TEST}`, "test/refuse.test.mjs": REFUSE_TEST },
  });
  const r = runGate(sc, "run");
  assertRed(r, "NOT-RED-BEFORE");
  assert.match(r.verdict.reasons[0].detail, /earlier version fails with the fix .* pins are declared only beside existing tests that pass with the fix unchanged/);
});

// Expect markers, like pins, are read only from the lines the pull request
// adds: a marker a merged pull request left in the file declares nothing.
// MUL_OLD: a test file at the base whose test passes, with a marker an earlier
// pull request left behind.
const MUL_OLD = `${TEST_HEAD}// red-first-expect: mul is not a function\nimport { add, mul } from "../src/calc.mjs";\n\ntest("mul multiplies two numbers", () => {\n  assert.equal(mul(2, 3), 6);\n});\n`;
const ADD_CASE = 'test("add sums two numbers", () => {\n  assert.equal(add(1, 2), 3);\n});\n';

test("expect markers: a marker the file already had declares nothing; a new failing test with its own added marker passes", async (t) => {
  const head = `${MUL_OLD}\n// red-first-expect: Expected values to be strictly equal\n${ADD_CASE}`;
  const sc = scenario(t, { base: { ...BASE, "test/calc.test.mjs": MUL_OLD }, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": head } });
  const r = runGate(sc, "run");
  assertPass(r);
  assert.deepEqual(r.verdict.files.map((f) => f.markers), [["Expected values to be strictly equal"]]);
});

test("expect markers: a changed file with only a base marker and a new failing test is judged as a file without markers", async (t) => {
  const sc = scenario(t, { base: { ...BASE, "test/calc.test.mjs": MUL_OLD }, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": `${MUL_OLD}\n${ADD_CASE}` } });
  const r = runGate(sc, "run");
  assertPass(r);
  assert.deepEqual(r.verdict.files.map((f) => f.markers), [[]]);
});

test("expect markers: an added marker that matches no failure is still TEXT-MISMATCH, named; the base marker is not", async (t) => {
  const head = `${MUL_OLD}\n// red-first-expect: add is not a function\n${ADD_CASE}`;
  const sc = scenario(t, { base: { ...BASE, "test/calc.test.mjs": MUL_OLD }, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": head } });
  const r = runGate(sc, "run");
  assertRed(r, "TEXT-MISMATCH");
  const reason = r.verdict.reasons.find((x) => x.code === "TEXT-MISMATCH");
  assert.match(reason.detail, /marker "add is not a function" is in no failure text/);
  assert.doesNotMatch(reason.detail, /mul is not a function/);
});

test("expect markers: a renamed test file's unchanged markers are not added lines; its edit's markers are", async (t) => {
  const sc = scenario(t, {
    base: { ...BASE, "test/old.test.mjs": MUL_OLD },
    head: { "src/calc.mjs": CALC_FIX, "test/old.test.mjs": null, "test/calc.test.mjs": `${MUL_OLD}\n${ADD_CASE}` },
  });
  const r = runGate(sc, "run");
  assertPass(r);
  assert.deepEqual(r.verdict.files.map((f) => `${f.file}:${f.markers.length}`), ["test/calc.test.mjs:0"]);
  // A pure rename (no hunk) is read as a file with no added line, not as an unreadable diff.
  const { parseRangeDiff } = await gateModule();
  const moved = parseRangeDiff("diff --git a/test/old.test.mjs b/test/new.test.mjs\nsimilarity index 100%\nrename from test/old.test.mjs\nrename to test/new.test.mjs\n");
  assert.deepEqual(moved.get("test/new.test.mjs"), { added: [], removed: [] });
});

test("expect markers: every marker of a file the pull request adds is read", async (t) => {
  const head = `${MUL_OLD}\n${ADD_CASE}`;
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": head } });
  const r = runGate(sc, "run");
  assertRed(r, "TEXT-MISMATCH");
  assert.match(r.verdict.reasons.find((x) => x.code === "TEXT-MISMATCH").detail, /marker "mul is not a function" is in no failure text/);
});

// A failure without an assertion: only a matching marker (or what the fix adds) proves it.
const WRONG_SUM = 'test("add sums two numbers", () => {\n  if (add(1, 2) !== 3) throw new Error("add gives the wrong sum");\n});\n';
const WRONG_SUM_FILE = (marker) => `${TEST_HEAD}// red-first-expect: ${marker}\nimport { add } from "../src/calc.mjs";\n\n${WRONG_SUM}`;

test("expect markers: a renamed file's added marker is read and must match; its unchanged old marker is not", async (t) => {
  const renamed = (marker) => ({
    base: { ...BASE, "test/old.test.mjs": MUL_OLD },
    head: { "src/calc.mjs": CALC_FIX, "test/old.test.mjs": null, "test/calc.test.mjs": `${MUL_OLD}\n// red-first-expect: ${marker}\n${WRONG_SUM}` },
  });
  const good = runGate(scenario(t, renamed("add gives the wrong sum")), "run");
  assertPass(good);
  assert.deepEqual(good.verdict.files.map((f) => f.markers), [["add gives the wrong sum"]]);
  const bad = runGate(scenario(t, renamed("add is not a function")), "run");
  assertRed(bad, "TEXT-MISMATCH");
  const reason = bad.verdict.reasons.find((x) => x.code === "TEXT-MISMATCH");
  assert.match(reason.detail, /marker "add is not a function" is in no failure text/);
  assert.doesNotMatch(reason.detail, /mul is not a function/);
});

test("expect markers: a new test file with a non-ASCII name: a matching marker proves a failure without an assertion", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/wörk.test.mjs": WRONG_SUM_FILE("add gives the wrong sum") } });
  const r = runGate(sc, "run");
  assertPass(r);
  assert.deepEqual(r.verdict.files.map((f) => f.markers), [["add gives the wrong sum"]]);
});

test("expect markers: names git writes quoted (non-ASCII, a double quote) and a name with a space: a marker that matches nothing is TEXT-MISMATCH", async (t) => {
  const marked = ADD_TEST.replace(TEST_HEAD, `${TEST_HEAD}// red-first-expect: nothing like this\n`);
  for (const name of ["test/wörk.test.mjs", 'test/say "hi".test.mjs', "test/my calc.test.mjs"]) {
    const r = runGate(scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, [name]: marked } }), "run");
    assertRed(r, "TEXT-MISMATCH");
    assert.match(r.verdict.reasons.find((x) => x.code === "TEXT-MISMATCH").detail, /marker "nothing like this" is in no failure text/, name);
  }
});

test("expect markers: a test file whose diff is not readable keeps every marker of its head source (fail closed)", async (t) => {
  // `-diff` makes git print no hunk for the file: its added lines cannot be read.
  const sc = scenario(t, {
    base: { ...BASE, ".gitattributes": "test/calc.test.mjs -diff\n", "test/calc.test.mjs": MUL_OLD },
    head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": `${MUL_OLD}\n${ADD_CASE}` },
  });
  const r = runGate(sc, "run");
  assertRed(r, "TEXT-MISMATCH");
  assert.match(r.verdict.reasons.find((x) => x.code === "TEXT-MISMATCH").detail, /marker "mul is not a function" is in no failure text/);
});

// A test file at the base whose old marker would match a later failure; `-diff` hides its added lines.
const UNREAD_BASE = (marker) => ({
  ...BASE,
  ".gitattributes": "test/calc.test.mjs -diff\n",
  "test/calc.test.mjs": MUL_OLD.replace("mul is not a function", marker),
});

test("expect markers: in a file whose diff is not readable, a marker of unknown origin never proves a failure without an assertion (WRONG-REASON)", async (t) => {
  const base = UNREAD_BASE("add gives the wrong sum");
  const sc = scenario(t, { base, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": `${base["test/calc.test.mjs"]}\n${WRONG_SUM}` } });
  const r = runGate(sc, "run");
  assertRed(r, "WRONG-REASON");
  const reason = r.verdict.reasons.find((x) => x.code === "WRONG-REASON");
  assert.match(reason.detail, /added lines cannot be read/);
  assert.match(reason.detail, /add gives the wrong sum/);
  assert.deepEqual(r.verdict.files.map((f) => [f.markers, f.unknownMarkers]), [[[], ["add gives the wrong sum"]]]);
});

test("expect markers: in a file whose diff is not readable, an assertion failure is judged as usual; a marker of unknown origin that matches it does not refuse it", async (t) => {
  const base = UNREAD_BASE("!== 3");
  const sc = scenario(t, { base, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": `${base["test/calc.test.mjs"]}\n${ADD_CASE}` } });
  assertPass(runGate(sc, "run"));
});

test("expect markers: an edited rename whose diff is not readable keeps every marker as of unknown origin; only a proven pure rename adds no line", async (t) => {
  const attrs = { ".gitattributes": "test/*.test.mjs -diff\n" };
  // renamed and edited: git prints the similarity and "Binary files ... differ", no hunk
  const edited = scenario(t, {
    base: { ...BASE, ...attrs, "test/old.test.mjs": MUL_OLD },
    head: { "src/calc.mjs": CALC_FIX, "test/old.test.mjs": null, "test/calc.test.mjs": `${MUL_OLD}\n// red-first-expect: add is not a function\n${ADD_CASE}` },
  });
  const r = runGate(edited, "run");
  assertRed(r, "TEXT-MISMATCH");
  assert.deepEqual(r.verdict.files.map((f) => [f.markers, f.unknownMarkers]), [[[], ["mul is not a function", "add is not a function"]]]);
  // a pure rename (similarity 100%) adds no line, also under -diff
  const pure = scenario(t, {
    base: { ...BASE, ...attrs, "test/old.test.mjs": MUL_OLD },
    head: { "src/calc.mjs": CALC_FIX, "test/old.test.mjs": null, "test/calc.test.mjs": MUL_OLD },
  });
  assert.deepEqual(runGate(pure, "run").verdict.files.map((f) => [f.file, f.markers, f.unknownMarkers]), [["test/calc.test.mjs", [], []]]);
  const { parseRangeDiff } = await gateModule();
  const diff = parseRangeDiff(
    [
      "diff --git a/p.mjs b/b.mjs",
      "similarity index 93%",
      "rename from p.mjs",
      "rename to b.mjs",
      "index e8823e1..cf868e2 100644",
      "Binary files a/p.mjs and b/b.mjs differ",
      "diff --git a/a.mjs b/q.mjs",
      "similarity index 100%",
      "rename from a.mjs",
      "rename to q.mjs",
      "",
    ].join("\n"),
  );
  assert.deepEqual([...diff.keys()], ["q.mjs"]);
});

for (const quotePath of ["true", "false"]) {
  test(`expect markers: a quoted name with an astral character and a double quote (core.quotePath=${quotePath}): its added markers are read`, async (t) => {
    const name = 'test/\u{1F600}"x.test.mjs';
    const good = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, [name]: WRONG_SUM_FILE("add gives the wrong sum") } });
    git(good.repo, "config", "core.quotePath", quotePath);
    const r = runGate(good, "run");
    assertPass(r);
    assert.deepEqual(r.verdict.files.map((f) => f.markers), [["add gives the wrong sum"]]);
    const bad = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, [name]: ADD_TEST.replace(TEST_HEAD, `${TEST_HEAD}// red-first-expect: nothing like this\n`) } });
    git(bad.repo, "config", "core.quotePath", quotePath);
    const b = runGate(bad, "run");
    assertRed(b, "TEXT-MISMATCH");
    assert.deepEqual(b.verdict.files.map((f) => f.markers), [["nothing like this"]]);
  });
}

test("diffPath: literal characters are read by code point, the bytes decoded once; invalid UTF-8 does not decode", async () => {
  const { diffPath } = await gateModule();
  assert.equal(diffPath('"b/test/\u{1F600}\\"x.mjs"'), 'b/test/\u{1F600}"x.mjs');
  assert.equal(diffPath('"b/\\360\\237\\230\\200\\"x.mjs"'), 'b/\u{1F600}"x.mjs');
  assert.equal(diffPath('"b/\\377.mjs"'), null);
  assert.equal(diffPath('"b/\\360\\237.mjs"'), null);
});

test("parseRangeDiff: C-quoted paths are decoded (octal bytes, \\\", \\\\, \\t, \\n); a malformed one is left out", async () => {
  const { parseRangeDiff } = await gateModule();
  const diff = parseRangeDiff(
    [
      'diff --git "a/w\\303\\266rk.mjs" "b/w\\303\\266rk.mjs"',
      '--- "a/w\\303\\266rk.mjs"',
      '+++ "b/w\\303\\266rk.mjs"',
      "@@ -0,0 +1 @@",
      "+one",
      'diff --git "a/say \\"hi\\" \\\\ x\\ty\\nz.mjs" "b/say \\"hi\\" \\\\ x\\ty\\nz.mjs"',
      '+++ "b/say \\"hi\\" \\\\ x\\ty\\nz.mjs"\t',
      "@@ -0,0 +1 @@",
      "+two",
      'diff --git "a/old \\"q\\".mjs" "b/new \\"q\\".mjs"',
      "similarity index 100%",
      'rename from "old \\"q\\".mjs"',
      'rename to "new \\"q\\".mjs"',
      'diff --git "a/bad.mjs" "b/bad.mjs"',
      '+++ "b/bad\\q.mjs"',
      "@@ -0,0 +1 @@",
      "+three",
      'diff --git "a/open.mjs" "b/open.mjs"',
      '+++ "b/open.mjs',
      "@@ -0,0 +1 @@",
      "+four",
      "",
    ].join("\n"),
  );
  assert.deepEqual([...diff.keys()].sort(), ["new \"q\".mjs", 'say "hi" \\ x\ty\nz.mjs', "wörk.mjs"].sort());
  assert.deepEqual(diff.get("wörk.mjs").added, ["one"]);
  assert.deepEqual(diff.get('say "hi" \\ x\ty\nz.mjs').added, ["two"]);
  assert.deepEqual(diff.get('new "q".mjs'), { added: [], removed: [] });
});

test("finding 3: a tests-only pull request whose new helper the range lists on the fix side is not proven by its load error (LOAD-ERROR)", async (t) => {
  const helperTest = `${TEST_HEAD}import { two } from "./support.mjs";\n\ntest("two is two", () => {\n  assert.equal(two(), 2);\n});\n`;
  const sc = scenario(t, { base: PUB_BASE, head: { "test/a.test.mjs": helperTest, "test/support.mjs": "export const two = () => 2;\n" } });
  const r = runGate(sc, "run");
  assertRed(r, "LOAD-ERROR");
  assert.deepEqual(r.verdict.notes, []);
});

test("finding 3: pull request B's TypeError when the export moved from another fix-side module, or is added to a module the test does not import: RED (WRONG-REASON)", async (t) => {
  const OTHER = `${AG}/src/verdaccio/other.ts`;
  const moved = bFiles(B_MARKER, B_CONTRACT_HEAD);
  moved.base[OTHER] = "export function checkRegenerateDeclaration(flow) {\n  return { ok: Boolean(flow) };\n}\n";
  moved.head[OTHER] = "export const left = 1;\n";
  assertRed(runVitest(t, bSpec(), "", moved), "WRONG-REASON");
  const elsewhere = bFiles(B_MARKER, "export const agentLifecycleDeclarationSchema = { strict: true };\n");
  elsewhere.head[OTHER] = "export function checkRegenerateDeclaration(flow) {\n  return { ok: Boolean(flow) };\n}\n";
  assertRed(runVitest(t, bSpec(), "", elsewhere), "WRONG-REASON");
});

test("finding 4: an earlier version whose runner exit contradicts its report is not collateral (NOT-RED-BEFORE)", async (t) => {
  const spec = (earlier) => ({ before: { report: vitestReport([A_QUIET, A_RED]), exit: 1 }, head: { report: vitestReport([A_QUIET, A_GREEN]), exit: 0 }, earlier });
  // a failing report with exit 0
  const zero = runVitest(t, spec({ report: vitestReport([A_EARLIER]), exit: 0 }), "", A_FILES);
  assertRed(zero, "NOT-RED-BEFORE");
  assert.match(zero.verdict.reasons[0].detail, /its runner's exit does not match its report \(vitest in packages\/agents exited 0 \(report success: false\) although its report shows a failure\)/);
  // an all-passing report with exit 1
  const one = runVitest(t, spec({ report: vitestReport([A_QUIET]), exit: 1 }), "", A_FILES);
  assertRed(one, "NOT-RED-BEFORE");
  assert.match(one.verdict.reasons[0].detail, /exited 1 although its report shows no failure/);
});

test("finding 4: an earlier version that changes a tracked test-side file is RED (TEST-CHANGED in the earlier run)", async (t) => {
  const writes = PUB_OLD.replace("import { publish }", 'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./__fixtures__/state.txt", import.meta.url), "changed");\nimport { publish }');
  const sc = scenario(t, {
    base: { ...PUB_BASE, "test/publish.test.mjs": writes, "test/__fixtures__/state.txt": "clean" },
    head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": PUB_NEW, "test/refuse.test.mjs": REFUSE_TEST },
  });
  const r = runGate(sc, "run");
  assertRed(r, "TEST-CHANGED");
  assert.equal(r.verdict.reasons.find((x) => x.code === "TEST-CHANGED").phase, "earlier");
});

// ---------------------------------------------------------------------------
// The second review: shapes that still gave a false green.
// ---------------------------------------------------------------------------

test("second review 1: a template interpolation with a brace in a string and a nested template exposes no export", async () => {
  const { exportsOf } = await gateModule();
  // a closing brace inside a string of the interpolation does not end it
  assert.deepEqual([...exportsOf('const decoy = `${\n  "}" + `\nexport function ghost() {}\n`\n}`;\nexport function ready() { return true; }\n')], ["ready"]);
  // a regular expression and a comment inside an interpolation are read as code there
  assert.deepEqual([...exportsOf("const a = `${ /`/.test(x) ? \"{\" : '}' /* } ` */ }\nexport function ghost() {}\n`;\nexport const real = 1;\n")], ["real"]);
  // nested templates with interpolations of their own
  assert.deepEqual([...exportsOf("const a = `x ${ `y ${ { z: 1 }.z } ` } w\nexport function ghost() {}\n`;\nexport const real = 1;\n")], ["real"]);
});

// A table of existing tests: each row is one test of the file.
const ROWS_TEST = (rows, extra = "") =>
  `${TEST_HEAD}import { publish } from "../src/publish.mjs";\n\nconst rows = [\n${rows.map((x) => `  ${JSON.stringify(x)},\n`).join("")}];\n${extra}for (const [name, ok] of rows) {\n  test(name, () => {\n    assert.match(publish(() => ({ ok })), /^published/);\n  });\n}\n`;

test("second review 2: an edit that removes the test the fix breaks is not collateral: RED, also beside a proven file", async (t) => {
  const sc = scenario(t, {
    base: { ...PUB_BASE, "test/publish.test.mjs": ROWS_TEST([["with a good compile", true], ["with a failed compile", false]]) },
    head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": ROWS_TEST([["with a good compile", true]]), "test/refuse.test.mjs": REFUSE_TEST },
  });
  const r = runGate(sc, "run");
  assertRed(r, "NOT-RED-BEFORE");
  assert.match(r.verdict.reasons.find((x) => x.code === "NOT-RED-BEFORE").detail, /the edit removes 1 test\(s\) of the file's earlier version: with a failed compile/);
});

test("second review 3: a pin beside added lines that drop an existing test is RED", async (t) => {
  const two = [["with a good compile", true], ["with another good compile", true]];
  const sc = scenario(t, {
    base: { ...PUB_BASE, "test/publish.test.mjs": ROWS_TEST(two) },
    head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": `${ROWS_TEST(two, "rows.pop();\n")}\n// red-first-pin: a good compile still publishes\n${PIN_TEST}`, "test/refuse.test.mjs": REFUSE_TEST },
  });
  const r = runGate(sc, "run");
  assertRed(r, "NOT-RED-BEFORE");
  assert.match(r.verdict.reasons.find((x) => x.code === "NOT-RED-BEFORE").detail, /the edit removes 1 test\(s\) of the file's earlier version: with another good compile/);
});

test("second review 4: an import that names its extension is that file, never a folder's index or another script of its stem", async () => {
  const { addedByFix } = await gateModule();
  const map = new Map([["src/pkg/index.mjs", new Set(["ghost"])]]);
  const ctx = { source: 'import * as api from "../src/pkg.mjs";\n', exportsByFile: () => map, addedFix: new Set(["src/pkg/index.mjs"]), roots: ["/t"], runnerDir: "" };
  assert.equal(addedByFix("TypeError: api.ghost is not a function", "test/a.test.mjs", ctx), null);
  assert.equal(addedByFix("Error: Cannot find module '/t/src/pkg.mjs' imported from /t/test/a.test.mjs", "test/a.test.mjs", ctx), null);
  // without the extension the folder's index is the module
  const bare = { ...ctx, source: 'import * as api from "../src/pkg";\n' };
  assert.equal(addedByFix("TypeError: api.ghost is not a function", "test/a.test.mjs", bare), "the export ghost");
  // a named extension stands only for its TypeScript source (x.mjs -> x.mts), not for x.js
  const stem = { ...ctx, source: 'import { s } from "../src/sum.mjs";\n', addedFix: new Set(["src/sum.js"]) };
  assert.equal(addedByFix("Error: Cannot find module '/t/src/sum.mjs' imported from /t/test/a.test.mjs", "test/a.test.mjs", stem), null);
  assert.equal(addedByFix("Error: Cannot find module '/t/src/sum.mjs' imported from /t/test/a.test.mjs", "test/a.test.mjs", { ...stem, addedFix: new Set(["src/sum.mts"]) }), "the module src/sum.mts");
});

test("second review 5: an earlier version that rewrites its own test file during its run is RED (TEST-CHANGED in the earlier run)", async (t) => {
  const writesSelf = PUB_OLD.replace("import { publish }", 'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL(import.meta.url), "// rewritten\\n");\nimport { publish }');
  const sc = scenario(t, {
    base: { ...PUB_BASE, "test/publish.test.mjs": writesSelf },
    head: { "src/publish.mjs": PUB_FIX, "test/publish.test.mjs": PUB_NEW, "test/refuse.test.mjs": REFUSE_TEST },
  });
  const r = runGate(sc, "run");
  assertRed(r, "TEST-CHANGED");
  const changed = r.verdict.reasons.find((x) => x.code === "TEST-CHANGED");
  assert.equal(changed.phase, "earlier");
  assert.equal(changed.file, "test/publish.test.mjs");
});

// ---------------------------------------------------------------------------
// The fold reading: a slash the scanner cannot read for sure gives no exports.
// ---------------------------------------------------------------------------

// A fix-side module whose template holds the text of an export, and a new test
// that calls that name only before the fix: a TypeError that must never count
// as what the fix adds.
const DECOY_BASE = "const decoy = `\nexport function ghost() {}\n`;\nexport function ready() { return false; }\n";
const DECOY_TEST = `${TEST_HEAD}import * as api from "../src/m.mjs";\n\ntest("ready before the call", () => {\n  if (!api.ready()) api.ghost();\n  assert.ok(true);\n});\n`;
function decoyScenario(t, headModule) {
  return scenario(t, { base: { "package.json": '{ "type": "module" }\n', "src/m.mjs": DECOY_BASE }, head: { "src/m.mjs": headModule, "test/m.test.mjs": DECOY_TEST } });
}

test("fold 1: a division after an object literal in an interpolation is not read as a regular expression that exposes an export (RED, not ADDED-BY-FIX)", async (t) => {
  const head = 'const decoy = `${ {} / {a: 1 / 2}.a + "`" }\nexport function ghost() {}\n`;\nexport function ready() { return true; }\n';
  const r = runGate(decoyScenario(t, head), "run");
  assertRed(r, "WRONG-REASON");
  assert.deepEqual(r.verdict.notes, []);
});

test("fold 2: a regular expression after `)` in an interpolation, read as a division, exposes no export (RED, not ADDED-BY-FIX)", async (t) => {
  const head = 'const a = false;\nconst b = "";\nconst decoy = `${ (() => { if (a) /}x/.test(b); })() + "`" }\nexport function ghost() {}\n`;\nexport function ready() { return true; }\n';
  const r = runGate(decoyScenario(t, head), "run");
  assertRed(r, "WRONG-REASON");
  assert.deepEqual(r.verdict.notes, []);
});

test("fold 3: a regular expression after `)` at the top level is read as one; a plain division as a division", async () => {
  const { exportsOf } = await gateModule();
  // a regular expression after `)` at the top level, read as a division, would open a template
  assert.deepEqual([...exportsOf('const a = false;\nif (a) /`/.test("");\nconst t = `\nexport function ghost() {}\n`;\nexport function ready() { return true; }\n')], ["ready"]);
  // a division after `)` or `]` with no other slash on its line is no regular expression: read as before
  assert.deepEqual([...exportsOf("const half = (a + b) / 2;\nconst q = xs[0] / 3;\nexport const real = half / q;\n")], ["real"]);
});

// ---------------------------------------------------------------------------
// The fold2 reading: every slash the scanner reads, at every start position.
// ---------------------------------------------------------------------------

test("fold2 1: a division after a postfix ++ is not read as a regular expression that exposes an export (RED, not ADDED-BY-FIX)", async (t) => {
  const head = "let n = 0;\nconst decoy = n++ / `x/\nexport function ghost() {}\n`;\nexport function ready() { return true; }\n";
  const r = runGate(decoyScenario(t, head), "run");
  assertRed(r, "WRONG-REASON");
  assert.deepEqual(r.verdict.notes, []);
});

// Each source below exports exactly `ready` when JavaScript reads it; the text
// `export function ghost` sits in a template. For every start position of a
// slash (each punctuator, ++ and --, names, keywords and names that look like
// keywords, a line start after a line break, at the top level and inside an
// interpolation), the reader must read exactly { ready } or say it is unsure,
// so that it never reports a fresh `ghost` at the head and never hides
// `ready` at the merge base.
const SLASH_DIVISIONS = [
  "n++", "n--", "x", "x.y", "of", "yield", "await", "let", "async", "get", "_$", "1", "1.5", "0x1f", "\"s\"", "'s'", "`t`", "(a)",
  "a[0]", "({})", "[]", "x\n", "n++\n", "(a)\n", "this", "null", "true", "x.return", "x.of", "x.in", "x.typeof", "x!", "f<T>",
  "x !", "a > b", "x. return", "this.#return", "\u00e9in", "x\u00e9in", "x ! ", "x. default", "o.debugger", "x .in",
];
const SLASH_REGEX_STARTS = [
  "", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "~", "^", "*", "%", "<", ">", "+", "-", "==", "===", "!=", "<=", ">=",
  "=>", "&&", "||", "??", "**", "<<", ">>", ">>>", "+=", "-=", "*=", "/=", "a ?", "a ? b :", "return", "typeof", "instanceof", "in",
  "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "of", "let", "}", ")", "]", "if (a)", "while (a)", "{}",
  "x\n", ";\n", "/a/", "a /", "default", "export default", "debugger\n", "break\n", "continue\n", "++", "--", "let v = ++",
  "x. return", "this.#return", "\u00e9in", "x !", "<p>", "=> ", "!", "a = !", "return !",
];
function decoySources() {
  const out = [];
  const ghost = "\nexport function ghost() {}\n";
  const tail = "export function ready() { return true; }\n";
  for (const d of SLASH_DIVISIONS) {
    // a division by a template that holds the decoy
    out.push(`let n = 0, x = 1, a = [1];\nconst decoy = ${d} / \`x/${ghost}\`;\n${tail}`);
    out.push(`const decoy = \`\${ ${d} / \`x/${ghost}\` }\`;\n${tail}`);
    out.push(`const decoy = ${d} / 2 / \`x/${ghost}\`;\n${tail}`);
    // a division and a comment that holds a backtick, then the decoy in a template
    out.push(`const q = ${d} / 2 // note \` /\nconst t = \`${ghost}\`;\n${tail}`);
    out.push(`const q = ${d} / 2 /* note \` */;\nconst t = \`${ghost}\`;\n${tail}`);
  }
  for (const r of SLASH_REGEX_STARTS) {
    // a regular expression (or what may be one) whose text holds a backtick, a quote or a brace, then a template that holds the decoy
    for (const re of ["/`/", "/'/", '/"/', "/[`]/", "/\\`/", "/}/", "/{/", "/x+/"]) {
      out.push(`const r = ${r} ${re}.source;\nconst t = \`${ghost}\`;\n${tail}`);
      out.push(`const decoy = \`\${ ${r} ${re}.source }${ghost}\`;\n${tail}`);
    }
  }
  return out;
}

test("fold2 2: for every start position of a slash, the reader reads exactly the real exports or is unsure (a generated set)", async () => {
  const { exportsOf, readExports } = await gateModule();
  const sources = decoySources();
  assert.ok(sources.length > 900, `only ${sources.length} sources`);
  const misread = [];
  let unsure = 0;
  for (const src of sources) {
    const read = readExports(src);
    if (read.unsure) {
      unsure += 1;
      assert.deepEqual([...exportsOf(src)], [], "an unsure reading gives no exports");
    } else if ([...read.names].join(",") !== "ready") misread.push(`${JSON.stringify(src.slice(0, 70))} -> ${[...read.names].join(",")}`);
  }
  assert.deepEqual(misread, []);
  // the set is not vacuous: many sources are valid and read, the invalid ones (an unclosed `(` and the like) are unsure
  assert.ok(unsure > 100 && sources.length - unsure > 400, `${unsure} of ${sources.length} unsure`);
});

test("fold2 3: plain code keeps its exports: divisions, regular expressions without quotes or braces, ++ and keywords", async () => {
  const { exportsOf } = await gateModule();
  for (const src of [
    "const half = (a + b) / 2;\nconst q = xs[0] / 3;\nn++;\nconst r = n++ / 2;\nexport const real = half / q;\n",
    "const ok = /^[a-z]+$/i.test(name);\nfunction f(x) { return /\\d+/.exec(x); }\nexport const real = ok && f;\n",
    "const parts = path.split(/[\\\\/]/);\nconst t = `a ${parts.length} b`;\nexport function real() { return t; }\n",
  ]) {
    assert.deepEqual([...exportsOf(src)], [src.match(/export (?:const|function) (\w+)/)[1]], src);
  }
});

// ---------------------------------------------------------------------------
// The fold3 reading: every reviewer input of the slash class, plus JSX and a
// hashbang line, by name; each must read its real exports or be unsure.
// ---------------------------------------------------------------------------

const READER_INPUTS = [
  // pre-2 finding 1, the fold reading (A, B), the fold2 reading, the fold3 reading (1, 2, 3, out of scope)
  ['const decoy = `${\n  "}" + `\nexport function ghost() {}\n`\n}`;\nexport function ready() { return true; }\n', ["ready"]],
  ['const decoy = `${ {} / {a: 1 / 2}.a + "`" }\nexport function ghost() {}\n`;\nexport function ready() { return true; }\n', ["ready"]],
  ['const a = false;\nconst b = "";\nconst decoy = `${ (() => { if (a) /}x/.test(b); })() + "`" }\nexport function ghost() {}\n`;\nexport function ready() { return true; }\n', ["ready"]],
  ['const a = false;\nif (a) /`/.test("");\nconst t = `\nexport function ghost() {}\n`;\nexport function ready() { return true; }\n', ["ready"]],
  ["let n = 0;\nconst decoy = n++ / `x/\nexport function ghost() {}\n`;\nexport function ready() { return true; }\n", ["ready"]],
  ["let of = 1; const decoy = of / `x/\nexport function ghost() {}\n`;\nexport function ready() { return true; }\n", ["ready"]],
  ["export default /`/;\nconst t = `\nexport function ghost() {}\n`;\n// `\n", []],
  ["function f() { debugger\n/`/.test(x); }\nconst t = `\nexport function ghost() {}\n`;\n// `\n", []],
  ["for (;;) { break\n/`/.test(x); }\nconst t = `\nexport function ghost() {}\n`;\n// `\n", []],
  ["for (;;) { continue\n/`/.test(x); }\nconst t = `\nexport function ghost() {}\n`;\n// `\n", []],
  ["let v = ++ /`/.lastIndex;\nconst t = `\nexport function ghost() {}\n`;\n// `\n", []],
  ["const x = { return: 4 }, a = [1];\nconst q = x. return / a[/*] / 1;\nexport function ghost() {}\n*/ 0]; /y/;\n", []],
  ["class C { #return = 4; m(a) { return this.#return / a[/*] / 1;\nexport function ghost() {}\n*/ 0]; } }\n", []],
  ["const \u00e9in = 4, a = [1];\nconst q = \u00e9in / a[/*] / 1;\nexport function ghost() {}\n*/ 0];\n", []],
  ["const q = x ! / a[/*] / 1;\nexport function ghost() {}\n*/ 0];\n", []],
  ["const a = <p>`</p>;\nconst t = `\nexport function ghost() {}\n`;\nconst b = <p>`</p><i></i>;\n", []],
  ["#!/usr/bin/env -S node --title=`\nconst t = `\nexport function ghost() {}\n`;\n// `\n", []],
  // a hashbang line before plain code keeps the exports
  ["#!/usr/bin/env node\nexport const real = 1;\n", ["real"]],
  // the fold4 reading: an escaped name that ends like a keyword, TypeScript's `!` after a comment, a regular
  // expression or `1.`, and a JSX closing tag with a space
  ["const \\u{61}in = 4, a = 1;\nconst q = \\u{61}in / a + /x'/ + ' + `';\nconst t = `\nexport function ghost() {}\n`;\n// `\n", []],
  ["const \\u{61}in = 4, a = 1;\nconst q = \\u{61}in / a + /x'/ + ' + `';\nexport function real() {}\n// `\n", ["real"]],
  ["const \\u{61}return = 4, a = 1;\nconst q = \\u{61}return / a + /x'/ + ' + `';\nconst t = `\nexport function ghost() {}\n`;\n// `\n", []],
  ["const a = 1, x = 2;\nconst q = x /**/! / a + /x'/ + ' + `';\nconst t = `\nexport function ghost() {}\n`;\n// `\n", [], "m.ts"],
  ["const a = 1;\nconst q = /re/! / a + /x'/ + ' + `';\nconst t = `\nexport function ghost() {}\n`;\n// `\n", [], "m.ts"],
  ["const a = 1;\nconst q = 1.! / a + /x'/ + ' + `';\nconst t = `\nexport function ghost() {}\n`;\n// `\n", [], "m.ts"],
  ["const a = <p>x`</ p>;\nconst t = `\nexport function ghost() {}\n`;\nconst b = <p>x`</ p>;\n", [], "m.tsx"],
  ["const a = <p>x`</ p>;\nconst t = `\nexport function ghost() {}\n`;\nconst b = <p>x`</ p>;\n", [], "m.jsx"],
  ["const \\u{61}in = 4, a = [1];\nconst q = \\u{61}in / a[/*] / 1;\nexport function ghost() {}\n*/ 0];\n", []],
  ["const \\u{61}in = 4;\nexport const real = \\u{61}in / 2 / 1;\n", ["real"]],
  ["const x = 4, a = [1];\nconst q = x /* c */ ! / a[/*] / 1;\nexport function ghost() {}\n*/ 0];\n", [], "m.ts"],
  ["const a = [1];\nconst q = /x/ ! / a[/*] / 1;\nexport function ghost() {}\n*/ 0];\n", [], "m.ts"],
  ["const a = [1];\nconst q = 1. ! / a[/*] / 1;\nexport function ghost() {}\n*/ 0];\n", [], "m.ts"],
  ["const a = <p>`</ p>;\nconst t = `\nexport function ghost() {}\n`;\nconst b = <p>`</ p><i></i>;\n", [], "m.jsx"],
  ["const a = <p>`</ p>;\nconst t = `\nexport function ghost() {}\n`;\nconst b = <p>`</ p><i></i>;\n", []],
  // the same JSX text as valid JSX (one root per expression)
  ["const a = <p>`</ p>;\nconst t = `\nexport function ghost() {}\n`;\nconst b = <p>`</ p>;\nexport const real = 1;\n", ["real"], "m.jsx"],
  ["const a = <p>`</p>;\nconst t = `\nexport function ghost() {}\n`;\nconst b = <p>`</p>;\nexport const real = 1;\n", ["real"]],
];

test("fold3 1: every reviewer input of the slash class, JSX text and a hashbang line: the real exports or unsure, never ghost", async () => {
  const { readExports, exportsOf } = await gateModule();
  const wrong = [];
  for (const [src, real, path] of READER_INPUTS) {
    const read = readExports(src, path);
    const names = [...read.names].sort();
    if (exportsOf(src, path).has("ghost") || (!read.unsure && names.join(",") !== [...real].sort().join(","))) wrong.push(`${JSON.stringify(src.slice(0, 60))} -> ${names.join(",")} unsure=${read.unsure}`);
  }
  assert.deepEqual(wrong, []);
  // the plain hashbang file is read, not unsure
  assert.equal(readExports("#!/usr/bin/env node\nexport const real = 1;\n").unsure, false);
});

test("fold3 2: the fold3 reviewer's default input ends RED, not ADDED-BY-FIX", async (t) => {
  const head = "export default /`/;\nconst t = `\nexport function ghost() {}\n`;\n// `\nexport function ready() { return true; }\n";
  const r = runGate(decoyScenario(t, head), "run");
  assertRed(r, "WRONG-REASON");
  assert.deepEqual(r.verdict.notes, []);
});

// ---------------------------------------------------------------------------
// The fold4 reading: the exports and imports are read by the TypeScript
// parser; a file it does not read cleanly is unsure.
// ---------------------------------------------------------------------------

test("fold4 1: the parser reads every valid reviewer input as JavaScript does (the real exports, never unsure); the invalid JSX ones are unsure", async () => {
  const { readExports } = await gateModule();
  // two JSX elements side by side without a parent (`<p>...</p><i></i>`) are a syntax error
  const invalid = ([src]) => /<\/ ?p><i><\/i>/.test(src);
  assert.deepEqual(READER_INPUTS.filter((x) => !invalid(x) && readExports(x[0], x[2]).unsure).map(([src]) => JSON.stringify(src.slice(0, 40))), []);
  assert.deepEqual(READER_INPUTS.filter((x) => invalid(x) && !readExports(x[0], x[2]).unsure).map(([src]) => JSON.stringify(src.slice(0, 40))), []);
  assert.equal(READER_INPUTS.filter(invalid).length, 3);
});

test("fold4 2: TypeScript and JSX shapes: value exports only, type and declare and default exports apart; a syntax error is unsure", async () => {
  const { readExports, exportsOf, importsOf } = await gateModule();
  const ts = "export interface I { a: number }\nexport type T = 1;\nexport declare const d: number;\nexport const real: number = 1;\nexport enum E { A }\nexport default function main() {}\nexport { real as alias, type I as J };\nexport const { x, y: [z] } = { x: 1, y: [2] };\nnamespace N { export const inner = 1; }\nexports.cjs = 1;\n";
  assert.deepEqual([...exportsOf(ts, "src/m.ts")].sort(), ["E", "alias", "cjs", "real", "x", "z"]);
  assert.deepEqual([...exportsOf("export const C = () => <div>{`x`}</div>;\n", "src/c.tsx")], ["C"]);
  // a syntax error: unsure, no exports at the head
  assert.equal(readExports("export const real = (;\n", "src/m.ts").unsure, true);
  assert.deepEqual([...exportsOf("export const real = (;\n", "src/m.ts")], []);
  // imports by the parser: TypeScript's import-equals and a type-only element; a file that does not parse imports nothing
  assert.deepEqual(
    importsOf('import x = require("./y");\nimport { type A, b } from "./m";\nconst t: string = `${1}`;\n', "test/a.test.ts").map((i) => `${i.spec}:${[...i.names].join(",")}:${i.whole}`),
    ["./m:b:false", "./y::true"],
  );
  assert.deepEqual(importsOf('import { a } from "./m";\nconst x = (;\n', "test/a.test.ts"), []);
});

test("fold4 3: the fold4 reviewer's escaped-name input ends RED, not ADDED-BY-FIX", async (t) => {
  const head = "const \\u{61}in = 4, a = 1;\nconst q = \\u{61}in / a + /x'/ + ' + `';\nconst t = `\nexport function ghost() {}\n`;\nexport function ready() { return true; }\n// `\n";
  const r = runGate(decoyScenario(t, head), "run");
  assertRed(r, "WRONG-REASON");
  assert.deepEqual(r.verdict.notes, []);
});

// ---------------------------------------------------------------------------
// The fold5 reading: HTML-like comments, the merge base the parser does not
// read cleanly, namespaces and `export import`, a function without a body.
// ---------------------------------------------------------------------------

test("fold5 1: an HTML-like comment outside a literal makes the file unsure; inside a string it does not", async () => {
  const { readExports, exportsOf, importsOf } = await gateModule();
  for (const [src, path] of [
    ["var a = 1, b = 2;\nvar t = a <!-- b; exports.ghost = function () {};\n", "src/m.cjs"],
    ["var a = 1;\n  --> exports.ghost = function () {};\n", "src/m.cjs"],
    ["var a = 1, b = 2;\nvar t = a <!-- b; exports.ghost = function () {};\n", ""],
  ]) {
    assert.equal(readExports(src, path).unsure, true, src);
    assert.deepEqual([...exportsOf(src, path)], [], src);
  }
  assert.deepEqual(importsOf('var a = 1, b = 2;\nvar t = a <!-- b; const { ghost } = require("./m");\n', "test/a.test.cjs"), []);
  // in a string, a template, a regular expression or JSX text it is text
  const plain = 'const html = "<!-- x -->";\nconst t = `\n--> y`;\nconst r = /<!--/;\nexport const real = 1;\n';
  assert.equal(readExports(plain, "src/m.mjs").unsure, false);
  assert.deepEqual([...exportsOf(plain, "src/m.mjs")], ["real"]);
});

test("fold5 2: a merge base the parser does not read cleanly hides no export the head reads (nothing is fresh then)", async () => {
  const { freshExports } = await gateModule();
  const run = (base, head, path = "src/m.cjs") => [...(freshExports([path], () => base, () => head).get(path) ?? [])].sort();
  // the fold5 reviewer's input: an HTML-like comment line at the merge base, dropped at the head
  assert.deepEqual(run("<!-- kept\nvar a = 1; exports.real = function () { return a; };\n", "var a = 1; exports.real = function () { return a; };\n"), []);
  // a legacy octal at the merge base (a syntax error to the parser), an export not at a line start
  assert.deepEqual(run("var mode = 0755; exports.real = 1;\n", "var mode = 493; exports.real = 1;\n"), []);
  // a destructured export and a list over several lines behind a syntax error; an escaped name
  assert.deepEqual(run("export const { real } = { real: 1 }; const x = (;\n", "export const { real } = { real: 1 };\n", "src/m.mjs"), []);
  assert.deepEqual(run("export {\n  real,\n};\nconst real = 1; const x = (;\n", "export {\n  real,\n};\nconst real = 1;\n", "src/m.mjs"), []);
  assert.deepEqual(run("export const \\u0072eal = 1; const x = (;\n", "export const real = 1;\n", "src/m.mjs"), []);
  // a clean merge base keeps the exact reading: a new name is fresh
  assert.deepEqual(run("export const old = 1;\n", "export const old = 1;\nexport function added() {}\n", "src/m.mjs"), ["added"]);
  // a merge base with a syntax error: no name is fresh, also one its text never spells
  assert.deepEqual(run("export const old = (;\n", "export const old = 1;\nexport function added() {}\n", "src/m.mjs"), []);
});

test("fold5 3/4: a namespace, a module and `export import` are value exports; a function without a body is not", async () => {
  const { exportsOf, freshExports } = await gateModule();
  const ts = "export namespace parse { export const v = 1; }\nexport module M { export const w = 1; }\nnamespace N { export const y = 1; }\nexport import alias = N.y;\nexport declare namespace D { const z: number; }\ndeclare module \"x\" {}\nexport function ghost(): void;\nexport function over(a: string): void;\nexport function over(a: unknown) {}\nexport const real = 1;\n";
  assert.deepEqual([...exportsOf(ts, "src/p.ts")].sort(), ["M", "alias", "over", "parse", "real"]);
  // the fold5 reviewer's input: a namespace at the merge base, a function at the head: not fresh
  assert.deepEqual([...(freshExports(["src/p.ts"], () => "export namespace parse { export const v = 1; }\n", () => "export function parse() { return 1; }\n").get("src/p.ts") ?? [])], []);
});

// ---------------------------------------------------------------------------
// The fold6 reading: an unsure merge base yields no fresh export at all; the
// CommonJS export forms are read (or make the file unsure).
// ---------------------------------------------------------------------------

test("fold6 1: an unsure merge base with an escaped string export name: nothing is fresh", async () => {
  const { freshExports } = await gateModule();
  for (const base of ['// <!--\nconst x = 1;\nexport { x as "re\\x61l" };\n', '// <!--\nconst x = 1;\nexport { x as "re\\al" };\n']) {
    assert.deepEqual([...(freshExports(["src/m.mjs"], () => base, () => "export function real() { return 1; }\n").get("src/m.mjs") ?? [])], [], base);
  }
});

test("fold6 2: CommonJS exports: module.exports object keys, element access, defineProperty; other forms are unsure", async () => {
  const { readExports, freshExports } = await gateModule();
  const read = (src) => {
    const r = readExports(src, "src/m.cjs");
    return `${[...r.names].sort().join(",")}${r.unsure ? " unsure" : ""}`;
  };
  assert.equal(read('const a = 1;\nmodule.exports = { a, b: 1, "c": 2, 3: 4, d() {}, get e() { return 1; } };\n'), "3,a,b,c,d,e");
  assert.equal(read('exports["x"] = 1;\nmodule.exports["y"] = 2;\nmodule.exports.z = 3;\nexports.w = 4;\n'), "w,x,y,z");
  assert.equal(read('Object.defineProperty(exports, "p", { value: 1 });\nObject.defineProperty(module.exports, "q", { get() { return 1; } });\n'), "p,q");
  assert.equal(read("module.exports = ({ a: 1 });\n"), "a");
  // forms whose names the parser cannot read: unsure
  for (const src of ["const f = () => 1;\nmodule.exports = f;\n", "const o = {};\nmodule.exports = { ...o, a: 1 };\n", "const k = 'a';\nmodule.exports = { [k]: 1 };\n", "const k = 'a';\nexports[k] = 1;\n", "const k = 'a';\nObject.defineProperty(exports, k, { value: 1 });\n"]) {
    assert.match(read(src), / unsure$/, src);
  }
  // the fold6 reviewer's out-of-scope inputs: a clean merge base that exports `real` by such a form; the head moves it
  const head = "exports.real = function () { return 1; };\n";
  for (const base of ["module.exports = { real: 1 };\n", 'exports["real"] = 1;\n', 'Object.defineProperty(exports, "real", { value: 1 });\n']) {
    assert.deepEqual([...(freshExports(["src/m.cjs"], () => base, () => head).get("src/m.cjs") ?? [])], [], base);
  }
});

// ---------------------------------------------------------------------------
// The fold7 reading: the CommonJS reading is deny-by-default. Every use of
// `exports`, `module`, an export helper, a top-level `this` or `export =`
// that is not a recognised top-level statement makes the script unsure.
// ---------------------------------------------------------------------------

const FOLD7_BASES = [
  ["Object.assign(module.exports, { real: 1 });\n", "src/m.cjs"],
  ["const e = module.exports;\ne.real = 1;\n", "src/m.cjs"],
  ["const e = exports;\ne.real = 1;\n", "src/m.cjs"],
  ["exports.real ||= 1;\n", "src/m.cjs"],
  ["exports.real ??= 1;\n", "src/m.cjs"],
  ["exports.real &&= 1;\n", "src/m.cjs"],
  ['module["exports"].real = 1;\n', "src/m.cjs"],
  ['module["exports"] = { real: 1 };\n', "src/m.cjs"],
  ["Object.defineProperties(exports, { real: { value: 1 } });\n", "src/m.cjs"],
  ['Reflect.defineProperty(exports, "real", { value: 1 });\n', "src/m.cjs"],
  ["({ real: exports.real } = { real: 1 });\n", "src/m.cjs"],
  ["this.real = 1;\n", "src/m.cjs"],
  ['Object.assign(exports, require("./x"));\n', "src/m.cjs"],
  ['__exportStar(require("./x"), exports);\n', "src/m.cjs"],
  ["export = { real: 1 };\n", "src/m.cts"],
];

test("fold7 1: every fold7 merge-base form is unsure or read, so a moved export is never fresh", async () => {
  const { readExports, freshExports } = await gateModule();
  const head = "exports.real = function () { return 1; };\n";
  const wrong = [];
  for (const [base, path] of FOLD7_BASES) {
    const read = readExports(base, path);
    if (!read.unsure && !read.names.has("real")) wrong.push(`${JSON.stringify(base)} read clean without real`);
    const fresh = [...(freshExports([path], () => base, () => head).get(path) ?? [])];
    if (fresh.includes("real")) wrong.push(`${JSON.stringify(base)} -> real fresh`);
  }
  assert.deepEqual(wrong, []);
});

// Every node kind the reading denies, in every place: a target (`exports`, `module.exports`, `module["exports"]`, an alias,
// a top-level `this`, a helper) under every assignment operator and helper call, at the top level, in a block, in a
// function, in an arrow function and in a class; each must leave the script unsure (or read `real`).
function fold7Sources() {
  const targets = ["exports", "module.exports", 'module["exports"]', "e", "this"];
  const writes = (t) => [
    `${t}.real = 1;`, `${t}["real"] = 1;`, `${t}.real ||= 1;`, `${t}.real ??= 1;`, `${t}.real &&= 1;`, `${t}.real += 1;`,
    `Object.assign(${t}, { real: 1 });`, `Object.defineProperties(${t}, { real: { value: 1 } });`, `Reflect.defineProperty(${t}, "real", { value: 1 });`,
    `({ real: ${t}.real } = { real: 1 });`, `[${t}.real] = [1];`, `__exportStar({ real: 1 }, ${t});`, `__export({ real: 1 }, ${t});`,
  ];
  const places = [(x) => x, (x) => `if (true) { ${x} }`, (x) => `(function () { ${x} })();`, (x) => `(() => { ${x} })();`, (x) => `class K { static { ${x} } }`];
  const out = [];
  for (const t of targets) {
    const alias = t === "e" ? "const e = module.exports;\n" : "";
    // inside a function or a class, `this` is not the module's (no export there): only the places that keep it
    const at = t === "this" ? [places[0], places[1], places[3]] : places;
    for (const w of writes(t)) for (const place of at) out.push(`${alias}${place(w)}\n`);
  }
  return out;
}

test("fold7 2: a generated set over the denied node kinds: never a clean reading without the export", async () => {
  const { readExports } = await gateModule();
  const sources = fold7Sources();
  assert.ok(sources.length > 290, `only ${sources.length} sources`);
  const wrong = sources.filter((src) => {
    const read = readExports(src, "src/m.cjs");
    return !read.unsure && !read.names.has("real");
  });
  assert.deepEqual(wrong, []);
});

test("fold7 3: the recognised statements still read clean; names that only look alike are no references", async () => {
  const { readExports } = await gateModule();
  const read = (src, path = "src/m.cjs") => {
    const r = readExports(src, path);
    return `${[...r.names].sort().join(",")}${r.unsure ? " unsure" : ""}`;
  };
  // a typical compiled CommonJS file
  assert.equal(read('"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.b = exports.a = void 0;\nconst a = 1;\nexports.a = a;\nfunction b() { return this; }\nexports.b = b;\n'), "__esModule,a,b");
  assert.equal(read('module.exports.x = 1;\nmodule.exports["y"] = 2;\nmodule.exports = ({ z: 3 });\n'), "x,y,z");
  // a property or a key named like them is no reference
  assert.equal(read("const o = { exports: 1, module: 2 };\nconst p = o.exports + o.module;\nexport const real = p;\n", "src/m.mjs"), "real");
  // a shadowing parameter or an assignment inside a function: unsure
  assert.equal(read("function f(exports) { exports.x = 1; }\nexports.real = 1;\n"), "real unsure");
  assert.equal(read("function f() { exports.x = 1; }\nf();\n"), " unsure");
  // a class's computed member names and heritage are evaluated outside its body: a `this` there is the module's
  for (const src of ["class A { [this.k] = 1; }\n", "class A extends (this.B) {}\n", "class A { [this.k]() {} }\n", "const g = () => this;\n"]) assert.equal(read(src), " unsure", src);
  for (const src of ["class A { x = this; }\n", "function f() { return this; }\n", "class A { m() { class B { [this.k] = 1; } } }\n"]) assert.equal(read(src), "", src);
});

// ---------------------------------------------------------------------------
// The fold8 reading: CommonJS exports are built at run time, so at the merge
// base only an ES module is read; a CommonJS script there yields no fresh
// export at all. The head keeps the recognised-statement reading.
// ---------------------------------------------------------------------------

const FOLD8_BASES = [
  'const o = { get [(this.real = function () { return 1; }, "k")]() { return 0; } };\n',
  'class A { static get [(this.real = 1, "k")]() {} }\n',
  'const o = { set [(this.real = 1, "k")](v) {} };\n',
  "require.cache[__filename].exports.real = function () { return 1; };\n",
  "arguments[0].real = function () { return 1; };\n",
  "arguments[2].exports = { real() {} };\n",
  'eval("exports").real = function () { return 1; };\n',
  "exports.__proto__ = { real: function () { return 1; } };\n",
  "module.exports = { __proto__: { real() { return 1; } } };\n",
];

// The fresh names of one fix-side script; package: the root package.json's text (none when undefined).
async function freshOf(path, base, head, pkg) {
  const { freshExports } = await gateModule();
  const read = (p) => (p === path ? base : p === "package.json" && pkg !== undefined ? pkg : null);
  return [...(freshExports([path], read, () => head).get(path) ?? [])].sort();
}
const typed = (type) => JSON.stringify({ type });

test("fold8 1: every fold8 merge-base input yields no fresh export, as .cjs, .js without a package type, .ts and .mjs", async () => {
  const head = "export function real() { return 1; }\nexports.real = real;\n";
  const wrong = [];
  for (const base of FOLD8_BASES) for (const path of ["src/m.cjs", "src/m.js", "src/m.ts", "src/m.mjs"]) {
    if ((await freshOf(path, base, head)).includes("real")) wrong.push(`${path}: ${JSON.stringify(base)}`);
  }
  assert.deepEqual(wrong, []);
});

test("fold8 2: the head reading: a getter or setter's computed-key `this` and a `__proto__` target or key are unsure", async () => {
  const { readExports } = await gateModule();
  for (const src of [...FOLD8_BASES.slice(0, 3), ...FOLD8_BASES.slice(7), 'exports["__proto__"] = {};\n', 'Object.defineProperty(exports, "__proto__", { value: {} });\n']) {
    assert.equal(readExports(src, "src/m.cjs").unsure, true, src);
  }
  // a computed key inside a method body is the method's `this`, not the module's
  assert.equal(readExports("class A { m() { return { [this.k]: 1 }; } }\nexports.a = 1;\n", "src/m.cjs").unsure, false);
});

test("fold8 3: at the merge base only a pure ES module is read", async () => {
  const head = "export const a = 1;\nexport function real() { return 1; }\n";
  const esm = "export const a = 1;\n";
  // an ES module: its static exports are read exactly, so `real` is new and `a` is not
  assert.deepEqual(await freshOf("src/m.mjs", esm, head), ["real"]);
  assert.deepEqual(await freshOf("src/m.js", esm, head, typed("module")), ["real"]);
  assert.deepEqual(await freshOf("src/m.ts", esm, head), ["real"]);
  assert.deepEqual(await freshOf("src/m.mjs", 'import { b } from "./b.mjs";\nexport { b as c };\nexport const a = 1;\n', head), ["real"]);
  // a moved export stays not new; an absent or empty base script exports nothing
  assert.deepEqual(await freshOf("src/m.mjs", "export function real() { return 0; }\n", head), ["a"]);
  assert.deepEqual(await freshOf("src/m.mjs", null, head), ["a", "real"]);
  assert.deepEqual(await freshOf("src/m.mjs", "// nothing yet\n", head), ["a", "real"]);
  // not read: CommonJS by extension or package type, no static import or export, `export =`, `import x = require`,
  // `export * from`, a reference to exports, module, require, arguments, eval or a module-level `this`, a broken package.json
  for (const [path, base, pkg] of [
    ["src/m.cjs", esm], ["src/m.cts", esm], ["src/m.js", esm, typed("commonjs")], ["src/m.ts", esm, typed("commonjs")],
    ["src/m.mjs", "const a = 1;\n"], ["src/m.js", "exports.a = 1;\n"], ["src/m.cts", "export = { a: 1 };\n"],
    ["src/m.ts", 'import x = require("./x");\nexport const a = 1;\n'], ["src/m.mjs", 'export * from "./x.mjs";\nexport const a = 1;\n'],
    ["src/m.mjs", "export const a = 1;\nexports.b = 1;\n"],
    ["src/m.mjs", 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport const a = 1;\n'],
    ["src/m.mjs", "export const a = 1;\nconst t = this;\n"], ["src/m.mjs", "export const a = arguments;\n"], ["src/m.js", esm, "{"],
  ]) {
    assert.deepEqual(await freshOf(path, base, head, pkg), [], `${path} ${pkg ?? ""}: ${base}`);
  }
});

// Every CommonJS export form the readings met, under every module kind, with and without static ES syntax beside it.
test("fold8 4: a generated set: a CommonJS export at the merge base never makes a name fresh", async () => {
  const forms = [...FOLD7_BASES.map(([b]) => b), ...FOLD8_BASES, "exports.real = 1;\n", "module.exports = { real: 1 };\n", "module.exports.real = 1;\n", 'Object.defineProperty(exports, "real", { value: 1 });\n'];
  const kinds = [["src/m.cjs"], ["src/m.cts"], ["src/m.js", typed("commonjs")], ["src/m.js"], ["src/m.ts"], ["src/m.mjs"], ["src/m.js", typed("module")]];
  const beside = ["", 'import "node:fs";\n', "export const other = 1;\n"];
  const head = "export function real() { return 1; }\n";
  let n = 0;
  const wrong = [];
  for (const form of forms) for (const [path, pkg] of kinds) for (const pre of beside) {
    n += 1;
    if ((await freshOf(path, pre + form, head, pkg)).includes("real")) wrong.push(`${path} ${pkg ?? ""}: ${JSON.stringify(pre + form)}`);
  }
  assert.ok(n > 500, `only ${n}`);
  assert.deepEqual(wrong, []);
});

// ---------------------------------------------------------------------------
// The fold9 reading: under a transpiler or a test runner an ES module can
// write its own export object, so at the merge base an ES module is read only
// without a namespace import, a dynamic import(), an import of node:module or
// module, and any identifier that starts with `__vi`.
// ---------------------------------------------------------------------------

const FOLD9_BASES = [
  'import * as self from "./m";\nObject.assign(self, { real() { return 1; } });\nexport const a = 1;\n',
  "export const a = 1;\n__vite_ssr_exports__.real = function () { return 1; };\n",
  'import { createRequire } from "node:module";\nconst r = createRequire(__filename);\nr.cache[__filename].exports.real = function () { return 1; };\nexport const a = 1;\n',
];

test("fold9 1: the fold9 merge-base inputs yield no fresh export, as .ts, .js, .mjs and .js of type module", async () => {
  const head = "export const a = 1;\nexport function real() { return 1; }\n";
  const wrong = [];
  for (const base of FOLD9_BASES) for (const [path, pkg] of [["src/m.ts"], ["src/m.js"], ["src/m.mjs"], ["src/m.js", typed("module")]]) {
    if ((await freshOf(path, base, head, pkg)).includes("real")) wrong.push(`${path}: ${JSON.stringify(base)}`);
  }
  assert.deepEqual(wrong, []);
});

test("fold9 2: the allow-list: a namespace import, a dynamic import(), node:module or module, a `__vi` name make the base unsure; other imports do not", async () => {
  const head = "export const a = 1;\nexport function real() { return 1; }\n";
  for (const base of [
    'import * as fs from "node:fs";\nexport const a = 1;\n',
    'import d, * as ns from "./x.mjs";\nexport const a = 1;\n',
    'export const a = 1;\nconst m = await import("./m.mjs");\n',
    'import { createRequire as cr } from "module";\nexport const a = 1;\n',
    'import m from "node:module";\nexport const a = 1;\n',
    'export { createRequire } from "node:module";\nexport const a = 1;\n',
    "export const a = 1;\nconst o = { x: __vi_import_0__ };\n",
    "export const a = 1;\nconst o = {};\no.__vite_ssr_import_meta__ = 1;\n",
  ]) {
    assert.deepEqual(await freshOf("src/m.mjs", base, head), [], base);
  }
  for (const base of ['import { readFileSync } from "node:fs";\nimport d from "./d.mjs";\nexport const a = 1;\n', 'export * as ns from "./x.mjs";\nexport const a = 1;\n', "export const a = 1;\nconst vi = 1;\n"]) {
    assert.deepEqual(await freshOf("src/m.mjs", base, head), ["real"], base);
  }
});
