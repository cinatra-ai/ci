#!/usr/bin/env node
// ---------------------------------------------------------------------------
// red-first-gate: the tests a pull request adds or changes must fail on the
// code before the fix, for the right reason, and pass with the fix.
//
// For the pull request range (merge base of base and head .. head) the gate:
//   1. finds the test files the pull request adds or changes (the new tests)
//      and splits every other changed path into the test side (test files,
//      test support folders, the runner's config and setup files, the setup
//      files a vitest config names, and the caller's --test-support pattern)
//      and the fix side;
//   2. builds the tree BEFORE the fix: the merge base with the pull request's
//      test side applied, so that tree and the head differ by exactly the fix
//      side (checked, else TREE-MISMATCH);
//   3. runs the caller's install and the new tests in both trees with the
//      repository's own runner (node:test or vitest), reading machine reports
//      (a node:test reporter, the vitest JSON report), never exit codes alone;
//   4. passes only when every new test file loads, collects tests and fails at
//      least one test for the right reason before the fix (an assertion, or the
//      text of a `red-first-expect:` marker in the file), and with the fix loads,
//      passes, and passes every occurrence of every test that failed before.
// Anything it cannot read or prove ends RED with a named reason. A pull request
// without a new test, with no change besides tests, or whose new tests all
// match --exclude, is a SKIP (exit 3 in `run`), never a pass. New tests that
// match --exclude beside other new tests are listed as notes (not proven here).
// Every child runs in its own process group, which is killed when the child
// exits or times out; the trees and reports are removed at the end of a run.
//
// Usage:
//   red-first-gate.mjs plan --base <sha> --head <sha> [--repo <dir>] [--exclude <re>]
//                           [--test-support <re>] [--verdict <file>]
//                           [--github-output <file>] [--summary <file>]
//   red-first-gate.mjs run  --base <sha> --head <sha> --work <empty dir> [--repo <dir>]
//                           [--install <cmd>] [--vitest <cmd>] [--exclude <re>]
//                           [--test-support <re>] [--timeout-seconds <n>]
//                           [--job-started <epoch s> --job-minutes <n>]
//                           [--verdict <file>] [--summary <file>]
// Exit codes: plan 0 (decided: run or skip); run 0 PASS, 1 RED, 3 SKIP;
// 2 usage or internal error (both modes).
//
// Node built-ins, git and bash; Linux or macOS.
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Test files: JavaScript and TypeScript only (.js .jsx .ts .tsx .mjs .cjs .mts
// .cts), the files node:test and vitest run.
export const TEST_FILE_RE = /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/;
// Test support: helper, fixture, snapshot, mock and stub folders, and the test
// runner's own configuration and setup files under their common names. They
// belong to the test side, so the tree before the fix runs the tests with the
// same test setup as the head. A setup file under another name is test side
// when a vitest config names it (setupFiles, globalSetup) or when it matches
// the caller's --test-support pattern.
export const TEST_SUPPORT_RE =
  /(^|\/)(__tests__|__fixtures__|__snapshots__|__mocks__|__stubs__)\/|(^|\/)(?:(?:vitest|vite)\.(?:config|workspace)|vitest\.(?:setup|global-?setup)|setupTests|setup-?tests|tests?-?setup|global-?setup)\.[^/]*$|(^|\/)tests?\/setup\.[^/]*$/;
const FIXTURE_DIR_RE = /(^|\/)__fixtures__\//;
const SHA_RE = /^[0-9a-f]{40}$/;
const VITEST_CONFIG_RE = /^(?:vitest|vite)\.config\.[cm]?[jt]s$|^vitest\.workspace\.(?:[cm]?[jt]s|json)$/;
const SETUP_KEY_RE = /\b(?:setupFiles|globalSetup)\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|`[^`$]*`)/g;
const STRING_RE = /"([^"]*)"|'([^']*)'|`([^`$]*)`/g;
const SCRIPT_EXT_RE = /\.[cm]?[jt]sx?$/;
// Time kept back from the job's limit for the verdict, the summary and the
// removal of the trees, so the gate names TIMEOUT before GitHub stops the job.
export const JOB_RESERVE_SECONDS = 120;
const NODE_TEST_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']node:test["']/;
const MARKER_RE = /red-first-expect:[ \t]*(.*?)[ \t]*(?:\*\/[ \t]*)?$/;
const ASSERTION_TEXT_RE = /^(?:AssertionError|JestAssertionError)\b/;
const REPORTER = join(dirname(fileURLToPath(import.meta.url)), "red-first-reporter.mjs");
export const DEFAULT_VITEST = "npx --no-install vitest run";
// The statuses the vitest JSON report uses; any other value makes the report
// unreadable (NO-REPORT), never a skip or a pass.
const VITEST_STATUS = { passed: "passed", failed: "failed", skipped: "skipped", pending: "skipped", todo: "skipped", disabled: "skipped" };
const VITEST_FILE_STATUS = new Set(["passed", "failed", "skipped", "pending", "todo"]);
const KNOWN_STATUS = new Set(["passed", "failed", "skipped"]);
// Runner credentials a test process never needs (the job reads only contents).
const CHILD_ENV_DROP = [
  "NODE_TEST_CONTEXT",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
  "ACTIONS_CACHE_URL",
  "ACTIONS_RESULTS_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
];

const USAGE = `usage:
  red-first-gate.mjs plan --base <sha> --head <sha> [--repo <dir>] [--exclude <re>] [--test-support <re>] [--verdict <file>] [--github-output <file>] [--summary <file>]
  red-first-gate.mjs run  --base <sha> --head <sha> --work <empty dir> [--repo <dir>] [--install <cmd>] [--vitest <cmd>] [--exclude <re>] [--test-support <re>] [--timeout-seconds <n>] [--job-started <epoch s> --job-minutes <n>] [--verdict <file>] [--summary <file>]`;

export class GateError extends Error {}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function normalizeText(text) {
  return String(text ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
}

function stripStack(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s+at\s/.test(line))
    .join("\n");
}

function clip(text, max = 240) {
  const t = normalizeText(text);
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function firstLine(text, max = 200) {
  const line = String(text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return clip(line, max);
}

function byPath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toPosix(p) {
  return p.split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function isTestFile(path) {
  return TEST_FILE_RE.test(path);
}

export function isTestSide(path) {
  return isTestFile(path) || TEST_SUPPORT_RE.test(path);
}

function pattern(flag, source) {
  if (!source) return null;
  try {
    return new RegExp(source);
  } catch (error) {
    throw new GateError(`${flag} is not a valid regular expression: ${error.message}`);
  }
}

// The test-side test of one path: the default names, the caller's
// --test-support pattern and the setup files a vitest config names.
export function testSideOf({ testSupport = "", setupPaths = [] } = {}) {
  const supportRe = pattern("--test-support", testSupport);
  const setup = new Set(setupPaths);
  return (path) => isTestSide(path) || setup.has(path) || setup.has(path.replace(SCRIPT_EXT_RE, "")) || Boolean(supportRe?.test(path));
}

// The setup files a vitest config names in setupFiles or globalSetup as string
// literals, as repository paths (relative to the config's folder). A path
// built at run time is not seen: name it in --test-support.
export function setupPathsFromConfig(configPath, source) {
  const dir = posix.dirname(configPath);
  const paths = [];
  for (const match of String(source).matchAll(SETUP_KEY_RE)) {
    for (const lit of match[1].matchAll(STRING_RE)) {
      const raw = (lit[1] ?? lit[2] ?? lit[3] ?? "").trim();
      // A package or an alias ("@scope/pkg", "~/x", "virtual:x") is not a path here.
      if (!raw || raw.startsWith("@") || raw.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) continue;
      const joined = posix.normalize(posix.join(dir, raw.replace(/^\/+/, "")));
      if (joined === "." || joined.startsWith("../") || joined === "..") continue;
      paths.push(joined);
    }
  }
  return [...new Set(paths)].sort(byPath);
}

export function classifyPaths(entries, { exclude = "", testSupport = "", setupPaths = [] } = {}) {
  const excludeRe = pattern("--exclude", exclude);
  const onTestSide = testSideOf({ testSupport, setupPaths });
  const newTests = [];
  const excluded = [];
  const fixSide = [];
  const testSide = [];
  for (const { status, path } of entries) {
    if (onTestSide(path)) {
      testSide.push({ status, path });
      // A test-named file inside a fixtures folder is test data, not a test.
      if (isTestFile(path) && status !== "D" && !FIXTURE_DIR_RE.test(path)) (excludeRe?.test(path) ? excluded : newTests).push(path);
    } else {
      fixSide.push(path);
    }
  }
  return {
    newTests: newTests.sort(byPath),
    excluded: excluded.sort(byPath),
    fixSide: fixSide.sort(byPath),
    testSide: testSide.sort((a, b) => byPath(a.path, b.path)),
  };
}

export function readMarkers(source) {
  const markers = [];
  for (const line of String(source).split(/\r?\n/)) {
    const match = MARKER_RE.exec(line);
    // A marker that is empty once normalized would match every failure text.
    if (match && normalizeText(match[1])) markers.push(match[1].trim());
  }
  return markers;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function relativeIn(name, roots) {
  if (typeof name !== "string" || !isAbsolute(name)) return null;
  for (const root of roots) {
    const rel = relative(root, name);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return toPosix(rel);
  }
  return null;
}

function rootsOf(treeRoot) {
  const roots = [treeRoot];
  try {
    const real = realpathSync(treeRoot);
    if (real !== treeRoot) roots.push(real);
  } catch {
    // the tree may be gone in a unit test; the given root is enough
  }
  return roots;
}

// vitest --reporter=json: { success, testResults: [{ name, status, message, assertionResults: [...] }] }.
// Read fail closed: any value outside that shape, an unknown status, or a
// report that contradicts itself (success with a failure, a failed test in a
// file reported as passed) makes the whole report unreadable.
// Returns { ok: true, success, files: Map(repo-relative file -> result) } or
// { ok: false, why }.
function isStringList(value) {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

export function parseVitestReport(report, treeRoot) {
  const bad = (why) => ({ ok: false, why, success: null, files: new Map() });
  if (!report || typeof report !== "object" || Array.isArray(report)) return bad("the report is not a JSON object");
  if (!Array.isArray(report.testResults)) return bad("the report has no testResults array");
  if (typeof report.success !== "boolean") return bad("the report has no boolean success field");
  const roots = rootsOf(treeRoot);
  const files = new Map();
  let anyFailed = false;
  for (const [i, entry] of report.testResults.entries()) {
    const at = `testResults[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return bad(`${at} is not an object`);
    if (typeof entry.name !== "string") return bad(`${at} has no file name`);
    if (!Array.isArray(entry.assertionResults)) return bad(`${at} has no assertionResults array`);
    if (!VITEST_FILE_STATUS.has(entry.status)) return bad(`${at} has the unknown status ${JSON.stringify(entry.status)}`);
    if (entry.message != null && typeof entry.message !== "string") return bad(`${at} has a message that is not text`);
    const tests = [];
    for (const [j, a] of entry.assertionResults.entries()) {
      const where = `${at}.assertionResults[${j}]`;
      if (!a || typeof a !== "object" || Array.isArray(a)) return bad(`${where} is not an object`);
      const status = Object.hasOwn(VITEST_STATUS, a.status) ? VITEST_STATUS[a.status] : null;
      if (!status) return bad(`${where} has the unknown status ${JSON.stringify(a.status)}`);
      if (a.ancestorTitles != null && !isStringList(a.ancestorTitles)) return bad(`${where} has ancestorTitles that are not a list of text`);
      if (a.title != null && typeof a.title !== "string") return bad(`${where} has a title that is not text`);
      if (a.fullName != null && typeof a.fullName !== "string") return bad(`${where} has a fullName that is not text`);
      if (a.failureMessages != null && !isStringList(a.failureMessages)) return bad(`${where} has failureMessages that are not a list of text`);
      const name = a.fullName || [...(a.ancestorTitles ?? []), a.title ?? ""].join(" ");
      if (!normalizeText(name)) return bad(`${where} has no test name`);
      const text = status === "failed" ? stripStack((a.failureMessages ?? []).join("\n")) : null;
      tests.push({ name, status, text, assertion: status === "failed" && ASSERTION_TEXT_RE.test(normalizeText(text)) });
    }
    const fileFailed = entry.status === "failed";
    const testFailed = tests.some((t) => t.status === "failed");
    if (testFailed && !fileFailed) return bad(`${at} reports a failed test in a file whose status is ${entry.status}`);
    if (fileFailed) anyFailed = true;
    const rel = relativeIn(entry.name, roots);
    if (rel === null) continue;
    const message = stripStack(entry.message ?? "").trim();
    const loaded = !(tests.length === 0 && (fileFailed || message));
    let fileError = null;
    if (loaded && message) fileError = firstLine(message);
    else if (loaded && fileFailed && !testFailed) fileError = "the runner reports the file as failed although none of its tests failed";
    const result = {
      loaded,
      loadError: loaded ? null : message ? firstLine(message) : `the runner reports the file as ${entry.status}`,
      fileError,
      tests,
    };
    // The same file reported twice (two projects include it): keep every
    // result, so one failing copy is never hidden by a passing one.
    const seen = files.get(rel);
    if (seen) {
      result.loaded = seen.loaded && result.loaded;
      result.loadError = seen.loadError ?? result.loadError;
      result.fileError = seen.fileError ?? result.fileError;
      result.tests = [...seen.tests, ...result.tests];
    }
    files.set(rel, result);
  }
  if (report.success && anyFailed) return bad("the report says success although a file or a test failed");
  return { ok: true, why: null, success: report.success, files };
}

function nodeFailure(error) {
  if (!error) return { text: "Error: failed", assertion: false };
  const name = error.causeName ?? error.name ?? "Error";
  const message = error.causeMessage || error.message || "";
  return {
    text: `${name}: ${message}`,
    assertion: error.failureType === "testCodeFailure" && (error.causeCode === "ERR_ASSERTION" || error.causeName === "AssertionError"),
  };
}

function firstErrorLine(stderr) {
  const lines = String(stderr).split(/\r?\n/).filter((l) => l.trim());
  return lines.find((l) => /\b[A-Z][A-Za-z]*Error\b|\bERR_[A-Z_]+\b/.test(l)) ?? lines[0] ?? null;
}

// The lines red-first-reporter.mjs writes for ONE test file run with
// `node --test <fileArg>`. Returns the file result, or null when unreadable.
export function parseNodeReport(text, fileArg) {
  const events = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  if (events.length === 0) return null;
  const stderr = [];
  const tests = [];
  const open = [];
  let wrapper = null;
  for (const e of events) {
    if (e?.kind === "stderr") {
      stderr.push(String(e.message ?? ""));
      continue;
    }
    if (e?.kind !== "test") return null;
    // The runner reports the file itself as a top-level test named after the
    // path it was given when the file's process reported no test or exited
    // with an error.
    if (e.nesting === 0 && e.type === "test" && e.name === fileArg) {
      wrapper = { ok: Boolean(e.ok), ...nodeFailure(e.error) };
      continue;
    }
    // Results arrive children first, then their suite: the trailing open
    // entries deeper than this one are its children.
    const children = [];
    while (open.length && open[open.length - 1].nesting > e.nesting) children.unshift(open.pop());
    const entry = { nesting: e.nesting, leaves: [] };
    for (const child of children) {
      for (const leaf of child.leaves) leaf.path.unshift(e.name);
      entry.leaves.push(...child.leaves);
    }
    const ownFailure = !e.ok && e.error?.failureType !== "subtestsFailed";
    if ((children.length === 0 && e.type !== "suite") || (children.length > 0 && e.type === "test" && ownFailure)) {
      const failure = e.ok ? null : nodeFailure(e.error);
      const leaf = {
        path: [e.name],
        status: e.skip || e.todo ? "skipped" : e.ok ? "passed" : "failed",
        text: failure?.text ?? null,
        assertion: Boolean(failure?.assertion),
      };
      tests.push(leaf);
      entry.leaves.push(leaf);
    }
    open.push(entry);
  }
  const result = tests.map((t) => ({ name: t.path.join(" > "), status: t.status, text: t.text, assertion: t.assertion }));
  if (wrapper && !wrapper.ok) {
    const why = firstErrorLine(stderr.join("")) ?? wrapper.text;
    if (result.length === 0) return { loaded: false, loadError: clip(why), fileError: null, tests: result };
    return { loaded: true, loadError: null, fileError: clip(why), tests: result };
  }
  return { loaded: true, loadError: null, fileError: null, tests: result };
}

// ---------------------------------------------------------------------------
// Judgement of one new test file
// ---------------------------------------------------------------------------

// Every test that failed before the fix, by name: the head must report at
// least as many occurrences of that name as the tree before the fix did, and
// every one of them passed. Tests of the same name (two projects, or two
// tests with one title) cannot be told apart, so one passing copy never
// stands in for another. Returns the names that fall short, with counts.
function notPassedAtHead(failedBefore, beforeTests, headTests) {
  const short = [];
  for (const name of [...new Set(failedBefore.map((t) => t.name))]) {
    const wanted = beforeTests.filter((t) => t.name === name).length;
    const atHead = headTests.filter((t) => t.name === name);
    const passed = atHead.filter((t) => t.status === "passed").length;
    if (passed < wanted || passed < atHead.length) short.push(`${name} (${passed} of ${Math.max(wanted, atHead.length)} passed)`);
  }
  return short;
}

function actual(failed) {
  return failed
    .slice(0, 3)
    .map((t) => `${t.name}: ${clip(t.text ?? "", 160)}`)
    .join(" | ");
}

// before / head: { run: "ok" | "no-report" | "timeout", result } or undefined
// when the phase did not run. Reasons for no-report, timeout and a stopped
// install are recorded where they happen; this adds the per-file reasons.
export function judgeFile({ file, markers = [] }, before, head) {
  const reasons = [];
  const add = (code, phase, detail) => reasons.push({ code, phase, file, detail: clip(detail, 400) });
  let failedBefore = [];
  let beforeTests = [];
  let beforeOk = false;
  let headOk = false;
  const unknown = (r) => r?.tests?.find((t) => !KNOWN_STATUS.has(t.status));

  if (before?.run === "ok") {
    const r = before.result;
    if (!r) add("NOT-COLLECTED", "before", "the file is not in the runner's report (outside the runner's include, or filtered out)");
    else if (unknown(r)) add("NO-REPORT", "before", `the report gives the unknown status ${JSON.stringify(unknown(r).status)} for ${unknown(r).name}`);
    else if (!r.loaded) add("LOAD-ERROR", "before", r.loadError);
    else if (r.fileError) add("FILE-ERROR", "before", r.fileError);
    else {
      const ran = r.tests.filter((t) => t.status !== "skipped");
      const failed = ran.filter((t) => t.status === "failed");
      if (ran.length === 0) add("NOT-COLLECTED", "before", "no test ran (none collected, or all skipped)");
      else if (failed.length === 0) add("NOT-RED-BEFORE", "before", `all ${ran.length} test(s) already pass before the fix`);
      else {
        failedBefore = failed;
        beforeTests = r.tests;
        const texts = failed.map((t) => normalizeText(t.text));
        const wanted = markers.map((m) => normalizeText(m));
        const unmatched = markers.filter((m, i) => !texts.some((x) => x.includes(wanted[i])));
        const right = failed.filter((t, i) => t.assertion || wanted.some((m) => texts[i].includes(m)));
        if (unmatched.length) add("TEXT-MISMATCH", "before", `marker "${unmatched[0]}" is in no failure text; actual: ${actual(failed)}`);
        else if (right.length === 0) add("WRONG-REASON", "before", `no assertion failure (a red-first-expect: marker can name the expected text); actual: ${actual(failed)}`);
        else beforeOk = true;
      }
    }
  }

  if (head?.run === "ok") {
    const r = head.result;
    if (!r) add("NOT-COLLECTED", "head", "the file is not in the runner's report (outside the runner's include, or filtered out)");
    else if (unknown(r)) add("NO-REPORT", "head", `the report gives the unknown status ${JSON.stringify(unknown(r).status)} for ${unknown(r).name}`);
    else if (!r.loaded) add("LOAD-ERROR", "head", r.loadError);
    else if (r.fileError) add("FILE-ERROR", "head", r.fileError);
    else {
      const failed = r.tests.filter((t) => t.status === "failed");
      const passed = r.tests.filter((t) => t.status === "passed");
      if (failed.length) add("NOT-GREEN-AT-HEAD", "head", `${failed.length} test(s) do not pass with the fix: ${actual(failed)}`);
      else if (passed.length === 0) add("NOT-COLLECTED", "head", "no test passed with the fix (none collected, or all skipped)");
      else {
        const short = notPassedAtHead(failedBefore, beforeTests, r.tests);
        if (short.length) {
          add("NOT-GREEN-AT-HEAD", "head", `failed before the fix but did not pass with it: ${short.slice(0, 3).join(" | ")}`);
        } else headOk = true;
      }
    }
  }
  return { reasons, proven: beforeOk && headOk && reasons.length === 0 };
}

// ---------------------------------------------------------------------------
// git, processes and trees
// ---------------------------------------------------------------------------

function gitEnv(extra = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extra };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[key];
  return env;
}

function git(repo, args, { allowFail = false, env = {} } = {}) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--literal-pathspecs", "-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: gitEnv(env),
  });
  if (r.error) throw new GateError(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new GateError(`git ${args.join(" ")} failed: ${firstLine(r.stderr)}`);
  return r;
}

function nulList(text) {
  const parts = String(text).split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

function childEnv() {
  const env = { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const key of CHILD_ENV_DROP) delete env[key];
  return env;
}

// The process groups of the children still running, so a stop of the gate
// (job cancelled) takes them along.
const liveGroups = new Set();

function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // the group is gone already
  }
}

function onStop(signal) {
  for (const pid of liveGroups) killGroup(pid);
  process.exit(signal === "SIGINT" ? 130 : 143);
}

// A child runs in its own process group (detached), with its output on this
// process's stderr, so stdout carries only the verdict. When the child exits,
// or its time is up, the whole group is killed: a background process it left
// cannot outlive it and change a later phase or run. (A process that leaves
// the group on purpose, with setsid, is outside this; the gate trusts the pull
// request's toolchain as any test job does.)
function spawnChild(command, args, cwd, timeoutMs) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", 2, 2], env: childEnv(), detached: true });
    } catch (error) {
      done({ status: null, signal: null, timedOut: false, error: error.message });
      return;
    }
    let timedOut = false;
    let settled = false;
    if (child.pid) liveGroups.add(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, Math.max(1, timeoutMs));
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child.pid);
      liveGroups.delete(child.pid);
      done(value);
    };
    child.on("error", (error) => finish({ status: null, signal: null, timedOut: false, error: error.message }));
    child.on("exit", (status, signal) => finish({ status, signal, timedOut, error: null }));
  });
}

function shell(script, cwd, timeoutMs, args = []) {
  return spawnChild("bash", ["-c", script, "red-first", ...args], cwd, timeoutMs);
}

function group(title) {
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::group::${title}`);
  else console.error(`== ${title}`);
}

function endGroup() {
  if (process.env.GITHUB_ACTIONS === "true") console.log("::endgroup::");
}

// Tracked test-side files of a tree whose bytes or mode differ from the head
// commit: the install or the test run changed them, so the tests that ran are
// not the tests of the pull request. Both trees carry the head's test side, and
// the comparison is with the head commit itself (not the tree's index or HEAD),
// so a change that was staged or committed is seen as well.
function changedTestSide(tree, plan) {
  const onTestSide = testSideOf(plan);
  const listed = new Set(plan.testSide.map((e) => e.path));
  return nulList(git(tree, ["diff", "--name-only", "--no-renames", "-z", plan.head]).stdout)
    .filter((p) => listed.has(p) || onTestSide(p))
    .sort(byPath);
}

function exitText(res) {
  if (res.error) return `could not start: ${res.error}`;
  return res.signal ? `was killed by ${res.signal}` : `exited ${res.status}`;
}

// Setup files named by every vitest config of the head, read from git objects.
// In the plan job (a partial clone) a config whose blob is not local is not
// fetched: the run job, with the full clone, reads it (strict = true).
function configSetupPaths(repo, head, strict) {
  const names = nulList(git(repo, ["ls-tree", "-r", "--name-only", "-z", head]).stdout);
  const paths = [];
  for (const name of names.filter((n) => VITEST_CONFIG_RE.test(posix.basename(n)))) {
    const r = git(repo, ["cat-file", "blob", `${head}:${name}`], { allowFail: true, env: { GIT_NO_LAZY_FETCH: "1" } });
    if (r.status !== 0) {
      if (strict) throw new GateError(`the vitest config ${name} at the head is not readable: ${firstLine(r.stderr)}`);
      continue;
    }
    paths.push(...setupPathsFromConfig(name, r.stdout));
  }
  return [...new Set(paths)].sort(byPath);
}

export function checkPlatform(platform = process.platform) {
  if (platform === "win32") throw new GateError("red-first-gate runs on Linux or macOS runners only (it needs bash and process groups)");
}

export function planRange({ repo = process.cwd(), base, head, exclude = "", testSupport = "", strict = false }) {
  if (!base && !head) {
    return { verdict: "skip", reason: "NOT-A-PULL-REQUEST", detail: "no pull request base and head were given", newTests: [], excluded: [], fixSide: [], testSide: [] };
  }
  if (!SHA_RE.test(base ?? "") || !SHA_RE.test(head ?? "")) throw new GateError("--base and --head must both be 40-hex commit SHAs");
  for (const sha of [base, head]) git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  const mergeBase = git(repo, ["merge-base", base, head]).stdout.trim();
  if (!SHA_RE.test(mergeBase)) throw new GateError(`no merge base of ${base} and ${head}`);
  const parts = nulList(git(repo, ["diff", "--name-status", "--no-renames", "-z", mergeBase, head]).stdout);
  if (parts.length % 2) throw new GateError("the range's name-status list is not readable");
  const entries = [];
  for (let i = 0; i < parts.length; i += 2) entries.push({ status: parts[i].charAt(0), path: parts[i + 1] });
  const setupPaths = configSetupPaths(repo, head, strict);
  const c = classifyPaths(entries, { exclude, testSupport, setupPaths });
  const plan = { base, head, mergeBase, testSupport, setupPaths, ...c };
  if (c.newTests.length + c.excluded.length === 0) {
    return { ...plan, verdict: "skip", reason: "NO-NEW-TESTS", detail: "the pull request adds or changes no test file" };
  }
  if (c.fixSide.length === 0) {
    return { ...plan, verdict: "skip", reason: "TESTS-ONLY", detail: "the pull request changes only tests and test support files: there is no fix to prove" };
  }
  if (c.newTests.length === 0) {
    return { ...plan, verdict: "skip", reason: "EXCLUDED-ONLY", detail: `every new or changed test file (${c.excluded.length}) matches --exclude: this check cannot prove them, so it is neutral (skipped), not red` };
  }
  const also = c.excluded.length ? `; ${c.excluded.length} more match --exclude and are not proven here` : "";
  return { ...plan, verdict: "run", reason: "", detail: `${c.newTests.length} new or changed test file(s) to prove${also}` };
}

const WORK_ENTRIES = ["before", "head", "reports", "take.lst", "drop.lst"];

function prepareWork(work) {
  if (!work) throw new GateError("--work is required for run");
  const abs = resolve(work);
  let created = false;
  if (existsSync(abs)) {
    if (readdirSync(abs).length) throw new GateError(`--work ${abs} is not empty`);
  } else {
    mkdirSync(abs, { recursive: true });
    created = true;
  }
  const real = realpathSync(abs);
  mkdirSync(join(real, "reports"));
  return { path: real, created };
}

// Removes the trees (and their worktree registrations) and the reports, so a
// later run on the same runner and work path starts clean.
function cleanWork(repo, work) {
  for (const tree of ["before", "head"]) {
    if (existsSync(join(work.path, tree))) git(repo, ["worktree", "remove", "--force", "--force", join(work.path, tree)], { allowFail: true });
  }
  git(repo, ["worktree", "prune"], { allowFail: true });
  for (const name of WORK_ENTRIES) rmSync(join(work.path, name), { recursive: true, force: true });
  if (work.created) rmSync(work.path, { recursive: true, force: true });
}

function writePathspec(file, paths) {
  writeFileSync(file, `${paths.join("\0")}\0`);
  return file;
}

// The tree before the fix: the merge base, with every test-side path of the
// range taken from the head (added and changed ones checked out, deleted ones
// removed). Returns a TREE-MISMATCH detail, or null when the tree is exact.
function buildBeforeTree(repo, plan, tree, work) {
  git(repo, ["worktree", "add", "-q", "--detach", tree, plan.mergeBase]);
  const take = plan.testSide.filter((e) => e.status !== "D").map((e) => e.path);
  const drop = plan.testSide.filter((e) => e.status === "D").map((e) => e.path);
  if (take.length) {
    git(tree, ["checkout", plan.head, `--pathspec-from-file=${writePathspec(join(work, "take.lst"), take)}`, "--pathspec-file-nul"]);
  }
  if (drop.length) {
    git(tree, ["rm", "-q", `--pathspec-from-file=${writePathspec(join(work, "drop.lst"), drop)}`, "--pathspec-file-nul"]);
  }
  const vsBase = nulList(git(tree, ["diff", "--cached", "--name-only", "--no-renames", "-z", plan.mergeBase]).stdout).sort(byPath);
  const vsHead = nulList(git(tree, ["diff", "--cached", "--name-only", "--no-renames", "-z", plan.head]).stdout).sort(byPath);
  const unstaged = nulList(git(tree, ["diff", "--name-only", "-z"]).stdout);
  const wantBase = plan.testSide.map((e) => e.path);
  if (JSON.stringify(vsBase) !== JSON.stringify(wantBase)) return `the tree before the fix differs from the merge base in ${vsBase.length} path(s), expected the ${wantBase.length} test-side path(s)`;
  if (JSON.stringify(vsHead) !== JSON.stringify(plan.fixSide)) return `the tree before the fix differs from the head in ${vsHead.length} path(s), expected the ${plan.fixSide.length} fix-side path(s)`;
  if (unstaged.length) return `the tree before the fix has ${unstaged.length} unstaged change(s)`;
  return null;
}

// A path that starts with "-" would read as an option.
function asArgument(path) {
  return path.startsWith("-") ? `./${path}` : path;
}

function vitestDir(tree, file) {
  let dir = dirname(file);
  for (;;) {
    const here = dir === "." ? "" : dir;
    let names = [];
    try {
      names = readdirSync(join(tree, here));
    } catch {
      names = [];
    }
    if (names.some((n) => VITEST_CONFIG_RE.test(n))) return here;
    if (!here) return "";
    dir = dirname(here);
  }
}

// The time a child may take: the per-child limit, cut to what is left of the
// job's budget (--job-started/--job-minutes less JOB_RESERVE_SECONDS).
function allowance(opts) {
  const own = opts.timeoutSeconds * 1000;
  if (opts.deadlineMs == null) return { ms: own, byJob: false };
  const left = opts.deadlineMs - Date.now();
  return left < own ? { ms: left, byJob: true } : { ms: own, byJob: false };
}

function timeText(opts, byJob) {
  return byJob ? `the job's time budget (timeout_minutes less ${JOB_RESERVE_SECONDS}s for the verdict)` : `${opts.timeoutSeconds}s`;
}

async function runPhase(phase, tree, files, plan, opts, reportDir) {
  const reasons = [];
  const perFile = new Map();
  const invocations = [];
  // Before each step: when the job's budget is spent, stop with TIMEOUT, so
  // the verdict is written before GitHub ends the job.
  const outOfTime = (step, pending) => {
    const left = allowance(opts);
    if (left.ms > 0) return null;
    reasons.push({ code: "TIMEOUT", phase, file: null, detail: `the job's time budget was spent before ${step}; no further test ran` });
    for (const file of pending) perFile.set(file, { run: "timeout" });
    return { stop: true, reasons, perFile, invocations };
  };
  if (opts.install) {
    const stop = outOfTime("the install", []);
    if (stop) return stop;
    const left = allowance(opts);
    group(`red-first: install (${phase})`);
    const res = await shell(opts.install, tree, left.ms);
    endGroup();
    if (res.timedOut) {
      reasons.push({ code: "TIMEOUT", phase, file: null, detail: `the install did not finish within ${timeText(opts, left.byJob)}; no test ran in this tree` });
      return { stop: true, reasons, perFile, invocations };
    }
    if (res.status !== 0) {
      reasons.push({ code: "INSTALL-FAILED", phase, file: null, detail: `the install ${exitText(res)}; no test ran in this tree` });
      return { stop: true, reasons, perFile, invocations };
    }
    const touched = changedTestSide(tree, plan);
    if (touched.length) {
      for (const file of touched) reasons.push({ code: "TEST-CHANGED", phase, file, detail: "the install changed this test-side file before the tests ran" });
      return { stop: true, reasons, perFile, invocations };
    }
  }

  const nodeFiles = files.filter((f) => f.runner === "node");
  for (const [i, f] of nodeFiles.entries()) {
    const stop = outOfTime(`node --test ${f.file}`, [...nodeFiles.slice(i).map((x) => x.file), ...files.filter((x) => x.runner === "vitest").map((x) => x.file)]);
    if (stop) return stop;
    const left = allowance(opts);
    const out = join(reportDir, `${phase}-node-${i}.jsonl`);
    const arg = asArgument(f.file);
    group(`red-first: node --test ${f.file} (${phase})`);
    const res = await spawnChild(
      process.execPath,
      ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${REPORTER}`, `--test-reporter-destination=${out}`, arg],
      tree,
      left.ms,
    );
    endGroup();
    if (res.timedOut) {
      reasons.push({ code: "TIMEOUT", phase, file: f.file, detail: `node --test did not finish within ${timeText(opts, left.byJob)}` });
      perFile.set(f.file, { run: "timeout" });
      continue;
    }
    const parsed = existsSync(out) ? parseNodeReport(readFileSync(out, "utf8"), arg) : null;
    if (!parsed) {
      reasons.push({ code: "NO-REPORT", phase, file: f.file, detail: `node --test ${exitText(res)} and wrote no readable report` });
      perFile.set(f.file, { run: "no-report" });
      continue;
    }
    perFile.set(f.file, { run: "ok", result: parsed });
    invocations.push({ label: `node --test ${f.file}`, files: [f.file], res, reportFailed: false });
  }

  const groups = new Map();
  for (const f of files.filter((x) => x.runner === "vitest")) {
    const dir = vitestDir(tree, f.file);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f.file);
  }
  const groupList = [...groups.entries()];
  for (const [i, [dir, list]] of groupList.entries()) {
    const where = dir || ".";
    const stop = outOfTime(`vitest in ${where}`, groupList.slice(i).flatMap(([, l]) => l));
    if (stop) return stop;
    const left = allowance(opts);
    const out = join(reportDir, `${phase}-vitest-${i}.json`);
    const cwd = join(tree, dir);
    const args = list.map((file) => asArgument(toPosix(relative(cwd, join(tree, file)))));
    group(`red-first: vitest in ${where} (${phase})`);
    const res = await shell(`${opts.vitest} "$@"`, cwd, left.ms, [...args, "--reporter=default", "--reporter=json", `--outputFile.json=${out}`]);
    endGroup();
    if (res.timedOut) {
      reasons.push({ code: "TIMEOUT", phase, file: null, detail: `vitest in ${where} did not finish within ${timeText(opts, left.byJob)}` });
      for (const file of list) perFile.set(file, { run: "timeout" });
      continue;
    }
    let report;
    let why = "no JSON report was written";
    try {
      report = JSON.parse(readFileSync(out, "utf8"));
    } catch (error) {
      report = undefined;
      if (existsSync(out)) why = `the JSON report is not valid JSON (${clip(error.message, 120)})`;
    }
    const parsed = report === undefined ? { ok: false, why } : parseVitestReport(report, tree);
    if (!parsed.ok) {
      reasons.push({ code: "NO-REPORT", phase, file: null, detail: `vitest in ${where} ${exitText(res)} and wrote no readable JSON report: ${parsed.why}` });
      for (const file of list) perFile.set(file, { run: "no-report" });
      continue;
    }
    for (const file of list) perFile.set(file, { run: "ok", result: parsed.files.get(file) ?? null });
    invocations.push({ label: `vitest in ${where}`, files: list, res, reportFailed: parsed.success === false });
  }
  for (const file of changedTestSide(tree, plan)) {
    reasons.push({ code: "TEST-CHANGED", phase, file, detail: "the test run changed this tracked test-side file" });
  }
  return { stop: false, reasons, perFile, invocations };
}

export async function runGate(opts) {
  const plan = planRange({ ...opts, strict: true });
  if (plan.verdict === "skip") {
    return { mode: "run", verdict: "SKIP", reason: plan.reason, detail: plan.detail, mergeBase: plan.mergeBase ?? null, reasons: [], notes: [], files: [] };
  }
  const repo = opts.repo ?? process.cwd();
  const reasons = [];
  // New tests that match --exclude beside other new tests: listed, not proven,
  // and no reason to fail the proof of the others.
  const notes = plan.excluded.map((file) => ({ code: "EXCLUDED", phase: "plan", file, detail: "the path matches --exclude: this check does not prove it" }));
  git(repo, ["worktree", "prune"], { allowFail: true });
  const work = prepareWork(opts.work);
  const result = { mode: "run", verdict: "RED", reason: "", detail: "", mergeBase: plan.mergeBase, reasons, notes, files: [] };
  const trees = { before: join(work.path, "before"), head: join(work.path, "head") };
  try {
    git(repo, ["worktree", "add", "-q", "--detach", trees.head, plan.head]);
    const mismatch = buildBeforeTree(repo, plan, trees.before, work.path);
    if (mismatch) {
      reasons.push({ code: "TREE-MISMATCH", phase: "before", file: null, detail: mismatch });
      return result;
    }

    const files = plan.newTests.map((file) => {
      const source = readFileSync(join(trees.head, file), "utf8");
      return { file, runner: NODE_TEST_IMPORT_RE.test(source) ? "node" : "vitest", markers: readMarkers(source) };
    });
    const phases = {};
    for (const phase of ["before", "head"]) {
      const run = await runPhase(phase, trees[phase], files, plan, opts, join(work.path, "reports"));
      reasons.push(...run.reasons);
      if (run.stop) break;
      phases[phase] = run;
    }

    const headReasonFiles = new Set();
    for (const f of files) {
      const judged = judgeFile(f, phases.before?.perFile.get(f.file), phases.head?.perFile.get(f.file));
      reasons.push(...judged.reasons);
      for (const r of judged.reasons) if (r.phase === "head") headReasonFiles.add(f.file);
      result.files.push({ file: f.file, runner: f.runner, markers: f.markers, proven: judged.proven });
    }
    for (const inv of phases.head?.invocations ?? []) {
      if ((inv.res.status !== 0 || inv.reportFailed) && !inv.files.some((file) => headReasonFiles.has(file))) {
        const what = inv.res.status !== 0 ? exitText(inv.res) : "reported success: false";
        reasons.push({ code: "RUNNER-EXIT", phase: "head", file: inv.files.length === 1 ? inv.files[0] : null, detail: `${inv.label} ${what} with the fix although every new test passed` });
      }
    }
    for (const f of result.files) {
      if (reasons.some((r) => r.file === f.file || r.file === null)) f.proven = false;
    }
    // Safety net: a file that is not proven always carries a reason.
    if (!reasons.length) {
      for (const f of result.files) {
        if (!f.proven) reasons.push({ code: "NOT-PROVEN", phase: null, file: f.file, detail: "the file was not proven red before the fix and green with it" });
      }
    }
    if (!reasons.length && result.files.length > 0 && result.files.every((f) => f.proven)) result.verdict = "PASS";
    return result;
  } finally {
    for (const r of reasons) {
      if (r.detail) for (const root of [...rootsOf(trees.before), ...rootsOf(trees.head)]) r.detail = r.detail.split(root).join("<tree>");
    }
    cleanWork(repo, work);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function escapeData(text) {
  return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(text) {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function cell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

function reasonLine(r) {
  return `${r.code} ${r.phase ?? "-"} ${r.file ?? "-"}: ${r.detail ?? ""}`;
}

function emit(result, opts) {
  const gha = process.env.GITHUB_ACTIONS === "true";
  for (const r of result.reasons ?? []) {
    console.log(`REASON ${reasonLine(r)}`);
    if (gha) {
      const fileProp = r.file ? `file=${escapeProperty(r.file)},` : "";
      console.log(`::error ${fileProp}title=${escapeProperty(`red-first ${r.code}`)}::${escapeData(reasonLine(r))}`);
    }
  }
  // Excluded new tests: a note in both jobs (plan lists them from the range).
  const notes = result.mode === "plan" ? (result.excluded ?? []).map((file) => ({ code: "EXCLUDED", phase: "plan", file, detail: "the path matches --exclude: this check does not prove it" })) : (result.notes ?? []);
  for (const r of notes) {
    console.log(`NOTE ${reasonLine(r)}`);
    if (gha) console.log(`::notice file=${escapeProperty(r.file)},title=${escapeProperty(`red-first ${r.code}`)}::${escapeData(reasonLine(r))}`);
  }
  const notProven = notes.length ? `; ${notes.length} excluded new test file(s) not proven here` : "";
  let headline;
  if (result.mode === "plan") headline = `RED-FIRST PLAN: ${result.verdict}${result.reason ? ` ${result.reason}` : ""}: ${result.detail}`;
  else if (result.verdict === "PASS") headline = `RED-FIRST: PASS (${result.files.length} new test file(s) fail before the fix and pass with it${notProven})`;
  else if (result.verdict === "SKIP") headline = `RED-FIRST: SKIP ${result.reason}: ${result.detail}`;
  else headline = `RED-FIRST: RED (${result.reasons.length} reason(s))`;
  console.log(headline);
  if (gha && result.verdict === "SKIP") console.log(`::notice title=red-first SKIP::${escapeData(`${result.reason}: ${result.detail}`)}`);

  if (opts.verdict) writeFileSync(opts.verdict, `${JSON.stringify(result, null, 2)}\n`);
  if (opts.githubOutput && result.mode === "plan") {
    appendFileSync(opts.githubOutput, `verdict=${result.verdict}\nreason=${result.reason}\nnew_tests=${(result.newTests ?? []).length + (result.excluded ?? []).length}\nexcluded=${(result.excluded ?? []).length}\n`);
  }
  if (opts.summary) {
    const lines = [`### red-first-gate: ${headline.replace(/^RED-FIRST( PLAN)?: /, "")}`, ""];
    if (result.mode === "plan" && result.verdict === "run") {
      lines.push(`New or changed test files: ${[...(result.newTests ?? []), ...(result.excluded ?? [])].map((f) => `\`${cell(f)}\``).join(", ")}`, "");
    }
    if (result.files?.length) {
      lines.push("| test file | runner | proven |", "| --- | --- | --- |");
      for (const f of result.files) lines.push(`| \`${cell(f.file)}\` | ${f.runner} | ${f.proven ? "yes" : "no"} |`);
      lines.push("");
    }
    for (const r of result.reasons ?? []) lines.push(`- \`${r.code}\` ${cell(r.phase ?? "")} ${r.file ? `\`${cell(r.file)}\`` : ""}: ${cell(r.detail)}`);
    for (const r of notes) lines.push(`- note \`${r.code}\` \`${cell(r.file)}\`: ${cell(r.detail)}`);
    appendFileSync(opts.summary, `${lines.join("\n")}\n`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const FLAGS = {
  "--repo": "repo",
  "--base": "base",
  "--head": "head",
  "--exclude": "exclude",
  "--test-support": "testSupport",
  "--job-started": "jobStarted",
  "--job-minutes": "jobMinutes",
  "--install": "install",
  "--vitest": "vitest",
  "--timeout-seconds": "timeoutSeconds",
  "--work": "work",
  "--verdict": "verdict",
  "--summary": "summary",
  "--github-output": "githubOutput",
};

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== "plan" && mode !== "run") throw new GateError(`unknown mode: ${mode ?? "(none)"}`);
  const opts = {
    mode,
    repo: process.cwd(),
    base: undefined,
    head: undefined,
    exclude: "",
    testSupport: "",
    install: "",
    vitest: DEFAULT_VITEST,
    timeoutSeconds: "1200",
    jobStarted: "",
    jobMinutes: "",
    work: "",
    verdict: "",
    summary: "",
    githubOutput: "",
  };
  for (let i = 0; i < rest.length; i += 1) {
    const key = FLAGS[rest[i]];
    if (!key || i + 1 >= rest.length) throw new GateError(`unknown or incomplete argument: ${rest[i]}`);
    opts[key] = rest[i + 1];
    i += 1;
  }
  if (!String(opts.vitest).trim()) opts.vitest = DEFAULT_VITEST;
  const seconds = Number(opts.timeoutSeconds);
  // At most a day: a larger value would overflow the timer and fire at once.
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 86400) throw new GateError("--timeout-seconds must be a whole number from 1 to 86400");
  opts.timeoutSeconds = seconds;
  // The job's budget: both or neither. The deadline keeps JOB_RESERVE_SECONDS
  // back for the verdict and the removal of the trees.
  opts.deadlineMs = null;
  if (opts.jobStarted !== "" || opts.jobMinutes !== "") {
    const started = Number(opts.jobStarted);
    const minutes = Number(opts.jobMinutes);
    if (opts.jobStarted === "" || !Number.isInteger(started) || started <= 0) throw new GateError("--job-started must be the job's start as epoch seconds (with --job-minutes)");
    if (opts.jobMinutes === "" || !Number.isFinite(minutes) || minutes <= 0) throw new GateError("--job-minutes must be a positive number (with --job-started)");
    opts.deadlineMs = (started + minutes * 60 - JOB_RESERVE_SECONDS) * 1000;
  }
  opts.repo = resolve(opts.repo);
  return opts;
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`red-first-gate: ${error.message}\n${USAGE}`);
    return 2;
  }
  try {
    checkPlatform();
    if (opts.mode === "plan") {
      emit({ mode: "plan", ...planRange(opts) }, opts);
      return 0;
    }
    const result = await runGate(opts);
    emit(result, opts);
    if (result.verdict === "PASS") return 0;
    return result.verdict === "SKIP" ? 3 : 1;
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(`red-first-gate: ${error.message}`);
    if (process.env.GITHUB_ACTIONS === "true") console.log(`::error title=red-first ERROR::${escapeData(error.message)}`);
    return 2;
  }
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);
  process.exitCode = await main(process.argv.slice(2));
}
