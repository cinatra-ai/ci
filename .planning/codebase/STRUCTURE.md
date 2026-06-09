# Codebase Structure

**Analysis Date:** 2026-06-09

## Directory Layout

```
ci/                              # Repo root — shared reusable CI for cinatra-ai org
├── .github/
│   └── workflows/
│       ├── source-leak-gate.yml # Reusable workflow_call entry point
│       └── self-check.yml       # Dogfood CI: gate + tests on this repo
├── config/
│   ├── default-profile.json     # No-op default config (placeholder)
│   └── example-config.json      # Annotated reference for consuming-repo authors
├── scripts/
│   ├── source-leak-gate.mjs     # Scanner CLI (main entry point, 567 lines)
│   ├── lib/
│   │   └── touch-ratchet.mjs    # Git diff helpers for line-mode ratchet (167 lines)
│   ├── __tests__/
│   │   ├── source-leak-gate.test.mjs    # Rule and scanFile unit tests
│   │   └── source-leak-ratchet.test.mjs # Ratchet logic unit tests
│   └── __fixtures__/
│       └── source-leak.fixture.txt      # Intentionally-marked test fixture (path-exempt)
├── .gitignore
└── README.md
```

## Directory Purposes

**`.github/workflows/`:**
- Purpose: GitHub Actions workflow definitions
- Contains: Reusable `workflow_call` workflow for consuming repos; self-check dogfood workflow
- Key files: `source-leak-gate.yml`, `self-check.yml`

**`config/`:**
- Purpose: Config templates for consuming repos; not loaded automatically by the scanner
- Contains: JSON config files documenting the schema and providing a no-op default
- Key files: `default-profile.json`, `example-config.json`

**`scripts/`:**
- Purpose: All executable Node.js source
- Contains: Scanner CLI, ratchet library, tests, test fixtures
- Key files: `source-leak-gate.mjs`

**`scripts/lib/`:**
- Purpose: Internal library modules imported by the scanner CLI
- Contains: Git diff utility functions used by line-mode ratchet
- Key files: `touch-ratchet.mjs`

**`scripts/__tests__/`:**
- Purpose: Unit tests run with `node --test`
- Contains: Test files for scanner rule matching and ratchet filtering
- Key files: `source-leak-gate.test.mjs`, `source-leak-ratchet.test.mjs`

**`scripts/__fixtures__/`:**
- Purpose: Test data containing intentional marker strings; excluded from live gate scans by real-path matching
- Contains: `source-leak.fixture.txt`

## Key File Locations

**Entry Points:**
- `scripts/source-leak-gate.mjs`: CLI scanner — invoked by workflows and locally
- `.github/workflows/source-leak-gate.yml`: Reusable workflow consumed by other repos

**Configuration:**
- `config/default-profile.json`: No-op default — safe to pass as `--config` when no overrides needed
- `config/example-config.json`: Full reference showing every supported config key

**Core Logic:**
- `scripts/source-leak-gate.mjs`: `RULES[]`, `buildRules()`, `scanFile()`, ratchet dispatch, `main()`
- `scripts/lib/touch-ratchet.mjs`: `resolveBaseRef()`, `buildRenameMap()`, `getAddedLineNumbers()`

**Testing:**
- `scripts/__tests__/source-leak-gate.test.mjs`: Rule and file-scan tests
- `scripts/__tests__/source-leak-ratchet.test.mjs`: Ratchet behavior tests
- `scripts/__fixtures__/source-leak.fixture.txt`: Marker-bearing fixture data

## Naming Conventions

**Files:**
- Scanner and library: `kebab-case.mjs` (e.g., `source-leak-gate.mjs`, `touch-ratchet.mjs`)
- Tests: `<subject>.test.mjs` co-located under `__tests__/` sibling to `scripts/`
- Fixtures: `<subject>.fixture.txt` under `__fixtures__/`
- Config: `kebab-case.json` (e.g., `default-profile.json`, `example-config.json`)
- Workflows: `kebab-case.yml`

**Directories:**
- Test and fixture dirs use double-underscore dunder convention: `__tests__/`, `__fixtures__/`
- Library code under `lib/` inside the owning script directory

**Rule IDs:**
- All caps with underscore separator, `SLG_` prefix (e.g., `SLG_MILESTONE_NUMBER`, `SLG_REVIEW_LABEL`)

## Where to Add New Code

**New scan rule:**
- Add to the `RULES` array in `scripts/source-leak-gate.mjs` inside the `SOURCE_LEAK_RULES_BEGIN` / end sentinel region
- Add corresponding test cases to `scripts/__tests__/source-leak-gate.test.mjs`
- Add fixture examples to `scripts/__fixtures__/source-leak.fixture.txt`

**New ratchet mode:**
- Add mode string to `VALID_RATCHET_MODES` in `scripts/source-leak-gate.mjs`
- Implement `applyXxxRatchet()` function in `scripts/source-leak-gate.mjs`
- Add git diff helpers (if needed) to `scripts/lib/touch-ratchet.mjs`
- Add tests to `scripts/__tests__/source-leak-ratchet.test.mjs`

**New profile:**
- Add profile string to `VALID_PROFILES` and extend `buildRules()` filter logic in `scripts/source-leak-gate.mjs`
- Update `README.md` input table

**New workflow:**
- Add to `.github/workflows/` following `kebab-case.yml` naming

**New config key:**
- Document in `config/example-config.json`
- Handle in `loadConfig()` and wire into the appropriate scanner option in `main()` in `scripts/source-leak-gate.mjs`

## Special Directories

**`.source-leak-gate/`:**
- Purpose: Checkout path used by the reusable workflow — the gate repo is checked out here inside the caller's workspace at CI runtime
- Generated: Yes (by `actions/checkout` during CI runs)
- Committed: No — exists only in CI runner workspaces; added to `DEFAULT_SKIP_DIRS` in the scanner so it is never scanned

**`.planning/`:**
- Purpose: Internal planning documents (analysis output, etc.)
- Generated: Yes (by tooling)
- Committed: Yes — permitted in this repo; excluded from scanning by `PRIVATE_PREFIXES` constant in the scanner

**`.claude/`:**
- Purpose: Claude/AI tooling configuration
- Excluded from scanning by `PRIVATE_PREFIXES` constant in the scanner

---

*Structure analysis: 2026-06-09*
