import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseTrailers,
  classifyArm,
  aggregateAssisted,
  globToRegExp,
  classifyHighRisk,
  permissionMeetsTier,
  verifyReviewedLine,
  verifyGateArm,
  looksLikeAgent,
  analyzePreMerge,
  analyzePostMerge,
  parseNameStatusZ,
  rangeCommitIdentities,
  rangeCommitMessages,
  DEFAULT_AGENT_NAME_TOKENS,
  GATE_VERSION,
  checkAuditStaleness,
  checkSuiteVersionBump,
  AUDIT_STALE_WARN_DAYS,
  AUDIT_STALE_FAIL_DAYS,
} from "../truthful-attribution-gate.mjs";

const GATE = path.join(import.meta.dirname, "..", "truthful-attribution-gate.mjs");

// =========================================================================
// §1 — Trailer grammar: parseTrailers
// =========================================================================

test("§1 valid human-arm record (assisted + maintainer reviewed)", () => {
  const msg = [
    "feat: add the thing",
    "",
    "Body text.",
    "",
    "Assisted-by: Claude Code (claude-fable-5)",
    "Assisted-by: Codex CLI (gpt-5.5-codex)",
    "Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)",
  ].join("\n");
  const p = parseTrailers(msg);
  assert.deepEqual(p.errors, []);
  assert.equal(p.assisted.length, 2);
  assert.equal(p.assisted[0].name, "Claude Code");
  assert.equal(p.assisted[0].model, "claude-fable-5");
  assert.equal(p.reviewed.length, 1);
  assert.equal(p.reviewed[0].login, "groganz");
  assert.equal(p.reviewed[0].tier, "maintainer");
  assert.ok(p.hasHumanArm);
  assert.ok(!p.hasGateArm);
});

test("§1 valid gate-arm record (assisted + Gate-suite + Accountable)", () => {
  const msg = [
    "chore: tidy",
    "",
    "Assisted-by: Claude Code (claude-opus-4-8)",
    "Gate-suite: cinatra-core@2026.06",
    "Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)",
  ].join("\n");
  const p = parseTrailers(msg);
  assert.deepEqual(p.errors, []);
  assert.ok(p.hasGateArm);
  assert.equal(p.gateSuite.suite, "cinatra-core");
  assert.equal(p.gateSuite.version, "2026.06");
  assert.equal(p.accountable.login, "groganz");
});

test("§1 Assisted-by: none — human-only change is valid", () => {
  const p = parseTrailers("docs: fix typo\n\nAssisted-by: none\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)");
  assert.deepEqual(p.errors, []);
  assert.equal(p.assisted.length, 1);
  assert.ok(p.assisted[0].isNone);
});

test("§1 missing Assisted-by is an error (mandatory on every merge)", () => {
  const p = parseTrailers("fix: thing\n\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)");
  assert.ok(p.errors.some((e) => /missing Assisted-by/.test(e)));
});

test("§1 'none' mixed with a named assistant is invalid", () => {
  const p = parseTrailers("x\n\nAssisted-by: none\nAssisted-by: Claude Code (claude-opus-4-8)\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)");
  assert.ok(p.errors.some((e) => /none.*ONLY Assisted-by/.test(e)));
});

test("§1 'None' (wrong case) is rejected — exact lowercase reserved word", () => {
  const p = parseTrailers("x\n\nAssisted-by: None");
  assert.ok(p.errors.some((e) => /lowercase exactly/.test(e)));
});

test("§1 Assisted-by without a model id is valid (model optional)", () => {
  const p = parseTrailers("x\n\nAssisted-by: Claude Code\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)");
  assert.deepEqual(p.errors, []);
  assert.equal(p.assisted[0].name, "Claude Code");
  assert.equal(p.assisted[0].model, null);
});

test("§1 duplicate Gate-suite is invalid", () => {
  const p = parseTrailers([
    "x", "",
    "Assisted-by: Claude Code (claude-opus-4-8)",
    "Gate-suite: cinatra-core@2026.06",
    "Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)",
    "Gate-suite: cinatra-core@2026.07",
    "Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)",
  ].join("\n"));
  assert.ok(p.errors.some((e) => /duplicate Gate-suite/.test(e)));
});

test("§1 Accountable must immediately follow Gate-suite", () => {
  const p = parseTrailers([
    "x", "",
    "Assisted-by: Claude Code (claude-opus-4-8)",
    "Gate-suite: cinatra-core@2026.06",
    "Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)",
    "Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)",
  ].join("\n"));
  assert.ok(p.errors.some((e) => /immediately follow Gate-suite/.test(e)));
});

test("§1 Gate-suite without Accountable is invalid", () => {
  const p = parseTrailers("x\n\nAssisted-by: Claude Code (claude-opus-4-8)\nGate-suite: cinatra-core@2026.06");
  assert.ok(p.errors.some((e) => /Gate-suite present without Accountable/.test(e)));
});

test("§1 unknown trailer keys are ignored, not errors (ticket refs)", () => {
  const p = parseTrailers("x\n\nAssisted-by: none\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)\nCloses: #42\nRefs: JIRA-7");
  assert.deepEqual(p.errors, []);
});

test("§1 a malformed OWNED key (bad Reviewed-by) is an error, not ignored", () => {
  const p = parseTrailers("x\n\nAssisted-by: none\nReviewed-by: Sandro Groganz (no-angle-email) tier=maintainer");
  assert.ok(p.errors.some((e) => /malformed Reviewed-by/.test(e)));
});

test("§1 Reviewed-by requires the @login (anti-fabrication binds to login)", () => {
  const p = parseTrailers("x\n\nAssisted-by: none\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (tier=maintainer)");
  assert.ok(p.errors.some((e) => /malformed Reviewed-by/.test(e)));
});

test("§1 tier must be maintainer or peer", () => {
  const p = parseTrailers("x\n\nAssisted-by: none\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=security-audit)");
  assert.ok(p.errors.some((e) => /malformed Reviewed-by/.test(e)));
});

test("§1 version must be CalVer YYYY.MM[.N], not semver", () => {
  const p = parseTrailers("x\n\nAssisted-by: none\nGate-suite: cinatra-core@1.2.3\nAccountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)");
  assert.ok(p.errors.some((e) => /malformed Gate-suite/.test(e)));
});

test("§1 CalVer intra-month .N is accepted", () => {
  const p = parseTrailers("x\n\nAssisted-by: none\nGate-suite: cinatra-core@2026.06.1\nAccountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)");
  assert.deepEqual(p.errors, []);
  assert.equal(p.gateSuite.version, "2026.06.1");
});

test("§1 a continuation/folded line inside the block is invalid", () => {
  const p = parseTrailers("x\n\nAssisted-by: Claude Code (claude-opus-4-8)\n\tfolded continuation\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)");
  assert.ok(p.errors.some((e) => /continuation\/folded/.test(e)));
});

test("§1 strict LF: a CRLF record is a grammar error (non-LF line endings)", () => {
  const p = parseTrailers("x\r\n\r\nAssisted-by: none\r\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)\r\n\r\n");
  assert.ok(p.errors.some((e) => /non-LF line endings/.test(e)));
  // the content is still parsed (so the rest of the structure is reported), but
  // the record is invalid because of the CR.
  assert.ok(p.hasHumanArm);
});

test("§1 trailing blank lines after an LF block are tolerated", () => {
  const p = parseTrailers("x\n\nAssisted-by: none\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)\n\n\n");
  assert.deepEqual(p.errors, []);
  assert.ok(p.hasHumanArm);
});

