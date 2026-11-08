// Tests for the agent pack publish gate: the flow rules over in-memory flows,
// and the command line over the committed fixture packs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PUBLISH_GATE_ID_PREFIX,
  RULES,
  checkAgentFlow,
  checkAgentPackage,
  quoteId,
} from "../agent-publish-gate.mjs";

const GATE = path.join(import.meta.dirname, "..", "agent-publish-gate.mjs");
const FIX = path.join(import.meta.dirname, "..", "__fixtures__", "agent-publish");

function runGate(args) {
  return spawnSync("node", [GATE, ...args], { encoding: "utf8" });
}

// A temporary pack folder for one test: `files` maps a relative path to its text. The folder is removed afterwards.
function withTempPack(files, fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "apg-")));
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const AGENT_PKG = JSON.stringify({ name: "x", cinatra: { kind: "agent" } });

// A node: `cinatra` is the metadata.cinatra object, or undefined for a node with no metadata.
// The node gets its own copy, so a test that changes it leaves READ and WRITE as they are.
function node(id, kind, cinatra) {
  const comp = { component_type: kind, id, name: id };
  if (cinatra !== undefined) comp.metadata = { cinatra: { ...cinatra } };
  return { id, comp };
}

// A flow of top-level nodes. `control` is a list of [from, to] node ids.
function flow(nodes, control = [], rootCinatra = {}) {
  const refs = {};
  for (const n of nodes) refs[n.id] = n.comp;
  return {
    component_type: "Flow",
    id: "flow",
    name: "flow",
    metadata: { cinatra: { type: "flow", ...rootCinatra } },
    start_node: { $component_ref: nodes[0].id },
    nodes: nodes.map((n) => ({ $component_ref: n.id })),
    control_flow_connections: control.map(([from, to]) => ({
      component_type: "ControlFlowEdge",
      name: `${from}_to_${to}`,
      from_node: { $component_ref: from },
      to_node: { $component_ref: to },
    })),
    data_flow_connections: [],
    $referenced_components: refs,
  };
}

const READ = Object.freeze({ riskClass: "read_only", requiresApproval: false });
const WRITE = Object.freeze({ riskClass: "write", requiresApproval: false });

// The shape of a publish pack once it declares: read, publish, write the address back.
function declaredPublishPack(overrides = {}) {
  const nodes = [
    node("start", "StartNode", {}),
    node("read_post", "ApiNode", READ),
    node("publish", "ApiNode", { ...WRITE, publishes: true, ...(overrides.publish ?? {}) }),
    node("write_address", "ApiNode", { ...WRITE, publishes: false, ...(overrides.write_address ?? {}) }),
    node("end", "EndNode"),
  ];
  return flow(
    nodes,
    [["start", "read_post"], ["read_post", "publish"], ["publish", "write_address"], ["write_address", "end"]],
    overrides.root ?? {},
  );
}

function rulesOf(findings) {
  return findings.map((f) => `${f.rule} ${f.node}`);
}

// ---------------------------------------------------------------------------
// The rule names.

test("the gate has exactly the four rules, and reserves the host's gate prefix", () => {
  assert.deepEqual([...RULES].sort(), [
    "oas.publish-malformed",
    "oas.publish-own-gate",
    "oas.publish-reserved-id",
    "oas.publish-undeclared",
  ]);
  assert.equal(PUBLISH_GATE_ID_PREFIX, "cinatra_publish_gate__");
});

// ---------------------------------------------------------------------------
// oas.publish-undeclared

test("a declared publish pack has no finding", () => {
  assert.deepEqual(checkAgentFlow(declaredPublishPack()), []);
});

test("a write node with no publishes key is refused, by node id", () => {
  const f = declaredPublishPack();
  delete f.$referenced_components.publish.metadata.cinatra.publishes;
  delete f.$referenced_components.write_address.metadata.cinatra.publishes;
  assert.deepEqual(rulesOf(checkAgentFlow(f)), [
    "oas.publish-undeclared publish",
    "oas.publish-undeclared write_address",
  ]);
});

for (const [label, cinatra] of [
  ["riskClass write", { riskClass: "write" }],
  ["no riskClass", { requiresApproval: false }],
  ["an unknown riskClass", { riskClass: "sends_mail" }],
  ["a riskClass that only looks read-only", { riskClass: "read-only" }],
  ["an upper-case read-only riskClass", { riskClass: "READ_ONLY" }],
  ["no metadata.cinatra at all", undefined],
]) {
  test(`an action node with ${label} and no publishes key is refused`, () => {
    const f = flow([node("start", "StartNode", {}), node("act", "ApiNode", cinatra), node("end", "EndNode")], [
      ["start", "act"],
      ["act", "end"],
    ]);
    assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared act"]);
  });
}

test("a node with riskClass exactly read_only needs no declaration", () => {
  const f = flow([node("start", "StartNode", {}), node("look", "ApiNode", READ), node("end", "EndNode")], [
    ["start", "look"],
    ["look", "end"],
  ]);
  assert.deepEqual(checkAgentFlow(f), []);
});

test("the five kinds that cannot reach a connector need no declaration", () => {
  const f = flow(
    [
      node("start", "StartNode"),
      node("ask", "InputMessageNode"),
      node("pick", "BranchingNode"),
      node("say", "OutputMessageNode"),
      node("end", "EndNode"),
    ],
    [["start", "ask"], ["ask", "pick"], ["pick", "say"], ["say", "end"]],
  );
  assert.deepEqual(checkAgentFlow(f), []);
});

