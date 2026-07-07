#!/usr/bin/env node
/**
 * gate-suite-audit-report — monthly staleness sweep across the inventoried
 * gate suites (the Truthful Attribution protocol §4). Surfaces every repo whose audit is
 * going stale (> 35d) or lapsed (> 65d, gate-arm merges blocked) BEFORE a PR
 * discovers it — the watchdog half of the §4 staleness mechanics.
 *
 * It reports; it does not mutate any gate-suite.json or the audit issue (the
 * Accountable human does that). Output: a GitHub step summary table + stderr.
 * Exit 0 (reporting); a repo whose suite is unreadable is reported, not fatal.
 * The reader is injectable for offline tests.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAuditStaleness } from "./truthful-attribution-gate.mjs";
import { ghReader } from "./gate-suite-index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY_PATH = path.join(HERE, "..", "config", "gate-suite-inventory.json");

// Shared reader: a genuine 404 => not-found; auth/rate-limit/5xx/missing gh =>
// operational (so a broken live scan reports `unreadable`, never a false fresh).
const defaultReader = ghReader;

/**
 * Build the staleness rows. Pure given the reader. Returns
 * { rows:[{repo,ref,state,detail}], stale, lapsed } where state ∈
 * { fresh, no-suite, going-stale, lapsed, no-audit-record, unreadable }.
 */
export function sweep(inventory, reader, now = Date.now()) {
  const rows = [];
  let stale = 0, lapsed = 0;
  for (const e of (inventory?.repos || [])) {
    const repo = String(e.repo);
    const ref = String(e.defaultBranch || "main");
    const r = reader(repo, ref);
    if (!r.ok) {
      rows.push({ repo, ref, state: r.reason === "not-found" ? "no-suite" : "unreadable", detail: r.reason });
      continue;
    }
    // §4 audit-record validity: a fresh date is not enough — auditEvidence must
    // be a non-empty STRING pointer (mirrors the gate-arm verification floor), so
    // the watchdog catches a missing/invalid evidence record before a PR does
    // (codex round-3 LOW).
    const ev = r.value?.auditEvidence;
    if (typeof ev !== "string" || ev.trim() === "") {
      rows.push({ repo, ref, state: "no-audit-record", detail: `auditEvidence missing/invalid (must be a non-empty string URL) — gate-arm verification will fail closed` });
      lapsed++;
      continue;
    }
    const s = checkAuditStaleness(r.value?.lastAuditedAt, now);
    if (s.fail && /no lastAuditedAt|not a valid date|FUTURE/.test(s.message)) {
      rows.push({ repo, ref, state: "no-audit-record", detail: s.message });
      lapsed++;
    } else if (s.fail) {
      rows.push({ repo, ref, state: "lapsed", detail: s.message });
      lapsed++;
    } else if (s.warn) {
      rows.push({ repo, ref, state: "going-stale", detail: s.message });
      stale++;
    } else {
      rows.push({ repo, ref, state: "fresh", detail: `lastAuditedAt=${r.value?.lastAuditedAt}` });
    }
  }
  return { rows, stale, lapsed };
}

function main() {
  let inv;
  try { inv = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8")); }
  catch (e) { console.error(`[gate-suite-audit-report] cannot read inventory: ${e.message}`); process.exit(2); }

  const { rows, stale, lapsed } = sweep(inv, defaultReader, Date.now());

  const lines = ["## Gate-suite staleness sweep (§4)", "",
    `Inventoried repos: ${rows.length} · going-stale (>35d): ${stale} · lapsed/no-record (>65d, gate-arm blocked): ${lapsed}`,
    "", "| Repo | Ref | State | Detail |", "| --- | --- | --- | --- |"];
  for (const r of rows) lines.push(`| ${r.repo} | ${r.ref} | ${r.state} | ${String(r.detail).replace(/\|/g, "\\|")} |`);
  lines.push("", "_The Accountable engineer must re-audit a going-stale/lapsed suite and bump lastAuditedAt + auditEvidence (evidence on the recurring `Gate-suite audit YYYY-MM` issue in cinatra-engineering). A lapsed audit blocks the GATE ARM only — a tier=maintainer human Reviewed-by still merges._");

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) { try { fs.appendFileSync(summaryFile, lines.join("\n") + "\n"); } catch { /* non-fatal */ } }
  for (const r of rows) process.stderr.write(`  [${r.state}] ${r.repo}@${r.ref} — ${r.detail}\n`);
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const r of rows) {
      if (r.state === "going-stale") process.stdout.write(`::warning::gate-suite audit going stale: ${r.repo} — ${r.detail}\n`);
      if (r.state === "lapsed" || r.state === "no-audit-record") process.stdout.write(`::warning::gate-suite audit lapsed (gate-arm blocked): ${r.repo} — ${r.detail}\n`);
    }
  }
  // Reporting job: surface, never block the schedule.
  process.exit(0);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); }
  catch { return false; }
}
if (isMainModule()) {
  try { main(); }
  catch (e) { console.error("[gate-suite-audit-report] failed:", e.message); process.exit(2); }
}
