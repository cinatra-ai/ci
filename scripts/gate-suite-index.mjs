#!/usr/bin/env node
/**
 * gate-suite-index — generate the org-wide, read-only gate-suite audit index.
 *
 * Ratified spec: cinatra-engineering#119 §4. The per-repo committed
 * `.github/gate-suite.json` is AUTHORITATIVE for enforcement (the
 * truthful-attribution-gate reads it at the merged SHA — no TOCTOU against a
 * remote registry). This index is the OTHER half of the §4 hybrid: a GENERATED,
 * READ-ONLY map of every inventoried repo's current suite, for ORG-WIDE
 * AUDITABILITY only. The monthly audit (§4) regenerates it; nothing reads it at
 * merge time, so it can never weaken enforcement — it is a reporting artifact.
 *
 * TRUTHFULNESS (codex round-1 MEDIUM): an empty/partial index is only honest if
 * the repo inventory it scanned is EXPLICIT. This generator scans a DECLARED
 * inventory (config/gate-suite-inventory.json — the repos expected to carry a
 * suite, with each repo's expected default branch) and records, per repo,
 * whether a committed suite was FOUND, its id@version + accountable + audit
 * fields, or that NONE was discovered. "repos: []" never means "nothing to
 * audit" — it means "no inventoried repo has committed a suite yet", and the
 * inventory it checked is named in `inventory`.
 *
 * DETERMINISM (codex round-1 MEDIUM/LOW): output is sorted by repo and the
 * `generatedAt` timestamp is injectable (--generated-at / GATE_SUITE_INDEX_NOW)
 * so a CI check can regenerate and byte-compare to detect drift — a committed
 * index that disagrees with a fresh scan fails the self-check.
 *
 * Modes:
 *   --check   regenerate from live repo state and DIFF against the committed
 *             config/gate-suite-index.json; exit 1 on drift (used by self-check
 *             / the monthly audit, not at merge time).
 *   (default) write the regenerated index to config/gate-suite-index.json.
 *
 * The GitHub reader is injectable so this is unit-testable offline.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(HERE, "..", "config");
const INVENTORY_PATH = path.join(CONFIG_DIR, "gate-suite-inventory.json");
const INDEX_PATH = path.join(CONFIG_DIR, "gate-suite-index.json");

export const INDEX_SCHEMA_VERSION = 1;

function ghApiRaw(endpoint, jq) {
  const args = ["api", endpoint];
  if (jq) args.push("--jq", jq);
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Default reader: fetch a repo's .github/gate-suite.json at a ref via gh api.
 * DISTINGUISHES a genuine `not-found` (repo+ref accessible, no suite committed)
 * from an OPERATIONAL failure (auth/rate-limit/5xx/missing gh, OR a private/
 * inaccessible repo / bad ref) — collapsing them would let a broken or
 * unauthorized scan report "no-suite" and falsely match the committed index
 * (codex round-2/round-3 MEDIUM). A content 404 alone is ambiguous, so on a
 * content 404 we PROBE the repo+ref: only if the ref resolves (repo accessible)
 * is the 404 a genuine `not-found`; otherwise it is `operational`.
 * @param exec injectable runner (default `ghApiRaw`) for offline tests.
 */
export function ghReader(repo, ref, exec = ghApiRaw) {
  let raw;
  try {
    raw = exec(`/repos/${repo}/contents/.github/gate-suite.json?ref=${encodeURIComponent(ref)}`, ".content");
  } catch (e) {
    const stderr = String(e.stderr || e.message || "");
    if (!/HTTP 404|Not Found/i.test(stderr)) {
      return { ok: false, reason: `operational: ${stderr.split("\n")[0].slice(0, 200)}`, operational: true };
    }
    // Content 404 — probe repo+ref accessibility before trusting "no suite".
    try {
      exec(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, ".sha");
      return { ok: false, reason: "not-found" }; // ref resolves => genuinely no suite
    } catch (probe) {
      const ps = String(probe.stderr || probe.message || "");
      return { ok: false, reason: `operational: repo/ref not accessible (${ps.split("\n")[0].slice(0, 160)})`, operational: true };
    }
  }
  try {
    const decoded = Buffer.from(raw.replace(/\n/g, ""), "base64").toString("utf8");
    return { ok: true, value: JSON.parse(decoded) };
  } catch (e) {
    return { ok: false, reason: `invalid: ${e.message}`, operational: true };
  }
}
const defaultReader = ghReader;

/**
 * Build the index object from an inventory + a reader. Pure given the reader.
 * @param inventory { repos: [{ repo, defaultBranch }] }
 * @param reader    (repo, ref) => { ok, value } | { ok:false, reason }
 * @param now       ISO string for generatedAt (deterministic in tests)
 */
