# cinatra-ai/ci

Shared, reusable CI for the cinatra-ai organization.

Most gates are a standalone Node script (`scripts/*.mjs`, Node built-ins only)
that can be run locally, plus a reusable `workflow_call` caller in
`.github/workflows/`. For gates backed by a `scripts/*.mjs` engine, consuming
repos add a thin caller workflow that pins both the workflow ref and the inner
`ref` input to the same immutable commit SHA. Some gates (such as
`secret-scan-gate`) wrap an upstream action directly and do not use an inner
`ref`.

## What belongs in this repo

- **Reusable gate workflows** (`.github/workflows/*.yml`) — org-wide quality
  controls that any cinatra-ai repo can wire in through a thin caller.
- **Gate scripts** (`scripts/*.mjs`) — the standalone Node engines; zero
  runtime npm dependencies.
- **Shared config** (`config/`) — profiles, baselines, and JSON config files
  consumed by the gate engines.

What does **not** belong here: per-repo configuration files (keep those in the
consuming repo), operational runbooks, or secret material of any kind.

## Repository structure

```
.github/workflows/   Gate workflows (reusable workflow_call callers) and
                     org-level scheduled/self-check workflows
scripts/             Gate engine scripts (Node, no runtime deps)
  __tests__/         Unit test suite (node --test)
  __fixtures__/      Deterministic fixtures for the test suite
  lib/vendor/        Vendored substrate (extension-ioc-gate)
config/              Shared profiles, baselines, and JSON config files
docs/                Org-wide conventions (release contract)
```

## Org-wide conventions documented here

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

`public-strict` is the hardened profile for **public** repos: it runs the full
base rule set **plus** rules that flag the full-form private-tracker issue
reference (the bare `<private-tracker>#<n>` form and the bare legacy repo name)
that the base rules deliberately allow — that form is the org-sanctioned
cross-repo citation style for **private** repos' content, so it stays permitted
under every other profile and is blocked only where public repos opt in. Adopt
it per-repo (scrub any pre-existing hits first, since `ratchet_mode: line`
grandfathers existing lines but blocks net-new ones).

### Inputs

| Input | Default | Meaning |
|-------|---------|---------|
| `profile` | `default` | Rule profile: `default`, `ts-monorepo`, `php-wp-plugin`, `drupal-module`, `ops-docs`, `public-strict`. |
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

### Private-tracker references

A default rule (`SLG_PRIVATE_ENG_REF`) flags references to the **private**
`cinatra-ai/engineering` issue tracker leaking into a public repo:

- `eng#<n>` and `cinatra-engineering#<n>` shorthands (the latter also catches
  the `cinatra-ai/cinatra-engineering#<n>` legacy form);
- the full `cinatra-ai/engineering` repo path (including `#<n>` and
  `/issues/<n>` URL forms);
- the bare `engineering/issues/` URL tail.

Public-repo references — `cinatra#231`, `cinatra-cli#61`, `cinatra-ai/cinatra` —
are **not** flagged; those are deliberately public and should stay. Like every
content rule it rides the **line ratchet**, so it blocks only newly-added
references and never reds an already-unclean repo before its sweep finishes.
Don't cite a private issue number in committed source: describe the change, or
name a public spec/protocol (e.g. "the Truthful Attribution protocol"). For a
genuinely-public reference, allowlist the single line via `config.lineExcludes`
(full-line-anchored) or the whole file via `config.exemptFileBasenames`.

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

## extension-ioc-gate

A reusable GitHub Actions workflow + standalone Node script (`node
scripts/extension-ioc-gate.mjs`, Node builtins only) that validates a single
extension package against the **extension→host IoC conformance contract**: an
extension must reach the host ONLY through its `register(ctx)` ports and the
`@cinatra-ai/host:*` services — never via a host `@/` import, another extension,
or a non-SDK first-party package; its `serverEntry` graph keeps SDK imports
type-only; its manifest is well-shaped; its README, license, and kind conform.

It is **self-contained** — Node builtins only, zero registry dependency — and
**host-tree-independent**: it validates ONE package directory in isolation, with
no monorepo inventory, no pinned baselines, no `SCANNER_EPOCH`, and no
generated-file lists. It is the org-wide generalization of the cinatra monorepo's
per-package audit gates (`scripts/audit/extension-{import-ban,host-peer-value-
import-ban,deps-gate,readme-gate,license-gate}.mjs` + the SDK manifest schema).

It **consumes** (does not duplicate) the SDK validator substrate:
the host-port grammar is checked against the
substrate's `TEST_HOST_PORT_NAMES`, and `--register-probe` runs the package's
`register(ctx)` against the faithful grant-aware `createTestHostContext`, both
imported from a **byte-identical vendored** copy at
[`scripts/lib/vendor/test-host-context.mjs`](scripts/lib/vendor/test-host-context.mjs).

### Scope — extension→host ONLY

The **core→extension** direction (instance-coupling ban, core-import-ban,
dispatcher-bypass, cover-gate equality, generated-map byte-pinning) is
host-monorepo-specific by construction (baselines, `SCANNER_EPOCH`,
generated-file lists, lock equality). It stays in `cinatra/scripts/audit`,
documented as host-side — exporting it would export the migration machinery, not
the rule.

### Use it from another repo

Add a thin caller workflow. The job name below (`extension-ioc-gate`) becomes
part of the required-check context name — keep it stable if you use it as a
required check. If your extension repo already has a placeholder job named
`kind-gates`, replace that job with this caller:

