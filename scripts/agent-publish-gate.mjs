#!/usr/bin/env node
// agent-publish-gate: the external-write check for ONE agent pack's flow (`cinatra/oas.json`),
// run in the pack's CI. An external write is any create, change or delete of data in a system
// outside Cinatra (sending an email counts); the key `metadata.cinatra.publishes` declares it.
// The five rules, what counts as a step, the texts and the exit codes are in README.md, section
// "agent-publish-gate". The gate reads what a pack declares; it cannot see what a step does.
// Node built-ins only.
// Usage: node scripts/agent-publish-gate.mjs [--package <dir>] [--format text|json]
// Exit codes: 0 = pass, 1 = findings, 2 = error.

import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLISH_GATE_ID_PREFIX = "cinatra_publish_gate__";

export const RULES = Object.freeze([
  "oas.publish-undeclared",
  "oas.publish-malformed",
  "oas.publish-misplaced",
  "oas.publish-reserved-id",
  "oas.publish-own-gate",
]);

// The fields of a flow that name its steps.
const FLOW_FIELDS = ["nodes", "start_node", "control_flow_connections", "data_flow_connections"];
// The fields of an edge that name a step.
const EDGE_ENDS = { control_flow_connections: ["from_node", "to_node"], data_flow_connections: ["source_node", "destination_node"] };

// The kinds that cannot reach a connector, so they need no declaration.
const NO_CONNECTOR_KINDS = new Set(["StartNode", "EndNode", "InputMessageNode", "OutputMessageNode", "BranchingNode"]);
// The kinds that run a subflow, and the field that names it.
const SUBFLOW_KINDS = new Set(["FlowNode", "MapNode", "ParallelMapNode"]);
const SUBFLOWS_KINDS = new Set(["ParallelFlowNode"]);
const CORE_MID_RUN_ENDINGS = [":output", "-output", ":list-picker", ":scrape-schema-review", ":final-list-review", ":setup-form"];

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

