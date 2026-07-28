#!/usr/bin/env bash
# Materialize a UNION skills tree from several pinned skill repositories
# (cinatra#2090 S3: the watch-bearing SKILL.mds no longer live in ONE
# assistant-skills pack — they are spread across the successor skill repos).
#
# This is the SINGLE source of truth for the multi-repo materialization logic.
# The reusable gate workflow and its regression test
# (`scripts/__tests__/materialize-skills-union.test.mjs`) both invoke THIS
# script, so the behaviour shipped and the behaviour under test can never
# drift apart.
#
# For each entry `owner/name@sha` the script fetches the repo at EXACTLY that
# commit (depth-1 fetch by full SHA — a pinned snapshot, never a moving
# branch) and copies its `skills/<slug>/` bundles into ONE aggregate
# `<out>/skills/` dir. The scan engine then runs UNCHANGED over the
# union (`--skills-dir <out>/skills`), scanning every router SKILL.md and the
# union of their `cinatra-watches` declarations, and the required-check
# context stays the single caller-job context — no per-repo checks.
#
# Fail-loud, by design (same posture as the single-repo pin):
#   - an entry that is not `owner/name@<40-hex-sha>` fails (no branch pins, no
#     shell metacharacters — entries reach git only as validated arguments);
#   - a fetch/checkout failure fails;
#   - a repo with no `skills/` dir fails (a wrong pin must not silently shrink
#     the watched surface);
#   - a bundle slug that appears in TWO repos fails (an ambiguous union would
#     attribute watches to the wrong package).
#
# Inputs (via env; the repo list is caller-influenceable, so every value is
# validated and passed as discrete arguments, never interpolated):
#   SKILLS_REPOS  whitespace/comma/newline-separated `owner/name@sha` entries
#   UNION_DIR     output dir (created; must not pre-exist with content)
#   GIT_BASE_URL  optional clone base (default https://github.com) — the test
#                 points this at local fixture remotes; entries stay validated
#                 either way.
#
# Output: one `materialized <owner/name>@<sha> (<n> bundle(s))` line per repo
# on stdout, then `union <total> bundle(s) from <k> repo(s)`.
set -euo pipefail

SKILLS_REPOS="${SKILLS_REPOS:-}"
UNION_DIR="${UNION_DIR:-}"
GIT_BASE_URL="${GIT_BASE_URL:-https://github.com}"

if [ -z "$SKILLS_REPOS" ]; then
  echo "materialize-skills-union: SKILLS_REPOS is empty — the gate must read PINNED snapshots, never a default." >&2
  exit 1
fi
if [ -z "$UNION_DIR" ]; then
  echo "materialize-skills-union: UNION_DIR is required." >&2
  exit 1
fi

mkdir -p "$UNION_DIR/skills" "$UNION_DIR/.checkouts"

# Normalize separators (commas/newlines -> spaces); iterate validated entries.
entries="$(printf '%s' "$SKILLS_REPOS" | tr ',\n' '  ')"
total_bundles=0
repo_count=0
for entry in $entries; do
  [ -z "$entry" ] && continue
  if ! printf '%s' "$entry" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+@[0-9a-f]{40}$'; then
    echo "materialize-skills-union: invalid entry '$entry' — expected owner/name@<40-hex-sha> (pinned SHA, not a branch)." >&2
    exit 1
  fi
  repo="${entry%@*}"
  sha="${entry##*@}"
  name="${repo##*/}"
  dest="$UNION_DIR/.checkouts/$name"

  git init -q "$dest"
  git -C "$dest" remote add origin "$GIT_BASE_URL/$repo"
  if ! git -C "$dest" fetch -q --depth 1 origin "$sha"; then
    echo "materialize-skills-union: could not fetch $repo at $sha — bad pin?" >&2
    exit 1
  fi
  git -C "$dest" -c advice.detachedHead=false checkout -q "$sha"

  if [ ! -d "$dest/skills" ]; then
    echo "materialize-skills-union: $repo@$sha has no skills/ dir — a wrong pin must not silently shrink the watched surface." >&2
    exit 1
  fi

  bundle_count=0
  for bundle in "$dest"/skills/*/; do
    [ -d "$bundle" ] || continue
    slug="$(basename "$bundle")"
    if [ -e "$UNION_DIR/skills/$slug" ]; then
      echo "materialize-skills-union: bundle slug '$slug' appears in more than one repo — refusing an ambiguous union." >&2
      exit 1
    fi
    cp -R "$bundle" "$UNION_DIR/skills/$slug"
    bundle_count=$((bundle_count + 1))
    total_bundles=$((total_bundles + 1))
  done
  if [ "$bundle_count" -eq 0 ]; then
    echo "materialize-skills-union: $repo@$sha ships no skills/<slug>/ bundle — a wrong pin must not silently shrink the watched surface." >&2
    exit 1
  fi
  repo_count=$((repo_count + 1))
  echo "materialized $repo@$sha ($bundle_count bundle(s))"
done

if [ "$repo_count" -eq 0 ]; then
  echo "materialize-skills-union: SKILLS_REPOS contained no entries." >&2
  exit 1
fi
echo "union $total_bundles bundle(s) from $repo_count repo(s)"
