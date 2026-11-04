#!/usr/bin/env node
// ---------------------------------------------------------------------------
// agent-publish-gate: the publish check for ONE agent pack, run in the pack's CI.
// The host stops a run in front of every flow step declared
// `metadata.cinatra.publishes: true` and asks one person to confirm. Rules:
//   oas.publish-undeclared   a step that can reach a connector declares
//     `publishes` true or false. Allow-list: only the kinds StartNode, EndNode,
//     InputMessageNode, OutputMessageNode, BranchingNode and a riskClass of
//     exactly `read_only` are exempt; a listed step whose component is not in
//     the file is refused, since its declaration cannot be read.
//   oas.publish-malformed    `publishes` is present and not a JSON boolean.
//   oas.publish-reserved-id  an id, a referenced-component key or a reference
//     takes the host's gate prefix.
//   oas.publish-own-gate     the pack keeps its own confirm or approval step in
//     front of a publishing step: an InputMessageNode with a control edge into
//     it, directly or through BranchingNodes only; `requiresApproval: true` on
//     the step; or a root `hitlScreens` entry, unless this package declares the
//     screen's renderer and it is not `midRunHitl`.
// The flow is `cinatra/oas.json`; a pack without one passes and says so. A
// package that is not an agent pack, an unreadable file and an unknown option
// are errors, never a pass. Findings name ids only, never a value or a kind
// the pack wrote. Node built-ins only.
// Usage: node scripts/agent-publish-gate.mjs [--package <dir>] [--format text|json]
// Exit codes: 0 = pass, 1 = findings, 2 = error.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLISH_GATE_ID_PREFIX = "cinatra_publish_gate__";

export const RULES = Object.freeze([
  "oas.publish-undeclared",
  "oas.publish-malformed",
  "oas.publish-reserved-id",
  "oas.publish-own-gate",
]);

// The kinds that cannot reach a connector, so they need no declaration.
const NO_CONNECTOR_KINDS = new Set(["StartNode", "EndNode", "InputMessageNode", "OutputMessageNode", "BranchingNode"]);

