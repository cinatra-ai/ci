# Codebase Concerns

**Analysis Date:** 2026-06-09

## Tech Debt

**No package.json / no declared Node version constraint:**
- Issue: The repo has no `package.json`, so there is no `engines` field or lockfile. Node 24+ is required (ESM `node:test`, `import.meta.dirname`), but this constraint is stated only in `README.md` prose and enforced implicitly by CI's `node-version: "24"` in `.github/workflows/self-check.yml`.
- Files: `README.md`, `.github/workflows/self-check.yml`
- Impact: A developer running Node < 22 (no `import.meta.dirname`) or < 18 (no `node:test`) will get opaque runtime errors rather than a clear version gate. There is nothing stopping `npm install` or `node` invocations from being attempted on older runtimes.
- Fix approach: Add a minimal `package.json` with `"type": "module"` and `"engines": { "node": ">=24" }`. This also enables `npm test` as the standard entry point and allows tooling (Renovate, Dependabot) to track runtime versioning.

**Profiles declared but never filtered on in `buildRules`:**
- Issue: Every rule in `RULES` is emitted with `profiles: r.profiles || VALID_PROFILES`, but no individual built-in rule sets a `profiles` array — they all default to `VALID_PROFILES` (all profiles). The `active` filter at line 280 of `scripts/source-leak-gate.mjs` therefore never narrows the active ruleset by profile. The `profile` input exists and is validated, but has zero effect on the built-in rule set.
- Files: `scripts/source-leak-gate.mjs` lines 245–292
- Impact: The `ts-monorepo`, `php-wp-plugin`, `drupal-module`, and `ops-docs` profiles are advertised as distinct rule sets but produce identical output. Consumers who supply `--profile php-wp-plugin` expecting a PHP-tailored scan get the same rules as `--profile default`. This is misleading documentation and creates silent false confidence.
- Fix approach: Either add a `profiles` property to individual rules to scope them correctly, or document that profiles currently only affect consumer-supplied `extraRules` and remove the profile-filtering code until it is actually needed.

**`config/default-profile.json` is a no-op placeholder with no enforcement:**
- Issue: `config/default-profile.json` exists as a placeholder comment file with empty arrays; it is never loaded automatically — it is only used if a caller explicitly passes `--config config/default-profile.json`. There is no mechanism to ensure this file stays in sync with the actual defaults inside the script.
- Files: `config/default-profile.json`
- Impact: Consumers who copy or reference `default-profile.json` may incorrectly assume it defines the default scan behaviour.
- Fix approach: Either remove the file and rely only on inline defaults, or add a CI step that validates the file is still consistent with script defaults.

## Known Bugs

**`SLG_HISTORICAL` contextExclude false-negative (fixture MISS line is overly narrow):**
- Symptoms: The MISS fixture line `MISS:SLG_HISTORICAL:the cache used to be invalidated on write` relies on the phrase "used to be invalidated" not matching the rule's regex. However the rule `re: /\bused\s+to\s+be\s+called\b/gi` does not fire on "invalidated" — the miss is a true miss. But the `contextExclude` function for this rule is not defined at all, so there is no explicit suppression of near-miss prose. This is currently correct but the intent is unclear in the code, making it fragile to rule rewrites.
- Files: `scripts/source-leak-gate.mjs` lines 165–169
- Trigger: Regex change that widens `SLG_HISTORICAL`.
- Workaround: Not applicable (currently correct).

**`applyBaselineRatchet` silently gates everything when `--gate-baseline` is omitted in baseline mode:**
- Symptoms: If `ratchet_mode=baseline` is passed without `--gate-baseline`, the function returns `{ blockers: findings, note: "baseline mode without --gate-baseline (all findings gated)" }` — all findings block. This is described only in the return note string; no warning is written to stderr or logged visibly to the user before the gate exits.
- Files: `scripts/source-leak-gate.mjs` lines 442–446
- Trigger: Caller misconfigures their workflow with `ratchet_mode: baseline` but forgets `gate_baseline`.
- Workaround: The note string appears in stderr summary line, but only if `--quiet` is not set.

## Security Considerations

