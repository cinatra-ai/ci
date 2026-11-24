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
//      least one test for the right reason before the fix (an assertion, the
//      text of a `red-first-expect:` marker in the file, or a failure that names
//      an export or a module the fix side adds and the test file itself
//      imports from that module), and with the fix loads, passes, and passes
//      every occurrence of every test that failed before.
// A test file with no failing test before the fix makes no red-first claim in
// three cases only, each a note (not proven here), never a proof:
//   - COLLATERAL: a changed file whose earlier version, run in the tree WITH
//     the fix, reports the same tests and fails (the fix breaks it, the edit
//     keeps it working), and whose edit touches no test declaration and no
//     assertion line;
//   - PIN: every test the pull request adds to the file is named by its own
//     `red-first-pin:` marker that the pull request adds, names one test
//     occurrence, and passes before the fix and with it; in a changed file the
//     edit only adds lines and the earlier version passes with the fix;
//   - REMOVAL: a changed file whose edit only deletes code (whole tests,
//     statements, list elements or JSX attributes; no line of code added or
//     changed, the retained code parsed alike, no pragma line changed, no
//     assertion of a kept test touched, no kept test lost), where every deleted part
//     names an identifier or a string that the pull request removes from its
//     product scripts, and whose tests pass before the fix and with it; it
//     stands only beside a proven file of the same pull request.
// A run is a PASS only with at least one proven file; with notes only it is
// RED (NOTHING-PROVEN): a green job always has a proven file.
// Anything it cannot read or prove ends RED with a named reason. A pull request
// without a new test, with no change besides tests, or whose new tests all
// match --exclude, is a SKIP (exit 3 in `run`), never a pass. New tests that
// match --exclude beside other new tests are listed as notes (not proven here).
// Every child runs in its own process group, which is killed when the child
// exits or times out; the trees and reports are removed at the end of a run.
//
// Usage:
//   red-first-gate.mjs plan --base <sha> --head <sha> [--repo <dir>] [--exclude <globs>]
//                           [--test-support <globs>] [--job-minutes <n>] [--verdict <file>]
//                           [--github-output <file>] [--summary <file>]
//   red-first-gate.mjs run  --base <sha> --head <sha> --work <empty dir> [--repo <dir>]
//                           [--install <cmd>] [--vitest <cmd>] [--exclude <globs>]
//                           [--test-support <globs>] [--timeout-seconds <n>]
//                           [--job-started <epoch s> --job-minutes <n>]
//                           [--verdict <file>] [--summary <file>]
// Exit codes: plan 0 (decided: run or skip); run 0 PASS, 1 RED,
// 3 SKIP, 130/143 stopped by SIGINT/SIGTERM; 2 usage or internal error (both
// modes).
//
// Node built-ins, git and bash; Linux or macOS.
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
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
// The key bare, quoted ("setupFiles", 'setupFiles', `setupFiles`) or computed
// (["setupFiles"]), as JavaScript, TypeScript and JSON configs write it.
const SETUP_KEY_RE = /(\[\s*)?(["'`]?)\b(?:setupFiles|globalSetup)\2\s*(?:\]\s*)?:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|`[^`$]*`)/g;
const STRING_RE = /"([^"]*)"|'([^']*)'|`([^`$]*)`/g;
const SCRIPT_EXT_RE = /\.[cm]?[jt]sx?$/;
// Time kept back from the job's limit for the verdict, the summary and the
// removal of the trees, so the gate names TIMEOUT before GitHub stops the job.
export const JOB_RESERVE_SECONDS = 120;
// The job limits the gate accepts: at least the reserve plus a minute of work,
// at most the longest job GitHub runs (5 days on a self-hosted runner).
export const JOB_MINUTES_MIN = 3;
export const JOB_MINUTES_MAX = 7200;
// After a kill, the time a child has to report its exit before the gate stops
// waiting for it (a process stuck in the kernel may never report one).
const KILL_GRACE_MS = 5000;
// After a stop signal, the time the run has to reach its own cleanup before
// the gate cleans up and leaves (GitHub sends SIGTERM 7.5 s after SIGINT).
const STOP_GRACE_MS = 5000;
// Each git call of the cleanup, which runs inside the reserve.
const CLEANUP_GIT_MS = 30_000;
const NODE_TEST_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']node:test["']/;
const MARKER_RE = /red-first-expect:[ \t]*(.*?)[ \t]*(?:\*\/[ \t]*)?$/;
const PIN_RE = /red-first-pin:[ \t]*(.*?)[ \t]*(?:\*\/[ \t]*)?$/;
const ASSERTION_TEXT_RE = /^(?:AssertionError|JestAssertionError)\b/;
// A failure before the fix that names what the fix adds. A call of something
// that is not there yet: the name is the last identifier of the callee
// (`calc.sum`, `(0 , __vite_ssr_import_1__.sum)`). A named import that is not
// there yet. A module that is not there yet, as node and vite word it.
const NOT_CALLABLE_RE = /^TypeError: (.+?) is not a (?:function|constructor)(?![A-Za-z])/;
const TRAILING_NAME_RE = /([A-Za-z_$][\w$]*)[\s)]*$/;
const CALLEE_MAX = 300;
// A runner's error text only: at the start of the text or right after an
// error name (`Error: `, `Error [ERR_MODULE_NOT_FOUND]: `, `SyntaxError: `),
// never inside other words (a message that prints such a text).
const AT_ERROR = String.raw`(?:^|(?<=(?:^|[\s>])[A-Za-z]*Error(?: \[[A-Z_]+\])?: ))`;
const NO_EXPORT_RE = new RegExp(`${AT_ERROR}The requested module ['"][^'"]+['"] does not provide an export named ['"]([A-Za-z_$][\\w$]*)['"]`);
// kind "vite": a path from the vite root (`/src/x.ts`); other absolute paths
// count only inside the tree.
const MISSING_MODULE_RES = [
  { re: new RegExp(`${AT_ERROR}Cannot find (?:module|package) ['"]([^'"]+)['"](?: imported from ['"]?([^\\s'"]+))?`, "g"), kind: "node" },
  { re: new RegExp(`${AT_ERROR}Failed to resolve import ['"]([^'"]+)['"] from ['"]([^'"]+)['"]`, "g"), kind: "node" },
  { re: new RegExp(`${AT_ERROR}Failed to load url (\\S+) \\(resolved id: [^)]*\\)(?: in (\\S+?)\\.? Does)?`, "g"), kind: "vite" },
];
// A path that is test code by its place or name, though the range lists it on
// the fix side: never evidence of what the fix adds. A declaration file holds
// types, never a value.
const TEST_PLACE_RE = /(^|\/)(?:tests?|__tests__|specs?|__mocks__|mocks?|fixtures?|__fixtures__|test-?utils|testing|e2e)\//i;
const TEST_NAME_RE = /(?:^|[-_.])(?:tests?|specs?|mocks?|fixtures?|stubs?|fakes?)(?:[-_.]|$)/i;
const DECLARATION_FILE_RE = /\.d\.[cm]?ts$/;
// Exports a script declares on one line: `export function f`, `export class
// C`, `export const c`, `export { a, b as c }`, `exports.f =`. Types, `export
// declare` (no value) and `export default` (no name of its own) are not read.
const EXPORT_DECL_RE = /^\s*export\s+(?:async\s+)?(?:function\s*\*?\s*|(?:abstract\s+)?class\s+|(?:const|let|var|enum)\s+)([A-Za-z_$][\w$]*)/;
const EXPORT_LIST_RE = /^\s*export\s*\{([^}]*)\}/;
const CJS_EXPORT_RE = /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/;
const NAME_RE = /^[A-Za-z_$][\w$]*$/;
// A line that declares a test or states an assertion: it/test/describe (with
// .each, .skip, ...), expect..., assert..., .should, .rejects, .resolves and
// the matcher calls (.toBe(, .not.toEqual(, ...). Read on the changed lines
// of a test file; a method call such as `re.test(` is not a declaration.
// ASSERTION_RE is its assertion part, the one list of assertion styles the
// gate knows (the removal reading uses it too).
const TEST_DECLARATION_SRC = /(?<![.\w$])(?:it|test|describe|suite|specify|bench)\s*(?:\.\s*[A-Za-z]+\s*)*(?:\(|`)/.source;
const ASSERTION_SRC = /(?<![.\w$])(?:expect|assert)[A-Za-z]*\s*[.(]|\.\s*(?:should|rejects|resolves)\b|\.\s*(?:not\s*\.\s*)?to(?:Be|Equal|StrictEqual|Have|Contain|Match|Throw|Satisfy|Include)[A-Za-z]*\s*\(/.source;
const TEST_LINE_RE = new RegExp(`${TEST_DECLARATION_SRC}|${ASSERTION_SRC}`);
const ASSERTION_RE = new RegExp(ASSERTION_SRC);
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
  red-first-gate.mjs plan --base <sha> --head <sha> [--repo <dir>] [--exclude <globs>] [--test-support <globs>] [--job-minutes <n>] [--verdict <file>] [--github-output <file>] [--summary <file>]
  red-first-gate.mjs run  --base <sha> --head <sha> --work <empty dir> [--repo <dir>] [--install <cmd>] [--vitest <cmd>] [--exclude <globs>] [--test-support <globs>] [--timeout-seconds <n>] [--job-started <epoch s> --job-minutes <n>] [--verdict <file>] [--summary <file>]`;

export class GateError extends Error {}
// A step the job's time budget cut: the run ends RED with TIMEOUT.
export class BudgetError extends GateError {}

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

// Every line the gate writes to stdout or stderr goes through this: a CR or LF
// inside a path or a message (paths come from the pull request) is shown as
// \r or \n, so it can never start a new line that the runner reads as a
// workflow command.
export function oneLine(text) {
  return String(text ?? "").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function say(text) {
  console.log(oneLine(text));
}

function sayErr(text) {
  console.error(oneLine(text));
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

// --exclude and --test-support: path patterns, separated by commas or line
// breaks. A pattern matches the whole repository path: `*` is any run of
// characters but `/`, `?` one character but `/`, `**` any run including `/`
// (`**/` also matches no folder, but only at the start of a folder name, so
// `**/calc.test.mjs` never matches `src/mycalc.test.mjs`); every other
// character matches itself. No regular expression is ever built from these
// inputs. The matcher is a table filled without recursion, in time and memory
// proportional to pattern times path. Characters of regular-expression or
// shell-glob syntax ([ ] { } ( ) ! ^ $ + | \) are refused, and so is a pattern
// ending in "/" (it can never match a file). `?` stands for one refused
// character (for example `app/?marketing?/**` for a folder `(marketing)`).
const PATTERN_REFUSED = new Set(["[", "]", "{", "}", "(", ")", "!", "^", "$", "+", "|", "\\"]);
const PATTERN_MAX = 1024;

export function globMatch(glob, path) {
  const P = glob.length;
  const S = path.length;
  const width = S + 1;
  // ok[pi * width + si]: glob from pi matches path from si. Rows are filled
  // from the end of the glob, each row from the end of the path, so every
  // cell reads only cells already filled.
  const ok = new Uint8Array((P + 1) * width);
  ok[P * width + S] = 1;
  for (let pi = P - 1; pi >= 0; pi -= 1) {
    const row = pi * width;
    const globstar = glob[pi] === "*" && glob[pi + 1] === "*";
    for (let si = S; si >= 0; si -= 1) {
      let v = 0;
      if (globstar) {
        const after = pi + 2;
        // the empty `**/`: only where a folder name starts
        if (glob[after] === "/" && (si === 0 || path[si - 1] === "/") && ok[(after + 1) * width + si]) v = 1;
        else if (ok[after * width + si]) v = 1;
        else if (si < S && ok[row + si + 1]) v = 1;
      } else if (glob[pi] === "*") {
        if (ok[(pi + 1) * width + si]) v = 1;
        else if (si < S && path[si] !== "/" && ok[row + si + 1]) v = 1;
      } else if (glob[pi] === "?") {
        if (si < S && path[si] !== "/" && ok[(pi + 1) * width + si + 1]) v = 1;
      } else if (si < S && path[si] === glob[pi] && ok[(pi + 1) * width + si + 1]) v = 1;
      ok[row + si] = v;
    }
  }
  return ok[0] === 1;
}

export function pathMatcher(flag, source) {
  if (!source) return null;
  const globs = String(source).split(/[,\r\n]/).map((g) => g.trim()).filter(Boolean);
  for (const glob of globs) {
    const bad = [...glob].find((ch) => PATTERN_REFUSED.has(ch));
    let why = null;
    if (bad !== undefined) why = `"${bad}" is refused (write ? for it)`;
    else if (glob.startsWith("/")) why = "a leading / is refused";
    else if (glob.endsWith("/")) why = "a pattern ending in / never matches a file (write folder/**)";
    else if (glob.length > PATTERN_MAX) why = `a pattern is at most ${PATTERN_MAX} characters`;
    if (why) throw new GateError(`${flag}: ${JSON.stringify(glob.slice(0, 120))} is not a path pattern (use *, ** and ?; ${why})`);
  }
  return globs.length ? (path) => globs.some((glob) => globMatch(glob, path)) : null;
}

// --vitest: the command split into words (spaces separate words; single or
// double quotes group them; no escapes, no expansion). It runs without a shell.
export function splitCommand(text) {
  const words = [];
  let word = "";
  let started = false;
  let quote = null;
  for (const ch of String(text ?? "")) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote) throw new GateError("--vitest has a quote that is not closed");
  if (started) words.push(word);
  return words;
}

// The test-side test of one path: the default names, the caller's
// --test-support pattern and the setup files a vitest config names.
export function testSideOf({ testSupport = "", setupPaths = [] } = {}) {
  const supportMatch = pathMatcher("--test-support", testSupport);
  const setup = new Set(setupPaths);
  return (path) => isTestSide(path) || setup.has(path) || setup.has(path.replace(SCRIPT_EXT_RE, "")) || Boolean(supportMatch?.(path));
}

// The setup files a vitest config names in setupFiles or globalSetup as string
// literals, as repository paths (relative to the config's folder). A path
// built at run time is not seen: name it in --test-support.
export function setupPathsFromConfig(configPath, source) {
  const dir = posix.dirname(configPath);
  const paths = [];
  for (const match of String(source).matchAll(SETUP_KEY_RE)) {
    // A computed key needs its closing bracket, a quoted key its closing quote.
    if (match[1] && !match[2]) continue;
    for (const lit of match[3].matchAll(STRING_RE)) {
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
  const excludeMatch = pathMatcher("--exclude", exclude);
  const onTestSide = testSideOf({ testSupport, setupPaths });
  const newTests = [];
  const excluded = [];
  const fixSide = [];
  const testSide = [];
  for (const { status, path } of entries) {
    if (onTestSide(path)) {
      testSide.push({ status, path });
      // A test-named file inside a fixtures folder is test data, not a test.
      if (isTestFile(path) && status !== "D" && !FIXTURE_DIR_RE.test(path)) (excludeMatch?.(path) ? excluded : newTests).push(path);
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

// `red-first-pin: <text>` lines: each names, by a part of its full name, a test
// that passes before the fix on purpose (it pins behaviour the fix keeps).
export function readPins(source) {
  const pins = [];
  for (const line of String(source).split(/\r?\n/)) {
    const match = PIN_RE.exec(line);
    // A pin that is empty once normalized would name every test.
    if (match && normalizeText(match[1])) pins.push(match[1].trim());
  }
  return pins;
}

// ---------------------------------------------------------------------------
// What the fix adds, and what an edit of a test file touches
// ---------------------------------------------------------------------------

// The name a `TypeError: ... is not a function` (or constructor) text calls.
export function missingCallable(text) {
  const match = NOT_CALLABLE_RE.exec(normalizeText(text));
  // A callee longer than any real name is not read.
  if (!match || match[1].length > CALLEE_MAX) return null;
  const name = TRAILING_NAME_RE.exec(match[1])?.[1] ?? null;
  return name && name !== "default" ? name : null;
}

// The modules a text reports as not found: [{ spec, importer, kind }].
export function missingModules(text) {
  const found = [];
  const t = normalizeText(text);
  for (const { re, kind } of MISSING_MODULE_RES) {
    for (const match of t.matchAll(re)) found.push({ spec: match[1], importer: match[2] ?? null, kind });
  }
  return found;
}

// The scripts' exports and imports are read with the TypeScript parser (the
// `typescript` package of this repository's lockfile, installed beside the
// gate), never with a hand scanner: a regular expression, a division, a
// template, JSX text and a comment are told apart by the grammar.
let tsParser;
function typescript() {
  if (tsParser === undefined) {
    try {
      tsParser = createRequire(import.meta.url)("typescript");
    } catch {
      throw new Error("the TypeScript parser is not installed beside the gate: run `npm ci` in the gate's checkout");
    }
  }
  return tsParser;
}

// The script kind of a path (a path-less source reads as JavaScript, which
// also parses JSX).
function scriptKind(ts, path) {
  if (/\.d\.[cm]?ts$/.test(path) || /\.[cm]?ts$/.test(path)) return ts.ScriptKind.TS;
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

// The literal tokens of a parsed file (strings, templates, regular
// expressions, JSX text): [start, end) offsets.
function literalRanges(ts, file) {
  const ranges = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isRegularExpressionLiteral(node) || ts.isJsxText(node)) ranges.push([node.getStart(file), node.end]);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return ranges;
}

// The offsets of the HTML-like comments of a text (`<!--` anywhere, `-->` at
// a line start after spaces or tabs only), which a CommonJS script may hold
// and the parser reads as code. A plain scan, not a pattern over the markup.
const LINE_BREAKS = "\n\r\u2028\u2029";
function htmlCommentOffsets(text) {
  const at = [];
  for (let i = text.indexOf("<!--"); i !== -1; i = text.indexOf("<!--", i + 4)) at.push(i);
  for (let i = text.indexOf("-->"); i !== -1; i = text.indexOf("-->", i + 3)) {
    let j = i - 1;
    while (j >= 0 && (text[j] === " " || text[j] === "\t")) j -= 1;
    if (j < 0 || LINE_BREAKS.includes(text[j])) at.push(i);
  }
  return at;
}

// The parsed source, and whether the parser may not read it as JavaScript
// does: a syntax error, or an HTML-like comment outside a literal.
function parse(source, path = "") {
  const ts = typescript();
  const text = String(source);
  const file = ts.createSourceFile(path || "source.js", text, ts.ScriptTarget.Latest, true, scriptKind(ts, path));
  let unsure = file.parseDiagnostics.length > 0;
  const comments = unsure ? [] : htmlCommentOffsets(text);
  if (comments.length) {
    const ranges = literalRanges(ts, file);
    if (comments.some((at) => !ranges.some(([start, end]) => at >= start && at < end))) unsure = true;
  }
  return { ts, file, unsure };
}

const hasModifier = (ts, node, kind) => (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((m) => m.kind === kind);

// The names a binding (a name or a destructuring pattern) declares.
function bindingNames(ts, name, out) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(ts, element.name, out);
}

// The CommonJS reading is deny-by-default: every reference to `exports`,
// `module`, `__exportStar` or `__export`, every top-level `this` and every
// `export =` makes the script unsure, unless the reference is part of one of
// the recognised top-level statements below, whose whole shape is read.
const CJS_WATCHED = new Set(["exports", "module", "__exportStar", "__export"]);

// `exports` or `module.exports`: the identifier nodes it references, or null.
function exportsObject(ts, node) {
  if (ts.isIdentifier(node) && node.text === "exports") return [node];
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "module" && node.name.text === "exports") return [node.expression];
  return null;
}

// A string or number literal as a name (an identifier too, for an object
// literal's key); else null.
function keyName(ts, key, identifier = false) {
  return key && ((identifier && ts.isIdentifier(key)) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) ? key.text : null;
}

// `exports.<n>`, `exports["<n>"]`, `module.exports.<n>`, `module.exports["<n>"]`:
// { name, refs }, or null.
function exportsTarget(ts, node) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null;
  const refs = exportsObject(ts, node.expression);
  if (!refs) return null;
  const name = ts.isPropertyAccessExpression(node) ? node.name.text : keyName(ts, node.argumentExpression);
  return name === null || name === "__proto__" ? null : { name, refs };
}

// The recognised CommonJS statements of a script's top level, each read as a
// whole: `T = value` and chains `T1 = T2 = value` with T an exports target,
// `module.exports = { ... }` (an object literal, also in parentheses, with plain keys: names,
// strings, numbers, shorthand, methods, accessors; no spread, no computed
// key) and `Object.defineProperty(exports or module.exports, "<n>", ...)`.
// Returns the names and the identifier nodes these statements account for.
function commonJsStatements(ts, file) {
  const names = [];
  const accounted = new Set();
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const whole = exportsObject(ts, expression.left);
      let value = expression.right;
      while (ts.isParenthesizedExpression(value)) value = value.expression;
      if (whole && !ts.isIdentifier(expression.left) && ts.isObjectLiteralExpression(value)) {
        const keys = value.properties.map((p) => (ts.isShorthandPropertyAssignment(p) ? p.name.text : ts.isSpreadAssignment(p) ? null : keyName(ts, p.name, true)));
        if (keys.every((k) => k !== null && k !== "__proto__")) {
          names.push(...keys);
          for (const ref of whole) accounted.add(ref);
        }
        continue;
      }
      let node = expression;
      while (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = exportsTarget(ts, node.left);
        if (!target) break;
        names.push(target.name);
        for (const ref of target.refs) accounted.add(ref);
        node = node.right;
      }
    } else if (
      ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && ts.isIdentifier(expression.expression.expression)
      && expression.expression.expression.text === "Object" && expression.expression.name.text === "defineProperty" && expression.arguments.length >= 2
    ) {
      const refs = exportsObject(ts, expression.arguments[0]);
      const name = keyName(ts, expression.arguments[1]);
      if (refs && name !== null && name !== "__proto__") {
        names.push(name);
        for (const ref of refs) accounted.add(ref);
      }
    }
  }
  return { names, accounted };
}

// An identifier that names a property, a member or a label rather than
// referencing a binding.
function notAReference(ts, node) {
  const parent = node.parent;
  if (!parent) return false;
  if ((ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) && (parent.name === node || parent.right === node)) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent) || ts.isJsxAttribute(parent)) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  return ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent);
}

// Whether a script holds a CommonJS or module-object use the reading does not
// account for (see CJS_WATCHED).
function unreadCommonJs(ts, file, accounted, watched = CJS_WATCHED) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && watched.has(node.text) && !accounted.has(node) && !notAReference(ts, node)) found = true;
    else if (node.kind === ts.SyntaxKind.ThisKeyword && moduleThis(ts, node)) found = true;
    else if (ts.isExportAssignment(node) && node.isExportEquals) found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// Whether a `this` is the module's: no enclosing non-arrow function and no
