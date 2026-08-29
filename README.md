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
scripts/             Gate engine scripts (Node built-ins; no registry deps)
  __tests__/         Unit test suite (node --test)
  __fixtures__/      Deterministic fixtures for the test suite
  lib/vendor/        Vendored third-party code and substrate (js-yaml,
                     extension-ioc-gate) — see "Vendored code"
config/              Shared profiles, baselines, and JSON config files
templates/           Copy-paste caller workflow templates for consuming repos
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

### Every selected file is scanned

Every file the scan selects is **read and scanned whatever its size** — an
unread file is never reported clean, so a leak cannot be padded past the gate —
and the one limit left is a resource cap (`64,000,000` bytes, what the engine can
hold in a single string) whose breach **fails the run**, naming the file and its
size, instead of passing it. A selected file the engine cannot stat or read
**fails the run** the same way, naming the file and the error, rather than
counting as clean. A selected **symbolic link** is scanned as the link text git
stores for it, not as whatever it points at. A selected entry that is neither a
regular file nor a link — a submodule gitlink, for which git stores no content —
is **excluded from the content scan and printed by path**, so the exclusion is on
the record and a repository with submodules stays scannable; its name is still
path-scanned. Content is scanned **whatever bytes it carries**: a `NUL` byte is
not a "binary" marker and stops nothing, so a leak cannot be hidden behind one.

The run's `Scanned N files` diagnostic (and the JSON summary's
`scannedFileCount`) counts the files this run actually **read**, never the
candidate set: a file skipped before it was opened — an exempt basename, an
exempt directory, a non-regular entry — is stated beside the count
(`Scanned 12 files (2 exempt, 1 not regular)`) instead of being counted as
coverage the run did not have.

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
  the `cinatra-ai/cinatra-engineering#<n>` legacy form). A numeric issue
  reference must **terminate**: `#<digits>` running straight into another
  alphanumeric (`eng#0abc`, a digest, an anchor slug) is not a citation and is
  not flagged;
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

### Private-repository references

Two lanes decide whether an `<org>/<name>` reference names a repository the
public may see:

- **the built-in list** — a hard-coded set of private repository names, always
  active. It is the only lane that can judge the *bare-name* forms (a name with
  no org path, which no API can resolve), and the only lane a run without a
  token has.
- **the visibility probe** — active when the gate is given a token in
  `GH_TOKEN` / `GITHUB_TOKEN` (the reusable workflow passes the caller's own
  `github.token`). Every *other* `<org>/<name>` reference on a **gated** line is
  resolved once against the GitHub API, so a repository created after the last
  edit to the list is still caught. The caller's job token cannot enumerate an
  organization's private repositories, and does not need to: the question asked
  is only "can this token see that repository as public?".

Both lanes share ONE repository-name grammar, so they always agree on where a
name starts and ends — and so does the committed cache's entry validation, which
is the same function rather than a second copy. The grammar is GitHub's: 1..100
characters from `[A-Za-z0-9_.-]` in any position, so a leading `_`, `.` or `-`
is allowed (`<org>/_shared`, `<org>/.github-private`, `<org>/-secret`), never `.`
or `..`, and never a trailing dot (so a sentence-final period stays punctuation).

A name token must **end at a boundary** — a character outside `[A-Za-z0-9_.-]`,
or end of text. A run longer than 100 characters therefore yields **no name at
all** rather than a 100-character prefix: probing a truncated prefix could only
404, and the gate would have to report that 404 as a fail-closed finding.

A trailing **`.git` followed by a boundary** is a clone suffix and resolves to
the repository it clones, and it is recognised **before** the dotted-sibling
test — so `<org>/<private>.git`, `git@github.com:<org>/<private>.git` and
`<org>/<private>.git/issues/1` are all the private repository. `.gitlab`,
`.gitfoo` and `.tools` are not: a dot is a *name character*, so a listed name
with a dotted continuation (`<org>/<listed>.something`) is a **different**
repository — claimed by the probe, never mistaken for the listed one, and never
claimed by both at once. The rules that match a fixed private name (the tracker,
the private proof host) use the same boundary, so `<name>.sibling` and
`sibling.<name>` are other names while `<name>.` at the end of a sentence still
resolves. The 1..100 ceiling belongs to the **name**, not to the spelling: a
written reference is a name plus that optional suffix, and the committed cache
validates its entries that way too — so a 100-character repository written as
`<name>.git` is that repository, folds to it, and collides with any other
spelling of it exactly like a bare entry would.

Every finding carries **both spellings** of the reference it caught: `match` is
the source-exact text, byte for byte as the file writes it (clone suffix
included), while `repository` is the canonical `<org>/<name>` that text names —
suffix off, both halves case-folded — which is the spelling the probe's request,
its memo and the committed cache all key on, and a match that names no
`<org>/<name>` token (a bare name, an issue id) carries no `repository` at all.

The **npm-scope carve-out** — `@<org>/<name>` names a vendored workspace
package, not a repository, so it is not a reference — **never excuses a name on
the private list**: no package carries one of those names, and the form leaks the
name just the same. `@<org>/<public-or-unclassified>` costs nothing, in both
lanes, exactly as before.

The probe never guesses. A repository the API reports public produces no
finding; private, `404` (what a private *or* absent repository returns to a
token without access), a rate limit, a network error and a malformed response
all produce one — the unresolved cases under their own rule id
(`SLG_PRIVATE_REPO_PROBE_ERROR`), naming the cause, so a run that could not
verify never reads as a pass.

