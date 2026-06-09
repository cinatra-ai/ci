# cinatra-ai/ci

Shared, reusable CI for the cinatra-ai organization.

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
immutable 40-char commit SHA carrying a `# vX.Y.Z` version comment. A moved
upstream tag (`@v6`) can silently run new code against the caller's
`GITHUB_TOKEN`; an immutable SHA cannot.

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
