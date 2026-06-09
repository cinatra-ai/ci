#!/usr/bin/env node
/**
 * source-leak-gate — reusable CI gate that detects internal process markers
 * that should not ship in source (numbered milestones, internal IDs,
 * review labels, history breadcrumbs, internal artifact names, etc.).
 *
 * Design:
 *   - Generic, repo-agnostic default rules ship here. Project-specific token
 *     lists (single-prefix IDs, host/handle/channel lists, repo-private names)
 *     are supplied by each consuming repo via `--config <json>`.
 *   - Ratchet modes: line (default, no-new-rot), file (allowlist), baseline
 *     (per rule+file count), off.
 *   - Self-exemption: the definition region (which necessarily contains the
 *     very markers it detects) is bracketed by sentinel comments and skipped on
 *     the gate's own file; dedicated fixtures + baselines are path-exempt.
 *
 * Zero runtime dependencies (node builtins only).
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBaseRef, buildRenameMap, getAddedLineNumbers, getIntroducedPaths } from "./lib/touch-ratchet.mjs";

const SCANNER_VERSION = "0.1.0";
const DEFAULT_DIFF_BASE_ENV = "SOURCE_LEAK_DIFF_BASE";

// Exemptions are keyed to the ACTUAL running gate file (and its sibling fixture)
// by real path — never by a relative path a scanned (caller) repo could also
// have. So the sentinel/fixture carve-outs apply only to this gate's own files.
const SCANNER_REAL = (() => {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return ""; }
})();
const FIXTURE_REAL = (() => {
  try { return fs.realpathSync(path.join(path.dirname(SCANNER_REAL), "__fixtures__", "source-leak.fixture.txt")); }
  catch { return ""; }
})();
function realPathOf(p) {
  try { return fs.realpathSync(path.resolve(p)); } catch { return ""; }
}
const VALID_PROFILES = ["default", "ts-monorepo", "php-wp-plugin", "drupal-module", "ops-docs"];
const VALID_RATCHET_MODES = ["line", "file", "baseline", "off"];

const DEFAULT_SKIP_DIRS = new Set([
  ".git", ".next", ".turbo", "node_modules", "dist", "build", "coverage",
  "public", ".cache", ".vercel", ".pnpm-store", "vendor",
  // The reusable workflow checks this gate out under this dir inside the caller
  // repo; never scan our own checked-out copy.
  ".source-leak-gate",
]);
const DEFAULT_SKIP_DIR_PREFIXES = [];
const DEFAULT_SKIP_FILE_PATTERNS = [
  /^pnpm-lock\.yaml$/, /^package-lock\.json$/, /^yarn\.lock$/,
  /\.tsbuildinfo$/, /\.min\.(js|css)$/, /\.d\.m?ts$/,
];
const DEFAULT_SCAN_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".rb", ".php", ".module", ".install", ".inc", ".sh", ".bash", ".zsh",
  ".json", ".jsonc", ".yml", ".yaml", ".toml", ".ini",
  ".md", ".mdx", ".css", ".scss", ".sass", ".less", ".sql", ".txt", ".html",
]);

// ===================== SOURCE_LEAK_RULES_BEGIN =====================
// Everything in this region may contain the markers it describes. It is
// self-exempt on the gate's own file (see readRuleDefRange) so the gate stays
// clean when scanning itself. Keep marker-bearing constants inside this block.

// Internal-only working areas: never scanned.
const PRIVATE_PREFIXES = [".planning/", ".claude/", ".agents/", ".gsd/"];
const PRIVATE_EXACT = new Set([".github/CODEOWNERS"]);

// Doc files are scanned but findings dropped (they legitimately reference history).
const EXEMPT_FILE_BASENAMES = new Set(["CLAUDE.md", "AGENTS.md", "MEMORY.md", "README.md", "CHANGELOG.md"]);
const EXEMPT_DIR_PREFIXES = ["docs/"];

const RULES = [
  {
    id: "SLG_MILESTONE_NUMBER",
    description: "Numbered planning milestone reference",
    re: /\bphase[\s:=\-_]+(?:[A-Z]?\d{2,4}(?:\.\d+)*[a-z]?)\b/gi,
    pathScan: true, // e.g. a dir `phase-553/`
    contextExclude(line) {
      if (line.includes("NEXT_PHASE=phase-production-build")) return true;
      if (/\bphased rollout\b/i.test(line)) return true;
      if (/\bbuild phase\b/i.test(line) && /\bproduction\b/i.test(line)) return true;
      return false;
    },
  },
  {
    id: "SLG_MILESTONE_SHORTHAND",
    description: "Milestone shorthand token",
    re: /\bP\d{3}(?:[-_.][A-Za-zβ\d]+)?\b/g,
    contextExclude(line) {
      if (/\bp-\d/i.test(line)) return true; // padding utilities
      if (/\bP-?(?:256|384|521)\b/.test(line)) return true; // ECC curves
      return false;
    },
  },
  {
    id: "SLG_VERSIONED_MILESTONE",
    description: "Versioned milestone reference",
    re: /\bv\d+\.\d+(?:\.\d+)?[\s:_/-]+(?:Phase|P)[\s:_#-]*\d{2,4}\b/gi,
    pathScan: true, // per-segment scan avoids matching across a real `/` (e.g. api/v1.2/P12)
  },
  {
    id: "SLG_MILESTONE_REF",
    description: "Milestone version reference",
    re: /\bmilestone\s+v\d+\.\d+(?:\.\d+)?\b|\bv\d+\.\d+(?:\.\d+)?\s+milestone\b/gi,
  },
  {
    id: "SLG_METHODOLOGY",
    description: "Internal methodology acronym",
    re: /\b(gsd|GSD)\b/g,
    contextExclude(line) {
      return /\b(getsubject|get-subject|gsdoc)\b/i.test(line);
    },
  },
  {
    id: "SLG_PLANNING_DOC",
    description: "Internal planning artifact filename",
    re: /\b(?:drift[-_ ]?gate|ROADMAP\.md|MILESTONE\.md|STATE\.md|PLAN\.md|REQUIREMENTS\.md|LEARNINGS\.md|MILESTONE-AUDIT\.md)\b/g,
  },
  {
    id: "SLG_PLANNING_DOC_VERSIONED",
    description: "Milestone-prefixed planning doc name",
    re: /\bv\d+\.\d+(?:\.\d+){0,2}[\s.-]+(?:MILESTONE(?:-AUDIT)?|PLAN|ROADMAP|PHASE|REQUIREMENTS|RESEARCH|REVIEW|VALIDATION|VERIFICATION|SECURITY|LEARNINGS|NYQUIST|PATTERNS)(?:\.md)?\b/g,
    pathScan: true, // e.g. a file `v6.13-ROADMAP.md` (the bare unversioned SLG_PLANNING_DOC is NOT path-scanned: legit OSS PLAN.md/ROADMAP.md)
  },
  {
    id: "SLG_PLANNING_PATH",
    description: "Reference to an internal planning directory",
    re: /(?:^|[\s"'`(])\.planning\//g,
    contextExclude(line) {
      return /^\s*-\s*['"]?\.planning\/\*\*['"]?\s*$/.test(line); // CI paths filter entry
    },
  },
  {
    id: "SLG_REQ_ID_BROAD",
    description: "Multi-segment requirement/workstream ID",
    re: /\b[A-Z]{2,8}\d{0,3}(?:-[A-Z0-9]{2,16}){1,4}-\d{2,3}\b/g,
  },
  {
    id: "SLG_WORKSTREAM_NUMERIC",
    description: "Numeric workstream ID",
    re: /\bGSD-?\d{3,4}\b/g,
    pathScan: true, // e.g. a file/dir `GSD-001-notes/`
  },
  {
    id: "SLG_WORKSTREAM_SLUG",
    description: "Numeric workstream slug",
    re: /\b\d{6}-[a-z0-9]{3}\b/g,
  },
  {
    id: "SLG_REVIEW_LABEL",
    description: "Adversarial-review label",
    re: /\b(?:[Cc]odex\s+[Rr]\d+|owner\s+note|review\s+round\s*\d+)\b/g,
  },
  {
    id: "SLG_PULL_REQUEST_ROUND",
    description: "Pull-request + review-round reference",
    re: /\bPR\s+#?\d{3,5}\s+[Rr]\d+\b/g,
  },
  {
    id: "SLG_PROVENANCE",
    description: "Provenance annotation referencing internal milestones",
    re: /\b(?:added|introduced|landed|shipped|fixed|removed|deprecated|migrated)\s+in\s+(?:Phase\s+\d|milestone\s+v|v\d+\.\d+\s+(?:Phase|milestone))/gi,
  },
  {
    id: "SLG_HISTORICAL",
    description: "History breadcrumb prose",
    re: /\b(?:renamed\s+from|used\s+to\s+be\s+called|before\s+the\s+refactor|prior\s+to\s+the\s+refactor|pre[\s-]refactor|formerly\s+(?:known\s+as|called))\b/gi,
  },
  {
    id: "SLG_DECISION_RECORD",
    description: "Internal decision-record pointer",
    re: /\bADR[\s-]?\d+\b/g,
  },
  {
    id: "SLG_AGENT_MEMORY",
    description: "Agent-memory provenance pointer",
    re: /\[\[(?:feedback|project|reference|user|memory)[_-][a-z0-9][a-z0-9_-]*\]\]|\b(?:generalized memory entry|agent memory|memory entry|save to memory)\b|\bMEMORY\.md\b/gi,
  },
  {
    id: "SLG_MILESTONE_VERSION",
    description: "Bare milestone version marker in planning context",
    re: /\bv\d+\.\d+(?:\.\d+)?\b/g,
    contextExclude(line) {
      if (/^\s*"(version|node|engines|peerDependencies)"\s*:/.test(line)) return true;
      if (/^\s*"@?[a-z0-9_\-/]+"\s*:\s*"[\^~>=<*]?\d/.test(line)) return true;
      if (/^\s*##\s+v?\d+\.\d+/.test(line)) return true; // changelog headers
      if (/openapi|oas|jsonschema|\$schema|jsonrpc|swagger/i.test(line)) return true;
      if (/(integrity|resolution|tarball|registry\.npmjs\.org)/i.test(line)) return true;
      if (/\b(tailscale|postgres|redis|nginx|node|alpine|bullseye|bookworm|debian|ubuntu)\b.*v?\d+\.\d+/i.test(line)) return true;
      if (/\bv?\d+\.\d+.*(docker|image|container|node|alpine|debian|ubuntu)/i.test(line)) return true;
      if (/\b(A2UI|AG-UI|OpenAPI|OAS|JSON-RPC|jsonrpc)\b/i.test(line)) return true;
      if (/\bv\d+\.\d+(?:\.\d+)?\s+(spec|protocol|schema|format|wire)\b/i.test(line)) return true;
      if (/version\s*:\s*['"`]v?\d+\.\d+/i.test(line)) return true;
      if (/\b[A-Z][A-Z0-9_]*_(REF|VERSION|TAG)\s*[:=]\s*['"]?v?\d+\.\d+/.test(line)) return true;
      if (/\.(toBe|toEqual|toContain|toMatch)\(['"`]v?\d+\.\d+/i.test(line)) return true;
      if (/v\d+\.\d+\.\d+/.test(line) && /(github\.com|@v\d+|ref\s*:\s*['"]v\d+|git\+|\.git)/i.test(line)) return true;
      if (/@[0-9a-f]{7,40}\b[^\n]*#\s*v?\d+\.\d+/.test(line)) return true; // SHA-pinned action with version comment
      if (/--save-(dev|exact)/.test(line)) return true;
      if (/\b(release|tag|ship(?:ped)?|target|require|min(?:imum)?)\b/i.test(line)) {
        return !/(milestone|phase|roadmap)/i.test(line);
      }
      return false;
    },
  },
];
// Single-prefix requirement IDs are project-specific; supply via config.reqIdSinglePrefixes.
const REQ_ID_SINGLE_RULE_ID = "SLG_REQ_ID_SINGLE";
// ===================== SOURCE_LEAK_RULES_END =====================

const RULE_DEFS_MARKER_BEGIN = "SOURCE_LEAK_RULES" + "_BEGIN";
const RULE_DEFS_MARKER_END = "SOURCE_LEAK_RULES" + "_END";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    if (eq !== -1) {
      args[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { args[key] = next; i++; }
      else args[key] = true;
    }
  }
  return args;
}

function fail(msg) {
  console.error(`[source-leak-gate] ${msg}`);
  process.exit(2);
}

function loadConfig(configPath) {
  if (!configPath) return {};
  let raw;
  try { raw = fs.readFileSync(configPath, "utf8"); }
  catch { return fail(`config not found or unreadable: ${configPath}`); }
  try { return JSON.parse(raw); }
  catch (e) { return fail(`config is not valid JSON (${configPath}): ${e.message}`); }
}

function buildRules(config, profile, onlyRules) {
  const rules = RULES.map((r) => ({ ...r, profiles: r.profiles || VALID_PROFILES }));

  const singlePrefixes = Array.isArray(config.reqIdSinglePrefixes) ? config.reqIdSinglePrefixes : [];
  if (singlePrefixes.length) {
    const alt = singlePrefixes.map((p) => String(p).replace(/[^A-Z0-9-]/gi, "")).filter(Boolean).join("|");
    if (alt) {
      rules.push({
        id: REQ_ID_SINGLE_RULE_ID,
        description: "Single-segment requirement ID (project-specific prefixes)",
        re: new RegExp(`\\b(?:${alt})-\\d{1,4}\\b`, "g"),
        profiles: VALID_PROFILES,
      });
    }
  }

  for (const er of Array.isArray(config.extraRules) ? config.extraRules : []) {
    if (!er || !er.id || !er.regex) continue;
    let re;
    try { re = new RegExp(er.regex, er.flags || "g"); }
    catch (e) { return fail(`config extraRule ${er.id} has an invalid regex: ${e.message}`); }
    const lineExcludes = (er.lineExcludes || []).map((s) => new RegExp(s));
    const pathExcludes = (er.pathExcludes || []).map((s) => new RegExp(s));
    rules.push({
      id: er.id,
      description: er.description || er.id,
      re,
      profiles: Array.isArray(er.profiles) && er.profiles.length ? er.profiles : VALID_PROFILES,
      contextExclude: lineExcludes.length ? (line) => lineExcludes.some((rx) => rx.test(line)) : undefined,
      pathExclude: pathExcludes.length ? (p) => pathExcludes.some((rx) => rx.test(p)) : undefined,
    });
  }

  const globalLineExcludes = (Array.isArray(config.lineExcludes) ? config.lineExcludes : []).map((s) => new RegExp(s));

  let active = rules.filter((r) => profile === "default" || r.profiles.includes(profile) || r.profiles.includes("default"));
  if (onlyRules) {
    const set = new Set(onlyRules.split(",").map((s) => s.trim()).filter(Boolean));
    active = active.filter((r) => set.has(r.id));
  }
  if (globalLineExcludes.length) {
    active = active.map((r) => {
      const base = r.contextExclude;
      return { ...r, contextExclude: (line) => (base ? base(line) : false) || globalLineExcludes.some((rx) => rx.test(line)) };
    });
  }
  return active;
}

function listTrackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return walk(process.cwd());
  }
}

function walk(dir, acc = [], relBase = "") {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const e of entries) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (DEFAULT_SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), acc, rel);
    } else if (e.isFile()) {
      acc.push(rel);
    }
  }
  return acc;
}

function applyManifest(files, manifestPath) {
  if (!manifestPath) return files;
  let lines;
  try { lines = fs.readFileSync(manifestPath, "utf8").split("\n"); }
  catch { return fail(`manifest not found or unreadable: ${manifestPath}`); }
  const includesDir = [], includesExact = new Set(), negDirs = [], negExact = new Set();
  for (let l of lines) {
    l = l.trim();
    if (!l || l.startsWith("#")) continue;
    let neg = false;
    if (l.startsWith("!")) { neg = true; l = l.slice(1); }
    if (l.endsWith("/")) (neg ? negDirs : includesDir).push(l);
    else (neg ? negExact : includesExact).add(l);
  }
  const isNeg = (f) => negExact.has(f) || negDirs.some((d) => f === d.slice(0, -1) || f.startsWith(d));
  const isInc = (f) => includesExact.has(f) || includesDir.some((d) => f === d.slice(0, -1) || f.startsWith(d));
  return files.filter((f) => !isNeg(f) && isInc(f));
}

function isPrivate(p) {
  return PRIVATE_EXACT.has(p) || PRIVATE_PREFIXES.some((pre) => p.startsWith(pre));
}
function shouldScan(p, scanExtensions, skipDirs, skipDirPrefixes, skipFilePatterns) {
  if (p.split("/").some((seg) => skipDirs.has(seg))) return false;
  if (skipDirPrefixes.some((pre) => p === pre.replace(/\/$/, "") || p.startsWith(pre))) return false;
  const base = p.split("/").pop();
  if (skipFilePatterns.some((rx) => rx.test(base))) return false;
  if (["package.json", "tsconfig.json", "Dockerfile"].includes(base)) return true;
  const ext = path.extname(p);
  if (scanExtensions.has(ext)) return true;
  return ["Makefile", "README", "AGENTS", "LICENSE", "NOTICE", "CHANGELOG"].some((n) => base.startsWith(n));
}

function readRuleDefRange(text) {
  const lines = text.split("\n");
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && lines[i].includes(RULE_DEFS_MARKER_BEGIN)) start = i + 1;
    else if (start !== -1 && lines[i].includes(RULE_DEFS_MARKER_END)) { end = i + 1; break; }
  }
  return { start, end };
}

function scanFile(relPath, rules) {
  let stat;
  try { stat = fs.statSync(relPath); } catch { return []; }
  if (!stat.isFile() || stat.size > 2_000_000) return [];
  let text;
  try { text = fs.readFileSync(relPath, "utf8"); } catch { return []; }
  if (text.includes("\0")) return [];
  const isSelf = SCANNER_REAL !== "" && realPathOf(relPath) === SCANNER_REAL;
  const defRange = isSelf ? readRuleDefRange(text) : { start: -1, end: -1 };
  const lines = text.split(/\r?\n/);
  const findings = [];
  for (const rule of rules) {
    if (rule.pathExclude && rule.pathExclude(relPath)) continue;
    for (let i = 0; i < lines.length; i++) {
      const lineno = i + 1;
      if (isSelf && defRange.start !== -1 && lineno >= defRange.start && lineno <= defRange.end) continue;
      const line = lines[i];
      const localRe = new RegExp(rule.re.source, rule.re.flags);
      let m;
      while ((m = localRe.exec(line)) !== null) {
        if (rule.contextExclude && rule.contextExclude(line)) break;
        findings.push({ rule: rule.id, file: relPath, line: lineno, column: m.index + 1, match: m[0], snippet: line.trim().slice(0, 200) });
        if (!localRe.global) break;
        if (m.index === localRe.lastIndex) localRe.lastIndex++;
      }
    }
  }
  return findings;
}

// File-name (path) scan: a leaky FILE or DIRECTORY name is a leak even when the
// file's content is clean (or unscanned, e.g. a binary). Scans the path
// PER-SEGMENT with the rule subset flagged `pathScan` — per-segment so one
// benign segment's contextExclude (e.g. ECC `P-256`) can't suppress a leaky
// sibling segment, and so segment-spanning regex separators (`/`) don't create
// cross-directory false positives. Path findings carry line:0 (the marker that
// routes them through the path ratchet, never the line ratchet).
function scanPath(relPath, pathRules) {
  if (!pathRules.length) return [];
  const segments = relPath.split("/");
  const findings = [];
  for (const rule of pathRules) {
    for (const seg of segments) {
      const localRe = new RegExp(rule.re.source, rule.re.flags);
      let m;
      while ((m = localRe.exec(seg)) !== null) {
        if (rule.contextExclude && rule.contextExclude(seg)) break;
        findings.push({ rule: rule.id, file: relPath, line: 0, column: 0, match: m[0], snippet: `path: ${relPath}` });
        if (!localRe.global) break;
        if (m.index === localRe.lastIndex) localRe.lastIndex++;
      }
    }
  }
  return findings;
}

function applyLineRatchet(findings, diffBaseEnv) {
  const base = resolveBaseRef(diffBaseEnv);
  if (!base) return findings;
  const renameMap = buildRenameMap(base);
  const cache = new Map();
  return findings.filter((f) => {
    if (!cache.has(f.file)) cache.set(f.file, getAddedLineNumbers(f.file, base, renameMap));
    const added = cache.get(f.file);
    if (added === null) return true;
    return added.has(f.line);
  });
}

// Ratchet for path (line:0) findings: block only on paths the PR ADDED, RENAMED-
// to, or COPIED-to; tolerate pre-existing leaky paths. Strict / fail-closed
// (block all) when there is no base or the diff cannot be computed — never
// silently tolerate a rename into a leaky name.
function applyPathRatchet(pathFindings, diffBaseEnv) {
  if (!pathFindings.length) return [];
  const base = resolveBaseRef(diffBaseEnv);
  const introduced = getIntroducedPaths(base);
  if (introduced === null) return pathFindings; // strict / fail-closed
  return pathFindings.filter((f) => introduced.has(f.file));
}

function resolveTouchedFiles(diffBaseEnv) {
  const base = resolveBaseRef(diffBaseEnv);
  if (!base) return null;
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--end-of-options", `${base}...HEAD`], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {
    return null; // fail closed: file ratchet treats null as strict (all allowlisted entries block)
  }
}

function applyFileRatchet(findings, args, diffBaseEnv) {
  const allowlistPath = args["legacy-allowlist"];
  let allow = new Set();
  if (allowlistPath && fs.existsSync(allowlistPath)) {
    try { allow = new Set(JSON.parse(fs.readFileSync(allowlistPath, "utf8")).files || []); }
    catch (e) { return { error: `legacy-allowlist is not valid JSON (${allowlistPath}): ${e.message}` }; }
  }
  const findingFiles = new Set(findings.map((f) => f.file));
  let touched;
  try { touched = resolveTouchedFiles(diffBaseEnv); }
  catch (e) { return { error: e.message }; }
  const blockers = [];
  for (const f of findings) {
    if (!allow.has(f.file)) { blockers.push(f); continue; }
    if (touched === null || touched.has(f.file)) blockers.push(f);
  }
  const stale = [...allow].filter((p) => !findingFiles.has(p));
  for (const p of stale) blockers.push({ rule: "SLG_STALE_ALLOWLIST", file: p, line: 0, column: 0, match: p, snippet: "stale allowlist entry" });
  return { blockers, note: `file ratchet: ${allow.size} allowlisted, ${stale.length} stale` };
}

function gateBaselineKey(f) { return `${f.rule}\t${f.file}`; }
function applyBaselineRatchet(findings, args) {
  const baselinePath = args["gate-baseline"];
  if (!baselinePath) return { blockers: findings, note: "baseline mode without --gate-baseline (all findings gated)" };
  if (!fs.existsSync(baselinePath)) return { error: `gate baseline not found or unreadable: ${baselinePath}` };
  let base;
  try { base = JSON.parse(fs.readFileSync(baselinePath, "utf8")).perRuleFile || {}; }
  catch (e) { return { error: `gate baseline is not valid JSON (${baselinePath}): ${e.message}` }; }
  const current = {};
  for (const f of findings) current[gateBaselineKey(f)] = (current[gateBaselineKey(f)] || 0) + 1;
  const blockers = [];
  for (const [k, count] of Object.entries(current)) {
    if (count > (base[k] || 0)) {
      const [rule, file] = k.split("\t");
      blockers.push({ rule, file, line: 0, column: 0, match: `${count} > ${base[k] || 0}`, snippet: "new finding beyond baseline" });
    }
  }
  return { blockers, note: `baseline ratchet: ${Object.keys(base).length} accepted group(s)` };
}
function writeGateBaseline(findings, outPath) {
  const perRuleFile = {};
  for (const f of findings) perRuleFile[gateBaselineKey(f)] = (perRuleFile[gateBaselineKey(f)] || 0) + 1;
  let gitHead = null;
  try { gitHead = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch { /* no head */ }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ gitHead, perRuleFile }, null, 2) + "\n");
}