test("§1 a non-trailer line in the final paragraph invalidates the block (no hiding behind prose)", () => {
  const p = parseTrailers("x\n\nAssisted-by: none\nthis is just prose, not a trailer\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)");
  assert.ok(p.errors.some((e) => /non-trailer line/.test(e)));
});

test("§1 duplicate Assisted-by: none is rejected", () => {
  const p = parseTrailers("x\n\nAssisted-by: none\nAssisted-by: none\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)");
  assert.ok(p.errors.some((e) => /none must appear at most once/.test(e)));
});

test("§1 multiple Reviewed-by lines (multiple human reviewers) parse", () => {
  const p = parseTrailers([
    "x", "",
    "Assisted-by: none",
    "Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)",
    "Reviewed-by: Pat Peer <pat@cinatra.ai> (@patpeer, tier=peer)",
  ].join("\n"));
  assert.deepEqual(p.errors, []);
  assert.equal(p.reviewed.length, 2);
});

test("§1 a display-name with a forbidden paren is not a valid Assisted-by name", () => {
  // "Weird (Name) Tool" — the first paren opens the model group; the residue is malformed.
  const p = parseTrailers("x\n\nAssisted-by: Weird (Name extra) Tool");
  assert.ok(p.errors.some((e) => /malformed Assisted-by/.test(e)) || p.assisted.length === 0);
});

// =========================================================================
// classifyArm
// =========================================================================

test("classifyArm: no arm present is an error", () => {
  const p = parseTrailers("x\n\nAssisted-by: none");
  const a = classifyArm(p);
  assert.ok(a.errors.some((e) => /no verification arm/.test(e)));
});

test("classifyArm: both arms present is allowed (human is of record)", () => {
  const p = parseTrailers([
    "x", "",
    "Assisted-by: none",
    "Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)",
    "Gate-suite: cinatra-core@2026.06",
    "Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)",
  ].join("\n"));
  const a = classifyArm(p);
  assert.deepEqual(a.errors, []);
  assert.ok(a.hasHumanArm && a.hasGateArm);
});

// =========================================================================
// §1 squash aggregation
// =========================================================================

test("aggregateAssisted: union, deduped on (name, model), first-appearance order", () => {
  const out = aggregateAssisted([
    "c1\n\nAssisted-by: Claude Code (claude-opus-4-8)",
    "c2\n\nAssisted-by: Claude Code (claude-opus-4-8)\nAssisted-by: Codex CLI (gpt-5.5-codex)",
    "c3\n\nAssisted-by: Claude Code (claude-opus-4-8)",
  ]);
  assert.deepEqual(out, [
    "Assisted-by: Claude Code (claude-opus-4-8)",
    "Assisted-by: Codex CLI (gpt-5.5-codex)",
  ]);
});

test("aggregateAssisted: same agent different model = two lines", () => {
  const out = aggregateAssisted([
    "c1\n\nAssisted-by: Claude Code (claude-opus-4-8)",
    "c2\n\nAssisted-by: Claude Code (claude-fable-5)",
  ]);
  assert.equal(out.length, 2);
});

test("aggregateAssisted: any named assistant drops 'none' (agent-assisted overall)", () => {
  const out = aggregateAssisted([
    "c1\n\nAssisted-by: none",
    "c2\n\nAssisted-by: Claude Code (claude-opus-4-8)",
  ]);
  assert.deepEqual(out, ["Assisted-by: Claude Code (claude-opus-4-8)"]);
});

test("aggregateAssisted: all-human squash collapses to a single none", () => {
  const out = aggregateAssisted(["c1\n\nAssisted-by: none", "c2\n\nAssisted-by: none"]);
  assert.deepEqual(out, ["Assisted-by: none"]);
});

// =========================================================================
// §3 — high-risk classification
// =========================================================================

test("globToRegExp: ** spans path segments; * does not cross /", () => {
  assert.ok(globToRegExp("**/auth/**").test("src/lib/auth/session.ts"));
  assert.ok(globToRegExp("**/auth/**").test("auth/x.ts"));
  assert.ok(globToRegExp("src/lib/auth*").test("src/lib/authz.ts"));
  assert.ok(!globToRegExp("src/lib/auth*").test("src/lib/auth/deep.ts")); // * stops at /
  assert.ok(globToRegExp(".github/**").test(".github/workflows/ci.yml"));
});

const DEFAULTS_OK = { ok: true, value: { highRiskGlobs: ["**/auth/**", ".github/**", "**/migrations/**", "config/high-risk-defaults.json"] } };

test("§3 a .github change is high-risk and requires the human arm", () => {
  const r = classifyHighRisk([".github/workflows/deploy.yml"], DEFAULTS_OK, null);
  assert.ok(r.highRisk);
  assert.equal(r.matched[0].glob, ".github/**");
});

test("§3 an ordinary source file is not high-risk", () => {
  const r = classifyHighRisk(["src/components/Button.tsx"], DEFAULTS_OK, null);
  assert.ok(!r.highRisk);
  assert.equal(r.errors.length, 0);
});

test("§3 defaults parse failure => fail closed (treated high-risk)", () => {
  const r = classifyHighRisk(["src/x.ts"], { ok: false, reason: "invalid JSON" }, null);
  assert.ok(r.highRisk);
  assert.ok(r.failClosed);
  assert.ok(r.errors.some((e) => /failing CLOSED/.test(e)));
});

test("§3 repo gate-suite may EXTEND defaults (superset ok)", () => {
  const suite = { ok: true, value: { highRiskPaths: ["**/auth/**", ".github/**", "**/migrations/**", "config/high-risk-defaults.json", "infra/**"] } };
  const r = classifyHighRisk(["infra/terraform/main.tf"], DEFAULTS_OK, suite);
  assert.ok(r.highRisk);
  assert.equal(r.errors.length, 0);
  assert.equal(r.matched[0].glob, "infra/**");
});

test("§3 repo gate-suite that REMOVES a default => fail closed", () => {
  const suite = { ok: true, value: { highRiskPaths: ["**/auth/**"] } }; // drops .github/**, migrations, config
  const r = classifyHighRisk(["src/x.ts"], DEFAULTS_OK, suite);
  assert.ok(r.highRisk);
  assert.ok(r.failClosed);
  assert.ok(r.errors.some((e) => /SUPERSET/.test(e)));
});

test("§3 repo gate-suite unparseable => fail closed", () => {
  const r = classifyHighRisk(["src/x.ts"], DEFAULTS_OK, { ok: false, reason: "bad json" });
  assert.ok(r.highRisk && r.failClosed);
});

test("§3 renamed file matches on BOTH old and new path", () => {
  // a file renamed OUT of auth/ still matches via its old path.
  const r = classifyHighRisk(["auth/old-session.ts", "lib/new-session.ts"], DEFAULTS_OK, null);
  assert.ok(r.highRisk);
});

// =========================================================================
// §2 / §5 — tier ↔ permission, Reviewed-by anti-fabrication
// =========================================================================

test("permissionMeetsTier: maintainer needs maintain/admin; peer needs write", () => {
  assert.ok(permissionMeetsTier("admin", "maintainer"));
  assert.ok(permissionMeetsTier("maintain", "maintainer"));
  assert.ok(!permissionMeetsTier("write", "maintainer"));
  assert.ok(permissionMeetsTier("write", "peer"));
  assert.ok(!permissionMeetsTier("read", "peer"));
});

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

