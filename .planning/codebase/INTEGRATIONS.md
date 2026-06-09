# External Integrations

**Analysis Date:** 2026-06-09

## APIs & External Services

**GitHub Actions (CI Platform):**
- GitHub Actions — reusable workflow host; this repo IS the shared CI infrastructure consumed by other repos in the `cinatra-ai` org
  - SDK/Client: Not applicable (YAML workflow definitions)
  - Auth: GitHub-managed (repository `contents: read` permission declared in both workflows)

## Data Storage

**Databases:**
- Not applicable

**File Storage:**
- Local filesystem only — scanner reads files from the caller's checked-out workspace; no remote storage

**Caching:**
- Not detected

## Authentication & Identity

**Auth Provider:**
- GitHub Actions token (implicit `GITHUB_TOKEN`) — workflows declare `permissions: contents: read`; no explicit secrets or external auth providers used

## Monitoring & Observability

**Error Tracking:**
- Not detected

**Logs:**
- Console stdout/stderr from `node scripts/source-leak-gate.mjs`; structured JSON output available via `--format json` flag

## CI/CD & Deployment

**Hosting:**
- GitHub (`cinatra-ai/ci` repository)

**CI Pipeline:**
- `.github/workflows/self-check.yml` — dogfood self-check: runs gate with `--ratchet-mode off` on this repo itself, then runs the test suite via `node --test`
- `.github/workflows/source-leak-gate.yml` — reusable `workflow_call` workflow consumed by other repos in the org

**How consuming repos integrate:**
- Add a thin caller workflow that references `cinatra-ai/ci/.github/workflows/source-leak-gate.yml@<sha>`
- Optionally supply a per-repo `--config` JSON file for project-specific token lists and rule extensions

## Environment Configuration

**Required env vars:**
- `SOURCE_LEAK_DIFF_BASE` — set automatically by the reusable workflow via the "Compute diff base" step; used by the scanner to determine the PR diff base for line-ratchet mode

**Secrets location:**
- No secrets required; no `.env` files present in repo

## Webhooks & Callbacks

**Incoming:**
- Not applicable — CI is triggered by GitHub `pull_request` and `push` events via `workflow_call`

**Outgoing:**
- Not applicable

## External GitHub Actions Used (pinned by SHA)

| Action | Pin SHA | Version Comment |
|--------|---------|-----------------|
| `actions/checkout` | `df4cb1c069e1874edd31b4311f1884172cec0e10` | v6.0.3 |
| `actions/setup-node` | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` | v6.4.0 |

Both actions are used in `.github/workflows/self-check.yml` and `.github/workflows/source-leak-gate.yml`.

---

*Integration audit: 2026-06-09*
