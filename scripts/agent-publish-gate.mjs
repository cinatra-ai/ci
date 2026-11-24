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
// The renderer the core selects for an InputMessageNode that names none (cinatra-ai/cinatra at 5ea6501c,
// packages/agents/src/agent-builder-ids.ts:36-47, used at oas-compiler.ts:1928).
export const SCHEMA_FIELD_FALLBACK_RENDERER_ID = "@cinatra-ai/agent-builder:schema-field-fallback";
const CORE_MID_RUN_ENDINGS = [":output", "-output", ":list-picker", ":scrape-schema-review", ":final-list-review", ":setup-form"];
// The riskClass values of a step that asks a person to approve or to send: such a step is a confirm of a later write
// even with work steps between them.
const CONFIRM_RISK_CLASSES = new Set(["approval", "test_send"]);

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

// A step that does no work between a stop and a later write, so a walk back from the write crosses it: a kind that
// cannot reach a connector (an InputMessageNode is a stop, never crossed) or a step declared riskClass read_only.
// A step declared publishes true is another write and is never crossed.
function isPassThrough(step) {
  if (readPublishes(step).value === true || step.component_type === "InputMessageNode") return false;
  return NO_CONNECTOR_KINDS.has(step.component_type) || cinatraOf(step)?.riskClass === "read_only";
}

// A confirmations value that the host can serve: a list whose every entry is an object that names the host's
// publish decision (`decision: "publish"`) and no gate renderer of the pack's own. An empty list is allowed.
function isPublishDecisionList(value) {
  return Array.isArray(value) && value.every((entry) => isObject(entry) && entry.decision === "publish" && !Object.hasOwn(entry, "gateRenderer"));
}

// True when `value` holds an "x-renderer" key at any depth (a field renderer the pack selects in a schema).
function holdsXRenderer(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value) && Object.hasOwn(value, "x-renderer")) return true;
  return Object.values(value).some((child) => holdsXRenderer(child, seen));
}

// A host review step (owner ruling 1204 B: the application opens its publish card only after a review approved
// earlier in the same run): an InputMessageNode marked metadata.cinatra.artifactReview.targetsInput with a non-empty
// string (the marker exactly as the core reads it, cinatra-ai/cinatra packages/agents/src/artifact-binding.ts,
// readArtifactReviewTargetsInput), which the application draws as its own review, and with no screen of the pack's
// own: no renderer, inputRenderers or gateRenderer key in its metadata.cinatra, no "x-renderer" key anywhere in it,
// and no package renderer or root hitlScreens entry that names the renderer the core selects for it when it names
// none (SCHEMA_FIELD_FALLBACK_RENDERER_ID). Any other InputMessageNode is a confirm step of the pack's own.
function isHostReview(step, packageScreenIds) {
  if (step.component_type !== "InputMessageNode") return false;
  const cinatra = cinatraOf(step);
  const marker = isObject(cinatra?.artifactReview) ? cinatra.artifactReview.targetsInput : undefined;
  if (typeof marker !== "string" || marker.length === 0) return false;
  if (["renderer", "inputRenderers", "gateRenderer"].some((key) => Object.hasOwn(cinatra, key))) return false;
  if (holdsXRenderer(step)) return false;
  return !packageScreenIds.has(SCHEMA_FIELD_FALLBACK_RENDERER_ID);
}