for (const kind of ["AgentNode", "FlowNode", "ParallelFlowNode", "LlmNode", "ToolNode", "MapNode", "SomeFutureNode"]) {
  test(`a ${kind} with no publishes key is refused (an allow-list, not a deny-list)`, () => {
    const f = flow([node("start", "StartNode"), node("n", kind, {}), node("end", "EndNode")], [
      ["start", "n"],
      ["n", "end"],
    ]);
    assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared n"]);
  });
}

test("a node of a flow whose component has no component_type is refused when undeclared", () => {
  const f = flow([node("start", "StartNode"), node("odd", "ApiNode", WRITE), node("end", "EndNode")], [
    ["start", "odd"],
    ["odd", "end"],
  ]);
  delete f.$referenced_components.odd.component_type;
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared odd"]);
  f.$referenced_components.odd.metadata.cinatra.publishes = false;
  assert.deepEqual(checkAgentFlow(f), []);
});

test("a node listed in a flow whose component is not in the file is refused", () => {
  const f = declaredPublishPack();
  f.nodes.push({ $component_ref: "missing_step" });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared missing_step"]);
});

test("a write node inside a nested subflow is read too", () => {
  const inner = {
    component_type: "Flow",
    id: "inner",
    name: "inner",
    start_node: { $component_ref: "inner_start" },
    nodes: [{ $component_ref: "inner_start" }, { $component_ref: "inner_write" }, { $component_ref: "inner_end" }],
    control_flow_connections: [],
    data_flow_connections: [],
    $referenced_components: {
      inner_start: { component_type: "StartNode", id: "inner_start", name: "inner_start" },
      inner_write: { component_type: "ApiNode", id: "inner_write", name: "inner_write", metadata: { cinatra: { ...WRITE } } },
      inner_end: { component_type: "EndNode", id: "inner_end", name: "inner_end" },
    },
  };
  const f = flow(
    [node("start", "StartNode"), node("sub", "FlowNode", { publishes: false }), node("end", "EndNode")],
    [["start", "sub"], ["sub", "end"]],
  );
  f.$referenced_components.sub.subflow = inner;
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared inner_write"]);
  inner.$referenced_components.inner_write.metadata.cinatra.publishes = false;
  assert.deepEqual(checkAgentFlow(f), []);
});

// A component whose kind does not end in "Node", kept in the root map but not in the nodes list.
function withOddStep(place) {
  const f = declaredPublishPack();
  f.$referenced_components.odd = { component_type: "Api", id: "odd", name: "odd", metadata: { cinatra: { ...WRITE } } };
  place(f);
  return f;
}

test("a component whose kind is not a Node name, reached only as the flow's start node, is checked", () => {
  const f = withOddStep((g) => {
    g.start_node = { $component_ref: "odd" };
  });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared odd"]);
});

test("a component whose kind is not a Node name, reached only as a control edge endpoint, is checked", () => {
  const f = withOddStep((g) => {
    g.control_flow_connections.push({
      component_type: "ControlFlowEdge",
      name: "read_post_to_odd",
      from_node: { $component_ref: "read_post" },
      to_node: { $component_ref: "odd" },
    });
  });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared odd"]);
});

test("a component whose kind is not a Node name, reached only as a data edge endpoint, is checked", () => {
  const f = withOddStep((g) => {
    g.data_flow_connections.push({
      component_type: "DataFlowEdge",
      name: "odd_to_publish",
      source_node: { $component_ref: "odd" },
      source_output: "text",
      destination_node: { $component_ref: "publish" },
      destination_input: "text",
    });
  });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared odd"]);
});

test("an inline step in a nodes list and an inline edge endpoint are checked", () => {
  const f = declaredPublishPack();
  f.nodes.push({ component_type: "Api", id: "inline_step", name: "inline_step", metadata: { cinatra: { ...WRITE } } });
  f.control_flow_connections.push({
    component_type: "ControlFlowEdge",
    name: "inline_edge",
    from_node: { $component_ref: "read_post" },
    to_node: { component_type: "ApiNode", id: "inline_endpoint", name: "inline_endpoint", metadata: { cinatra: { ...WRITE } } },
  });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared inline_endpoint", "oas.publish-undeclared inline_step"]);
});

test("an edge endpoint whose component is not in the file gives no undeclared finding (there is no component to run)", () => {
  const f = declaredPublishPack();
  f.control_flow_connections.push({
    component_type: "ControlFlowEdge",
    name: "nowhere_to_publish",
    from_node: { $component_ref: "nowhere" },
    to_node: { $component_ref: "publish" },
  });
  assert.deepEqual(checkAgentFlow(f), []);
});

// The two ends of each edge kind.
const EDGE_FIELDS = {
  control_flow_connections: ["from_node", "to_node"],
  data_flow_connections: ["source_node", "destination_node"],
};

// A component whose kind is not a Node name, reached at one place only: as the start node, or as one end of a control
// or data edge. The component is inline or kept in the root map; the edge is inline or kept as a referenced component.
function oddStepAt(field, end, { inline = false, edgeRef = false } = {}) {
  const f = inline ? declaredPublishPack() : withOddStep(() => {});
  const odd = inline
    ? { component_type: "Api", id: "odd", name: "odd", metadata: { cinatra: { ...WRITE } } }
    : { $component_ref: "odd" };
  if (field === "start_node") {
    f.start_node = odd;
    return f;
  }
  const other = { $component_ref: "read_post" };
  const [first, second] = EDGE_FIELDS[field];
  const edge =
    field === "control_flow_connections"
      ? { component_type: "ControlFlowEdge", name: "odd_edge" }
      : { component_type: "DataFlowEdge", name: "odd_edge", source_output: "text", destination_input: "text" };
  edge[first] = end === first ? odd : other;
  edge[second] = end === second ? odd : other;
  if (edgeRef) {
    f.$referenced_components.odd_edge = edge;
    f[field].push({ $component_ref: "odd_edge" });
  } else {
    f[field].push(edge);
  }
  return f;
}