test("§5 check2: a real, non-stale, non-self maintainer approval verifies", () => {
  const line = { login: "groganz", tier: "maintainer" };
  const reviews = [{ user: { login: "groganz" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-06-12T10:00:00Z" }];
  const v = verifyReviewedLine(line, { reviews, permission: "admin", prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD });
  assert.ok(v.ok, v.reasons.join("; "));
});

test("§5 check2: self-approval is rejected (author == reviewer)", () => {
  const line = { login: "groganz", tier: "maintainer" };
  const reviews = [{ user: { login: "groganz" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-06-12T10:00:00Z" }];
  const v = verifyReviewedLine(line, { reviews, permission: "admin", prAuthorLogin: "groganz", reviewedHeadSha: HEAD });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /self-approval/.test(r)));
});

test("§5 check2: a stale approval (older commit) is rejected", () => {
  const line = { login: "groganz", tier: "maintainer" };
  const reviews = [{ user: { login: "groganz" }, state: "APPROVED", commit_id: OLD, submitted_at: "2026-06-12T10:00:00Z" }];
  const v = verifyReviewedLine(line, { reviews, permission: "admin", prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /STALE/.test(r)));
});

test("§5 check2: latest review wins — a later CHANGES_REQUESTED kills an earlier APPROVED", () => {
  const line = { login: "groganz", tier: "maintainer" };
  const reviews = [
    { user: { login: "groganz" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-06-12T10:00:00Z" },
    { user: { login: "groganz" }, state: "CHANGES_REQUESTED", commit_id: HEAD, submitted_at: "2026-06-12T11:00:00Z" },
  ];
  const v = verifyReviewedLine(line, { reviews, permission: "admin", prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /not APPROVED/.test(r)));
});

test("§5 check2: a DISMISSED approval does not count", () => {
  const line = { login: "groganz", tier: "maintainer" };
  const reviews = [{ user: { login: "groganz" }, state: "DISMISSED", commit_id: HEAD, submitted_at: "2026-06-12T10:00:00Z" }];
  const v = verifyReviewedLine(line, { reviews, permission: "admin", prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /no non-dismissed review/.test(r)));
});

test("§5 check2: claimed tier exceeding actual permission is rejected", () => {
  const line = { login: "patpeer", tier: "maintainer" };
  const reviews = [{ user: { login: "patpeer" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-06-12T10:00:00Z" }];
  const v = verifyReviewedLine(line, { reviews, permission: "write", prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /does not meet claimed tier/.test(r)));
});

test("§5 check2: a login that never reviewed is rejected", () => {
  const line = { login: "ghost", tier: "maintainer" };
  const v = verifyReviewedLine(line, { reviews: [], permission: "admin", prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /no non-dismissed review/.test(r)));
});

// =========================================================================
// §5 check3 — gate arm anti-fabrication
// =========================================================================

// A FRESH audit date so the §4 staleness check (added with the registry work)
// does not make this canonical "valid suite" fixture fail in the existing
// gate-arm tests that don't inject `now`. "Today" keeps it < 35 days old under
// the real clock; the dedicated staleness tests below inject explicit `now`.
const TODAY_ISO = new Date().toISOString().slice(0, 10);
const SUITE_FILE = {
  ok: true,
  value: {
    suiteId: "cinatra-core",
    version: "2026.06",
    accountable: { name: "Sandro Groganz", email: "sandro@cinatra.ai", github: "groganz" },
    requiredContexts: [
      { context: "source-leak-gate / source-leak-gate" },
      { context: "ci / build-test" },
    ],
    lastAuditedAt: TODAY_ISO,
    auditEvidence: "https://github.com/cinatra-ai/cinatra-engineering/issues/200#issuecomment-1",
  },
};

function gateParsed(suite = "cinatra-core", version = "2026.06", login = "groganz") {
  return parseTrailers([
    "x", "",
    "Assisted-by: Claude Code (claude-opus-4-8)",
    `Gate-suite: ${suite}@${version}`,
    `Accountable: Sandro Groganz <sandro@cinatra.ai> (@${login})`,
  ].join("\n"));
}

test("§5 check3: matching suite + all contexts green verifies", () => {
  const checkRuns = [
    { name: "source-leak-gate / source-leak-gate", status: "completed", conclusion: "success", completed_at: "2026-06-12T10:00:00Z" },
    { name: "ci / build-test", status: "completed", conclusion: "success", completed_at: "2026-06-12T10:00:00Z" },
  ];
  const v = verifyGateArm(gateParsed(), { suiteFile: SUITE_FILE, checkRuns });
  assert.ok(v.ok, v.reasons.join("; "));
});

test("§5 check3: a cited version != committed suite is fabrication", () => {
  const checkRuns = SUITE_FILE.value.requiredContexts.map((c) => ({ name: c.context, status: "completed", conclusion: "success" }));
  const v = verifyGateArm(gateParsed("cinatra-core", "2026.07"), { suiteFile: SUITE_FILE, checkRuns });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /!= committed suite/.test(r)));
});

test("§5 check3: a required context not green is fabrication (skipped counts as failure)", () => {
  const checkRuns = [
    { name: "source-leak-gate / source-leak-gate", status: "completed", conclusion: "success" },
    { name: "ci / build-test", status: "completed", conclusion: "skipped" },
  ];
  const v = verifyGateArm(gateParsed(), { suiteFile: SUITE_FILE, checkRuns });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /did not conclude success/.test(r)));
});

test("§5 check3: a missing required context is fabrication", () => {
  const checkRuns = [{ name: "source-leak-gate / source-leak-gate", status: "completed", conclusion: "success" }];
  const v = verifyGateArm(gateParsed(), { suiteFile: SUITE_FILE, checkRuns });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /no matching check-run/.test(r)));
});

test("§5 check3: Accountable trailer != file's accountable is fabrication", () => {
  const checkRuns = SUITE_FILE.value.requiredContexts.map((c) => ({ name: c.context, status: "completed", conclusion: "success" }));
  const v = verifyGateArm(gateParsed("cinatra-core", "2026.06", "someoneelse"), { suiteFile: SUITE_FILE, checkRuns });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /Accountable/.test(r)));
});

// =========================================================================
// §5 check5 — known-agent identity
// =========================================================================

test("§5 check5: agent vendor tokens are detected by name/email", () => {
  assert.ok(looksLikeAgent({ name: "Claude Code", email: "noreply@anthropic.com" }));
  assert.ok(looksLikeAgent({ name: "Codex", email: "x@y.z" }));
  assert.ok(looksLikeAgent({ name: "x", email: "agent@openai.com" }));
});

test("§5 check5: non-AI bots are allowlisted (renovate/dependabot/github-actions)", () => {
  assert.ok(!looksLikeAgent({ name: "dependabot[bot]", email: "x@y.z" }));
  assert.ok(!looksLikeAgent({ name: "renovate[bot]", email: "bot@renovate.com" }));
  assert.ok(!looksLikeAgent({ name: "github-actions[bot]", email: "x@y.z" }));
});

test("§5 check5: a plain human identity is not an agent", () => {
  assert.ok(!looksLikeAgent({ name: "Sandro Groganz", email: "sandro@cinatra.ai" }));
});

test("§5 check5: the dedicated agent identity (cinatra-agent-bot[bot]) is detected", () => {
  // eng#119 §5/§8.5, eng#137: the bot that authors every agent-opened PR must
  // be recognized as an agent so an Assisted-by omission on its commits is
  // caught. Its identity carries no vendor token, so the public "cinatra-agent"
  // default is what keys check 5 on it.
  assert.ok(looksLikeAgent({
    name: "cinatra-agent-bot[bot]",
    email: "293224031+cinatra-agent-bot[bot]@users.noreply.github.com",
  }), "the dedicated agent identity must be flagged as an agent");
  // A future cinatra-agent-* identity is also covered by the substring token.
  assert.ok(looksLikeAgent({ name: "cinatra-agent-ci[bot]", email: "x@y.z" }));
});

test("§5 check5: internal codename tokens are NOT in the public default", () => {
  // Sanity: the default list is the public AI-vendor tokens + the public bot
  // login token only — never internal codenames.
  for (const t of DEFAULT_AGENT_NAME_TOKENS) assert.equal(typeof t, "string");
  assert.ok(DEFAULT_AGENT_NAME_TOKENS.includes("claude"));
  assert.ok(DEFAULT_AGENT_NAME_TOKENS.includes("cinatra-agent")); // the public dedicated-agent login token
  assert.ok(!DEFAULT_AGENT_NAME_TOKENS.includes("fable")); // a codename would live in private config
});

test("§5 check5: extra (internal codename) tokens flag via opts", () => {
  assert.ok(looksLikeAgent({ name: "InternalCodename", email: "x@y.z" }, { tokens: ["internalcodename"] }));
});

// =========================================================================
// parseNameStatusZ
// =========================================================================

test("parseNameStatusZ: renames yield both old and new path", () => {
  const out = "R100\0old/a.ts\0new/b.ts\0M\0src/c.ts\0";
  const paths = parseNameStatusZ(out);
  assert.ok(paths.includes("old/a.ts"));
  assert.ok(paths.includes("new/b.ts"));
  assert.ok(paths.includes("src/c.ts"));
});

// =========================================================================
// Orchestration — analyzePreMerge / analyzePostMerge (pure, stubbed inputs)


// =========================================================================
// Round-2 (codex-converge) regression tests
// =========================================================================

test("R2 §1: a whitespace-only Assisted-by name is rejected (no blank assistant)", () => {
  const p1 = parseTrailers("x\n\nAssisted-by:    \nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)");
  assert.ok(p1.errors.some((e) => /malformed Assisted-by|missing Assisted-by/.test(e)) || p1.assisted.every((a) => a.isNone === false ? a.name : true) === false || !p1.assisted.some((a) => !a.isNone && a.name && a.name.trim()));
  // Concretely: there must be NO named assistant with a blank name.
  assert.ok(!p1.assisted.some((a) => !a.isNone && (!a.name || !a.name.trim())));
});

test("R2 §1: 'Assisted-by:   (model)' with a blank name is not a valid named assistant", () => {
  const p1 = parseTrailers("x\n\nAssisted-by:   (gpt-5)\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)");
  assert.ok(!p1.assisted.some((a) => !a.isNone && (!a.name || !a.name.trim())));
});

test("R2 §1: an unknown trailer with underscore/dot tokens is still accepted (not false-rejected)", () => {
  const p1 = parseTrailers("x\n\nAssisted-by: none\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)\nX.Ref: ABC-1\nco_author_note: see thread");
  assert.deepEqual(p1.errors, []);
});

test("R2 check3: a queued rerun with NO started_at is not masked by an older success", () => {
  const checkRuns = [
    { name: "source-leak-gate / source-leak-gate", status: "completed", conclusion: "success", started_at: "2026-06-12T09:00:00Z", completed_at: "2026-06-12T09:05:00Z" },
    { name: "source-leak-gate / source-leak-gate", status: "queued", conclusion: null, created_at: "2026-06-12T10:00:00Z", updated_at: "2026-06-12T10:00:00Z" },
    { name: "ci / build-test", status: "completed", conclusion: "success", started_at: "2026-06-12T09:00:00Z" },
  ];
  const v = verifyGateArm(gateParsed(), { suiteFile: SUITE_FILE, checkRuns });
  assert.ok(!v.ok, "a newer queued rerun (created_at only) must override the older success");
});

test("R2 check3: a suite whose accountable omits name/email fails closed", () => {
  const partialSuite = { ok: true, value: { suiteId: "cinatra-core", version: "2026.06", accountable: { github: "groganz" }, requiredContexts: [{ context: "ci / build-test" }] } };
  const checkRuns = [{ name: "ci / build-test", status: "completed", conclusion: "success" }];
  const v = verifyGateArm(gateParsed(), { suiteFile: partialSuite, checkRuns });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /accountable is incomplete/.test(r)));
});