// enclosing class, except the member or class whose computed name, decorator
// or heritage clause holds it (those are evaluated outside that member's or
// class's body: `class A { get [this.k]() {} }`, `class A extends this.B {}`,
// `({ set [this.k](v) {} })`).
function moduleThis(ts, node) {
  const outside = new Set();
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isComputedPropertyName(p) || ts.isDecorator(p) || ts.isHeritageClause(p)) {
      let owner = p.parent;
      if (ts.isParameter(owner)) owner = owner.parent;
      outside.add(owner);
      if (owner.parent && ts.isClassLike(owner.parent)) outside.add(owner.parent);
    }
    if (outside.has(p)) continue;
    if ((ts.isFunctionLike(p) && !ts.isArrowFunction(p)) || ts.isClassLike(p)) return false;
  }
  return true;
}

// The value exports of a whole script by the parser: an exported function
// with a body, class, variable, enum, namespace or `import x =` declaration
// (not `declare`, not a type), an `export { ... }` list (not `type` names,
// not `default`), `export * as`, and the recognised CommonJS statements;
// unsure when the parser reports a syntax error or an HTML-like comment, or
// the script uses `exports`, `module`, a top-level `this`, an export helper
// or `export =` in any other way.
export function readExports(source, path = "") {
  const { ts, file, unsure: parseUnsure } = parse(source, path);
  const names = moduleExports(ts, file);
  const cjs = commonJsStatements(ts, file);
  for (const name of cjs.names) names.add(name);
  return { names, unsure: parseUnsure || unreadCommonJs(ts, file, cjs.accounted) };
}

// The ES module export names of a parsed script (see readExports).
function moduleExports(ts, file) {
  const names = new Set();
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) if (!element.isTypeOnly && element.name.text !== "default") names.add(element.name.text);
      } else if (clause && ts.isNamespaceExport(clause)) names.add(clause.name.text);
      continue;
    }
    if (!hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword) || hasModifier(ts, statement, ts.SyntaxKind.DeclareKeyword) || hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword)) continue;
    // a function needs a body (a signature alone is no value); a namespace or module of a plain name and
    // `export import x = ...` are values
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) names.add(statement.name.text);
    else if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) names.add(statement.name.text);
    else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) names.add(statement.name.text);
    else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) names.add(statement.name.text);
    else if (ts.isVariableStatement(statement)) {
      const list = [];
      for (const declaration of statement.declarationList.declarations) bindingNames(ts, declaration.name, list);
      for (const name of list) names.add(name);
    }
  }
  return names;
}