for (const [label, field, end, options] of [
  ["inline, as the start node", "start_node", null, { inline: true }],
  ["by reference, as a control edge's from_node", "control_flow_connections", "from_node", {}],
  ["inline, as a control edge's from_node", "control_flow_connections", "from_node", { inline: true }],
  ["inline, as a control edge's to_node", "control_flow_connections", "to_node", { inline: true }],
  ["by reference, as the to_node of a control edge kept as a referenced component", "control_flow_connections", "to_node", { edgeRef: true }],
  ["inline, as a data edge's source_node", "data_flow_connections", "source_node", { inline: true }],
  ["by reference, as a data edge's destination_node", "data_flow_connections", "destination_node", {}],
  ["inline, as a data edge's destination_node", "data_flow_connections", "destination_node", { inline: true }],
  ["by reference, as the source_node of a data edge kept as a referenced component", "data_flow_connections", "source_node", { edgeRef: true }],
]) {
  test(`a component whose kind is not a Node name, reached only ${label}, is checked`, () => {
    assert.deepEqual(rulesOf(checkAgentFlow(oddStepAt(field, end, options))), ["oas.publish-undeclared odd"]);
  });
}

test("a reference resolves to the nearest map: an inner map shadows an outer one, and an outer map serves an inner flow", () => {
  const inner = (refs) => ({
    component_type: "Flow",
    id: "inner",
    name: "inner",
    start_node: { $component_ref: "shared" },
    nodes: [{ $component_ref: "shared" }],
    control_flow_connections: [],
    data_flow_connections: [],
    ...(refs ? { $referenced_components: refs } : {}),
  });
  const outerShared = { component_type: "Api", id: "shared", name: "shared", metadata: { cinatra: { ...WRITE } } };
  const innerShared = { component_type: "Api", id: "shared", name: "shared", metadata: { cinatra: { ...WRITE, publishes: false } } };
  const build = (refs) => {
    const f = flow(
      [node("start", "StartNode"), node("sub", "FlowNode", { publishes: false }), node("end", "EndNode")],
      [["start", "sub"], ["sub", "end"]],
    );
    f.$referenced_components.shared = structuredClone(outerShared);
    f.$referenced_components.sub.subflow = inner(refs);
    return f;
  };
  // The inner map declares its own "shared"; the outer, undeclared one is not reached.
  assert.deepEqual(checkAgentFlow(build({ shared: structuredClone(innerShared) })), []);
  // Without an inner map, the inner flow's "shared" is the outer one.
  assert.deepEqual(rulesOf(checkAgentFlow(build(null))), ["oas.publish-undeclared shared"]);
});

test("two steps with one id give one finding", () => {
  const f = declaredPublishPack();
  for (let i = 0; i < 2; i++) {
    f.nodes.push({ component_type: "ApiNode", id: "dup", name: "dup", metadata: { cinatra: { ...WRITE } } });
  }
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared dup"]);
});

test("checkAgentFlow refuses a flow that is not a JSON object", () => {
  for (const value of [null, [], "flow", 1]) {
    assert.throws(() => checkAgentFlow(value), /not a JSON object/);
  }
});

// ---------------------------------------------------------------------------
// oas.publish-malformed

for (const [label, value] of [
  ["the string \"true\"", "true"],
  ["the number 1", 1],
  ["null", null],
  ["an object", { on: true }],
  ["an array", [true]],
]) {
  test(`publishes as ${label} is malformed`, () => {
    const f = declaredPublishPack({ publish: { publishes: value } });
    assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-malformed publish"]);
  });
}

test("a malformed publishes on the flow root is refused as well", () => {
  const f = declaredPublishPack({ root: { publishes: "yes" } });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-malformed flow"]);
});

test("a finding names ids only, never the value or the kind the pack wrote", () => {
  const f = declaredPublishPack({ publish: { publishes: "VALUE-NOT-TO-ECHO" } });
  f.$referenced_components.write_address.component_type = "KindNotToEchoNode";
  delete f.$referenced_components.write_address.metadata.cinatra.publishes;
  const text = JSON.stringify(checkAgentFlow(f));
  assert.ok(!text.includes("VALUE-NOT-TO-ECHO"), text);
  assert.ok(!text.includes("KindNotToEcho"), text);
  assert.match(text, /a string/);
});

test("a long or multi-line node id is quoted on one line and cut", () => {
  const id = `${"x".repeat(200)}\u2028next`;
  const f = flow([node("start", "StartNode"), node(id, "ApiNode", WRITE), node("end", "EndNode")], [
    ["start", id],
    [id, "end"],
  ]);
  const [finding] = checkAgentFlow(f);
  assert.equal(finding.rule, "oas.publish-undeclared");
  assert.ok(!finding.message.includes("\u2028"));
  assert.ok(!finding.message.includes("\n"));
  assert.ok(finding.message.length < 400, finding.message);
});

test("an id of exactly 120 characters is quoted whole, a longer one is cut, and U+2028 and U+2029 are escaped", () => {
  assert.equal(quoteId("y".repeat(120)), JSON.stringify("y".repeat(120)));
  assert.equal(quoteId("y".repeat(121)), JSON.stringify(`${"y".repeat(120)}...`));
  assert.equal(quoteId("a b c"), '"a\\u2028b\\u2029c"');
});

// ---------------------------------------------------------------------------
// oas.publish-reserved-id