**`ref` input defaults to `main` (mutable) — not pinned to SHA by default:**
- Risk: The reusable workflow's `ref` input defaults to `"main"`, meaning a supply-chain compromise of this `cinatra-ai/ci` repo would immediately affect all callers unless they have explicitly pinned to a SHA. The README warns about this but the default itself is unsafe.
- Files: `.github/workflows/source-leak-gate.yml` lines 44–46, `README.md` lines 35–39
- Current mitigation: README contains a prominent warning ("pin BOTH to the same commit SHA"); the workflow comment also warns. The actions/checkout step in the workflow is SHA-pinned.
- Recommendations: Change the default value of `ref` to an empty string and make the gate fail if `ref` resolves to a branch name (not a SHA). This forces every caller to pin explicitly.

**Caller-controlled `--manifest`, `--config`, `--legacy-allowlist`, `--gate-baseline` paths read from the filesystem without path traversal checks:**
- Risk: These arguments accept arbitrary file paths. A malicious config or manifest at an attacker-controlled path could be read. In GitHub Actions context, the paths come from caller workflow inputs, which are caller-controlled — but within the repository.
- Files: `scripts/source-leak-gate.mjs` lines 236–243, 321–338, 420–426, 443–448
- Current mitigation: All git invocations use `execFileSync` (no shell), and `--end-of-options` is used consistently in `scripts/lib/touch-ratchet.mjs`. File reads are limited to the repository being scanned.
- Recommendations: Not applicable for typical threat model; document that `--config` should only be a path within the caller repo.

**`execSync` used once for `git rev-parse HEAD` in `writeGateBaseline`:**
- Risk: Unlike all other git invocations (which use `execFileSync`), the `writeGateBaseline` function at line 463 uses `execSync` (shell-interpreted). This is inconsistent with the explicit no-shell policy documented in `touch-ratchet.mjs` and could introduce a shell injection vector if `git` is ever replaced by a wrapper in a compromised environment.
- Files: `scripts/source-leak-gate.mjs` line 463
- Current mitigation: No user input is interpolated into the string `"git rev-parse HEAD"`.
- Recommendations: Replace `execSync("git rev-parse HEAD", ...)` with `execFileSync("git", ["rev-parse", "HEAD"], ...)` for consistency and defense-in-depth.

## Performance Bottlenecks

**Large file skip threshold is 2 MB (hardcoded):**
- Problem: Files larger than 2,000,000 bytes are silently skipped (`scripts/source-leak-gate.mjs` line 367). For repos with large generated JSON or SQL dumps just under the threshold, scanning is slow because the entire file is read into memory before regex application.
- Files: `scripts/source-leak-gate.mjs` line 367
- Cause: No streaming — `fs.readFileSync` loads the whole file. The 2 MB cap is a hard size guard but not configurable.
- Improvement path: Make the size cap configurable via `config.maxFileSizeBytes`; add a streaming line-by-line reader for files above a lower threshold.

**`applyLineRatchet` calls `getAddedLineNumbers` once per unique file, but `git diff` is invoked per file:**
- Problem: For a PR touching 100 files, 100 separate `git diff` subprocesses are spawned sequentially.
- Files: `scripts/source-leak-gate.mjs` lines 394–405, `scripts/lib/touch-ratchet.mjs` lines 120–167
- Cause: The cache in `applyLineRatchet` avoids duplicate calls for the same file but cannot batch the git calls.
- Improvement path: Acceptable for typical CI scan sizes (< 1,000 files). No immediate action needed unless scan times exceed CI timeout.

## Fragile Areas

**Self-exemption keyed to `realpathSync` of the running gate file:**
- Files: `scripts/source-leak-gate.mjs` lines 31–40, 371–379
- Why fragile: The exemption for the rule-definition sentinel block works by comparing `realpathSync` of the scanned file against the running gate's own real path. If the gate is invoked through a symlink that resolves to the same inode, or if it is run from a path where `realpathSync` fails (e.g., deleted-but-open file), the exemption silently drops (empty string comparison never matches) and the gate may report false positives on itself. The `FIXTURE_REAL` path-exemption has the same characteristic.
- Safe modification: Always run the gate from a stable filesystem path. Test `realpathSync` failure paths before changing the startup exemption logic.
- Test coverage: `source-leak-gate.test.mjs` test "the gate is clean on its own source" covers the happy path; no test for `realpathSync` failure.

**Ratchet mode validation happens after config and rules are built:**
- Files: `scripts/source-leak-gate.mjs` lines 483–488
- Why fragile: `main()` builds rules (including loading and parsing the external `--config` file) before validating `--ratchet-mode`. An invalid ratchet mode therefore triggers a `fail()` exit only after potentially expensive config parsing.
- Safe modification: Move `ratchetMode` validation to immediately after `parseArgs`.
- Test coverage: Not tested.