// At the merge base only an ES module is read, because CommonJS exports are
// built at run time and no static reading of them is complete. A script there
// is unsure (it may export any name) unless it is a pure ES module: not a
// `.cjs` or `.cts` file, not under a package.json whose type is "commonjs"
// (packageType: the nearest one's type, "" when none, null when it does not
// parse), at least one static `import` or `export` statement, no `export =`,
// no `import x = require(...)`, no `export * from` (its names are another
// file's), and no reference at all to `exports`, `module`, `require`,
// `arguments`, `eval`, an export helper or a module-level `this`. A
// transpiler or a test runner (TypeScript to CommonJS, vitest) can still let
// an ES module write its own export object, so the reading allows only a
// module without a namespace import (`import * as`), a dynamic `import()`,
// an import from `node:module` or `module`, and any identifier that starts
// with `__vi` (`__vite_ssr_exports__`, `__vi_import_0__`). The reading is
// static; a file that sets its exports through runtime tricks is outside
// it. An empty script exports nothing.
const BASE_WATCHED = new Set([...CJS_WATCHED, "require", "arguments", "eval"]);
export function readBaseExports(source, path = "", packageType = "") {
  const { ts, file, unsure } = parse(source, path);
  const none = (u) => ({ names: new Set(), unsure: u });
  if (unsure) return none(true);
  if (!file.statements.length) return none(false);
  if (/\.c[jt]s$/.test(path) || (!/\.m[jt]s$/.test(path) && (packageType === null || packageType === "commonjs"))) return none(true);
  let isModule = false;
  for (const statement of file.statements) {
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) return none(true);
    if (ts.isExportAssignment(statement) && statement.isExportEquals) return none(true);
    if (ts.isExportDeclaration(statement) && !statement.exportClause && !statement.isTypeOnly) return none(true);
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement) || hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)) isModule = true;
  }
  if (!isModule || unreadCommonJs(ts, file, new Set(), BASE_WATCHED) || runtimeExportRoad(ts, file)) return none(true);
  return { names: moduleExports(ts, file), unsure: false };
}

// Whether an ES module holds one of the roads by which a transpiler or a test
// runner lets it write its own export object (see readBaseExports).
const MODULE_SPECIFIERS = new Set(["node:module", "module"]);
function runtimeExportRoad(ts, file) {
  for (const statement of file.statements) {
    const spec = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier;
    if (spec && ts.isStringLiteralLike(spec) && MODULE_SPECIFIERS.has(spec.text)) return true;
    const bindings = ts.isImportDeclaration(statement) && statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) return true;
  }
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found = true;
    else if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && /^#?__vi/.test(node.text)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// The type field of the package.json nearest to a path in a version: "" when
// there is none or it names no type, null when it does not parse.
function nearestPackageType(read, path) {
  const parts = path.split("/").slice(0, -1);
  for (let n = parts.length; n >= 0; n -= 1) {
    const text = read([...parts.slice(0, n), "package.json"].join("/"));
    if (text === null || text === undefined) continue;
    try {
      const type = JSON.parse(text)?.type;
      return typeof type === "string" ? type : "";
    } catch {
      return null;
    }
  }
  return "";
}

// The value exports of a whole script; none when the parser reports a syntax
// error (fail closed: such a file is never evidence).
export function exportsOf(source, path = "") {
  const read = readExports(source, path);
  return read.unsure ? new Set() : read.names;
}

// Per fix-side evidence script, the names its whole head version exports that
// no fix-side script exported at the merge base (so a moved export is not
// new): Map(path -> names). base(path) and head(path) give a version's text,
// or null. When any fix-side script of the merge base is not read cleanly as
// an ES module (readBaseExports), nothing is fresh (that script may export
// any name).
export function freshExports(fixSide, base, head) {
  const byFile = new Map();
  const scripts = fixSide.filter((path) => SCRIPT_EXT_RE.test(path));
  const before = new Set();
  for (const path of scripts) {
    const text = base(path);
    if (text === null || text === undefined) continue;
    const read = readBaseExports(text, path, /\.m[jt]s$/.test(path) ? "" : nearestPackageType(base, path));
    if (read.unsure) return byFile;
    for (const name of read.names) before.add(name);
  }
  for (const path of scripts.filter(evidencePath)) {
    const text = head(path);
    if (text === null) continue;
    const fresh = new Set([...exportsOf(text, path)].filter((name) => !before.has(name)));
    if (fresh.size) byFile.set(path, fresh);
  }
  return byFile;
}

// The static imports of a test file: [{ spec, names, whole }]. names: the
// exported names it imports by name; whole: it binds the whole module (a
// namespace, a default import, `require` of the module), so any export may be
// called through it. `import type` binds no value and is not read. A file the
// parser does not read cleanly imports nothing here (no evidence).
export function importsOf(source, path = "") {
  const { ts, file, unsure } = parse(source, path);
  if (unsure) return [];
  const found = [];
  const requireOf = (node) =>
    node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : null;
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    const names = new Set();
    let whole = Boolean(clause?.name);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) whole = true;
    else if (bindings) for (const element of bindings.elements) if (!element.isTypeOnly) names.add((element.propertyName ?? element.name).text);
    found.push({ spec: statement.moduleSpecifier.text, names, whole });
  }
  const visit = (node) => {
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      found.push({ spec: node.moduleReference.expression.text, names: new Set(), whole: true });
    } else if (ts.isVariableDeclaration(node)) {
      const spec = requireOf(node.initializer);
      if (spec !== null && ts.isIdentifier(node.name)) found.push({ spec, names: new Set(), whole: true });
      else if (spec !== null && ts.isObjectBindingPattern(node.name)) {
        const names = new Set();
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key)) names.add(key.text);
        }
        found.push({ spec, names, whole: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// A relative import of `file`, as a repository path, or null.
function importPath(spec, file) {
  if (!(spec.startsWith("./") || spec.startsWith("../"))) return null;
  const n = posix.normalize(posix.join(posix.dirname(file), spec));
  return n && n !== "." && n !== ".." && !n.startsWith("../") && !n.startsWith("/") ? n : null;
}

// A fix-side path that can be evidence of what the fix adds: a script, not a
// declaration file, not test code by its place or name.
export function evidencePath(path) {
  return SCRIPT_EXT_RE.test(path) && !DECLARATION_FILE_RE.test(path) && !TEST_PLACE_RE.test(path) && !TEST_NAME_RE.test(posix.basename(path).replace(SCRIPT_EXT_RE, ""));
}

// The names the added lines of one script export, less the names its removed
// lines exported (a changed line is not a new export).
export function exportNames(lines) {
  const names = [];
  for (const line of lines) {
    const decl = EXPORT_DECL_RE.exec(line)?.[1] ?? CJS_EXPORT_RE.exec(line)?.[1];
    if (decl) names.push(decl);
    const list = EXPORT_LIST_RE.exec(line)?.[1];
    if (list === undefined) continue;
    for (const part of list.split(",")) {
      const item = part.trim();
      if (!item || /^type\s/.test(item)) continue;
      const name = item.split(/\s+as\s+/).pop().trim();
      if (NAME_RE.test(name) && name !== "default") names.push(name);
    }
  }
  return names;
}

function isCommentLine(line) {
  const t = line.trim();
  if (t.startsWith("//")) return true;
  if (!(t.startsWith("/*") || t.startsWith("*"))) return false;
  const end = t.indexOf("*/");
  return end < 0 || !t.slice(end + 2).trim();
}

// The first changed line (added or removed, comments apart) of a test file's
// edit that declares a test or states an assertion, or null.
export function changedTestLine(lines) {
  return lines.find((line) => !isCommentLine(line) && TEST_LINE_RE.test(line)) ?? null;
}

// A unified diff with no context lines, per path: { added: [...], removed:
// [...] }. A path git writes quoted (unusual characters) is left out: what
// is not read here is never evidence.
export function parseRangeDiff(text) {
  const files = new Map();
  let current = null;
  let header = false;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      current = null;
    } else if (header) {
      if (line.startsWith("+++ b/")) {
        current = { added: [], removed: [] };
        files.set(line.slice(6).replace(/\t$/, ""), current);
      } else if (line.startsWith("@@")) header = false;
    } else if (current) {
      if (line.startsWith("+")) current.added.push(line.slice(1));
      else if (line.startsWith("-")) current.removed.push(line.slice(1));
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Removal edits: a changed test file whose edit only deletes what the pull
// request removes from the product code
// ---------------------------------------------------------------------------

// A unified diff with no context lines, per path, with its hunks: { removed:
// [...], hunks: [{ oldStart, oldCount, newStart, newCount }] }. A deleted
// file (`+++ /dev/null`) is listed under its old path. A path git writes
// quoted is left out (not read here, so never evidence).
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
export function parseDiffHunks(text) {
  const files = new Map();
  let current = null;
  let header = false;
  let oldPath = null;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      current = null;
      oldPath = null;
    } else if (header && line.startsWith("--- ")) {
      oldPath = line.startsWith("--- a/") ? line.slice(6).replace(/\t$/, "") : null;
    } else if (header && line.startsWith("+++ ")) {
      const path = line.startsWith("+++ b/") ? line.slice(6).replace(/\t$/, "") : line.startsWith("+++ /dev/null") ? oldPath : null;
      current = path === null ? null : { removed: [], hunks: [] };
      if (current) files.set(path, current);
    } else if (line.startsWith("@@")) {
      header = false;
      const m = HUNK_RE.exec(line);
      if (current && m) current.hunks.push({ oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) });
      else if (current) current.unreadable = true;
    } else if (current && !header && line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return files;
}

// The callee names of a test and a suite. An assertion is read with
// ASSERTION_RE (the gate's one list of assertion styles).
const TEST_CALLEES = new Set(["it", "test", "specify", "bench"]);
const SUITE_CALLEES = new Set(["describe", "suite"]);
// Comment text a runner or a transform reads: `@vitest-environment`, `@jsx`,
// a red-first marker, a `/// <reference>` line. A removal edit keeps every
// comment line that holds one exactly as it was, in the same order.
const PRAGMA_RE = /@[A-Za-z][\w-]*|red-first-(?:expect|pin):|\/\/\/[ \t]*<[A-Za-z]+/;
// The largest hunk the token alignment reads (old tokens times new tokens).
const ALIGN_MAX_CELLS = 4_000_000;

// The code tokens of a parsed script, comments and blanks apart: [{ text,
// start, end, line, node, chain }] (chain: the token's ancestors, outermost
// first), and the text between them (the comments). JSX text counts with its
// blanks collapsed; JSX text of blanks only is not a token.
function codeTokens(ts, file) {
  const tokens = [];
  const visit = (node, chain) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = node.getChildren(file);
    if (kids.length === 0) {
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
      const start = node.getStart(file);
      let text = file.text.slice(start, node.end);
      if (node.kind === ts.SyntaxKind.JsxText) text = text.replace(/\s+/g, " ").trim();
      if (!text) return;
      tokens.push({ text, start, end: node.end, line: file.getLineAndCharacterOfPosition(start).line + 1, node, chain });
      return;
    }
    const next = [...chain, node];
    for (const kid of kids) visit(kid, next);
  };
  visit(file, []);
  let gaps = "";
  let at = 0;
  for (const t of tokens) {
    gaps += `${file.text.slice(at, t.start)}\n`;
    at = t.end;
  }
  gaps += file.text.slice(at);
  return { tokens, gaps };
}

// The comment lines (comment text between code tokens, one per line, blanks
// trimmed at both ends) that hold a pragma, in file order.
function pragmaLines(gaps) {
  return gaps
    .split(/\r?\n|\r|\u2028|\u2029/)
    .map((line) => line.trim())
    .filter((line) => PRAGMA_RE.test(line));
}

// The shape of a parsed tree: every node's kind in nesting order, and the text
// of every leaf (JSX text with its blanks collapsed, JSX text of blanks only
// left out), leaving out the nodes of `skip` (with all they hold). Two trees
// with one shape are read alike by the parser.
function treeShape(ts, file, skip = new Set()) {
  const out = [];
  const visit = (node) => {
    if (skip.has(node)) return;
    const kids = [];
    ts.forEachChild(node, (kid) => {
      kids.push(kid);
    });
    if (kids.length === 0) {
      let text = node.kind === ts.SyntaxKind.EndOfFileToken ? "" : file.text.slice(node.getStart(file), node.end);
      if (node.kind === ts.SyntaxKind.JsxText) {
        text = text.replace(/\s+/g, " ").trim();
        if (!text) return;
      }
      out.push(`${node.kind}:${text}`);
      return;
    }
    out.push(`(${node.kind}`);
    for (const kid of kids) visit(kid);
    out.push(")");
  };
  visit(file);
  return out;
}

// The old tokens a deletion-only edit removes, aligned per hunk of the line
// diff: outside the hunks the token runs must be equal, inside each hunk the
// new tokens must be a subsequence of the old ones. Returns a boolean array
// over the old tokens, or a text that says why the edit is not deletion only.
function deletedTokens(oldTokens, newTokens, hunks) {
  const deleted = new Array(oldTokens.length).fill(false);
  let po = 0;
  let pn = 0;
  const sameUntil = (oldLine, newLine) => {
    while (po < oldTokens.length && oldTokens[po].line < oldLine) {
      if (pn >= newTokens.length || newTokens[pn].line >= newLine || newTokens[pn].text !== oldTokens[po].text) return false;
      po += 1;
      pn += 1;
    }
    return !(pn < newTokens.length && newTokens[pn].line < newLine);
  };
  for (const h of hunks) {
    const oldFrom = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart;
    const newFrom = h.newCount === 0 ? h.newStart + 1 : h.newStart;
    if (!sameUntil(oldFrom, newFrom)) return "the code outside the changed lines differs";
    const o0 = po;
    while (po < oldTokens.length && oldTokens[po].line < oldFrom + h.oldCount) po += 1;
    const n0 = pn;
    while (pn < newTokens.length && newTokens[pn].line < newFrom + h.newCount) pn += 1;
    const O = oldTokens.slice(o0, po).map((t) => t.text);
    const N = newTokens.slice(n0, pn).map((t) => t.text);
    if (N.length === 0) {
      for (let k = o0; k < po; k += 1) deleted[k] = true;
      continue;
    }
    if (N.length > O.length) return "the edit adds code";
    if ((O.length + 1) * (N.length + 1) > ALIGN_MAX_CELLS) return "a changed part is too large to align";
    // Longest common subsequence; every new token must be in it.
    const W = N.length + 1;
    const L = new Uint32Array((O.length + 1) * W);
    for (let i = O.length - 1; i >= 0; i -= 1) {
      for (let j = N.length - 1; j >= 0; j -= 1) {
        L[i * W + j] = O[i] === N[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      }
    }
    if (L[0] !== N.length) return "the edit adds or changes code";
    let i = 0;
    let j = 0;
    while (i < O.length) {
      if (j < N.length && O[i] === N[j] && L[i * W + j] === L[(i + 1) * W + j + 1] + 1) {
        i += 1;
        j += 1;
      } else {
        deleted[o0 + i] = true;
        i += 1;
      }
    }
  }
  if (!sameUntil(Infinity, Infinity) || po !== oldTokens.length || pn !== newTokens.length) return "the code outside the changed lines differs";
  return deleted;
}

// How a node may be deleted whole: a statement of a block or the file, an
// element of an object, an array or an import or export list (comma lists),
// or a JSX attribute. Else null.
function removableKind(ts, node) {
  const p = node.parent;
  if (!p) return null;
  if ((ts.isSourceFile(p) || ts.isBlock(p) || ts.isModuleBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) && p.statements.includes(node)) return "statement";
  if ((ts.isObjectLiteralExpression(p) && p.properties.includes(node)) || (ts.isArrayLiteralExpression(p) && p.elements.includes(node))) return "element";
  if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) return "element";
  if (ts.isJsxAttributes(p) && p.properties.includes(node)) return "attribute";
  return null;
}

// A comma that separates the elements of an object, an array or an import or
// export list: the node that owns the list, or null.
function listCommaOwner(ts, token) {
  if (token.text !== ",") return null;
  const list = token.chain.at(-1);
  const owner = token.chain.at(-2);
  if (!list || list.kind !== ts.SyntaxKind.SyntaxList || !owner) return null;
  return ts.isObjectLiteralExpression(owner) || ts.isArrayLiteralExpression(owner) || ts.isNamedImports(owner) || ts.isNamedExports(owner) ? owner : null;
}

// The deleted run of old tokens [i, j) as whole removable nodes and list
// commas (no more commas in a list than elements deleted from it), or null.
function coverRun(ts, file, tokens, i, j) {
  const units = [];
  const commas = new Map();
  const end = tokens[j - 1].end;
  let k = i;
  while (k < j) {
    const tok = tokens[k];
    let best = null;
    for (const node of [tok.node, ...[...tok.chain].reverse()]) {
      if (node.kind === ts.SyntaxKind.SyntaxList) continue;
      if (node.getStart(file) !== tok.start || node.end > end) break;
      if (removableKind(ts, node)) best = node;
    }
    if (best) {
      units.push(best);
      while (k < j && tokens[k].start < best.end) k += 1;
      continue;
    }
    const owner = listCommaOwner(ts, tok);
    if (!owner) return null;
    commas.set(owner, (commas.get(owner) ?? 0) + 1);
    k += 1;
  }
  for (const [owner, n] of commas) {
    if (units.filter((u) => removableKind(ts, u) === "element" && u.parent === owner).length < n) return null;
  }
  return units;
}

// The leftmost name of a callee: `it` of `it.each(rows)`, `expect` of
// `expect(x).not.toBe`.
function calleeRoot(ts, expr) {
  for (;;) {
    if (ts.isCallExpression(expr) || ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr) || ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr)) expr = expr.expression;
    else if (ts.isTaggedTemplateExpression(expr)) expr = expr.tag;
    else break;
  }
  return ts.isIdentifier(expr) ? expr.text : null;
}

