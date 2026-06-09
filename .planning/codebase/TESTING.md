# Testing Patterns

**Analysis Date:** 2026-06-09

## Test Framework

**Runner:**
- Node.js built-in test runner (`node:test`) — no external framework
- No `jest.config.*`, `vitest.config.*`, or similar config file
- Node 24 (set in `.github/workflows/self-check.yml`)

**Assertion Library:**
- `node:assert/strict` — strict equality mode throughout

**Run Commands:**
```bash
node --test \
  scripts/__tests__/source-leak-gate.test.mjs \
  scripts/__tests__/source-leak-ratchet.test.mjs
```

Tests are run explicitly by file list (no glob discovery config).

## Test File Organization

**Location:**
- Co-located under `scripts/__tests__/` alongside the source files they test

**Naming:**
- `<subject>.test.mjs` pattern
- `scripts/__tests__/source-leak-gate.test.mjs` — unit tests for rule matching and scanner logic
- `scripts/__tests__/source-leak-ratchet.test.mjs` — integration/ratchet-mode tests using real git repos

**Structure:**
```
scripts/
├── __fixtures__/
│   └── source-leak.fixture.txt   # Tagged HIT/MISS lines for rule coverage
├── __tests__/
│   ├── source-leak-gate.test.mjs
│   └── source-leak-ratchet.test.mjs
├── lib/
│   └── touch-ratchet.mjs
└── source-leak-gate.mjs
```

## Test Structure

**Suite Organization:**
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";

test("descriptive test name", () => {
  // arrange
  // act
  // assert
});
```

No `describe` blocks — flat `test()` calls only, each named as a sentence describing the expected behavior.

**Patterns:**
- No `beforeEach`/`afterEach` — each test that needs a git repo calls `setupRepo()` directly and cleans up in a `finally` block
- Temporary directories created with `fs.mkdtempSync` in `os.tmpdir()`
- Cleanup: `fs.rmSync(dir, { recursive: true, force: true })` in `finally`
- Minimum count assertions (e.g., `assert.ok(hits.length >= 15)`) ensure fixtures stay populated

## Mocking

**Framework:** None — no mocking library used

**Patterns:**
- No mocks or stubs; tests use real implementations
- For integration tests in `source-leak-ratchet.test.mjs`, real temporary git repos are created and destroyed per test
- Environment variables injected via `spawnSync` `env` option to simulate CI context:
```javascript
const res = spawnSync(
  "node",
  [SCANNER, "--exit-on-match", "--quiet", "--diff-base-env", "TESTBASE", ...extraArgs],
  { cwd: dir, encoding: "utf8", env: { ...process.env, TESTBASE: base || "" } },
);
```

**What to Mock:**
- Not applicable — project philosophy is real execution with isolated temp repos

**What NOT to Mock:**
- Git subprocess calls — tested against real git repos in tempdir
- File system — real files written and read

## Fixtures and Factories

**Test Data — Fixture File:**
```
scripts/__fixtures__/source-leak.fixture.txt
```
Lines follow a tagged format:
```
HIT:<RULE_ID>:<payload line that should match>
MISS:<RULE_ID>:<payload line that should NOT match>
```

Tests parse this file via `fixtureLines(tag)` and assert every HIT matches and every MISS does not.

**Marker Assembly Pattern:**
Strings containing real rule-triggering content are assembled at runtime rather than written as literals, to prevent this test file from self-flagging:
```javascript
const MARKER = "see " + "Phase " + "530 here";
```

**Factory Helpers (in `source-leak-ratchet.test.mjs`):**
```javascript
function setupRepo()         // creates tmpdir, inits git repo, configures identity
function commit(dir, files, msg)  // writes files, stages, commits; returns SHA
function runGate(dir, base, extraArgs)  // runs the gate CLI via spawnSync; returns exit code
function rm(dir)             // removes tmpdir recursively
```

## Coverage

**Requirements:** Not enforced — no coverage thresholds or coverage config

**View Coverage:**
```bash
node --test --experimental-test-coverage \
  scripts/__tests__/source-leak-gate.test.mjs \
  scripts/__tests__/source-leak-ratchet.test.mjs
```

## Test Types

**Unit Tests (`source-leak-gate.test.mjs`):**
- Scope: individual rule regex matching, fixture HIT/MISS correctness, self-scan cleanness, config-driven rule activation
- Imports `buildRules` and `scanFile` directly from the module under test
- Tests rule matching via a local `matchRule` helper that replicates the scanner's per-line logic

**Integration Tests (`source-leak-ratchet.test.mjs`):**
- Scope: full CLI invocation via `spawnSync`, all ratchet modes (`line`, `file`, `baseline`, `off`), allowlists, manifests, diff base resolution, exit codes
- Creates real git repos in tmpdir for each test; exercises the gate as a subprocess
- Tests cover: new-finding blocking, pre-existing tolerance, stale allowlist detection, bad ref error exit, empty base strict mode, baseline mode, caller-file exemption bypass, manifest include/negation

**E2E Tests:**
- Not applicable as a separate category; the integration tests in `source-leak-ratchet.test.mjs` serve this role by running the full CLI

## Common Patterns

**Async Testing:**
- All tests are synchronous (no `async`/`await`); `execFileSync`/`spawnSync` are used throughout

**Error Testing:**
```javascript
test("bad explicit diff base fails loud (exit 2)", () => {
  const dir = setupRepo();
  try {
    commit(dir, { "b.md": MARKER + "\n" }, "init");
    assert.equal(runGate(dir, "does-not-exist", ["--ratchet-mode", "line"]), 2);
  } finally { rm(dir); }
});
```

**Exit Code Assertions:**
```javascript
assert.equal(runGate(dir, base, ["--ratchet-mode", "line"]), 1);  // blocked
assert.equal(runGate(dir, base, ["--ratchet-mode", "line"]), 0);  // clean
```

## CI Integration

Tests run in `.github/workflows/self-check.yml` on every PR and push to `main`:
- Node 24 via `actions/setup-node`
- `fetch-depth: 0` required so git history is available for ratchet tests
- Gate runs clean on itself before tests execute (dogfood step)

---

*Testing analysis: 2026-06-09*