test("R2 check3: app/workflow identity pin — a same-named run from the wrong app does not satisfy", () => {
  const pinnedSuite = { ok: true, value: { suiteId: "cinatra-core", version: "2026.06", accountable: SUITE_FILE.value.accountable, requiredContexts: [{ context: "ci / build-test", appSlug: "github-actions" }] } };
  const checkRuns = [{ name: "ci / build-test", status: "completed", conclusion: "success", app: { slug: "some-other-app" } }];
  const v = verifyGateArm(gateParsed(), { suiteFile: pinnedSuite, checkRuns });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /no matching check-run/.test(r)));
});

test("R2 postMerge: a PR-merge correction (reviewed head present) still enforces the tree bridge", () => {
  const message = [
    "fix the record", "",
    "Assisted-by: none",
    "Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)",
    "Correction-for: " + "c".repeat(40),
  ].join("\n");
  const r = analyzePostMerge({
    message, changedFiles: ["src/x.ts"], defaults: DEFAULTS_OK, repoSuite: null,
    apiBound: true, treeMatch: false,
    reviews: [{ user: { login: "groganz" }, state: "APPROVED", commit_id: HEAD, submitted_at: "t" }],
    prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD, permissionByLogin: { groganz: "admin" },
  });
  assert.ok(r.findings.some((f) => f.code === "tree-mismatch"), "a PR-merge correction must not bypass the tree bridge");
});

test("R2 postMerge: a non-PR correction (no reviewed head) legitimately skips the tree bridge", () => {
  const message = [
    "retroactive attestation", "",
    "Assisted-by: none",
    "Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)",
    "Correction-for: " + "d".repeat(40),
  ].join("\n");
  const r = analyzePostMerge({
    message, changedFiles: ["docs/x.md"], defaults: DEFAULTS_OK, repoSuite: null,
    apiBound: false, // no PR / no reviewed head
  });
  assert.ok(!r.findings.some((f) => f.code === "tree-mismatch" || f.code === "tree-unverifiable"), JSON.stringify(r.findings));
});

test("R2 preMerge: a DECLARED Reviewed-by with API unbound is unverifiable (fail closed)", () => {
  const r = analyzePreMerge({
    changedFiles: ["src/x.ts"], rangeIdentities: [], messageBySha: {},
    defaults: DEFAULTS_OK, repoSuite: null, apiBound: false,
    declaredReviewedBy: [{ login: "groganz", tier: "maintainer" }],
  });
  assert.ok(r.findings.some((f) => f.code === "reviewed-by-unverifiable"), JSON.stringify(r.findings));
});

test("R2 preMerge: a DECLARED Gate-suite with API unbound is unverifiable (fail closed)", () => {
  const r = analyzePreMerge({
    changedFiles: ["src/x.ts"], rangeIdentities: [], messageBySha: {},
    defaults: DEFAULTS_OK, repoSuite: null, apiBound: false,
    declaredGateArm: gateParsed(),
  });
  assert.ok(r.findings.some((f) => f.code === "gate-suite-unverifiable"), JSON.stringify(r.findings));
});

