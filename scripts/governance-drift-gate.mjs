#!/usr/bin/env node
/**
 * governance-drift-gate — detects drift between a repo's COMMITTED
 * release-governance manifests and the LIVE GitHub config they describe
 * (cinatra-engineering#315).
 *
 * A release-governance closeout audit found four manifest-vs-live drifts that
 * had to be reconciled by hand (cinatra#488). This gate makes that
 * self-policing: it
 * diffs the committed `.github/branch-protections.json` /
 * `.github/tag-protections.json` against the live branch protection, the live
 * tag ruleset, and the org `baseline-protection` ruleset, and fails on any
 * UNEXPLAINED drift. Deliberate live-only values are declared in an allowlist.
 *
 * AUTH / EXECUTION MODEL (see ../README.md and the reusable workflow):
 *   - Reading branch protection needs repo Administration: read; reading org
 *     rulesets (with bypass_actors) needs org Administration. The default
 *     Actions GITHUB_TOKEN cannot do this, so the live read uses an
 *     operator-provisioned fine-grained / App token (GOVERNANCE_DRIFT_READ_TOKEN).
 *   - This is therefore a SCHEDULED / manual job, NOT a required PR status
 *     check (a fork PR has no such token). When the token is ABSENT the gate
 *     SKIPS GREEN (exit 0 + ::notice) so shipping it never reds the schedule
 *     before the owner provisions the token. When the token is PRESENT but the
 *     API returns 401/403 or incomplete ruleset visibility, the gate HARD
 *     FAILS — a privileged read that silently degrades would mask real drift.
 *
 * The diff core (`diffGovernance`) is pure and offline-testable: it takes the
 * committed objects, the live objects, and the allowlist. The live fetch
 * (`fetchLive`, via `gh api`) is a thin wrapper invoked only with `--live`.
 *
 * Zero runtime dependencies (node builtins + the `gh` CLI for `--live`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const GATE_VERSION = "0.1.0";

/* ----------------------------- normalization ----------------------------- */