// A text cut at 120 characters.
function cutText(value) {
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

// JSON text with U+2028 and U+2029 escaped (JSON.stringify leaves them as they are).
function escapeLineSeparators(json) {
  return json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// The id quoted with JSON escaping, cut at 120 characters, on one line.
export function quoteId(id) {
  return escapeLineSeparators(JSON.stringify(cutText(id)));
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
  const scopeOf = new WeakMap(); // object -> the $referenced_components maps in scope at it, nearest first
  const nameOf = (component) => keyOf.get(component) ?? (typeof component.id === "string" ? component.id : "(no id)");
  const nodes = []; // node components, in file order
  const nodeSet = new Set();
  const flows = []; // every object with a field of FLOW_FIELDS
  const declaringTrue = []; // every object that declares publishes true, in file order

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
      `node ${quoteId(nameOf(component))} can reach a connector but declares no metadata.cinatra.publishes; declare true if the step makes an external write (it creates, changes or deletes data in a system outside Cinatra; sending an email counts), false if it does not`,
    );
  };

  // The walk: every value in the file, in file order. `chain` is the list of
  // $referenced_components maps in scope, nearest first.
  const walk = (value, chain, key) => {
    reserved(key);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, chain, undefined);
      return;
    }
    if (!isObject(value)) return;
    if (key !== undefined) keyOf.set(value, key);
    reserved(value.id);
    reserved(value.$component_ref);
    const refs = isObject(value.$referenced_components) ? value.$referenced_components : null;
    const scope = refs ? [refs, ...chain] : chain;
    scopeOf.set(value, scope);
    const flag = readPublishes(value);
    if (flag.value === true) declaringTrue.push(value);
    if (flag.present && typeof flag.value !== "boolean") {
      const name = nameOf(value);
      add(
        "oas.publish-malformed",
        name,
        `${quoteId(name)} declares metadata.cinatra.publishes as ${describeType(flag.value)}; it must be the JSON boolean true or false`,
      );
    }
    if (isNodeKind(value.component_type)) checkNode(value);
    if (FLOW_FIELDS.some((field) => value[field] !== undefined)) flows.push(value);
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
  const ownMap = (value) => (isObject(value.$referenced_components) ? [value.$referenced_components] : []);
  // The components an object names: itself, or what its reference resolves to, both in the maps in scope where
  // the reference is written and in those where it is used (`chain`). A reference to a reference is followed.
  const resolveAll = (entry, chain, seen = new Set()) => {
    if (typeof entry.$component_ref !== "string") return [entry];
    if (seen.has(entry)) return [];
    seen.add(entry);
    const ref = entry.$component_ref;
    const found = new Set([resolveRef(ref, scopeOf.get(entry) ?? []), resolveRef(ref, [...ownMap(entry), ...chain])]);
    return [...found].filter(Boolean).flatMap((target) => resolveAll(target, chain, seen));
  };

  // Every component a flow lists in `nodes`, names as `start_node` or reaches as an edge endpoint is a step,
  // whatever its kind. A value there that is neither a component nor a reference, and a listed step whose component
  // is not in the file, are refused; a start node, edge or endpoint whose component is not in the file names
  // nothing that can run. Control edges are kept as predecessor lists.
  const predecessors = new Map();
  const stepsOf = new Map(); // flow holder -> the components it lists, starts at or reaches by an edge
  for (const holder of flows) {
    const holderSteps = new Set();
    stepsOf.set(holder, holderSteps);
    const holderName = nameOf(holder);
    const stepsAt = (field, value, chain) => {
      if (value === undefined) return [];
      if (!isObject(value)) {
        add("oas.publish-undeclared", holderName, `flow ${quoteId(holderName)} has a value in ${field} that is neither a component nor a reference, so the step it names cannot be checked`);
        return [];
      }
      const found = resolveAll(value, chain);
      if (field !== "control_flow_connections" && field !== "data_flow_connections") found.forEach((step) => holderSteps.add(step));
      if (field === "nodes" && found.length === 0) {
        add("oas.publish-undeclared", value.$component_ref, `node ${quoteId(value.$component_ref)} is listed in a flow, but its component is not in the file, so its declaration cannot be read`);
      }
      return found;
    };
    const chain = scopeOf.get(holder);
    for (const entry of Array.isArray(holder.nodes) ? holder.nodes : []) stepsAt("nodes", entry ?? null, chain).forEach(checkNode);
    stepsAt("start_node", holder.start_node, chain).forEach(checkNode);
    for (const [field, [first, second]] of Object.entries(EDGE_ENDS)) {
      for (const entry of Array.isArray(holder[field]) ? holder[field] : []) {
        for (const edge of stepsAt(field, entry ?? null, chain)) {
          const at = [...ownMap(edge), ...chain];
          const [froms, tos] = [stepsAt(field, edge[first], at), stepsAt(field, edge[second], at)];
          [...froms, ...tos].forEach((step) => holderSteps.add(step));
          [...froms, ...tos].forEach(checkNode);
          if (field === "control_flow_connections") for (const to of tos) predecessors.set(to, [...(predecessors.get(to) ?? []), ...froms]);
        }
      }
    }
  }

  // The steps that run: those of the root flow, and of every subflow that a running step runs, references followed.
  // Only these kinds run a subflow (Agent Spec): FlowNode, MapNode and ParallelMapNode through `subflow`,
  // ParallelFlowNode through `subflows`. A subflow field on any other kind, and a flow-shaped value anywhere else
  // (inside metadata, a subflow definition no running step runs), runs nothing, so its steps are not here.
  const subflowsRunBy = (step) => {
    if (SUBFLOW_KINDS.has(step.component_type)) return isObject(step.subflow) ? [step.subflow] : [];
    if (SUBFLOWS_KINDS.has(step.component_type)) return (Array.isArray(step.subflows) ? step.subflows : []).filter(isObject);
    return [];
  };
  const flowSteps = new Set();
  const runningFlows = new Set();
  const flowQueue = stepsOf.has(flow) ? [flow] : [];
  while (flowQueue.length > 0) {
    const holder = flowQueue.shift();
    if (runningFlows.has(holder)) continue;
    runningFlows.add(holder);
    for (const step of stepsOf.get(holder)) {
      flowSteps.add(step);
      const runs = subflowsRunBy(step);
      for (const sub of runs) {
        for (const target of resolveAll(sub, scopeOf.get(step) ?? [])) if (stepsOf.has(target)) flowQueue.push(target);
      }
    }
  }

  // Every object that declares publishes true, in file order. Only a component that the root flow lists in `nodes`
  // by a reference to a key of its own $referenced_components can carry it, and only when that reference resolves
  // to exactly that component (no nearer map shadows the key, and the component is no reference wrapper). The core
  // refuses true on a node inside a nested subflow, a subflow definition, the flow root and a root map component
  // the root does not list (cinatra-ai/cinatra packages/agents/src/oas-compiler.ts, collectPublishingSteps,
  // PUBLISHES_MISPLACED). The gate is stricter on purpose: it also refuses true on an inline node in the root
  // `nodes` list, a wrapper or a shadowed key, which the core does not read as a publishing step (no stop).
  const rootRefs = isObject(flow.$referenced_components) ? flow.$referenced_components : {};
  const topLevel = new Set();
  for (const entry of Array.isArray(flow.nodes) ? flow.nodes : []) {
    const ref = isObject(entry) ? entry.$component_ref : undefined;
    if (typeof ref !== "string" || !Object.hasOwn(rootRefs, ref) || !isObject(rootRefs[ref])) continue;
    const target = rootRefs[ref];
    if (typeof target.$component_ref === "string") continue;
    const resolved = resolveAll(entry, scopeOf.get(flow) ?? []);
    if (resolved.length > 0 && resolved.every((component) => component === target)) topLevel.add(target);
  }
  for (const holder of declaringTrue) {
    if (topLevel.has(holder)) continue;
    const name = holder === flow ? "(flow root)" : nameOf(holder);
    add(
      "oas.publish-misplaced",
      name,
      `${holder === flow ? "the flow root" : quoteId(name)} declares metadata.cinatra.publishes true but is not a top-level node of the flow; only a node that the root flow lists in nodes can carry it, since the host cannot stop the run in front of any other`,
    );
  }

  const publishing = nodes.filter((component) => readPublishes(component).value === true);
  if (publishing.length === 0) return findings;

  const ownGate = (name, message) => add("oas.publish-own-gate", name, message);
  for (const step of publishing) {
    const stepName = nameOf(step);
    const stepCinatra = cinatraOf(step);
    if (stepCinatra && Object.hasOwn(stepCinatra, "requiresApproval") && stepCinatra.requiresApproval !== false) {
      ownGate(
        stepName,
        `publishing node ${quoteId(stepName)} declares a metadata.cinatra.requiresApproval that is not false; the host's publish confirmation is to be the one approval in front of it`,
      );
    }
    if (stepCinatra && Object.hasOwn(stepCinatra, "confirmations") && !(Array.isArray(stepCinatra.confirmations) && stepCinatra.confirmations.length === 0)) {
      ownGate(
        stepName,
        `publishing node ${quoteId(stepName)} declares a metadata.cinatra.confirmations that is not an empty list; the host's publish confirmation is to be the one approval in front of it`,
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
          `node ${quoteId(gateName)} waits for a person in front of publishing node ${quoteId(stepName)}; the host's publish confirmation is to be the one stop there, so the pack keeps no confirm step of its own`,
        );
      } else if (before.component_type === "BranchingNode") {
        queue.push(...(predecessors.get(before) ?? []));
      }
    }
  }

  // Root hitlScreens in front of a publishing step. A screen is placed on every step whose
  // metadata.cinatra.renderer names it: a running step (above). A renderer on any other object (a reference wrapper,
  // a component no running flow uses, a step of a flow-shaped value that does not run) places nothing. It stands in front of a publishing step when one of those steps is in
  // the step itself (its own subflow included) or on a control path back from the step that ends at the first
  // InputMessageNode (the person's last stop before the write) or at another publishing step. A screen that no
  // step names counts as in front of every publishing step. A screen placed only elsewhere (after the write,
  // or in front of an earlier stop) is not a confirm step of this write.
  const rootCinatra = cinatraOf(flow);
  if (rootCinatra && Object.hasOwn(rootCinatra, "hitlScreens")) {
    const screens = rootCinatra.hitlScreens;
    const renderers = Array.isArray(fieldRenderers) ? fieldRenderers.filter(isObject) : [];
    const placedOn = new Map(); // screen id -> the components that name it as their renderer
    for (const component of flowSteps) {
      if (typeof component.$component_ref === "string") continue;
      const renderer = cinatraOf(component)?.renderer;
      if (typeof renderer === "string") placedOn.set(renderer, [...(placedOn.get(renderer) ?? []), component]);
    }
    const inFrontOf = (step) => {
      const front = new Set();
      // A step and what it holds: every object inside it, references followed.
      const insideSeen = new Set();
      const addHeld = (start) => {
        const inside = [start];
        while (inside.length > 0) {
          const value = inside.pop();
          if (Array.isArray(value)) {
            inside.push(...value);
            continue;
          }
          if (!isObject(value) || insideSeen.has(value)) continue;
          insideSeen.add(value);
          front.add(value);
          if (typeof value.$component_ref === "string") inside.push(...resolveAll(value, scopeOf.get(value) ?? []));
          inside.push(...Object.values(value));
        }
      };
      addHeld(step);
      // The control paths back from the step, to the first stop or the first other publishing step. What a step
      // on that path holds (a subflow it runs) is in front too; an earlier publishing step's own content is its own.
      const visited = new Set([step]);
      const queue = [...(predecessors.get(step) ?? [])];
      while (queue.length > 0) {
        const before = queue.shift();
        if (visited.has(before)) continue;
        visited.add(before);
        front.add(before);
        if (readPublishes(before).value === true) continue;
        addHeld(before);
        if (before.component_type === "InputMessageNode") continue;
        queue.push(...(predecessors.get(before) ?? []));
      }
      return front;
    };
    const fronts = new Map(publishing.map((step) => [step, inFrontOf(step)]));
    const offendingFor = new Map(); // publishing step -> the first offending screen text
    const offendAll = (text) => {
      for (const step of publishing) if (!offendingFor.has(step)) offendingFor.set(step, text);
    };
    if (!Array.isArray(screens)) {
      offendAll("a hitlScreens value that is not a list of screen ids");
    } else {
      // A screen passes only when this package declares its renderer exactly once, with midRunHitl false or
      // without the key, and its id has no ending in CORE_MID_RUN_ENDINGS. The core reads the key as mid-run only
      // when it is true, and those endings as mid-run whatever is declared (cinatra-ai/cinatra at 9ee9adf8,
      // packages/agents/src/orchestrator-mid-run-hitl.ts:24-28 and 40-50). Any other value, or a second entry, is
      // refused, but only beside the publishing steps it stands in front of.
      for (const screen of screens) {
        const matches = typeof screen === "string" ? renderers.filter((r) => r.id === screen) : [];
        const notMidRun = matches.length === 1 && (!Object.hasOwn(matches[0], "midRunHitl") || matches[0].midRunHitl === false) && !CORE_MID_RUN_ENDINGS.some((end) => screen.endsWith(end));
        if (notMidRun) continue;
        if (typeof screen !== "string") {
          offendAll("a hitlScreens entry that is not a screen id");
          continue;
        }
        const text = `hitlScreens entry ${quoteId(screen)}`;
        const places = placedOn.get(screen) ?? [];
        for (const step of publishing) {
          if (offendingFor.has(step)) continue;
          if (places.length === 0 || places.some((place) => fronts.get(step).has(place))) offendingFor.set(step, text);
        }
      }
    }
    for (const step of publishing) {
      if (!offendingFor.has(step)) continue;
      const stepName = nameOf(step);
      ownGate(
        stepName,
        `the flow root lists ${offendingFor.get(step)} in front of publishing node ${quoteId(stepName)}; only a screen whose renderer this package declares once, with midRunHitl false or without it, and whose id has no ending the core reads as mid-run, is not a confirm step of the pack's own`,
      );
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
  // Only a missing path is "no flow"; any other failure to read it is an error.
  try {
    lstatSync(flowFile);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "no-flow", packageName, findings: [] };
    throw new GateError(`cannot read cinatra/oas.json (${error?.code ?? "read error"})`);
  }
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
      if (value === undefined || value.startsWith("-")) throw new GateError(`${arg} needs a value`);
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
    // The same cut as the text output; the messages already quote cut ids.
    const findings = result.findings.map((finding) => ({ ...finding, node: cutText(finding.node) }));
    const report = { package: cutText(result.packageName), status: pass ? "pass" : "fail", flow: result.status === "checked", findings };
    console.log(escapeLineSeparators(JSON.stringify(report, null, 2)));
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
