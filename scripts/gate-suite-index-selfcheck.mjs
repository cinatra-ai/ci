#!/usr/bin/env node
/**
 * gate-suite-index-selfcheck — OFFLINE structural check of the committed
 * org-wide gate-suite audit index (cinatra-engineering#119 §4), for the
 * hermetic self-check (no GitHub token).
 *
 * This does NOT do the live drift scan (a fresh read of every inventoried
 * repo's real .github/gate-suite.json — that needs auth and runs in the monthly
 * Gate-suite audit job via `gate-suite-index.mjs --check`). It verifies the
 * committed artifacts are internally consistent and that "generated/read-only"
 * is mechanically true, not just asserted in a comment:
 *  - both config files parse;
 *  - the index points at the inventory it claims to scan;
 *  - every inventoried repo appears in the index (none silently omitted);
 *  - every index repo is one of the inventoried repos (no fabricated rows);
 *  - re-serializing the committed index (key order + 2-space + trailing NL) is
 *    byte-identical to the file on disk — i.e. the file is in generator
 *    canonical form (a hand-edit that reorders/reformats is caught here).
 *
 * Exit 0 clean, 1 on any inconsistency.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "./gate-suite-index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(HERE, "..", "config");
const INVENTORY_PATH = path.join(CONFIG_DIR, "gate-suite-inventory.json");
const INDEX_PATH = path.join(CONFIG_DIR, "gate-suite-index.json");

function fail(msg) { console.error(`[gate-suite-index-selfcheck] FAIL: ${msg}`); process.exit(1); }

function readJson(p) {
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch (e) { fail(`cannot read ${p}: ${e.message}`); }
  try { return { raw, value: JSON.parse(raw) }; } catch (e) { fail(`${p} is not valid JSON: ${e.message}`); }
}

const inv = readJson(INVENTORY_PATH);
const idx = readJson(INDEX_PATH);

if (!Array.isArray(inv.value.repos)) fail("inventory has no `repos` array");
if (!Array.isArray(idx.value.repos)) fail("index has no `repos` array");
if (idx.value.inventory !== "config/gate-suite-inventory.json") fail(`index.inventory must point at config/gate-suite-inventory.json (got ${JSON.stringify(idx.value.inventory)})`);
if (typeof idx.value.generatedAt !== "string" || !Number.isFinite(Date.parse(idx.value.generatedAt))) fail("index.generatedAt is missing or not an ISO timestamp");

const invRepos = new Set(inv.value.repos.map((r) => String(r.repo)));
const idxRepos = new Set(idx.value.repos.map((r) => String(r.repo)));

for (const r of invRepos) if (!idxRepos.has(r)) fail(`inventoried repo ${r} is missing from the index (silent omission)`);
for (const r of idxRepos) if (!invRepos.has(r)) fail(`index lists ${r} which is not in the inventory (fabricated row)`);

// Canonical-form check: the committed index must equal a re-serialization of
// its own parsed value. This makes "do not hand-edit — run the generator"
// enforceable: any manual reorder/reformat breaks byte-identity here.
const canonical = serialize(idx.value);
if (canonical !== idx.raw) fail("committed index is not in generator canonical form (key order / 2-space / trailing newline). Run `node scripts/gate-suite-index.mjs` and commit.");

console.error(`[gate-suite-index-selfcheck] OK — index consistent with inventory (${idx.value.repos.length} repo(s)); canonical form intact. (Live suite-drift scan runs in the monthly audit.)`);
process.exit(0);