The lane runs inside a per-run **budget**: a cap on distinct names, a wall-clock
deadline and bounded concurrency. The deadline bounds the whole lane, not just
its next request: each request's timeout is `min(10s, time left on the
deadline)`, so a request already in flight is aborted the moment the deadline
passes instead of running its full timeout past it. The deadline bounds the
**answer** as well as the request, because an abort signal is only a request to
stop and a transport is free to ignore it: both halves of a probe — the response
and the body read — are raced against the lane's own clock, and a resolution that
lands past the deadline is refused and **not memoised**, so a late
`private: false` can never clear a name for the rest of the run. A candidate the
budget leaves unasked — including one whose request the deadline cut, and one
whose answer arrived too late — is reported as
`SLG_PRIVATE_REPO_PROBE_BUDGET`, so "we ran out of budget" can never read as "we
checked it and it was fine".

Verdicts are memoised per run, and
[`config/public-repos.json`](config/public-repos.json) is a small committed
latency cache: each entry records the day it was last confirmed public and is
ignored once past the TTL, because an entry that cannot go stale would be a
permanent fail-open. The cache's own metadata is validated fail-closed, since a
cache that keeps vouching is the failure that matters:

- `ttlDays` must be an **integer in 1..7**. Anything else — a huge TTL, `0`, a
  fraction, a string — is the freshness rule switched off, so the **whole cache
  is ignored** (one warning line, every name resolved live) rather than honoured.
  Omitting it takes the shipped 7-day default.
- `verifiedAt` must be a canonical `YYYY-MM-DD` day that **round-trips as a real
  calendar date** (`2026-02-30` does not — `Date` silently normalises it to March
  2nd) and is **not in the future** (UTC). An entry that fails either check is
  treated as stale and resolved live; it is never counted as verified.
- Freshness is measured in whole **UTC calendar days**, and an entry expires
  **by** `verifiedAt + ttlDays`: the entry stamped exactly that many days ago is
  already out of date, so a 7-day TTL vouches for seven days and not an eighth.
- `name` is accepted in **every spelling the shared grammar allows** and is
  stored, compared and rewritten in the one canonical form the scan itself uses —
  case-folded, with a `.git` clone suffix resolved to the repository it clones —
  so `CI`, `ci` and `ci.git` are one name and the cache cannot disagree with the
  scan about which repository an entry clears. Two entries that fold to one name
  are that name twice, which no cache may hold: the pair is **invalid** (one
  warning, no spelling of it cleared, the name resolved live), and
  `--verify-cache` collapses it to the canonical spelling.
- `name` and `verifiedAt` must be JSON **strings** (and `name` a real repository
  name). Types are checked, never coerced: `{"name": 123}` would otherwise
  stringify into the perfectly good name `123` and clear that repository with no
  probe at all. An entry that is not an object, or whose `name`/`verifiedAt`
  fails this, is **invalid** — skipped with one warning naming it, and the name
  it was going to clear is resolved live. One bad entry never decides the fate of
  the file, and never clears a name.
- A malformed **file** (not JSON, not an object, no `public` array) still fails
  the run outright: there is nothing to read.

`--verify-cache` re-confirms every entry and rewrites those stamps, dropping any
repository that is no longer public; a weekly workflow runs it and opens a pull
request on drift.

Pass `--offline` to force the list-only lane (also what happens with no token),
and `--probe` to force the probe on unauthenticated. Deliberately-public
references are allowlisted the same way every other rule allows them, via
`config.lineExcludes` or `config.exemptFileBasenames`.

### Dispatch targets that are also private

A few private repositories are named by the organization's own automation and
cannot be rephrased away — a reusable-workflow or action reference, a checkout or
token-scope key, a clone URL. Those exact machine forms are excused **per
match**, not per name and not per line: ordinary prose, an `#<n>` citation and an
`/issues/` or `/blob/` URL naming the same repository all still flag, including
on a line that also carries a legitimate functional reference. A name-wide
exemption would have hidden precisely the forms worth catching.

The excused forms are transcribed as **machine grammars**, not substrings. A
carve-out applies only where:

- **the key owns the line** — the key is the line's first non-blank token, after
  an optional `- ` sequence marker. A `#` anywhere before it makes the line a
  comment, and a comment is prose *about* a machine form: `# uses: <org>/<repo>@main`
  and `see uses: <org>/<repo>@main in the old job` are findings;
- **the key is separated from its value by real whitespace** — YAML requires a
  space (or tab) after a mapping key, so `uses:<org>/<repo>@main` and
  `repository:<org>/<repo>` are not scalars at all, no runner accepts them, and
  they are findings;
- **the scalar is complete** — after the value only end of line or a real YAML
  comment (whitespace, then `#`) may follow. Trailing junk, a `/issues/1` tail
  and a comment-less `#1` all leave the carve-out. Quotes must match: an opening
  `"` or `'` has to close the scalar. The terminator is a lookahead, so the
  excused span stops at the value — a citation inside the trailing comment still
  flags;