// Canonicalize for order-insensitive comparison: recurse objects (sorted keys,
// drop _comment), and sort EVERY array set-wise by its canonical JSON. Order is
// not policy here — a required-check context list, a rule list, and a
// bypass-actor list all compare as sets (GitHub returns them in arbitrary
// order), so sorting both sides the same way makes the diff order-immune.
function canonicalize(value) {
  if (Array.isArray(value)) {
    const items = value.map(canonicalize);
    return items
      .map((x) => [JSON.stringify(x), x])
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map((pair) => pair[1]);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "_comment") continue; // prose, not policy
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

// The live `gh api .../branches/main/protection` GET wraps several booleans as
// `{ "enabled": <bool> }` and expresses required checks as `checks:[{context}]`
// instead of `contexts:[...]`. Normalize the live shape into the committed
// PUT-body shape so EVERY field the manifest pins compares apples-to-apples.
// Wrapper keys are the documented booleans GitHub returns as `{enabled}`.
const LIVE_ENABLED_WRAPPERS = new Set([
  "enforce_admins",
  "allow_force_pushes",
  "allow_deletions",
  "required_linear_history",
  "required_conversation_resolution",
  "required_signatures",
  "block_creations",
  "lock_branch",
  "allow_fork_syncing",
]);

function normalizeLiveBranchProtection(live) {
  const out = {};
  for (const [key, val] of Object.entries(live || {})) {
    if (key === "url" || key === "contexts_url" || key === "protection_url") continue; // API hrefs, not policy
    if (LIVE_ENABLED_WRAPPERS.has(key) && val && typeof val === "object" && "enabled" in val) {
      out[key] = val.enabled;
    } else if (key === "required_status_checks" && val && typeof val === "object") {
      const rsc = { strict: val.strict };
      // GET returns checks:[{context,app_id}]; the PUT body uses contexts:[...].
      // Compare contexts (the policy); ignore the API `url`/`contexts_url` hrefs.
      rsc.contexts = val.contexts ?? (Array.isArray(val.checks) ? val.checks.map((c) => c.context) : []);
      if (Array.isArray(val.checks) && val.checks.some((c) => c.app_id != null)) {
        rsc.check_app_ids = val.checks.map((c) => c.app_id ?? null);
      }
      out[key] = rsc;
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Extract the comparable policy facts from a branch-protection object. The
 * committed side is the `gh api -X PUT .../protection` body; the live side is
 * first normalized into that same shape, then BOTH derive facts from the union
 * of pinned keys, so a drift in ANY field the manifest pins is detected — not a
 * hardcoded subset. API-only metadata (`url`, `*_url`) is dropped.
 */
function branchProtectionFacts(side, source) {
  const obj = source === "live" ? normalizeLiveBranchProtection(side) : side;
  const facts = {};
  for (const [key, val] of Object.entries(obj || {})) {
    if (key === "_comment" || key === "url" || key.endsWith("_url")) continue;
    facts[key] = val;
  }
  return canonicalize(facts);
}

/**
 * Extract comparable facts from a ruleset (tag protection or org baseline).
 * Committed shape and live `gh api .../rulesets/<id>` response are close; we pin
 * target, enforcement, the ref conditions, the FULL rule objects (type AND
 * parameters — a drift inside `parameters` is real governance drift), and the
 * bypass actors. API-only metadata (`id`, `node_id`, `_links`, timestamps,
 * `source*`, `current_user_can_bypass`) is dropped.
 */
const RULESET_DROP_KEYS = new Set([
  "id", "node_id", "_links", "created_at", "updated_at",
  "source", "source_type", "current_user_can_bypass",
]);

function rulesetFacts(side) {
  const facts = {};
  facts.target = side.target ?? null;
  facts.enforcement = side.enforcement ?? null;
  facts.conditions = side.conditions ?? null;
  // Keep the FULL rule object (type + parameters) so parameter drift is caught.
  facts.rules = (side.rules || []).map((r) => {
    const rule = {};
    for (const [k, v] of Object.entries(r)) {
      if (RULESET_DROP_KEYS.has(k)) continue;
      rule[k] = v;
    }
    return rule;
  });
  facts.bypass_actors = (side.bypass_actors || []).map((b) => ({
    actor_id: b.actor_id ?? null,
    actor_type: b.actor_type ?? null,
    bypass_mode: b.bypass_mode ?? null,
  }));
  return canonicalize(facts);
}

/* -------------------------------- diffing -------------------------------- */

// Deep-diff that walks ONLY the keys the COMMITTED side pins: the committed
// manifest is the contract for WHAT is enforced, so a live-only field the
// manifest does not pin (e.g. a GET-only `require_last_push_approval`) is not a
// drift, while every field the manifest DOES pin — at any depth — is compared.
// Nested objects recurse key-by-key; arrays + scalars compare whole (already
// canonicalized set-wise). An allowlisted TOP-LEVEL field is suppressed.
function diffFacts(committed, live, label, allowKeys) {
  const drifts = [];
  const walk = (cNode, lNode, fieldPath, topKey) => {
    if (allowKeys.has(topKey)) return;
    const cIsObj = cNode && typeof cNode === "object" && !Array.isArray(cNode);
    const lIsObj = lNode && typeof lNode === "object" && !Array.isArray(lNode);
    if (cIsObj && lIsObj) {
      for (const key of Object.keys(cNode).sort()) {
        walk(cNode[key], lNode[key], fieldPath ? `${fieldPath}.${key}` : key, topKey);
      }
      return;
    }
    // Normalize undefined -> null so a committed `field: null` matches a live
    // response that simply omits that field (both mean "not set").
    const c = JSON.stringify(cNode ?? null);
    const l = JSON.stringify(lNode ?? null);
    if (c !== l) {
      drifts.push({ scope: label, field: fieldPath, committed: cNode ?? null, live: lNode ?? null });
    }
  };
  for (const key of Object.keys(committed).sort()) {
    walk(committed[key], (live || {})[key], key, key);
  }
  return drifts;
}

/**
 * Pure diff core. Inputs:
 *   committed: { branchProtection, tagRuleset, baselineRuleset? }  (committed JSON objects)
 *   live:      { branchProtection, tagRuleset, baselineRuleset? }  (live API responses)
 *   allowlist: { branchProtection?: string[], tagRuleset?: string[], baselineRuleset?: string[] }
 * Any side that is `null`/absent on BOTH committed and live is skipped; a side
 * present on exactly one is itself a drift (presence drift).
 */
function diffGovernance({ committed, live, allowlist = {} }) {
  const drifts = [];

  const cmp = (cKey, lKey, label, factsFn, srcFn) => {
    const cVal = committed[cKey];
    const lVal = live[lKey];
    if (cVal == null && lVal == null) return;
    if (cVal == null || lVal == null) {
      drifts.push({
        scope: label,
        field: "<presence>",
        committed: cVal == null ? null : "present",
        live: lVal == null ? null : "present",
      });
      return;
    }
    const allow = new Set(allowlist[label] || []);
    const cFacts = factsFn(cVal, "committed");
    const lFacts = factsFn(lVal, "live");
    drifts.push(...diffFacts(cFacts, lFacts, label, allow));
  };

  cmp("branchProtection", "branchProtection", "branchProtection", branchProtectionFacts);
  cmp("tagRuleset", "tagRuleset", "tagRuleset", (s) => rulesetFacts(s));
  cmp("baselineRuleset", "baselineRuleset", "baselineRuleset", (s) => rulesetFacts(s));

  return { ok: drifts.length === 0, drifts };
}

function reportDrifts(drifts) {
  const lines = [];
  for (const d of drifts) {
    lines.push(
      `  - [${d.scope}] ${d.field}:\n` +
        `      committed: ${JSON.stringify(d.committed)}\n` +
        `      live:      ${JSON.stringify(d.live)}`
    );
  }
  return lines.join("\n");
}

/* ------------------------------ live fetch ------------------------------ */

function ghApi(endpoint, token) {
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  const res = spawnSync("gh", ["api", endpoint, "-H", "Accept: application/vnd.github+json"], {
    encoding: "utf8",
    env,
  });
  if (res.status !== 0) {
    const err = (res.stderr || "").trim();
    return { ok: false, error: `gh api ${endpoint} failed (exit ${res.status}): ${err}` };
  }
  try {
    return { ok: true, data: JSON.parse(res.stdout) };
  } catch (e) {
    return { ok: false, error: `gh api ${endpoint} returned unparseable JSON: ${e.message}` };
  }
}

/**
 * Fetch live state. Returns { ok, live, errors }.
 * repo: "owner/name". org: "owner". tagRulesetName / baselineRulesetName name
 * the rulesets to resolve by name.
 */
function fetchLive({ repo, org, tagRulesetName, baselineRulesetName, token }) {
  const errors = [];
  const live = { branchProtection: null, tagRuleset: null, baselineRuleset: null };

  const bp = ghApi(`repos/${repo}/branches/main/protection`, token);
  if (!bp.ok) errors.push(bp.error);
  else live.branchProtection = bp.data;

  // Repo rulesets: list, find the tag ruleset by name, then GET it (the list
  // form omits rules/bypass_actors).
  const repoRules = ghApi(`repos/${repo}/rulesets`, token);
  if (!repoRules.ok) {
    errors.push(repoRules.error);
  } else if (tagRulesetName) {
    const match = (repoRules.data || []).find((r) => r.name === tagRulesetName);
    if (!match) {
      errors.push(`repo ruleset named ${JSON.stringify(tagRulesetName)} not found on ${repo}`);
    } else {
      const full = ghApi(`repos/${repo}/rulesets/${match.id}`, token);
      if (!full.ok) errors.push(full.error);
      else live.tagRuleset = full.data;
    }
  }

  if (baselineRulesetName) {
    const orgRules = ghApi(`orgs/${org}/rulesets`, token);
    if (!orgRules.ok) {
      errors.push(orgRules.error);
    } else {
      const match = (orgRules.data || []).find((r) => r.name === baselineRulesetName);
      if (!match) {
        errors.push(`org ruleset named ${JSON.stringify(baselineRulesetName)} not found on ${org}`);
      } else {
        const full = ghApi(`orgs/${org}/rulesets/${match.id}`, token);
        if (!full.ok) errors.push(full.error);
        else live.baselineRuleset = full.data;
      }
    }
  }

  return { ok: errors.length === 0, live, errors };
}

/* --------------------------------- CLI --------------------------------- */

const VALUE_FLAGS = new Set([
  "root", "repo", "org", "branch-protections", "tag-protections", "baseline-protections",
  "allowlist", "tag-ruleset-name", "baseline-ruleset-name", "token-env", "live-json",
]);
const BOOLEAN_FLAGS = new Set(["live", "quiet"]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) return fail(`unexpected argument: ${tok}`);
    const eq = tok.indexOf("=");
    const key = eq !== -1 ? tok.slice(2, eq) : tok.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq !== -1) return fail(`--${key} takes no value`);
      args[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      const value = eq !== -1 ? tok.slice(eq + 1) : argv[++i];
      if (value === undefined || value.trim() === "" || (eq === -1 && value.startsWith("--"))) {
        return fail(`--${key} requires a value`);
      }
      args[key] = value;
    } else {
      return fail(`unknown flag --${key}`);
    }
  }
  return args;
}

function fail(msg) {
  console.error(`[governance-drift-gate] ${msg}`);
  process.exit(2);
}

function readJson(file, optional = false) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") delete obj._comment;
    return obj;
  } catch (e) {
    if (optional && e.code === "ENOENT") return null;
    fail(`cannot read/parse ${file}: ${e.message}`);
  }
}

