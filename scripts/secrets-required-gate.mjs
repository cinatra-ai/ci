#!/usr/bin/env node
/**
 * secrets-required-gate — reusable CI gate that keeps a repo's
 * `.github/secrets-required.txt` manifest in lockstep with the secrets its
 * workflows actually reference (cinatra-engineering#315).
 *
 * Two drift classes, both fail-closed:
 *
 *   1. ORPHAN REFERENCE — a `secrets.<NAME>` used in `.github/workflows/**`
 *      with no matching manifest entry. This is the recurrence the audit hit:
 *      DEV_LOCK_BUMP_TOKEN was wired into dev-lock-auto-bump.yml but absent from
 *      the manifest, so its provisioning/rotation was undocumented.
 *
 *   2. ORPHAN DECLARATION — a manifest entry that no workflow references. A
 *      stale name invites provisioning a secret nothing consumes (or hides a
 *      rename that silently dropped the real reference).
 *
 * The build-in `GITHUB_TOKEN` is auto-provided by Actions and is never
 * provisioned, so it is excluded from both sides.
 *
 * Reference scan is deliberately strict. It recognises the canonical
 * `secrets.NAME` / `secrets['NAME']` / `secrets["NAME"]` forms (whitespace
 * tolerant: `secrets [ 'NAME' ]`). Two un-auditable forms FAIL CLOSED rather
 * than pass silently:
 *   - a *dynamic* bracket reference (`secrets[matrix.x]`, `secrets[steps...]`)
 *     whose key is not a quoted literal — the concrete name can't be resolved;
 *   - `secrets: inherit` on a reusable-workflow call, which forwards ALL of the
 *     caller's secrets without naming them, hiding the real dependency.
 * In both cases the gate tells the author to wire the concrete `secrets.NAME`.
 *
 * Manifest grammar (`.github/secrets-required.txt`): an ENTRY is a token at
 * column 0 (a line that does not start with whitespace and is not a `#`
 * comment) matching /^[A-Z][A-Z0-9_]*$/. A single line may declare several
 * names separated by " / " (e.g. `DOCKERHUB_USERNAME / DOCKERHUB_TOKEN`).
 * Indented prose (purpose/scope/wiring notes) and comments are NOT entries, so
 * a name mentioned mid-sentence in a note never counts as a declaration.
 *
 * Zero runtime dependencies (node builtins only).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATE_VERSION = "0.1.0";
const VALID_FORMATS = ["text", "json"];
const VALUE_FLAGS = new Set(["root", "format", "manifest", "workflows"]);
const BOOLEAN_FLAGS = new Set(["quiet"]);

// Auto-provided by Actions; never provisioned, so never manifested.
const BUILTIN_SECRETS = new Set(["GITHUB_TOKEN"]);

const DEFAULT_MANIFEST = path.join(".github", "secrets-required.txt");
const DEFAULT_WORKFLOWS = path.join(".github", "workflows");

// Strict usage with explicit flag arity: unknown flags, stray operands, values
// on boolean flags, and missing/empty values on value flags all exit 2 loud —
// a typo must never run a weaker check silently.
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
      return fail(`unknown flag --${key} (valid: --root, --manifest, --workflows, --format, --quiet)`);
    }
  }
  return args;
}

function fail(msg) {
  console.error(`[secrets-required-gate] ${msg}`);
  process.exit(2);
}

/**
 * Parse the declared entries out of a secrets-required.txt body.
 * Returns { entries: Map<name, lineNumber>, errors: string[] }.
 * A duplicate declaration is an error (a manifest should name each secret once).
 */
function parseManifest(text) {
  const entries = new Map();
  const errors = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Column-0 only: indented prose and blank lines are not entries.
    if (raw === "" || /^\s/.test(raw)) continue;
    const line = raw.trimEnd();
    if (line.startsWith("#")) continue;
    // A declaration line is one or more NAME tokens joined by " / ".
    const tokens = line.split(/\s*\/\s*/);
    for (const tok of tokens) {
      const name = tok.trim();
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        errors.push(
          `manifest line ${i + 1}: unparseable entry token ${JSON.stringify(name)} ` +
            `(entries must be UPPER_SNAKE at column 0; indent prose notes)`
        );
        continue;
      }
      if (entries.has(name)) {
        errors.push(`manifest line ${i + 1}: duplicate declaration of ${name} (first at line ${entries.get(name)})`);
        continue;
      }
      entries.set(name, i + 1);
    }
  }
  return { entries, errors };
}

