#!/usr/bin/env bash
# Resolve the diff BASE ref a working-tree gate should diff HEAD against, from
# the triggering event's context. Writes the resolved value to stdout (empty =>
# no base => the gate scans the full working tree, which surfaces MORE findings,
# never fewer — a fail-SAFE default).
#
# This is the SINGLE source of truth for the diff-base logic. The reusable gate
# workflows that diff against a base (source-leak and skills-drift) and
# this logic's regression test (`scripts/__tests__/resolve-diff-base.test.mjs`)
# all invoke THIS script, so the base a gate diffs against in production and the
# base under test can never drift apart (same rationale as collect-skills-acks.sh).
#
# WHY merge_group matters (the reason this script exists): a GitHub merge-queue
# candidate runs the required gates under the `merge_group` event, whose payload
# carries NEITHER `pull_request` NOR `before`. Without a merge_group arm the base
# resolved empty and the gate silently full-scanned the synthetic candidate — the
# incremental (ratchet-line) semantics a PR gets were lost on exactly the commit
# that decides whether the merge lands. The merge_group arm restores the correct
# incremental base: `merge_group.base_sha` is the tip of the target branch the
# queue is merging onto, and (because the caller checks out the candidate with
# fetch-depth: 0) it is an ancestor of HEAD and always reachable — no extra fetch.
#
# This does NOT weaken any gate: it only makes the base MORE precise on
# merge_group (an empty base full-scans, which can only add findings); the
# pull_request and push arms are byte-for-byte the prior inline behaviour.
#
# Inputs (all via env; a branch ref / SHA is attacker-influenceable, so every
# value is passed via env and never interpolated into a shell line — no command
# injection via a crafted ref, and source-leak-gate's prior inline `${{ }}`
# interpolation of base.ref is retired in favour of this env-only path):
#   PR_BASE_REF   github.event.pull_request.base.ref   (pull_request arm)
#   MG_BASE_SHA   github.event.merge_group.base_sha    (merge_group arm)
#   EVENT_BEFORE  github.event.before                  (push arm)
#   EVENT_NAME    github.event_name                    (optional; documentation only)
#
# Resolution precedence — for a real event exactly one arm is populated, so the
# order only disambiguates impossible overlaps and is deterministic regardless:
#   pull_request : PR_BASE_REF set          -> origin/<base.ref>
#   merge_group  : MG_BASE_SHA set (non-zero)-> <base_sha>
#   push         : EVENT_BEFORE set (non-zero)-> <before>
#   otherwise                                -> "" (empty => full-tree scan)
#
# Output: the resolved base ref on stdout (possibly empty), one trailing newline.
set -euo pipefail

PR_BASE_REF="${PR_BASE_REF:-}"
MG_BASE_SHA="${MG_BASE_SHA:-}"
EVENT_BEFORE="${EVENT_BEFORE:-}"

ZERO_SHA="0000000000000000000000000000000000000000"

if [ -n "$PR_BASE_REF" ]; then
  printf '%s\n' "origin/$PR_BASE_REF"
elif [ -n "$MG_BASE_SHA" ] && [ "$MG_BASE_SHA" != "$ZERO_SHA" ]; then
  printf '%s\n' "$MG_BASE_SHA"
elif [ -n "$EVENT_BEFORE" ] && [ "$EVENT_BEFORE" != "$ZERO_SHA" ]; then
  printf '%s\n' "$EVENT_BEFORE"
else
  printf '\n'
fi
