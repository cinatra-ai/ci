#!/usr/bin/env bash
# Collect skills-drift acknowledgement markers (Skills-PR / Skills-reviewed /
# Skills-unaffected) into a single text blob written to stdout.
#
# This is the SINGLE source of truth for the ack-collection logic. The reusable
# gate workflow and its regression test
# (`scripts/__tests__/collect-skills-acks.test.mjs`) both invoke THIS script, so
# the push-arm behaviour they ship and the behaviour under test can never drift
# apart.
#
# The marker can live in the PR body OR a commit message; on a squash merge to
# main it lands in the squash commit body, which is HEAD on main. The gate's
# node script reads acks ONLY from --ack-file, so the push arm MUST collect them
# too — otherwise a declared-watch finding fails on push even though the squash
# body acknowledged it (the required gate would red main with no way to clear).
#
# A push event carries no PR body, yet the marker may live ONLY in the PR body
# (the squash body need not repeat it as a trailer). The workflow therefore
# resolves the merged PR out-of-band (the commit->PR association) and stages that
# body in PR_BODY_FILE, which this script folds into the push arm — the SAME
# trust source the pull_request arm reads (the ack is an unbound self-attestation
# recorded on the PR; it is not approval-bound in either arm). PR_BODY_FILE is a
# RECOVERY source: unset/empty (a direct push with no PR, or an API miss) leaves
# only the commit trailers, i.e. the prior fail-closed behaviour, unchanged.
#
# Inputs (all via env; branch names, PR bodies, and SHAs are
# attacker-influenceable, so every value is passed via env and never
# interpolated into a shell line — no command injection via a crafted ref):
#   EVENT_NAME    github.event_name ("pull_request" or "push")
#   PR_BODY       github.event.pull_request.body         (pull_request arm)
#   BASE_REF      github.event.pull_request.base.ref      (pull_request arm)
#   EVENT_BEFORE  github.event.before                     (push arm)
#   PR_BODY_FILE  path to the resolved merged-PR body     (push arm; optional)
#
# Output: the concatenated ack text on stdout.
set -euo pipefail

EVENT_NAME="${EVENT_NAME:-}"
PR_BODY="${PR_BODY:-}"
BASE_REF="${BASE_REF:-}"
EVENT_BEFORE="${EVENT_BEFORE:-}"
PR_BODY_FILE="${PR_BODY_FILE:-}"

ZERO_SHA="0000000000000000000000000000000000000000"

if [ "$EVENT_NAME" = "pull_request" ]; then
  # Concatenate the PR body and every commit message in the range so the gate
  # reads Skills-* markers from either.
  printf '%s\n' "$PR_BODY"
  git log --format='%B' "origin/$BASE_REF...HEAD" 2>/dev/null || true
else
  # push (e.g. squash merge): the marker may live in the merged PR's body
  # (staged in PR_BODY_FILE by the workflow) AND/OR the squash commit body (HEAD).
  # Emit the PR body FIRST (empty/unset => nothing) so a PR-body-only ack is
  # collected even when the squash body did not repeat it as a trailer; then the
  # pushed commit range. Require a REGULAR, readable file (`-f` excludes a
  # directory path; `-r` excludes an unreadable one) and `cat --` so a missing or
  # odd path is inert rather than tripping errexit — the file is produced by the
  # trusted workflow, but keep the collector total.
  if [ -n "$PR_BODY_FILE" ] && [ -f "$PR_BODY_FILE" ] && [ -r "$PR_BODY_FILE" ]; then
    cat -- "$PR_BODY_FILE"
    printf '\n'
  fi
  # Read the full pushed range when github.event.before is a real ancestor of
  # HEAD; otherwise (branch-create, force-push, missing/non-ancestor before)
  # fall back to the HEAD commit body.
  if [ -n "$EVENT_BEFORE" ] && [ "$EVENT_BEFORE" != "$ZERO_SHA" ] && git merge-base --is-ancestor "$EVENT_BEFORE" HEAD 2>/dev/null; then
    git log --format='%B' "$EVENT_BEFORE..HEAD" 2>/dev/null || git log -1 --format='%B' HEAD
  else
    git log -1 --format='%B' HEAD
  fi
fi