test("a node key that takes the reserved prefix is refused", () => {
  const id = `${PUBLISH_GATE_ID_PREFIX}publish`;
  const f = flow([node("start", "StartNode"), node(id, "InputMessageNode"), node("end", "EndNode")], [
    ["start", id],
    [id, "end"],
  ]);
  assert.deepEqual(rulesOf(checkAgentFlow(f)), [`oas.publish-reserved-id ${id}`]);
});

test("a component id that takes the reserved prefix is refused under any key", () => {
  const f = declaredPublishPack();
  f.$referenced_components.read_post.id = `${PUBLISH_GATE_ID_PREFIX}x`;
  assert.deepEqual(rulesOf(checkAgentFlow(f)), [`oas.publish-reserved-id ${PUBLISH_GATE_ID_PREFIX}x`]);
});

test("a reference that takes the reserved prefix is refused even when nothing defines it", () => {
  const f = declaredPublishPack();
  f.control_flow_connections.push({
    component_type: "ControlFlowEdge",
    name: "odd",
    from_node: { $component_ref: `${PUBLISH_GATE_ID_PREFIX}ghost` },
    to_node: { $component_ref: "publish" },
  });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), [`oas.publish-reserved-id ${PUBLISH_GATE_ID_PREFIX}ghost`]);
});

// ---------------------------------------------------------------------------
// oas.publish-own-gate

function withConfirmBefore(extraNodes, control) {
  const nodes = [
    node("start", "StartNode"),
    node("read_post", "ApiNode", READ),
    ...extraNodes,
    node("publish", "ApiNode", { ...WRITE, publishes: true }),
    node("end", "EndNode"),
  ];
  return flow(nodes, control);
}

test("a pack InputMessageNode directly in front of a publishing node is its own confirm gate", () => {
  const f = withConfirmBefore([node("confirm", "InputMessageNode")], [
    ["start", "read_post"],
    ["read_post", "confirm"],
    ["confirm", "publish"],
    ["publish", "end"],
  ]);
  const findings = checkAgentFlow(f);
  assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate confirm"]);
  assert.match(findings[0].message, /"publish"/);
});

test("an InputMessageNode that reaches the publishing node only through branching is its own confirm gate", () => {
  const f = withConfirmBefore([node("confirm", "InputMessageNode"), node("approved", "BranchingNode")], [
    ["start", "read_post"],
    ["read_post", "confirm"],
    ["confirm", "approved"],
    ["approved", "publish"],
    ["approved", "end"],
    ["publish", "end"],
  ]);
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate confirm"]);
});

test("an InputMessageNode with an action between it and the publishing node is not a confirm gate", () => {
  const f = withConfirmBefore([node("ask_post", "InputMessageNode")], [
    ["start", "ask_post"],
    ["ask_post", "read_post"],
    ["read_post", "publish"],
    ["publish", "end"],
  ]);
  assert.deepEqual(checkAgentFlow(f), []);
});

test("an InputMessageNode in front of a node declared publishes: false is not refused", () => {
  const f = flow(
    [node("start", "StartNode"), node("ask", "InputMessageNode"), node("save", "ApiNode", { ...WRITE, publishes: false }), node("end", "EndNode")],
    [["start", "ask"], ["ask", "save"], ["save", "end"]],
  );
  assert.deepEqual(checkAgentFlow(f), []);
});

test("a control edge kept as a referenced component is read like an inline edge", () => {
  const f = withConfirmBefore([node("confirm", "InputMessageNode")], [
    ["start", "read_post"],
    ["read_post", "confirm"],
    ["publish", "end"],
  ]);
  f.$referenced_components.confirm_to_publish = {
    component_type: "ControlFlowEdge",
    name: "confirm_to_publish",
    from_node: { $component_ref: "confirm" },
    to_node: { $component_ref: "publish" },
  };
  f.control_flow_connections.push({ $component_ref: "confirm_to_publish" });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate confirm"]);
});

test("a publishing node that also asks for its own approval step is refused", () => {
  const f = declaredPublishPack({ publish: { requiresApproval: true } });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate publish"]);
});

const SCREEN = "@example/publish-agent:confirm";

test("a root HITL screen whose renderer is a mid-run gate is refused beside a publishing node", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [SCREEN] } });
  const findings = checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: true }] });
  assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate publish"]);
  assert.match(findings[0].message, /hitlScreens/);
});

test("a root HITL screen whose renderer this package does not declare is refused beside a publishing node", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [SCREEN] } });
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [] })), ["oas.publish-own-gate publish"]);
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate publish"]);
});

test("a root hitlScreens value that is not a list of screen ids is refused beside a publishing node", () => {
  const f = declaredPublishPack({ root: { hitlScreens: SCREEN } });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate publish"]);
});

test("a root HITL screen declared not mid-run is allowed beside a publishing node", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [SCREEN] } });
  assert.deepEqual(checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: false }] }), []);
});

test("a root HITL screen is no finding in a flow that publishes nothing", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [SCREEN] }, publish: { publishes: false } });
  assert.deepEqual(checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: true }] }), []);
});

for (const [label, value] of [
  ["the string \"true\"", "true"],
  ["the string \"false\"", "false"],
  ["the number 1", 1],
  ["the number 0", 0],
  ["null", null],
]) {
  test(`a root HITL screen whose renderer declares midRunHitl as ${label} is refused beside a publishing node`, () => {
    const f = declaredPublishPack({ root: { hitlScreens: [SCREEN] } });
    assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: value }] })), [
      "oas.publish-own-gate publish",
    ]);
  });
}

test("a root HITL screen whose renderer has no midRunHitl key is allowed beside a publishing node", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [SCREEN] } });
  assert.deepEqual(checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, kind: "example-confirm" }] }), []);
});