export class GateError extends Error {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cinatraOf(component) {
  const metadata = component?.metadata;
  if (!isObject(metadata)) return null;
  return isObject(metadata.cinatra) ? metadata.cinatra : null;
}

function readPublishes(component) {
  const cinatra = cinatraOf(component);
  if (!cinatra || !Object.hasOwn(cinatra, "publishes")) return { present: false };
  return { present: true, value: cinatra.publishes };
}

function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

// The id quoted with JSON escaping and cut at 120 characters; U+2028 and
// U+2029, which JSON.stringify leaves as they are, are escaped too.
export function quoteId(id) {
  const text = String(id);
  return JSON.stringify(text.length > 120 ? `${text.slice(0, 120)}...` : text)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function isNodeKind(kind) {
  return typeof kind === "string" && kind.endsWith("Node");
}

// Check one parsed flow. `fieldRenderers` is the package's
// `cinatra.fieldRenderers` list (it is read for the hitlScreens rule only).
export function checkAgentFlow(flow, { fieldRenderers = [] } = {}) {
  if (!isObject(flow)) throw new GateError("the flow is not a JSON object");
  const findings = [];
  const seen = new Set();
  const add = (rule, name, message) => {
    const key = `${rule}\u0000${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, node: name, message });
  };

  const keyOf = new WeakMap(); // component -> its key in a $referenced_components map
  const nameOf = (component) => keyOf.get(component) ?? (typeof component.id === "string" ? component.id : "(no id)");
  const nodes = []; // node components, in file order
  const nodeSet = new Set();
  const flows = []; // { component, chain }: every component that lists nodes or control edges

  const reserved = (candidate) => {
    if (typeof candidate === "string" && candidate.startsWith(PUBLISH_GATE_ID_PREFIX)) {
      add("oas.publish-reserved-id", candidate, `${quoteId(candidate)} uses the reserved prefix "${PUBLISH_GATE_ID_PREFIX}"`);
    }
  };

  const checkNode = (component) => {
    if (nodeSet.has(component)) return;
    nodeSet.add(component);
    nodes.push(component);
    const flag = readPublishes(component);
    if (flag.present) return; // a malformed value is reported by the walk, for every component
    if (NO_CONNECTOR_KINDS.has(component.component_type)) return;
    if (cinatraOf(component)?.riskClass === "read_only") return;
    add(
      "oas.publish-undeclared",
      nameOf(component),
      `node ${quoteId(nameOf(component))} can reach a connector but declares no metadata.cinatra.publishes; declare true if the step publishes, false if it does not`,
    );
  };

  // The walk: every object in the file, in file order. `chain` is the list of
  // $referenced_components maps in scope, nearest first.
  const walk = (value, chain, key) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, chain, undefined);
      return;
    }
    if (!isObject(value)) return;
    if (key !== undefined) keyOf.set(value, key);
    reserved(key);
    if (key !== undefined || typeof value.component_type === "string") reserved(value.id);
    reserved(value.$component_ref);
    const refs = isObject(value.$referenced_components) ? value.$referenced_components : null;
    const scope = refs ? [refs, ...chain] : chain;
    const flag = readPublishes(value);
    if (flag.present && typeof flag.value !== "boolean") {
      const name = nameOf(value);
      add(
        "oas.publish-malformed",
        name,
        `${quoteId(name)} declares metadata.cinatra.publishes as ${describeType(flag.value)}; it must be the JSON boolean true or false`,
      );
    }
    if (isNodeKind(value.component_type)) checkNode(value);
    if (Array.isArray(value.nodes) || Array.isArray(value.control_flow_connections)) flows.push({ component: value, chain: scope });
    for (const [field, child] of Object.entries(value)) {
      if (field === "$referenced_components" && refs) {
        for (const [refKey, component] of Object.entries(refs)) walk(component, scope, refKey);
      } else {
        walk(child, scope, undefined);
      }
    }
  };
  walk(flow, [], undefined);

  const resolveRef = (ref, chain) => {
    for (const refs of chain) {
      if (Object.hasOwn(refs, ref) && isObject(refs[ref])) return refs[ref];
    }
    return null;
  };
  // A reference or an inline component, resolved to the component.
  const resolveEntry = (entry, chain) => {
    if (!isObject(entry)) return null;
    if (typeof entry.$component_ref === "string") return resolveRef(entry.$component_ref, chain);
    return entry;
  };

  // Every component a flow lists as a node is a node, whatever its kind.
  for (const { component, chain } of flows) {
    if (!Array.isArray(component.nodes)) continue;
    for (const entry of component.nodes) {
      const target = resolveEntry(entry, chain);
      if (target) {
        checkNode(target);
      } else if (isObject(entry) && typeof entry.$component_ref === "string") {
        add(
          "oas.publish-undeclared",
          entry.$component_ref,
          `node ${quoteId(entry.$component_ref)} is listed in a flow, but its component is not in the file, so its declaration cannot be read`,
        );
      }
    }
  }

  const publishing = nodes.filter((component) => readPublishes(component).value === true);
  if (publishing.length === 0) return findings;

  // Control edges, as predecessor lists.
  const predecessors = new Map();
  for (const { component, chain } of flows) {
    if (!Array.isArray(component.control_flow_connections)) continue;
    for (const entry of component.control_flow_connections) {
      const edge = resolveEntry(entry, chain);
      if (!edge) continue;
      const from = resolveEntry(edge.from_node, chain);
      const to = resolveEntry(edge.to_node, chain);
      if (!from || !to) continue;
      if (!predecessors.has(to)) predecessors.set(to, []);
      predecessors.get(to).push(from);
    }
  }

  const ownGate = (name, message) => add("oas.publish-own-gate", name, message);
  for (const step of publishing) {
    const stepName = nameOf(step);
    if (cinatraOf(step)?.requiresApproval === true) {
      ownGate(
        stepName,
        `publishing node ${quoteId(stepName)} also declares metadata.cinatra.requiresApproval: true; the host's publish confirmation is the one approval in front of it`,
      );
    }
    // Walk back from the step through BranchingNodes only.
    const visited = new Set([step]);
    const queue = [...(predecessors.get(step) ?? [])];
    while (queue.length > 0) {
      const before = queue.shift();
      if (visited.has(before)) continue;
      visited.add(before);
      if (before.component_type === "InputMessageNode") {
        const gateName = nameOf(before);
        ownGate(
          gateName,
          `node ${quoteId(gateName)} waits for a person in front of publishing node ${quoteId(stepName)}; the host stops the run there itself, so the pack keeps no confirm step of its own`,
        );
      } else if (before.component_type === "BranchingNode") {
        queue.push(...(predecessors.get(before) ?? []));
      }
    }
  }