function loadAllowlist(file) {
  if (!file) return {};
  const obj = readJson(file, true);
  if (!obj) return {};
  // Accept either { allow: {scope: [keys]} } or { scope: [keys] } directly.
  return obj.allow && typeof obj.allow === "object" ? obj.allow : obj;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = "root" in args ? path.resolve(args.root) : process.cwd();
  const quiet = Boolean(args.quiet);

  const bpFile = path.resolve(root, args["branch-protections"] || path.join(".github", "branch-protections.json"));
  const tpFile = path.resolve(root, args["tag-protections"] || path.join(".github", "tag-protections.json"));
  const blFile = path.resolve(root, args["baseline-protections"] || path.join(".github", "baseline-protection.json"));
  const allowFile = args.allowlist ? path.resolve(root, args.allowlist) : path.resolve(root, ".github", "governance-drift-allowlist.json");

  const committed = {
    branchProtection: readJson(bpFile),
    tagRuleset: readJson(tpFile),
    // The committed org-baseline snapshot is OPTIONAL: a repo that wants the
    // org `baseline-protection` ruleset diffed commits a .github/
    // baseline-protection.json snapshot. Absent => the baseline is not compared
    // (the org owns it centrally); present => it is diffed against live.
    baselineRuleset: readJson(blFile, true),
  };
  const allowlist = loadAllowlist(fs.existsSync(allowFile) ? allowFile : null);

  let live;
  if (args["live-json"]) {
    // Test / dry-run hook: read the live side from a JSON file instead of the API.
    live = readJson(path.resolve(root, args["live-json"]));
  } else if (args.live) {
    const repo = args.repo;
    const org = args.org || (repo ? repo.split("/")[0] : null);
    if (!repo) fail("--live requires --repo owner/name");
    const tokenEnv = args["token-env"] || "GOVERNANCE_DRIFT_READ_TOKEN";
    const token = process.env[tokenEnv];
    if (!token) {
      // GREEN SKIP: the gate ships before the operator provisions the token.
      const msg =
        `governance-drift-gate: not configured — ${tokenEnv} is unset; ` +
        `skipping live drift detection (provision a fine-grained/App token with ` +
        `repo Administration:read + org Administration to arm this gate).`;
      if (process.env.GITHUB_ACTIONS) process.stdout.write(`::notice::${msg}\n`);
      if (!quiet) process.stderr.write(msg + "\n");
      process.exit(0);
    }
    // Fetch the org baseline ruleset only when a committed snapshot exists to
    // compare it against (no snapshot => the org owns the baseline centrally).
    const baselineRulesetName = committed.baselineRuleset
      ? args["baseline-ruleset-name"] || committed.baselineRuleset.name || "baseline-protection"
      : null;
    const fetched = fetchLive({
      repo,
      org,
      tagRulesetName: args["tag-ruleset-name"] || (committed.tagRuleset && committed.tagRuleset.name) || null,
      baselineRulesetName,
      token,
    });
    if (!fetched.ok) {
      // HARD FAIL: a privileged read that degraded must not mask drift.
      process.stderr.write("governance-drift-gate: FAIL — live read incomplete:\n");
      for (const e of fetched.errors) process.stderr.write(`  - ${e}\n`);
      process.exit(1);
    }
    live = fetched.live;
  } else {
    fail("provide --live (with --repo) or --live-json <file>");
  }

  const { ok, drifts } = diffGovernance({ committed, live, allowlist });

  if (ok) {
    if (!quiet) process.stderr.write("governance-drift-gate: clean (committed manifests match live state).\n");
    process.exit(0);
  }
  process.stderr.write(
    "governance-drift-gate: FAIL — committed release-governance manifests drifted from live state:\n" +
      reportDrifts(drifts) +
      "\n  Reconcile the .github/*.json manifests (or the live config), or add a deliberate\n" +
      "  live-only value to .github/governance-drift-allowlist.json with a rationale.\n"
  );
  process.exit(1);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isMainModule()) {
  try { main(); }
  catch (e) { console.error("[governance-drift-gate] gate failed:", e.message); process.exit(2); }
}

export {
  canonicalize,
  branchProtectionFacts,
  rulesetFacts,
  diffFacts,
  diffGovernance,
  reportDrifts,
  fetchLive,
};