// The renderer id endings that the core's classifyMidRunHitl reads as mid-run whatever the renderer declares.
const MID_RUN_ENDINGS = [":output", "-output", ":list-picker", ":scrape-schema-review", ":final-list-review", ":setup-form"];

for (const ending of MID_RUN_ENDINGS) {
  test(`a root HITL screen whose id ends in "${ending}" is refused beside a publishing node, even when declared not mid-run`, () => {
    const screen = `@example/publish-agent:confirm${ending}`;
    const f = declaredPublishPack({ root: { hitlScreens: [screen] } });
    assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: screen, midRunHitl: false }] })), [
      "oas.publish-own-gate publish",
    ]);
  });
}

for (const ending of MID_RUN_ENDINGS) {
  test(`a root HITL screen whose id ends in "${ending}" is refused beside a publishing node when its renderer has no midRunHitl key`, () => {
    const screen = `@example/publish-agent:confirm${ending}`;
    const f = declaredPublishPack({ root: { hitlScreens: [screen] } });
    assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: screen, kind: "example-confirm" }] })), [
      "oas.publish-own-gate publish",
    ]);
  });
}

test("a root HITL screen whose id holds a mid-run ending only inside it is allowed when declared not mid-run", () => {
  const screen = "@example/publish-agent:output-view";
  const f = declaredPublishPack({ root: { hitlScreens: [screen] } });
  assert.deepEqual(checkAgentFlow(f, { fieldRenderers: [{ id: screen, midRunHitl: false }] }), []);
});

test("a root HITL screen whose renderer id this package declares twice is refused beside a publishing node", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [SCREEN] } });
  for (const second of [true, false]) {
    const renderers = [{ id: SCREEN, midRunHitl: false }, { id: SCREEN, midRunHitl: second }];
    assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: renderers })), ["oas.publish-own-gate publish"]);
  }
});

test("a hitlScreens entry that is not a screen id is refused, also after an allowed entry", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [SCREEN, 42] } });
  const findings = checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: false }] });
  assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate publish"]);
  assert.match(findings[0].message, /not a screen id/);
});

test("an empty hitlScreens list is no finding beside a publishing node", () => {
  assert.deepEqual(checkAgentFlow(declaredPublishPack({ root: { hitlScreens: [] } })), []);
});

test("a fieldRenderers value that is not a list, or an entry that is not an object, declares no renderer", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [SCREEN] } });
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: { id: SCREEN, midRunHitl: false } })), ["oas.publish-own-gate publish"]);
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [null, SCREEN, [SCREEN]] })), ["oas.publish-own-gate publish"]);
});

for (const [label, value] of [
  ["the string \"true\"", "true"],
  ["the number 1", 1],
  ["null", null],
]) {
  test(`a publishing node that declares requiresApproval as ${label} is refused`, () => {
    const f = declaredPublishPack({ publish: { requiresApproval: value } });
    assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate publish"]);
  });
}

test("a publishing node with requiresApproval false, or without the key, needs no other step", () => {
  const f = declaredPublishPack();
  assert.deepEqual(checkAgentFlow(f), []);
  delete f.$referenced_components.publish.metadata.cinatra.requiresApproval;
  assert.deepEqual(checkAgentFlow(f), []);
});

test("a loop of branching nodes in front of a publishing node ends, and the confirm step is named once", () => {
  const f = withConfirmBefore([node("confirm", "InputMessageNode"), node("b1", "BranchingNode"), node("b2", "BranchingNode")], [
    ["start", "read_post"],
    ["read_post", "confirm"],
    ["confirm", "b1"],
    ["b1", "b2"],
    ["b2", "b1"],
    ["b2", "publish"],
    ["publish", "end"],
  ]);
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate confirm"]);
});

test("the findings are the same on every run", () => {
  const f = withConfirmBefore([node("confirm", "InputMessageNode"), node("draft", "ApiNode", WRITE)], [
    ["start", "read_post"],
    ["read_post", "draft"],
    ["draft", "confirm"],
    ["confirm", "publish"],
    ["publish", "end"],
  ]);
  const first = JSON.stringify(checkAgentFlow(f));
  assert.equal(JSON.stringify(checkAgentFlow(structuredClone(f))), first);
  assert.deepEqual(rulesOf(JSON.parse(first)), ["oas.publish-undeclared draft", "oas.publish-own-gate confirm"]);
});

// ---------------------------------------------------------------------------
// Reference scopes held by an edge, values that are neither a component nor a reference, and aliases.

const CONFIRM = Object.freeze({ component_type: "InputMessageNode", id: "confirm", name: "confirm" });
const ODD_WRITE = () => ({ component_type: "Api", id: "odd", name: "odd", metadata: { cinatra: { ...WRITE } } });

// A control edge from `from` to `to` (two references), with its own $referenced_components map when `refs` is given.
function controlEdge(name, from, to, refs) {
  const edge = { component_type: "ControlFlowEdge", name, from_node: { $component_ref: from }, to_node: { $component_ref: to } };
  if (refs) edge.$referenced_components = refs;
  return edge;
}

test("an inline edge that holds its own map resolves its endpoints there: an unknown-kind writing step is checked", () => {
  const f = declaredPublishPack();
  f.control_flow_connections.push(controlEdge("read_post_to_odd", "read_post", "odd", { odd: ODD_WRITE() }));
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared odd"]);
});

test("an inline edge that holds its own map resolves its endpoints there: an InputMessageNode into a publishing node is its own confirm gate", () => {
  const f = declaredPublishPack();
  f.control_flow_connections.push(controlEdge("confirm_to_publish", "confirm", "publish", { confirm: { ...CONFIRM } }));
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate confirm"]);
});