function countBy(arr, keyFn) {
  const out = {};
  for (const x of arr) out[keyFn(x)] = (out[keyFn(x)] || 0) + 1;
  return out;
}
function buildSummary(findings, gateFindings, profile, scannedFileCount) {
  return {
    scannerVersion: SCANNER_VERSION, profile, scannedFileCount,
    totalFindings: findings.length, gatedFindings: gateFindings.length,
    perRule: countBy(gateFindings, (f) => f.rule), samples: gateFindings.slice(0, 50),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = args.profile || "default";
  if (!VALID_PROFILES.includes(profile)) fail(`unknown --profile '${profile}' (valid: ${VALID_PROFILES.join(", ")})`);
  const ratchetMode = args["ratchet-mode"] || "line";
  if (!VALID_RATCHET_MODES.includes(ratchetMode)) fail(`unknown --ratchet-mode '${ratchetMode}' (valid: ${VALID_RATCHET_MODES.join(", ")})`);
  const format = args.format || "text";
  const quiet = Boolean(args.quiet);
  const exitOnMatch = Boolean(args["exit-on-match"]);
  const includeTests = args["include-tests"] !== "false";
  const diffBaseEnv = args["diff-base-env"] || DEFAULT_DIFF_BASE_ENV;
  const config = loadConfig(args.config);
  const rules = buildRules(config, profile, args.rules || null);

  const scanExtensions = new Set([...DEFAULT_SCAN_EXTENSIONS, ...((config.scanExtensions) || [])]);
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...((config.skipDirs) || [])]);
  const skipDirPrefixes = [...DEFAULT_SKIP_DIR_PREFIXES, ...((config.skipDirPrefixes) || [])];
  const skipFilePatterns = [...DEFAULT_SKIP_FILE_PATTERNS, ...((config.skipFilePatterns) || []).map((s) => new RegExp(s))];
  const exemptDirs = [...EXEMPT_DIR_PREFIXES, ...((config.exemptDirPrefixes) || [])];
  const exemptFiles = new Set([...EXEMPT_FILE_BASENAMES, ...((config.exemptFileBasenames) || [])]);

  // The gate's own config / legacy-allowlist / baseline artifacts necessarily
  // contain the very tokens (and leaky path strings) they describe — never scan
  // them, or a regenerated allowlist would flag itself.
  const gateArtifacts = new Set(
    [args.config, args["legacy-allowlist"], args["gate-baseline"]].filter(Boolean).map((p) => realPathOf(p)).filter(Boolean),
  );

  let files = listTrackedFiles();
  files = applyManifest(files, args.manifest);
  const candidates = files.filter((p) => {
    const real = realPathOf(p);
    if (real && real === SCANNER_REAL) return true; // the running gate (rule-def region is sentinel-exempt)
    if (real && FIXTURE_REAL && real === FIXTURE_REAL) return false; // this gate's own marker fixture
    if (real && gateArtifacts.has(real)) return false; // gate's own config/allowlist/baseline
    if (isPrivate(p)) return false;
    if (!includeTests && /(^|\/)(__tests__|\.test\.|\.spec\.)/.test(p)) return false;
    return shouldScan(p, scanExtensions, skipDirs, skipDirPrefixes, skipFilePatterns);
  });

  let findings = [];
  for (const f of candidates) {
    const fileFindings = scanFile(f, rules);
    if (!fileFindings.length) continue;
    const base = f.split("/").pop();
    if (exemptFiles.has(base) || exemptDirs.some((pre) => f.startsWith(pre))) continue;
    findings.push(...fileFindings);
  }

  // File-name (path) scan: extension-INDEPENDENT candidate set (a leaky-named
  // binary counts), re-applying every exclusion (private/skip/exempt/gate-own)
  // up front. Path findings (line:0) merge into `findings` so file/baseline
  // ratchets key on path consistently.
  const pathRules = rules.filter((r) => r.pathScan);
  if (pathRules.length) {
    for (const p of files) {
      const real = realPathOf(p);
      if (real && (real === SCANNER_REAL || (FIXTURE_REAL && real === FIXTURE_REAL) || gateArtifacts.has(real))) continue;
      if (isPrivate(p)) continue;
      if (!includeTests && /(^|\/)(__tests__|\.test\.|\.spec\.)/.test(p)) continue;
      if (p.split("/").some((seg) => skipDirs.has(seg))) continue;
      if (skipDirPrefixes.some((pre) => p === pre.replace(/\/$/, "") || p.startsWith(pre))) continue;
      const base = p.split("/").pop();
      if (exemptFiles.has(base) || exemptDirs.some((pre) => p.startsWith(pre))) continue;
      findings.push(...scanPath(p, pathRules));
    }
  }

  let gateFindings = findings;
  let ratchetNote = "";
  if (ratchetMode === "line") {
    // Content findings (line>0) ride the line ratchet; path findings (line:0)
    // ride the path ratchet (a rename into a leaky name has no "added line").
    const contentFindings = findings.filter((f) => f.line > 0);
    const pathFindings = findings.filter((f) => f.line === 0);
    gateFindings = [...applyLineRatchet(contentFindings, diffBaseEnv), ...applyPathRatchet(pathFindings, diffBaseEnv)];
    ratchetNote = `line ratchet: ${findings.length - gateFindings.length} pre-existing finding(s) tolerated`;
  } else if (ratchetMode === "file") {
    const r = applyFileRatchet(findings, args, diffBaseEnv);
    if (r.error) fail(r.error);
    gateFindings = r.blockers; ratchetNote = r.note;
  } else if (ratchetMode === "baseline") {
    const r = applyBaselineRatchet(findings, args);
    if (r.error) fail(r.error);
    gateFindings = r.blockers; ratchetNote = r.note;
  }
  if (args["write-gate-baseline"]) writeGateBaseline(findings, args["write-gate-baseline"]);

  if (format === "json") {
    process.stdout.write(JSON.stringify(buildSummary(findings, gateFindings, profile, candidates.length), null, 2) + "\n");
  } else if (!quiet) {
    for (const f of gateFindings) process.stdout.write(`${f.rule}\t${f.file}:${f.line}:${f.column}\t${f.match}\t${f.snippet}\n`);
    process.stderr.write(`Scanned ${candidates.length} files, ${gateFindings.length} gated finding(s)` + (ratchetNote ? ` (${ratchetNote})` : "") + "\n");
    for (const [r, c] of Object.entries(countBy(gateFindings, (f) => f.rule)).sort((a, b) => b[1] - a[1])) {
      process.stderr.write(`  ${r}: ${c}\n`);
    }
    if (gateFindings.length === 0) process.stderr.write("source-leak-gate: clean.\n");
  }

  if (exitOnMatch && gateFindings.length > 0) process.exit(1);
  process.exit(0);
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
  catch (e) { console.error("[source-leak-gate] scanner failed:", e.message); process.exit(2); }
}

export { buildRules, scanFile, RULES, readRuleDefRange };
