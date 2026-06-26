#!/usr/bin/env node
// ---------------------------------------------------------------------------
// docs-contract-gate — the reusable integration docs-contract validator
// (cinatra-ai/ci#39). Integration repos (wordpress-plugin, drupal-module,
// twenty-connector, plane-connector) call this PRE-TAG so their per-repo `docs/`
// stays consistent with the docs contract authored in cinatra-ai/docs (docs#51)
// without central control; the docs publish path (ops#378) runs the SAME gate at
// compile time against the tagged docs tree.
//
// It validates ONE integration `docs/` directory in isolation against the
// contract: the fixed 6-page set, the required frontmatter schema + value
// domains, slug == registry slug, the allowed-content policy (Markdown + static
// assets only — no MDX/imports/code execution), link/path policy (relative links
// resolve inside the docs dir; cross-chapter links are absolute canonical; no
// private-repo / non-https schemes), and asset path/size + stable-filename rules.
//
// SELF-CONTAINED: Node builtins only, zero runtime npm deps, runnable locally. It
// NEVER fetches anything and NEVER reads outside the docs dir — all checks are
// static/offline (no private-repo access), per ci#39.
//
// Usage (after checkout; this repo is private with no published bin):
//   node scripts/docs-contract-gate.mjs --docs <dir> --slug <registry-slug> [--format text|json]
//
// Exit codes: 0 = conform, 1 = findings, 2 = internal/usage error.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { conformDocsTree, MAX_PAGE_BYTES } from "./lib/docs-contract-rules.mjs";

const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "g");
function sanitizeMessage(s, max = 500) {
  const stripped = String(s ?? "").replace(CONTROL_CHARS, "·");
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}

function parseArgs(argv) {
  const out = { docs: "docs", slug: null, format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--docs" || a === "-d") out.docs = argv[++i];
    else if (a === "--slug" || a === "-s") out.slug = argv[++i];
    else if (a === "--format" || a === "-f") out.format = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".docs-contract-gate"]);

/** Recursively walk the docs root. Returns:
 *   files:   Set<docs-relative path> (every file)
 *   pages:   { rel -> text } for *.md at the docs root (the contract pages)
 *   assets:  { rel -> byteSize } for every non-md file
 *   oversize: rel[] for pages too large to read. */
function loadDocsTree(root) {
  const files = new Set();
  const pages = {};
  const assets = {};
  const oversize = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      let est;
      if (ent.isSymbolicLink()) { try { est = statSync(abs); } catch { continue; } }
      const isDir = ent.isDirectory() || (est && est.isDirectory());
      const isFile = ent.isFile() || (est && est.isFile());
      if (isDir) {
        if (SKIP_DIRS.has(ent.name)) continue;
        stack.push(abs);
        continue;
      }
      if (!isFile) continue;
      const rel = relative(root, abs).split(sep).join("/");
      files.add(rel);
      let st = est;
      try { st = st ?? statSync(abs); } catch { continue; }
      if (rel.toLowerCase().endsWith(".md") && !rel.includes("/")) {
        if (st.size > MAX_PAGE_BYTES) { oversize.push(rel); continue; }
        try { pages[rel] = readFileSync(abs, "utf8"); } catch { oversize.push(rel); }
      } else if (rel.toLowerCase().endsWith(".md")) {
        // nested .md — record so conformDocsTree flags it as stray
        if (st.size > MAX_PAGE_BYTES) { oversize.push(rel); continue; }
        try { pages[rel] = readFileSync(abs, "utf8"); } catch { oversize.push(rel); }
      } else {
        assets[rel] = st.size;
      }
    }
  }
  return { files, pages, assets, oversize };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: docs-contract-gate --docs <dir> --slug <registry-slug> [--format text|json]");
    process.exit(0);
  }
  const root = args.docs;
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    const msg = `docs directory not found: ${root}`;
    if (args.format === "json") console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(`[docs-contract-gate] ERROR: ${msg}`);
    process.exit(2);
  }
  if (!args.slug) {
    const msg = "--slug <registry-slug> is required (the page slug must equal the integration's registry slug).";
    if (args.format === "json") console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(`[docs-contract-gate] ERROR: ${msg}`);
    process.exit(2);
  }

  let loaded;
  try {
    loaded = loadDocsTree(root);
  } catch (e) {
    const msg = sanitizeMessage(e.message);
    if (args.format === "json") console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(`[docs-contract-gate] ERROR: ${msg}`);
    process.exit(2);
  }

  const { findings } = conformDocsTree(loaded, { slug: args.slug });
  const pass = findings.length === 0;

  if (args.format === "json") {
    console.log(JSON.stringify({ slug: args.slug, ok: pass, findings }, null, 2));
  } else if (pass) {
    console.log(`[docs-contract-gate] OK — docs/ for "${args.slug}" conforms to the integration docs contract.`);
  } else {
    console.error(`[docs-contract-gate] FAIL — "${args.slug}": ${findings.length} docs-contract finding(s):`);
    for (const f of findings) console.error(`  - [${f.id}] ${sanitizeMessage(f.message)}`);
  }
  process.exit(pass ? 0 : 1);
}

main();
