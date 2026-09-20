import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/verification-boundary.py");
const MODULE = path.join(ROOT, "scripts/boundary_receipts.py");
const HEAD = "a".repeat(40), OTHER = "b".repeat(40), REPO = "cinatra-ai/ci";
const trust = JSON.parse(fs.readFileSync(path.join(ROOT, "config/delegated-merge-authorities.json")));
// Generated once by the actual immutable private producer at 7bc8509. Synthetic
// scope/data; the comment bytes and digest are preserved without a second grammar.
const GOLDEN = '<!-- cinatra-verification-boundary:v1 -->\n```json\n{"checks":["unit"],"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","previous":null,"pullRequest":7,"repository":"cinatra-ai/ci","repositoryId":10,"schema":"cinatra.verification-boundary/v1","state":"candidate"}\n```\nReceipt-SHA256: 7d7caba1f1ff1c0e1b0d35bcfba082a5f7c0e77e73d4958ac3a37b33984952fa\n';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-current-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  const data = { repo: { id: 10, full_name: REPO, owner: { id: trust.bot.organizationId, type: "Organization" } },
    pull: { number: 7, state: "open", head: { sha: HEAD }, base: { repo: { id: 10, full_name: REPO } },
      body: "Verification boundary: candidate at " + HEAD }, comments: [] };
  const row = body => ({ id: 100 + data.comments.length, body,
    user: { id: trust.bot.userId, login: trust.bot.login, type: "Bot" },
    performed_via_github_app: { id: trust.bot.appId },
    issue_url: "https://api.github.com/repos/" + REPO + "/issues/7",
    html_url: "https://github.com/" + REPO + "/pull/7#issuecomment-" + (100 + data.comments.length),
    created_at: "2026-09-20T01:00:00Z", updated_at: "2026-09-20T01:00:00Z" });
  function add(state = "candidate", head = HEAD, checks = ["unit"], receiptChanges = {}) {
    // Invoke the maintained producer itself. This fixture owns only transport,
    // not a copied envelope/parser/verdict implementation.
    const r = spawnSync("python3", ["-c", `import sys,json;sys.path.insert(0,sys.argv[1]);import boundary_receipts as b
v=json.load(sys.stdin); old=v.pop('old'); previous={'commentId':old['id'],'digest':b.digest(b.parse_receipt(old['body']))} if old else None
receipt=dict(schema=b.SCHEMA,repository='cinatra-ai/ci',repositoryId=10,pullRequest=7,previous=previous);receipt.update(v);print(b.comment_body(receipt),end='')`, path.dirname(MODULE)],
    { input: JSON.stringify({ state, headSha: head, checks, old: data.comments.filter(x => x.body.startsWith("<!-- cinatra-verification-boundary:")).at(-1) || null, ...receiptChanges }), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    assert.equal(r.status, 0, r.stderr); const comment = row(r.stdout); data.comments.push(comment); return comment;
  }
  const gh = path.join(bin, "gh"), transport = path.join(dir, "transport.json"), trace = path.join(dir, "trace.jsonl");
  fs.writeFileSync(gh, `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2),e=a.at(-1),f=process.env.BOUNDARY_FIXTURE;
if(JSON.stringify(a.slice(0,-1))!==JSON.stringify(['api','--hostname','github.com','-H','X-GitHub-Api-Version: 2022-11-28','-X','GET']))throw Error('fixed GET/version required');
if(process.env.GH_HOST!=='github.com')throw Error('host not pinned');
const log=f+'.reads',seen=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean):[];
fs.appendFileSync(log,e+'\\n');fs.appendFileSync(process.env.BOUNDARY_TRACE,JSON.stringify(a)+'\\n');
const d=JSON.parse(fs.readFileSync(f)),root='/repos/cinatra-ai/ci';let v;
if(d.movingMetadata && seen.filter(x=>x===root).length+Number(e===root)>=2)for(const row of d.comments)row.reactions={total_count:1};
if(e===root)v=d.repo;
else if(e===root+'/pulls/7')v={...d.pull,comments:d.count??d.comments.length};
else if(e.startsWith(root+'/issues/7/comments?per_page=100&page=')){const page=Number(e.split('=').at(-1));v=d.infinite?Array.from({length:100},(_,i)=>({id:i+1,body:''})):d.comments.slice((page-1)*100,page*100);if(d.truncated)v=[];}
else if(e.startsWith(root+'/issues/comments/')){v=d.comments.find(x=>x.id===Number(e.split('/').at(-1)));if(d.deleted)process.exit(1);if(d.direct)v={...v,...d.direct};}
else throw Error('unexpected endpoint '+e);
if(d.move && e===root+'/pulls/7' && seen.filter(x=>x===e).length===3)v={...v,head:{sha:'b'.repeat(40)}};
if(d.secondList && e===root+'/issues/7/comments?per_page=100&page=1' && seen.includes(e))v=d.secondList;
process.stdout.write(JSON.stringify(v));
`); fs.chmodSync(gh, 0o700);
  function run(args = [], extraEnv = {}) {
    fs.writeFileSync(transport, JSON.stringify(data)); fs.rmSync(transport + ".reads", { force: true }); fs.rmSync(trace, { force: true });
    const r = spawnSync("python3", [SCRIPT, "--repo", REPO, "--pr", "7", "--head", HEAD, ...args], { cwd: dir,
      env: { ...process.env, ...extraEnv, GH_HOST: "hostile.invalid", PATH: bin + path.delimiter + process.env.PATH,
        BOUNDARY_FIXTURE: transport, BOUNDARY_TRACE: trace, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", timeout: 15000 });
    return r;
  }
  return { dir, data, row, add, run, trace };
}
function refused(r, why) { assert.notEqual(r.status, 0, r.stdout); assert.equal(r.stdout, ""); if (why) assert.match(r.stderr, why); }

test("canonical module retains exact merged private producer bytes", () => {
  assert.equal(createHash("sha256").update(fs.readFileSync(MODULE)).digest("hex"), "ef30c4c14b7f4532bb55ae923e77924dc86451d18d08f88a17bfd121f29d66c5");
});
test("real CLI accepts unchanged producer golden with fixed GETs and current-view output", t => {
  const f = fixture(t); assert.equal(f.add().body, GOLDEN);
  const r = f.run(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { schema: "cinatra.verification-boundary-current/v1", repository: REPO, repositoryId: 10,
    pullRequest: 7, headSha: HEAD, state: "candidate", commentId: 100, digest: "7d7caba1f1ff1c0e1b0d35bcfba082a5f7c0e77e73d4958ac3a37b33984952fa" });
  const calls = fs.readFileSync(f.trace, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 10); assert.equal(calls.filter(x => x.at(-1).endsWith("/issues/comments/100")).length, 2);
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ["bin", "trace.jsonl", "transport.json", "transport.json.reads"]);
});
test("candidate cwd/env cannot replace source-owned principal or add mutation commands", t => {
  const f = fixture(t); f.add(); fs.mkdirSync(path.join(f.dir, "config"));
  fs.writeFileSync(path.join(f.dir, "config/delegated-merge-authorities.json"), JSON.stringify({ bot: { userId: 1 } }));
  assert.equal(f.run([], { DEVOPS_OPERATOR_CONFIG: "/missing", BOUNDARY_BOT_ID: "1" }).status, 0);
  for (const args of [["--repo", "foreign/ci"], ["--repo", "cinatra-ai/product.."], ["--head", HEAD.slice(0, 12)], ["--pr", "0"], ["--publish"], ["--trust", "/tmp/policy"]]) {
    refused(f.run(args)); assert.equal(fs.existsSync(f.trace), false);
  }
});
test("editable body and foreign comments cannot supply boundary authority", t => {
  const f = fixture(t); refused(f.run(), /no authenticated/);
  const c = f.add(); c.user = { id: 1, login: "other[bot]", type: "Bot" }; refused(f.run(), /no authenticated/);
});
test("numeric principal, App, type, exact scope and immutable timestamps remain strict", t => {
  const f = fixture(t); const c = f.add(), original = structuredClone(c);
  for (const changes of [{ user: { ...c.user, id: 1 } }, { user: { ...c.user, login: "forged[bot]" } }, { user: { ...c.user, type: "User" } },
    { performed_via_github_app: null }, { performed_via_github_app: { id: 1 } }, { performed_via_github_app: {} },
    { updated_at: "2026-09-20T01:00:01Z" }, { issue_url: "https://api.github.com/repos/foreign/ci/issues/7" },
    { html_url: original.html_url.replace("/pull/7", "/pull/8") }]) {
    f.data.comments[0] = { ...original, ...changes }; refused(f.run());
  }
  f.data.comments[0] = original;
  for (const change of [() => { f.data.repo.owner.id++; }, () => { f.data.repo.owner.type = "User"; },
    () => { f.data.pull.number++; }, () => { f.data.pull.head.sha = OTHER; }, () => { f.data.pull.base.repo.id++; }]) {
    const saved = structuredClone(f.data); change(); refused(f.run()); Object.assign(f.data, saved);
  }
});
test("exact canonical envelope and digest refuse forgery, extra keys and prefix heads", t => {
  const f = fixture(t), c = f.add();
  for (const body of [GOLDEN.replace('"state":"candidate"', '"state":"candidate","state":"candidate"'), GOLDEN.replace('"repositoryId":10', '"repositoryId":11'),
    GOLDEN.replace('"checks":', '"extra":true,"checks":'), GOLDEN.replace(HEAD, HEAD.slice(0, 12)), GOLDEN + "extra\n", GOLDEN.replace('```json\n{', '```json\n{ ')]) {
    c.body = body; refused(f.run());
  }
});
test("latest authenticated all-head outcome prevents stale candidate selection", t => {
  for (const state of ["candidate-pending-ci", "candidate-pending-proof", "proof-failed", "preserved-failing", "not-a-lane"]) {
    const f = fixture(t); f.add(); f.add(state); refused(f.run(), /latest boundary|not queue eligible/);
  }
  const f = fixture(t); f.add(); f.add("candidate", OTHER); refused(f.run(), /another head/);
  f.data.comments.at(-1).body = "<!-- cinatra-verification-boundary:v1 --> malformed"; refused(f.run(), /malformed/);
});
test("promotion requires immediate same-head pending receipt and complete exact check names", t => {
  const f = fixture(t); const checks = ['A; B', 'quote " and backslash \\'];
  f.add("candidate-pending-ci", HEAD, checks); f.add("promoted", HEAD, checks);
  let r = f.run(); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).state, "promoted");
  for (const middle of ["proof-failed", "candidate"]) {
    f.data.comments = []; f.add("candidate-pending-ci", HEAD, checks); f.add(middle); f.add("promoted", HEAD, checks); refused(f.run(), /immediate/);
  }
  f.data.comments = []; f.add("candidate-pending-ci", OTHER, checks); f.add("promoted", HEAD, checks); refused(f.run(), /immediate/);
  f.data.comments = []; f.add("candidate-pending-ci", HEAD, checks); f.add("promoted", HEAD, checks.slice(0, 1)); refused(f.run(), /immediate/);
});
test("deleted/interior records, duplicate and truncated inventory refuse", t => {
  const f = fixture(t); f.add(); f.add(); f.add();
  const saved = structuredClone(f.data.comments); f.data.comments.splice(1, 1); refused(f.run(), /chain incomplete/);
  f.data.comments = saved; f.data.deleted = true; refused(f.run(), /GET failed/); delete f.data.deleted;
  f.data.comments.push(structuredClone(saved.at(-1))); refused(f.run(), /duplicate/); f.data.comments = saved.slice(0, 3);
  f.data.truncated = true; refused(f.run(), /truncated/);
});
test("complete terminal pagination is mandatory and capped", t => {
  const f = fixture(t); for (let i = 0; i < 100; i++) f.data.comments.push(f.row("ordinary comment")); f.add();
  const r = f.run(); assert.equal(r.status, 0, r.stderr); assert.match(fs.readFileSync(f.trace, "utf8"), /page=2/);
  f.data.infinite = true; refused(f.run(), /pagination incomplete/);
});
test("direct/list security parity and repeated-read movement refuse", t => {
  const f = fixture(t); f.add(); f.data.direct = { body: GOLDEN + "changed" }; refused(f.run(), /direct\/list/);
  delete f.data.direct; f.data.move = true; refused(f.run(), /identity\/head changed/);
  delete f.data.move; f.data.secondList = []; refused(f.run(), /truncated/);
  f.data.secondList = [{ ...f.data.comments[0], body: GOLDEN + "changed" }]; refused(f.run(), /direct\/list/);
});

test("canonical producer receipts still require exact live repository/PR/schema scope", t => {
  for (const changes of [{ repository: "cinatra-ai/other" }, { repositoryId: 11 }, { pullRequest: 8 }, { schema: "other/v1" }]) {
    const f = fixture(t); f.add("candidate", HEAD, ["unit"], changes); refused(f.run());
  }
});
test("two internally consistent snapshots that changed still fail stable-read equality", t => {
  const f = fixture(t); f.add(); f.data.movingMetadata = true; refused(f.run(), /boundary reads moved/);
});