test("an edge kept as a referenced component that holds its own map resolves its endpoints there", () => {
  const f = declaredPublishPack();
  f.$referenced_components.gate_edge = controlEdge("gate_edge", "confirm", "publish", { confirm: { ...CONFIRM } });
  f.control_flow_connections.push({ $component_ref: "gate_edge" });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate confirm"]);
});

for (const [label, place] of [
  ["a nodes entry that is a bare string", (f) => f.nodes.push("odd")],
  ["a nodes entry that is null", (f) => f.nodes.push(null)],
  ["a control_flow_connections entry that is a bare string", (f) => f.control_flow_connections.push("odd_edge")],
  ["a data_flow_connections entry that is a number", (f) => f.data_flow_connections.push(7)],
  ["a start_node that is a bare string", (f) => { f.start_node = "odd"; }],
  ["a control edge whose to_node is a bare string", (f) => f.control_flow_connections.push({ ...controlEdge("e", "read_post", "x"), to_node: "odd" })],
  ["a data edge whose source_node is a bare string", (f) => f.data_flow_connections.push({ component_type: "DataFlowEdge", name: "e", source_node: "odd", destination_node: { $component_ref: "publish" } })],
]) {
  test(`${label} is refused, by the flow's id, since the step it names cannot be checked`, () => {
    const f = withOddStep(() => {});
    f.$referenced_components.odd_edge = controlEdge("odd_edge", "read_post", "odd");
    place(f);
    assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared flow"]);
  });
}

test("a reference to a reference is followed to the component: an aliased InputMessageNode into a publishing node is its own confirm gate", () => {
  const f = declaredPublishPack();
  f.$referenced_components.confirm = { ...CONFIRM };
  f.$referenced_components.confirm_alias = { $component_ref: "confirm", metadata: { cinatra: { publishes: false } } };
  f.control_flow_connections.push(controlEdge("alias_to_publish", "confirm_alias", "publish"));
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate confirm"]);
});

test("a loop of references ends, and a listed step that names it is refused", () => {
  const f = declaredPublishPack();
  f.$referenced_components.a = { $component_ref: "b" };
  f.$referenced_components.b = { $component_ref: "a" };
  f.nodes.push({ $component_ref: "a" });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared a"]);
});

test("a nearer map entry that is not an object does not shadow: the reference resolves to the outer component", () => {
  const f = flow([node("start", "StartNode"), node("sub", "FlowNode", { publishes: false }), node("end", "EndNode")], [
    ["start", "sub"],
    ["sub", "end"],
  ]);
  f.$referenced_components.shared = { component_type: "Api", id: "shared", name: "shared", metadata: { cinatra: { ...WRITE } } };
  f.$referenced_components.sub.subflow = {
    component_type: "Flow",
    id: "inner",
    name: "inner",
    start_node: { $component_ref: "shared" },
    nodes: [{ $component_ref: "shared" }],
    $referenced_components: { shared: "not a component" },
  };
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-undeclared shared"]);
});

test("a start node or an edge whose reference names nothing in the file gives no finding (there is nothing to run)", () => {
  const f = declaredPublishPack();
  f.start_node = { $component_ref: "nowhere" };
  f.control_flow_connections.push({ $component_ref: "missing_edge" });
  f.data_flow_connections.push({ $component_ref: "missing_data_edge" });
  assert.deepEqual(checkAgentFlow(f), []);
});

test("an id with the reserved prefix is refused on a listed inline component with no component_type", () => {
  const f = declaredPublishPack();
  f.nodes.push({ id: `${PUBLISH_GATE_ID_PREFIX}x`, name: "x", metadata: { cinatra: { publishes: false } } });
  assert.deepEqual(rulesOf(checkAgentFlow(f)), [`oas.publish-reserved-id ${PUBLISH_GATE_ID_PREFIX}x`]);
});

test("a referenced-component key with the reserved prefix is refused whatever its value", () => {
  for (const value of ["text", [1], 7, null]) {
    const f = declaredPublishPack();
    f.$referenced_components[`${PUBLISH_GATE_ID_PREFIX}k`] = value;
    assert.deepEqual(rulesOf(checkAgentFlow(f)), [`oas.publish-reserved-id ${PUBLISH_GATE_ID_PREFIX}k`], JSON.stringify(value));
  }
});

test("an empty flow object has no step, so it has no finding", () => {
  assert.deepEqual(checkAgentFlow({}), []);
});

test("a root HITL screen whose id holds a mid-run ending only inside it is allowed when its renderer has no midRunHitl key", () => {
  const screen = "@example/publish-agent:output-view";
  const f = declaredPublishPack({ root: { hitlScreens: [screen] } });
  assert.deepEqual(checkAgentFlow(f, { fieldRenderers: [{ id: screen, kind: "example-confirm" }] }), []);
});

for (const [label, value] of [
  ["an object", { on: false }],
  ["a list", [false]],
]) {
  test(`a root HITL screen whose renderer declares midRunHitl as ${label} is refused beside a publishing node`, () => {
    const f = declaredPublishPack({ root: { hitlScreens: [SCREEN] } });
    assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: value }] })), [
      "oas.publish-own-gate publish",
    ]);
  });
}

for (const [label, value] of [
  ["the number 0", 0],
  ["the empty string", ""],
  ["the string \"false\"", "false"],
  ["an object", { on: false }],
  ["a list", [false]],
]) {
  test(`a publishing node that declares requiresApproval as ${label} is refused (only false passes)`, () => {
    const f = declaredPublishPack({ publish: { requiresApproval: value } });
    assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate publish"]);
  });
}

