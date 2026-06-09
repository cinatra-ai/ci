# Coding Conventions

**Analysis Date:** 2026-06-09

## Naming Patterns

**Files:**
- kebab-case for script files: `source-leak-gate.mjs`, `touch-ratchet.mjs`
- kebab-case with double-underscore prefix for test/fixture dirs: `__tests__/`, `__fixtures__/`
- kebab-case for config files: `default-profile.json`, `example-config.json`

**Functions:**
- camelCase for all exported and internal functions: `buildRules`, `scanFile`, `resolveBaseRef`, `buildRenameMap`, `getAddedLineNumbers`, `verifyGitRef`
- camelCase for local helpers: `matchRule`, `fixtureLines`, `setupRepo`, `runGate`

**Variables:**
- camelCase for local variables: `byId`, `active`, `ruleId`, `payload`
- SCREAMING_SNAKE_CASE for module-level constants: `SCANNER_VERSION`, `SCANNER_REAL`, `FIXTURE_REAL`, `DEFAULT_DIFF_BASE_ENV`, `VALID_PROFILES`, `VALID_RATCHET_MODES`, `DEFAULT_SKIP_DIRS`, `DEFAULT_SCAN_EXTENSIONS`, `RULES`, `PRIVATE_PREFIXES`, `PRIVATE_EXACT`, `EXEMPT_FILE_BASENAMES`

**Types:**
- Not applicable (no TypeScript; project uses `.mjs` ESM JavaScript)

**Rule IDs:**
- SCREAMING_SNAKE_CASE with `SLG_` prefix: `SLG_MILESTONE_NUMBER`, `SLG_MILESTONE_SHORTHAND`, `SLG_VERSIONED_MILESTONE`, `SLG_REQ_ID_SINGLE`

## Code Style

**Formatting:**
- No formatter config detected (no `.prettierrc`, `biome.json`, or `eslint.config.*`)
- Style is consistent in practice: 2-space indentation, single-quoted strings in test files, double-quoted strings in main source

**Linting:**
- No linter config detected (no `.eslintrc*`)
- Code is lint-clean by convention without tooling enforcement

## Import Organization

**Order (observed in `scripts/__tests__/source-leak-gate.test.mjs` and `scripts/__tests__/source-leak-ratchet.test.mjs`):**
1. Node built-in modules (`node:test`, `node:assert/strict`, `node:fs`, `node:os`, `node:path`, `node:child_process`)
2. Local project imports (`../source-leak-gate.mjs`, `../lib/touch-ratchet.mjs`)

**Path Aliases:**
- None — bare relative paths used throughout

**Module Format:**
- ESM throughout (`.mjs` extension, `import`/`export` syntax)
- No CommonJS (`require`) usage

## Error Handling

**Patterns:**
- Throw `Error` with descriptive human-readable messages for hard failures (e.g., bad git ref in `scripts/lib/touch-ratchet.mjs`)
- `try/catch` with empty catch blocks used to defensively compute derived values at module load time (e.g., `SCANNER_REAL`, `FIXTURE_REAL` initialization)
- Tests use `finally` blocks for temp directory cleanup, ensuring cleanup on assertion failure
- CLI exits with distinct codes: `0` = clean, `1` = match found, `2` = invocation error

## Logging

**Framework:** None — `console.error` / `console.log` to stderr/stdout directly

**Patterns:**
- `--quiet` flag suppresses non-error output in the gate CLI
- Errors printed to stderr; findings to stdout unless quiet

## Comments

**When to Comment:**
- Module-level JSDoc block at top of each file describing purpose, design decisions, and constraints: `scripts/source-leak-gate.mjs`, `scripts/lib/touch-ratchet.mjs`
- Inline comments explain non-obvious logic, especially security decisions (e.g., `execFileSync` over shell, `--end-of-options` flag)
- Section sentinel comments used to bracket self-exempt rule definition region: `// ===================== SOURCE_LEAK_RULES_BEGIN =====================`
- Test setup comments explain why marker strings are assembled at runtime rather than written literally (to avoid self-flagging)

**JSDoc/TSDoc:**
- Used for module-level and exported function documentation in `scripts/lib/touch-ratchet.mjs`
- Not used for every function; reserved for public API and non-obvious behavior

## Function Design

**Size:** Functions are small and single-purpose; helpers like `matchRule`, `fixtureLines`, `setupRepo`, `git`, `commit`, `runGate`, `rm` are all under ~10 lines

**Parameters:** Plain positional parameters; no options-object pattern

**Return Values:**
- Numbers (match counts, exit codes)
- Arrays of findings or matched lines
- `null` for "not resolvable / strict mode" (e.g., `resolveBaseRef` returns `null`)

## Module Design

**Exports:**
- Named exports only: `buildRules`, `scanFile` from `scripts/source-leak-gate.mjs`; `resolveBaseRef`, `buildRenameMap`, `getAddedLineNumbers`, `verifyGitRef` from `scripts/lib/touch-ratchet.mjs`
- No default exports

**Barrel Files:**
- Not used (small codebase, direct imports)

## Security Conventions

- All `git` invocations use `execFileSync` (array args, no shell interpolation) and `--end-of-options` to prevent argument injection: `scripts/lib/touch-ratchet.mjs`
- Self-exemption is keyed to the real (resolved symlink) file path, not the relative path, to prevent caller repos from spoofing the exemption: `scripts/source-leak-gate.mjs`
- Fixtures and baseline files are path-exempt by real path, not by name pattern

---

*Convention analysis: 2026-06-09*
