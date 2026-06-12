import { test } from "node:test";
import assert from "node:assert/strict";
import { sweep } from "../gate-suite-audit-report.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-12T00:00:00Z");
function daysAgo(n) { return new Date(NOW - n * DAY).toISOString().slice(0, 10); }
function reader(map) { return (repo, ref) => map[`${repo}@${ref}`] || { ok: false, reason: "not-found" }; }

const EV = "https://e/x#1"; // a valid string auditEvidence to isolate staleness

test("sweep: a fresh suite is `fresh`, not counted stale/lapsed", () => {
  const inv = { repos: [{ repo: "cinatra-ai/x", defaultBranch: "main" }] };
  const r = sweep(inv, reader({ "cinatra-ai/x@main": { ok: true, value: { lastAuditedAt: daysAgo(5), auditEvidence: EV } } }), NOW);
  assert.equal(r.rows[0].state, "fresh");
  assert.equal(r.stale, 0);
  assert.equal(r.lapsed, 0);
});

test("sweep: a > 35d suite is `going-stale` (counted in stale)", () => {
  const inv = { repos: [{ repo: "cinatra-ai/x", defaultBranch: "main" }] };
  const r = sweep(inv, reader({ "cinatra-ai/x@main": { ok: true, value: { lastAuditedAt: daysAgo(40), auditEvidence: EV } } }), NOW);
  assert.equal(r.rows[0].state, "going-stale");
  assert.equal(r.stale, 1);
  assert.equal(r.lapsed, 0);
});

test("sweep: a > 65d suite is `lapsed` (counted in lapsed)", () => {
  const inv = { repos: [{ repo: "cinatra-ai/x", defaultBranch: "main" }] };
  const r = sweep(inv, reader({ "cinatra-ai/x@main": { ok: true, value: { lastAuditedAt: daysAgo(80), auditEvidence: EV } } }), NOW);
  assert.equal(r.rows[0].state, "lapsed");
  assert.equal(r.lapsed, 1);
});

test("sweep: a suite with no lastAuditedAt is `no-audit-record` (counted lapsed)", () => {
  const inv = { repos: [{ repo: "cinatra-ai/x", defaultBranch: "main" }] };
  const r = sweep(inv, reader({ "cinatra-ai/x@main": { ok: true, value: {} } }), NOW);
  assert.equal(r.rows[0].state, "no-audit-record");
  assert.equal(r.lapsed, 1);
});

test("sweep: an inventoried repo with no committed suite is `no-suite` (not lapsed)", () => {
  const inv = { repos: [{ repo: "cinatra-ai/cinatra", defaultBranch: "main" }] };
  const r = sweep(inv, reader({}), NOW);
  assert.equal(r.rows[0].state, "no-suite");
  assert.equal(r.stale, 0);
  assert.equal(r.lapsed, 0);
});

test("sweep: an unreadable suite is `unreadable`, reported not dropped", () => {
  const inv = { repos: [{ repo: "cinatra-ai/x", defaultBranch: "main" }] };
  const r = sweep(inv, reader({ "cinatra-ai/x@main": { ok: false, reason: "invalid: boom" } }), NOW);
  assert.equal(r.rows[0].state, "unreadable");
  assert.match(r.rows[0].detail, /invalid/);
});

test("sweep: mixed inventory tallies stale + lapsed independently", () => {
  const inv = { repos: [
    { repo: "cinatra-ai/a" }, { repo: "cinatra-ai/b" }, { repo: "cinatra-ai/c" }, { repo: "cinatra-ai/d" },
  ] };
  const r = sweep(inv, reader({
    "cinatra-ai/a@main": { ok: true, value: { lastAuditedAt: daysAgo(5), auditEvidence: EV } },
    "cinatra-ai/b@main": { ok: true, value: { lastAuditedAt: daysAgo(40), auditEvidence: EV } },
    "cinatra-ai/c@main": { ok: true, value: { lastAuditedAt: daysAgo(90), auditEvidence: EV } },
    "cinatra-ai/d@main": { ok: true, value: {} },
  }), NOW);
  assert.equal(r.stale, 1);
  assert.equal(r.lapsed, 2);
});

test("sweep: a fresh date but MISSING auditEvidence is `no-audit-record` (watchdog catches it)", () => {
  const inv = { repos: [{ repo: "cinatra-ai/x", defaultBranch: "main" }] };
  const r = sweep(inv, reader({ "cinatra-ai/x@main": { ok: true, value: { lastAuditedAt: daysAgo(2) } } }), NOW);
  assert.equal(r.rows[0].state, "no-audit-record");
  assert.equal(r.lapsed, 1);
});

test("sweep: a fresh date with a non-string auditEvidence is `no-audit-record`", () => {
  const inv = { repos: [{ repo: "cinatra-ai/x", defaultBranch: "main" }] };
  const r = sweep(inv, reader({ "cinatra-ai/x@main": { ok: true, value: { lastAuditedAt: daysAgo(2), auditEvidence: {} } } }), NOW);
  assert.equal(r.rows[0].state, "no-audit-record");
});

test("sweep: a fresh date WITH a string auditEvidence is `fresh`", () => {
  const inv = { repos: [{ repo: "cinatra-ai/x", defaultBranch: "main" }] };
  const r = sweep(inv, reader({ "cinatra-ai/x@main": { ok: true, value: { lastAuditedAt: daysAgo(2), auditEvidence: "https://e/x#1" } } }), NOW);
  assert.equal(r.rows[0].state, "fresh");
});

test("sweep: a future lastAuditedAt (with evidence) is `no-audit-record` (cannot be fresh)", () => {
  const inv = { repos: [{ repo: "cinatra-ai/x", defaultBranch: "main" }] };
  const future = new Date(NOW + 30 * DAY).toISOString().slice(0, 10);
  const r = sweep(inv, reader({ "cinatra-ai/x@main": { ok: true, value: { lastAuditedAt: future, auditEvidence: "https://e/x#1" } } }), NOW);
  assert.equal(r.rows[0].state, "no-audit-record");
});
