#!/usr/bin/env node
/**
 * doc-code-value-gate — reusable CI gate for the "a doc asserts a code value"
 * drift class. Given a set of assertions, each pairing a documentation file +
 * pattern with a source-of-truth file + pattern, it fails when the value the
 * docs claim does not equal the value the code actually carries.
 *
 * Motivating case (cinatra-engineering#152): a README that states an ABI/version
 * constant drifting from the `const` it documents. The recurring failure mode of
 * that lineage is doc/code version drift; this gate pins it mechanically and is
 * the template for every doc-asserts-a-code-value case across the org.
 *
 * Robustness contract (fail-closed by construction):
 *   - Each pattern is a JS regex with EXACTLY ONE capture group; the captured
 *     value is the comparison key.
 *   - A pattern must match EXACTLY ONCE in its file. Zero matches => the doc/code
 *     line moved or was deleted (drift) => FAIL. More than one match => the
 *     pattern is ambiguous (it could be silently reading a changelog line, a
 *     comment, or a code fence instead of the live value) => FAIL. This is what
 *     stops the gate from passing vacuously on a moved/duplicated anchor.
 *   - Doc files (`type: "doc"` / `*.md`) are scanned with fenced code blocks
 *     stripped by default, so an example inside ``` … ``` cannot be mistaken for
 *     the canonical statement. Set `stripFences: false` on a side to disable.
 *   - JSON sides (`type: "json"`) are parsed and read by dot-path (`pointer`),
 *     never regex-scanned — a brace/quote shift can't be misread as a value.
 *
 * Zero runtime dependencies (node builtins only). Exit codes:
 *   0 — every assertion holds
 *   1 — one or more assertions failed (drift, no-match, or ambiguous-match)
 *   2 — usage / IO / config error (loud; never a silently weaker run)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GATE_VERSION = "0.1.0";

const VALUE_FLAGS = new Set([
  "config",
  "root",
  "label",
  "doc-file",
  "doc-pattern",
  "code-file",
  "code-pattern",
]);
const BOOLEAN_FLAGS = new Set(["no-strip-fences"]);

function usageFail(message) {
  process.stderr.write(`[doc-code-value-gate] usage error: ${message}\n`);
  process.exit(2);
}

// Strict arg parsing with explicit flag arity — a typo must never run a weaker
// check silently. Mirrors the org gitignore-gate convention.
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) return usageFail(`unexpected argument: ${tok}`);
    const eq = tok.indexOf("=");
    const key = eq !== -1 ? tok.slice(2, eq) : tok.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq !== -1) return usageFail(`--${key} takes no value`);
      args[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      const value = eq !== -1 ? tok.slice(eq + 1) : argv[++i];
      if (value === undefined || value.trim() === "" || (eq === -1 && value.startsWith("--"))) {
        return usageFail(`--${key} requires a value`);
      }
      args[key] = value;
    } else {
      return usageFail(`unknown flag: --${key}`);
    }
  }
  return args;
}

// Strip fenced code blocks (``` or ~~~) so a value shown inside an example can
// never be read as the canonical statement. Inline code spans are KEPT — the
// canonical statement routinely wraps the value in backticks (e.g. **`2.2.0`**).
export function stripCodeFences(text) {
  const lines = text.split("\n");
  const out = [];
  let fence = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (fence === null) {
      const m = trimmed.match(/^(```+|~~~+)/);
      if (m) {
        fence = m[1][0].repeat(m[1].length);
        continue;
      }
      out.push(line);
    } else {
      const m = trimmed.match(/^(```+|~~~+)\s*$/);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
        fence = null;
      }
    }
  }
  return out.join("\n");
}

// Compile a user-supplied pattern; reject anything that is not exactly-one
// capture group (the captured value IS the comparison key, so the contract is
// unambiguous). We count groups by probing against the empty string with an
// Count capture groups in a compiled regex. `RegExp.prototype.exec` on a
// guaranteed-match probe is fragile, so we read the group count off a match
// against a string the engine builds for us: append an alternation that always
// matches empty, then the resulting match array length minus 1 is the group
// count. We construct that probe regex and exec it against "".
function countCaptureGroups(pattern, where) {
  let probe;
  try {
    probe = new RegExp(`${pattern}|`);
  } catch (e) {
    return { error: `${where}: invalid regex ${JSON.stringify(pattern)} — ${e.message}` };
  }
  const m = probe.exec("");
  // m is non-null (the trailing `|` matches empty); m.length-1 == group count.
  return { count: m.length - 1 };
}

// Extract the single captured value, enforcing EXACTLY-ONE capture group AND
// EXACTLY-ONE total match across the (already fence-stripped, if requested)
// text. Returns { value } or { error }. Both "exactly one" rules are what keep
// the gate from passing vacuously on an ambiguous/multi-group pattern that
// happens to capture a partial value (e.g. only the MAJOR).
export function extractValue(text, pattern, where) {
  let re;
  try {
    re = new RegExp(pattern, "gm");
  } catch (e) {
    return { error: `${where}: invalid regex ${JSON.stringify(pattern)} — ${e.message}` };
  }
  const groups = countCaptureGroups(pattern, where);
  if (groups.error) return { error: groups.error };
  if (groups.count !== 1) {
    return {
      error: `${where}: pattern ${JSON.stringify(pattern)} has ${groups.count} capture group(s) — it must have EXACTLY ONE around the whole value (a partial group, e.g. capturing only the MAJOR, can pass vacuously)`,
    };
  }
  const matches = [];
  let m;
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    if (m[1] === undefined) {
      return { error: `${where}: pattern matched but capture group 1 is undefined — the pattern must have exactly one capture group around the value` };
    }
    matches.push(m[1]);
    if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
    if (++guard > 100000) return { error: `${where}: pattern produced runaway matches` };
  }
  if (matches.length === 0) {
    return { error: `${where}: pattern ${JSON.stringify(pattern)} did not match (the documented/code line moved or was deleted — drift)` };
  }
  if (matches.length > 1) {
    return {
      error: `${where}: pattern ${JSON.stringify(pattern)} matched ${matches.length} times (ambiguous — anchor it to the canonical line, e.g. with ^…$, so it reads the live value and not a changelog/comment/example)`,
    };
  }
  return { value: matches[0] };
}

// Read a value from a JSON file by dot-path pointer (e.g. "cinatra.sdkAbiVersion").
export function extractJsonValue(text, pointer, where) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: `${where}: not valid JSON — ${e.message}` };
  }
  const parts = pointer.split(".").filter((p) => p.length > 0);
  let node = data;
  for (const p of parts) {
    if (node === null || typeof node !== "object" || !(p in node)) {
      return { error: `${where}: JSON pointer ${JSON.stringify(pointer)} not found` };
    }
    node = node[p];
  }
  if (typeof node !== "string") {
    return { error: `${where}: JSON pointer ${JSON.stringify(pointer)} resolved to a ${typeof node}, expected a string value` };
  }
  return { value: node };
}

// Resolve one side ({ file, pattern? | pointer?, type?, stripFences? }) to a value.
export function resolveSide(root, side, where) {
  if (!side || typeof side !== "object") return { error: `${where}: side must be an object` };
  if (typeof side.file !== "string" || side.file.length === 0) {
    return { error: `${where}: missing "file"` };
  }
  if (path.isAbsolute(side.file)) {
    return { error: `${where}: "file" must be a repo-relative path, not absolute (${side.file})` };
  }
  const abs = path.resolve(root, side.file);
  // Confine to the checkout: a config must not point the scan at a runner file
  // outside the repo (e.g. via `..`), which could leak captured content to logs.
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { error: `${where}: "file" escapes the repo root (${side.file})` };
  }
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (e) {
    return { error: `${where}: cannot read ${side.file} — ${e.message}` };
  }
  const isJson = side.type === "json";
  if (isJson) {
    if (typeof side.pointer !== "string" || side.pointer.length === 0) {
      return { error: `${where}: JSON side requires a "pointer"` };
    }
    return extractJsonValue(text, side.pointer, `${where}[${side.file}]`);
  }
  if (typeof side.pattern !== "string" || side.pattern.length === 0) {
    return { error: `${where}: side requires a "pattern" (or set type:"json" + "pointer")` };
  }
  const isDoc = side.type === "doc" || (side.type === undefined && /\.(md|markdown|mdx)$/i.test(side.file));
  const stripFences = side.stripFences === undefined ? isDoc : !!side.stripFences;
  const scanned = stripFences ? stripCodeFences(text) : text;
  return extractValue(scanned, side.pattern, `${where}[${side.file}]`);
}

// Run a list of assertions; returns { results, ok }.
export function runAssertions(root, assertions) {
  const results = [];
  for (let i = 0; i < assertions.length; i++) {
    const a = assertions[i];
    const label = a.label || `assertion #${i + 1}`;
    const where = `${label}`;
    const doc = resolveSide(root, a.doc, `${where}.doc`);
    const code = resolveSide(root, a.code, `${where}.code`);
    const errors = [];
    if (doc.error) errors.push(doc.error);
    if (code.error) errors.push(code.error);
    let ok = false;
    if (errors.length === 0) {
      ok = doc.value === code.value;
      if (!ok) {
        errors.push(
          `${where}: doc value ${JSON.stringify(doc.value)} (${a.doc.file}) != code value ${JSON.stringify(code.value)} (${a.code.file})`,
        );
      }
    }
    results.push({ label, ok, docValue: doc.value, codeValue: code.value, errors });
  }
  return { results, ok: results.every((r) => r.ok) };
}

function loadConfig(root, configPath) {
  const abs = path.resolve(root, configPath);
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (e) {
    usageFail(`cannot read --config ${configPath} — ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    usageFail(`--config ${configPath} is not valid JSON — ${e.message}`);
  }
  const assertions = Array.isArray(data) ? data : data.assertions;
  if (!Array.isArray(assertions) || assertions.length === 0) {
    usageFail(`--config ${configPath} must be a non-empty array of assertions (or { "assertions": [...] })`);
  }
  return assertions;
}

function assertionFromFlags(args) {
  const need = (k) => {
    if (args[k] === undefined) usageFail(`without --config you must pass --${k} (or use --config for multi-assertion)`);
    return args[k];
  };
  return [
    {
      label: args.label || "doc==code",
      doc: { file: need("doc-file"), pattern: need("doc-pattern") },
      code: { file: need("code-file"), pattern: need("code-pattern") },
    },
  ];
}

function main(argv) {
  const args = parseArgs(argv);
  const root = args.root ? path.resolve(args.root) : process.cwd();
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    usageFail(`--root ${root} is not a directory`);
  }
  const assertions = args.config ? loadConfig(root, args.config) : assertionFromFlags(args);

  const { results, ok } = runAssertions(root, assertions);

  for (const r of results) {
    if (r.ok) {
      process.stdout.write(`[doc-code-value-gate] PASS — ${r.label}: ${JSON.stringify(r.docValue)}\n`);
    } else {
      for (const e of r.errors) process.stderr.write(`[doc-code-value-gate] FAIL — ${e}\n`);
    }
  }

  if (ok) {
    process.stdout.write(`[doc-code-value-gate] PASS — ${results.length} assertion(s) hold.\n`);
    process.exit(0);
  }
  const failed = results.filter((r) => !r.ok).length;
  process.stderr.write(`[doc-code-value-gate] FAIL — ${failed}/${results.length} assertion(s) failed.\n`);
  process.exit(1);
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isDirect) {
  main(process.argv.slice(2));
}
