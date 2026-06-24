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
# Inputs (all via env; branch names, PR bodies, and SHAs are
# attacker-influenceable, so every value is passed via env and never
# interpolated into a shell line — no command injection via a crafted ref):
#   EVENT_NAME    github.event_name ("pull_request" or "push")
#   PR_BODY       github.event.pull_request.body         (pull_request arm)
#   BASE_REF      github.event.pull_request.base.ref      (pull_request arm)
#   EVENT_BEFORE  github.event.before                     (push arm)
#
# Output: the concatenated ack text on stdout.
set -euo pipefail

EVENT_NAME="${EVENT_NAME:-}"
PR_BODY="${PR_BODY:-}"
BASE_REF="${BASE_REF:-}"
EVENT_BEFORE="${EVENT_BEFORE:-}"

ZERO_SHA="0000000000000000000000000000000000000000"

if [ "$EVENT_NAME" = "pull_request" ]; then
  # Concatenate the PR body and every commit message in the range so the gate
  # reads Skills-* markers from either.
  printf '%s\n' "$PR_BODY"
  git log --format='%B' "origin/$BASE_REF...HEAD" 2>/dev/null || true
else
  # push (e.g. squash merge): the marker lives in the squash commit body (HEAD).
  # Read the full pushed range when github.event.before is a real ancestor of
  # HEAD; otherwise (branch-create, force-push, missing/non-ancestor before)
  # fall back to the HEAD commit body.
  if [ -n "$EVENT_BEFORE" ] && [ "$EVENT_BEFORE" != "$ZERO_SHA" ] && git merge-base --is-ancestor "$EVENT_BEFORE" HEAD 2>/dev/null; then
    git log --format='%B' "$EVENT_BEFORE..HEAD" 2>/dev/null || git log -1 --format='%B' HEAD
  else
    git log -1 --format='%B' HEAD
  fi
fi
