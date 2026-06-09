# Technology Stack

**Analysis Date:** 2026-06-09

## Languages

**Primary:**
- JavaScript (ESM) - All scanner and library logic in `scripts/`

**Secondary:**
- YAML - GitHub Actions workflow definitions in `.github/workflows/`
- JSON - Configuration profiles in `config/`

## Runtime

**Environment:**
- Node.js 24+ (required; enforced by `.github/workflows/self-check.yml` via `actions/setup-node` with `node-version: "24"`)

**Package Manager:**
- None — zero dependencies, no `package.json` present
- Lockfile: Not applicable

## Frameworks

**Core:**
- None — deliberately dependency-free; uses only Node.js built-in modules (`node:child_process`, `node:fs`, `node:path`, `node:url`)

**Testing:**
- Node.js built-in test runner (`node --test`) — no external test framework
- Test files: `scripts/__tests__/source-leak-gate.test.mjs`, `scripts/__tests__/source-leak-ratchet.test.mjs`

**Build/Dev:**
- No build step — scripts are run directly with `node`

## Key Dependencies

**Critical:**
- None — intentional design decision; README states "Zero runtime dependencies (Node built-ins only)"

**Infrastructure:**
- `actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10` (v6.0.3) — used in both workflows
- `actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` (v6.4.0) — sets up Node 24

## Configuration

**Environment:**
- `SOURCE_LEAK_DIFF_BASE` — env var consumed by `scripts/source-leak-gate.mjs`; set by the reusable workflow to the PR base ref for line-ratchet mode

**Build:**
- No build config files; scripts are run directly

**Scanner Config Inputs (runtime flags):**
- `--profile` — selects rule profile (`default`, `ts-monorepo`, `php-wp-plugin`, `drupal-module`, `ops-docs`)
- `--config` — path to per-repo JSON config (see `config/example-config.json`)
- `--ratchet-mode` — `line` | `file` | `baseline` | `off`
- `--manifest`, `--rules`, `--legacy-allowlist`, `--gate-baseline`, `--exit-on-match`, `--format`

**Default profile config:** `config/default-profile.json` (no-op; all rules are built into the scanner)
**Example per-repo config:** `config/example-config.json`

## Platform Requirements

**Development:**
- Node.js 24+
- Git (required by scanner for diff-based ratchet logic via `execFileSync`)

**Production:**
- GitHub Actions runners (`ubuntu-latest`)
- Consumed as a reusable workflow via `cinatra-ai/ci/.github/workflows/source-leak-gate.yml@<sha>`

---

*Stack analysis: 2026-06-09*
