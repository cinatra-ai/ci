// The merge-time reader is the authority for whether an owner's approval counts at a head. Its vendored conformance corpus runs
// here against this gate's reader. This adapter changes only query spelling and supplies the synthetic git facts already recorded
// by each case; it never changes, suppresses or replaces a case's expected verdict.
//
// REST mapping:
// - the gate asks with a leading slash; corpus keys do not have one;
// - the gate's first timeline page omits `page=1`; the corpus records that explicit page;
// - activity and check-suite keys otherwise match; readPage returns the corpus row plus its optional `links` successor.
// Git mapping:
// - commit parents and trees come from `git/commits/<sha>` answers;
// - base/head ancestry also uses the before/after chain of the recorded branch activity;
// - clean merge trees come from `mergeTrees`; patch ids and content fingerprints come from the recorded compare diffs.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DECIDING_STATES, makeApprovalAt, plainForwardOf, projectReviews, sameLogin,
} from "../truthful-attribution-gate.mjs";

const CORPUS = path.join(import.meta.dirname, "fixtures", "approval-corpus");
const CASES = fs.readdirSync(CORPUS).filter((name) => name.endsWith(".json")).sort().map((name) => [
  name.slice(0, -5), JSON.parse(fs.readFileSync(path.join(CORPUS, name), "utf8")),
]);
const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0".repeat(40);
const clone = (value) => structuredClone(value);
// Only fail-closed differences belong here: the gate may refuse a case the authority counts,
// but it may never count a case the authority refuses. Keep the reason beside every exception.
const UNEXPRESSIBLE = Object.freeze({});

class CorpusReadError extends Error {}