test("R2 preMerge check5: a later commit mentioning an agent SHA does not satisfy that commit's own missing Assisted-by", () => {
  const agentSha = "e".repeat(40);
  const r = analyzePreMerge({
    changedFiles: ["src/x.ts"],
    rangeIdentities: [{ sha: agentSha, authorName: "Claude Code", authorEmail: "noreply@anthropic.com", committerName: "Claude Code", committerEmail: "noreply@anthropic.com" }],
    // The agent commit's OWN message has no Assisted-by; a *different* later
    // commit body references the agent SHA and carries a valid Assisted-by.
    messageBySha: { [agentSha]: "fix: thing (no trailer)" },
    rangeMessages: ["chore: follow-up to " + agentSha + "\n\nAssisted-by: Claude Code (claude-opus-4-8)"],
    defaults: DEFAULTS_OK, repoSuite: null,
  });
  assert.ok(r.findings.some((f) => f.code === "agent-commit-no-assisted"), JSON.stringify(r.findings));
});
test("R3 preMerge: a fabricated Reviewed-by DECLARED in the PR body is caught (reachable path)", () => {
  // Mirror what main() does: parse the PR body's §1 block into declaredReviewedBy.
  const prBody = "Some description.\n\nAssisted-by: Claude Code (claude-opus-4-8)\nReviewed-by: Mallory Forge <mallory@x.io> (@mallory, tier=maintainer)";
  const declared = parseTrailers(prBody);
  assert.equal(declared.reviewed.length, 1, "the body trailer block must parse a Reviewed-by");
  const r = analyzePreMerge({
    changedFiles: ["src/x.ts"], rangeIdentities: [], messageBySha: {},
    defaults: DEFAULTS_OK, repoSuite: null, apiBound: true,
    reviews: [], // @mallory never actually approved
    approverLogins: [], prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD, permissionByLogin: {},
    declaredReviewedBy: declared.reviewed,
  });
  assert.ok(r.findings.some((f) => f.code === "reviewed-by-fabricated"), JSON.stringify(r.findings));
});

test("R3 preMerge: a truthful Reviewed-by DECLARED in the PR body and actually approved passes", () => {
  const prBody = "Assisted-by: none\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)";
  const declared = parseTrailers(prBody);
  const r = analyzePreMerge({
    changedFiles: ["src/x.ts"], rangeIdentities: [], messageBySha: {},
    defaults: DEFAULTS_OK, repoSuite: null, apiBound: true,
    reviews: [{ user: { login: "groganz" }, state: "APPROVED", commit_id: HEAD, submitted_at: "t" }],
    approverLogins: ["groganz"], prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD,
    permissionByLogin: { groganz: "admin" },
    declaredReviewedBy: declared.reviewed,
  });
  assert.ok(!r.findings.some((f) => f.code === "reviewed-by-fabricated" || f.code === "reviewed-by-unverifiable"), JSON.stringify(r.findings));
});

// =========================================================================

test("analyzePostMerge: a clean human-arm record on an ordinary change is finding-free", () => {
  const message = [
    "feat: button", "",
    "Assisted-by: Claude Code (claude-opus-4-8)",
    "Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)",
  ].join("\n");
  const reviews = [{ user: { login: "groganz" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-06-12T10:00:00Z" }];
  const r = analyzePostMerge({
    message, changedFiles: ["src/Button.tsx"], defaults: DEFAULTS_OK, repoSuite: null,
    reviews, prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD, permissionByLogin: { groganz: "admin" },
    treeMatch: true, apiBound: true,
  });
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
});

test("analyzePostMerge: no record at all => no-record finding", () => {
  const r = analyzePostMerge({ message: "feat: x\n\njust a body, no trailers", changedFiles: ["src/x.ts"], defaults: DEFAULTS_OK, repoSuite: null });
  assert.ok(r.findings.some((f) => f.code === "no-record"));
});

test("analyzePostMerge: high-risk change with only a gate arm => high-risk-without-maintainer", () => {
  const message = [
    "ci: change workflow", "",
    "Assisted-by: Claude Code (claude-opus-4-8)",
    "Gate-suite: cinatra-core@2026.06",
    "Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)",
  ].join("\n");
  const checkRuns = SUITE_FILE.value.requiredContexts.map((c) => ({ name: c.context, status: "completed", conclusion: "success" }));
  const r = analyzePostMerge({
    message, changedFiles: [".github/workflows/ci.yml"], defaults: DEFAULTS_OK, repoSuite: SUITE_FILE,
    reviews: [], prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD, permissionByLogin: {},
    suiteFile: SUITE_FILE, checkRuns, treeMatch: true, apiBound: true,
  });
  assert.ok(r.findings.some((f) => f.code === "high-risk-without-maintainer"), JSON.stringify(r.findings));
});

test("analyzePostMerge: tree mismatch is flagged", () => {
  const message = "x\n\nAssisted-by: none\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)";
  const r = analyzePostMerge({
    message, changedFiles: ["docs/readme.md"], defaults: DEFAULTS_OK, repoSuite: null,
    reviews: [{ user: { login: "groganz" }, state: "APPROVED", commit_id: HEAD, submitted_at: "t" }],
    prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD, permissionByLogin: { groganz: "admin" }, treeMatch: false, apiBound: true,
  });
  assert.ok(r.findings.some((f) => f.code === "tree-mismatch"));
});

test("analyzePreMerge: an agent-authored commit without Assisted-by => error finding (check5)", () => {
  const r = analyzePreMerge({
    changedFiles: ["src/x.ts"],
    rangeIdentities: [{ sha: "deadbeef".repeat(5), authorName: "Claude Code", authorEmail: "noreply@anthropic.com", committerName: "Claude Code", committerEmail: "noreply@anthropic.com" }],
    messageBySha: { ["deadbeef".repeat(5)]: "fix: thing\n\n(no trailers)" },
    defaults: DEFAULTS_OK, repoSuite: null,
  });
  const f = r.findings.find((x) => x.code === "agent-commit-no-assisted");
  assert.ok(f, JSON.stringify(r.findings));
  assert.equal(f.severity, "error", "check5 must be error so enforce mode gates it");
});

// --- Anti-fabrication fail-closed: a claimed arm we cannot verify is a finding,
//     never a silent pass (codex-converge round 1 findings 1, 2, 7). ----------

test("analyzePostMerge: a human-arm record with NO API binding is unverifiable (fail closed)", () => {
  const message = "x\n\nAssisted-by: none\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)";
  const r = analyzePostMerge({ message, changedFiles: ["docs/x.md"], defaults: DEFAULTS_OK, repoSuite: null, apiBound: false });
  assert.ok(r.findings.some((f) => f.code === "reviewed-by-unverifiable"), JSON.stringify(r.findings));
});

test("analyzePostMerge: a gate-arm record with NO committed suite is fabricated (fail closed)", () => {
  const message = [
    "x", "",
    "Assisted-by: Claude Code (claude-opus-4-8)",
    "Gate-suite: cinatra-core@2026.06",
    "Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)",
  ].join("\n");
  const r = analyzePostMerge({
    message, changedFiles: ["src/x.ts"], defaults: DEFAULTS_OK, repoSuite: null,
    apiBound: true, reviews: [], checkRuns: [], suiteFile: null,
  });
  assert.ok(r.findings.some((f) => f.code === "gate-suite-fabricated"), JSON.stringify(r.findings));
});

test("analyzePostMerge: a gate-arm record with API unbound is unverifiable (fail closed)", () => {
  const message = [
    "x", "",
    "Assisted-by: Claude Code (claude-opus-4-8)",
    "Gate-suite: cinatra-core@2026.06",
    "Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)",
  ].join("\n");
  const r = analyzePostMerge({ message, changedFiles: ["src/x.ts"], defaults: DEFAULTS_OK, repoSuite: null, apiBound: false });
  assert.ok(r.findings.some((f) => f.code === "gate-suite-unverifiable"), JSON.stringify(r.findings));
});

test("analyzePostMerge: a squash of agent work carrying Assisted-by: none is flagged (check5, post-merge)", () => {
  const message = "feat: x\n\nAssisted-by: none\nReviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)";
  const r = analyzePostMerge({
    message, changedFiles: ["src/x.ts"], defaults: DEFAULTS_OK, repoSuite: null,
    apiBound: true, treeMatch: true,
    reviews: [{ user: { login: "groganz" }, state: "APPROVED", commit_id: HEAD, submitted_at: "t" }],
    prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD, permissionByLogin: { groganz: "admin" },
    agentTokens: DEFAULT_AGENT_NAME_TOKENS,
    rangeIdentities: [{ sha: "a".repeat(40), authorName: "Claude Code", authorEmail: "noreply@anthropic.com", committerName: "Claude Code", committerEmail: "noreply@anthropic.com" }],
  });
  assert.ok(r.findings.some((f) => f.code === "agent-commit-no-assisted"), JSON.stringify(r.findings));
});

test("analyzePreMerge: high-risk change with API unbound is unverifiable (fail closed)", () => {
  const r = analyzePreMerge({
    changedFiles: [".github/workflows/ci.yml"], rangeIdentities: [], messageBySha: {},
    defaults: DEFAULTS_OK, repoSuite: null, apiBound: false,
  });
  assert.ok(r.findings.some((f) => f.code === "high-risk-unverifiable"), JSON.stringify(r.findings));
});

test("§5 check3: a newer in-progress rerun is NOT masked by an older success", () => {
  const parsed = gateParsed();
  const checkRuns = [
    { name: "source-leak-gate / source-leak-gate", status: "completed", conclusion: "success", started_at: "2026-06-12T09:00:00Z", completed_at: "2026-06-12T09:05:00Z" },
    { name: "source-leak-gate / source-leak-gate", status: "in_progress", conclusion: null, started_at: "2026-06-12T10:00:00Z", completed_at: null },
    { name: "ci / build-test", status: "completed", conclusion: "success", started_at: "2026-06-12T09:00:00Z" },
  ];
  const v = verifyGateArm(parsed, { suiteFile: SUITE_FILE, checkRuns });
  assert.ok(!v.ok, "a pending rerun must override the older success");
  assert.ok(v.reasons.some((r) => /did not conclude success/.test(r)));
});

test("§5 check3: a suite file with NO requiredContexts fails closed", () => {
  const emptySuite = { ok: true, value: { suiteId: "cinatra-core", version: "2026.06", accountable: SUITE_FILE.value.accountable, requiredContexts: [] } };
  const v = verifyGateArm(gateParsed(), { suiteFile: emptySuite, checkRuns: [] });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /no requiredContexts/.test(r)));
});

test("§5 check3: Accountable with matching login but forged name is fabrication", () => {
  const checkRuns = SUITE_FILE.value.requiredContexts.map((c) => ({ name: c.context, status: "completed", conclusion: "success" }));
  const parsed = parseTrailers([
    "x", "",
    "Assisted-by: Claude Code (claude-opus-4-8)",
    "Gate-suite: cinatra-core@2026.06",
    "Accountable: Mallory Forge <sandro@cinatra.ai> (@groganz)",
  ].join("\n"));
  const v = verifyGateArm(parsed, { suiteFile: SUITE_FILE, checkRuns });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /Accountable name/.test(r)));
});

