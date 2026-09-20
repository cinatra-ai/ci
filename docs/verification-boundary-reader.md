# Authenticated current verification boundaries

Run the engine from an immutable, trusted checkout, with Python 3 and `gh` on
Linux/macOS. Candidate repository contents, environment variables and arguments
cannot select its principal policy or parser:

```sh
python3 /path/to/pinned-engine/scripts/verification-boundary.py \
  --repo cinatra-ai/ci --pr 123 --head FULL_40_HEX_HEAD
```

The command permits fixed `github.com` GETs only, with REST `2022-11-28`, a
40-second transport timeout and at most 20 comment pages per snapshot. It reads
the exact repository/PR/head, complete ordered comment inventory and individual
protocol comments, then repeats the snapshot. The source-owned principal comes
from the engine's `config/delegated-merge-authorities.json`; only its organization
and numeric Bot/App identity are reused. The delegation grant is not boundary
authority. Present wrong App metadata, absent/redacted App metadata, edited
comments, invalid canonical bytes, missing predecessors and moving reads refuse.
No token grants, publisher command, candidate trust override or body fallback are
provided.

`scripts/boundary_receipts.py` is byte-identical to the canonical module from
DevOps commit `7bc8509b110196af08feb4abf5cc568a5d63bb5a`, SHA256
`ef30c4c14b7f4532bb55ae923e77924dc86451d18d08f88a17bfd121f29d66c5`.
The test asserts these bytes and executes the real CLI against synthetic GET
transport. Its golden comment was emitted by that exact producer, not a second
envelope implementation. The complete module is vendored to preserve one
protocol; the hosted entrypoint calls only `stable_read`, `chain` and `verdict`,
and never its private publication/state functions.

A successful result is one JSON object with schema
`cinatra.verification-boundary-current/v1`, repository name/numeric ID, PR number,
full head, state, authenticated comment ID and receipt digest. Only `candidate`
and `promoted` are queue eligible. A promotion must immediately follow a
same-head `candidate-pending-ci` receipt and cover every exact pending check name.
The newest authenticated outcome across **all heads** governs. `not-a-lane`,
pending and failed states do not grant queue eligibility. Actual required checks
must still be evaluated independently.

## Queue identity from attribution

The existing attribution command in `--arm merge-group --mode enforce --format
json` includes `queueBinding` only after all findings are clear and the actual
API/Git context binds one PR, its current initial/final identity, ordered group
parents and computed merge tree. The projection has schema
`cinatra.queue-binding/v1`, `repository`, `repositoryId`, `pullRequest`, `headSha`,
`headRepositoryId`, `baseRef`, `baseSha`, `groupHeadSha`, `parents`, `groupTree` and
`authority` (`review` or `delegated-v1`). The base SHA is the actual group parent;
GitHub's potentially lagging PR `base.sha` does not replace it. The ordinary
qualified-review path still permits a fork head and records its repository ID.
Delegation continues to require the existing v1 receipt's same-repository head,
frozen base and tree. Invalid declared delegation cannot fall back to a review.

Warning, offline, failed, pre-merge and post-merge reports carry a null binding.
A consumer must execute its pinned engine itself, require successful enforce
output and matching requested group/repository identities, and repeat its reads
after waiting for checks. An editable or caller-supplied JSON report is not
authority. This source unit does not wire or advance a repository's consumer pin.

## Current-view limits and activation

This hosted read establishes a complete stable **current** chain. It does not
read or replace the private coordinator's durable observed frontier or unresolved
publication intent. A new ephemeral directory cannot prove that an unobserved
tail was never deleted. Coordinator final merge checks retain those separate
durable safeguards; the hosted command creates no substitute journal.

An asynchronous queue may land without a final coordinator call. Its future
transport/activation must resolve the publication fence/frontier throughout the
queued lifetime, not claim a pre-enqueue check or post-merge discovery provides
the same guarantee. Native enqueue journaling, exact record preservation,
consumer pins/checks, ruleset/bypass authority, dequeue/rollback and a real canary
remain separate prerequisites. No queue, ruleset, grant or active policy is
changed here.
