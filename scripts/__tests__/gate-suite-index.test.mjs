import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, serialize, INDEX_SCHEMA_VERSION } from "../gate-suite-index.mjs";

const NOW = "2026-06-12T00:00:00.000Z";

// A reader stub: maps "repo@ref" -> result, so buildIndex is fully offline.
function stubReader(map) {
  return (repo, ref) => map[`${repo}@${ref}`] || { ok: false, reason: "not-found" };
}

test("buildIndex: an inventoried repo with NO committed suite is `no-suite`, never omitted", () => {
  const inv = { repos: [{ repo: "cinatra-ai/cinatra", defaultBranch: "main" }] };
  const idx = buildIndex(inv, stubReader({}), NOW);
  assert.equal(idx.schemaVersion, INDEX_SCHEMA_VERSION);
  assert.equal(idx.generatedAt, NOW);
  assert.equal(idx.inventory, "config/gate-suite-inventory.json");
  assert.equal(idx.repos.length, 1);
  assert.equal(idx.repos[0].repo, "cinatra-ai/cinatra");
  assert.equal(idx.repos[0].status, "no-suite");
  assert.equal(idx.repos[0].suite, null);
});

test("buildIndex: `repos: []` only when the inventory itself is empty (honest emptiness)", () => {
  const idx = buildIndex({ repos: [] }, stubReader({}), NOW);
  assert.deepEqual(idx.repos, []);
  // the inventory it scanned is always named, so [] is never ambiguous.
  assert.equal(idx.inventory, "config/gate-suite-inventory.json");
});

test("buildIndex: a present suite is summarized (id@version + accountable + audit fields), not copied wholesale", () => {
  const suite = {
    suiteId: "cinatra-core",
    version: "2026.06",
    accountable: { github: "groganz", name: "Sandro Groganz", email: "sandro@cinatra.ai" },
    requiredContexts: [{ context: "a" }, { context: "b" }],
    highRiskPaths: ["**/x/**"],
    lastAuditedAt: "2026-06-01",
    auditEvidence: "https://example/issue#c1",
    secretField: "should-not-appear",
  };
  const inv = { repos: [{ repo: "cinatra-ai/cinatra", defaultBranch: "main" }] };
  const idx = buildIndex(inv, stubReader({ "cinatra-ai/cinatra@main": { ok: true, value: suite } }), NOW);
  const r = idx.repos[0];
  assert.equal(r.status, "present");
  assert.equal(r.suite.suiteId, "cinatra-core");
  assert.equal(r.suite.version, "2026.06");
  assert.equal(r.suite.accountable.github, "groganz");
  assert.equal(r.suite.requiredContextCount, 2);
  assert.equal(r.suite.highRiskPathCount, 1);
  assert.equal(r.suite.lastAuditedAt, "2026-06-01");
  assert.equal(r.suite.auditEvidence, "https://example/issue#c1");
  // wholesale fields are NOT carried into the read-only index
  assert.ok(!("secretField" in r.suite));
});

test("buildIndex: output is deterministic — repos sorted regardless of inventory order", () => {
  const map = {
    "cinatra-ai/aaa@main": { ok: true, value: { suiteId: "a", version: "2026.06", accountable: { github: "g", name: "G", email: "g@x" }, requiredContexts: [], highRiskPaths: [] } },
    "cinatra-ai/zzz@main": { ok: true, value: { suiteId: "z", version: "2026.06", accountable: { github: "g", name: "G", email: "g@x" }, requiredContexts: [], highRiskPaths: [] } },
  };
  const inv1 = { repos: [{ repo: "cinatra-ai/zzz" }, { repo: "cinatra-ai/aaa" }] };
  const inv2 = { repos: [{ repo: "cinatra-ai/aaa" }, { repo: "cinatra-ai/zzz" }] };
  const a = serialize(buildIndex(inv1, stubReader(map), NOW));
  const b = serialize(buildIndex(inv2, stubReader(map), NOW));
  assert.equal(a, b);
  assert.equal(buildIndex(inv1, stubReader(map), NOW).repos[0].repo, "cinatra-ai/aaa");
});