export function buildIndex(inventory, reader, now) {
  const repos = [];
  const inRepos = Array.isArray(inventory?.repos) ? inventory.repos : [];
  // Sort the inventory by repo so the output is deterministic regardless of
  // inventory order.
  const sorted = [...inRepos].sort((a, b) => (String(a.repo) < String(b.repo) ? -1 : String(a.repo) > String(b.repo) ? 1 : 0));
  for (const entry of sorted) {
    const repo = String(entry.repo);
    const ref = String(entry.defaultBranch || "main");
    const r = reader(repo, ref);
    if (!r.ok) {
      repos.push({ repo, ref, suite: null, status: r.reason === "not-found" ? "no-suite" : "unreadable", detail: r.reason });
      continue;
    }
    const s = r.value || {};
    repos.push({
      repo,
      ref,
      status: "present",
      suite: {
        suiteId: s.suiteId ?? null,
        version: s.version ?? null,
        accountable: s.accountable
          ? { github: s.accountable.github ?? null, name: s.accountable.name ?? null, email: s.accountable.email ?? null }
          : null,
        requiredContextCount: Array.isArray(s.requiredContexts) ? s.requiredContexts.length : null,
        highRiskPathCount: Array.isArray(s.highRiskPaths) ? s.highRiskPaths.length : null,
        lastAuditedAt: s.lastAuditedAt ?? null,
        auditEvidence: s.auditEvidence ?? null,
      },
    });
  }
  return {
    $comment:
      "GENERATED, READ-ONLY org-wide gate-suite audit index (cinatra-engineering#119 §4). " +
      "Authoritative enforcement lives in each repo's committed .github/gate-suite.json (read by the truthful-attribution-gate at the merged SHA). " +
      "This index is regenerated by `node scripts/gate-suite-index.mjs` from config/gate-suite-inventory.json during the monthly audit; nothing reads it at merge time. " +
      "Do NOT hand-edit — run the generator. A CI self-check regenerates and byte-compares (`--check`) to catch drift. " +
      "`repos: []` means no inventoried repo has committed a suite yet (the inventory scanned is named in `inventory`), NOT that there is nothing to audit.",
    schemaVersion: INDEX_SCHEMA_VERSION,
    generatedAt: now,
    inventory: "config/gate-suite-inventory.json",
    auditObligation: {
      cadence: "monthly",
      accountableRecordedPerRepo: "each repo's .github/gate-suite.json accountable{github,name,email}",
      sampleRule: "10% of eligible gate-arm merges since the last audit, min 5, capped at all eligible",
      evidence: "closing comment on a recurring `Gate-suite audit YYYY-MM` issue in cinatra-engineering",
      bumpRule: "the same commit that updates lastAuditedAt must update auditEvidence (gate-checked at the version-bump rule)",
      staleness: "the truthful-attribution-gate WARNS gate-arm merges when lastAuditedAt > 35 days and FAILS them when > 65 days; human-arm (tier=maintainer Reviewed-by) merges stay possible",
    },
    repos,
  };
}

export function loadJson(p) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(p, "utf8")) }; }
  catch (e) { return { ok: false, reason: e.message }; }
}

/** Stable 2-space JSON with a trailing newline (matches the committed file). */
export function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  let now = process.env.GATE_SUITE_INDEX_NOW || null;
  const gaIdx = argv.indexOf("--generated-at");
  if (gaIdx !== -1 && argv[gaIdx + 1]) now = argv[gaIdx + 1];

  const inv = loadJson(INVENTORY_PATH);
  if (!inv.ok) { console.error(`[gate-suite-index] cannot read inventory ${INVENTORY_PATH}: ${inv.reason}`); process.exit(2); }

  // In --check mode without an explicit timestamp, reuse the committed index's
  // generatedAt so the comparison isolates SUITE drift from clock drift.
  if (check && !now) {
    const committed = loadJson(INDEX_PATH);
    now = (committed.ok && committed.value.generatedAt) || new Date().toISOString();
  }
  if (!now) now = new Date().toISOString();

  const index = buildIndex(inv.value, defaultReader, now);
  const out = serialize(index);

  if (check) {
    const committed = (() => { try { return fs.readFileSync(INDEX_PATH, "utf8"); } catch { return null; } })();
    if (committed === out) { console.error("[gate-suite-index] index is up to date."); process.exit(0); }
    console.error("[gate-suite-index] DRIFT: committed config/gate-suite-index.json does not match a fresh scan. Run `node scripts/gate-suite-index.mjs` and commit.");
    process.exit(1);
  }
  fs.writeFileSync(INDEX_PATH, out);
  console.error(`[gate-suite-index] wrote ${INDEX_PATH} (${index.repos.length} inventoried repo(s)).`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); }
  catch { return false; }
}
if (isMainModule()) {
  try { main(); }
  catch (e) { console.error("[gate-suite-index] failed:", e.message); process.exit(2); }
}
