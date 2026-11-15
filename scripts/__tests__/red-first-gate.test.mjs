import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("repeat case (3): a test file that loads only with the fix is RED: a load error before is not a red-first failure", async (t) => {
  const sc = scenario(t, {
    base: BASE,
    head: {
      "src/calc.mjs": CALC_FIX,
      "src/sum.mjs": 'export { add as sum } from "./calc.mjs";\n',
      "test/sum.test.mjs": `${TEST_HEAD}import { sum } from "../src/sum.mjs";\n\ntest("sum adds", () => {\n  assert.equal(sum(1, 2), 3);\n});\n`,
    },
  });
  const r = runGate(sc, "run");
  assertRed(r, "LOAD-ERROR");
  assert.deepEqual(r.verdict.reasons.map((x) => `${x.code}:${x.phase}`), ["LOAD-ERROR:before"]);
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

test("a non-assertion failure without a marker is RED (WRONG-REASON)", async (t) => {
  const sumTest = `${TEST_HEAD}import * as calc from "../src/calc.mjs";\n\ntest("sum adds", () => {\n  assert.equal(calc.sum(1, 2), 3);\n});\n`;
  const sc = scenario(t, {
    base: BASE,
    head: { "src/calc.mjs": `${CALC_BUG}export function sum(a, b) {\n  return a + b;\n}\n`, "test/sum.test.mjs": sumTest },
  });
  const r = runGate(sc, "run");
  assertRed(r, "WRONG-REASON");
  assert.match(r.verdict.reasons.find((x) => x.code === "WRONG-REASON").detail, /TypeError/);
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
  const r = runGate(sc, "run", ["--exclude", "^e2e/", "--summary", summary]);
  assertPass(r);
  assert.deepEqual(r.verdict.files.map((f) => f.file), ["test/calc.test.mjs"]);
  assert.deepEqual(r.verdict.notes.map((n) => `${n.code} ${n.file}`), ["EXCLUDED e2e/flow.spec.mjs"]);
  assert.match(r.stdout, /^NOTE EXCLUDED plan e2e\/flow\.spec\.mjs: /m);
  assert.match(r.stdout, /^RED-FIRST: PASS \(1 new test file\(s\) fail before the fix and pass with it; 1 excluded new test file\(s\) not proven here\)/m);
  assert.match(fs.readFileSync(summary, "utf8"), /note `EXCLUDED` `e2e\/flow\.spec\.mjs`/);
});

test("a unit test beside an excluded test still has to be red first: the excluded file hides nothing", async (t) => {
  const mulTest = `${TEST_HEAD}import { mul } from "../src/calc.mjs";\n\ntest("mul multiplies", () => {\n  assert.equal(mul(2, 3), 6);\n});\n`;
  const sc = scenario(t, {
    base: BASE,
    head: { "src/calc.mjs": CALC_FIX, "test/mul.test.mjs": mulTest, "e2e/flow.spec.mjs": `${TEST_HEAD}test("flow", () => {});\n` },
  });
  assertRed(runGate(sc, "run", ["--exclude", "^e2e/"]), "NOT-RED-BEFORE");
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
  const exclude = ["--exclude", "^tests/e2e/.+\\.spec\\.[cm]?[jt]sx?$|\\.integration\\.test\\.[cm]?[jt]sx?$"];
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
  const plan = runGate(sc, "plan", ["--exclude", "^e2e/"]);
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.equal(plan.verdict.verdict, "skip");
  assert.equal(plan.verdict.reason, "EXCLUDED-ONLY");
  const run = runGate(sc, "run", ["--exclude", "^e2e/"]);
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
  const started = Math.floor(Date.now() / 1000);
  // 2.05 minutes less the 120 s reserve leaves about 3 s of budget.
  const t0 = Date.now();
  const r = runGate(sc, "run", ["--install", "sleep 20", "--job-started", String(started), "--job-minutes", "2.05"]);
  assertRed(r, "TIMEOUT");
  assert.ok(Date.now() - t0 < 15_000, "the install ran past the job's budget");
  assert.match(r.verdict.reasons.find((x) => x.code === "TIMEOUT").detail, /job's time budget/);
});

test("a job budget already spent stops with TIMEOUT before the install runs", async (t) => {
  const sc = scenario(t, { base: BASE, head: { "src/calc.mjs": CALC_FIX, "test/calc.test.mjs": ADD_TEST } });
  const mark = path.join(sc.root, "install-ran");
  const r = runGate(sc, "run", ["--install", `touch '${mark}'`, "--job-started", String(Math.floor(Date.now() / 1000)), "--job-minutes", "1"]);
  assertRed(r, "TIMEOUT");
  assert.match(r.verdict.reasons.find((x) => x.code === "TIMEOUT").detail, /spent before the install/);
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
appendFileSync(process.env.FAKE_VITEST_LOG, JSON.stringify({ phase, cwd, args }) + "\\n");
const step = spec[phase];
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
        ancestorTitles: ["calc"],
        title: x.title,
        fullName: `calc ${x.title}`,
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

function runVitest(t, spec) {
  const sc = scenario(t, { base: V_BASE, head: V_HEAD });
  const fake = path.join(sc.root, "fake-vitest.mjs");
  const specFile = path.join(sc.root, "fake-spec.json");
  const log = path.join(sc.root, "fake-log.jsonl");
  fs.writeFileSync(fake, FAKE_VITEST);
  fs.writeFileSync(specFile, JSON.stringify(spec));
  ENV.FAKE_VITEST_SPEC = specFile;
  ENV.FAKE_VITEST_LOG = log;
  try {
    const r = runGate(sc, "run", ["--vitest", `'${process.execPath}' '${fake}' run`]);
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
  const plan = runGate(sc, "plan", ["--test-support", "^support/"]);
  assert.ok(plan.verdict, `no plan verdict (exit ${plan.code}): ${plan.stderr.slice(0, 400)}`);
  assert.equal(plan.verdict.verdict, "skip");
  assert.equal(plan.verdict.reason, "TESTS-ONLY");
  assert.equal(runGate(sc, "run", ["--test-support", "^support/"]).code, 3);
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
  ], { exclude: "^tests/e2e/" });
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
  ], { setupPaths: ["packages/web/test/setup-dom.ts"], testSupport: "^support/" });
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

test("classify: an exclude pattern that is not a valid regular expression is refused", async () => {
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