function isCallTo(ts, node, test) {
  if (!ts.isCallExpression(node)) return false;
  const root = calleeRoot(ts, node.expression);
  return root !== null && test(root);
}

// A test or suite declaration: a call rooted at a test or suite name that is
// not itself the callee of a call, so `test.each(rows)("title", fn)` is one
// declaration (the outer call), not two.
function isDeclaration(ts, node, callees) {
  return isCallTo(ts, node, (r) => callees.some((set) => set.has(r))) && !(ts.isCallExpression(node.parent) && node.parent.expression === node);
}

// The code of a node from the file's code tokens, comments left out (a blank
// where the source has blanks or a comment between two tokens).
function codeOf(tokens, file, node) {
  const start = node.getStart(file);
  let out = "";
  let last = null;
  for (const t of tokens) {
    if (t.start < start || t.end > node.end) continue;
    if (last !== null && t.start > last) out += " ";
    out += t.text;
    last = t.end;
  }
  return out;
}

// Whether a call states an assertion: its callee read with ASSERTION_RE
// (`expect(`, `assert.equal(`, `x.should.equal(`, `.toBe(`, ...).
function isAssertionCall(ts, tokens, file, node) {
  return ts.isCallExpression(node) && ASSERTION_RE.test(`${codeOf(tokens, file, node.expression)}(`);
}

// The test names a deleted declaration registers, as a RegExp over a runner's
// normalized test name, or null when its title is not a literal. A test's
// name ends with its title; a suite's title is a part of the names of the
// tests inside it. In a `.each` / `.for` title, the printf placeholders and
// the `$name` fields match any text, as does a template substitution.
function declarationPattern(ts, tokens, file, call, suite) {
  const title = call.arguments[0];
  if (!title) return null;
  const each = /\.\s*(?:each|for)\b/.test(codeOf(tokens, file, call.expression));
  let parts;
  if (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) parts = [title.text];
  else if (ts.isTemplateExpression(title)) {
    parts = [title.head.text];
    for (const span of title.templateSpans) parts.push(null, span.literal.text);
  } else return null;
  const any = "[\\s\\S]*";
  const literal = (text) =>
    (text.match(/%%|%[sdifjoOcp#]|\$[A-Za-z_$][\w$]*(?:\.[\w$]+)*|\s+|[\s\S]/g) ?? [])
      .map((piece) => {
        if (/^\s+$/.test(piece)) return "\\s*";
        if (each && piece === "%%") return "%";
        if (each && piece.length > 1 && (piece[0] === "%" || piece[0] === "$")) return any;
        return piece.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      })
      .join("");
  const body = parts.map((p) => (p === null ? any : literal(p))).join("");
  return new RegExp(`(?:^|[\\s>])${body}${suite ? "(?:[\\s>]|$)" : "$"}`);
}

// Every node under (and including) a node that passes `test`.
function nodesWhere(ts, node, test, out = []) {
  if (test(node)) out.push(node);
  ts.forEachChild(node, (child) => {
    nodesWhere(ts, child, test, out);
  });
  return out;
}

// The names a node mentions: identifiers and the texts of its string literals.
function mentions(ts, node) {
  const words = new Set();
  const texts = new Set();
  nodesWhere(ts, node, (n) => {
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) words.add(n.text);
    else if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      if (n.text.trim()) texts.add(n.text);
    }
    return false;
  });
  return { words, texts };
}

function hasWord(text, word) {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + word.length] ?? "";
    if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) return true;
  }
  return false;
}

// Whether the pull request removes a name from the product code: a line it
// deletes from a product file holds it, and no product file the pull request
// changes holds it at the head (a deleted file holds nothing). An identifier
// is matched as a whole word, a string literal's text as a part of a line.
// product: [{ path, removed: [lines], head: text | null }].
function removedByPullRequest(name, word, product) {
  const has = word ? (text) => hasWord(text, name) : (text) => text.includes(name);
  return product.some((p) => p.removed.some(has)) && product.every((p) => p.head === null || !has(p.head));
}