// Check one parsed flow. `fieldRenderers` is the package's
// `cinatra.fieldRenderers` list (it is read for the hitlScreens rule and for a host review step).
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
  const keysOf = new WeakMap(); // component -> every key it is kept under in a $referenced_components map
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
    if (key !== undefined) {
      keyOf.set(value, key);
      keysOf.set(value, [...(keysOf.get(value) ?? []), key]);
    }
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

  // A step and what it holds: every object inside it, references followed.
  const heldBy = (start) => {
    const held = new Set();
    const inside = [start];
    while (inside.length > 0) {
      const value = inside.pop();
      if (Array.isArray(value)) {
        inside.push(...value);
        continue;
      }
      if (!isObject(value) || held.has(value)) continue;
      held.add(value);
      if (typeof value.$component_ref === "string") inside.push(...resolveAll(value, scopeOf.get(value) ?? []));
      inside.push(...Object.values(value));
    }
    return held;
  };

  const ownGate = (name, message) => add("oas.publish-own-gate", name, message);
  // The screen ids the package names: its renderer ids and the root hitlScreens entries (for isHostReview).
  const rootScreens = cinatraOf(flow)?.hitlScreens;
  const packageScreenIds = new Set([
    ...(Array.isArray(fieldRenderers) ? fieldRenderers.filter(isObject).map((r) => r.id) : []),
    ...(Array.isArray(rootScreens) ? rootScreens : []),
  ]);
  for (const step of publishing) {
    const stepName = nameOf(step);
    const stepCinatra = cinatraOf(step);
    if (stepCinatra && Object.hasOwn(stepCinatra, "requiresApproval") && stepCinatra.requiresApproval !== false) {
      ownGate(
        stepName,
        `publishing node ${quoteId(stepName)} declares a metadata.cinatra.requiresApproval that is not false; the host's publish confirmation is to be the one approval in front of it`,
      );
    }
    // A confirmations list on the step or on any component it holds (its subflow's steps) may only name the host's
    // publish decision; an entry with a gate renderer of the pack's own, or any other value, is a confirm road of its own.
    for (const component of heldBy(step)) {
      const cinatra = cinatraOf(component);
      if (!cinatra || !Object.hasOwn(cinatra, "confirmations") || isPublishDecisionList(cinatra.confirmations)) continue;
      const where = component === step ? `publishing node ${quoteId(stepName)}` : `${quoteId(nameOf(component))} inside publishing node ${quoteId(stepName)}`;
      ownGate(
        stepName,
        `${where} declares a metadata.cinatra.confirmations that is not a list of entries naming decision "publish" with no gateRenderer; the host's publish confirmation is to be the one approval in front of it`,
      );
      break;
    }
    // Walk back from the step across the steps that do no work (isPassThrough), up to the first stop.
    const visited = new Set([step]);
    const queue = [...(predecessors.get(step) ?? [])];
    while (queue.length > 0) {
      const before = queue.shift();
      if (visited.has(before)) continue;
      visited.add(before);
      if (before.component_type === "InputMessageNode") {
        if (isHostReview(before, packageScreenIds)) continue; // the application's review, not a confirm of the pack's own
        const gateName = nameOf(before);
        ownGate(
          gateName,
          `node ${quoteId(gateName)} waits for a person in front of publishing node ${quoteId(stepName)}; the host's publish confirmation is to be the one stop there, so the pack keeps no confirm step of its own`,
        );
      } else if (isPassThrough(before)) {
        queue.push(...(predecessors.get(before) ?? []));
      }
    }
  }

  // Root hitlScreens in front of a publishing step. A screen is placed on every running step (above) by the renderer
  // the core selects for it (rendererOf). The core evaluates, in JavaScript, on the same JSON.parse output
  // (cinatra-ai/cinatra at 5ea6501c, packages/agents/src/oas-compiler.ts:1735), for an InputMessageNode with node id `id`
  // (its key in $referenced_components, :1794, :1841-1847):
  //   const out0 = ime.outputs?.[0] ?? {}; const field = out0.title ?? out0.id ?? id;                 (:1918-1919)
  //   ime.metadata?.cinatra?.inputRenderers?.[field] ?? ime.metadata?.cinatra?.renderer ?? SCHEMA_FIELD_FALLBACK_RENDERER_ID
  //                                                                                                 (:1925-1928)
  // with SCHEMA_FIELD_FALLBACK_RENDERER_ID = "@cinatra-ai/agent-builder:schema-field-fallback"
  // (packages/agents/src/agent-builder-ids.ts:36-47); for any other step, metadata.cinatra.renderer (:645, :2036).
  // rendererOf evaluates the same expressions literally, so prototype keys, non-list outputs and the fallback select
  // what the core selects. Where the result cannot be known (a component kept under two keys that select differently,
  // or a selected value that is not a string: a number, boolean, list or object, which a host may turn into the text
  // String(value)), that text is read as unplaced, never placed. An InputMessageNode with no key in
  // $referenced_components is no step of the core (it reads localRefs[id] only) and selects nothing. If the selection
  // throws (a field the core cannot turn into a key), every mid-run screen is refused beside every publishing step. A renderer
  // on any other object (a reference wrapper, a
  // component no running flow uses, a step of a flow-shaped value that does not run) places nothing. A placed screen is a confirm of a publishing step when
  // the step it is placed on is
  // (1) inside the step itself (its own subflow included), or reaches the step through steps that do no work only
  //     (isPassThrough, crossed with what they hold); a step that does work ends that walk, but what it runs last
  //     (the steps in front of the end of its subflow, by the same walk) still reaches the write; or
  // (2) declared riskClass "approval" or "test_send", and on a control path back from the step that ends at the
  //     first InputMessageNode or at another publishing step, or inside a step on that path (the wide front).
  // A screen that no step names counts as in front of every publishing step. Any other screen (after the write, in
  // front of an earlier stop, or a review that work steps separate from the write) is not a confirm step of this write.
  const rootCinatra = cinatraOf(flow);
  if (rootCinatra && Object.hasOwn(rootCinatra, "hitlScreens")) {
    const screens = rootCinatra.hitlScreens;
    const renderers = Array.isArray(fieldRenderers) ? fieldRenderers.filter(isObject) : [];
    const placedOn = new Map(); // screen id -> the components whose selected renderer it is
    const unknownPlace = new Set(); // screen ids whose placement cannot be known: read as unplaced
    // The core's selection, evaluated literally (the comment above); `id` is one node id the core may use.
    const selectFor = (component, id) => {
      if (component.component_type === "InputMessageNode") {
        const out0 = component.outputs?.[0] ?? {};
        const field = out0.title ?? out0.id ?? id;
        return component.metadata?.cinatra?.inputRenderers?.[field] ?? component.metadata?.cinatra?.renderer ?? SCHEMA_FIELD_FALLBACK_RENDERER_ID;
      }
      return component.metadata?.cinatra?.renderer;
    };
    let selectionThrew = false; // a selection threw: every mid-run screen is refused beside every publishing step
    for (const component of flowSteps) {
      if (typeof component.$component_ref === "string") continue;
      const keys = keysOf.get(component);
      if (component.component_type === "InputMessageNode" && keys === undefined) continue; // no core step: selects nothing
      try {
        const raw = [...new Set((keys ?? [nameOf(component)]).map((id) => selectFor(component, id)))];
        if (raw.length === 1 && typeof raw[0] === "string") {
          placedOn.set(raw[0], [...(placedOn.get(raw[0]) ?? []), component]);
        } else {
          // Two keys that select differently, or a selection that is not a string: read as unplaced, never placed.
          for (const v of raw) if (v !== null && v !== undefined) unknownPlace.add(String(v));
        }
      } catch {
        selectionThrew = true;
      }
    }
    // (1) The steps whose screen reaches the step through steps that do no work.
    const confirmFrontOf = (step) => {
      const front = heldBy(step);
      const visited = new Set([step]);
      const queue = [...(predecessors.get(step) ?? [])];
      while (queue.length > 0) {
        const before = queue.shift();
        if (visited.has(before)) continue;
        visited.add(before);
        front.add(before);
        if (readPublishes(before).value === true || before.component_type === "InputMessageNode") continue;
        if (isPassThrough(before)) {
          heldBy(before).forEach((value) => front.add(value));
          queue.push(...(predecessors.get(before) ?? []));
          continue;
        }
        // A step that does work: the walk goes on only from the ends of the subflows it runs.
        for (const sub of subflowsRunBy(before)) {
          for (const target of resolveAll(sub, scopeOf.get(before) ?? [])) {
            const ends = [...(stepsOf.get(target) ?? [])].filter((s) => s.component_type === "EndNode");
            if (ends.length === 0) heldBy(target).forEach((value) => front.add(value));
            queue.push(...ends);
          }
        }
      }
      return front;
    };
    const inFrontOf = (step) => {
      const front = new Set();
      const addHeld = (start) => heldBy(start).forEach((value) => front.add(value));
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
    const confirmFronts = new Map(publishing.map((step) => [step, confirmFrontOf(step)]));
    const confirms = (step, place) =>
      confirmFronts.get(step).has(place) || (fronts.get(step).has(place) && CONFIRM_RISK_CLASSES.has(cinatraOf(place)?.riskClass));
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
          if (places.length === 0 || selectionThrew || unknownPlace.has(screen) || places.some((place) => confirms(step, place))) offendingFor.set(step, text);
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