**`walk()` fallback in `listTrackedFiles` skips `DEFAULT_SKIP_DIRS` but not `skipDirs` from config:**
- Files: `scripts/source-leak-gate.mjs` lines 294–303, 305–319
- Why fragile: When `git ls-files` fails (non-git directory), `walk()` is called with only the hardcoded `DEFAULT_SKIP_DIRS`. Config-supplied `skipDirs` are applied to the file list after collection via `shouldScan`, so this is technically correct — but the code flow is non-obvious and could easily be broken by a future refactor that tries to pass `skipDirs` to `walk()`.
- Safe modification: Add a comment at the `walk()` call site explaining that `shouldScan` provides the second-pass filter.

## Scaling Limits

**Single-file scanner with no worker threads:**
- Current capacity: Adequate for typical application repos (< 5,000 source files).
- Limit: For very large monorepos (50,000+ files), sequential scanning with per-file `readFileSync` + regex loops becomes measurably slow. The `timeout-minutes: 5` CI cap in both workflows could be hit.
- Scaling path: Parallelise file scanning using `worker_threads` (Node 12+) with a work-stealing queue.

## Dependencies at Risk

**Zero runtime dependencies — Node built-ins only:**
- Risk: Not applicable. No third-party dependencies means no supply-chain risk.
- Impact: Node 24 LTS is the only external runtime dependency. If Node 24 reaches EOL, all consumers must upgrade together.
- Migration plan: The `engines` constraint (once added to `package.json`) will surface this automatically.

## Missing Critical Features

**No version tagging / release process:**
- Problem: The README instructs consumers to pin to a SHA ("pin BOTH to the same commit SHA") but there are no version tags (e.g., `v1.0.0`) in the repository. Consumers must manually discover the latest SHA from `main`.
- Blocks: Consumers cannot use Renovate/Dependabot to track releases; there is no clear upgrade surface.

**No `--help` output:**
- Problem: Running `node scripts/source-leak-gate.mjs` with no arguments silently scans the working directory with defaults and exits 0. There is no `--help` flag to print usage.
- Blocks: Discoverability for developers onboarding to the tool.

**Profile differentiation is unimplemented (see Tech Debt above):**
- Problem: The `ts-monorepo`, `php-wp-plugin`, `drupal-module`, and `ops-docs` profiles are accepted inputs but produce identical rule sets to `default`.
- Blocks: Consumers who set `profile: php-wp-plugin` expecting PHP-specific suppression or addition of rules get no differentiation.

## Test Coverage Gaps

**No tests for `--format json` output shape:**
- What's not tested: The JSON output path (`buildSummary` + `process.stdout.write`) is never exercised by the test suite.
- Files: `scripts/source-leak-gate.mjs` lines 474–480, 539–540
- Risk: A refactor of `buildSummary` field names could silently break downstream consumers parsing JSON output.
- Priority: Medium

**No tests for config `extraRules` with `pathExcludes`:**
- What's not tested: The `pathExclude` closure added to extra rules (line 274 of `scripts/source-leak-gate.mjs`) is never invoked in tests.
- Files: `scripts/source-leak-gate.mjs` lines 268–275
- Risk: Path-based exclusions in `extraRules` could silently stop working.
- Priority: Low

**No tests for `writeGateBaseline` output format:**
- What's not tested: `--write-gate-baseline` flag and the resulting JSON file structure.
- Files: `scripts/source-leak-gate.mjs` lines 460–467
- Risk: A format change could break consumers who generate baselines in CI and commit them.
- Priority: Medium

**No tests for the `walk()` fallback path (non-git directory):**
- What's not tested: `listTrackedFiles` fallback when `git ls-files` fails.
- Files: `scripts/source-leak-gate.mjs` lines 294–303
- Risk: The fallback walk could silently scan or skip files differently from the git path.
- Priority: Low

**`SLG_MILESTONE_VERSION` contextExclude has many branches; only a few are covered by MISS fixtures:**
- What's not tested: Lines 195–202 of `scripts/source-leak-gate.mjs` contain 10+ `contextExclude` branches for `SLG_MILESTONE_VERSION`; only 2 MISS cases exist in the fixture.
- Files: `scripts/__fixtures__/source-leak.fixture.txt`, `scripts/source-leak-gate.mjs` lines 183–204
- Risk: Regression in any untested exclusion branch goes undetected.
- Priority: High — this is the most complex rule with the most contextual carve-outs.

---

*Concerns audit: 2026-06-09*
