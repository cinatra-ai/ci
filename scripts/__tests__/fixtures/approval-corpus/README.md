# The approval conformance corpus

One question, many readers: **does the owner's approval count at head H?** Every reader of that fact runs every case in this
folder and must read the verdict the case expects. In this repository the readers are `head_arrival.py` (run by
`tests/test_approval_corpus.py`) and `head-arrival.mjs` (run by `tests/approval-corpus.test.mjs`). A reader in another repository
vendors this folder unchanged, under a digest pin, and runs it the same way.

A fault found later in any reader becomes one new case here, and every reader must pass it.

## The rule the cases pin

The rule is the one in `head_arrival.py`'s module text. In short:

- The owner's latest deciding review is read from every review page. The deciding states are `APPROVED`, `CHANGES_REQUESTED`
  and `DISMISSED`; a `COMMENTED` review decides nothing. It must be `APPROVED` at H.
- The approval counts only when GitHub recorded its `submitted_at` strictly after H arrived in this pull request, or when the
  owner's plain-forward rule keeps it.
- Every time compared is a time GitHub recorded. A commit's author or committer date is never one of them.
- Every row is validated before any filter. The closed sets are GitHub's published ones (`../github-rest-excerpt.json`), and a
  documented null is passed over.

## The format of a case

Each case is one JSON file, `<case>.json`. All data is synthetic: example logins, example repositories and synthetic shas. No
case holds private data.

```json
{
 "corpus": 1,
 "case": "<the file name without .json>",
 "about": "<what the case pins, in one or two sentences>",
 "origin": "<where the case came from: a review finding, a published schema fact, a live shape>",
 "ask": {"reading": "owner-approval", "repository": "<org>/<repo>", "pull": 7, "head": "<40 hex>", "owner": "<login>"},
 "platform": {
  "rest": {"<endpoint>": <the JSON answer>},
  "links": {"<endpoint>": "<the next page's endpoint>"},
  "diffs": {"<endpoint>": "<the diff text>"},
  "mergeTrees": {"<p1> <p2>": "<tree sha> or CONFLICT"}
 },
 "expect": {"exit": 0, "verdict": "counts", "line": "<a part of the reader's line>"}
}
```

- **`ask`** is the question. `reading` is always `owner-approval` in format 1: the owner's approval of `head` on that pull
  request.
- **`platform.rest`** maps each REST endpoint the reader asks to its answer. The keys have no leading slash, and the query is
  written exactly as the reader asks it. For example:
  - `repos/<org>/<repo>/pulls/<n>/reviews?per_page=100&page=<p>`
  - `repos/<org>/<repo>/commits/<sha>/check-suites?per_page=100&page=<p>`
  - `repos/<org>/<repo>/issues/<n>/timeline?per_page=100&page=<p>`
  - `repos/<org>/<repo>/activity?ref=refs/heads/<branch>&direction=desc&per_page=10` (the arrival of an open pull
    request: the newest changes of its head branch) and `...&per_page=100` (a merged pull request's arrival, the
    plain-forward reading's history of the head branch and of the base branch)
  - `repos/<org>/<repo>/git/commits/<sha>`

  An endpoint that is not in the map is a read that fails. The runner raises the reader's own "cannot be read" error for it.
- **`platform.links`** (optional) maps an endpoint of a cursor-paged list to the endpoint of its next page, as GitHub's Link header
  names it (rel="next"). The repository activity pages by cursor: a merged pull request's history is read back through these
  links until the merge is covered. An endpoint without an entry is the last page. Every `direction=desc` activity page lists
  rows newest-first by timestamp; rows from the same second may appear in either order.
- **`platform.diffs`** maps a compare endpoint (`repos/<org>/<repo>/compare/<base>...<sha>`, the diff media type) to its diff
  text. The patch id is computed from it with `git patch-id --stable`.
- **`platform.mergeTrees`** maps two parents, `"<p1> <p2>"`, to the tree of their automatic clean merge (what
  `git merge-tree --write-tree p1 p2` answers), or `"CONFLICT"` when they have none.
- **`expect.exit`** is the verdict:
  - `0`: the approval counts (`verdict: counts`);
  - `1`: a definite refusal (`refused`);
  - `2`: a reading that cannot be read, which is also a refusal (`unreadable`).

  `expect.line` is a part of the line the reader prints. Both readers here print it, so a reader that refuses for another reason
  fails the case.

A reader whose words differ from these readers' words may map `expect.line` to its own words. It must still match `expect.exit`
for every case.

## Notes for a reader in another language

- Review ids are int64. A JSON reader that parses numbers as doubles cannot order ids above 2^53 exactly. Both readers here refuse
  to order the owner's reviews when one of them carries such an id (case `owner-review-id-above-2-53`). Another reviewer's large
  id is valid and passed over (case `another-reviewers-id-near-int64-max`).
- `exactly-1000-reviews-full-last-page` holds ten full pages of 100 reviews and an empty eleventh. A reader that stops at a page
  count, or at a page length that is not short, fails it.

## Adding a case

Write one new file in this format, with a new `case` name and an `origin` that names the fault. Run both runners: every reader
must read its `expect`. The first cases were written by a generator kept in the build record of this change. The files are the
corpus; no generator is needed to add or change a case.
