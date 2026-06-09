<!-- refreshed: 2026-06-09 -->
# Architecture

**Analysis Date:** 2026-06-09

## System Overview

```text
┌──────────────────────────────────────────────────────────────┐
│            Consuming Repo CI (GitHub Actions caller)         │
│   .github/workflows/<caller>.yml  uses: cinatra-ai/ci/...    │
└────────────────────────┬─────────────────────────────────────┘
                         │ workflow_call
                         ▼
┌──────────────────────────────────────────────────────────────┐
│         Reusable Workflow                                     │
│   `.github/workflows/source-leak-gate.yml`                   │
│   Checks out caller repo + checks out this gate repo         │
│   into `.source-leak-gate/` inside the caller workspace      │
└────────────────────────┬─────────────────────────────────────┘
                         │ node invocation
                         ▼
┌──────────────────────────────────────────────────────────────┐
│         Scanner CLI                                           │
│   `scripts/source-leak-gate.mjs`  (567 lines, no deps)       │
│   ┌─────────────────────────────────────────────────────┐    │
│   │  Rule Engine  — RULES[] + profile filter            │    │
│   │  File Walker  — listTrackedFiles + shouldScan       │    │
│   │  Ratchet      — lib/touch-ratchet.mjs (167 lines)   │    │
│   └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
                         │ stdout findings / stderr summary
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  Output: text (default) or JSON (--format json)              │
│  Exit code: 0 = clean, 1 = gated findings, 2 = scanner crash │
└──────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Reusable workflow | Checkout orchestration, Node setup, diff-base env injection, invocation | `.github/workflows/source-leak-gate.yml` |
| Self-check workflow | Dogfood gate on own repo + run test suite | `.github/workflows/self-check.yml` |
| Scanner CLI | Arg parsing, file walking, rule matching, ratchet dispatch, output | `scripts/source-leak-gate.mjs` |
| Ratchet library | Git diff resolution, rename tracking, added-line number set construction | `scripts/lib/touch-ratchet.mjs` |
| Default config | No-op placeholder config consumed via `--config` | `config/default-profile.json` |
| Example config | Reference template for per-repo config authors | `config/example-config.json` |
| Test suite | Unit tests for scanner rules and ratchet logic | `scripts/__tests__/source-leak-gate.test.mjs`, `scripts/__tests__/source-leak-ratchet.test.mjs` |
| Fixture | Intentionally-marked file for test assertions (path-exempt from live gate) | `scripts/__fixtures__/source-leak.fixture.txt` |

## Pattern Overview

**Overall:** Reusable GitHub Actions workflow wrapping a self-contained Node.js CLI scanner

**Key Characteristics:**
- Zero runtime npm dependencies — only Node 24 built-ins (`fs`, `path`, `child_process`)
- Scanner is invoked directly with `node scripts/source-leak-gate.mjs`; the workflow checks out this repo into the caller's workspace and runs from there
- All project-specific token lists live in consuming repos via `--config`; this repo contains only generic, repo-agnostic defaults
- Self-exemption: rule definition region in `scripts/source-leak-gate.mjs` is bracketed by sentinel comments (`SOURCE_LEAK_RULES_BEGIN` / end) and skipped when the gate scans its own file

## Layers

**Workflow layer:**
- Purpose: GitHub Actions orchestration — checkout sequencing, environment variable injection, Node setup
- Location: `.github/workflows/`
- Contains: Two workflow YAML files (`source-leak-gate.yml` for reusable workflow_call, `self-check.yml` for dogfood CI)
- Depends on: `scripts/source-leak-gate.mjs`
- Used by: Any cinatra-ai org repo that calls `cinatra-ai/ci/.github/workflows/source-leak-gate.yml`

**Scanner CLI layer:**
- Purpose: Orchestrates file walking, rule matching, ratchet application, and output formatting
- Location: `scripts/source-leak-gate.mjs`
- Contains: `main()`, `parseArgs()`, `buildRules()`, `scanFile()`, `listTrackedFiles()`, `shouldScan()`, ratchet dispatch, output rendering; exports `buildRules`, `scanFile`, `RULES`, `readRuleDefRange`
- Depends on: `scripts/lib/touch-ratchet.mjs`, Node built-ins
- Used by: workflow YAML, local CLI invocation, test suite

**Ratchet library:**
- Purpose: Git diff helpers for line-mode ratchet — resolves a base ref, builds a rename map, returns a Set of added line numbers for a file
- Location: `scripts/lib/touch-ratchet.mjs`
- Contains: `resolveBaseRef()`, `buildRenameMap()`, `getAddedLineNumbers()`
- Depends on: `child_process.execFileSync`, git in PATH
- Used by: `scripts/source-leak-gate.mjs`

**Config layer:**
- Purpose: Provide a no-op default config and an example template for consumers
- Location: `config/`
- Contains: `default-profile.json` (empty `reqIdSinglePrefixes`/`extraRules`), `example-config.json` (annotated reference)
- Depends on: nothing
- Used by: consuming repos as a `--config` starting point; not loaded automatically by the scanner

## Data Flow

### Primary Request Path (CI on PR)

1. Consuming repo's caller workflow triggers on `pull_request` and calls `cinatra-ai/ci/.github/workflows/source-leak-gate.yml@<sha>`
2. Reusable workflow checks out caller repo (full depth) and checks out this gate repo into `.source-leak-gate/`
3. Workflow computes `SOURCE_LEAK_DIFF_BASE` from `github.event.pull_request.base.ref` and exports it as an env var
4. Workflow invokes `node .source-leak-gate/scripts/source-leak-gate.mjs --profile <p> --ratchet-mode line --exit-on-match` (`scripts/source-leak-gate.mjs` `main()`)
5. Scanner calls `listTrackedFiles()` (runs `git ls-files`), applies manifest/profile/extension filters
6. Each candidate file is passed to `scanFile()` which runs every active `RULES[]` regex line-by-line
7. Raw findings are passed to `applyLineRatchet()` in `scripts/lib/touch-ratchet.mjs` which resolves the base ref and retains only findings on git-added lines
8. Remaining findings are printed to stdout (text) or JSON; summary to stderr; exit 1 if any gated findings

### Local Development Path

1. Developer runs `node scripts/source-leak-gate.mjs --profile default --ratchet-mode off`
2. Same flow as above but ratchet is skipped — all findings are gated

### Self-Check Path

1. `self-check.yml` triggers on push to `main` or PR
2. Runs gate on this repo with `--ratchet-mode off` (every finding blocks)
3. Then runs test suite with `node --test scripts/__tests__/*.test.mjs`

**State Management:**
- No persistent state. All context is derived at scan time from git index (`git ls-files`) and diff (`git diff`).
- Ratchet baselines/allowlists are external JSON files committed in consuming repos, not here.

## Key Abstractions

**RULES array:**
- Purpose: Array of rule objects `{ id, description, re, contextExclude?, pathExclude? }` defining each marker pattern
- Examples: defined inline in `scripts/source-leak-gate.mjs` (lines ~65–200, inside `SOURCE_LEAK_RULES_BEGIN` sentinel region)
- Pattern: each rule carries its own compiled `RegExp` and optional per-line/per-path exclusion callbacks

**Ratchet modes:**
- Purpose: Control whether pre-existing findings block the gate
- Values: `line` (only newly-added lines block), `file` (allowlist-based), `baseline` (per rule+file count snapshot), `off` (all findings block)
- Implemented in: `applyLineRatchet`, `applyFileRatchet`, `applyBaselineRatchet` functions in `scripts/source-leak-gate.mjs`

**Profiles:**
- Purpose: Named rule subsets for different repo types
- Values: `default`, `ts-monorepo`, `php-wp-plugin`, `drupal-module`, `ops-docs`
- Implemented in: `buildRules()` in `scripts/source-leak-gate.mjs`

**Self-exemption sentinel:**
- Purpose: Allows the scanner's own source file to contain the markers it detects without tripping itself
- Mechanism: `readRuleDefRange()` finds `SOURCE_LEAK_RULES_BEGIN`/end comments; lines in that range are skipped when scanning the gate's own real path
- Location: `scripts/source-leak-gate.mjs`

## Entry Points

**Reusable workflow:**
- Location: `.github/workflows/source-leak-gate.yml`
- Triggers: `workflow_call` from consuming repos
- Responsibilities: Environment setup, checkout orchestration, CLI invocation

**Scanner CLI:**
- Location: `scripts/source-leak-gate.mjs` (`main()` function, guarded by `isMainModule()`)
- Triggers: Direct `node` invocation (CI or local)
- Responsibilities: Arg parsing, scan orchestration, output, exit code

**Test runner:**
- Location: `scripts/__tests__/source-leak-gate.test.mjs`, `scripts/__tests__/source-leak-ratchet.test.mjs`
- Triggers: `node --test` (used in `self-check.yml` and locally)
- Responsibilities: Unit-test RULES, scanFile, ratchet functions

## Architectural Constraints

- **Threading:** Single-threaded Node.js event loop; all file I/O is synchronous (`fs.readFileSync`)
- **Global state:** `SCANNER_REAL` and `FIXTURE_REAL` are module-level constants resolved at import time (real paths to the running gate and its fixture)
- **Circular imports:** None — `touch-ratchet.mjs` is a leaf module; `source-leak-gate.mjs` is the only importer
- **Node version:** Requires Node 24+ (uses `node --test` built-in runner)
- **Git dependency:** `git` must be in PATH; scanner calls `git ls-files` and `git diff` via `execFileSync`

## Anti-Patterns

### Reading `.env` or credential files

**What happens:** The scanner intentionally skips `.git/` and `node_modules/` but does not special-case `.env` by default
**Why it's wrong:** `.env` files may contain secrets that should never be regex-scanned or surfaced in CI logs
**Do this instead:** Consuming repos should add `.env` to `skipFilePatterns` or `skipDirs` in their per-repo config; see `config/example-config.json`

### Committing per-repo config to this shared repo

**What happens:** `config/example-config.json` is a template only; it names placeholder prefixes like `ABC`, `PROJ`
**Why it's wrong:** Project-private token lists would leak internal naming into this shared repo
**Do this instead:** Each consuming repo maintains its own config file and passes it via `--config`; this shared repo's `config/default-profile.json` is intentionally a no-op

## Error Handling

**Strategy:** Fail-fast with `process.exit(2)` for scanner crashes; `process.exit(1)` for gated findings; `process.exit(0)` for clean

**Patterns:**
- Top-level `try/catch` in `if (isMainModule())` block catches unexpected errors and prints to stderr before exit 2
- Per-ratchet-mode error returns (`{ error: string }`) are checked and converted to `fail()` calls which print and exit 2
- File read errors in `scanFile` are silently skipped (binary files, unreadable files return `[]`)

## Cross-Cutting Concerns

**Logging:** stderr for human-readable summary and per-rule counts; stdout for machine-parseable findings (text or JSON)
**Validation:** `VALID_PROFILES` and `VALID_RATCHET_MODES` checked at startup; unknown values call `fail()` immediately
**Authentication:** Not applicable — read-only `contents: read` permission; no secrets consumed

---

*Architecture analysis: 2026-06-09*
