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

The org-wide gate for the **truthful verification-record model** ratified in
[cinatra-engineering#119](https://github.com/cinatra-ai/cinatra-engineering/issues/119)
(it re-scopes and supersedes the old no-AI-attribution gate, #116). Every merge
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
