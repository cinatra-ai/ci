#!/usr/bin/env bash
# Resolve a pull request's CURRENT description from the API and stage it in a
# file, so a check that reads the description sees what the description says
# RIGHT NOW rather than what it said when the run was first triggered.
#
# WHY (the re-run trap this closes). A workflow that reads the description from
# the `pull_request` event payload reads a FROZEN snapshot: "Re-run failed jobs"
# (and "Re-run all jobs") replays that same payload, so a description the author
# edited after the first run is invisible to every re-run. For a check that asks
# the author to ADD a line to the description, that is a dead end — the author
# adds the line, re-runs, and the check reads the pre-edit description and stays
# red; only a new push or a close/reopen (which delivers a fresh event) clears
# it. Reading the body from the API at run time makes a plain re-run pick up the
# edit, which is what an author expects the re-run button to do.
#
# The event payload still supplies the IDENTITY (repository + PR number) — an
# edit cannot change either — while the CONTENT is always fetched live.
#
# FAIL CLOSED. When the read fails there is NO fall back to the frozen payload
# body: a silent fallback would resurrect exactly the trap above (a verdict
# computed from a stale description, with nothing in the log saying so).
#   - MODE=enforce (or any non-`warn` value): exit 1 with an error annotation,
#     so the run is red with a diagnostic the author can act on.
#   - MODE=warn: this mode never gates, so a read failure must not turn it into
#     a gate — emit a warning annotation, leave the staged file EMPTY (never
#     partial, never stale), and exit 0. The caller is told the body is
#     unavailable so it can say so instead of implying "no acknowledgement".
#
# Inputs (all via env; a description is author-controlled text, so it is never
# interpolated into a shell line, never eval'd or sourced, and only ever
# redirected into a file):
#   GH_TOKEN    token for the API read (needs `pull-requests: read`)
#   REPO        owner/name of the pull request's repository
#   PR_NUMBER   the pull request number (identity from the event payload)
#   MODE        warn | enforce — decides the read-failure behaviour above. Unset
#               means `warn`, the same default the workflow input and the gate
#               engine use; any OTHER unrecognized value is treated as gating, so
#               a typo can never buy a fail-open read.
#   OUT         path of the file to stage the description in (required)
#
# Output: the description is written to $OUT; a single `source=<live|unavailable>`
# line is printed on stdout for the caller to record and forward.
set -euo pipefail

GH_TOKEN="${GH_TOKEN:-}"
REPO="${REPO:-}"
PR_NUMBER="${PR_NUMBER:-}"
MODE="${MODE:-warn}"
OUT="${OUT:-}"

if [ -z "$OUT" ]; then
  echo "::error::OUT (the file to stage the pull request description in) is required." >&2
  exit 2
fi

# Start EMPTY: every later exit path then leaves either a complete body or
# nothing at all — a reader can never pick up a half-written description.
: > "$OUT"

# One exit path for every "the live description is not available" case, so the
# fail-closed decision is made in exactly one place.
unavailable() {
  if [ "$MODE" = "warn" ]; then
    echo "::warning::could not read the pull request description from the API ($1). This run reports acknowledgements from the commit range only; it does NOT fall back to the description carried in the event payload." >&2
    echo "source=unavailable"
    exit 0
  fi
  echo "::error::could not read the pull request description from the API ($1). Failing closed: the description carried in the event payload is a pre-re-run snapshot, so using it would silently judge this run against a stale description. Re-run once the API read can succeed (the job needs 'pull-requests: read', which a reusable workflow only gets if the CALLING workflow grants it too)." >&2
  exit 1
}

case "$PR_NUMBER" in
  "" | *[!0-9]*) unavailable "pull request number missing or not numeric" ;;
esac
[ -n "$REPO" ] || unavailable "repository (owner/name) not provided"
[ -n "$GH_TOKEN" ] || unavailable "no API token available to the job"

# Write through a temp file and move it into place only on success, so a read
# that dies mid-stream cannot leave a truncated description looking complete.
# `.body` is null when the author left the description empty — an empty body is
# a legitimate answer (no acknowledgement), NOT a failed read.
tmp="$OUT.partial"
err="$OUT.partial.err"
if gh api "/repos/$REPO/pulls/$PR_NUMBER" --jq '.body // ""' > "$tmp" 2> "$err"; then
  mv -- "$tmp" "$OUT"
  rm -f -- "$err"
  echo "source=live"
  exit 0
fi

detail="$(tr '\n' ' ' < "$err" 2>/dev/null | cut -c1-300 || true)"
rm -f -- "$tmp" "$err"
unavailable "API read failed: ${detail:-no detail reported}"