- **the document says the value is a dispatch** — the grammar is necessary and
  never sufficient. A `*.yml|*.yaml` file is **parsed** (with the vendored
  js-yaml, below), and the parse yields the file's set of *legitimate values*:
  every string at `jobs.<id>.uses` (a reusable-workflow call),
  `jobs.<id>.steps[].uses` (an action), `jobs.<id>.steps[].with.repository` (a
  checkout or dispatch input), and, for a composite action, `runs.steps[].uses`
  and `runs.steps[].with.repository`. **Where those keys are read from is part
  of the rule, not an aside**: `jobs.*` counts only in a repository-root
  workflow (`.github/workflows/<file>.yml|.yaml`), and `runs.steps[]` only in an
  `action.yml|.yaml` whose own `runs.using` is the string `composite` — the one
  declaration that makes those steps a list GitHub runs. Any other file type, or
  a document that does not carry the matching shape, yields **no legitimate
  value at all**: a `runs:` tree in a workflow, a `jobs:` tree in an action file
  or in a `compose.yml`, and a `node20` or `docker` action's `runs.steps` are
  shapes nothing executes, so they dispatch nothing however well they are
  spelled. A `uses:` / `repository:` carve-out then applies to a line **only
  when the value its grammar reads is a member of that set**. If the file is not
  YAML, the path is unknown, or the document does not parse, there is **no
  carve-out at all** and every private reference in it is a finding. A document carrying a `__proto__`, `constructor` or `prototype`
  mapping key at any depth counts as one that does not parse (see "Vendored
  code"), and every key is read as an **own** property, so an inherited `jobs`
  is not a dispatch.

  This is what makes the multi-line text forms findings without a line scanner
  having to recognise them: a heredoc under `run: |`, a folded `run: >-` body, a
  `- |` sequence item, a key that carries its own colon (`run:x: |`), an anchored
  block (`run: &payload |`), a `--- |` whole-document scalar, a quoted value
  (bare or quoted-key) that runs over several lines, and an `env:` mapping whose
  key happens to be `uses` are all *strings* to a parser, dispatched nowhere —
  so nothing in them is excused. Membership is by **value**, not by line: a value
  the same file really does dispatch stays excused wherever else it appears in
  that file, because by then the file carries the name either way.

Owner and repository **names fold case** — GitHub resolves them
case-insensitively, so `uses: <Org>/<Repo>@main` is the same dispatch as the
lower-case spelling and is excused with it. The fold reaches the **comparison**,
not only the grammar: the value a line carries and the value the document
declares are both canonicalised on their owner/repository halves before
membership is tested — the `<path>` inside the checkout and the `@<ref>` stay
exact and case-sensitive — so a `<Org>/<Repo>@main` the file really dispatches
covers that same dispatch's other spellings wherever else they appear in it,
while another path or another ref is another value and is covered by nothing.
The **key** does not fold: `uses:` is the one spelling a runner accepts, so
`Uses: <org>/<repo>@main` is prose.

- `uses:` matches only the grammar GitHub accepts for a cross-repository step,
  `<org>/<repo>[/<path>]@<ref>` — `<path>` a reusable-workflow file under
  `.github/workflows/` or an action directory path, `<ref>` one or more of
  `[A-Za-z0-9._/-]` (branch names contain `/`) and never whitespace, `@` or `#`.
  The `@<ref>` is mandatory (GitHub rejects a ref-less cross-repo `uses:`), and
  requiring it is what keeps `uses: <org>/<repo>/issues/1` out. Where the scan
  knows the file path — a repository walk always does — a `uses:` step is
  excused only in the **repository-root** `.github/workflows/*.yml|.yaml` or in
  an `action.yml|.yaml` at any depth (composite actions live in subdirectories),
  because that is the only place one can run: a `.github/workflows/` directory
  at any other depth never executes, so `nested/.github/workflows/fake.yml` is
  an ordinary document and the reference in it is prose.
- `repository:` / `repositories:` is excused **only in a YAML file**
  (`*.yml|*.yaml`) where the scan knows the path — its grammar is that of an
  ordinary mapping key, legal in any workflow, action or compose file, but
  outside YAML the same text is prose wearing a machine key as a hat and is a
  finding. Being YAML only gets it as far as the structural rule above, which
  finds an Actions location for it in a root workflow or a composite action and
  nowhere else. It has **two
  separate grammars**. The SCALAR form is exactly `<org>/<repo>` under the
  terminator rule above — end of line, a real
  comment, or its own closing quote. A `,` or `]` ends nothing there, because
  nothing was opened: `repository: <org>/<repo>,#1`, `repository: <org>/<repo>/issues/1`
  and `repository: <org>/<repo>#1` are findings, not machine forms. The FLOW
  SEQUENCE form is `key: [<org>/<repo>, <org>/<repo>]` with **paired**
  delimiters, in which every entry must itself be a valid `<org>/<repo>` scalar
  (optionally quoted), with one optional trailing comma before `]` — YAML
  accepts `key: [<org>/<repo>,]` and so does the carve-out. The excused span is
  the whole sequence, so *every* entry is excused by the grammar, while an
  unclosed `[` — or junk in any entry — excuses nothing. In a real file the
  structural rule then decides, and no GitHub Actions input takes a **list** at
  `repository:` (a checkout takes one string), so a parsed document never
  declares such a value and a flow sequence is a finding wherever it stands. The owner of an entry is GitHub's login
  grammar exactly (1–39 of `[A-Za-z0-9-]`, no leading, trailing or consecutive
  hyphen), so an entry such as `bad-/public` names an owner GitHub cannot issue,
  the sequence is not a machine form, and every private entry in it is a
  finding.
- the **clone URL** terminates at `.git` plus a terminator (end of line,
  whitespace, a quote, `,`, `;`, `)`), so `<org>/<repo>.git` is a remote while
  `<org>/<repo>.git/issues/1` is a citation wearing a remote's spelling — and a
  finding. It is anchored on the left as well, and the anchor binds the full
  remotes (`https://github.com/<org>/<repo>.git`,
  `git@github.com:<org>/<repo>.git`, `ssh://git@github.com/<org>/<repo>.git`)
  exactly as it binds the bare `<org>/<repo>.git`: the reference must start a
  line or follow whitespace, an opening quote or bracket, or the `=` of a
  shell/env assignment (`REMOTE=https://github.com/<org>/<repo>.git`). So
  `xhttps://github.com/<org>/<repo>.git` is not a remote and is a finding, and
  neither is anything after an `@`, because `@<org>/<repo>.git` is an npm scope.

### Per-repo config

See [`config/example-config.json`](config/example-config.json). A config may add
`reqIdSinglePrefixes`, `extraRules`, `lineExcludes`, `scanExtensions`,
`skipDirs`, `exemptDirPrefixes`, `exemptFileBasenames`, and
`exemptFileBasenamesExpiry`. Keep your config in your own repo.

### Time-boxed basename exemptions

A whole-file exemption that exists only because some *other*, pinned copy of the
engine lacks a fix is a debt, not a rule — and an undated debt is never paid.
`exemptFileBasenamesExpiry` keys such an entry to the pin that justifies it:

```json
"exemptFileBasenames": ["some-fixture.txt"],
"exemptFileBasenamesExpiry": {
  "some-fixture.txt": {
    "untilPin": {
      "file": ".github/workflows/my-caller.yml",
      "uses": "<org>/<repo>/.github/workflows/<workflow>.yml",
      "sha": "<the 40-character commit sha that target is pinned to today>"
    },
    "why": "one sentence: what the pinned engine cannot do yet"
  }
}
```

`untilPin.file` names the **caller workflow that actually runs**, and only that:
it must be a repository-relative `.github/workflows/<file>.yml|.yaml` path (no
`..`, no absolute segments), must be **tracked** in the scanned tree, and must
not be a symlink. It must also name **one literal file**: a value carrying a
pathspec pattern character (`*`, `?`, `[`, `\`) or a leading `-` is a config
error before git is asked anything, and "tracked" means git — asked with
`--literal-pathspecs` and `-z`, its `NUL`-separated answer compared byte for
byte — lists exactly that path and nothing else, so an untracked file literally
named `.github/workflows/*.yml` can no longer pass on the strength of some other
workflow the glob would have matched, and a tracked workflow whose name carries a
non-ASCII character (which line-terminated `ls-files` output would C-quote) is
read as the tracked file it is. Any other readable file — a `README.md`, a path climbing out of
the tree, a link — could carry the keyed target at the keyed sha long after the
real caller moved, so each of those is a config error rather than a verdict.

Before every scan the gate reads `untilPin.file` out of the **scanned** tree and
takes the ref of the one `uses:` line whose target is `untilPin.uses`. Same sha,
and the exemption is live and the gate says nothing about it. A different sha,
and the exemption has EXPIRED: the run exits 1 and names the basename, the file,
the target, both shas, and the fix — **the pull request that moves the pin
deletes the basename and its expiry entry in the same change.**

The pin is read **structurally**, from the same parse: the caller workflow's
pins are its `jobs.<id>.uses` values — the job-level reusable-workflow calls it
actually dispatches — split with the carve-out's own `<target>@<ref>` grammar. A
step's `uses:` is an action the job runs, not the caller's dispatch of the gate,
and it cannot answer for a keyed target; neither can text that merely spells one
(a heredoc, a folded block, a quoted continuation, an `env:` mapping). A value
the `<target>@<ref>` grammar rejects — no whitespace after the key, a trailing
tail, a ref-less or local `uses:` — is not a pin either, so replacing a real gate
call with text no runner accepts makes the keyed target *missing* (a config
error) instead of leaving the exemption it justifies quietly alive. A pin file
that is **not parseable YAML** is likewise a config error: a caller nobody can
read has no dispatch to be keyed to.

The target is compared **case-canonically**: GitHub resolves the owner and
repository halves case-insensitively, so `Some-Org/CI/.github/workflows/x.yml`
is the same dispatch as `some-org/ci/.github/workflows/x.yml` and answers for it
— while everything after them is a path inside the checkout, where file names
stay case-sensitive. Two spellings of the same target at different refs are
therefore the ambiguous-target config error, not an evasion of it.

`untilPin.uses` is what binds the expiry to the reference it is actually about.
Keyed to "some sha in the file", an exemption survived the very edit it exists to
catch — move the gate reference to `@main`, leave an unrelated
`actions/checkout@<sha>` in place, and the keyed sha was still "in the file".
Only the named target answers now; every other `uses:` line is irrelevant, in
either direction. A basename listed in the map but not in `exemptFileBasenames`,
an entry of the wrong shape (a missing `file`, `uses` or 40-character `sha`), a
`file` that is not a tracked, non-symlink repository-root workflow or that
cannot be read, a named target that is absent, that appears twice with different
refs, or that is not pinned to a commit sha are all config errors
(exit 1): an exemption whose expiry cannot be evaluated must never stay quietly
in force.

### Run locally

```sh
node scripts/source-leak-gate.mjs --profile default --ratchet-mode off
```

Add `--exit-on-match` to make it a gate, `--format json` for machine output.

### Self-exemption

The scanner's rule definitions necessarily contain the markers they detect, so
that region is bracketed by sentinel comments and skipped when the gate scans
its own source — **only** that region: the rest of the engine is scanned
normally, and a marker-bearing line outside it is exempted at the line with a
`source-leak-allow` marker, never by exempting the whole file. (A whole-file
exemption on the engine would discard exactly the findings the sentinel scoping
exists to preserve.) Dedicated test fixtures and baselines are path-exempt, so
the gate's own fixture needs no config entry either. For the
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
into the Integrations chapter of docs.cinatra.ai by the docs publish path.
Integration repos call it **pre-tag** so their per-repo
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

## meta-commentary-gate

A reusable GitHub Actions workflow + standalone Node script
(`node scripts/check-meta-commentary.mjs`, Node builtins only, fully offline)
that fails CI when a repo's **published pages — Markdown and HTML** — carry
commentary that belongs to the people producing the docs rather than to the
people reading them. Four violation classes:

1. **Docs-production meta** — how the page or its assets are produced:
   "compiled from", "published from", "never hand-edit", "this page is
   generated…", "canonical source".
2. **Transition / in-flight notes** — "forthcoming", "coming soon",
   "(pending)", "to be added", "still landing", "not yet landed", "is landing
   in a later release". A published page states what the product does; a
   roadmap state ages into a lie the moment the work ships.
3. **Planning provenance** — a capability described by the internal work item
   that produced it, the acceptance criterion it was reviewed against, or the
   decision that approved it ("epic #123, landed", "cinatra#1607 AC6",
   "ruling 4", "the ratified claim-only mode", "per the ruling") instead of by
   what it does. A reader of a published page cannot resolve those references.
   Since docs#171 the class also covers **derivation** provenance — the numbered
   review or convergence round a constraint came out of, with or without the tool
   or agent that ran it ("<agent> round-12 lesson", "lesson from round 3",
   "<agent> found in round 7"). The binding is the numbered round, never the
   name: a tool or agent name on its own is ordinary product prose and can never
   match.
4. **In-page authoring / publish-status annotation** — editorial scaffolding
   that survived into the published bytes: "publish decision", "spec status",
   "design note, outside the page mock", "a separate, owner-gated publish". The
   same family as class 1, in the vocabulary a design spec accumulates.

The patterns are lexical heuristics, so the engine is as explicit about what it
deliberately does **not** match — bare "landed", "still in flight", "no need to
hand-edit", a released-version CHANGELOG entry, a **bare** `#123` cross-reference
with no history claim, "ratified" next to external-standards vocabulary, "the
decision tree", "X is not yet supported", a tool or agent **name** with no
numbered round bound to it, an **unnumbered** review round ("approval rounds
repeat until the reviewer signs off"), and a numbered round carrying no
derivation claim ("round 2 of the rollout adds the CRM connector"). Every
rule-out is recorded, with its reason, in the header of
[`scripts/check-meta-commentary.mjs`](scripts/check-meta-commentary.mjs);
read it before adding a pattern or filing a false positive.

**docs#160 re-decided one rule-out on evidence.** docs#156 ruled the whole
work-item-link class out on precision grounds. The **repo-qualified** spelling
(`cinatra#1607`, `cinatra-ai/cinatra#1795`) is now IN: it is structurally
unambiguous, it was the form every real occurrence took across the corpus, and a
reader of a published page cannot resolve it — the same defect that makes an
acceptance-criterion or ruling citation a violation. The rule-out was
**narrowed** to the bare `#123` form, not reaffirmed wholesale.

### HTML surfaces

Published documentation is not only Markdown, so the gate scans tracked
`.html` / `.htm` under the configured paths with the same pattern list,
line-pinned allowlist semantics and `reviewBy` expiry. HTML is not matched as raw
source — it is first reduced to its **prose** by
[`scripts/lib/html-text.mjs`](scripts/lib/html-text.mjs), whose header carries
the full per-construct contract. In scope: visible text nodes, HTML **comments**
(they ship in the published bytes and are where authoring annotations
accumulate), and the human-readable attributes `title` / `alt` / `aria-label` /
`aria-description` / `placeholder` / `summary` plus `content` on a
`<meta name="description">`. Out of scope: `<script>` and `<style>` bodies
entirely, and every machine attribute (`href`, `src`, `class`, `id`, `style`,
`data-*`). Entities are decoded before matching (`&nbsp;` to a plain space, so it
cannot defeat a pattern's `[ \t]` gap); inline tags are transparent so a phrase
split by `<b>` still matches; block tags are a hard separator so prose from two
different blocks can never be joined. Reporting stays on the **source** file and
line — every extracted character carries the source offset it came from, and the
allowlist still pins the full raw source line.

### Coverage — the inventory is the closure set

[`config/meta-commentary-inventory.json`](config/meta-commentary-inventory.json)
is the enumerated closure set this gate is measured against: every **public,
non-archived** org repo's default branch, with each surface classified.
Re-recorded on 2026-08-01 (docs#160): **132 repos**, classified `published`,
`staged-listing` (the `.wordpress-org/` and `.drupalorg/` copy staged for the
external directory listings, which is a published surface: an asset-production
note there is removed, not exempted), or `exempt-engineering-internal`.
Only three repos (`.github`, `a2a-servers-dev`, and this one) are exempt end to
end. Five archived public repos are excluded and listed in
`excludedArchivedRepos` — they are read-only, so no caller can be added.

"Published surface" means a page a non-contributor is expected to read: a public
repo's root `README.md` / `CHANGELOG.md`, any `docs/` tree, copy staged for an
external listing, and published HTML reference pages. Contributor-, maintainer-,
and engineering-internal documentation is out of scope **by design**, and every
such exemption is recorded per surface with a rationale rather than implied.

That test governs how a surface is **classified here**. It is emphatically not
something the scanner evaluates: at runtime the recorded paths are the sole
source of truth, the engine receives an explicit list of literal paths, and it
never discovers a repository root or infers an audience from a filename or from
content. A tree is exempt exactly when the caller does not list it —
`--print-files` prints the selected read set so that claim is checkable rather
than asserted.

A surface may record `"coverage": "repo-local"` when something other than a
pinned caller enforces the gate on it (`cinatra-ai/docs` runs its own blocking
check over its whole tracked tree). An **absent** `coverage` means a caller is
required; the escape is recorded, never inferred.

Two rules follow from that:

- **The inventory is the closure set, not a snapshot of adopters.** A repo whose
  in-scope surfaces are not yet covered by a caller is a gap in the rollout, not
  a repo outside the scope. Measure adoption against this file.
- **A new public repo with published pages adopts the caller template.** Copy
  [`templates/meta-commentary-gate.yml`](templates/meta-commentary-gate.yml),
  set `paths` to literal files/directories that cover every `published` or
  `staged-listing` surface recorded for it (the gate does not accept inventory
  globs), and update the inventory in a coordinated `cinatra-ai/ci` change.

### New-surface detection (`meta-commentary-surface-coverage`)

The inventory is a point-in-time census, and nothing re-derives it. A repo
created after it was recorded, or a `docs/` tree added to a repo that previously
published only a README, arrives with no entry and no caller — and every other
check stays green, because each one only ever looks at the paths it was already
told about. The absence is invisible by construction.

[`scripts/meta-commentary-surface-coverage.mjs`](scripts/meta-commentary-surface-coverage.mjs)
closes that. It enumerates the org's **public, non-archived** repos and the
published-surface paths each one actually has, then reconciles that census
against the inventory and against caller presence. Four finding kinds, all of
them failing: `unknown-repo`, `undeclared-surface`, `missing-caller`,
`stale-inventory-repo`.

It is **fail-closed** end to end — no token, an API error, an empty enumeration,
an unparseable inventory and an unreadable tree are all failures. A coverage
check that passes when it cannot see is worse than none, because it reads as
proof. The verdict core is pure and offline (`--census-json <file>`); `--live` is
a thin `gh api` wrapper with no verdict logic in it.

```sh
# reconcile the live org against the committed inventory
node scripts/meta-commentary-surface-coverage.mjs --live --org cinatra-ai

# reconcile a recorded census (what the fixtures do)
node scripts/meta-commentary-surface-coverage.mjs \
  --census-json scripts/__fixtures__/meta-commentary-coverage/census-clean.json \
  --inventory   scripts/__fixtures__/meta-commentary-coverage/inventory.json
```

`.github/workflows/meta-commentary-surface-coverage.yml` runs it weekly, on
demand, and on every change to the inventory or the checker itself. Refreshing
the inventory means running it `--live`, recording what it reports, and bumping
`recordedAt`.

### Use it from another repo

Copy [`templates/meta-commentary-gate.yml`](templates/meta-commentary-gate.yml)
to `.github/workflows/meta-commentary-gate.yml` and fill in the two placeholders:

```yaml
name: meta-commentary-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  meta-commentary-gate:
    uses: cinatra-ai/ci/.github/workflows/meta-commentary-gate.yml@<sha> # vX.Y.Z
    with:
      paths: |
        README.md
        CHANGELOG.md
        docs
      ref: <sha>
```

**Pin BOTH refs to the same SHA.** The workflow ref (`@<sha>`) pins the YAML;
the `ref:` input is what checks out the gate **engine**. A caller that pins only
the workflow ref still runs whatever engine is on mutable `main`, which is
exactly the drift the pin exists to prevent — so `ref` is REQUIRED and is
rejected unless it is a 40-char commit SHA.

**The version comment.** The org actions-pinned-gate validates its syntax
(`# vX.Y.Z` / `# X.Y.Z`, including prerelease/build suffixes); it does not
verify that the comment names an existing tag or that the tag points at the
pinned SHA. For a tagged SHA, use the exact tag: `# v0.1.3`. For an
intentionally between-tags SHA, the current org-local marker is the nearest
preceding tag plus the pinned short SHA: `# v0.1.3-next.7e5f416`. That marker
passes the format gate, but it is not literal `git describe --tags` output
(`v0.1.3-5-g7e5f416` for this SHA) and is not a real tag for Renovate to
resolve. If Renovate-managed updates are required, tag the commit and use that
real tag. Older callers use `+<short-sha>`; that spelling also passes the
format check.

### Path scoping

By default the gate scans a single directory: the `docs` input (default
`docs/`). Most repos publish more than that — a root `README.md`, a
`CHANGELOG.md`, staged listing copy — so the `paths` input takes a **set**
instead: directories and/or single `.md` / `.html` files, newline- and/or
comma-separated. A non-empty `paths` takes precedence over `docs`; omitting it
leaves the original single-directory behavior untouched, so existing callers
pass unchanged.

**Path selection is the only scoping mechanism.** The engine has no semantic
notion of an "implementation-facing" or "internal" tree and must never acquire
one. A caller configured with `README.md,CHANGELOG.md` is green even with a
planted violation under `docs/**`, because `docs/**` is never selected and
therefore never read — a fixture asserts exactly that, including with the
planted tree made unreadable.

Scoping is deliberately **fail-closed**, because a scan that silently covers
less than the caller asked for is worse than no scan:

- A non-empty `paths` value that normalizes to zero entries (for example, only
  commas or whitespace) is a config error (exit 2), never a silent fallback.
  An omitted or empty workflow input selects the `docs` scan by design.
- Every configured entry must exist **and** yield at least one tracked
  Markdown/HTML file. A typo'd, untracked, or prose-free entry is a config
  error, not a quietly narrower scan.
- Entries are **literal paths, never globs** (`--literal-pathspecs`), so a `*`
  in an entry cannot silently widen or shift the scan.
- Only **tracked** files are read (`git ls-files`), so untracked scratch never
  trips the gate. Overlapping entries (`docs,docs/overview.md`) scan once.

### Inputs

| Input | Default | Meaning |
|-------|---------|---------|
| `docs` | `docs` | Single directory to scan. Ignored when `paths` is set. |
| `paths` | `""` | Newline- and/or comma-separated set of directories and/or `.md` / `.html` files to scan instead. Fail-closed; literal paths only. |
| `allowlist` | `.github/meta-commentary-gate-allowlist.json` | Reviewed false positives. An ABSENT file is an EMPTY allowlist. |
| `ref` | _(required)_ | 40-char commit SHA of this repo to check out — the gate engine. Same SHA as the workflow ref. |

### The allowlist

Optional and **per-repo**: an absent file means an empty allowlist, which is
what most repos want. There is deliberately no shared cross-repo allowlist —
each repo owns and reviews its own exceptions. An entry pins the exact **full
source line** the match sits on (not the bare matched phrase, so a second
unrelated line matching the same phrase is not silently covered by the first
line's sign-off) and carries `owner` + `reviewBy`. Once `reviewBy` passes the
entry stops suppressing: the violation reds again until a human re-verifies and
renews the date, or fixes the content. An exception never becomes permanent by
being forgotten.

### Run locally

```sh
# single directory (the default)
node scripts/check-meta-commentary.mjs --docs docs

# a set of published surfaces (Markdown and HTML)
node scripts/check-meta-commentary.mjs --paths "docs,README.md,CHANGELOG.md"

# print the exact read set the configured paths select, then scan
node scripts/check-meta-commentary.mjs --print-files --paths "README.md,CHANGELOG.md"
```

Run it from the repo being scanned (paths resolve against the cwd). Exit codes:
`0` clean · `1` violation(s) · `2` usage/config error.

### Develop

```sh
node --test scripts/__tests__/check-meta-commentary.test.mjs
node --test scripts/__tests__/meta-commentary-html.test.mjs
node --test scripts/__tests__/meta-commentary-surface-coverage.test.mjs
```

Positive and negative fixtures for every pattern id live in
[`scripts/__fixtures__/meta-commentary/`](scripts/__fixtures__/meta-commentary/)
(`clean/`, `violating/`, `multipath/`, `allowlisted/`, `html-clean/`,
`html-violating/`, `boundary-guard/`), the coverage-check censuses in
[`scripts/__fixtures__/meta-commentary-coverage/`](scripts/__fixtures__/meta-commentary-coverage/),
and `self-check.yml` runs the engine against them on every PR.

**Twin.** `cinatra-ai/docs` runs a repo-local copy of this check over its whole
tracked Markdown **and HTML** tree; the two files were byte-identical through docs#119 and
have diverged since (scan scope, its contributor-docs skip paths, the CLI
surface). The **pattern list and its documented policy are kept in sync**, and a
widened list lands **here first** — caller repos enforce the list at the SHA
they pin, so a widened pattern changes what a consumer enforces only once that
consumer moves its pin.

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
  **skills-repo** PR that **names** the impacted skill(s) it updates. A bare PR
  link with no `covers:` list satisfies nothing (coverage can't be verified
  offline — only the recorded decision is enforced, never content correctness).
  This ack is **per-skill**; a finding touching multiple skills needs all of them
  named.
- **(b)** `Skills-reviewed: <note>` — a recorded "checked + updated" assertion
  (covers all impacted skills); or
- **(c)** `Skills-unaffected: <reason>` — a recorded override. The **reason is
  required**: a bare `Skills-unaffected:` satisfies nothing (the issue: "not
  `Skills-unaffected:` only").

#### The `Skills-PR:` ref grammar (fail-closed)

An unrecognized ref acknowledges **nothing** — arbitrary text (or a foreign PR
link) must never launder a finding clear. Accepted:

| Form | Example | Notes |
|------|---------|-------|
| repo-relative number | `#5`, `5`, `GH-5` | Accepted for compatibility, but **ambiguous** — in a cinatra PR body `#5` reads as cinatra#5 to a human. Prefer the URL form. |
| pull URL on `assistant-skills` | `https://github.com/cinatra-ai/assistant-skills/pull/5` | The retired single pack, any owner — the pre-split arm, unchanged. |
| pull URL on a **pinned skills repo** | `https://github.com/cinatra-ai/<a pinned skill repo>/pull/5` | **Recommended** (unambiguous). Valid for exactly the repos this caller pins in `skills_repos` (or `skills_repo`). |

Anything else — prose, a pull URL on any other repo, a lookalike host — is
rejected, **reported** as rejected (so a bad ack never reads as "no ack at all"),
and leaves the finding open.

The accepted repo set is **derived from the caller's own pins**, never a list
maintained inside the gate: the reusable workflow hands its `skills_repos` /
`skills_repo` input to the engine (`--skills-repos`), so the ack grammar tracks
the pinned skills universe automatically as repos are added or retired. With no
pins reaching the engine the URL arm falls back to `assistant-skills` only. The
effective set is echoed in the JSON report (`skillsRepos`) and the step summary.

The caller concatenates the PR body + commit messages into an ack file; the gate
parses these trailers and reports them. In `warn` mode they never change the exit
code; in `enforce` mode an unacknowledged watch finding gates and a matching
recorded ack clears it.

#### Editing the PR description and re-running the check

The PR description is read **from the API at run time**, not from the workflow's
event payload. That distinction is the difference between a check an author can
clear and one they cannot:

- `github.event.pull_request.body` is a **snapshot** taken when the run was
  triggered. Re-running a failed check replays that same payload, so an
  acknowledgement the author adds to the description **after** the first red run
  is invisible to every re-run — the check stays red however they edit it, and
  only a new push or a close/reopen (which delivers a fresh event) clears it.
- Reading the description live means the obvious move works: **edit the
  description, re-run the check**. Only the PR's *identity* (repository + number)
  comes from the payload, and no edit can change either.

The read **fails closed**. If the API read fails there is no fall back to the
payload copy — that fallback is the trap itself, and it would decide a run
against a stale description with nothing in the log saying so:

| Mode | API read fails |
|------|----------------|
| `enforce` | the job **fails** with an error annotation naming the likely cause (most often: the **calling** workflow does not grant `pull-requests: read`, which caps what this reusable workflow can request). |
| `warn` | a warning annotation; the staged description is left **empty** (never partial, never stale) and the run continues — a non-gating mode must not become a gate because of an API hiccup. |

The failure message then states the remediation **that is true for that run**: the
engine is told where the description came from (`--ack-source live | event |
unavailable`, recorded in the JSON report as `ackSource`), so a live-reading run
says "re-run the check", while a run whose caller is pinned to an older gate —
which still reads the payload copy — says a re-run replays the pre-edit
description and names the escape hatches that do work. `--ack-source` changes
only that sentence; it never changes which findings gate. An unknown value fails
loud (exit 2).

> **Caller requirement.** Both description reads (this one, and the push arm's
> merged-PR body) need `pull-requests: read`. A reusable workflow's permissions
> are **capped by the caller**, so the calling workflow must grant that scope too
> — see the caller example below.

### Use it from cinatra

```yaml
name: skills-drift-gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  # REQUIRED: the gate reads the PR description from the API (the pull_request
  # arm reads the current one; the push arm resolves the merged PR's body). A
  # reusable workflow's scope is capped by its caller, so granting it here is
  # what makes those reads possible — without it the enforce run fails closed.
  pull-requests: read
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
| `skills_ref` | _(none)_ | SINGLE-repo mode: skills git ref to check out — pin to the SHA in cinatra's required-extensions lock. Exactly one of `skills_ref` / `skills_repos` must be set; an empty pair fails loud. |
| `skills_repo` | `cinatra-ai/assistant-skills` | SINGLE-repo mode: the skills repository. Also the repo whose pull URLs the `Skills-PR:` ack accepts. |
| `skills_repos` | _(none)_ | MULTI-repo mode: whitespace/comma/newline-separated `owner/name@<40-hex-sha>` entries, each pinned to that repo's `resolvedSha` in the caller's lock. The union of every repo's `skills/<slug>/` bundles is scanned in ONE job (one stable required-check context), and these repos are the ones whose pull URLs the `Skills-PR:` ack accepts. Mutually exclusive with `skills_ref`. |
| `mode` | `warn` | `warn` (non-failing) or `enforce` (gates an unacknowledged **declared-watch** finding; heuristic findings stay advisory). |
| `config` | _(none)_ | Per-repo JSON config (e.g. `primitiveStopwords` to tune the primitive matcher). |
| `ref` | `main` | Ref of this repo to check out (pin to a SHA in production). |

### Run locally

```sh
node scripts/skills-drift-gate.mjs \
  --skills-dir ../assistant-skills/skills \
  --diff-base origin/main --mode warn --format json
```

Add `--ack-file <path>` to feed acknowledgements (a PR description + commit
messages concatenated), and `--ack-source live|event|unavailable` to say where
the description in that file came from — it selects the remediation the failure
prints and is echoed as `ackSource` in the report.

### Develop

```sh
node --test scripts/__tests__/skills-drift-gate.test.mjs
node --test scripts/__tests__/collect-skills-acks.test.mjs
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
and fail-loud on a bad pin / diff base. The `Skills-PR:` **ref grammar** carries
its own matrix: every previously-accepted form still accepted (with and without
pins), a pull URL on each pinned skills repo accepted, and the anti-laundering
rejections pinned — a foreign repo, an owner/repo-name lookalike, a lookalike
host, a non-pull or decorated URL, prose, and a successor-repo URL when the
caller pins nothing.

The **description-source** matrix lives alongside the ack-collector tests: a
mocked API read whose edited description clears a finding the payload copy would
keep red (and the payload copy ignored even when it is the one carrying a
marker), the collector refusing to fall back when a live read is claimed but no
description is staged, an unreadable description staying empty rather than
becoming the stale one, a caller with no live read still reading the payload copy
(so an older workflow pin keeps working), the resolver failing closed on an API
error / a non-numeric PR number while an empty description stays a *successful*
read, each remediation sentence appearing for exactly its own `--ack-source`, and
workflow locks pinning the wiring end to end.

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

Three arms: **pre-merge** (PR claims), **post-merge** (the landed record itself —
a squash message, or each commit of a rebase landing), and a scheduled **org
watchdog**. It currently runs in **WARN**
mode (computes + annotates every finding, always green); the ENFORCE flip is
gated on the dedicated machine identity for agent-opened PRs (spec §8.5), tracked
as an `[owner]` issue — it is **not** a gate-config change.

### Landed shape: squash vs rebase merges (§7)

A **squash** merge lands one commit carrying the whole reviewed change, so the
post-merge arm binds that commit's own diff to the PR's reviewed change. A
**rebase** merge lands the PR's commits *individually* and reports the **last**
of them as `merge_commit_sha` — so binding that one commit's diff to the PR's
whole reviewed change can never match (cinatra-ai/ci#94). The arm therefore
classifies the landing first, from facts it asserts rather than assumes: the PR
merged at this commit, it has 2..249 commits, the local first-parent walk yields
those N single-parent commits plus the commit they landed on, and each landed
commit carries the corresponding reviewed commit's message **verbatim** (a rebase
preserves messages; a squash synthesizes one). Only then is the content binding
taken over the whole landed range (`base..tip`) against the PR's full reviewed
change, and **each landed commit's own record is judged per-commit** — its own
grammar/arm, its own `Reviewed-by`/`Gate-suite` claims against the PR's real
approvals and contexts, its own high-risk surface, its own check 5. Anything
unproven classifies as a single-commit landing and binds exactly as before (fail
closed), and a tampered rebased range still has to re-derive the reviewed
fingerprint over the whole range, so any altered commit still reds. The JSON
report names the shape it bound over in `landing`.

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
   zero registry dependencies — anything else is vendored under
   `scripts/lib/vendor/`, see "Vendored code").
2. Add unit tests at `scripts/__tests__/<gate-name>.test.mjs` using
   `node:test`.
3. Add the reusable workflow at `.github/workflows/<gate-name>.yml`.
4. Where the gate has a local script, add a `self-check` step so it dogfoods
   on this repo.
5. Document the gate in this README (purpose, thin-caller snippet, inputs
   table, local run command where applicable, develop command).

### Vendored code

Gate engines run inside consuming repositories' CI with **no `npm install`**, so
they may only import files committed under `scripts/`. Where an engine needs a
third-party library, the library is vendored under `scripts/lib/vendor/<name>/`,
verbatim, with its licence beside it:

| file | what it is |
| --- | --- |
| [`scripts/lib/vendor/js-yaml/js-yaml.mjs`](scripts/lib/vendor/js-yaml/js-yaml.mjs) | the single-file ESM build of the `js-yaml` package, **4.1.1** (MIT), used by `source-leak-gate` to parse YAML and decide which values stand at a real GitHub Actions location |
| [`scripts/lib/vendor/js-yaml/LICENSE`](scripts/lib/vendor/js-yaml/LICENSE) | the package's MIT licence, as published |
| [`scripts/lib/vendor/js-yaml/PROVENANCE.md`](scripts/lib/vendor/js-yaml/PROVENANCE.md) | package, version, registry tarball URL and its `dist.integrity`, the vendored file's sha256, the date, and the refresh procedure |

The copy is never edited in place, and it is **not** an npm dependency — there is
no `package.json` entry for it. A drift test in
`scripts/__tests__/source-leak-gate.test.mjs` recomputes the sha256 of
`js-yaml.mjs` and compares it with the digest recorded in `PROVENANCE.md`, so
refreshing the copy without updating its provenance (or editing it at all) fails
the suite. The directory is excluded from the repository lint in
`eslint.config.mjs` for the same reason: nobody may fix a finding in it.

A parsed document is **attacker-shaped input** — the text comes from the
repository being scanned — so the engine never trusts the parser to be the whole
defence. js-yaml 4.1.0 protected a directly written `__proto__` mapping key but
not the **merge** path (`<<:`), so a document could set a parsed object's
prototype and make the engine read an *inherited* `jobs` — a dispatch the file
never declares, which forges both a carve-out and a live `uses:` pin at once.
4.1.1 fixes the parser, and independently of the parser version the engine (a)
reads **own properties only**, and treats a value whose prototype is neither
`Object.prototype` nor `null` as absent; (b) treats a document carrying a
`__proto__`, `constructor` or `prototype` mapping key **at any depth** as
unparsable — no carve-out for anything in it, and a config error if it is a pin
file; and (c) snapshots the own-property names of `Object.prototype`,
`Array.prototype` and `Function.prototype` before every parse and compares them
after, aborting the **whole run** with a named `PrototypePollutionError` and a
non-zero exit if any of them changed — a run whose interpreter was edited by its
own input has no trustworthy verdict to report, including the clean ones it
already printed.

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