test("with two publishing nodes, a confirm step in front of both is named once, and a step or screen finding is given for each", () => {
  const twoPublishers = (cinatra = {}, root = {}) => {
    const nodes = [
      node("start", "StartNode"),
      node("confirm", "InputMessageNode"),
      node("pick", "BranchingNode"),
      node("publish", "ApiNode", { ...WRITE, publishes: true, ...cinatra }),
      node("publish2", "ApiNode", { ...WRITE, publishes: true, ...cinatra }),
      node("end", "EndNode"),
    ];
    return flow(nodes, [["start", "confirm"], ["confirm", "pick"], ["pick", "publish"], ["pick", "publish2"], ["publish", "end"], ["publish2", "end"]], root);
  };
  assert.deepEqual(rulesOf(checkAgentFlow(twoPublishers())), ["oas.publish-own-gate confirm"]);
  // Without the confirm step's edge: a requiresApproval, a screen, or both, give one finding per publishing node.
  for (const [cinatra, root] of [[{ requiresApproval: true }, {}], [{}, { hitlScreens: [SCREEN] }], [{ requiresApproval: true }, { hitlScreens: [SCREEN] }]]) {
    const g = twoPublishers(cinatra, root);
    g.control_flow_connections = g.control_flow_connections.filter((e) => e.name !== "confirm_to_pick");
    assert.deepEqual(rulesOf(checkAgentFlow(g)), ["oas.publish-own-gate publish", "oas.publish-own-gate publish2"]);
  }
});

// ---------------------------------------------------------------------------
// The package reader and the command line, over the committed fixture packs.

test("checkAgentPackage reads the flow and the package's renderers", () => {
  assert.deepEqual(checkAgentPackage(path.join(FIX, "declared-publish")).findings, []);
  assert.deepEqual(rulesOf(checkAgentPackage(path.join(FIX, "kept-confirm-screen")).findings), [
    "oas.publish-own-gate publish",
  ]);
});

test("the command line passes a declared publish pack (exit 0)", () => {
  const r = runGate(["--package", path.join(FIX, "declared-publish")]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS/);
});

test("the command line refuses a publish pack that declares nothing (exit 1)", () => {
  const r = runGate(["--package", path.join(FIX, "undeclared-publish")]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /oas\.publish-undeclared: node "publish"/);
  assert.match(r.stdout, /oas\.publish-undeclared: node "write_address"/);
  assert.match(r.stdout, /FAIL, 2 findings/);
});

test("the command line refuses a pack that keeps its own confirm screen (exit 1)", () => {
  const r = runGate(["--package", path.join(FIX, "kept-confirm-screen")]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /oas\.publish-own-gate/);
});

test("the command line writes JSON on request", () => {
  const r = runGate(["--package", path.join(FIX, "undeclared-publish"), "--format", "json"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "fail");
  assert.deepEqual(out.findings.map((f) => f.rule), ["oas.publish-undeclared", "oas.publish-undeclared"]);
});

test("an agent pack with no flow file passes and says so (exit 0)", () => {
  const r = runGate(["--package", path.join(FIX, "no-flow")]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no cinatra\/oas\.json/);
});

test("a package that is not an agent pack is a usage error (exit 2)", () => {
  const r = runGate(["--package", path.join(FIX, "not-an-agent")]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /not an agent pack/);
});

test("an unreadable flow, a missing package and an unknown option are errors (exit 2), never a pass", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "apg-")));
  try {
    fs.mkdirSync(path.join(dir, "cinatra"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", cinatra: { kind: "agent" } }));
    fs.writeFileSync(path.join(dir, "cinatra", "oas.json"), "{ not json");
    assert.equal(runGate(["--package", dir]).status, 2);
    fs.writeFileSync(path.join(dir, "cinatra", "oas.json"), "[]");
    assert.equal(runGate(["--package", dir]).status, 2);
    assert.equal(runGate(["--package", path.join(dir, "absent")]).status, 2);
    assert.equal(runGate(["--package", dir, "--strictly"]).status, 2);
    assert.equal(runGate(["--package", dir, "--format", "yaml"]).status, 2);
    assert.equal(runGate(["--package"]).status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--help prints the usage (exit 0)", () => {
  const r = runGate(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: agent-publish-gate/);
});

test("-h prints the usage, and an option with no value or with another option as its value is an error (exit 2)", () => {
  const h = runGate(["-h"]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Usage: agent-publish-gate/);
  const noValue = runGate(["--format"]);
  assert.equal(noValue.status, 2);
  assert.match(noValue.stderr, /--format needs a value/);
  const optionAsValue = runGate(["--package", "--format", "json"]);
  assert.equal(optionAsValue.status, 2);
  assert.match(optionAsValue.stderr, /--package needs a value/);
});

test("an option value that starts with a dash is refused, so a short option is never read as a package path (exit 2)", () => {
  const swallowed = runGate(["--package", "-h", "--help"]);
  assert.equal(swallowed.status, 2, swallowed.stdout + swallowed.stderr);
  assert.match(swallowed.stderr, /--package needs a value/);
  // A folder named "-h" that holds an agent pack with no flow would pass if "-h" were read as its path.
  withTempPack({ "-h/package.json": AGENT_PKG }, (dir) => {
    for (const args of [["--package", "-h"], ["--format", "-h"]]) {
      const r = spawnSync("node", [GATE, ...args], { encoding: "utf8", cwd: dir });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`${args[0]} needs a value`));
    }
  });
});

test("a pack whose flow is an empty object passes with no finding (exit 0)", () => {
  withTempPack({ "package.json": AGENT_PKG, "cinatra/oas.json": "{}" }, (dir) => {
    const r = runGate(["--package", dir]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS, 0 findings/);
  });
});

