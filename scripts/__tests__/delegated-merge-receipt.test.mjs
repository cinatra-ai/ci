import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonical, digest, frame, normalizeFiles, parseAuthorization, pointer, verifyDelegatedReceipt } from "../delegated-merge-receipt.mjs";

const HEAD = "a".repeat(40), BASE = "b".repeat(40), TREE = "c".repeat(40), MERGE = "d".repeat(40), LANDED = "e".repeat(40);
export function fixture({ trustedPolicy = false } = {}) {
  const policy = JSON.parse(fs.readFileSync(new URL("../../config/delegated-merge-authorities.json", import.meta.url)));
  if (!trustedPolicy) { policy.organization = "fixture-org"; policy.bot.login = "fixture-bot[bot]"; }
  const repo = policy.organization + (trustedPolicy ? "/ci" : "/project"), root = "/repos/" + repo;
  const files = [{ filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", sha: "f".repeat(40), additions: 2, deletions: 1, changes: 3 }];
  const receipt = { schema: "cinatra.delegated-merge/v1", authority: { ...policy.authority }, operation: "squash-merge", verdict: "authorized",
    target: { repository: repo, repositoryId: 123, pullRequest: 7, headSha: HEAD, headRef: "feature/work", headTree: TREE,
      base: { ref: "main", sha: BASE }, policy: { ref: "main", sha: BASE }, mergeTree: MERGE },
    scope: { registrationDigest: "1".repeat(64), membershipDigest: "2".repeat(64), fileInventoryDigest: digest(normalizeFiles(files)) },
    issuedAt: "2026-09-19T10:00:00Z", validUntil: "2026-09-20T10:00:00Z" };
  const url = "https://github.com/" + repo + "/pull/7#issuecomment-99";
  const comment = { id: 99, html_url: url, issue_url: "https://api.github.com/repos/" + repo + "/issues/7",
    user: { id: policy.bot.userId, login: policy.bot.login, type: "Bot" }, performed_via_github_app: { id: policy.bot.appId },
    created_at: "2026-09-19T10:00:01Z", updated_at: "2026-09-19T10:00:01Z" };
  const pr = { number: 7, state: "open", merged: false, draft: false, comments: 1, changed_files: 1,
    head: { sha: HEAD, ref: "feature/work", repo: { id: 123, full_name: repo } },
    base: { sha: "0".repeat(40), ref: "main", repo: { id: 123, full_name: repo } } };
  const api = { [root]: { id: 123, full_name: repo, default_branch: "main", archived: false, disabled: false,
    owner: { id: policy.bot.organizationId, type: "Organization" } },
    [root + "/pulls/7"]: pr, [root + "/issues/comments/99"]: comment,
    [root + "/pulls/7/files?per_page=100&page=1"]: files,
    [root + "/issues/7/comments?per_page=100&page=1"]: [comment],
    [root + "/git/ref/heads/main"]: { ref: "refs/heads/main", object: { type: "commit", sha: BASE } },
    [root + "/git/commits/" + HEAD]: { sha: HEAD, tree: { sha: TREE } },
    [root + "/git/commits/" + BASE]: { sha: BASE, tree: { sha: "9".repeat(40) } },
    [root + "/git/commits/" + LANDED]: { sha: LANDED, tree: { sha: MERGE }, parents: [{ sha: BASE }] } };
  const calls = [];
  const f = { policy, receipt, api, root, pr, comment, files, calls,
    get(endpoint) { calls.push(endpoint); assert.ok(endpoint in api, "unexpected API " + endpoint); return structuredClone(api[endpoint]); },
    seal() { comment.body = frame(receipt); pr.body = "Merge authorization: " + url + " SHA256:" + digest(receipt); },
    check(options = {}) { return verifyDelegatedReceipt({ repository: repo, pullRequest: 7, expectedHead: HEAD, arm: "pre-merge",
      get: f.get, mergeTree: (base, head) => base === BASE && head === HEAD ? MERGE : null,
      now: Date.parse("2026-09-19T11:00:00Z"), policy, ...options }); },
    post() { pr.state = "closed"; pr.merged = true; pr.merge_commit_sha = LANDED; pr.merged_at = "2026-09-19T12:00:00Z"; } };
  f.seal(); return f;
}
const refuses = (f, regex, options) => { const result = f.check(options); assert.equal(result.ok, false); if (regex) assert.match(result.reasons.join(";"), regex); };

test("valid scoped receipt binds live base despite lagging PR base payload", () => {
  const f = fixture(); assert.equal(f.check().ok, true);
  assert.equal(f.calls.filter(p => p.endsWith("/files?per_page=100&page=1")).length, 2);
  assert.equal(f.calls.filter(p => p.endsWith("/comments?per_page=100&page=1")).length, 2);
});
test("receipt and trailer framing are exact and duplicate pointers refuse", () => {
  const f = fixture(), ref = pointer(f.pr.body);
  assert.deepEqual(parseAuthorization("Merge-authorization: delegated-v1 " + ref.url + " sha256:" + ref.digest), ref);
  for (const line of [" " + f.pr.body, f.pr.body + " ", f.pr.body.replace("SHA256", "sha256")]) {
    if (line.startsWith("Merge authorization:")) assert.throws(() => pointer(line));
  }
  assert.throws(() => pointer(f.pr.body + "\n" + f.pr.body));
  assert.equal(parseAuthorization("Merge-authorization: delegated-v2 " + ref.url + " sha256:" + ref.digest), null);
});
test("forged bot, App, issue URL and edited/deleted comments refuse", () => {
  for (const change of [f => f.comment.user.id++, f => f.comment.user.type = "User", f => f.comment.user.login = "other[bot]",
    f => f.comment.performed_via_github_app.id++, f => f.comment.issue_url += "0", f => f.comment.updated_at = "2026-09-19T10:00:02Z",
    f => delete f.api[f.root + "/issues/comments/99"]]) {
    const f = fixture(); change(f); refuses(f);
  }
});
test("unknown fields, authority revisions, nonpass verdicts and canonical digest changes refuse", () => {
  for (const change of [f => f.receipt.extra = true, f => f.receipt.authority.revision++, f => f.receipt.authority.digest = "0".repeat(64),
    f => f.receipt.verdict = "refused", f => f.receipt.verdict = "revoked", f => f.receipt.operation = "merge",
    f => f.receipt.target.base.extra = true, f => f.receipt.issuedAt = "2026-02-30T10:00:00Z"] ) {
    const f = fixture(); change(f); f.seal(); refuses(f);
  }
  const f = fixture(); f.comment.body = f.comment.body.replace('"operation":', '"operation":"squash-merge","operation":'); refuses(f, /digest/);
});
test("expired, not-yet-issued and overlong authorization windows refuse", () => {
  const f = fixture(); refuses(f, /expired/, { now: Date.parse("2026-09-20T10:00:01Z") });
  refuses(f, /expired/, { now: Date.parse("2026-09-19T09:59:59Z") });
  f.receipt.validUntil = "2026-09-20T10:00:01Z"; f.seal(); refuses(f, /24 hours/);
});
test("newest authenticated refused receipt prevents restoring an older pointer", () => {
  const f = fixture(); f.api[f.root + "/issues/7/comments?per_page=100&page=1"].push({ ...f.comment, id: 100, body: frame({ ...f.receipt, verdict: "refused" }) });
  f.pr.comments++; refuses(f, /superseded/);
  // Ordinary comments are not an authorization outcome.
  f.api[f.root + "/issues/7/comments?per_page=100&page=1"][1].body = "ordinary discussion";
  assert.equal(f.check().ok, true);
});
test("head, repository, target, governance and mechanically computed trees must match", () => {
  for (const change of [f => f.pr.head.sha = BASE, f => f.pr.head.ref = "other", f => f.pr.base.repo.id++,
    f => f.pr.base.ref = "release/next", f => f.api[f.root + "/git/ref/heads/main"].object.sha = HEAD,
    f => f.api[f.root].default_branch = "other", f => f.api[f.root].owner.id++,
    f => f.api[f.root + "/git/commits/" + HEAD].tree.sha = BASE]) { const f = fixture(); change(f); refuses(f); }
  refuses(fixture(), /merge tree/, { mergeTree: () => HEAD });
});
test("same-count rename/status and second-read mutations cannot reuse scope", () => {
  for (const field of ["previous_filename", "status", "filename", "sha", "changes"]) {
    const f = fixture(); f.files[0][field] = field === "changes" ? 4 : field === "sha" ? BASE : field === "status" ? "modified" : "different";
    refuses(f);
  }
  const f = fixture(); let pages = 0; const original = f.get;
  f.get = p => { const row = original(p); if (p.includes("/files?") && ++pages === 2) row[0].previous_filename = "other.ts"; return row; };
  refuses(f, /inventory changed/);
});
test("full inventories refuse missing, duplicate and truncated pages", () => {
  for (const change of [f => f.pr.changed_files++, f => f.pr.comments++, f => f.api[f.root + "/pulls/7/files?per_page=100&page=1"] = [],
    f => { f.files.push({ ...f.files[0] }); f.pr.changed_files++; }, f => f.pr.changed_files = 3000]) { const f = fixture(); change(f); refuses(f); }
});
test("postmerge binds historical expiry, sole base parent and actual landed tree", () => {
  const f = fixture(); f.post(); f.api[f.root + "/git/ref/heads/main"].object.sha = HEAD;
  const options = { arm: "post-merge", mergedSha: LANDED, now: Date.parse("2027-01-01T00:00:00Z") };
  assert.equal(f.check(options).ok, true);
  assert.equal(f.calls.some(p => p.includes("/git/ref/")), false);
  for (const change of [g => g.pr.merged_at = "2026-09-20T10:00:01Z", g => g.pr.merge_commit_sha = HEAD,
    g => g.api[g.root + "/git/commits/" + LANDED].parents.push({ sha: HEAD }),
    g => g.api[g.root + "/git/commits/" + LANDED].parents[0].sha = HEAD,
    g => g.api[g.root + "/git/commits/" + LANDED].tree.sha = TREE]) { const g = fixture(); g.post(); change(g); refuses(g, undefined, options); }
});
test("final PR, comment and governance readbacks refuse drift", () => {
  for (const kind of ["pr", "comment", "governance", "comments"]) {
    const f = fixture(), original = f.get; let reads = 0;
    const match = kind === "pr" ? f.root + "/pulls/7" : kind === "comment" ? f.root + "/issues/comments/99"
      : kind === "governance" ? f.root : f.root + "/issues/7/comments?per_page=100&page=1";
    f.get = p => { const data = original(p); if (p === match && ++reads === 2) {
      if (kind === "pr") data.body += " changed";
      else if (kind === "comment") data.updated_at = "2026-09-19T11:01:00Z";
      else if (kind === "governance") data.default_branch = "other";
      else data[0].body += " changed";
    } return data; };
    refuses(f);
  }
});
test("UTF-8 path ordering is canonical and unpaired surrogates refuse", () => {
  assert.throws(() => canonical("\ud800"), /surrogate/);
  const f = fixture(); assert.throws(() => normalizeFiles([{ ...f.files[0], filename: "\ud800" }]));
  const rows = ["\u{10000}.ts", "\ue000.ts"].map(filename => ({ ...f.files[0], filename }));
  assert.deepEqual(normalizeFiles(rows).map(row => row.filename), ["\ue000.ts", "\u{10000}.ts"]);
});
test("record pointer mismatch and unsupported queue arm cannot authorize", () => {
  const f = fixture(); refuses(f, /exact receipt/, { record: { ...pointer(f.pr.body), digest: "0".repeat(64) } });
  refuses(f, /unsupported/, { arm: "merge-group" });
});
test("producer parity refuses malformed owned pointers, newer marker text, backslashes and foreign heads", () => {
  for (const change of [f => f.pr.body = f.pr.body.toLowerCase(),
    f => f.pr.body += "\n" + f.pr.body.replace("Merge authorization:", "MERGE AUTHORIZATION:"),
    f => { f.api[f.root + "/issues/7/comments?per_page=100&page=1"].push({ ...f.comment, id: 100, body: "malformed prelude\n" + f.comment.body }); f.pr.comments++; },
    f => f.files[0].filename = "src\\other.ts", f => f.files[0].previous_filename = "src\\old.ts",
    f => f.pr.head.repo.id++, f => f.pr.head.repo.full_name = "outside/project", f => delete f.pr.head.repo]) {
    const f = fixture(); change(f); refuses(f);
  }
});
