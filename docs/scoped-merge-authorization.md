# Scoped merge authorization

The `delegated-v1` arm records a scoped standing authorization to squash a pull
request. It does not claim that a person reviewed its commits. An actual
`Reviewed-by` line always requires the corresponding genuine review, including
when this authorization is also present. Required checks, workflow provenance,
assistance attribution and high-risk classification continue to run.

The record uses this exact trailer:

```text
Merge-authorization: delegated-v1 https://github.com/ORG/REPO/pull/NUMBER#issuecomment-ID sha256:DIGEST
```

The PR body selects the same immutable receipt with one exact line:

```text
Merge authorization: https://github.com/ORG/REPO/pull/NUMBER#issuecomment-ID SHA256:DIGEST
```

The hosted verifier trusts only the supported authority in the pinned engine's
`config/delegated-merge-authorities.json`. Candidate files, command-line flags,
environment variables and PR text cannot supply a new authority. It verifies
the configured bot user and App, the immutable comment timestamps and canonical
payload digest, and requires the pointer to select the newest authenticated
receipt comment. Missing, edited, deleted, superseded, refused or revoked
receipts fail closed.

The sanitized receipt binds the exact repository ID and name, PR, head and
branch, head tree, actual target ref and SHA, governance revision, complete file
inventory including rename/status information, and mechanically computed merge
tree. Opaque digests bind the private registration, membership verification and
standing authorization. Private instructions and membership evidence remain in
the trusted coordinator journal. The hosted verifier does not claim it can read
private cross-repository membership: the authenticated producer attests that
snapshot, and the canonical merge road revalidates it immediately before merge.

A receipt is valid for at most 24 hours. Pre-merge verification reads the live
target ref rather than relying on the PR payload's potentially lagging base SHA,
checks the whole inventory, and rechecks all bindings after the reads. Post-merge
verification uses `merged_at` for expiration and requires the associated landed
commit to have exactly the authorized base as its sole parent and the authorized
merge tree. Later ordinary target-branch advances do not invalidate that
historical landing. Merge-queue and rebase landings are outside this arm.

Install the engine through ordinary immutable consumer-pin updates. Repositories
whose existing enforcing attribution caller uses an older engine must obtain a
real successful compatible hosted execution before using this arm; no local
authorization suppresses a legacy failed check. The engine repository's own
required safety gates remain required during bootstrap. The new arm does not
grant App permissions or authorize unrelated deployment or resource purchases.