  // Root hitlScreens beside a publishing step.
  const rootCinatra = cinatraOf(flow);
  if (rootCinatra && Object.hasOwn(rootCinatra, "hitlScreens")) {
    const screens = rootCinatra.hitlScreens;
    const renderers = Array.isArray(fieldRenderers) ? fieldRenderers.filter(isObject) : [];
    let offending = null;
    if (!Array.isArray(screens)) {
      offending = "a hitlScreens value that is not a list of screen ids";
    } else {
      for (const screen of screens) {
        const renderer = typeof screen === "string" ? renderers.find((r) => r.id === screen) : undefined;
        if (!renderer || renderer.midRunHitl === true) {
          offending = typeof screen === "string" ? `hitlScreens entry ${quoteId(screen)}` : "a hitlScreens entry that is not a screen id";
          break;
        }
      }
    }
    if (offending) {
      for (const step of publishing) {
        const stepName = nameOf(step);
        ownGate(
          stepName,
          `the flow root lists ${offending} beside publishing node ${quoteId(stepName)}; a mid-run screen (or one this package does not declare) would be a confirm step of the pack's own`,
        );
      }
    }
  }

  return findings;
}

function readJson(file, what) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new GateError(`cannot read ${what} (${error.code ?? "read error"})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GateError(`${what} is not valid JSON`);
  }
}

// Check one pack directory: its package.json must declare cinatra.kind
// "agent"; its flow is cinatra/oas.json.
export function checkAgentPackage(dir) {
  const pkg = readJson(join(dir, "package.json"), "package.json");
  if (!isObject(pkg)) throw new GateError("package.json is not a JSON object");
  const cinatra = isObject(pkg.cinatra) ? pkg.cinatra : {};
  if (cinatra.kind !== "agent") throw new GateError("the package is not an agent pack (package.json cinatra.kind is not \"agent\")");
  const packageName = typeof pkg.name === "string" ? pkg.name : "(no name)";
  const flowFile = join(dir, "cinatra", "oas.json");
  if (!existsSync(flowFile)) return { status: "no-flow", packageName, findings: [] };
  const flow = readJson(flowFile, "cinatra/oas.json");
  if (!isObject(flow)) throw new GateError("cinatra/oas.json is not a JSON object");
  return { status: "checked", packageName, findings: checkAgentFlow(flow, { fieldRenderers: cinatra.fieldRenderers }) };
}

const USAGE = "Usage: agent-publish-gate [--package <dir>] [--format text|json]";

function parseArgs(argv) {
  const out = { package: ".", format: "text", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--package" || arg === "--format") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new GateError(`${arg} needs a value`);
      out[arg.slice(2)] = value;
    } else throw new GateError(`unknown option ${quoteId(arg)}`);
  }
  if (out.format !== "text" && out.format !== "json") throw new GateError("--format must be text or json");
  return out;
}

function main(argv) {
  let args;
  let result;
  try {
    args = parseArgs(argv);
    if (args.help) {
      console.log(USAGE);
      return 0;
    }
    result = checkAgentPackage(resolve(args.package));
  } catch (error) {
    const message = error instanceof GateError ? error.message : `internal error (${error?.name ?? "unknown"})`;
    console.error(`agent-publish-gate: ERROR ${message}`);
    if (!(error instanceof GateError)) console.error(USAGE);
    return 2;
  }
  const pass = result.findings.length === 0;
  if (args.format === "json") {
    console.log(JSON.stringify({ package: result.packageName, status: pass ? "pass" : "fail", flow: result.status === "checked", findings: result.findings }, null, 2));
  } else {
    console.log(`agent-publish-gate: package ${quoteId(result.packageName)}`);
    if (result.status === "no-flow") {
      console.log("agent-publish-gate: PASS, no cinatra/oas.json in the package (no flow to check)");
    } else {
      for (const finding of result.findings) console.log(`${finding.rule}: ${finding.message}`);
      console.log(pass ? "agent-publish-gate: PASS, 0 findings" : `agent-publish-gate: FAIL, ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}`);
    }
  }
  return pass ? 0 : 1;
}

// Run only as the entry module. Both paths are compared as real paths, so a
// caller that reaches the file through a symbolic link still runs the gate.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = main(process.argv.slice(2));
}