// A changed test file whose edit only deletes what the same pull request
// removes from the product code (a removed test, or a removed mock or prop of
// something the product code no longer has). All must hold:
//   - both versions parse, and the head's code tokens are the earlier
//     version's with some deleted (comments and blanks apart): no line of
//     code is added or changed;
//   - the comment lines that hold a pragma (an @ pragma, a red-first marker,
//     a /// line) are the same lines, in the same order, in both versions;
//   - the deleted tokens are whole statements, object, array or import list
//     elements, or JSX attributes (with the commas between list elements);
//   - the head's syntax tree is the earlier tree less the deleted nodes (the
//     parser reads the retained code alike);
//   - deleted code that asserts (ASSERTION_RE: expect, assert, .should,
//     .rejects, .resolves, the matchers) is a whole test or suite; no deleted
//     part sits inside an assertion, or in the title or the cases of a test or
//     suite the file keeps;
//   - every deleted part, and every test it deletes (`test.each(rows)(...)`
//     is one test), names an identifier or a string that the pull request
//     removes from the product code (removedByPullRequest), except an import
//     of a name the head no longer uses; at least one part names one.
// file: the test file's path; earlier, source: its merge-base and head texts;
// hunks: its line diff (parseDiffHunks); product: the pull request's product
// scripts (removedByPullRequest). Returns { ok: true, parts, tests, names,
// deletedTitles } (deletedTitles: the RegExps of the test names the deleted
// declarations register, declarationPattern) or { ok: false, why }.
export function removalEdit({ file, earlier, source, hunks, product }) {
  const no = (why) => ({ ok: false, why });
  if (typeof earlier !== "string" || typeof source !== "string") return no("a version of the file is not readable");
  if (!Array.isArray(hunks) || hunks.length === 0) return no("the file's diff is not readable");
  if (!Array.isArray(product) || product.some((p) => !Array.isArray(p.removed))) return no("a product file's diff is not readable");
  const before = parse(earlier, file);
  const after = parse(source, file);
  if (before.unsure || after.unsure) return no("a version of the file does not parse cleanly");
  const ts = before.ts;
  const old = codeTokens(ts, before.file);
  const now = codeTokens(ts, after.file);
  const pragmasBefore = pragmaLines(old.gaps);
  const pragmasAfter = pragmaLines(now.gaps);
  const pragmaAt = Array.from({ length: Math.max(pragmasBefore.length, pragmasAfter.length) }, (_, k) => k).find((k) => pragmasBefore[k] !== pragmasAfter[k]);
  if (pragmaAt !== undefined) {
    return no(`the edit changes the comment pragmas (${clip(pragmasBefore[pragmaAt] ?? "nothing", 80)} becomes ${clip(pragmasAfter[pragmaAt] ?? "nothing", 80)}): a comment line with an @ pragma, a red-first marker or a /// line stays exactly as it was`);
  }
  const deleted = deletedTokens(old.tokens, now.tokens, hunks);
  if (typeof deleted === "string") return no(`the edit is not deletion only (${deleted})`);
  if (!deleted.includes(true)) return no("the edit deletes no code");
  const usedNow = new Set(now.tokens.filter((t) => ts.isIdentifier(t.node)).map((t) => t.text));
  // The longest name of a part that the pull request removes, or null.
  const removed = (m) =>
    [...[...m.words].filter((w) => removedByPullRequest(w, true, product)), ...[...m.texts].filter((s) => removedByPullRequest(s, false, product))].sort((a, b) => b.length - a.length)[0] ?? null;
  const tokens = old.tokens;
  const text = (k) => tokens[k].text;
  const units = [];
  for (let i = 0; i < tokens.length; ) {
    if (!deleted[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < tokens.length && deleted[j]) j += 1;
    // A run of deleted tokens may slide while the token beside it repeats its
    // other end (`a, b, c` less `b`: `, b` or `b ,`); the first place that
    // covers whole nodes is taken.
    const n = j - i;
    let left = i;
    while (left > 0 && !deleted[left - 1] && text(left - 1) === text(left - 1 + n)) left -= 1;
    let right = i;
    while (right + n < tokens.length && !deleted[right + n] && text(right) === text(right + n)) right += 1;
    let cover = null;
    let at = left;
    for (; at <= right; at += 1) {
      cover = coverRun(ts, before.file, tokens, at, at + n);
      if (cover) break;
    }
    if (!cover) return no(`the deleted code at line ${tokens[i].line} is not whole statements, list elements or JSX attributes`);
    for (let k = i; k < j; k += 1) deleted[k] = false;
    for (let k = at; k < at + n; k += 1) deleted[k] = true;
    units.push(...cover);
    i = at + n;
  }
  // The token check keeps the retained tokens in order; the parser must also
  // read them alike: the head's tree is the earlier tree less the deleted
  // nodes (a deletion that lets two statements join, as `x` and `[0].f()`
  // become `x[0].f()` without a semicolon between them, is refused).
  const shapeBefore = treeShape(ts, before.file, new Set(units));
  const shapeAfter = treeShape(ts, after.file);
  if (shapeBefore.length !== shapeAfter.length || shapeBefore.some((s, k) => s !== shapeAfter[k])) {
    return no("the retained code does not keep its structure: without the deleted parts the parser reads the code around them as other statements or expressions");
  }
  const names = [];
  const deletedTitles = [];
  let parts = 0;
  let tests = 0;
  for (const unit of units) {
    const line = before.file.getLineAndCharacterOfPosition(unit.getStart(before.file)).line + 1;
    const kind = removableKind(ts, unit);
    const declaration = kind === "statement" && ts.isExpressionStatement(unit) && isDeclaration(ts, unit.expression, [TEST_CALLEES, SUITE_CALLEES]);
    if (!declaration && ASSERTION_RE.test(codeOf(tokens, before.file, unit))) return no(`the deleted code at line ${line} removes an assertion from a test the file keeps`);
    let inBody = false;
    for (let p = unit.parent; p; p = p.parent) {
      if (isAssertionCall(ts, tokens, before.file, p)) return no(`the deleted code at line ${line} changes an assertion`);
      if (ts.isFunctionLike(p)) inBody = true;
      else if (!inBody && isCallTo(ts, p, (r) => TEST_CALLEES.has(r) || SUITE_CALLEES.has(r))) return no(`the deleted code at line ${line} changes the title or the cases of a test or suite the file keeps`);
    }
    for (const call of nodesWhere(ts, unit, (n) => isDeclaration(ts, n, [TEST_CALLEES]))) {
      tests += 1;
      if (!removed(mentions(ts, call))) return no(`the test deleted at line ${before.file.getLineAndCharacterOfPosition(call.getStart(before.file)).line + 1} names nothing the pull request removes from the product code`);
    }
    for (const call of nodesWhere(ts, unit, (n) => isDeclaration(ts, n, [TEST_CALLEES, SUITE_CALLEES]))) {
      const pattern = declarationPattern(ts, tokens, before.file, call, isCallTo(ts, call, (r) => SUITE_CALLEES.has(r)));
      if (pattern) deletedTitles.push(pattern);
    }
    const name = removed(mentions(ts, unit));
    if (name) {
      parts += 1;
      if (!names.includes(name)) names.push(name);
    } else if (!(ts.isImportSpecifier(unit) && !usedNow.has(unit.name.text))) {
      return no(`the deleted code at line ${line} names nothing the pull request removes from the product code`);
    }
  }
  if (parts === 0) return no("no deleted code names something the pull request removes from the product code");
  return { ok: true, parts, tests, names, deletedTitles };
}

// Repository paths a missing-module text may mean: an absolute path inside the
// tree, a path from the repository root or the runner's folder (vite writes
// `/src/x.ts`), or a relative specifier from its importer or the test file.
function moduleCandidates({ spec, importer, kind }, file, roots, runnerDir) {
  const out = [];
  const push = (p) => {
    const n = posix.normalize(p);
    if (n && n !== "." && !n.startsWith("../") && n !== ".." && !n.startsWith("/")) out.push(n);
  };
  const name = spec.replace(/^file:\/\//, "");
  if (name.startsWith("/")) {
    const inside = relativeIn(name, roots);
    if (inside) push(inside);
    // Only vite writes a path from its root; any other absolute path outside
    // the tree is not a path of the repository.
    else if (kind === "vite") push(posix.join(runnerDir || ".", name.replace(/^\/+/, "")));
  } else if (name.startsWith("./") || name.startsWith("../")) {
    const from = importer ? relativeIn(importer.replace(/^file:\/\//, ""), roots) : null;
    if (from) push(posix.join(posix.dirname(from), name));
    push(posix.join(posix.dirname(file), name));
  }
  return out;
}

// The TypeScript sources an import that names a script's extension may load.
const TS_SOURCE_EXT = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

// The added script a module path means. Without an extension: that path with
// any script extension, or its folder's index. With one: that very file, or
// only its TypeScript source (x.js -> x.ts), never an index or another script.
function addedModule(candidate, added) {
  if (added.has(candidate)) return candidate;
  const ext = SCRIPT_EXT_RE.exec(candidate)?.[0];
  const stem = candidate.replace(SCRIPT_EXT_RE, "");
  for (const path of added) {
    const own = SCRIPT_EXT_RE.exec(path);
    if (!own) continue;
    const name = path.slice(0, own.index);
    if (ext ? name === stem && (TS_SOURCE_EXT[ext] ?? []).includes(own[0]) : name === candidate || name === `${candidate}/index`) return path;
  }
  return null;
}

// What a failure text before the fix names that the fix side adds: an export
// (a call of it, or a named import of it) or a module. The evidence is bound
// to the test file's own static imports: the export is new in the very module
// the test file imports it from (or imports whole), and the module is one the
// test file imports, outside the test file's folder. Returns a description for
// the note, or null: no evidence, so the failure is judged as before.
//   source        the test file's text at the head;
//   exportsByFile () => Map(path -> names the fix side newly exports there);
//   addedFix      the evidence paths the range adds (plan.addedFix).
export function addedByFix(text, file, { source = "", exportsByFile = () => new Map(), addedFix = new Set(), roots = [], runnerDir = "" }) {
  const t = normalizeText(text);
  const imports = importsOf(source, file)
    .map((im) => ({ ...im, path: importPath(im.spec, file) }))
    .filter((im) => im.path);
  const name = missingCallable(t) ?? NO_EXPORT_RE.exec(t)?.[1] ?? null;
  if (name) {
    const map = exportsByFile();
    for (const im of imports.filter((x) => x.names.has(name) || x.whole)) {
      const hit = addedModule(im.path, new Set(map.keys()));
      if (hit && map.get(hit).has(name)) return `the export ${name}`;
    }
  }
  const own = posix.dirname(file);
  for (const missing of missingModules(t)) {
    for (const candidate of moduleCandidates(missing, file, roots, runnerDir)) {
      const hit = addedModule(candidate, addedFix);
      if (!hit || posix.dirname(hit) === own) continue;
      if (imports.some((im) => addedModule(im.path, new Set([hit])))) return `the module ${hit}`;
    }
  }
  return null;
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
    // A file reported as skipped, pending or todo ran no test: a passed test in
    // it contradicts the file status.
    if (entry.status !== "passed" && !fileFailed && tests.some((t) => t.status === "passed")) {
      return bad(`${at} reports a passed test in a file whose status is ${entry.status}`);
    }
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
      // the whole message, for the reading of what the fix adds
      loadText: loaded ? null : normalizeText(message),
      fileError,
      tests,
    };
    // The same file reported twice (two projects include it): keep every
    // result, so one failing copy is never hidden by a passing one.
    const seen = files.get(rel);
    if (seen) {
      result.loaded = seen.loaded && result.loaded;
      result.loadError = seen.loadError ?? result.loadError;
      result.loadText = seen.loadText ?? result.loadText;
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
    if (e?.kind !== "stderr" && e?.kind !== "test") return null;
  }
  // The runner reports the file itself as a top-level test named after the
  // path it was given, after all of the file's own results, when the file's
  // process reported no test or exited with an error. Only that final result
  // is the file: a test of the file with the same name anywhere before it is
  // a test like any other, so no occurrence of it is ever dropped.
  const testEvents = events.filter((e) => e.kind === "test");
  const last = testEvents.at(-1);
  const isWrapper = (e) => e === last && e.nesting === 0 && e.type === "test" && e.name === fileArg;
  for (const e of events) {
    if (e.kind === "stderr") {
      stderr.push(String(e.message ?? ""));
      continue;
    }
    if (isWrapper(e)) {
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
    if (result.length === 0) return { loaded: false, loadError: clip(why), loadText: normalizeText(`${stderr.join("")} ${wrapper.text}`), fileError: null, tests: result };
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

// The tests of `tests` that `earlier` does not report, by name and count (two
// tests of one name in the new list against one in the earlier list: one is
// added).
function addedTests(tests, earlier) {
  const left = new Map();
  for (const t of earlier) left.set(t.name, (left.get(t.name) ?? 0) + 1);
  const added = [];
  for (const t of tests) {
    const n = left.get(t.name) ?? 0;
    if (n > 0) left.set(t.name, n - 1);
    else added.push(t);
  }
  return added;
}

// Why the run of a changed test file's earlier version cannot be compared, or
// null when its tests were read.
function earlierUnreadable(earlier) {
  if (!earlier) return "it was not run";
  if (earlier.run === "contradicts") return `its runner's exit does not match its report (${earlier.detail})`;
  if (earlier.run !== "ok") return earlier.run === "timeout" ? "its run did not finish in time" : "its run gave no readable report";
  const r = earlier.result;
  if (!r) return "it is not in the runner's report";
  if (r.tests?.some((t) => !KNOWN_STATUS.has(t.status))) return "its report gives an unknown status";
  if (!r.loaded) return `it does not load: ${r.loadError}`;
  if (r.fileError) return `its run reports a file error: ${r.fileError}`;
  return null;
}

// before / head: { run: "ok" | "no-report" | "timeout", result } or undefined
// when the phase did not run. Reasons for no-report, timeout and a stopped
// install are recorded where they happen; this adds the per-file reasons.
// context (all optional; without it the file is judged by assertions and
// markers alone):
//   earlier         the run of a changed file's earlier version in the tree
//                   with the fix ({ run, result }): its test names, and
//                   whether the fix breaks it;
//   changedTestLine the first changed line of the file's edit that declares a
//                   test or states an assertion, or null;
//   pureAddition    the file's edit only adds lines (no line removed or
//                   changed);
//   addedByFix      (text) => what the text names that the fix side adds;
//   removal         () => removalEdit's reading of the file's edit.
// Returns the reasons, the notes (a file that makes no red-first claim, or
// that is red because of what the fix adds), `proven`, and `kind`: "proven",
// "collateral", "pins", "removal" or null (not settled: a reason says why).
// A "removal" file stands only beside a proven file (runGate).
export function judgeFile({ file, markers = [], pins = [], status = "A" }, before, head, context = {}) {
  const reasons = [];
  const notes = [];
  const add = (code, phase, detail) => reasons.push({ code, phase, file, detail: clip(detail, 400) });
  let mustPass = [];
  let beforeTests = [];
  let beforeOk = false;
  let headOk = false;
  let noClaim = null;
  let evidence = null;
  const unknown = (r) => r?.tests?.find((t) => !KNOWN_STATUS.has(t.status));
  const wantedPins = pins.map((p) => normalizeText(p));
  const pinned = (t) => wantedPins.some((p) => normalizeText(t.name).includes(p));
  const fromFix = (text) => (text ? (context.addedByFix?.(text) ?? null) : null);

  if (before?.run === "ok") {
    const r = before.result;
    if (!r) add("NOT-COLLECTED", "before", "the file is not in the runner's report (outside the runner's include, or filtered out)");
    else if (unknown(r)) add("NO-REPORT", "before", `the report gives the unknown status ${JSON.stringify(unknown(r).status)} for ${unknown(r).name}`);
    else if (!r.loaded) {
      // A file that does not load is red for the right reason only when the
      // load error names an export or a module the fix side adds.
      evidence = fromFix(r.loadText ?? r.loadError);
      if (!evidence) add("LOAD-ERROR", "before", r.loadError);
      else if (pins.length) add("PIN-MISMATCH", "before", "the file does not load before the fix, so a test declared with red-first-pin: cannot pass there");
      else beforeOk = true;
    } else if (r.fileError) add("FILE-ERROR", "before", r.fileError);
    else {
      const ran = r.tests.filter((t) => t.status !== "skipped");
      const failed = ran.filter((t) => t.status === "failed");
      const stray = pins.find((p, i) => !r.tests.some((t) => normalizeText(t.name).includes(wantedPins[i])));
      // One marker names one test: a text that is in several test names (a
      // suite name, a short word), or a name reported more than once (two
      // tests of one title, two projects), would declare more than one test.
      const broad = pins.find((p, i) => r.tests.filter((t) => normalizeText(t.name).includes(wantedPins[i])).length > 1);
      const notPinned = r.tests.find((t) => pinned(t) && t.status !== "passed");
      if (ran.length === 0) add("NOT-COLLECTED", "before", "no test ran (none collected, or all skipped)");
      else if (stray !== undefined) add("PIN-MISMATCH", "before", `marker red-first-pin: "${stray}" is in no test name of the file`);
      else if (broad !== undefined) add("PIN-MISMATCH", "before", `marker red-first-pin: "${broad}" is in more than one test name of the file, or in a name the report gives more than once: write one marker for each test, under a name of its own`);
      else if (notPinned) add("PIN-MISMATCH", "before", `${notPinned.name} is declared with red-first-pin: but is ${notPinned.status} before the fix (a pin passes before the fix and with it)`);
      else if (failed.length === 0) {
        // No red-first claim is possible here. The file is settled without a
        // proof only as a collateral edit or as declared pins; else it is RED.
        const base = `all ${ran.length} test(s) already pass before the fix`;
        const why = status === "A" ? null : earlierUnreadable(context.earlier);
        const added = status === "A" ? r.tests : why ? [] : addedTests(r.tests, context.earlier.result.tests);
        const undeclared = added.filter((t) => !pinned(t));
        // The earlier version run in the tree with the fix: its failed tests.
        const brokenByFix = why || status === "A" ? [] : context.earlier.result.tests.filter((t) => t.status === "failed");
        const offAdded = status === "A" ? undefined : pins.find((p, i) => !added.some((t) => normalizeText(t.name).includes(wantedPins[i])));
        // The earlier version's tests that the new version no longer reports
        // (by name and count): a collateral edit and a pin keep every one.
        const dropped = why || status === "A" ? [] : addedTests(context.earlier.result.tests, r.tests);
        // A removal edit (removalEdit) is read from the two versions of a
        // changed file, so it needs no run of the earlier version (which may
        // not load with the fix: it imports what the fix removes); a refusal
        // is named on the file's reason.
        const removal = status === "A" || !context.removal ? null : context.removal();
        const notRemoval = removal && !removal.ok ? `; not a removal edit: ${removal.why}` : "";
        // A removal edit keeps every test it does not delete: each test of
        // the earlier version (run with the fix) that the head no longer
        // reports must be one a deleted declaration registers. When the
        // earlier version cannot run with the fix (it imports what the fix
        // removes), the parser's reading stands alone: removalEdit holds the
        // head's tree to the earlier tree less the deleted nodes.
        const titles = Array.isArray(removal?.deletedTitles) ? removal.deletedTitles : [];
        const stray = removal?.ok && !why ? dropped.filter((t) => !titles.some((re) => re instanceof RegExp && re.test(normalizeText(t.name)))) : [];
        if (removal?.ok && added.length === 0 && pins.length === 0 && stray.length) {
          add("NOT-RED-BEFORE", "before", `${base}; the edit removes ${stray.length} test(s) of the file's earlier version that no deleted test declaration names: ${stray.slice(0, 3).map((t) => t.name).join(" | ")}: not a removal edit (a removal edit keeps every test it does not delete)`);
        } else if (removal?.ok && added.length === 0 && pins.length === 0) {
          noClaim = {
            code: "REMOVAL",
            kind: "removal",
            detail: `the edit only deletes code: ${removal.parts} part(s)${removal.tests ? `, ${removal.tests} test(s) among them,` : ""} that name what the pull request removes from the product code (${clip(removal.names.slice(0, 3).join(", "), 160)}); all ${ran.length} test(s) pass before the fix and with it: not proven here`,
          };
        } else if (why) add("NOT-RED-BEFORE", "before", `${base}; the tests of the file's earlier version could not be read to compare them (${why})${notRemoval}`);
        else if (dropped.length) {
          add("NOT-RED-BEFORE", "before", `${base}; the edit removes ${dropped.length} test(s) of the file's earlier version: ${dropped.slice(0, 3).map((t) => t.name).join(" | ")} (a collateral edit or a pin keeps every existing test)${notRemoval}`);
        } else if (undeclared.length) {
          const names = undeclared.slice(0, 3).map((t) => t.name).join(" | ");
          add("NOT-RED-BEFORE", "before", `${base}; ${undeclared.length} test(s) the pull request adds do not fail first: ${names} (a test that pins behaviour the fix keeps is declared with a red-first-pin: <test name> line)`);
        } else if (added.length) {
          if (offAdded !== undefined) add("PIN-MISMATCH", "before", `marker red-first-pin: "${offAdded}" names a test the pull request does not add to the file`);
          else if (status !== "A" && !context.pureAddition) {
            add("NOT-RED-BEFORE", "before", `${base}; the edit declares pins but also changes or removes lines of the file: pins are declared only in an edit that adds lines (a change to an existing test must fail first)`);
          } else if (brokenByFix.length) {
            add("NOT-RED-BEFORE", "before", `${base}; the file's earlier version fails with the fix (${clip(brokenByFix.map((t) => t.name).slice(0, 3).join(" | "), 160)}), so the added lines also keep existing tests working: pins are declared only beside existing tests that pass with the fix unchanged`);
          } else {
            noClaim = { code: "PIN", kind: "pins", detail: `${added.length} test(s) the pull request adds are each declared by a red-first-pin: marker it adds and pass before the fix and with it; the file has no other new or changed test: not proven here` };
          }
        } else if (context.changedTestLine) {
          add("NOT-RED-BEFORE", "before", `${base}; the edit adds no test but changes a test declaration or an assertion (${clip(context.changedTestLine, 120)}): a changed test must fail first${notRemoval}`);
        } else if (!brokenByFix.length) {
          add("NOT-RED-BEFORE", "before", `${base}; the edit adds no test and the file's earlier version also passes with the fix, so the fix does not need the edit: a changed test must fail first${notRemoval}`);
        } else {
          noClaim = {
            code: "COLLATERAL",
            kind: "collateral",
            detail: `the file's earlier version fails with the fix (${clip(brokenByFix.map((t) => t.name).slice(0, 3).join(" | "), 160)}); the edit adds no test, changes no test declaration or assertion line, and all ${ran.length} test(s) pass before the fix and with it: it keeps an existing test file working, not a new test, not proven here`,
          };
        }
        if (noClaim) {
          mustPass = r.tests.filter((t) => t.status === "passed");
          beforeTests = r.tests;
        }
      } else {
        mustPass = [...failed, ...r.tests.filter(pinned)];
        beforeTests = r.tests;
        const texts = failed.map((t) => normalizeText(t.text));
        const wanted = markers.map((m) => normalizeText(m));
        const unmatched = markers.filter((m, i) => !texts.some((x) => x.includes(wanted[i])));
        const stated = failed.filter((t, i) => t.assertion || wanted.some((m) => texts[i].includes(m)));
        if (unmatched.length) add("TEXT-MISMATCH", "before", `marker "${unmatched[0]}" is in no failure text; actual: ${actual(failed)}`);
        else if (stated.length) beforeOk = true;
        else {
          // No assertion and no marker text: red for the right reason only
          // when a failure names an export or a module the fix side adds.
          evidence = failed.map((t) => fromFix(t.text)).find(Boolean) ?? null;
          if (evidence) beforeOk = true;
          else add("WRONG-REASON", "before", `no assertion failure (a red-first-expect: marker can name the expected text); actual: ${actual(failed)}`);
        }
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
        const short = notPassedAtHead(mustPass, beforeTests, r.tests);
        if (short.length) {
          const what = noClaim ? "passed before the fix but did not pass with it" : pins.length ? "failed before the fix, or is a declared pin, but did not pass with it" : "failed before the fix but did not pass with it";
          add("NOT-GREEN-AT-HEAD", "head", `${what}: ${short.slice(0, 3).join(" | ")}`);
        } else headOk = true;
      }
    }
  }
  const clean = headOk && reasons.length === 0;
  const proven = beforeOk && clean;
  const settled = Boolean(noClaim) && clean;
  if (settled) notes.push({ code: noClaim.code, phase: "before", file, detail: noClaim.detail });
  if (proven && evidence) notes.push({ code: "ADDED-BY-FIX", phase: "before", file, detail: `red before the fix because ${evidence} is not there yet: the fix side adds it, and the file passes with the fix` });
  return { reasons, notes, proven, kind: proven ? "proven" : settled ? noClaim.kind : null };
}

// ---------------------------------------------------------------------------
// git, processes and trees
// ---------------------------------------------------------------------------

function gitEnv(extra = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extra };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[key];
  return env;
}

// The deadline of the run's git calls (the job's budget less the reserve), or
// null when the run has no job budget. The cleanup's git calls run inside the
// reserve, each with CLEANUP_GIT_MS.
const gitBudget = { deadlineMs: null };

function gitTimeout(cleanup) {
  if (cleanup) return CLEANUP_GIT_MS;
  if (gitBudget.deadlineMs == null) return undefined;
  return gitBudget.deadlineMs - Date.now();
}

function git(repo, args, { allowFail = false, env = {}, cleanup = false } = {}) {
  const timeout = gitTimeout(cleanup);
  if (timeout !== undefined && timeout <= 0) throw new BudgetError(`the job's time budget was spent before git ${args[0]}`);
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--literal-pathspecs", "-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: gitEnv(env),
    timeout,
    killSignal: "SIGKILL",
  });
  if (r.error?.code === "ETIMEDOUT") {
    const what = `git ${args[0]} did not finish within ${cleanup ? `${CLEANUP_GIT_MS / 1000}s` : "the job's time budget"}`;
    if (cleanup && allowFail) return { status: null, stdout: "", stderr: what };
    throw new BudgetError(what);
  }
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

// A stop of the gate (SIGINT or SIGTERM, for example a cancelled job). The
// first signal kills the children and asks the run to stop: it ends with the
// reason STOPPED and removes its trees in its own cleanup. When the run has
// not left within STOP_GRACE_MS, or at a second signal, the gate removes the
// trees itself and leaves. Either way the work folder is left clean.
export const stopState = { signal: null };
let activeCleanup = null;

function stopCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function cleanupNow() {
  const cleanup = activeCleanup;
  activeCleanup = null;
  if (cleanup) {
    try {
      cleanup();
    } catch {
      // leave anyway
    }
  }
}

function onStop(signal) {
  for (const pid of liveGroups) killGroup(pid);
  if (stopState.signal) {
    cleanupNow();
    process.exit(stopCode(stopState.signal));
  }
  stopState.signal = signal;
  setTimeout(() => {
    cleanupNow();
    process.exit(stopCode(signal));
  }, STOP_GRACE_MS).unref();
}

// A child runs in its own process group (detached), with its output on this
// process's stderr, so stdout carries only the verdict. When the child exits,
// or its time is up, the whole group is killed: a background process it left
// cannot outlive it and change a later phase or run. (A process that leaves
// the group on purpose, with setsid, is outside this; the gate trusts the pull
// request's toolchain as any test job does.)
// The promise always settles: when the time is up the group is killed, and
// when no exit is reported within the grace time after that kill (the kill
// failed, or the process is stuck in the kernel), it settles as timed out.
// A program runs from its argument list, without a shell (spawnChild); the
// install is the only shell (shell). Each starts its child at its own spawn
// call, so an argument list the gate builds never reaches a shell.
function childOptions(cwd) {
  return { cwd, stdio: ["ignore", 2, 2], env: childEnv(), detached: true };
}

export function spawnChild(command, args, cwd, timeoutMs, options = {}) {
  return watchChild(() => spawn(command, args, childOptions(cwd)), timeoutMs, options);
}

// The caller's install command is a shell script, as a `run:` step is; it gets
// no argument from the gate.
export function shell(script, cwd, timeoutMs, options = {}) {
  return watchChild(() => spawn("bash", ["-c", script], childOptions(cwd)), timeoutMs, options);
}

function watchChild(start, timeoutMs, { kill = killGroup, graceMs = KILL_GRACE_MS } = {}) {
  return new Promise((done) => {
    let child;
    try {
      child = start();
    } catch (error) {
      done({ status: null, signal: null, timedOut: false, error: error.message });
      return;
    }
    let timedOut = false;
    let settled = false;
    let grace = null;
    if (child.pid) liveGroups.add(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child.pid);
      grace = setTimeout(() => finish({ status: null, signal: null, timedOut: true, error: null }), Math.max(1, graceMs));
    }, Math.max(1, timeoutMs));
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      kill(child.pid);
      liveGroups.delete(child.pid);
      done(value);
    };
    child.on("error", (error) => finish({ status: null, signal: null, timedOut: false, error: error.message }));
    child.on("exit", (status, signal) => finish({ status, signal, timedOut, error: null }));
  });
}

function group(title) {
  if (process.env.GITHUB_ACTIONS === "true") say(`::group::${escapeData(title)}`);
  else sayErr(`== ${title}`);
}

function endGroup() {
  if (process.env.GITHUB_ACTIONS === "true") say("::endgroup::");
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
// Every entry of the head tree: path -> mode ("100644", "100755", "120000"
// for a symlink, "160000" for a gitlink).
function headModes(repo, head) {
  const modes = new Map();
  for (const line of nulList(git(repo, ["ls-tree", "-r", "-z", head]).stdout)) {
    const tab = line.indexOf("\t");
    if (tab < 0) throw new GateError("the head tree listing is not readable");
    modes.set(line.slice(tab + 1), line.split(" ")[0]);
  }
  return modes;
}

const REGULAR_MODES = new Set(["100644", "100755"]);

function configSetupPaths(repo, head, strict, modes) {
  const names = [...modes.keys()];
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
    return { verdict: "skip", reason: "NOT-A-PULL-REQUEST", detail: "no pull request base and head were given", newTests: [], excluded: [], fixSide: [], testSide: [], notFiles: [] };
  }
  if (!SHA_RE.test(base ?? "") || !SHA_RE.test(head ?? "")) throw new GateError("--base and --head must both be 40-hex commit SHAs");
  for (const sha of [base, head]) git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  const mergeBase = git(repo, ["merge-base", base, head]).stdout.trim();
  if (!SHA_RE.test(mergeBase)) throw new GateError(`no merge base of ${base} and ${head}`);
  const parts = nulList(git(repo, ["diff", "--name-status", "--no-renames", "-z", mergeBase, head]).stdout);
  if (parts.length % 2) throw new GateError("the range's name-status list is not readable");
  const entries = [];
  for (let i = 0; i < parts.length; i += 2) entries.push({ status: parts[i].charAt(0), path: parts[i + 1] });
  const modes = headModes(repo, head);
  const setupPaths = configSetupPaths(repo, head, strict, modes);
  const c = classifyPaths(entries, { exclude, testSupport, setupPaths });
  // Test-side entries of the head that are not regular files (a symlink, whose
  // target may be fix side, or a gitlink): the test that runs would not be the
  // pull request's test file, so run refuses them (NOT-A-FILE).
  const notFiles = c.testSide.filter((e) => e.status !== "D" && !REGULAR_MODES.has(modes.get(e.path))).map((e) => e.path);
  // The fix-side paths the range adds: a module only the head has. Only a
  // regular file that can be evidence counts (not a symlink, whose target may
  // be test side or outside, not a declaration file, not test code).
  const fixSide = new Set(c.fixSide);
  const addedFix = entries
    .filter((e) => e.status === "A" && fixSide.has(e.path) && REGULAR_MODES.has(modes.get(e.path)) && evidencePath(e.path))
    .map((e) => e.path)
    .sort(byPath);
  const plan = { base, head, mergeBase, testSupport, setupPaths, notFiles, addedFix, ...c };
  if (c.newTests.length + c.excluded.length === 0) {
    return { ...plan, verdict: "skip", reason: "NO-NEW-TESTS", detail: "the pull request adds or changes no test file" };
  }
  // Every new test excluded decides first: with or without a fix, this check
  // cannot prove them.
  if (c.newTests.length === 0) {
    return { ...plan, verdict: "skip", reason: "EXCLUDED-ONLY", detail: `every new or changed test file (${c.excluded.length}) matches --exclude: this check cannot prove them, so it is neutral (skipped), not red` };
  }
  if (c.fixSide.length === 0) {
    return { ...plan, verdict: "skip", reason: "TESTS-ONLY", detail: "the pull request changes only tests and test support files: there is no fix to prove" };
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
  if (work.cleaned) return;
  work.cleaned = true;
  for (const tree of ["before", "head"]) {
    if (existsSync(join(work.path, tree))) git(repo, ["worktree", "remove", "--force", "--force", join(work.path, tree)], { allowFail: true, cleanup: true });
  }
  git(repo, ["worktree", "prune"], { allowFail: true, cleanup: true });
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

// swapped: test files this phase runs in their earlier version (the phase
// "earlier"); they differ from the head on purpose. skipInstall: the tree was
// installed by an earlier phase.
async function runPhase(phase, tree, files, plan, opts, reportDir, { skipInstall = false, swapped = [] } = {}) {
  const reasons = [];
  const perFile = new Map();
  const invocations = [];
  // Before each step: when the job's budget is spent, stop with TIMEOUT, so
  // the verdict is written before GitHub ends the job.
  // After a stop signal: end with STOPPED, read nothing more from this tree.
  const halted = (step, pending) => {
    if (!stopState.signal) return null;
    reasons.push({ code: "STOPPED", phase, file: null, detail: `the gate was stopped by ${stopState.signal} ${step}; no further test ran` });
    for (const file of pending) perFile.set(file, { run: "stopped" });
    return { stop: true, reasons, perFile, invocations };
  };
  const outOfTime = (step, pending) => {
    const halt = halted(`before ${step}`, pending);
    if (halt) return halt;
    const left = allowance(opts);
    if (left.ms > 0) return null;
    reasons.push({ code: "TIMEOUT", phase, file: null, detail: `the job's time budget was spent before ${step}; no further test ran` });
    for (const file of pending) perFile.set(file, { run: "timeout" });
    return { stop: true, reasons, perFile, invocations };
  };
  if (opts.install && !skipInstall) {
    const stop = outOfTime("the install", []);
    if (stop) return stop;
    const left = allowance(opts);
    group(`red-first: install (${phase})`);
    const res = await shell(opts.install, tree, left.ms);
    endGroup();
    const halt = halted("during the install", files.map((x) => x.file));
    if (halt) return halt;
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
    const halt = halted(`during node --test ${f.file}`, [...nodeFiles.slice(i).map((x) => x.file), ...files.filter((x) => x.runner === "vitest").map((x) => x.file)]);
    if (halt) return halt;
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
    // vitest runs from its argument list, without a shell.
    const [command, ...words] = splitCommand(opts.vitest);
    const res = await spawnChild(command, [...words, ...args, "--reporter=default", "--reporter=json", `--outputFile.json=${out}`], cwd, left.ms);
    endGroup();
    const halt = halted(`during vitest in ${where}`, groupList.slice(i).flatMap(([, l]) => l));
    if (halt) return halt;
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
  // A swapped file differs from the head on purpose: it must still be the
  // merge base's version after the run.
  const moved = swapped.length ? nulList(git(tree, ["diff", "--name-only", "--no-renames", "-z", plan.mergeBase, "--", ...swapped]).stdout) : [];
  for (const file of [...new Set([...changedTestSide(tree, plan).filter((p) => !swapped.includes(p)), ...moved])].sort(byPath)) {
    reasons.push({ code: "TEST-CHANGED", phase, file, detail: "the test run changed this tracked test-side file" });
  }
  return { stop: false, reasons, perFile, invocations };
}

// A changed test file with no failing test before the fix: its earlier version
// (the merge base's) is run in the tree WITH the fix, after both phases, to
// read the names of its tests and whether the fix breaks it. A stop of the
// gate and a test-side file the run changed are reasons of their own; a file
// whose earlier version cannot be read, or whose runner's exit contradicts its
// report, stays NOT-RED-BEFORE.
function quietBefore(entry) {
  const r = entry?.run === "ok" ? entry.result : null;
  if (!r || !r.loaded || r.fileError || r.tests.some((t) => !KNOWN_STATUS.has(t.status))) return false;
  const ran = r.tests.filter((t) => t.status !== "skipped");
  return ran.length > 0 && ran.every((t) => t.status === "passed");
}

async function runEarlier(repo, plan, tree, quiet, opts, work) {
  const paths = quiet.map((f) => f.file);
  git(tree, ["checkout", plan.mergeBase, `--pathspec-from-file=${writePathspec(join(work, "take.lst"), paths)}`, "--pathspec-file-nul"]);
  const files = paths.map((file) => {
    const source = git(repo, ["cat-file", "blob", `${plan.mergeBase}:${file}`]).stdout;
    return { file, runner: NODE_TEST_IMPORT_RE.test(source) ? "node" : "vitest" };
  });
  const run = await runPhase("earlier", tree, files, plan, opts, join(work, "reports"), { skipInstall: true, swapped: paths });
  // A runner that exits non-zero (or reports success: false) although every
  // file of its report passed, or exits 0 although one failed, is not read.
  for (const inv of run.invocations) {
    const entries = inv.files.map((file) => run.perFile.get(file));
    const failed = entries.some((e) => e?.run === "ok" && e.result && (!e.result.loaded || e.result.fileError || e.result.tests.some((t) => t.status === "failed")));
    // A failure must end the runner non-zero; no failure, with exit 0 and no
    // success: false.
    const agrees = failed ? inv.res.status !== 0 && inv.res.status !== null : inv.res.status === 0 && !inv.reportFailed;
    if (!agrees) {
      const detail = `${inv.label} ${exitText(inv.res)}${inv.reportFailed ? " (report success: false)" : ""} although its report shows ${failed ? "a failure" : "no failure"}`;
      for (const file of inv.files) run.perFile.set(file, { run: "contradicts", detail });
    }
  }
  return { perFile: run.perFile, reasons: run.reasons.filter((r) => r.code === "STOPPED" || r.code === "TEST-CHANGED") };
}

// What the fix side adds, read once when a judgement first asks: per fix-side
// script, the names its whole head version exports (code only) that no
// fix-side script exported at the merge base (so a moved or reworded export
// is not new); per changed test file, the first changed line that declares a
// test or states an assertion, its added lines and whether it only adds.
function rangeReader(repo, plan) {
  let files = null;
  let byFile = null;
  let text = null;
  let hunks = null;
  let product = null;
  const diffText = () => {
    text ??= git(repo, ["diff", "-U0", "--no-renames", "--no-color", "--no-ext-diff", plan.mergeBase, plan.head]).stdout;
    return text;
  };
  const read = () => {
    files ??= parseRangeDiff(diffText());
    return files;
  };
  const readHunks = () => {
    hunks ??= parseDiffHunks(diffText());
    return hunks;
  };
  const blob = (rev, path) => {
    const r = git(repo, ["cat-file", "blob", `${rev}:${path}`], { allowFail: true });
    return r.status === 0 ? r.stdout : null;
  };
  return {
    exportsByFile() {
      if (byFile) return byFile;
      byFile = freshExports(plan.fixSide, (path) => blob(plan.mergeBase, path), (path) => blob(plan.head, path));
      return byFile;
    },
    // The added lines of a file's edit, or null when its diff is not readable.
    addedLines(path) {
      return read().get(path)?.added ?? null;
    },
    pureAddition(path) {
      const diff = read().get(path);
      return Boolean(diff) && diff.removed.every((line) => !line.trim());
    },
    // removalEdit of a changed test file: its two versions and line diff, and
    // the pull request's product scripts (fix side, evidence paths) with the
    // lines it deletes from them and their head texts.
    removal(path) {
      try {
        const diff = readHunks().get(path);
        product ??= plan.fixSide.filter(evidencePath).map((p) => {
          const entry = readHunks().get(p);
          return { path: p, removed: entry && !entry.unreadable ? entry.removed : null, head: blob(plan.head, p) };
        });
        return removalEdit({ file: path, earlier: blob(plan.mergeBase, path), source: blob(plan.head, path), hunks: diff && !diff.unreadable ? diff.hunks : null, product });
      } catch (error) {
        if (error instanceof BudgetError) throw error;
        return { ok: false, why: `the edit could not be read (${clip(error?.message ?? error, 120)})` };
      }
    },
    // A changed file whose diff is not readable here counts as touched.
    testLine(path) {
      const diff = read().get(path);
      return diff ? changedTestLine([...diff.added, ...diff.removed]) : "the file's diff is not readable";
    },
  };
}

function budgetResult(error, mergeBase = null) {
  return { mode: "run", verdict: "RED", reason: "", detail: "", mergeBase, reasons: [{ code: "TIMEOUT", phase: null, file: null, detail: error.message }], notes: [], files: [] };
}

export async function runGate(opts) {
  // Every git call of the run stops at the job's budget (BudgetError: TIMEOUT).
  gitBudget.deadlineMs = opts.deadlineMs ?? null;
  try {
    return await runGateIn(opts);
  } finally {
    gitBudget.deadlineMs = null;
  }
}

async function runGateIn(opts) {
  let plan;
  try {
    plan = planRange({ ...opts, strict: true });
  } catch (error) {
    if (error instanceof BudgetError) return budgetResult(error);
    throw error;
  }
  if (plan.verdict === "skip") {
    return { mode: "run", verdict: "SKIP", reason: plan.reason, detail: plan.detail, mergeBase: plan.mergeBase ?? null, reasons: [], notes: [], files: [] };
  }
  // the parser is loaded before any test of the pull request runs (they could change its files)
  typescript();
  const repo = opts.repo ?? process.cwd();
  const reasons = [];
  // New tests that match --exclude beside other new tests: listed, not proven,
  // and no reason to fail the proof of the others.
  const notes = plan.excluded.map((file) => ({ code: "EXCLUDED", phase: "plan", file, detail: "the path matches --exclude: this check does not prove it" }));
  const result = { mode: "run", verdict: "RED", reason: "", detail: "", mergeBase: plan.mergeBase, reasons, notes, files: [] };
  if (plan.notFiles.length) {
    for (const file of plan.notFiles) reasons.push({ code: "NOT-A-FILE", phase: "plan", file, detail: "a test-side path of the head is a symlink or a submodule, not a regular file: the test that would run is not this file" });
    return result;
  }
  try {
    git(repo, ["worktree", "prune"], { allowFail: true });
  } catch (error) {
    if (error instanceof BudgetError) return budgetResult(error, plan.mergeBase);
    throw error;
  }
  const work = prepareWork(opts.work);
  activeCleanup = () => cleanWork(repo, work);
  const trees = { before: join(work.path, "before"), head: join(work.path, "head") };
  try {
    git(repo, ["worktree", "add", "-q", "--detach", trees.head, plan.head]);
    const mismatch = buildBeforeTree(repo, plan, trees.before, work.path);
    if (mismatch) {
      reasons.push({ code: "TREE-MISMATCH", phase: "before", file: null, detail: mismatch });
      return result;
    }

    // The new test's bytes from the head commit (a regular file, checked by
    // plan), never through the file system.
    const statusOf = new Map(plan.testSide.map((e) => [e.path, e.status]));
    const range = rangeReader(repo, plan);
    const sources = new Map();
    const files = plan.newTests.map((file) => {
      const source = git(repo, ["cat-file", "blob", `${plan.head}:${file}`]).stdout;
      sources.set(file, source);
      // Pins only from the lines the pull request adds: a marker the file
      // already had declares nothing (an unreadable diff declares nothing).
      const added = range.addedLines(file);
      return { file, runner: NODE_TEST_IMPORT_RE.test(source) ? "node" : "vitest", markers: readMarkers(source), pins: added ? readPins(added.join("\n")) : [], status: statusOf.get(file) ?? "A" };
    });
    const phases = {};
    for (const phase of ["before", "head"]) {
      const run = await runPhase(phase, trees[phase], files, plan, opts, join(work.path, "reports"));
      reasons.push(...run.reasons);
      if (run.stop) break;
      phases[phase] = run;
    }
    if (stopState.signal && !reasons.some((r) => r.code === "STOPPED")) {
      reasons.push({ code: "STOPPED", phase: null, file: null, detail: `the gate was stopped by ${stopState.signal}` });
    }

    // Only a file that is a regular file on both sides (status M) has an
    // earlier version to run; a type change (a link before) is never compared.
    // It runs in the tree with the fix (installed, its own run finished).
    let earlier = null;
    const quiet = phases.before && phases.head && !stopState.signal ? files.filter((f) => f.status === "M" && quietBefore(phases.before.perFile.get(f.file))) : [];
    if (quiet.length) {
      earlier = await runEarlier(repo, plan, trees.head, quiet, opts, work.path);
      reasons.push(...earlier.reasons);
    }

    const roots = rootsOf(trees.before);
    const addedFix = new Set(plan.addedFix);
    const fileNotes = [];
    const headReasonFiles = new Set();
    for (const f of files) {
      const context = {
        earlier: earlier?.perFile.get(f.file),
        changedTestLine: quiet.includes(f) ? range.testLine(f.file) : null,
        pureAddition: f.status === "A" || range.pureAddition(f.file),
        removal: quiet.includes(f) ? () => range.removal(f.file) : undefined,
        addedByFix: (text) => addedByFix(text, f.file, { source: sources.get(f.file), exportsByFile: range.exportsByFile, addedFix, roots, runnerDir: f.runner === "vitest" ? vitestDir(trees.before, f.file) : "" }),
      };
      const judged = judgeFile(f, phases.before?.perFile.get(f.file), phases.head?.perFile.get(f.file), context);
      reasons.push(...judged.reasons);
      fileNotes.push(...judged.notes);
      for (const r of judged.reasons) if (r.phase === "head") headReasonFiles.add(f.file);
      result.files.push({ file: f.file, runner: f.runner, markers: f.markers, pins: f.pins, proven: judged.proven, kind: judged.kind });
    }
    for (const inv of phases.head?.invocations ?? []) {
      if ((inv.res.status !== 0 || inv.reportFailed) && !inv.files.some((file) => headReasonFiles.has(file))) {
        const what = inv.res.status !== 0 ? exitText(inv.res) : "reported success: false";
        reasons.push({ code: "RUNNER-EXIT", phase: "head", file: inv.files.length === 1 ? inv.files[0] : null, detail: `${inv.label} ${what} with the fix although every new test passed` });
      }
    }
    for (const f of result.files) {
      if (reasons.some((r) => r.file === f.file || r.file === null)) {
        f.proven = false;
        f.kind = null;
      }
    }
    // A removal edit stands only beside a proven file: the pull request's own
    // new test proves the removal it makes.
    if (!result.files.some((f) => f.proven)) {
      for (const f of result.files.filter((x) => x.kind === "removal")) {
        reasons.push({ code: "NOT-RED-BEFORE", phase: "before", file: f.file, detail: "every test already passes before the fix; the edit only deletes code that names what the pull request removes from the product code, but no test file of the pull request is proven red before the fix and green with it: a removal edit is accepted only beside a proven test" });
        f.kind = null;
      }
    }
    // A note belongs to a file that is settled (proven, collateral or pins).
    notes.push(...fileNotes.filter((n) => result.files.some((f) => f.file === n.file && f.kind)));
    // Safety net: a file that is not settled always carries a reason.
    if (!reasons.length) {
      for (const f of result.files) {
        if (!f.kind) reasons.push({ code: "NOT-PROVEN", phase: null, file: f.file, detail: "the file was not proven red before the fix and green with it" });
      }
    }
    if (!reasons.length && result.files.length > 0 && result.files.every((f) => f.kind)) {
      // Proven files decide a PASS. Collateral edits and declared pins alone
      // prove nothing: the run fails closed, so a green job always has a
      // proven file.
      if (result.files.some((f) => f.proven)) result.verdict = "PASS";
      else {
        reasons.push({
          code: "NOTHING-PROVEN",
          phase: null,
          file: null,
          detail: `no test file of the pull request is proven red before the fix and green with it: its ${result.files.length} test file(s) are notes only (collateral edits or declared pins), which prove nothing; add a test that fails before the fix`,
        });
      }
    }
    return result;
  } catch (error) {
    if (!(error instanceof BudgetError)) throw error;
    reasons.push({ code: "TIMEOUT", phase: null, file: null, detail: error.message });
    for (const f of result.files) f.proven = false;
    for (const f of result.files) f.kind = null;
    result.verdict = "RED";
    return result;
  } finally {
    for (const r of reasons) {
      if (r.detail) for (const root of [...rootsOf(trees.before), ...rootsOf(trees.head)]) r.detail = r.detail.split(root).join("<tree>");
    }
    activeCleanup = null;
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

// Text from the pull request (paths, details) in the Markdown summary: plain
// text on one line, with every character Markdown or a table could read as
// syntax escaped by a backslash (the backslash itself first, in the same pass):
// \ ` * _ [ ] < > | ~ & $. Never inside a code span, where no escape works.
export function cell(text) {
  return String(text ?? "").replace(/\s+/g, " ").replace(/[\\`*_[\]<>|~&$]/g, "\\$&");
}

function reasonLine(r) {
  return `${r.code} ${r.phase ?? "-"} ${r.file ?? "-"}: ${r.detail ?? ""}`;
}

function emit(result, opts) {
  const gha = process.env.GITHUB_ACTIONS === "true";
  for (const r of result.reasons ?? []) {
    say(`REASON ${reasonLine(r)}`);
    if (gha) {
      const fileProp = r.file ? `file=${escapeProperty(r.file)},` : "";
      say(`::error ${fileProp}title=${escapeProperty(`red-first ${r.code}`)}::${escapeData(reasonLine(r))}`);
    }
  }
  // Excluded new tests: a note in both jobs (plan lists them from the range).
  const notes = result.mode === "plan" ? (result.excluded ?? []).map((file) => ({ code: "EXCLUDED", phase: "plan", file, detail: "the path matches --exclude: this check does not prove it" })) : (result.notes ?? []);
  for (const r of notes) {
    say(`NOTE ${reasonLine(r)}`);
    if (gha) say(`::notice file=${escapeProperty(r.file)},title=${escapeProperty(`red-first ${r.code}`)}::${escapeData(reasonLine(r))}`);
  }
  const count = (code) => notes.filter((n) => n.code === code).length;
  let notProven = count("EXCLUDED") ? `; ${count("EXCLUDED")} excluded new test file(s) not proven here` : "";
  if (count("COLLATERAL")) notProven += `; ${count("COLLATERAL")} changed test file(s) collateral, not proven here`;
  if (count("PIN")) notProven += `; ${count("PIN")} test file(s) with declared pins only, not proven here`;
  if (count("REMOVAL")) notProven += `; ${count("REMOVAL")} changed test file(s) that only delete what the pull request removes, not proven here`;
  let headline;
  if (result.mode === "plan") headline = `RED-FIRST PLAN: ${result.verdict}${result.reason ? ` ${result.reason}` : ""}: ${result.detail}`;
  else if (result.verdict === "PASS") headline = `RED-FIRST: PASS (${result.files.filter((f) => f.proven).length} new test file(s) fail before the fix and pass with it${notProven})`;
  else if (result.verdict === "SKIP") headline = `RED-FIRST: ${result.verdict} ${result.reason}: ${result.detail}`;
  else headline = `RED-FIRST: RED (${result.reasons.length} reason(s))`;
  say(headline);
  if (gha && result.verdict === "SKIP") say(`::notice title=red-first ${result.verdict}::${escapeData(`${result.reason}: ${result.detail}`)}`);

  if (opts.verdict) writeFileSync(opts.verdict, `${JSON.stringify(result, null, 2)}\n`);
  if (opts.githubOutput && result.mode === "plan") {
    appendFileSync(opts.githubOutput, `verdict=${result.verdict}\nreason=${result.reason}\nnew_tests=${(result.newTests ?? []).length + (result.excluded ?? []).length}\nexcluded=${(result.excluded ?? []).length}\n`);
  }
  if (opts.summary) {
    const lines = [`### red-first-gate: ${headline.replace(/^RED-FIRST( PLAN)?: /, "")}`, ""];
    if (result.mode === "plan" && result.verdict === "run") {
      lines.push(`New or changed test files: ${[...(result.newTests ?? []), ...(result.excluded ?? [])].map((f) => cell(f)).join(", ")}`, "");
    }
    if (result.files?.length) {
      lines.push("| test file | runner | proven |", "| --- | --- | --- |");
      for (const f of result.files) lines.push(`| ${cell(f.file)} | ${f.runner} | ${f.proven ? "yes" : f.kind ? `no (${f.kind})` : "no"} |`);
      lines.push("");
    }
    for (const r of result.reasons ?? []) lines.push(`- \`${r.code}\` ${cell(r.phase ?? "")} ${r.file ? cell(r.file) : ""}: ${cell(r.detail)}`);
    for (const r of notes) lines.push(`- note \`${r.code}\` ${cell(r.file)}: ${cell(r.detail)}`);
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
  if (splitCommand(opts.vitest).length === 0) throw new GateError("--vitest names no command");
  const seconds = Number(opts.timeoutSeconds);
  // At most a day: a larger value would overflow the timer and fire at once.
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 86400) throw new GateError("--timeout-seconds must be a whole number from 1 to 86400");
  opts.timeoutSeconds = seconds;
  // The job's budget. run: both or neither; the deadline keeps
  // JOB_RESERVE_SECONDS back for the verdict and the removal of the trees.
  // plan: --job-minutes alone, checked so that a limit the reserve does not fit
  // in fails the plan job before the red-first job starts.
  opts.deadlineMs = null;
  if (opts.jobStarted !== "" || opts.jobMinutes !== "") {
    const minutes = Number(opts.jobMinutes);
    if (opts.jobMinutes === "" || !Number.isFinite(minutes) || minutes < JOB_MINUTES_MIN || minutes > JOB_MINUTES_MAX) {
      throw new GateError(`--job-minutes must be a number from ${JOB_MINUTES_MIN} to ${JOB_MINUTES_MAX} (the job's limit; the gate keeps ${JOB_RESERVE_SECONDS}s of it back)`);
    }
    if (mode === "run" || opts.jobStarted !== "") {
      const started = Number(opts.jobStarted);
      // At most five minutes ahead of this clock: a start in the future would
      // move the deadline past the job's real limit.
      if (opts.jobStarted === "" || !Number.isInteger(started) || started <= 0 || started > Date.now() / 1000 + 300) {
        throw new GateError("--job-started must be the job's start as epoch seconds, not in the future (with --job-minutes)");
      }
      opts.deadlineMs = (started + minutes * 60 - JOB_RESERVE_SECONDS) * 1000;
    }
  }
  opts.repo = resolve(opts.repo);
  return opts;
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    sayErr(`red-first-gate: ${error.message}`);
    console.error(USAGE);
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
    if (stopState.signal) return stopCode(stopState.signal);
    // Only a PASS (at least one proven file) is green; notes alone are RED
    // (NOTHING-PROVEN).
    if (result.verdict === "PASS") return 0;
    return result.verdict === "SKIP" ? 3 : 1;
  } catch (error) {
    // Any error, not only a GateError, is exit 2 with its message (the
    // contract: 2 is a usage or internal error, never a crash).
    const message = error instanceof GateError ? error.message : `internal error: ${error?.message ?? error}`;
    sayErr(`red-first-gate: ${message}`);
    if (process.env.GITHUB_ACTIONS === "true") say(`::error title=red-first ERROR::${escapeData(message)}`);
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
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  process.exitCode = await main(process.argv.slice(2));
}