test("the JSON output of a passing pack and of a pack with no flow says whether a flow was read", () => {
  const pass = runGate(["--package", path.join(FIX, "declared-publish"), "--format", "json"]);
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.deepEqual(JSON.parse(pass.stdout), { package: "@example/publish-agent", status: "pass", flow: true, findings: [] });
  const noFlow = runGate(["--package", path.join(FIX, "no-flow"), "--format", "json"]);
  assert.equal(noFlow.status, 0, noFlow.stdout + noFlow.stderr);
  const out = JSON.parse(noFlow.stdout);
  assert.equal(out.status, "pass");
  assert.equal(out.flow, false);
  assert.deepEqual(out.findings, []);
});

test("the JSON output cuts a long node id and package name at 120 characters and escapes U+2028 and U+2029", () => {
  const longId = "x".repeat(200);
  const f = flow(
    [node("start", "StartNode"), node(longId, "ApiNode", WRITE), node("a b", "ApiNode", WRITE), node("c\u2029d", "ApiNode", WRITE), node("end", "EndNode")],
    [["start", longId], [longId, "a b"], ["a b", "c\u2029d"], ["c\u2029d", "end"]],
  );
  const pkg = JSON.stringify({ name: "p".repeat(150), cinatra: { kind: "agent" } });
  withTempPack({ "package.json": pkg, "cinatra/oas.json": JSON.stringify(f) }, (dir) => {
    const r = runGate(["--package", dir, "--format", "json"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(!r.stdout.includes(" "), "a raw U+2028 is in the JSON output");
    assert.ok(!r.stdout.includes("\u2029"), "a raw U+2029 is in the JSON output");
    const out = JSON.parse(r.stdout);
    assert.equal(out.package, `${"p".repeat(120)}...`);
    assert.deepEqual(out.findings.map((x) => x.node), [`${"x".repeat(120)}...`, "a b", "c\u2029d"]);
  });
});

test("a broken package.json is an error (exit 2), and a package name that is not a string is shown as (no name)", () => {
  for (const [text, want] of [
    ["{ not json", /package\.json is not valid JSON/],
    ["[]", /package\.json is not a JSON object/],
    [JSON.stringify({ name: "x" }), /not an agent pack/],
    [JSON.stringify({ name: "x", cinatra: "agent" }), /not an agent pack/],
  ]) {
    withTempPack({ "package.json": text }, (dir) => {
      const r = runGate(["--package", dir]);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, want);
    });
  }
  withTempPack({ "package.json": JSON.stringify({ name: 7, cinatra: { kind: "agent" } }) }, (dir) => {
    const r = runGate(["--package", dir]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /package "\(no name\)"/);
  });
});

test("a --package path that is a file is an error (exit 2)", () => {
  const r = runGate(["--package", path.join(FIX, "declared-publish", "package.json")]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot read package\.json/);
});

test("a flow path that exists but cannot be read as a file is an error (exit 2), never a pack with no flow", () => {
  // `cinatra` is a file, so the flow path cannot be read (ENOTDIR).
  withTempPack({ "package.json": AGENT_PKG, cinatra: "not a folder" }, (dir) => {
    const r = runGate(["--package", dir]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot read cinatra\/oas\.json/);
  });
  // `cinatra/oas.json` is a symbolic link to nothing.
  withTempPack({ "package.json": AGENT_PKG }, (dir) => {
    fs.mkdirSync(path.join(dir, "cinatra"));
    fs.symlinkSync(path.join(dir, "absent.json"), path.join(dir, "cinatra", "oas.json"));
    const r = runGate(["--package", dir]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot read cinatra\/oas\.json/);
  });
});

test("a flow path inside a loop of symbolic links is an error (exit 2), never a pack with no flow", () => {
  // `cinatra` is a link to itself, so the flow path cannot be resolved (ELOOP).
  withTempPack({ "package.json": AGENT_PKG }, (dir) => {
    fs.symlinkSync("cinatra", path.join(dir, "cinatra"));
    const r = runGate(["--package", dir]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot read cinatra\/oas\.json \(ELOOP\)/);
  });
});

test("a cinatra folder that is a symbolic link to nothing reads as a pack with no flow (a stated limit)", () => {
  withTempPack({ "package.json": AGENT_PKG }, (dir) => {
    fs.symlinkSync(path.join(dir, "absent"), path.join(dir, "cinatra"));
    const r = runGate(["--package", dir]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no cinatra\/oas\.json/);
  });
});

test("a flow nested too deep to walk is an error (exit 2), never a pass", () => {
  const depth = 100000;
  const text = `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
  withTempPack({ "package.json": AGENT_PKG, "cinatra/oas.json": text }, (dir) => {
    const r = runGate(["--package", dir]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /agent-publish-gate: ERROR/);
    assert.ok(!r.stdout.includes("PASS"), r.stdout);
  });
});

test("the gate runs when it is called through a symbolic link", () => {
  withTempPack({}, (dir) => {
    const link = path.join(dir, "gate-link.mjs");
    fs.symlinkSync(GATE, link);
    const r = spawnSync("node", [link, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Usage: agent-publish-gate/);
  });
});

test("the gate does not run when it is imported with no script path or with a script path that does not exist", () => {
  const code = `import(${JSON.stringify(pathToFileURL(GATE).href)})`;
  withTempPack({}, (dir) => {
    for (const extra of [[], [path.join(dir, "absent.mjs")]]) {
      const r = spawnSync("node", ["-e", code, ...extra], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(r.stdout, "");
    }
  });
});

test("the gate does not run when it is imported by another script file that exists", () => {
  withTempPack({}, (dir) => {
    const runner = path.join(dir, "runner.mjs");
    fs.writeFileSync(runner, `await import(${JSON.stringify(pathToFileURL(GATE).href)});\n`);
    const r = spawnSync("node", [runner, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, "");
  });
});