function endpointKey(endpoint) {
  let key = String(endpoint).replace(/^\//, "");
  if (/\/issues\/[1-9][0-9]*\/timeline\?per_page=100$/.test(key)) key += "&page=1";
  return key;
}

function platformReaders({ rest, links = {} }) {
  const answer = (endpoint) => {
    const key = endpointKey(endpoint);
    if (!Object.hasOwn(rest, key)) throw new CorpusReadError(`no answer for ${key}`);
    return { key, body: clone(rest[key]) };
  };
  return {
    read: (endpoint) => answer(endpoint).body,
    readPage: (endpoint) => {
      const { key, body } = answer(endpoint);
      return { body, next: Object.hasOwn(links, key) ? `/${links[key]}` : null };
    },
  };
}

function reviewReading(read, { repository, pull, owner }) {
  const rows = [];
  for (let page = 1; page <= 31; page++) {
    let answer;
    try { answer = read(`/repos/${repository}/pulls/${pull}/reviews?per_page=100&page=${page}`); }
    catch (error) { return { code: 2, line: `the reviews cannot be read (${error.message})` }; }
    if (!Array.isArray(answer)) return { code: 2, line: `reviews page ${page} is not a list` };
    if (page > 30 && answer.length) return { code: 2, line: "the pull request holds more than 3000 reviews" };
    rows.push(...answer);
    if (answer.length < 100) break;
  }
  const projected = projectReviews(rows);
  if (projected.problem) return { code: 2, line: projected.problem };
  const own = projected.rows.filter((row) => row.user !== null && sameLogin(row.user.login, owner) && DECIDING_STATES.includes(row.state));
  if (!own.length) return { code: 1, line: `@${owner} has no approval` };
  if (own.some((row) => !Number.isSafeInteger(row.id))) return { code: 2, line: `the reviews of @${owner} cannot be ordered exactly` };
  return { review: own.reduce((latest, row) => row.id > latest.id ? row : latest) };
}

function corpusGit(platform, ask) {
  const rest = platform.rest;
  const commits = new Map();
  const parents = new Map();
  const known = new Set();
  const remember = (sha) => { if (SHA.test(String(sha))) known.add(sha); };
  const addParent = (child, parent) => {
    if (!SHA.test(String(child)) || !SHA.test(String(parent)) || child === parent || parent === ZERO_SHA) return;
    const list = parents.get(child) || [];
    if (!list.includes(parent)) list.push(parent);
    parents.set(child, list);
    remember(child); remember(parent);
  };
  for (const [key, value] of Object.entries(rest)) {
    if (key.includes("/git/commits/") && value && typeof value === "object") {
      commits.set(value.sha, value);
      remember(value.sha); remember(value.tree?.sha);
      const ps = Array.isArray(value.parents) ? value.parents.map((item) => item?.sha).filter((sha) => SHA.test(String(sha))) : [];
      parents.set(value.sha, ps);
      for (const parent of ps) remember(parent);
    }
    if (key.includes("/activity?") && Array.isArray(value)) {
      for (const row of value) {
        remember(row?.before); remember(row?.after);
        // A force push records ref movement, not commit ancestry. The other head-setting kinds preserve the before/after chain.
        if (["push", "branch_creation", "pr_merge", "merge_queue_merge"].includes(row?.activity_type)) addParent(row?.after, row?.before);
      }
    }
  }
  const pullKey = `repos/${ask.repository}/pulls/${ask.pull}`;
  const baseRef = rest[pullKey]?.base?.ref;
  const baseKey = `repos/${ask.repository}/activity?ref=refs/heads/${baseRef}&direction=desc&per_page=100`;
  const baseRows = Array.isArray(rest[baseKey]) ? rest[baseKey] : [];
  const anchor = baseRows.find((row) => row?.activity_type !== "branch_deletion" && SHA.test(String(row?.after)))?.after || null;

  const reachable = (ancestor, descendant) => {
    if (ancestor === descendant) return true;
    const pending = [descendant], seen = new Set();
    while (pending.length) {
      const sha = pending.pop();
      if (seen.has(sha)) continue;
      seen.add(sha);
      for (const parent of parents.get(sha) || []) {
        if (parent === ancestor) return true;
        pending.push(parent);
      }
    }
    return false;
  };
  const forwardCommits = (approved, head) => {
    const chain = [];
    let current = head;
    for (let count = 0; current !== approved && count < 64; count++) {
      chain.push(current);
      current = (parents.get(current) || [])[0];
      if (!current) return null;
    }
    return current === approved ? chain.reverse() : null;
  };
  const diffOf = (head) => platform.diffs?.[`repos/${ask.repository}/compare/${baseRef}...${head}`];
  const patchId = (_base, head) => {
    const diff = diffOf(head);
    if (typeof diff !== "string") return null;
    const done = spawnSync("git", ["patch-id", "--stable"], { input: diff, encoding: "utf8" });
    if (done.status !== 0) return null;
    const id = String(done.stdout || "").trim().split(/\s+/)[0] || "";
    return id === "" || SHA.test(id) ? id : null;
  };
  const fingerprint = (_base, head) => {
    const diff = diffOf(head);
    return typeof diff === "string" ? crypto.createHash("sha256").update(diff).digest("hex") : null;
  };
  const mergeInfo = (sha) => {
    const commit = commits.get(sha);
    if (!commit || !Array.isArray(commit.parents) || commit.parents.length !== 2) return null;
    const ps = commit.parents.map((item) => item.sha);
    const pair = `${ps[0]} ${ps[1]}`;
    const clean = platform.mergeTrees?.[pair];
    return { parents: ps, tree: commit.tree?.sha || null, cleanTree: clean === "CONFLICT" || clean === undefined ? null : clean };
  };
  return {
    anchor,
    forward: (args) => plainForwardOf({
      ...args,
      isAncestor: (ancestor, descendant) => known.has(ancestor) && known.has(descendant) ? reachable(ancestor, descendant) : undefined,
      forwardCommits,
      mergeInfo,
      hasLocal: (sha) => known.has(sha),
      mergeBase: () => baseRef || null,
      patchId,
      fingerprint,
    }),
  };
}

function runCase(body) {
  const ask = body.ask;
  const { read, readPage } = platformReaders(body.platform);
  const latest = reviewReading(read, ask);
  if (!latest.review) return latest;
  const review = latest.review;
  if (review.state !== "APPROVED") return { code: 1, line: `the owner's latest review is ${review.state}, not an approval` };
  if (review.commit_id === null) return { code: 1, line: "the owner's approval names no commit" };
  if (review.commit_id !== ask.head) return { code: 1, line: `the owner's approval stands at ${review.commit_id.slice(0, 12)}, not at ${ask.head.slice(0, 12)}` };
  const { anchor, forward } = corpusGit(body.platform, ask);
  const result = makeApprovalAt({ read, readPage, slug: ask.repository, pr: ask.pull, anchor, forward })(review, ask.head);
  return { code: result.ok ? 0 : result.unreadable ? 2 : 1, line: result.reason || result.via || "counts" };
}

test("the shared approval corpus is well formed and synthetic", () => {
  assert.ok(CASES.length >= 50, String(CASES.length));
  for (const [stem, body] of CASES) {
    assert.deepEqual(Object.keys(body).sort(), ["about", "ask", "case", "corpus", "expect", "origin", "platform"], stem);
    assert.equal(body.corpus, 1, stem);
    assert.equal(body.case, stem);
    assert.equal(body.ask.reading, "owner-approval", stem);
    assert.equal({ 0: "counts", 1: "refused", 2: "unreadable" }[body.expect.exit], body.expect.verdict, stem);
    assert.ok(body.ask.repository.startsWith("example-"), `${stem}: ${body.ask.repository}`);
    const text = JSON.stringify(body);
    assert.doesNotMatch(text.toLowerCase(), /cinatra|groganz|ghp_|github_pat_|gho_|\/users\/|\/home\//, stem);
    for (const login of text.matchAll(/"login":"([^"]*)"/g)) {
      assert.ok(login[1] === "x" || login[1].toLowerCase().includes("example") || login[1].toLowerCase().startsWith("kelly"), `${stem}: ${login[1]}`);
    }
  }
});

for (const [stem, body] of CASES) {
  test(`shared approval corpus: ${stem}`, () => {
    const result = runCase(body);
    if (Object.hasOwn(UNEXPRESSIBLE, stem)) {
      assert.equal(result.code, UNEXPRESSIBLE[stem].actual, `${result.line}\n${UNEXPRESSIBLE[stem].reason}`);
      assert.notEqual(result.code, body.expect.exit, `${stem} unexpectedly became expressible; remove it from UNEXPRESSIBLE`);
      return;
    }
    assert.equal(result.code, body.expect.exit, `${result.line}\nexpected ${body.expect.verdict}`);
  });
}

test("every corpus mismatch is named with the reason the gate cannot express it", () => {
  assert.deepEqual(Object.keys(UNEXPRESSIBLE).sort(), CASES.filter(([, body]) => runCase(body).code !== body.expect.exit).map(([stem]) => stem).sort());
  for (const [stem, mismatch] of Object.entries(UNEXPRESSIBLE)) {
    assert.ok(mismatch.reason.length > 40, stem);
  }
});
