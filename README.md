# cinatra-ai/ci

Shared, reusable CI for the cinatra-ai organization.

Org-wide conventions documented here:

- **[The release contract](docs/release-contract.md)** — what a tagged release
  is and carries per repo type (PR-list notes, archives, npm tarballs), the
  packlist gate, the `files`-allowlist and `.gitattributes export-ignore`
  conventions, and how to wire a repo's thin caller. The reusable release
  workflows themselves live in
  [`cinatra-ai/.github`](https://github.com/cinatra-ai/.github).

## source-leak-gate

A reusable GitHub Actions workflow + scanner that fails CI when **internal
process artifacts** leak into committed source — numbered milestones, internal
requirement/workstream IDs, review labels, history breadcrumbs, internal
planning-document names, decision-record pointers, and similar. These belong in
issues and pull-request descriptions, not in the code itself.

The default ruleset is **generic and repo-agnostic**. Project-specific token
lists (single-prefix IDs, internal host/handle/channel names, and the like) are
supplied by each consuming repo through its own `--config` file, so this shared
repo never has to name anything project-private.

### Use it from another repo

Add a thin caller workflow:

```yaml
name: source-leak-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  source-leak-gate:
    # In production pin BOTH to the same commit SHA: the workflow ref (`@<sha>`)
    # and the `ref` input below — otherwise the scanner code is still pulled from
    # mutable `main`.
    uses: cinatra-ai/ci/.github/workflows/source-leak-gate.yml@main  # @<sha> in prod
    with:
      profile: default
      ratchet_mode: line
      ref: main  # set to the same <sha> in production
```

Suggested per-repo profiles: `cinatra` → `ts-monorepo`, `wordpress-plugin` →
`php-wp-plugin`, `drupal-module` → `drupal-module`.

### Inputs

| Input | Default | Meaning |
|-------|---------|---------|
| `profile` | `default` | Rule profile: `default`, `ts-monorepo`, `php-wp-plugin`, `drupal-module`, `ops-docs`. |
| `manifest` | _(none)_ | Include/negation manifest to scope the scan to a published file set. |
| `config` | _(none)_ | Per-repo JSON config (extra rules, token lists, scope tweaks). |
| `rules` | _(all)_ | Comma-separated rule-ID allowlist. |
| `ratchet_mode` | `line` | `line` (block only newly-added findings), `file` (legacy allowlist), `baseline` (per rule+file count), `off` (block everything). |
| `legacy_allowlist` | _(none)_ | JSON allowlist for `file` mode. |
| `gate_baseline` | _(none)_ | JSON baseline for `baseline` mode. |
| `ref` | `main` | Ref of this repo to check out (pin to a SHA in production). |

### File-name (path) scanning

In addition to file **content**, the gate scans each file's **path** so a leaky
file or directory name (e.g. `phase-553/`, `v6.13-ROADMAP.md`, `GSD-001-notes/`)
is caught even when the content is clean or the file is binary. Paths are scanned
**per-segment** (split on `/`) with a curated, low-false-positive rule subset
(numbered milestones, versioned milestone/planning-doc names, numeric workstream
IDs); broad/ambiguous rules are deliberately excluded from path scanning to avoid
false positives on `api/v2/`, ECC `P-256/`, hashed/date slugs, and locale codes.
Path findings report `line: 0` and are ratcheted by **introduced path** (added /
renamed-to / copied-to vs the base) in `line` mode, and by the legacy allowlist
in `file` mode — so pre-existing leaky names are tolerated and only newly
introduced ones block.

### Ratchet modes

- **line** (default): only findings on lines the PR added (and paths the PR
  introduced) block the merge; pre-existing findings are tolerated. Needs full
  history (`fetch-depth: 0`).
- **file**: findings block unless the file is in a committed legacy allowlist
  and untouched by the PR; touched allowlisted files must be scrubbed; stale
  allowlist entries block.
- **baseline**: a marker-free per-(rule, file) count snapshot; only counts above
  the baseline block.
- **off**: every finding blocks (used by this repo's own self-check).

### Per-repo config

See [`config/example-config.json`](config/example-config.json). A config may add
`reqIdSinglePrefixes`, `extraRules`, `lineExcludes`, `scanExtensions`,
`skipDirs`, and `exemptDirPrefixes`. Keep your config in your own repo.

### Run locally

```sh
node scripts/source-leak-gate.mjs --profile default --ratchet-mode off
```

Add `--exit-on-match` to make it a gate, `--format json` for machine output.

### Self-exemption

The scanner's rule definitions necessarily contain the markers they detect, so
that region is bracketed by sentinel comments and skipped when the gate scans
its own source. Dedicated test fixtures and baselines are path-exempt. For the
same reason, the `actions-pinned-gate` source and tests contain the version
comments they enforce, so this repo's own self-check passes
[`config/self-check.json`](config/self-check.json) to exempt those two files
from its scan — consuming repos never receive that config. The
[`self-check`](.github/workflows/self-check.yml) workflow proves the gate runs
clean on this repository and that the test suite passes.

### Develop

```sh
node --test scripts/__tests__/source-leak-gate.test.mjs scripts/__tests__/source-leak-ratchet.test.mjs
```

## gitignore-gate

A reusable GitHub Actions workflow + check that fails CI when a repo's root
`.gitignore` is **missing, empty, or whitespace-only** (or not a regular file —
git ≥ 2.32 does not follow a symlinked `.gitignore`). A comment-only
`.gitignore` passes (presence is the contract); the text output reports the
effective entry count so a hollow file stays visible.

### Baseline template

[`config/baseline.gitignore`](config/baseline.gitignore) is the org-wide
baseline: node/pnpm dependencies, monorepo build output, logs/caches, OS cruft,
editor dirs, and env files/secrets. To adopt it in a repo without a
`.gitignore`:

```sh
curl -fsSL https://raw.githubusercontent.com/cinatra-ai/ci/main/config/baseline.gitignore -o .gitignore
```

then append project-specific entries below the baseline block. Repos that
already have a `.gitignore` should merge the baseline entries into it rather
than replace the file (and drop any baseline entry they deliberately commit,
e.g. `.vscode/`).

### Use it from another repo

Add a thin caller workflow:

```yaml
name: gitignore-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  gitignore-gate:
    # In production pin BOTH to the same commit SHA: the workflow ref (`@<sha>`)
    # and the `ref` input below — otherwise the gate code is still pulled from
    # mutable `main`.
    uses: cinatra-ai/ci/.github/workflows/gitignore-gate.yml@main  # @<sha> in prod
    with:
      ref: main  # set to the same <sha> in production
```

### Run locally

```sh
node scripts/gitignore-gate.mjs
```

Add `--root <dir>` to check another checkout, `--format json` for machine
output. Exit codes: `0` pass, `1` gate failure, `2` usage/internal error.

### Develop

```sh
node --test scripts/__tests__/gitignore-gate.test.mjs
```

Zero runtime dependencies (Node built-ins only); requires Node 24+.

## actions-pinned-gate

A reusable GitHub Actions workflow + scanner that fails CI when any **remote
`uses:` ref** in the caller repo's GitHub Actions YAML (`.github/workflows/**`
workflows and `.github/actions/**` local composite actions) is not pinned to an
immutable 40-char commit SHA carrying a version comment that matches the
upstream tag (`# vX.Y.Z`, or `# X.Y.Z` for upstreams that tag without a `v`
prefix, e.g. `shivammathur/setup-php` tags `2.37.2`). A moved upstream tag
(`@v6`) can silently run new code against the caller's `GITHUB_TOKEN`; an
immutable SHA cannot. The SHA pin is the security control; the comment is the
version-of-record that Renovate uses to keep the pin fresh, so it must equal a
real upstream tag.

It is a purely-offline **format** check: it does not resolve SHAs upstream, and
it deliberately exempts local `./` and `docker://` refs. The parser is hardened
against the realistic bypass/false-positive vectors (quoted/space-before-colon
`uses` keys, single-line flow mappings, `run: |` block-scalar bodies) and is
fail-closed: a `uses:`-bearing construct it cannot verify is flagged loudly
rather than skipped.

### Use it from another repo

Add a thin caller workflow:

```yaml
name: actions-pinned-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  actions-pinned-gate:
    # In production pin BOTH to the same commit SHA: the workflow ref (`@<sha>`)
    # and the `ref` input below — otherwise the scanner code is still pulled from
    # mutable `main`.
    uses: cinatra-ai/ci/.github/workflows/actions-pinned-gate.yml@main  # @<sha> in prod
    with:
      ref: main  # set to the same <sha> in production
```

### Inputs

| Input | Default | Meaning |
|-------|---------|---------|
| `ref` | `main` | Ref of this repo to check out (pin to a SHA in production). |

### Run locally

```sh
node scripts/actions-pinned-gate.mjs
```

Exits non-zero listing every offending `file:line` when a remote ref is
unpinned or missing its version comment.

### Develop

```sh
node --test scripts/__tests__/actions-pinned-gate.test.mjs
```

Zero runtime dependencies (Node built-ins only); requires Node 24+. The
fail-closed behavior (a deliberately unpinned ref fails the gate) is exercised
by unit fixtures in the test suite, and the [`self-check`](.github/workflows/self-check.yml)
workflow dogfoods the gate against this repository's own workflows.

## ui-design-system-gate

A reusable GitHub Actions workflow + shareable ESLint flat-config preset
([`config/ui-design-system.flat.mjs`](config/ui-design-system.flat.mjs)) that
enforces "UI work uses shadcn":

- **Imports (`error`)**: bans Radix (`@radix-ui/*`, `radix-ui`) and non-shadcn
  UI libraries (MUI, Chakra, antd, Mantine, Emotion, styled-components,
  HeadlessUI) plus the Drizzle Cube client surface (`drizzle-cube/client*`,
  `react-grid-layout`) outside their carve-outs.
- **Raw JSX (`warn`, configurable)**: flags raw `<button>`, `<input>`,
  `<select>`, `<textarea>`, `<a>` in favor of the shadcn wrappers.
- **Carve-outs as `files` globs (never inline `eslint-disable`)**: the
  vendored shadcn primitive dirs re-allow Radix; the Drizzle Cube
  dashboard-components dirs re-allow `drizzle-cube/client*` and
  `react-grid-layout` only; `__tests__/fixtures/` dirs are exempt.
- `recharts` is the allowed shadcn chart primitive — never banned, never
  Drizzle-scoped.

Lint prohibits non-shadcn UI; it cannot prove a rendered component is shadcn.

### Use it from another repo

Spread the preset into the repo's **own** `eslint.config.mjs` (vendor the
preset file or restate its blocks — local dev and CI must agree), then add a
thin caller:

```yaml
name: ui-design-system-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  ui-design-system-gate:
    # In production pin to a commit SHA.
    uses: cinatra-ai/ci/.github/workflows/ui-design-system-gate.yml@main  # @<sha> in prod
    with:
      strictness: warn
```

The gate installs the caller's dependencies (lockfile auto-detected) and runs
plain ESLint against the repo's own flat config — never a generated one. The
typed inputs are forwarded as `UI_DESIGN_SYSTEM_*` environment variables which
the preset reads as defaults (explicit options in the repo's config win).

### Inputs

| Input | Default | Meaning |
|-------|---------|---------|
| `ui_globs` | `**/components/ui/**,**/src/ui/**` | shadcn primitive dirs: Radix re-allowed, raw-JSX rules off. |
| `drizzle_cube_globs` | `**/packages/dashboards/src/components/**` | Dirs where `drizzle-cube/client*` and `react-grid-layout` are re-allowed. |
| `strictness` | `warn` | Severity of the raw-JSX rules: `warn` \| `error`. |
| `install_command` | _(auto-detect)_ | Override the dependency install command. |
| `lint_command` | `npx eslint .` | ESLint invocation loading the repo's own config. |

### Develop

```sh
npm ci
npx eslint .   # dogfood: the preset runs clean on this repo
node --test scripts/__tests__/ui-design-system-gate.test.mjs
```

The test harness asserts the preset's outcome on a fixture tree: negative
fixtures (raw `<button>`, Radix outside `ui/`, banned UI libraries,
out-of-carve-out Drizzle Cube imports) must be flagged; positive controls
(shadcn primitives, the Drizzle Cube carve-out, `recharts`, wrapper usage)
must be clean.

## skills-drift-gate

A reusable GitHub Actions workflow + scanner that flags when a **cinatra** PR
changes a surface an [`assistant-skills`](https://github.com/cinatra-ai/assistant-skills)
`SKILL.md` depends on — an MCP **primitive** name (e.g. `agent_run`,
`agent_run_get`), an `@cinatra-ai/*` **package** name, or a **route** string —
so the impacted skill is reviewed before it silently goes stale.

> **Scope: cinatra only.** This gate is wired into the `cinatra` repo and
> nothing else. It is **not** part of the org-wide min-repo-config rollout — no
> other repo calls it, because cinatra is the only repo whose changes can drift
> the `assistant-skills` knowledge.

### Stage 1 — warn mode (heuristic match)

It ships in **warn** mode first: it extracts identifiers from the cinatra PR
diff (both **added and removed** lines across `merge-base…head`, so a rename —
whose effect lands on the removed-identifier line — is caught), intersects them
with the identifiers that appear verbatim in any `SKILL.md`, and reports which
surfaces changed and which skills reference them as a **non-failing** warning
(workflow annotations + a step summary; the check stays green). The documented
graduation path is **skill-declared watches** for `enforce` mode (a skill
declares the surfaces — including source-path globs — it depends on, lowering
false positives), available via `mode: enforce`.

Identifier classes are shaped to keep prose out: primitives must be
`lower_snake_case` with at least one underscore (a bare English word never
matches); packages must carry the canonical `@cinatra-ai/` scope; routes must
sit under a known root (`api`, `app`, `agents`, …) with a sub-segment.

### Acknowledgement / override

A flagged PR resolves the warning by one of (mirroring `source-leak-gate`'s
override ergonomics):

- **(a)** link an `assistant-skills` PR that updates the impacted skill(s); or
- **(b)** a recorded **`Skills-reviewed: <note>`** trailer (checked + updated); or
- **(c)** an explicit **`Skills-unaffected: <reason>`** trailer (recorded override).

The caller concatenates the PR body + commit messages into an ack file; the gate
parses these trailers and reports them. In `warn` mode they never change the
exit code; in `enforce` mode an unacknowledged finding gates and any recorded
ack clears it.

### Use it from cinatra

```yaml
name: skills-drift-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  # The JOB name is the required-check context prefix (see below) — keep it
  # stable as `skills-drift-gate`.
  skills-drift-gate:
    uses: cinatra-ai/ci/.github/workflows/skills-drift-gate.yml@main  # @<sha> in prod
    with:
      # Pin to the assistant-skills SHA cinatra already records in
      # cinatra-required-extensions.lock.json (the @cinatra-ai/assistant-skills
      # entry's resolvedSha) — keep this in lockstep so the gate reads the same
      # skills the product ships.
      skills_ref: <assistant-skills SHA>
      mode: warn
      ref: main  # set to the same <sha> as the workflow @ref in production
```

### Required-check context

A reusable `workflow_call` does **not** produce a check context under its own
name — the context is surfaced under the **caller's job name**, formatted
`<caller-job> / <reusable-job>`. With both named `skills-drift-gate`, register
**`skills-drift-gate / skills-drift-gate`** as the required status check on
cinatra (same convention as `source-leak-gate / source-leak-gate`).

### The assistant-skills pin (fail-loud)

The gate checks out `assistant-skills` at `skills_ref` and **fails loud** if the
pin cannot be resolved or yields no `SKILL.md` — a stale or broken pin must
never silently pass. The resolved SHA is echoed in the report. The pin should
track the `@cinatra-ai/assistant-skills` `resolvedSha` in cinatra's
`cinatra-required-extensions.lock.json`, and a release-closeout sweep (per
cinatra#188) should re-pin to the release-current ref before reconciling the
whole release diff.

### Inputs

| Input | Default | Meaning |
|-------|---------|---------|
| `skills_ref` | _(default branch)_ | `assistant-skills` git ref to check out — pin to the SHA in cinatra's required-extensions lock. |
| `skills_repo` | `cinatra-ai/assistant-skills` | The skills repository. |
| `mode` | `warn` | `warn` (Stage 1, non-failing) or `enforce` (gates an unacknowledged finding). |
| `config` | _(none)_ | Per-repo JSON config (e.g. `primitiveStopwords` to tune the primitive matcher). |
| `ref` | `main` | Ref of this repo to check out (pin to a SHA in production). |

### Run locally

```sh
node scripts/skills-drift-gate.mjs \
  --skills-dir ../assistant-skills/skills \
  --diff-base origin/main --mode warn --format json
```

### Develop

```sh
node --test scripts/__tests__/skills-drift-gate.test.mjs
```

The test harness covers the three matcher cases on fixture `SKILL.md`s — a true
primitive/route/package hit, the prose false-positive guard (English prose flags
nothing), and a multi-skill hit (one identifier referenced by two skills surfaces
both) — plus a real-git-diff rename catching the removed-side identifier, warn
vs enforce exit codes, ack clearing, and fail-loud on a bad pin.