// `secrets.NAME`, `secrets['NAME']`, `secrets["NAME"]` (whitespace tolerant
// around the bracket/key). The reference is part of the GitHub Actions
// expression `${{ ... }}`, but we scan the raw token so a reference written
// without surrounding braces (invalid, but author-visible) still surfaces.
const STATIC_REF_RE = /secrets\.([A-Za-z_][A-Za-z0-9_]*)|secrets\s*\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*\]/g;
// A bracket reference whose key is NOT a quoted literal — a dynamic/computed
// secret name the gate cannot resolve statically. The lookahead is anchored at
// the `[` (BEFORE consuming whitespace) so a `\s*` cannot backtrack to defeat
// it: `secrets [ 'NAME' ]` (quoted, static) must NOT match here.
const DYNAMIC_REF_RE = /secrets\s*\[(?!\s*['"])/g;
// `secrets: inherit` on a reusable-workflow `uses:` call forwards EVERY caller
// secret without naming any — an un-auditable dependency. Tolerate a trailing
// YAML `# comment`, optional quoting (`"inherit"` / `'inherit'`), and trailing
// whitespace so a quoted/annotated form is not silently missed.
const INHERIT_RE = /^\s*secrets\s*:\s*(?:inherit|"inherit"|'inherit')\s*(?:#.*)?$/gm;

function listWorkflowFiles(dir) {
  let stat;
  try { stat = fs.statSync(dir); } catch { return []; }
  if (!stat.isDirectory()) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listWorkflowFiles(full));
    } else if (ent.isFile() && /\.(ya?ml)$/.test(ent.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Scan a set of workflow files for secret references.
 * Returns { refs: Map<name, file[]>, dynamic: {file,line}[], inherit: {file,line}[] }.
 */
function scanWorkflows(files) {
  const refs = new Map();
  const dynamic = [];
  const inherit = [];
  const lineOf = (text, index) => text.slice(0, index).split(/\r?\n/).length;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    let m;
    STATIC_REF_RE.lastIndex = 0;
    while ((m = STATIC_REF_RE.exec(text)) !== null) {
      const name = m[1] ?? m[3];
      if (!name) continue;
      if (!refs.has(name)) refs.set(name, []);
      const arr = refs.get(name);
      if (!arr.includes(file)) arr.push(file);
    }
    DYNAMIC_REF_RE.lastIndex = 0;
    while ((m = DYNAMIC_REF_RE.exec(text)) !== null) {
      dynamic.push({ file, line: lineOf(text, m.index) });
    }
    INHERIT_RE.lastIndex = 0;
    while ((m = INHERIT_RE.exec(text)) !== null) {
      inherit.push({ file, line: lineOf(text, m.index) });
    }
  }
  return { refs, dynamic, inherit };
}

function analyze({ manifestText, workflowFiles, rootForDisplay }) {
  const { entries, errors: manifestErrors } = parseManifest(manifestText);
  const { refs, dynamic, inherit } = scanWorkflows(workflowFiles);

  const rel = (f) => (rootForDisplay ? path.relative(rootForDisplay, f) : f);

  const referencedNames = [...refs.keys()].filter((n) => !BUILTIN_SECRETS.has(n)).sort();
  const declaredNames = [...entries.keys()].sort();

  // Orphan reference: referenced by a workflow, not declared in the manifest.
  const orphanReferences = referencedNames
    .filter((n) => !entries.has(n))
    .map((n) => ({ name: n, files: refs.get(n).map(rel).sort() }));

  // Orphan declaration: declared in the manifest, referenced by no workflow.
  const orphanDeclarations = declaredNames
    .filter((n) => !refs.has(n))
    .map((n) => ({ name: n, line: entries.get(n) }));

  const dynamicReferences = dynamic.map((d) => ({ file: rel(d.file), line: d.line }));
  const inheritReferences = inherit.map((d) => ({ file: rel(d.file), line: d.line }));

  const ok =
    manifestErrors.length === 0 &&
    orphanReferences.length === 0 &&
    orphanDeclarations.length === 0 &&
    dynamicReferences.length === 0 &&
    inheritReferences.length === 0;

  return {
    ok,
    declaredCount: declaredNames.length,
    referencedCount: referencedNames.length,
    manifestErrors,
    orphanReferences,
    orphanDeclarations,
    dynamicReferences,
    inheritReferences,
  };
}

function report(result) {
  const lines = [];
  if (result.manifestErrors.length) {
    lines.push("Manifest parse errors:");
    for (const e of result.manifestErrors) lines.push(`  - ${e}`);
  }
  if (result.orphanReferences.length) {
    lines.push("Secrets referenced by a workflow but MISSING from .github/secrets-required.txt:");
    for (const o of result.orphanReferences) {
      lines.push(`  - ${o.name}  (referenced in: ${o.files.join(", ")})`);
    }
    lines.push("  Fix: add each name (with its scope + wiring note, NEVER a value) to the manifest.");
  }
  if (result.orphanDeclarations.length) {
    lines.push("Manifest entries with NO referencing workflow (stale declarations):");
    for (const o of result.orphanDeclarations) {
      lines.push(`  - ${o.name}  (manifest line ${o.line})`);
    }
    lines.push("  Fix: remove the stale entry, or wire the secret into the workflow that needs it.");
  }
  if (result.dynamicReferences.length) {
    lines.push("Unresolvable DYNAMIC secret references (the gate cannot audit a computed name):");
    for (const d of result.dynamicReferences) {
      lines.push(`  - ${d.file}:${d.line}`);
    }
    lines.push("  Fix: reference the concrete `secrets.NAME` so the name is auditable.");
  }
  if (result.inheritReferences.length) {
    lines.push("`secrets: inherit` forwards EVERY caller secret unnamed (un-auditable):");
    for (const d of result.inheritReferences) {
      lines.push(`  - ${d.file}:${d.line}`);
    }
    lines.push("  Fix: pass each secret explicitly under `secrets:` so the dependency is named.");
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = "root" in args ? path.resolve(args.root) : process.cwd();
  let rootStat;
  try { rootStat = fs.statSync(root); } catch { rootStat = null; }
  if (!rootStat || !rootStat.isDirectory()) fail(`--root is not a directory: ${root}`);

  const format = "format" in args ? args.format : "text";
  if (!VALID_FORMATS.includes(format)) fail(`unknown --format '${format}' (valid: ${VALID_FORMATS.join(", ")})`);
  const quiet = Boolean(args.quiet);

  const manifestPath = path.resolve(root, "manifest" in args ? args.manifest : DEFAULT_MANIFEST);
  const workflowsDir = path.resolve(root, "workflows" in args ? args.workflows : DEFAULT_WORKFLOWS);

  let manifestText;
  try {
    manifestText = fs.readFileSync(manifestPath, "utf8");
  } catch {
    // A missing manifest with referenced secrets is itself a failure; a missing
    // manifest with NO referenced secrets is fine (nothing to declare).
    manifestText = "";
    if (!fs.existsSync(manifestPath)) {
      const wfFiles = listWorkflowFiles(workflowsDir);
      const { refs, dynamic, inherit } = scanWorkflows(wfFiles);
      const referenced = [...refs.keys()].filter((n) => !BUILTIN_SECRETS.has(n));
      // A missing manifest is fine ONLY when nothing un-auditable depends on a
      // secret: no named ref, no dynamic ref, no `secrets: inherit`.
      if (referenced.length === 0 && dynamic.length === 0 && inherit.length === 0) {
        if (format === "json") {
          process.stdout.write(
            JSON.stringify({ gateVersion: GATE_VERSION, ok: true, status: "no-manifest-no-secrets" }, null, 2) + "\n"
          );
        } else if (!quiet) {
          process.stderr.write("secrets-required-gate: clean (no manifest, no referenced secrets).\n");
        }
        process.exit(0);
      }
      const what = [
        referenced.length ? `secrets (${referenced.sort().join(", ")})` : null,
        dynamic.length ? `${dynamic.length} dynamic secrets[...] reference(s)` : null,
        inherit.length ? `${inherit.length} 'secrets: inherit' call(s)` : null,
      ].filter(Boolean).join(", ");
      fail(`no manifest at ${path.relative(root, manifestPath)} but workflows use ${what}; create the manifest`);
    }
  }

  const workflowFiles = listWorkflowFiles(workflowsDir);
  const result = analyze({ manifestText, workflowFiles, rootForDisplay: root });

  if (format === "json") {
    process.stdout.write(JSON.stringify({ gateVersion: GATE_VERSION, ...result }, null, 2) + "\n");
  } else if (!quiet) {
    if (result.ok) {
      process.stderr.write(
        `secrets-required-gate: clean (${result.declaredCount} declared, ${result.referencedCount} referenced; in lockstep).\n`
      );
    } else {
      process.stderr.write("secrets-required-gate: FAIL\n" + report(result) + "\n");
    }
  }

  process.exit(result.ok ? 0 : 1);
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
  catch (e) { console.error("[secrets-required-gate] gate failed:", e.message); process.exit(2); }
}

export { parseManifest, scanWorkflows, analyze, report, listWorkflowFiles, BUILTIN_SECRETS };