```yaml
name: extension-ioc-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  extension-ioc-gate:
    # In production pin BOTH the workflow ref (`@<sha>`) and `ref` to the SAME
    # commit SHA, so the gate code is not pulled from mutable main.
    uses: cinatra-ai/ci/.github/workflows/extension-ioc-gate.yml@main  # @<sha> in prod
    with:
      package: "."
      register-probe: true
      ref: main  # set to the same <sha> in production
```

### Inputs

| Input | Default | Meaning |
|-------|---------|---------|
| `package` | `.` | Path to the extension package directory to validate. |
| `register-probe` | `false` | Also run `register(ctx)` against the test host context, reporting a REDACTED summary. |
| `format` | `text` | `text` or `json`. |
| `ref` | `main` | Ref of this repo to check out (pin to a SHA in production). |

### Rules

| Rule id(s) | Checks |
|------------|--------|
| `manifest-shape` / `-kind` / `-ports` / `-abi` / `-deps` / `-serverentry` | `cinatra` block present; `kind` valid; `requestedHostPorts ⊆ HOST_PORT_NAMES`; `sdkAbiRange` grammar; dependency-edge shape; serverEntry is a package-relative path. |
| `import-ban-host-alias` / `import-ban-first-party` | No `@/` host imports; no cross-extension / non-SDK first-party imports (only `@cinatra-ai/sdk-extensions` + `@cinatra-ai/sdk-ui` are permitted, subpaths allowed). |
| `host-peer-value-import` | Host-peer (`sdk-extensions` / `sdk-ui` / `mcp-client`) imports in the serverEntry graph are type-only. |
| `deps-sdk-only` / `deps-host-scope` | `package.json` deps name no `@cinatra-ai/*` package but the SDK packages. |
| `source-too-large` | A source file too large to scan fails closed (no padding bypass). |
| `readme-*` | README byte bounds + the small card contract (only the `Works with` / `Capabilities` H2s; `Capabilities` required). |
| `license-*` | A plausible SPDX `license` field. |
| `serverentry-exports` / `serverentry-artifact` | A declared serverEntry resolves via `exports` and its built artifact exists. |
| `register-probe` | (`--register-probe`, opt-in) best-effort AUTHOR diagnostic: the package's `register(ctx)` runs clean against the test host, in an isolated child process. NOT a trust boundary — it runs untrusted code in-process, so its verdict is hardened (defeats `process.exit(0)` / stdout forgery) but not forgery-proof. The static rules above are the conformance gate. |

### Run locally

```sh
node scripts/extension-ioc-gate.mjs --package <dir> [--register-probe] [--format json]
```

### Cross-repo parity

The gate's pinned contract constants (host ports, kinds, dependency-edge
grammar, README bounds) and its vendored substrate MUST track the cinatra source
of truth — a divergence would let an extension pass the org-wide gate while
failing the host. A **real** cross-repo parity test
([`scripts/__tests__/extension-ioc-gate.test.mjs`](scripts/__tests__/extension-ioc-gate.test.mjs))
reads the cinatra source directly (checked out by the `extension-ioc-parity`
self-check job) and asserts every pinned value matches — the build-server-entry
§4.1 lockstep-pin precedent, not a daily detection-only diff. Re-vendor with:

```sh
cp <cinatra>/packages/sdk-extensions/src/test-host-context.mjs \
   scripts/lib/vendor/test-host-context.mjs
```

## hot-install-canary-gate

A reusable GitHub Actions workflow that RUNS the host repo's **cross-kind
no-rebuild hot-install canary harness** — the one terminal proof for the full
extension hot-installability milestone. Unlike the other gates, the engine here
is NOT a `scripts/*.mjs` in this repo: the harness is a single, DB-less,
in-process root-vitest file that lives in the host repo (cinatra) at
`src/lib/__tests__/hot-install-canary-harness.test.ts`. This workflow checks out
the **caller** (the host) at the PR head and runs that harness, so the proof
always covers the exact branch under test.

