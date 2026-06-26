import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalize,
  branchProtectionFacts,
  rulesetFacts,
  diffGovernance,
} from "../governance-drift-gate.mjs";

const GATE = path.join(import.meta.dirname, "..", "governance-drift-gate.mjs");

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gdg-")));
}
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function runGate(extraArgs, opts = {}) {
  return spawnSync("node", [GATE, ...extraArgs], { encoding: "utf8", ...opts });
}

/* committed branch-protections.json shape (the PUT body) */
const COMMITTED_BP = {
  _comment: ["prose ignored"],
  required_status_checks: { strict: true, contexts: ["build", "proof"] },
  enforce_admins: false,
  required_pull_request_reviews: {
    required_approving_review_count: 0,
    require_code_owner_reviews: true,
    dismiss_stale_reviews: true,
  },
  allow_force_pushes: false,
  allow_deletions: false,
  required_linear_history: false,
  required_conversation_resolution: true,
};

/* live GET response shape (different — nested {enabled} + checks[]) */
const LIVE_BP_MATCH = {
  required_status_checks: { strict: true, checks: [{ context: "proof" }, { context: "build" }] },
  enforce_admins: { enabled: false },
  required_pull_request_reviews: {
    required_approving_review_count: 0,
    require_code_owner_reviews: true,
    dismiss_stale_reviews: true,
  },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  required_linear_history: { enabled: false },
  required_conversation_resolution: { enabled: true },
};

const COMMITTED_TAG = {
  _comment: ["prose"],
  name: "Release tag protection (v*)",
  target: "tag",
  enforcement: "active",
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
  conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
  rules: [{ type: "creation" }, { type: "deletion" }, { type: "non_fast_forward" }],
};

const LIVE_TAG_MATCH = {
  id: 99,
  name: "Release tag protection (v*)",
  target: "tag",
  enforcement: "active",
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
  conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
  rules: [{ type: "non_fast_forward" }, { type: "creation" }, { type: "deletion" }],
};

/* ------------------------------ normalization ------------------------------ */

test("canonicalize sorts scalar arrays, drops _comment, recurses objects", () => {
  const out = canonicalize({ _comment: "x", b: [3, 1, 2], a: { z: 1, y: 2 } });
  assert.deepEqual(out, { a: { y: 2, z: 1 }, b: [1, 2, 3] });
});

test("branchProtectionFacts maps committed-PUT and live-GET shapes to the same facts", () => {
  const c = branchProtectionFacts(COMMITTED_BP, "committed");
  const l = branchProtectionFacts(LIVE_BP_MATCH, "live");
  assert.deepEqual(c, l, "matching policy should normalize to identical facts");
});

test("rulesetFacts is order-insensitive for rules + bypass actors", () => {
  assert.deepEqual(rulesetFacts(COMMITTED_TAG), rulesetFacts(LIVE_TAG_MATCH));
});

/* -------------------------------- diffGovernance -------------------------------- */

test("diffGovernance: matching committed vs live is clean", () => {
  const r = diffGovernance({
    committed: { branchProtection: COMMITTED_BP, tagRuleset: COMMITTED_TAG },
    live: { branchProtection: LIVE_BP_MATCH, tagRuleset: LIVE_TAG_MATCH },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.drifts, []);
});

test("diffGovernance: a drifted required-check context is flagged (nested field path)", () => {
  const liveDrift = JSON.parse(JSON.stringify(LIVE_BP_MATCH));
  liveDrift.required_status_checks.checks = [{ context: "build" }]; // 'proof' removed live
  const r = diffGovernance({
    committed: { branchProtection: COMMITTED_BP, tagRuleset: COMMITTED_TAG },
    live: { branchProtection: liveDrift, tagRuleset: LIVE_TAG_MATCH },
  });
  assert.equal(r.ok, false);
  const ctx = r.drifts.find((d) => d.field === "required_status_checks.contexts");
  assert.ok(ctx, "should flag a required_status_checks.contexts drift");
  assert.equal(ctx.scope, "branchProtection");
});

test("diffGovernance: a live-only branch-protection field the manifest does NOT pin is ignored", () => {
  const liveExtra = JSON.parse(JSON.stringify(LIVE_BP_MATCH));
  // The manifest pins no `require_last_push_approval`; a live-only value must
  // not be reported as drift (only PINNED fields are compared).
  liveExtra.required_pull_request_reviews.require_last_push_approval = true;
  const r = diffGovernance({
    committed: { branchProtection: COMMITTED_BP, tagRuleset: COMMITTED_TAG },
    live: { branchProtection: liveExtra, tagRuleset: LIVE_TAG_MATCH },
  });
  assert.equal(r.ok, true, "an unpinned live-only field is not drift");
});

test("diffGovernance: ruleset PARAMETER drift (not just rule type) is flagged", () => {
  const cTag = JSON.parse(JSON.stringify(COMMITTED_TAG));
  cTag.rules = [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true } }];
  const lTag = JSON.parse(JSON.stringify(LIVE_TAG_MATCH));
  lTag.rules = [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false } }];
  const r = diffGovernance({
    committed: { branchProtection: COMMITTED_BP, tagRuleset: cTag },
    live: { branchProtection: LIVE_BP_MATCH, tagRuleset: lTag },
  });
  assert.equal(r.ok, false, "a drift INSIDE rule parameters must be caught, not just the rule type");
  assert.ok(r.drifts.find((d) => d.scope === "tagRuleset" && d.field === "rules"));
});

