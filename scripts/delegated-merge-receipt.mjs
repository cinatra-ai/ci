import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

export const MARKER = "<!-- cinatra-delegated-merge:v1 -->";
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const URL_PATTERN = "https://github\\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)#issuecomment-([1-9][0-9]*)";
export const AUTHORIZATION_RE = new RegExp("^Merge-authorization: delegated-v1 (" + URL_PATTERN + ") sha256:([0-9a-f]{64})$");
const POINTER_RE = new RegExp("^Merge authorization: (" + URL_PATTERN + ") SHA256:([0-9a-f]{64})$");
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys, label) => requireThat(plain(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"), label + " fields differ");
export function canonical(value) {
  if (typeof value === "string") requireThat(value.isWellFormed(), "unpaired Unicode surrogate");
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (plain(value)) return "{" + Object.keys(value).sort().map(key => canonical(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
export const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
function time(value) {
  requireThat(typeof value === "string" && DATE.test(value), "timestamp is not canonical UTC");
  const ms = Date.parse(value);
  requireThat(Number.isFinite(ms) && new Date(ms).toISOString().replace(".000Z", "Z") === value, "timestamp invalid");
  return ms;
}
function branch(value) {
  requireThat(typeof value === "string" && value.isWellFormed() && value.length > 0 && value.length <= 255 && value !== "@"
    && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) && !value.includes("..") && !value.includes("@{")
    && !value.startsWith("-") && !value.endsWith(".")
    && value.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".lock")), "branch malformed");
}
function reference(match) {
  if (!match) return null;
  if (!positive(Number(match[3])) || !positive(Number(match[4]))) return null;
  return { url: match[1], repository: match[2], pullRequest: Number(match[3]), commentId: Number(match[4]), digest: match[5] };
}
export function parseAuthorization(line) { return reference(String(line).match(AUTHORIZATION_RE)); }
export function pointer(body) {
  requireThat(typeof body === "string", "PR body unavailable");
  const lines = body.split("\n").filter(line => /^Merge authorization:/i.test(line));
  if (!lines.length) return null;
  requireThat(lines.length === 1, "duplicate merge authorization pointer");
  const value = reference(lines[0].match(POINTER_RE));
  requireThat(value, "merge authorization pointer malformed");
  return value;
}
export function normalizeFiles(rows) {
  requireThat(Array.isArray(rows) && rows.length > 0 && rows.length < 3000, "file inventory unavailable or at truncation limit");
  const seen = new Set();
  const path = value => typeof value === "string" && value.isWellFormed() && value.length > 0 && !/[\\\x00-\x1f\x7f]/.test(value)
    && !value.startsWith("/") && value.split("/").every(part => part !== "." && part !== ".." && part !== "");
  return rows.map(row => {
    requireThat(plain(row) && path(row.filename) && !seen.has(row.filename), "duplicate or malformed file path");
    seen.add(row.filename);
    const previous = row.previous_filename ?? null;
    requireThat((previous === null || path(previous)) && SHA.test(row.sha)
      && ["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"].includes(row.status)
      && (row.status !== "renamed" || previous !== null)
      && [row.additions, row.deletions, row.changes].every(n => Number.isSafeInteger(n) && n >= 0), "file metadata malformed");
    return { filename: row.filename, previous_filename: previous, status: row.status, sha: row.sha,
      additions: row.additions, deletions: row.deletions, changes: row.changes };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.filename), Buffer.from(b.filename)));
}
function authorityPolicy() {
  // Resolve from this immutable engine checkout. No candidate path or env override.
  return JSON.parse(fs.readFileSync(new URL("../config/delegated-merge-authorities.json", import.meta.url), "utf8"));
}
function validatePolicy(policy) {
  exact(policy, ["schema", "authority", "ownerUserId", "bot", "organization", "maximumReceiptSeconds"], "trusted policy");
  requireThat(policy.schema === "cinatra.delegated-merge-trust/v1" && policy.maximumReceiptSeconds === 86400
    && positive(policy.ownerUserId) && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(policy.organization), "unsupported authority policy");
  const a = policy.authority;
  exact(a, ["id", "revision", "digest"], "trusted authority");
  requireThat(/^grant-[0-9a-f]{64}$/.test(a.id) && positive(a.revision) && DIGEST.test(a.digest), "trusted authority malformed");
  exact(policy.bot, ["login", "userId", "appId", "organizationId"], "trusted publisher");
  requireThat(typeof policy.bot.login === "string" && /^[A-Za-z0-9-]+\[bot\]$/.test(policy.bot.login)
    && positive(policy.bot.userId) && positive(policy.bot.appId) && positive(policy.bot.organizationId), "trusted publisher malformed");
  return { ...a, organization: policy.organization, publisher: policy.bot };
}
function publisher(comment, authority) {
  const p = authority.publisher;
  return comment?.user?.id === p.userId && comment.user.login === p.login && comment.user.type === "Bot";
}
function commentBinding(comment, authority) {
  return { id: comment.id, url: comment.html_url, issue: comment.issue_url, body: comment.body,
    user: { id: comment.user?.id, login: comment.user?.login, type: comment.user?.type },
    app: comment.performed_via_github_app?.id ?? authority.publisher.appId, created: comment.created_at, updated: comment.updated_at };
}
export function frame(receipt) {
  return MARKER + "\n```json\n" + canonical(receipt) + "\n```\nReceipt-SHA256: " + digest(receipt);
}
function decode(comment, ref, authenticate) {
  requireThat(comment.id === ref.commentId && comment.html_url === ref.url
    && comment.issue_url === "https://api.github.com/repos/" + ref.repository + "/issues/" + ref.pullRequest
    && authenticate(comment), "receipt publisher or identity is untrusted");
  requireThat(comment.created_at === comment.updated_at, "receipt comment was edited");
  time(comment.created_at);
  requireThat(typeof comment.body === "string" && comment.body.length <= 32768, "receipt content unavailable or too large");
  const lines = comment.body.split("\n");
  requireThat(lines.length === 5 && lines[0] === MARKER && lines[1] === "```json" && lines[3] === "```"
    && lines[4] === "Receipt-SHA256: " + ref.digest, "receipt framing differs");
  const receipt = JSON.parse(lines[2]);
  requireThat(canonical(receipt) === lines[2] && digest(receipt) === ref.digest, "receipt digest differs");
  return receipt;
}
function payload(receipt, authority) {
  exact(receipt, ["schema", "authority", "operation", "verdict", "target", "scope", "issuedAt", "validUntil"], "receipt");
  requireThat(receipt.schema === "cinatra.delegated-merge/v1" && receipt.operation === "squash-merge", "unsupported authorization protocol or operation");
  exact(receipt.authority, ["id", "revision", "digest"], "receipt authority");
  requireThat(receipt.authority.id === authority.id && receipt.authority.revision === authority.revision
    && receipt.authority.digest === authority.digest, "authority revision is unsupported or revoked");
  requireThat(receipt.verdict === "authorized", "receipt does not authorize this operation");
  const t = receipt.target;
  exact(t, ["repository", "repositoryId", "pullRequest", "headSha", "headRef", "headTree", "base", "policy", "mergeTree"], "receipt target");
  requireThat(NAME.test(t.repository) && t.repository.split("/")[0] === authority.organization
    && positive(t.repositoryId) && positive(t.pullRequest) && [t.headSha, t.headTree, t.mergeTree].every(s => typeof s === "string" && SHA.test(s)), "target identity malformed");
  branch(t.headRef);
  for (const key of ["base", "policy"]) {
    exact(t[key], ["ref", "sha"], key); branch(t[key].ref);
    requireThat(typeof t[key].sha === "string" && SHA.test(t[key].sha), key + " SHA malformed");
  }
  exact(receipt.scope, ["registrationDigest", "membershipDigest", "fileInventoryDigest"], "receipt scope");
  requireThat(Object.values(receipt.scope).every(s => typeof s === "string" && DIGEST.test(s)), "scope digest malformed");
  const issued = time(receipt.issuedAt), until = time(receipt.validUntil);
  requireThat(until > issued && until - issued <= 86400000, "receipt validity exceeds 24 hours");
  return t;
}
export function readGithub(endpoint) {
  requireThat(typeof endpoint === "string" && (endpoint.startsWith("/repos/") || /^\/users\/[A-Za-z0-9-]+%5Bbot%5D$/.test(endpoint)) && !/[\x00-\x20\x7f]/.test(endpoint), "invalid receipt API endpoint");
  return JSON.parse(execFileSync("gh", ["api", "--hostname", "github.com", "--method", "GET", "-H", "Accept: application/vnd.github+json",
    "-H", "X-GitHub-Api-Version: 2022-11-28", endpoint],
    { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024 }));
}

/** Pure authority evaluation with injectable read/Git transports; CLI has no bypass. */
export function verifyDelegatedReceipt({ repository, pullRequest, expectedHead, arm, record = null, mergedSha = null,
  get = readGithub, mergeTree, now = Date.now(), policy }) {
  try {
    const authority = validatePolicy(policy ?? authorityPolicy());
    requireThat(NAME.test(repository) && positive(Number(pullRequest)) && SHA.test(expectedHead)
      && ["pre-merge", "post-merge"].includes(arm), "delegation request identity malformed or unsupported");
    const root = "/repos/" + repository, number = Number(pullRequest), deadline = Date.now() + 90000;
    const read = endpoint => { requireThat(Date.now() < deadline, "receipt read deadline exceeded"); return get(endpoint); };
    // GitHub may redact a private App object while preserving its immutable Bot author.
    // The trusted engine policy owns the numeric Bot/App association. A redacted object
    // additionally requires GitHub's live Bot profile to link that same author to the App.
    const profileEndpoint = "/users/" + encodeURIComponent(authority.publisher.login);
    let profileBefore = null;
    const publisherProfile = () => {
      const profile = read(profileEndpoint), p = authority.publisher;
      requireThat(profile?.id === p.userId && profile.login === p.login && profile.type === "Bot"
        && profile.html_url === "https://github.com/apps/" + p.login.slice(0, -5), "publisher App profile linkage unavailable or untrusted");
      return { id: profile.id, login: profile.login, type: profile.type, url: profile.html_url };
    };
    const authenticate = comment => {
      if (!publisher(comment, authority)) return false;
      const app = comment.performed_via_github_app;
      if (app !== null && app !== undefined) return plain(app) && app.id === authority.publisher.appId;
      profileBefore ??= publisherProfile();
      return true;
    };
    const list = endpoint => {
      const rows = [];
      for (let page = 1; page <= 31; page++) {
        const batch = read(endpoint + "?per_page=100&page=" + page);
        requireThat(Array.isArray(batch) && batch.length <= 100, "receipt inventory page malformed");
        rows.push(...batch);
        requireThat(rows.length <= 3000, "receipt inventory exceeds bound");
        if (batch.length < 100) return rows;
      }
      throw new Error("receipt inventory incomplete");
    };
    const snapshot = pr => {
      requireThat(pr?.number === number && positive(pr.base?.repo?.id) && pr.base.repo.full_name === repository
        && pr.head?.repo?.id === pr.base.repo.id && pr.head.repo.full_name === repository
        && typeof pr.body === "string" && positive(pr.changed_files) && pr.changed_files < 3000
        && Number.isSafeInteger(pr.comments) && pr.comments >= 0, "PR identity or inventory metadata unavailable");
      return { number: pr.number, headSha: pr.head.sha, headRef: pr.head.ref, headRepositoryId: pr.head.repo.id,
        headRepository: pr.head.repo.full_name, baseRepositoryId: pr.base.repo.id,
        baseRepository: pr.base.repo.full_name, baseRef: pr.base.ref, state: pr.state, merged: pr.merged,
        mergeCommit: pr.merge_commit_sha ?? null, mergedAt: pr.merged_at ?? null,
        changedFiles: pr.changed_files, comments: pr.comments, body: pr.body };
    };
    const pr = read(root + "/pulls/" + number), before = snapshot(pr), ref = pointer(pr.body);
    requireThat(ref && ref.repository === repository && ref.pullRequest === number, "receipt pointer missing or bound to another PR");
    if (record !== null) requireThat(canonical(record) === canonical(ref), "record does not match the exact receipt pointer");
    const comment = read(root + "/issues/comments/" + ref.commentId);
    const receipt = decode(comment, ref, authenticate), target = payload(receipt, authority);
    requireThat(target.repository === repository && target.pullRequest === number && target.headSha === expectedHead
      && before.headSha === expectedHead && before.headRef === target.headRef && before.baseRef === target.base.ref
      && before.baseRepositoryId === target.repositoryId, "receipt does not match the candidate head/base/repository");
    const meta = read(root);
    requireThat(meta?.id === target.repositoryId && meta.full_name === repository && meta.default_branch === target.policy.ref
      && meta.owner?.id === authority.publisher.organizationId && meta.owner.type === "Organization"
      && meta.archived === false && meta.disabled === false, "repository governance identity differs");
    const liveRef = refName => {
      const data = read(root + "/git/ref/heads/" + encodeURIComponent(refName));
      requireThat(data?.ref === "refs/heads/" + refName && data.object?.type === "commit" && SHA.test(data.object.sha), "live ref unavailable");
      return data.object.sha;
    };
    const files = normalizeFiles(list(root + "/pulls/" + number + "/files"));
    requireThat(files.length === before.changedFiles && digest(files) === receipt.scope.fileInventoryDigest, "complete file inventory differs");
    const verifyComments = () => {
      const comments = list(root + "/issues/" + number + "/comments");
      requireThat(comments.length === before.comments && comments.every(row => positive(row.id))
        && new Set(comments.map(row => row.id)).size === comments.length, "comment inventory incomplete or duplicated");
      const candidates = comments.filter(row => publisher(row, authority) && typeof row.body === "string" && row.body.includes(MARKER))
        .sort((a, b) => b.id - a.id);
      requireThat(candidates[0]?.id === ref.commentId && authenticate(candidates[0])
        && canonical(commentBinding(candidates[0], authority)) === canonical(commentBinding(comment, authority)),
        "receipt superseded or comment inventory changed");
    };
    verifyComments();
    const created = time(comment.created_at), issued = time(receipt.issuedAt), until = time(receipt.validUntil);
    requireThat(created >= issued && created <= until, "receipt publication is outside authorization window");
    const head = read(root + "/git/commits/" + target.headSha);
    requireThat(head?.sha === target.headSha && head.tree?.sha === target.headTree, "head tree differs");
    requireThat(typeof mergeTree === "function" && mergeTree(target.base.sha, target.headSha) === target.mergeTree, "mechanical merge tree differs or is unavailable");
    if (arm === "pre-merge") {
      requireThat(before.state === "open" && before.merged === false && now >= issued && now <= until, "authorization expired or candidate is not open");
      requireThat(liveRef(target.base.ref) === target.base.sha && liveRef(target.policy.ref) === target.policy.sha, "actual target or governance ref moved");
    } else {
      requireThat(SHA.test(mergedSha) && before.state === "closed" && before.merged === true && before.mergeCommit === mergedSha,
        "postmerge PR does not bind the landed commit");
      const at = time(before.mergedAt);
      requireThat(at >= created && at >= issued && at <= until, "merge occurred outside the authorization window");
      const landed = read(root + "/git/commits/" + mergedSha);
      requireThat(landed?.sha === mergedSha && landed.tree?.sha === target.mergeTree && Array.isArray(landed.parents)
        && landed.parents.length === 1 && landed.parents[0].sha === target.base.sha, "landed squash parent/tree differs");
      const governance = read(root + "/git/commits/" + target.policy.sha);
      requireThat(governance?.sha === target.policy.sha && (target.policy.ref !== target.base.ref || target.policy.sha === target.base.sha), "historical governance binding differs");
    }
    requireThat(digest(normalizeFiles(list(root + "/pulls/" + number + "/files"))) === receipt.scope.fileInventoryDigest, "file inventory changed during verification");
    const finalComment = read(root + "/issues/comments/" + ref.commentId);
    requireThat(authenticate(finalComment) && canonical(commentBinding(finalComment, authority)) === canonical(commentBinding(comment, authority)), "receipt changed during verification");
    verifyComments();
    const finalMeta = read(root);
    requireThat(finalMeta?.id === meta.id && finalMeta.full_name === meta.full_name && finalMeta.default_branch === meta.default_branch
      && finalMeta.owner?.id === authority.publisher.organizationId && finalMeta.owner.type === "Organization"
      && finalMeta.archived === false && finalMeta.disabled === false, "repository governance changed during verification");
    if (arm === "pre-merge") requireThat(liveRef(target.base.ref) === target.base.sha && liveRef(target.policy.ref) === target.policy.sha,
      "actual target or governance ref changed during verification");
    requireThat(canonical(snapshot(read(root + "/pulls/" + number))) === canonical(before), "PR changed during receipt verification");
    if (profileBefore !== null) requireThat(canonical(publisherProfile()) === canonical(profileBefore), "publisher App profile changed during verification");
    return { ok: true, reference: ref, receipt, reasons: [] };
  } catch (error) { return { ok: false, reasons: [error.message] }; }
}