test("analyzePreMerge: high-risk PR with a verified maintainer approval passes", () => {
  const reviews = [{ user: { login: "groganz" }, state: "APPROVED", commit_id: HEAD, submitted_at: "t" }];
  const r = analyzePreMerge({
    changedFiles: [".github/workflows/ci.yml"], rangeIdentities: [], messageBySha: {},
    defaults: DEFAULTS_OK, repoSuite: null,
    reviews, approverLogins: ["groganz"], prAuthorLogin: "claude-bot", reviewedHeadSha: HEAD,
    permissionByLogin: { groganz: "admin" }, apiBound: true,
  });
  assert.ok(!r.findings.some((f) => f.code === "high-risk-without-maintainer"), JSON.stringify(r.findings));
});

test("analyzePreMerge: high-risk PR with only a self-approval fails check4", () => {
  const reviews = [{ user: { login: "groganz" }, state: "APPROVED", commit_id: HEAD, submitted_at: "t" }];
  const r = analyzePreMerge({
    changedFiles: [".github/workflows/ci.yml"], rangeIdentities: [], messageBySha: {},
    defaults: DEFAULTS_OK, repoSuite: null,
    reviews, approverLogins: ["groganz"], prAuthorLogin: "groganz", reviewedHeadSha: HEAD,
    permissionByLogin: { groganz: "admin" }, apiBound: true,
  });
  assert.ok(r.findings.some((f) => f.code === "high-risk-without-maintainer"), JSON.stringify(r.findings));
});

// =========================================================================
// CLI smoke — WARN mode always exits 0 even with findings
// =========================================================================

function tmpRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tag-")));
  const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "sandro@cinatra.ai");
  g("config", "user.name", "Sandro Groganz");
  // Disable any global/local hooks for test isolation: the operator machine's
  // Stage-1 commit-msg hook legitimately STRIPS verification trailers from
  // working commits (Reviewed-by/Gate-suite/Accountable belong only to merge
  // records), which would otherwise mutate the fixture commit messages here.
  g("config", "core.hooksPath", "/dev/null");
  return { dir, g };
}