test("diffGovernance: a drifted tag bypass actor is flagged", () => {
  const liveDrift = JSON.parse(JSON.stringify(LIVE_TAG_MATCH));
  liveDrift.bypass_actors.push({ actor_id: 1234, actor_type: "Team", bypass_mode: "always" });
  const r = diffGovernance({
    committed: { branchProtection: COMMITTED_BP, tagRuleset: COMMITTED_TAG },
    live: { branchProtection: LIVE_BP_MATCH, tagRuleset: liveDrift },
  });
  assert.equal(r.ok, false);
  assert.ok(r.drifts.find((d) => d.scope === "tagRuleset" && d.field === "bypass_actors"));
});

test("diffGovernance: an allowlisted top-level field is suppressed", () => {
  const liveDrift = JSON.parse(JSON.stringify(LIVE_BP_MATCH));
  liveDrift.required_status_checks.checks = [{ context: "build" }];
  const r = diffGovernance({
    committed: { branchProtection: COMMITTED_BP, tagRuleset: COMMITTED_TAG },
    live: { branchProtection: liveDrift, tagRuleset: LIVE_TAG_MATCH },
    allowlist: { branchProtection: ["required_status_checks"] },
  });
  assert.equal(r.ok, true, "an allowlisted top-level field (and its nested drift) should be suppressed");
});

test("diffGovernance: presence drift (committed baseline snapshot, live missing) is flagged", () => {
  const r = diffGovernance({
    committed: { branchProtection: COMMITTED_BP, tagRuleset: COMMITTED_TAG, baselineRuleset: COMMITTED_TAG },
    live: { branchProtection: LIVE_BP_MATCH, tagRuleset: LIVE_TAG_MATCH, baselineRuleset: null },
  });
  assert.equal(r.ok, false);
  assert.ok(r.drifts.find((d) => d.scope === "baselineRuleset" && d.field === "<presence>"));
});

/* ------------------------------ CLI via --live-json ------------------------------ */

function scaffoldRepo({ live }) {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, ".github"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github", "branch-protections.json"), JSON.stringify(COMMITTED_BP));
  fs.writeFileSync(path.join(root, ".github", "tag-protections.json"), JSON.stringify(COMMITTED_TAG));
  fs.writeFileSync(path.join(root, "live.json"), JSON.stringify(live));
  return root;
}

test("CLI --live-json: clean when live matches committed (exit 0)", () => {
  const root = scaffoldRepo({ live: { branchProtection: LIVE_BP_MATCH, tagRuleset: LIVE_TAG_MATCH } });
  try {
    const res = runGate(["--root", root, "--live-json", "live.json", "--quiet"]);
    assert.equal(res.status, 0);
  } finally { rm(root); }
});

test("CLI --live-json: drift fails (exit 1) and prints the diff", () => {
  const liveDrift = JSON.parse(JSON.stringify(LIVE_BP_MATCH));
  liveDrift.allow_force_pushes = { enabled: true }; // live weakened vs committed false
  const root = scaffoldRepo({ live: { branchProtection: liveDrift, tagRuleset: LIVE_TAG_MATCH } });
  try {
    const res = runGate(["--root", root, "--live-json", "live.json"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /allow_force_pushes/);
  } finally { rm(root); }
});

test("CLI --live: missing token => GREEN SKIP (exit 0, notice)", () => {
  const root = scaffoldRepo({ live: { branchProtection: LIVE_BP_MATCH, tagRuleset: LIVE_TAG_MATCH } });
  try {
    const env = { ...process.env };
    delete env.GOVERNANCE_DRIFT_READ_TOKEN;
    const res = runGate(["--root", root, "--live", "--repo", "cinatra-ai/cinatra"], { env });
    assert.equal(res.status, 0, "an unconfigured token must skip green, not red");
    assert.match(res.stderr, /not configured/);
  } finally { rm(root); }
});

test("CLI: neither --live nor --live-json fails loud (exit 2)", () => {
  const root = scaffoldRepo({ live: {} });
  try {
    assert.equal(runGate(["--root", root]).status, 2);
  } finally { rm(root); }
});

test("CLI: unknown flag fails loud (exit 2)", () => {
  assert.equal(runGate(["--bogus"]).status, 2);
});