For every extension kind — connector, agent, skill, artifact, workflow,
cube/portlet — the harness proves
`install -> surface appears -> disable -> surface disappears -> uninstall ->
teardown` with **no rebuild, no restart, and no `src/lib/generated/**`
regeneration** (the keystone oracle: generated-tree hash + process pid +
per-file mtime, re-checked after every kind). It also asserts the
direct-invocation refusals (a disabled agent's `agent_run` refuses, a disabled
cube serves `cube_not_active` on BOTH the HTTP and MCP transports, an archived
artifact type's direct write is denied, a disabled skill is not resolvable, a
disabled connector's render anchor is not live) and the negative cases
(unsigned/untrusted, cross-org actor, stale static reference, and a
closure-package-without-a-v2-signature install refusal). A **source-wiring
guard** inside the harness pins the live production call-sites to those gates so
the proof cannot rot into dead code.

### Why caller-checkout (not a hardcoded host ref)

The harness AND the host's `./.github/actions/clone-extensions` composite both
live in the host repo, so checking out the **caller** gives the exact
branch-under-test copy of both — the gate proves the code on the PR head, never
a drifted `main`. A **fail-closed presence guard** runs first: it asserts the
harness file exists and still carries both its keystone-oracle and
source-wiring-guard sections, so a caller PR cannot silently delete or hollow
the proof and have the gate pass vacuously.

### "Build the image once" — honest realization

The milestone's executable-proof issue framed this as "build the app image once,
then install fixtures without rebuild." The harness was deliberately written to
be DB-less and in-process (a `vi.mock` injects the canonical-store reader the
real runtime-install gates consume), so it needs **no built image, no container,
and no live DB**. A plain `vitest run` IS the no-rebuild proof — the keystone
oracle is the in-process assertion that the generated tree is byte-identical and
the process never restarted across every kind's full lifecycle. This gate
therefore does not claim image-level coverage; it runs the harness whose
in-process oracle is the no-regeneration assertion.

### Use it from the host repo

Add a thin caller workflow in the host repo and wire its job as a required
status check on the milestone/default branch. The harness imports host workspace
packages, so the caller's job (this reusable workflow) clones the pinned
companion extension repos and runs `pnpm install --frozen-lockfile` before the
harness:

```yaml
name: hot-install-canary-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  hot-install-canary-gate:
    # In production pin the workflow ref (`@<sha>`) to an immutable commit.
    uses: cinatra-ai/ci/.github/workflows/hot-install-canary-gate.yml@main  # @<sha> in prod
```

### Inputs

| Input | Default | Meaning |
|-------|---------|---------|
| `harness` | `src/lib/__tests__/hot-install-canary-harness.test.ts` | Path (in the caller repo) to the no-rebuild canary harness vitest file. |
| `vitest-config` | `vitest.config.ts` | Path (in the caller repo) to the vitest config hosting `src/**` unit tests. |

### Artifacts

The harness emits a JUnit report (`hot-install-canary-report.junit.xml`),
uploaded on every run, so a per-kind failure is actionable for the owning repo.

## docs-contract-gate

A reusable GitHub Actions workflow + standalone Node script (`node
scripts/docs-contract-gate.mjs`, Node builtins only) that validates one
integration's `docs/` directory against the **integration docs contract** — the
fixed page-set + frontmatter shape authored in
[`cinatra-ai/docs`](https://github.com/cinatra-ai/docs) (docs#51) and compiled
into the Integrations chapter of docs.cinatra.ai by the docs publish path
(cinatra-ai/ops#378). Integration repos call it **pre-tag** so their per-repo
docs stay consistent without central control; the publish path runs the SAME
gate at compile time against the tagged docs tree.

It is **self-contained** — Node builtins only, zero registry dependency — and
**fully offline**: it never fetches anything and never reads outside the docs
dir, so it requires no private-repo access (a hard requirement of ci#39).

### The contract it enforces

- **The fixed 6-page set** (exact filenames at the docs root): `overview.md` ·
  `quick-start.md` · `use-it.md` · `settings-and-permissions.md` ·
  `troubleshooting.md` · `advanced-and-reference.md`. No stray/extra Markdown.
- **Required frontmatter on every page:** `slug, title, description, navOrder,
  tier, lifecycle, cinatraCompat, integrationVersion, sourceRepo, supportUrl,
  marketplaceUrl`. `tier` must be `first-party` (third-party never compiles into
  the hub); `lifecycle ∈ {draft, active, deprecated, retired}`; `navOrder` must
  match the canonical page order; `slug` must equal the registry slug passed via
  `--slug`; `sourceRepo`/`supportUrl`/`marketplaceUrl` must be absolute https.
- **Allowed content:** Markdown + static assets only. **No MDX/JSX, no `import`
  / `export`, no `{…}` expressions** outside code fences (untrusted-repo content
  crosses into a trusted build, so build-time code surface is rejected for v1).
- **Link policy:** relative links must resolve to a file INSIDE the docs dir (no
  `../` escape out of the integration); cross-chapter links must be absolute
  canonical (`https://…` or a root-absolute `/guides|/references` path); no
  `file:`/`data:`/other schemes.
- **Assets:** namespaced under `docs/assets/`, stable lowercase-kebab filenames,
  per-asset ≤ 1 MiB, total ≤ 8 MiB, image types only.

### Use it from another repo (pre-tag)

Add a thin caller workflow that runs on PR/push so `docs/` is validated before
you cut a tag:

```yaml
name: docs-contract-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  docs-contract-gate:
    # In production pin BOTH the workflow ref (`@<sha>`) and `ref` to the SAME
    # commit SHA, so the gate code is not pulled from mutable main.
    uses: cinatra-ai/ci/.github/workflows/docs-contract-gate.yml@main  # @<sha> in prod
    with:
      docs: "docs"
      slug: "wordpress"  # this integration's registry slug
      ref: main          # set to the same <sha> in production
```

### Inputs

| Input | Default | Meaning |
|-------|---------|---------|
| `docs` | `docs` | Path to the docs directory to validate. |
| `slug` | _(required)_ | The integration's registry slug; every page's frontmatter `slug` must equal it. |
| `format` | `text` | `text` or `json`. |
| `ref` | `main` | Ref of this repo to check out (pin to a SHA in production). |

### Run locally

```sh
node scripts/docs-contract-gate.mjs --docs <dir> --slug <registry-slug> [--format json]
```

Exit codes: `0` conform · `1` findings · `2` usage/internal error. The rule
library lives in [`scripts/lib/docs-contract-rules.mjs`](scripts/lib/docs-contract-rules.mjs);
tests + good/bad fixtures in
[`scripts/__tests__/docs-contract-gate.test.mjs`](scripts/__tests__/docs-contract-gate.test.mjs).

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

## secrets-required-gate

A reusable GitHub Actions workflow + check that keeps a repo's
`.github/secrets-required.txt` manifest in lockstep with the secrets its
workflows actually reference. Deterministic and
repo-local (no GitHub API), so it is safe to wire as a required PR/push status
check. It fails on two drift classes:

- **orphan reference** — a `secrets.NAME` used in `.github/workflows/**` with no
  matching manifest entry (the recurrence the audit hit: `DEV_LOCK_BUMP_TOKEN`
  was wired but undocumented);
- **orphan declaration** — a manifest entry that no workflow references (a stale
  name, or a rename that silently dropped the real reference).

The built-in `GITHUB_TOKEN` is auto-provided by Actions and is excluded from
both sides. A *dynamic* bracket reference (`secrets[matrix.x]`) cannot be
resolved statically, so the gate fails closed and asks for the concrete name.

### Manifest grammar

An ENTRY is a token at **column 0** matching `UPPER_SNAKE` (a line that does not
start with whitespace and is not a `#` comment). A single line may declare
several names separated by ` / ` (e.g. `DOCKERHUB_USERNAME / DOCKERHUB_TOKEN`).
Indented prose (purpose/scope/wiring notes) and comments are NOT entries, so a
name mentioned mid-sentence in a note never counts as a declaration. Names only
— never a value (Actions secrets are write-only and cannot be read back).

### Use it from another repo

```yaml
name: secrets-required-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  secrets-required-gate:
    uses: cinatra-ai/ci/.github/workflows/secrets-required-gate.yml@<sha>  # vX.Y.Z
    with:
      ref: <sha>  # the SAME 40-char SHA as the workflow @ref
```

### Run locally

```sh
node scripts/secrets-required-gate.mjs            # scans ./.github
node scripts/secrets-required-gate.mjs --root <dir> --format json
```

Exit codes: `0` pass, `1` gate failure, `2` usage/internal error.

```sh
node --test scripts/__tests__/secrets-required-gate.test.mjs
```

## governance-drift-gate

A reusable engine that detects drift between a repo's COMMITTED
release-governance manifests (`.github/branch-protections.json`,
`.github/tag-protections.json`, optional `.github/baseline-protection.json`) and
the LIVE GitHub config they describe. A release
governance closeout audit found four manifest-vs-live drifts that had to be
reconciled by hand; this gate makes that self-policing.

It normalizes both sides order-insensitively (sorting required-check contexts,
rule types, bypass actors; dropping `_comment` prose), diffs them, and fails on
any unexplained drift. A deliberate live-only value is declared in
`.github/governance-drift-allowlist.json` (`{ "branchProtection": ["field"], … }`)
with a rationale.

### Why it is SCHEDULED, not a required PR check

Reading branch protection needs repo `Administration: read`; reading org
rulesets (with `bypass_actors`) needs org `Administration`. The default Actions
`GITHUB_TOKEN` cannot do this and a fork PR has no privileged token, so this
runs on a schedule / on demand only — never as a required `pull_request`
context.

- Pass an operator-provisioned fine-grained PAT or App token as the
  `governance_read_token` secret.
- When that secret is **absent** the gate **skips green** (`exit 0` + a
  `::notice`) so it can ship before the token is provisioned.
- When the token is **present** but a read returns 401/403/incomplete, the gate
  **hard fails** — a degraded privileged read must not mask drift.

### Use it from another repo

```yaml
name: governance-drift-gate
on:
  schedule: [{ cron: "17 7 * * *" }]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  governance-drift-gate:
    uses: cinatra-ai/ci/.github/workflows/governance-drift-gate.yml@<sha>  # vX.Y.Z
    with:
      repo: cinatra-ai/cinatra
      ref: <sha>  # the SAME 40-char SHA as the workflow @ref
    secrets:
      governance_read_token: ${{ secrets.GOVERNANCE_DRIFT_READ_TOKEN }}
```

### Run locally

```sh
# offline: diff committed manifests against a saved live-state JSON
node scripts/governance-drift-gate.mjs --root <dir> --live-json live.json
# live: read the GitHub API via `gh` (needs GOVERNANCE_DRIFT_READ_TOKEN)
GOVERNANCE_DRIFT_READ_TOKEN=<token> \
  node scripts/governance-drift-gate.mjs --live --repo cinatra-ai/cinatra
node --test scripts/__tests__/governance-drift-gate.test.mjs
```

## release-workflow-pin-drift-gate

Fails **closed** if any extension / connector repo's
`.github/workflows/release.yml` calls the central
`reusable-extension-release.yml` at a ref whose `release` job is **not** behind
the `release-approval` Environment — i.e. a ref that would let a `v*` tag
publish with **no** human-approval pause.

**The trap it closes — opt-in vs enforced-default.** The `release-approval`
wall is applied per repo by *pinning the gated reusable-workflow ref*. A
security control that is opt-in-per-repo fails **open** for every repo that did
not opt in — an older pin left behind, or a new/scaffolded repo that copies an
old `release.yml`. This gate makes the wall enforced-by-default: it scans
**every** org repo and reds the moment any one of them pins a non-gated ref, so
a fail-open pin cannot sit undetected. (This is the same class of bug as an
auth check that ships fail-open-by-default with an opt-in flag: the fix is
never "remember to opt in each repo" — it is a default that fails closed and a
gate that proves it.)

The gated set is a **curated allowlist of gated SHAs**
(`config/release-workflow-gated-refs.json`), not a "minimum ref" — commit SHAs
are not orderable. Every ref whose reusable-release `release` job carries
`environment: release-approval` goes in the list; a ref not in the list is
treated as ungated. Publishing a **new** gated reusable-workflow tag ⇒ verify
its release job still carries the wall, then add its SHA to the allowlist (and
bump the extension repos onto it). A repo whose `release.yml` publishes
elsewhere (e.g. a direct `npm publish`, or no reusable call) is skipped; a repo
with no `release.yml` is skipped.

### Why it is SCHEDULED, not a required PR check

The drift lives in repos **other** than the one a PR touches, and enumerating
org repos + reading each `release.yml` needs a token a fork PR does not have.
So this runs on a schedule / on demand only.

- Pass an operator-provisioned fine-grained PAT or App token
  (repo `contents: read` across the org + `read:org`) as the
  `release_pin_read_token` secret; it also honors `GH_TOKEN`/`GITHUB_TOKEN`.
- When **no** token is available the gate **skips green** (`exit 0` + a
  `::notice`) so it can ship before the token is provisioned.
- When a token is **present** but a read fails / returns unparseable data, the
  gate **hard fails** — a degraded privileged read must not mask drift.

### Residual gap (documented honestly)

A scheduled scan **detects and reds** drift; it does not physically stop a `v*`
tag that fires on an ungated ref in the window before the next scan +
remediation. The physical stop for an already-gated repo is the reusable
workflow's own `environment: release-approval` (and, defense-in-depth, a
self-guard step inside it). This gate is the enforced-by-default backstop that
keeps every repo *on* a gated ref.

### Use it from another repo

```yaml
name: release-workflow-pin-drift-gate
on:
  schedule: [{ cron: "23 6 * * *" }]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  release-workflow-pin-drift-gate:
    uses: cinatra-ai/ci/.github/workflows/release-workflow-pin-drift-gate.yml@<sha>  # vX.Y.Z
    with:
      org: cinatra-ai
      ref: <sha>  # the SAME 40-char SHA as the workflow @ref
    secrets:
      release_pin_read_token: ${{ secrets.RELEASE_PIN_DRIFT_READ_TOKEN }}
```

### Run locally

```sh
# offline: audit a { repo -> release.yml text|null } map against the allowlist
node scripts/release-workflow-pin-drift-gate.mjs --root <dir> --repos-json repos.json
# live: scan the whole org via `gh` (needs a token; --only scopes to a subset)
GH_TOKEN=$(gh auth token) \
  node scripts/release-workflow-pin-drift-gate.mjs --live --org cinatra-ai
node --test scripts/__tests__/release-workflow-pin-drift-gate.test.mjs
```

## doc-code-value-gate

A reusable GitHub Actions workflow + engine for the **"a doc asserts a code
value"** drift class: it fails CI when the value a documentation file claims
drifts from the value the source-of-truth file actually carries. The recurring
failure mode of version/ABI constants is a README that quietly diverges from the
`const` it documents; this gate pins that mechanically
and is the org template for every doc-asserts-a-code-value case.

Each assertion pairs a `doc` side with a `code` side. A side names a `file` and
either a regex `pattern` (exactly one capture group — the captured value is the
comparison key) or, for JSON files, `type: "json"` + a dot-path `pointer`. The
gate fails closed by construction:

- a pattern must match **exactly once** — zero matches means the line moved or
  was deleted (drift); more than one match means the pattern is ambiguous (it
  could be silently reading a changelog line, a comment, or a fenced example);
- documentation files (`*.md`, or `type: "doc"`) are scanned with fenced code
  blocks stripped, so an example inside ``` … ``` cannot shadow the canonical
  statement (set `stripFences: false` to opt out);
- JSON sides are parsed and read by `pointer`, never regex-scanned.

Anchor patterns to the canonical line (e.g. with `^…$`) so the gate reads the
live value and not a near-miss elsewhere in the file.

### Use it from another repo

Add a thin caller workflow plus a config JSON listing the assertions:

```yaml
name: doc-code-value-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  doc-code-value-gate:
    # Pin BOTH to the SAME 40-char commit SHA: the workflow ref (`@<sha>`) and the
    # `ref` input below. `ref` is REQUIRED and is rejected unless it is a SHA —
    # otherwise the gate engine could change under a caller that pinned only the
    # workflow ref.
    uses: cinatra-ai/ci/.github/workflows/doc-code-value-gate.yml@<sha>  # vX.Y.Z
    with:
      config: .github/doc-code-value-gate.config.json
      ref: <sha>  # the SAME 40-char SHA as the workflow @ref
```

```jsonc
// .github/doc-code-value-gate.config.json
[
  {
    "label": "sdk-abi-readme==register",
    "doc":  { "file": "packages/sdk-extensions/README.md",
              "pattern": "The SDK ABI is \\*\\*`(\\d+\\.\\d+\\.\\d+)`\\*\\*" },
    "code": { "file": "packages/sdk-extensions/src/register.ts",
              "pattern": "^export const SDK_EXTENSIONS_ABI_VERSION = \"(\\d+\\.\\d+\\.\\d+)\"" }
  }
]
```

### Run locally

```sh
node scripts/doc-code-value-gate.mjs --config <path/to/config.json>
```

Single assertions can skip the config file with
`--doc-file --doc-pattern --code-file --code-pattern` (and `--label`). Add
`--root <dir>` to check another checkout. Exit codes: `0` pass, `1` gate failure
(drift, no-match, or ambiguous-match), `2` usage/internal error.

### Develop

```sh
node --test scripts/__tests__/doc-code-value-gate.test.mjs
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

## secret-scan-gate

A reusable GitHub Actions workflow that blocks a PR when a verified or
unverifiable secret is introduced into the diff. The engine is
[TruffleHog OSS](https://github.com/trufflesecurity/trufflehog), run with
`--results=verified,unknown` (verified leaks and verification-error results
both fail; unverified results are excluded to limit false positives). The
engine version is pinned to match the companion scheduled sweep.

This gate is the **preventive** control; the companion `secret-scan-sweep`
workflow (scheduled, org-wide) is the **detective** control that covers the
`--admin` bypass case.

### Use it from another repo

```yaml
name: secret-scan-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  secret-scan-gate:
    uses: cinatra-ai/ci/.github/workflows/secret-scan-gate.yml@main  # @<sha> in prod
    with:
      base_sha: ${{ github.event.pull_request.base.sha }}
      head_sha: ${{ github.event.pull_request.head.sha }}
```

When `base_sha` is empty (push events, or not provided), TruffleHog performs
a full working-tree scan rather than a diff scan.

### Inputs

| Input | Default | Meaning |
|-------|---------|---------|
| `base_sha` | _(none)_ | Diff base commit SHA (PR: `pull_request.base.sha`). Empty triggers a full tree scan. |
| `head_sha` | _(none)_ | Diff head commit SHA (PR: `pull_request.head.sha`). Empty defaults to `HEAD`. |
| `extra_args` | _(none)_ | Optional extra TruffleHog CLI args appended after the gate defaults (e.g. `--exclude-paths=.trufflehog-exclude`). |

### Required-check context

The check context name is `secret-scan-gate / secret-scan-gate` (the workflow
name and the job key are both `secret-scan-gate`).

Note: unlike the `source-leak-gate` family, this gate does **not** take a `ref`
input. The scanning engine is the upstream TruffleHog action (SHA-pinned in the
workflow), not a script from this repository. There is no local run command.

## wp-drupal-rename-gate

A reusable GitHub Actions workflow that fails a PR when a deprecated legacy
identity token is reintroduced into a caller repo's tree. It is shared plumbing
for the cinatra core repo and any companion WordPress/Drupal repos that carry
the current canonical identity.

### Use it from another repo

```yaml
name: wp-drupal-rename-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  rename-gate:
    uses: cinatra-ai/ci/.github/workflows/wp-drupal-rename-gate.yml@main  # @<sha> in prod
```

The workflow takes no inputs; it checks the caller's own tree using
`ripgrep` (installed in the job). Git-ignored paths (such as companion dev
clones) are excluded automatically.

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

### How it matches — watches-first with heuristic fallback

The gate uses two tiers, applied per skill:

1. **Declared watches (preferred — low false-positive).** A `SKILL.md` MAY
   declare, in its YAML frontmatter, the cinatra surfaces it depends on:

   ```yaml
   cinatra-watches:
     primitives: [agent_run, agent_run_get]      # exact MCP primitive names
     packages: ["@cinatra-ai/trigger-agent"]     # exact @cinatra-ai/* package names
     routes: ["/api/agents/passthrough"]         # exact route strings
     paths:                                       # source-path GLOBS (* / ** / ?)
       - packages/agents/src/a2a-actions.ts
       - packages/agents/src/**
   ```

   `primitives` / `packages` / `routes` are matched against identifiers extracted
   from the PR diff (both **added and removed** lines across `merge-base…head`, so
   a rename — whose effect lands on the removed-identifier line — is caught).
   `paths` globs are matched against the PR's **touched file paths** (both rename
   sides), so a **param-shape change** that edits a watched source file but leaves
   the watched string (`agent_run`) untouched is still flagged — the documented
   v1 false-negative, closed by the `paths` class. A skill that declares **any**
   non-empty watch class is matched **only** by its declared surfaces (the
   verbatim heuristic is suppressed for it, silencing noise).

2. **Heuristic fallback (zero skill-side work).** A skill with **no**
   `cinatra-watches` block (or a present-but-**empty** one) is matched the v1 way:
   identifiers that appear verbatim in its `SKILL.md`, intersected with the diff.
   Identifier classes are shaped to keep prose out — primitives are
   `lower_snake_case` with ≥1 underscore, packages carry the `@cinatra-ai/` scope,
   routes sit under a known root with a sub-segment. So adoption is incremental:
   undeclared skills keep coverage until they add watches.

Every finding is tagged `source: "watch"` or `source: "heuristic"`.

### warn vs enforce

- **warn** — exit 0 always. Reports watch + heuristic findings as workflow
  annotations + a step summary (the check stays green).
- **enforce** — exit 1 **iff** there is an **unacknowledged `source: "watch"`
  finding**. `source: "heuristic"` findings are **advisory in every mode** — they
  are reported but **never gate**, so the warn→enforce flip can never hard-fail on
  heuristic noise from an undeclared skill. (This is the issue's "graduate to
  declared watches *for enforcement*".)
- **fail-loud (exit 2)** — a bad/unresolvable `assistant-skills` pin, zero
  `SKILL.md`, an unresolvable diff base, or a **malformed `cinatra-watches`
  block** (a typo must break the gate, never silently disable a watch). Fail-loud
  runs **before** the mode decision, so it exits 2 regardless of `warn`/`enforce`.

### Acknowledgement / override

A flagged **declared-watch** finding resolves by one of (mirroring
`source-leak-gate`'s override ergonomics):

- **(a)** `Skills-PR: <url-or-#n> covers: <skill-slug>[, …]` — a linked
  `assistant-skills` PR that **names** the impacted skill(s) it updates. A bare PR
  link with no `covers:` list satisfies nothing (coverage can't be verified
  offline — only the recorded decision is enforced, never content correctness).
  This ack is **per-skill**; a finding touching multiple skills needs all of them
  named.
- **(b)** `Skills-reviewed: <note>` — a recorded "checked + updated" assertion
  (covers all impacted skills); or
- **(c)** `Skills-unaffected: <reason>` — a recorded override. The **reason is
  required**: a bare `Skills-unaffected:` satisfies nothing (the issue: "not
  `Skills-unaffected:` only").

The caller concatenates the PR body + commit messages into an ack file; the gate
parses these trailers and reports them. In `warn` mode they never change the exit
code; in `enforce` mode an unacknowledged watch finding gates and a matching
recorded ack clears it.

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
| `skills_ref` | _(required)_ | `assistant-skills` git ref to check out — pin to the SHA in cinatra's required-extensions lock. Empty fails loud. |
| `skills_repo` | `cinatra-ai/assistant-skills` | The skills repository. |
| `mode` | `warn` | `warn` (non-failing) or `enforce` (gates an unacknowledged **declared-watch** finding; heuristic findings stay advisory). |
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

The test harness covers the heuristic matcher cases on fixture `SKILL.md`s — a
true primitive/route/package hit, the prose false-positive guard, a multi-skill
hit, a real-git-diff rename catching the removed-side identifier — **plus the v2
declared-watches surface**: watch parsing (block + flow arrays), fail-loud on a
malformed/unknown-key/scalar watch block, path-glob semantics (`*` within a
segment, `**` across segments), watches suppressing the heuristic for a declared
skill, an empty watch block falling back to the heuristic, a **path-only** finding
(a watched source file edited with no watched string), enforce gating only
unacknowledged watch findings (heuristic findings advisory), the `Skills-PR:
covers:` per-skill ack, a reasonless `Skills-unaffected:` not clearing the gate,
and fail-loud on a bad pin / diff base.

## truthful-attribution-gate

The org-wide gate for the **truthful verification-record model** — the
**Truthful Attribution protocol** (it supersedes the earlier paused
no-AI-attribution gate). Every merge
carries a truthful record: an `Assisted-by:` transparency trailer (what produced
the change) plus one verification arm — a human `Reviewed-by:` (a real,
non-self, non-stale GitHub PR approval by a login whose repo permission meets the
claimed tier) **or** a `Gate-suite:`+`Accountable:` machine arm (the named,
versioned required-check set ran green, owned by a named accountable engineer).
"We never put a human's name on a change they did not read." The gate's core job
is anti-fabrication of the **verification** claim — that is where a lie does
damage.

Three arms: **pre-merge** (PR claims), **post-merge** (the synthesized squash
record itself), and a scheduled **org watchdog**. It currently runs in **WARN**
mode (computes + annotates every finding, always green); the ENFORCE flip is
gated on the dedicated machine identity for agent-opened PRs (spec §8.5), tracked
as an `[owner]` issue — it is **not** a gate-config change.

### High-risk classification (§3)

A change whose files match **any** glob in `config/high-risk-defaults.json` (the
central, **extend-only** five-class defaults: auth/security, migrations,
release/CI infra, org governance, extension-system architecture) **or** a repo's
`.github/gate-suite.json` `highRiskPaths` (which must be a **superset** of the
defaults) **requires** the human arm at `tier=maintainer`; the gate arm alone is
rejected. A parse failure of either config => the whole change is treated
high-risk (fail closed). Removing a default means editing this repo's config —
itself a high-risk path, so maintainer-reviewed by construction.

### Gate suite — registry, versioning, audit (§4)

The named, versioned set of required checks that constitutes machine verification
for one repo. Hybrid storage:

- **Per-repo `.github/gate-suite.json` is authoritative for enforcement** — the
  gate reads it **at the merged SHA** (deterministic; no TOCTOU against a remote
  registry). Shape: `suiteId`, CalVer `version` (`YYYY.MM[.N]`),
  `accountable{github,name,email}` (all three required), non-empty
  `requiredContexts[{context, workflow?, pinned?, appSlug?}]`, `highRiskPaths`
  (superset of the central defaults), `lastAuditedAt`, `auditEvidence`.
- **`config/gate-suite-index.json`** in this repo is a **generated, read-only**
  org-wide audit index — *nothing reads it at merge time*, so it can never weaken
  enforcement. It is regenerated from the **explicit** `config/gate-suite-inventory.json`
  by `node scripts/gate-suite-index.mjs`. A `no-suite` row never means "nothing
  to audit" — it means that inventoried repo has not committed a suite yet
  (cinatra's is deferred to its enforce-bootstrap owner-reviewed PR per §7 step
  3). The self-check enforces the index is in generator canonical form and lists
  exactly the inventoried repos (`scripts/gate-suite-index-selfcheck.mjs`).

**Version-bump rule (gate-checked):** on a PR that changes
`.github/gate-suite.json`, if `requiredContexts`, a context `pinned` SHA, or
`highRiskPaths` changed versus the base and `version` did **not** bump, that is a
finding — a material suite change must bump CalVer so the audit can tell which
suite applied.

**Continuous-audit + staleness (gate-checked):** monthly, the `Accountable`
engineer reviews the suite + a 10% sample of gate-arm merges (min 5), records
evidence as a closing comment on the recurring `Gate-suite audit YYYY-MM` issue
in cinatra-engineering, then bumps `lastAuditedAt` **and** `auditEvidence` in the
same commit. Staleness is mechanical and **gate-arm-only**: the gate **warns**
when `lastAuditedAt` > 35 days and **fails the gate arm** when > 65 days (or when
there is no audit record at all — fail closed). A lapsed audit stops *machine*
verification, never a `tier=maintainer` human-arm merge. The monthly
`gate-suite-audit` workflow runs the **live** index drift check + a staleness
sweep across the inventory, so a lapse is visible before a PR discovers it. The
job only reports — it never edits a `gate-suite.json` or closes the audit issue
(those are the human's acts; the gate never fabricates a record).

### Run locally

```sh
# pre-merge claim check on a PR (anti-fabrication needs a token + --pr)
node scripts/truthful-attribution-gate.mjs --arm pre-merge --mode warn --pr <n>
# post-merge record check on the squash commit
node scripts/truthful-attribution-gate.mjs --arm post-merge --mode warn --pr <n>
# regenerate / drift-check the org-wide audit index
node scripts/gate-suite-index.mjs              # write
node scripts/gate-suite-index.mjs --check      # fail on drift (live scan; needs auth)
node scripts/gate-suite-index-selfcheck.mjs    # offline structural + canonical-form check
node scripts/gate-suite-audit-report.mjs       # staleness sweep across the inventory
```

### Develop

```sh
node --test scripts/__tests__/truthful-attribution-gate.test.mjs \
            scripts/__tests__/gate-suite-index.test.mjs \
            scripts/__tests__/gate-suite-audit-report.test.mjs
```

## Developing in this repo

### Run the full test suite

```sh
npm ci
node --test scripts/__tests__/*.test.mjs
```

The [`self-check`](.github/workflows/self-check.yml) workflow dogfoods a
subset of gates on this repository's own source and exercises the full test
suite on every PR and push to `main`.

### Add a new gate

1. Write the engine script at `scripts/<gate-name>.mjs` (Node built-ins only,
   zero registry dependencies).
2. Add unit tests at `scripts/__tests__/<gate-name>.test.mjs` using
   `node:test`.
3. Add the reusable workflow at `.github/workflows/<gate-name>.yml`.
4. Where the gate has a local script, add a `self-check` step so it dogfoods
   on this repo.
5. Document the gate in this README (purpose, thin-caller snippet, inputs
   table, local run command where applicable, develop command).

### Update the vendored substrate (extension-ioc-gate)

```sh
cp <cinatra>/packages/sdk-extensions/src/test-host-context.mjs \
   scripts/lib/vendor/test-host-context.mjs
```

Then run the parity test to confirm the vendored copy matches the cinatra
source of truth:

```sh
CINATRA_REPO=<path-to-cinatra-checkout> \
  node --test --test-name-pattern='PARITY' scripts/__tests__/extension-ioc-gate.test.mjs
```

## Troubleshooting

### A gate is failing but I can't tell which rule triggered it

Run the gate locally with `--format json` (where supported) or `--exit-on-match`
to get per-finding detail. Gate scripts that support it accept `--help` for the
full flag list (e.g. `node scripts/extension-ioc-gate.mjs --help`).

```sh
# source-leak-gate: show all findings as JSON
node scripts/source-leak-gate.mjs --profile default --ratchet-mode off --format json

# actions-pinned-gate: list every offending ref
node scripts/actions-pinned-gate.mjs

# extension-ioc-gate: verbose output for a package
node scripts/extension-ioc-gate.mjs --package <dir> --register-probe
```

### The source-leak-gate fires on lines I didn't add

The default ratchet mode is `line`: only findings on lines the PR *added* should
block. If the gate fires on pre-existing lines, confirm your caller workflow sets
`fetch-depth: 0` so the gate can diff against the merge base.

If you are using `ratchet_mode: file` or `ratchet_mode: baseline`, check that
your allowlist or baseline file is committed and that the path is correct.

### The actions-pinned-gate version comment does not match

Every `uses:` ref must be pinned to a 40-character commit SHA and carry a
version comment in the form `# vX.Y.Z` (or `# X.Y.Z` for upstreams that do not
use a `v` prefix). The version in the comment must exactly match a real upstream
tag — it is what Renovate uses to propose updates.

### The extension-ioc-gate fails with a parity error in CI

The gate's pinned constants (host-port names, kinds, dependency-edge grammar)
must track the cinatra source of truth. Run the local parity check (see
"Developing" above) to identify the drift. Re-vendor
`scripts/lib/vendor/test-host-context.mjs` if the substrate diverged.

### The truthful-attribution-gate reports a stale gate suite

The `lastAuditedAt` field in a repo's `.github/gate-suite.json` must be updated
monthly by the named `Accountable` engineer (with audit evidence). A date older
than 35 days produces a warning; older than 65 days blocks the machine arm. See
the `truthful-attribution-gate` section above for the full audit protocol.

### A self-check job fails only in CI, passes locally

Check that your local Node version is 24+ (`node --version`). All gate scripts
require `node >= 24` (see `package.json` `engines` field). The self-check CI job
installs Node 24 explicitly.