test("CLI post-merge WARN: a record-less commit produces findings but exits 0", () => {
  const { dir, g } = tmpRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  g("add", "-A");
  g("commit", "-q", "-m", "feat: no record here at all");
  const res = spawnSync("node", [GATE, "--arm", "post-merge", "--mode", "warn", "--format", "json", "--high-risk-defaults", path.join(import.meta.dirname, "..", "..", "config", "high-risk-defaults.json")], {
    cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_REPOSITORY: "" },
  });
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.mode, "warn");
  assert.equal(report.gateVersion, GATE_VERSION);
  assert.ok(report.findings.some((f) => f.code === "no-record"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI post-merge ENFORCE: the same record-less commit exits 1 (flag-only upgrade)", () => {
  const { dir, g } = tmpRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  g("add", "-A");
  g("commit", "-q", "-m", "feat: still no record");
  const res = spawnSync("node", [GATE, "--arm", "post-merge", "--mode", "enforce", "--format", "json", "--high-risk-defaults", path.join(import.meta.dirname, "..", "..", "config", "high-risk-defaults.json")], {
    cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_REPOSITORY: "" },
  });
  assert.equal(res.status, 1, `expected enforce to fail; stderr=${res.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI post-merge WARN: a clean human-arm record on an ordinary change is finding-free (offline grammar)", () => {
  const { dir, g } = tmpRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  g("add", "-A");
  const msg = [
    "feat: ok", "",
    "Assisted-by: none",
    "Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)",
  ].join("\n");
  g("commit", "-q", "-m", msg);
  const res = spawnSync("node", [GATE, "--arm", "post-merge", "--mode", "warn", "--format", "json", "--high-risk-defaults", path.join(import.meta.dirname, "..", "..", "config", "high-risk-defaults.json")], {
    cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_REPOSITORY: "" },
  });
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  // No API context => anti-fabrication skipped; grammar/structure is clean.
  assert.ok(report.apiSkippedReason);
  assert.equal(report.findings.filter((f) => f.code === "no-record").length, 0, JSON.stringify(report.findings));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI rejects an unknown --arm", () => {
  const res = spawnSync("node", [GATE, "--arm", "sideways"], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown --arm/);
});

// =========================================================================
// §4 — continuous-audit staleness (gate-arm only) + version-bump rule
// =========================================================================

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-12T00:00:00Z");
function daysAgo(n) { return new Date(NOW - n * DAY).toISOString().slice(0, 10); }

test("§4 staleness: a fresh audit (< 35d) is clean", () => {
  const r = checkAuditStaleness(daysAgo(10), NOW);
  assert.ok(!r.fail && !r.warn);
});

test("§4 staleness: missing lastAuditedAt fails closed (no audit record)", () => {
  for (const v of [undefined, null, ""]) {
    const r = checkAuditStaleness(v, NOW);
    assert.ok(r.fail, `expected fail for ${JSON.stringify(v)}`);
    assert.match(r.message, /no lastAuditedAt|audit obligation/);
  }
});

test("§4 staleness: an unparseable lastAuditedAt fails closed", () => {
  const r = checkAuditStaleness("not-a-date", NOW);
  assert.ok(r.fail);
  assert.match(r.message, /not a valid date/);
});

test(`§4 staleness: > ${AUDIT_STALE_WARN_DAYS}d warns (not fail)`, () => {
  const r = checkAuditStaleness(daysAgo(AUDIT_STALE_WARN_DAYS + 1), NOW);
  assert.ok(r.warn && !r.fail);
  assert.match(r.message, /going stale/);
});

test(`§4 staleness: > ${AUDIT_STALE_FAIL_DAYS}d fails (gate-arm blocked)`, () => {
  const r = checkAuditStaleness(daysAgo(AUDIT_STALE_FAIL_DAYS + 1), NOW);
  assert.ok(r.fail && !r.warn);
  assert.match(r.message, /lapsed|blocked/);
});

test("§4 staleness: boundary at exactly 35d/65d does not trip (strict >)", () => {
  assert.ok(!checkAuditStaleness(daysAgo(AUDIT_STALE_WARN_DAYS), NOW).warn);
  assert.ok(!checkAuditStaleness(daysAgo(AUDIT_STALE_FAIL_DAYS), NOW).fail);
});


test("§4 verifyGateArm: a stale (> 65d) suite fails the gate arm via reasons", () => {
  const checkRuns = SUITE_FILE.value.requiredContexts.map((c) => ({ name: c.context, status: "completed", conclusion: "success" }));
  const staleSuite = { ok: true, value: { ...SUITE_FILE.value, lastAuditedAt: daysAgo(AUDIT_STALE_FAIL_DAYS + 5) } };
  const v = verifyGateArm(gateParsed(), { suiteFile: staleSuite, checkRuns, now: NOW });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /lapsed|blocked/.test(r)));
});

test("§4 verifyGateArm: a going-stale (35–65d) suite still verifies but warns", () => {
  const checkRuns = SUITE_FILE.value.requiredContexts.map((c) => ({ name: c.context, status: "completed", conclusion: "success" }));
  const agingSuite = { ok: true, value: { ...SUITE_FILE.value, lastAuditedAt: daysAgo(AUDIT_STALE_WARN_DAYS + 5) } };
  const v = verifyGateArm(gateParsed(), { suiteFile: agingSuite, checkRuns, now: NOW });
  assert.ok(v.ok, v.reasons.join("; "));
  assert.ok((v.warnings || []).some((w) => /going stale/.test(w)));
});

test("§4 verifyGateArm: a suite with NO lastAuditedAt fails closed on the gate arm", () => {
  const checkRuns = SUITE_FILE.value.requiredContexts.map((c) => ({ name: c.context, status: "completed", conclusion: "success" }));
  // include auditEvidence so the failure isolates the missing lastAuditedAt
  const noAudit = { ok: true, value: { suiteId: "cinatra-core", version: "2026.06", accountable: SUITE_FILE.value.accountable, requiredContexts: SUITE_FILE.value.requiredContexts, auditEvidence: "https://e/x#1" } };
  const v = verifyGateArm(gateParsed(), { suiteFile: noAudit, checkRuns, now: NOW });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /no lastAuditedAt|audit obligation/.test(r)));
});

test("§4 verifyGateArm: a suite with a fresh lastAuditedAt but NO auditEvidence fails closed (coupling floor)", () => {
  const checkRuns = SUITE_FILE.value.requiredContexts.map((c) => ({ name: c.context, status: "completed", conclusion: "success" }));
  const noEvidence = { ok: true, value: { ...SUITE_FILE.value, lastAuditedAt: daysAgo(2), auditEvidence: undefined } };
  const v = verifyGateArm(gateParsed(), { suiteFile: noEvidence, checkRuns, now: NOW });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /auditEvidence must be a non-empty string/.test(r)));
});

test("§4 verifyGateArm: a NON-STRING auditEvidence (object) fails closed (no String() bypass)", () => {
  const checkRuns = SUITE_FILE.value.requiredContexts.map((c) => ({ name: c.context, status: "completed", conclusion: "success" }));
  const objEvidence = { ok: true, value: { ...SUITE_FILE.value, lastAuditedAt: daysAgo(2), auditEvidence: {} } };
  const v = verifyGateArm(gateParsed(), { suiteFile: objEvidence, checkRuns, now: NOW });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /auditEvidence must be a non-empty string/.test(r)));
});

test("§4 version-bump: changed date with unchanged STRUCTURED evidence fails (value compare, not ===)", () => {
  const parent = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a" }], highRiskPaths: [], lastAuditedAt: "2026-05-01", auditEvidence: ["u1"] } };
  const head = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a" }], highRiskPaths: [], lastAuditedAt: "2026-06-01", auditEvidence: ["u1"] } };
  const r = checkSuiteVersionBump(parent, head);
  assert.ok(!r.ok);
  assert.match(r.reason, /auditEvidence did not/);
});

test("§4 verifyGateArm: a FUTURE lastAuditedAt fails closed (cannot suppress staleness)", () => {
  const checkRuns = SUITE_FILE.value.requiredContexts.map((c) => ({ name: c.context, status: "completed", conclusion: "success" }));
  const future = { ok: true, value: { ...SUITE_FILE.value, lastAuditedAt: new Date(NOW + 30 * DAY).toISOString().slice(0, 10) } };
  const v = verifyGateArm(gateParsed(), { suiteFile: future, checkRuns, now: NOW });
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => /FUTURE/.test(r)));
});

test("§4 staleness: a far-future date fails closed (not treated as fresh)", () => {
  const r = checkAuditStaleness(new Date(NOW + 30 * DAY).toISOString().slice(0, 10), NOW);
  assert.ok(r.fail);
  assert.match(r.message, /FUTURE/);
});

test("§4 staleness: a within-skew future date (< 1d) is tolerated as fresh", () => {
  const r = checkAuditStaleness(new Date(NOW + 6 * 60 * 60 * 1000).toISOString(), NOW);
  assert.ok(!r.fail && !r.warn);
});

test("§4 version-bump: a GENUINELY NEW suite (absent parent) is vacuously OK", () => {
  const head = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "x" }], highRiskPaths: [] } };
  const r = checkSuiteVersionBump({ ok: false, reason: "absent-at-ref", absent: true }, head);
  assert.ok(r.ok);
});

test("§4 version-bump: an OPERATIONAL parent failure FAILS CLOSED (no fail-open)", () => {
  const head = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "x" }], highRiskPaths: [] } };
  for (const parent of [
    { ok: false, reason: "base ref 'origin/main' does not resolve", operational: true },
    { ok: false, reason: "invalid JSON at origin/main: boom", operational: true },
    null,
  ]) {
    const r = checkSuiteVersionBump(parent, head);
    assert.ok(!r.ok, `expected fail-closed for ${JSON.stringify(parent)}`);
    assert.match(r.reason, /failing closed|cannot read the parent/);
  }
});

test("§4 version-bump: changed lastAuditedAt with unchanged auditEvidence fails (coupling)", () => {
  const parent = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a" }], highRiskPaths: [], lastAuditedAt: "2026-05-01", auditEvidence: "https://e/x#1" } };
  const head = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a" }], highRiskPaths: [], lastAuditedAt: "2026-06-01", auditEvidence: "https://e/x#1" } };
  const r = checkSuiteVersionBump(parent, head);
  assert.ok(!r.ok);
  assert.match(r.reason, /auditEvidence did not/);
});

test("§4 version-bump: a coupled audit bump (both lastAuditedAt + auditEvidence) is OK", () => {
  const parent = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a" }], highRiskPaths: [], lastAuditedAt: "2026-05-01", auditEvidence: "https://e/x#1" } };
  const head = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a" }], highRiskPaths: [], lastAuditedAt: "2026-06-01", auditEvidence: "https://e/x#2" } };
  const r = checkSuiteVersionBump(parent, head);
  assert.ok(r.ok);
});

test("§4 version-bump: changing requiredContexts without a version bump fails", () => {
  const parent = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a" }], highRiskPaths: [] } };
  const head = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a" }, { context: "b" }], highRiskPaths: [] } };
  const r = checkSuiteVersionBump(parent, head);
  assert.ok(!r.ok);
  assert.match(r.reason, /did not bump/);
});

test("§4 version-bump: changing a pinned SHA without a version bump fails", () => {
  const parent = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a", pinned: "aaa" }], highRiskPaths: [] } };
  const head = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a", pinned: "bbb" }], highRiskPaths: [] } };
  const r = checkSuiteVersionBump(parent, head);
  assert.ok(!r.ok);
});

test("§4 version-bump: changing highRiskPaths without a version bump fails", () => {
  const parent = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a" }], highRiskPaths: ["**/x/**"] } };
  const head = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a" }], highRiskPaths: ["**/x/**", "**/y/**"] } };
  const r = checkSuiteVersionBump(parent, head);
  assert.ok(!r.ok);
});

test("§4 version-bump: a material change WITH a version bump is OK", () => {
  const parent = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a" }], highRiskPaths: [] } };
  const head = { ok: true, value: { version: "2026.07", requiredContexts: [{ context: "a" }, { context: "b" }], highRiskPaths: [] } };
  const r = checkSuiteVersionBump(parent, head);
  assert.ok(r.ok);
});

test("§4 version-bump: a pure reorder (no material change) needs no bump", () => {
  const parent = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "a" }, { context: "b" }], highRiskPaths: ["**/x/**", "**/y/**"] } };
  const head = { ok: true, value: { version: "2026.06", requiredContexts: [{ context: "b" }, { context: "a" }], highRiskPaths: ["**/y/**", "**/x/**"] } };
  const r = checkSuiteVersionBump(parent, head);
  assert.ok(r.ok);
});

test("§4 version-bump: an unparseable head suite is left to classifyHighRisk (vacuous here)", () => {
  const r = checkSuiteVersionBump({ ok: true, value: {} }, { ok: false, reason: "invalid JSON" });
  assert.ok(r.ok);
});

// =========================================================================
// check 5 / pre-merge: the synthetic GitHub PR merge commit (refs/pull/N/merge)
// is authored by the acting App identity (a known agent) yet carries no
// Assisted-by. The pre-merge range walk must EXCLUDE merge commits (--no-merges)
// so an enforce PR from the dedicated agent identity does not self-trip check 5
// on its own integration merge ref (eng#119 enforce-bootstrap; cinatra#206).
// =========================================================================

function tmpGitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tag-merge-")));
  const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "sandro@cinatra.ai");
  g("config", "user.name", "Sandro Groganz");
  g("config", "core.hooksPath", "/dev/null");
  return { dir, g };
}

test("rangeCommitIdentities/Messages exclude the synthetic PR merge commit (check 5 must not see refs/pull/N/merge)", () => {
  const { dir, g } = tmpGitRepo();
  // base on main
  fs.writeFileSync(path.join(dir, "base.txt"), "base");
  g("add", "-A");
  g("commit", "-q", "-m", "base commit");
  const base = g("rev-parse", "HEAD").stdout.trim();
  // a real branch commit by the agent identity, WITH an Assisted-by (legitimate)
  g("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "feat.txt"), "feat");
  g("add", "-A");
  g(
    "-c", "user.name=cinatra-agent-bot[bot]",
    "-c", "user.email=293224031+cinatra-agent-bot[bot]@users.noreply.github.com",
    "commit", "-q", "-m", "feat: real branch work\n\nAssisted-by: Claude Code (claude-opus-4-8), implementation",
  );
  // simulate GitHub's refs/pull/N/merge: a 2-parent merge commit authored by the
  // acting App identity (cinatra-agent-bot[bot]) with NO trailers.
  g("checkout", "-q", "main");
  const mergeRes = g(
    "-c", "user.name=cinatra-agent-bot[bot]",
    "-c", "user.email=293224031+cinatra-agent-bot[bot]@users.noreply.github.com",
    "merge", "-q", "--no-ff", "feature", "-m", "Merge feature into main",
  );
  assert.equal(mergeRes.status, 0, mergeRes.stderr);

  const ids = rangeCommitIdentities(base, dir);
  const shas = ids.map((i) => i.sha);
  // the real branch commit is present; the synthetic merge commit is excluded.
  const headSha = g("rev-parse", "HEAD").stdout.trim();
  assert.ok(!shas.includes(headSha), `merge commit ${headSha} must be excluded; got ${JSON.stringify(shas)}`);
  assert.equal(ids.length, 1, `only the real branch commit should remain; got ${JSON.stringify(ids)}`);
  assert.ok(ids[0].authorName.includes("cinatra-agent"), "the surviving commit is the agent's real branch commit");

  // and the messages walk likewise excludes the merge commit's message.
  const msgs = rangeCommitMessages(base, dir);
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].includes("Assisted-by:"), "the surviving commit carries its Assisted-by");
  assert.ok(!msgs.some((m) => m.startsWith("Merge feature into main")), "the synthetic merge message is excluded");

  fs.rmSync(dir, { recursive: true, force: true });
});