test("buildIndex: an unreadable suite (malformed JSON) is `unreadable`, with detail — not silently dropped", () => {
  const inv = { repos: [{ repo: "cinatra-ai/cinatra", defaultBranch: "main" }] };
  const idx = buildIndex(inv, stubReader({ "cinatra-ai/cinatra@main": { ok: false, reason: "invalid: boom" } }), NOW);
  assert.equal(idx.repos[0].status, "unreadable");
  assert.match(idx.repos[0].detail, /invalid/);
});

test("buildIndex: a non-default branch is recorded as the scanned ref", () => {
  const inv = { repos: [{ repo: "cinatra-ai/x", defaultBranch: "trunk" }] };
  const idx = buildIndex(inv, stubReader({}), NOW);
  assert.equal(idx.repos[0].ref, "trunk");
});

test("buildIndex: missing defaultBranch defaults to main", () => {
  const inv = { repos: [{ repo: "cinatra-ai/x" }] };
  const idx = buildIndex(inv, stubReader({}), NOW);
  assert.equal(idx.repos[0].ref, "main");
});

test("serialize: stable 2-space JSON with a trailing newline", () => {
  const s = serialize({ a: 1 });
  assert.equal(s, '{\n  "a": 1\n}\n');
});

// ghReader classification (injectable exec) — codex round-2/3 MEDIUM
import { ghReader } from "../gate-suite-index.mjs";

function execStub(map) {
  // map: endpoint-substring -> () => string | throws {stderr}
  return (endpoint) => {
    for (const key of Object.keys(map)) {
      if (endpoint.includes(key)) {
        const v = map[key];
        if (typeof v === "function") return v();
        return v;
      }
    }
    const e = new Error("unexpected endpoint"); e.stderr = "gh: Not Found (HTTP 404)"; throw e;
  };
}
function http(status, msg) { const e = new Error(msg || `HTTP ${status}`); e.stderr = `gh: ${msg || "err"} (HTTP ${status})`; return () => { throw e; }; }

test("ghReader: a present suite parses (base64 content)", () => {
  const b64 = Buffer.from(JSON.stringify({ suiteId: "x", version: "2026.06" })).toString("base64");
  const r = ghReader("cinatra-ai/x", "main", execStub({ "/contents/": b64 }));
  assert.ok(r.ok);
  assert.equal(r.value.suiteId, "x");
});

test("ghReader: content 404 with a RESOLVING ref is genuine not-found", () => {
  const r = ghReader("cinatra-ai/x", "main", execStub({ "/contents/": http(404), "/commits/": "abc123" }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-found");
  assert.ok(!r.operational);
});

test("ghReader: content 404 with an UNRESOLVABLE ref/repo is operational (not a false no-suite)", () => {
  const r = ghReader("cinatra-ai/x", "main", execStub({ "/contents/": http(404), "/commits/": http(404, "repo gone") }));
  assert.equal(r.ok, false);
  assert.ok(r.operational);
  assert.match(r.reason, /operational/);
});

test("ghReader: a 401/403/5xx on the content call is operational, never not-found", () => {
  for (const s of [401, 403, 429, 500, 502]) {
    const r = ghReader("cinatra-ai/x", "main", execStub({ "/contents/": http(s, "boom") }));
    assert.ok(r.operational, `status ${s} should be operational`);
    assert.notEqual(r.reason, "not-found");
  }
});

test("ghReader: unparseable content is operational (invalid), not silently dropped", () => {
  const r = ghReader("cinatra-ai/x", "main", execStub({ "/contents/": Buffer.from("not json").toString("base64") }));
  assert.ok(r.operational);
  assert.match(r.reason, /invalid/);
});
