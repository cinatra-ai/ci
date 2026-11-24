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
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
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

test("the gate has exactly the five rules, and reserves the host's gate prefix", () => {
  assert.deepEqual([...RULES].sort(), [
    "oas.publish-malformed",
    "oas.publish-misplaced",
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

test("an InputMessageNode with a work step between it and the publishing node is not a confirm gate", () => {
  const f = withConfirmBefore([node("ask_post", "InputMessageNode"), node("save_post", "ApiNode", { ...WRITE, publishes: false })], [
    ["start", "ask_post"],
    ["ask_post", "save_post"],
    ["save_post", "publish"],
    ["read_post", "end"],
    ["publish", "end"],
  ]);
  assert.deepEqual(checkAgentFlow(f), []);
});

test("an InputMessageNode with only a read_only step between it and the publishing node is its own confirm gate", () => {
  const f = withConfirmBefore([node("ask_post", "InputMessageNode")], [
    ["start", "ask_post"],
    ["ask_post", "read_post"],
    ["read_post", "publish"],
    ["publish", "end"],
  ]);
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate ask_post"]);
});

// A host review (owner ruling 1204 B: an approved review in the same run comes before the publish card): an
// InputMessageNode marked metadata.cinatra.artifactReview.targetsInput, which the application draws as its review,
// with no screen of the pack's own.
const REVIEW_MARK = { requiresApproval: true, artifactReview: { targetsInput: "reviewTargets" } };
function reviewBefore(cinatra, extra = {}) {
  const review = node("review_post", "InputMessageNode", cinatra);
  Object.assign(review.comp, extra);
  return withConfirmBefore([review], [
    ["start", "review_post"],
    ["review_post", "read_post"],
    ["read_post", "publish"],
    ["publish", "end"],
  ]);
}

test("a host review step (artifactReview.targetsInput, no own screen) in front of a publishing node is not a confirm gate", () => {
  assert.deepEqual(checkAgentFlow(reviewBefore(REVIEW_MARK)), []);
  const direct = withConfirmBefore([node("review_post", "InputMessageNode", REVIEW_MARK)], [
    ["start", "read_post"],
    ["read_post", "review_post"],
    ["review_post", "publish"],
    ["publish", "end"],
  ]);
  assert.deepEqual(checkAgentFlow(direct), []);
});

test("a plain requiresApproval InputMessageNode in front of a publishing node is still its own confirm gate", () => {
  assert.deepEqual(rulesOf(checkAgentFlow(reviewBefore({ requiresApproval: true }))), ["oas.publish-own-gate review_post"]);
});

test("a review marker that is not a non-empty string does not make a host review step", () => {
  for (const targetsInput of ["", 1, true, null, ["reviewTargets"], { name: "reviewTargets" }]) {
    const f = reviewBefore({ requiresApproval: true, artifactReview: { targetsInput } });
    assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate review_post"], JSON.stringify(targetsInput));
  }
  assert.deepEqual(rulesOf(checkAgentFlow(reviewBefore({ artifactReview: "reviewTargets" }))), ["oas.publish-own-gate review_post"]);
});

test("a review-marked step with a screen of the pack's own is still its own confirm gate", () => {
  const ownScreens = [
    [{ ...REVIEW_MARK, renderer: "@x/pack:confirm" }, {}],
    [{ ...REVIEW_MARK, inputRenderers: { reviewDecision: "@x/pack:confirm" } }, {}],
    [{ ...REVIEW_MARK, inputRenderers: {} }, {}],
    [{ ...REVIEW_MARK, gateRenderer: "@x/pack:confirm" }, {}],
    [{ ...REVIEW_MARK, inputMessageSchema: { type: "object", properties: { ok: { type: "boolean", "x-renderer": "@x/pack:confirm" } } } }, {}],
    [REVIEW_MARK, { inputs: [{ title: "reviewTargets", schema: { type: "object", "x-renderer": "@x/pack:confirm" } }] }],
  ];
  for (const [cinatra, extra] of ownScreens) {
    assert.deepEqual(rulesOf(checkAgentFlow(reviewBefore(cinatra, extra))), ["oas.publish-own-gate review_post"], JSON.stringify([cinatra, extra]));
  }
});

test("a review-marked step that a root hitlScreens entry or a package renderer selects is still its own confirm gate", () => {
  const listed = reviewBefore(REVIEW_MARK);
  listed.metadata.cinatra.hitlScreens = [SCHEMA_FIELD_FALLBACK_RENDERER_ID];
  assert.ok(rulesOf(checkAgentFlow(listed, { fieldRenderers: [{ id: SCHEMA_FIELD_FALLBACK_RENDERER_ID, midRunHitl: false }] })).includes("oas.publish-own-gate review_post"));
  const bound = checkAgentFlow(reviewBefore(REVIEW_MARK), { fieldRenderers: [{ id: SCHEMA_FIELD_FALLBACK_RENDERER_ID, midRunHitl: false }] });
  assert.deepEqual(rulesOf(bound), ["oas.publish-own-gate review_post"]);
  // A package renderer the step does not select is no screen of the step.
  assert.deepEqual(checkAgentFlow(reviewBefore(REVIEW_MARK), { fieldRenderers: [{ id: "@x/pack:draft-confirm", midRunHitl: true }] }), []);
});

test("an InputMessageNode that reaches the publishing node through an OutputMessageNode and a read_only step is its own confirm gate", () => {
  const f = withConfirmBefore([node("confirm", "InputMessageNode"), node("note", "OutputMessageNode")], [
    ["start", "confirm"],
    ["confirm", "note"],
    ["note", "read_post"],
    ["read_post", "publish"],
    ["publish", "end"],
  ]);
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate confirm"]);
});

test("the walk back from a publishing node does not cross another publishing node, even one declared read_only", () => {
  const f = flow(
    [
      node("start", "StartNode"),
      node("confirm", "InputMessageNode"),
      node("first", "ApiNode", { riskClass: "read_only", publishes: true }),
      node("second", "ApiNode", { ...WRITE, publishes: true }),
      node("end", "EndNode"),
    ],
    [["start", "confirm"], ["confirm", "first"], ["first", "second"], ["second", "end"]],
  );
  // The stop is named once, as in front of `first`; `second` has `first` in front of it, not the stop.
  const findings = checkAgentFlow(f);
  assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate confirm"]);
  assert.match(findings[0].message, /"first"/);
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

// ---------------------------------------------------------------------------
// The external-write declaration: the undeclared text, a `confirmations` list on a step declared true,
// publishes true on a node that is not a top-level node, and review screens bound to the write they stand in front of.

test("the undeclared text says what an external write is", () => {
  const f = declaredPublishPack();
  delete f.$referenced_components.publish.metadata.cinatra.publishes;
  const [finding] = checkAgentFlow(f);
  assert.match(finding.message, /external write/);
  assert.match(finding.message, /creates, changes or deletes data in a system outside Cinatra/);
  assert.match(finding.message, /sending an email counts/);
});

test("a publishing node that keeps a confirmations list of its own is refused", () => {
  const f = declaredPublishPack({ publish: { confirmations: [{ gateRenderer: "@example/publish-agent:send-confirmation" }] } });
  const findings = checkAgentFlow(f);
  assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate publish"]);
  assert.match(findings[0].message, /confirmations/);
  assert.ok(!JSON.stringify(findings).includes("send-confirmation"), "the text names no value the pack wrote");
});

for (const [label, value] of [
  ["an object", { gateRenderer: "x" }],
  ["a string", "x"],
  ["null", null],
  ["true", true],
]) {
  test(`a publishing node that declares confirmations as ${label} is refused`, () => {
    const f = declaredPublishPack({ publish: { confirmations: value } });
    assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-own-gate publish"]);
  });
}

test("an empty confirmations list on a publishing node, or a confirmations list on a step declared false, is no finding", () => {
  assert.deepEqual(checkAgentFlow(declaredPublishPack({ publish: { confirmations: [] } })), []);
  assert.deepEqual(checkAgentFlow(declaredPublishPack({ write_address: { confirmations: [{ gateRenderer: "x" }] } })), []);
});

// A flow whose top-level FlowNode `send_flow` runs a subflow (kept in the root map) that ends in `send`.
function nestedSendPack({ outer = {}, inner = {}, subflowCinatra = {} } = {}) {
  const inside = flow(
    [node("send-start", "StartNode", {}), node("send", "ApiNode", { ...WRITE, publishes: false, ...inner }), node("send-end", "EndNode")],
    [["send-start", "send"], ["send", "send-end"]],
    subflowCinatra,
  );
  inside.id = "send-subflow";
  inside.name = "send-subflow";
  const outerNode = node("send_flow", "FlowNode", { publishes: false, ...outer });
  outerNode.comp.subflow = { $component_ref: "send-subflow" };
  const f = flow([node("start", "StartNode", {}), node("read_post", "ApiNode", READ), outerNode, node("end", "EndNode")], [
    ["start", "read_post"],
    ["read_post", "send_flow"],
    ["send_flow", "end"],
  ]);
  f.$referenced_components["send-subflow"] = inside;
  return f;
}

test("publishes true on the top-level node that runs a subflow is no finding", () => {
  assert.deepEqual(checkAgentFlow(nestedSendPack({ outer: { publishes: true } })), []);
});

test("publishes true on a node inside a nested subflow is refused as misplaced, as the core refuses it", () => {
  const findings = checkAgentFlow(nestedSendPack({ inner: { publishes: true } }));
  assert.deepEqual(rulesOf(findings), ["oas.publish-misplaced send"]);
  assert.match(findings[0].message, /not a top-level node/);
});

test("publishes true on a subflow definition is refused as misplaced", () => {
  assert.deepEqual(rulesOf(checkAgentFlow(nestedSendPack({ subflowCinatra: { publishes: true } }))), [
    "oas.publish-misplaced send-subflow",
  ]);
});

test("publishes true on the flow root is refused as misplaced", () => {
  assert.deepEqual(rulesOf(checkAgentFlow(declaredPublishPack({ root: { publishes: true } }))), [
    "oas.publish-misplaced (flow root)",
  ]);
});

test("publishes true on a root map component that the root flow does not list in nodes is refused as misplaced", () => {
  const f = declaredPublishPack();
  f.$referenced_components.spare = { component_type: "ApiNode", id: "spare", name: "spare", metadata: { cinatra: { ...WRITE, publishes: true } } };
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-misplaced spare"]);
});

test("publishes false inside a nested subflow is no finding", () => {
  assert.deepEqual(checkAgentFlow(nestedSendPack({ outer: { publishes: false }, inner: { publishes: false } })), []);
});

const EARLY_SCREEN = "@example/curate-agent:schema-review";
const LATE_SCREEN = "@example/curate-agent:final-list-review";

// propose -> schema_gate (screen) -> collect -> list_gate (screen) -> create (publishes) -> summary.
function twoScreenPack({ createCinatra = {}, screens = [EARLY_SCREEN, LATE_SCREEN] } = {}) {
  return flow(
    [
      node("start", "StartNode", {}),
      node("propose", "ApiNode", READ),
      node("schema_gate", "InputMessageNode", { riskClass: "read_only", renderer: EARLY_SCREEN }),
      node("collect", "ApiNode", { ...WRITE, publishes: false }),
      node("list_gate", "InputMessageNode", { riskClass: "approval", renderer: LATE_SCREEN }),
      node("list_branch", "BranchingNode"),
      node("create", "ApiNode", { ...WRITE, publishes: true, ...createCinatra }),
      node("summary", "OutputMessageNode"),
      node("end", "EndNode"),
    ],
    [
      ["start", "propose"],
      ["propose", "schema_gate"],
      ["schema_gate", "collect"],
      ["collect", "list_gate"],
      ["list_gate", "list_branch"],
      ["list_branch", "create"],
      ["list_branch", "collect"],
      ["create", "summary"],
      ["summary", "end"],
    ],
    { hitlScreens: screens },
  );
}

test("a mid-run screen placed before an earlier stop, not in front of the publishing node, is no finding", () => {
  const f = twoScreenPack({ screens: [EARLY_SCREEN] });
  const findings = checkAgentFlow(f, { fieldRenderers: [{ id: EARLY_SCREEN, midRunHitl: true }] });
  // Only the stop right in front of the write is named (by the InputMessageNode rule), never the early screen.
  assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate list_gate"]);
  assert.ok(!JSON.stringify(findings).includes("schema-review"), JSON.stringify(findings));
});

test("a mid-run screen placed on the last stop in front of the publishing node is still refused", () => {
  const f = twoScreenPack();
  const findings = checkAgentFlow(f, {
    fieldRenderers: [
      { id: EARLY_SCREEN, midRunHitl: true },
      { id: LATE_SCREEN, midRunHitl: true },
    ],
  });
  assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate list_gate", "oas.publish-own-gate create"]);
  assert.match(findings[1].message, /final-list-review/);
  assert.ok(!findings[1].message.includes("schema-review"), findings[1].message);
});

test("a mid-run screen placed after the publishing node is no finding", () => {
  const f = flow(
    [
      node("start", "StartNode", {}),
      node("publish", "ApiNode", { ...WRITE, publishes: true }),
      node("follow_up", "InputMessageNode", { renderer: SCREEN }),
      node("end", "EndNode"),
    ],
    [["start", "publish"], ["publish", "follow_up"], ["follow_up", "end"]],
    { hitlScreens: [SCREEN] },
  );
  assert.deepEqual(checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: true }] }), []);
});

test("a mid-run screen on an approval step with work steps but no stop between it and the publishing node is refused", () => {
  const f = flow(
    [
      node("start", "StartNode", {}),
      node("approve", "InputMessageNode", { riskClass: "approval", renderer: SCREEN }),
      node("file_recipients", "ApiNode", { ...WRITE, publishes: false }),
      node("publish", "ApiNode", { ...WRITE, publishes: true }),
      node("end", "EndNode"),
    ],
    [["start", "approve"], ["approve", "file_recipients"], ["file_recipients", "publish"], ["publish", "end"]],
    { hitlScreens: [SCREEN] },
  );
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: true }] })), [
    "oas.publish-own-gate publish",
  ]);
});

test("a mid-run screen placed inside the subflow of the publishing node is refused", () => {
  const f = nestedSendPack({ outer: { publishes: true } });
  const inside = f.$referenced_components["send-subflow"];
  inside.$referenced_components["send-gate"] = { component_type: "InputMessageNode", id: "send-gate", name: "send-gate", metadata: { cinatra: { renderer: SCREEN } } };
  inside.nodes.push({ $component_ref: "send-gate" });
  inside.control_flow_connections = [
    { component_type: "ControlFlowEdge", name: "a", from_node: { $component_ref: "send-start" }, to_node: { $component_ref: "send-gate" } },
    { component_type: "ControlFlowEdge", name: "b", from_node: { $component_ref: "send-gate" }, to_node: { $component_ref: "send" } },
    { component_type: "ControlFlowEdge", name: "c", from_node: { $component_ref: "send" }, to_node: { $component_ref: "send-end" } },
  ];
  f.metadata.cinatra.hitlScreens = [SCREEN];
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: true }] })), [
    "oas.publish-own-gate send_flow",
  ]);
});

test("a mid-run screen that no step places is still refused beside every publishing node", () => {
  const f = twoScreenPack({ screens: ["@example/curate-agent:unplaced"] });
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: "@example/curate-agent:unplaced", midRunHitl: true }] })), [
    "oas.publish-own-gate list_gate",
    "oas.publish-own-gate create",
  ]);
});

// Review 1 cases: the top-level identity of a true declaration, and what may place a screen.

test("publishes true on a root map object that a nearer map shadows for the listed reference is refused as misplaced", () => {
  const f = declaredPublishPack({ publish: { publishes: true } });
  const runs = { component_type: "ApiNode", id: "publish", name: "publish", metadata: { cinatra: { ...WRITE, publishes: false } } };
  const at = f.nodes.findIndex((entry) => entry.$component_ref === "publish");
  f.nodes[at] = { $component_ref: "publish", $referenced_components: { publish: runs } };
  assert.ok(rulesOf(checkAgentFlow(f)).includes("oas.publish-misplaced publish"), JSON.stringify(rulesOf(checkAgentFlow(f))));
});

test("publishes true on a root map reference wrapper is refused as misplaced, even when the listed target declares false", () => {
  const f = declaredPublishPack({ publish: { publishes: false } });
  f.$referenced_components.publish_alias = { $component_ref: "publish", metadata: { cinatra: { publishes: true } } };
  const at = f.nodes.findIndex((entry) => entry.$component_ref === "publish");
  f.nodes[at] = { $component_ref: "publish_alias" };
  assert.deepEqual(rulesOf(checkAgentFlow(f)), ["oas.publish-misplaced publish_alias"]);
});

test("publishes true on an inline node in the root nodes list is refused as misplaced (stricter than the core, which does not read it)", () => {
  const f = declaredPublishPack({ publish: { publishes: false } });
  f.nodes.push({ component_type: "ApiNode", id: "inline_send", name: "inline_send", metadata: { cinatra: { ...WRITE, publishes: true } } });
  assert.ok(rulesOf(checkAgentFlow(f)).includes("oas.publish-misplaced inline_send"));
});

test("publishes true on a node named only as start_node is refused as misplaced", () => {
  const f = declaredPublishPack();
  f.$referenced_components.first = { component_type: "ApiNode", id: "first", name: "first", metadata: { cinatra: { ...WRITE, publishes: true } } };
  f.start_node = { $component_ref: "first" };
  assert.ok(rulesOf(checkAgentFlow(f)).includes("oas.publish-misplaced first"));
});

const DECOY_SCREEN = "@example/publish-agent:decoy";

test("a renderer on an object that is not a component does not place a screen: the screen stays unplaced and is refused", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [DECOY_SCREEN] } });
  f.metadata.cinatra.decoy = { metadata: { cinatra: { renderer: DECOY_SCREEN } } };
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: DECOY_SCREEN, midRunHitl: true }] })), [
    "oas.publish-own-gate publish",
  ]);
});

test("a renderer on a reference wrapper does not place a screen: the screen stays unplaced and is refused", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [DECOY_SCREEN] } });
  f.$referenced_components.end_alias = { $component_ref: "end", component_type: "EndNode", metadata: { cinatra: { renderer: DECOY_SCREEN } } };
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: DECOY_SCREEN, midRunHitl: true }] })), [
    "oas.publish-own-gate publish",
  ]);
});

test("a renderer on a component that no flow lists, reaches or starts at does not place a screen", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [DECOY_SCREEN] } });
  f.$referenced_components.spare_gate = { component_type: "InputMessageNode", id: "spare_gate", name: "spare_gate", metadata: { cinatra: { renderer: DECOY_SCREEN } } };
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: DECOY_SCREEN, midRunHitl: true }] })), [
    "oas.publish-own-gate publish",
  ]);
});

test("a screen placed both after and in front of the publishing node is refused, and a control loop in front of it ends", () => {
  const f = flow(
    [
      node("start", "StartNode", {}),
      node("prep", "ApiNode", { ...WRITE, publishes: false, renderer: SCREEN }),
      node("loop", "BranchingNode"),
      node("publish", "ApiNode", { ...WRITE, publishes: true }),
      node("after", "InputMessageNode", { renderer: SCREEN }),
      node("end", "EndNode"),
    ],
    [["start", "prep"], ["prep", "loop"], ["loop", "prep"], ["loop", "publish"], ["publish", "after"], ["after", "end"]],
    { hitlScreens: [SCREEN] },
  );
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: true }] })), ["oas.publish-own-gate publish"]);
});

// Review 2 case: only a flow that runs (the root flow, and a subflow a running step runs) places a screen.

test("a renderer on a step of a flow-shaped value inside metadata does not place a screen: the screen stays unplaced and is refused", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [DECOY_SCREEN] } });
  f.metadata.cinatra.decoy = { nodes: [{ component_type: "InputMessageNode", metadata: { cinatra: { renderer: DECOY_SCREEN } } }] };
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: DECOY_SCREEN, midRunHitl: true }] })), [
    "oas.publish-own-gate publish",
  ]);
});

test("a renderer on a step of a subflow definition that no running step runs does not place a screen", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [DECOY_SCREEN] } });
  const unused = flow([node("u-start", "StartNode", {}), node("u-gate", "InputMessageNode", { renderer: DECOY_SCREEN }), node("u-end", "EndNode")], [
    ["u-start", "u-gate"],
    ["u-gate", "u-end"],
  ]);
  unused.id = "unused-subflow";
  f.$referenced_components["unused-subflow"] = unused;
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: DECOY_SCREEN, midRunHitl: true }] })), [
    "oas.publish-own-gate publish",
  ]);
});

test("a screen placed in a subflow that a running step after the write runs is still placed there, and is no finding", () => {
  const f = nestedSendPack({ outer: { publishes: false } });
  f.$referenced_components.publish = { component_type: "ApiNode", id: "publish", name: "publish", metadata: { cinatra: { ...WRITE, publishes: true } } };
  f.nodes.splice(2, 0, { $component_ref: "publish" });
  f.control_flow_connections = [
    ["start", "read_post"], ["read_post", "publish"], ["publish", "send_flow"], ["send_flow", "end"],
  ].map(([from, to]) => ({ component_type: "ControlFlowEdge", name: `${from}_${to}`, from_node: { $component_ref: from }, to_node: { $component_ref: to } }));
  const inside = f.$referenced_components["send-subflow"];
  inside.$referenced_components["send-gate"] = { component_type: "InputMessageNode", id: "send-gate", name: "send-gate", metadata: { cinatra: { renderer: SCREEN } } };
  inside.nodes.push({ $component_ref: "send-gate" });
  f.metadata.cinatra.hitlScreens = [SCREEN];
  assert.deepEqual(checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: true }] }), []);
});

// Review 3 cases: a subflow runs only under the kinds that run one, and what a step in front holds is in front.

// A small flow whose one gate step names `renderer`.
function gateFlow(prefix, renderer) {
  const f = flow([node(`${prefix}-start`, "StartNode", {}), node(`${prefix}-gate`, "InputMessageNode", { renderer }), node(`${prefix}-end`, "EndNode")], [
    [`${prefix}-start`, `${prefix}-gate`],
    [`${prefix}-gate`, `${prefix}-end`],
  ]);
  f.id = `${prefix}-flow`;
  return f;
}

for (const [label, attach] of [
  ["an inline subflow on the EndNode", (f) => { f.$referenced_components.end.subflow = gateFlow("d", DECOY_SCREEN); }],
  ["a subflows list on the EndNode", (f) => { f.$referenced_components.end.subflows = [gateFlow("d", DECOY_SCREEN)]; }],
  ["an inline subflow on an ApiNode", (f) => { f.$referenced_components.write_address.subflow = gateFlow("d", DECOY_SCREEN); }],
  ["a referenced subflow on the EndNode", (f) => {
    f.$referenced_components["d-flow"] = gateFlow("d", DECOY_SCREEN);
    f.$referenced_components.end.subflow = { $component_ref: "d-flow" };
  }],
  ["a start_node-only subflow on the EndNode", (f) => {
    const g = gateFlow("d", DECOY_SCREEN);
    f.$referenced_components.end.subflow = { start_node: { $component_ref: "d-gate" }, $referenced_components: g.$referenced_components };
  }],
]) {
  test(`a screen in ${label} after the write does not place it: the step kind runs no subflow, so the screen is refused`, () => {
    const f = declaredPublishPack({ root: { hitlScreens: [DECOY_SCREEN] } });
    attach(f);
    assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: DECOY_SCREEN, midRunHitl: true }] })), [
      "oas.publish-own-gate publish",
    ]);
  });
}

// start -> prep (a container step that runs a subflow holding a gate) -> publish -> end.
function containerBeforeWrite(kind, field) {
  const prep = node("prep", kind, { publishes: false });
  prep.comp[field] = field === "subflows" ? [{ $component_ref: "p-flow" }] : { $component_ref: "p-flow" };
  const f = flow(
    [node("start", "StartNode", {}), prep, node("publish", "ApiNode", { ...WRITE, publishes: true }), node("end", "EndNode")],
    [["start", "prep"], ["prep", "publish"], ["publish", "end"]],
    { hitlScreens: [SCREEN] },
  );
  f.$referenced_components["p-flow"] = gateFlow("p", SCREEN);
  return f;
}

for (const [kind, field] of [["FlowNode", "subflow"], ["MapNode", "subflow"], ["ParallelMapNode", "subflow"], ["ParallelFlowNode", "subflows"]]) {
  test(`a screen inside the subflow of a ${kind} in front of the publishing node is refused`, () => {
    const f = containerBeforeWrite(kind, field);
    assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: true }] })), ["oas.publish-own-gate publish"]);
  });
}

test("a screen inside the subflow of a FlowNode after the publishing node is no finding", () => {
  const prep = node("later", "FlowNode", { publishes: false });
  prep.comp.subflow = { $component_ref: "p-flow" };
  const f = flow(
    [node("start", "StartNode", {}), node("publish", "ApiNode", { ...WRITE, publishes: true }), prep, node("end", "EndNode")],
    [["start", "publish"], ["publish", "later"], ["later", "end"]],
    { hitlScreens: [SCREEN] },
  );
  f.$referenced_components["p-flow"] = gateFlow("p", SCREEN);
  assert.deepEqual(checkAgentFlow(f, { fieldRenderers: [{ id: SCREEN, midRunHitl: true }] }), []);
});

// ---------------------------------------------------------------------------
// A review screen is a confirm of a write only in front of it: through steps that do no work, or on an approval or
// test-send step on the wide front. A confirmations entry may name the host's publish decision.

const MID = { fieldRenderers: [{ id: SCREEN, midRunHitl: true }] };

// start -> gate (names SCREEN) -> between -> publish -> end.
function screenBefore(gateCinatra, between) {
  return flow(
    [
      node("start", "StartNode", {}),
      node("gate", "InputMessageNode", { renderer: SCREEN, ...gateCinatra }),
      node("between", between.kind, between.cinatra),
      node("publish", "ApiNode", { ...WRITE, publishes: true }),
      node("end", "EndNode"),
    ],
    [["start", "gate"], ["gate", "between"], ["between", "publish"], ["publish", "end"]],
    { hitlScreens: [SCREEN] },
  );
}
const WORK_STEP = { kind: "ApiNode", cinatra: { ...WRITE, publishes: false } };

test("a mid-run review screen with a work step between it and the publishing node is no finding", () => {
  assert.deepEqual(checkAgentFlow(screenBefore({ riskClass: "read_only" }, WORK_STEP), MID), []);
  assert.deepEqual(checkAgentFlow(screenBefore({}, WORK_STEP), MID), []);
});

for (const riskClass of ["approval", "test_send"]) {
  test(`a mid-run screen on a ${riskClass} step with a work step between it and the publishing node is refused`, () => {
    assert.deepEqual(rulesOf(checkAgentFlow(screenBefore({ riskClass }, WORK_STEP), MID)), ["oas.publish-own-gate publish"]);
  });
}

for (const [label, between] of [
  ["a read_only step", { kind: "ApiNode", cinatra: READ }],
  ["a BranchingNode", { kind: "BranchingNode" }],
  ["an OutputMessageNode", { kind: "OutputMessageNode" }],
]) {
  test(`a mid-run review screen that reaches the publishing node through ${label} only is refused`, () => {
    const findings = checkAgentFlow(screenBefore({ riskClass: "read_only" }, between), MID);
    assert.ok(rulesOf(findings).includes("oas.publish-own-gate publish"), JSON.stringify(findings));
  });
}

test("an approval screen in front of an earlier stop is no finding: the wide front ends at the first InputMessageNode", () => {
  const f = flow(
    [
      node("start", "StartNode", {}),
      node("approve", "InputMessageNode", { riskClass: "approval", renderer: SCREEN }),
      node("collect", "ApiNode", { ...WRITE, publishes: false }),
      node("ask", "InputMessageNode", {}),
      node("save", "ApiNode", { ...WRITE, publishes: false }),
      node("publish", "ApiNode", { ...WRITE, publishes: true }),
      node("end", "EndNode"),
    ],
    [["start", "approve"], ["approve", "collect"], ["collect", "ask"], ["ask", "save"], ["save", "publish"], ["publish", "end"]],
    { hitlScreens: [SCREEN] },
  );
  assert.deepEqual(checkAgentFlow(f, MID), []);
});

// start -> prep (a work FlowNode running p-flow) -> publish -> end; p-flow is p-start -> p-gate -> [p-work ->] p-end.
function workContainerBeforeWrite({ gateCinatra = {}, workInside = false } = {}) {
  const prep = node("prep", "FlowNode", { publishes: false });
  prep.comp.subflow = { $component_ref: "p-flow" };
  const f = flow(
    [node("start", "StartNode", {}), prep, node("publish", "ApiNode", { ...WRITE, publishes: true }), node("end", "EndNode")],
    [["start", "prep"], ["prep", "publish"], ["publish", "end"]],
    { hitlScreens: [SCREEN] },
  );
  const inner = [node("p-start", "StartNode", {}), node("p-gate", "InputMessageNode", { renderer: SCREEN, ...gateCinatra })];
  if (workInside) inner.push(node("p-work", "ApiNode", { ...WRITE, publishes: false }));
  inner.push(node("p-end", "EndNode"));
  const ids = inner.map((n) => n.id);
  const sub = flow(inner, ids.slice(1).map((id, i) => [ids[i], id]));
  sub.id = "p-flow";
  f.$referenced_components["p-flow"] = sub;
  return f;
}

test("a review screen that a work container runs last, right before its end, stands in front of the next publishing node", () => {
  assert.deepEqual(rulesOf(checkAgentFlow(workContainerBeforeWrite(), MID)), ["oas.publish-own-gate publish"]);
});

test("a review screen inside a work container with a work step after it is no finding; an approval one is refused", () => {
  assert.deepEqual(checkAgentFlow(workContainerBeforeWrite({ workInside: true }), MID), []);
  assert.deepEqual(rulesOf(checkAgentFlow(workContainerBeforeWrite({ workInside: true, gateCinatra: { riskClass: "approval" } }), MID)), [
    "oas.publish-own-gate publish",
  ]);
});

test("a review screen inside a read_only container crossed by the walk is refused", () => {
  const f = workContainerBeforeWrite({ workInside: true });
  f.$referenced_components.prep.metadata.cinatra = { riskClass: "read_only" };
  assert.deepEqual(rulesOf(checkAgentFlow(f, MID)), ["oas.publish-own-gate publish"]);
});

// The renderer the core selects for an InputMessageNode: inputRenderers under its output field (outputs[0].title, else
// outputs[0].id, else the node id), ahead of renderer (cinatra-ai/cinatra packages/agents/src/oas-compiler.ts:1918-1927).
function inputGate(f, { outputs, inputRenderers, renderer }) {
  const comp = f.$referenced_components.gate;
  if (outputs !== undefined) comp.outputs = outputs;
  const cin = comp.metadata.cinatra;
  delete cin.renderer;
  if (renderer !== undefined) cin.renderer = renderer;
  if (inputRenderers !== undefined) cin.inputRenderers = inputRenderers;
  return f;
}
const OTHER = "@example/publish-agent:other";

for (const [label, outputs, inputRenderers] of [
  ["outputs[0].title", [{ title: "accountScope" }], { accountScope: SCREEN }],
  ["outputs[0].id", [{ id: "accountScope" }], { accountScope: SCREEN }],
  ["the node id (no outputs)", undefined, { gate: SCREEN }],
]) {
  test(`a screen selected by an InputMessageNode's inputRenderers under ${label} is placed there: behind a work step it is no finding`, () => {
    const f = inputGate(screenBefore({ riskClass: "read_only" }, WORK_STEP), { outputs, inputRenderers });
    assert.deepEqual(checkAgentFlow(f, MID), []);
  });
}

test("an inputRenderers value under another key than the output field places nothing: the screen stays unplaced and is refused", () => {
  const f = inputGate(screenBefore({ riskClass: "read_only" }, WORK_STEP), { outputs: [{ title: "accountScope" }], inputRenderers: { decoy: SCREEN } });
  assert.deepEqual(rulesOf(checkAgentFlow(f, MID)), ["oas.publish-own-gate publish"]);
});

test("an inputRenderers value on a step that is not an InputMessageNode places nothing: the screen stays unplaced and is refused", () => {
  const f = flow(
    [node("start", "StartNode", {}), node("publish", "ApiNode", { ...WRITE, publishes: true }),
      node("later", "ApiNode", { ...WRITE, publishes: false, inputRenderers: { decoy: SCREEN } }), node("end", "EndNode")],
    [["start", "publish"], ["publish", "later"], ["later", "end"]],
    { hitlScreens: [SCREEN] },
  );
  assert.deepEqual(rulesOf(checkAgentFlow(f, MID)), ["oas.publish-own-gate publish"]);
});

test("a renderer that the output field's inputRenderers value overrides places nothing: the screen it names stays unplaced and is refused", () => {
  const f = inputGate(screenBefore({ riskClass: "read_only" }, WORK_STEP), {
    outputs: [{ title: "accountScope" }], inputRenderers: { accountScope: OTHER }, renderer: SCREEN,
  });
  assert.deepEqual(rulesOf(checkAgentFlow(f, MID)), ["oas.publish-own-gate publish"]);
});

for (const [label, inputRenderers] of [["no value", { other: OTHER }], ["a null value", { accountScope: null }]]) {
  test(`a renderer stays selected when inputRenderers has ${label} under the output field`, () => {
    const f = inputGate(screenBefore({ riskClass: "read_only" }, WORK_STEP), { outputs: [{ title: "accountScope" }], inputRenderers, renderer: SCREEN });
    assert.deepEqual(checkAgentFlow(f, MID), []);
  });
}

// start -> publish -> gate (an InputMessageNode after the write) -> end. The core draws on `gate` the renderer its
// expression selects; when that is not SCREEN, SCREEN is placed nowhere and is refused beside the write.
function gateAfterWrite(gateComp) {
  const f = flow(
    [node("start", "StartNode", {}), node("publish", "ApiNode", { ...WRITE, publishes: true }), node("gate", "InputMessageNode", {}), node("end", "EndNode")],
    [["start", "publish"], ["publish", "gate"], ["gate", "end"]],
    { hitlScreens: [SCREEN] },
  );
  Object.assign(f.$referenced_components.gate, gateComp);
  return f;
}

for (const [label, gateComp] of [
  ["an output field that is a prototype key (the core reads the inherited value, not renderer)",
    { outputs: [{ title: "constructor" }], metadata: { cinatra: { inputRenderers: {}, renderer: SCREEN } } }],
  ["outputs that is an object, not a list (the core's outputs?.[0] still reads it)",
    { outputs: { 0: { title: "actual" } }, metadata: { cinatra: { inputRenderers: { actual: OTHER, gate: SCREEN } } } }],
  ["inputRenderers that is a list (the core indexes it by the field)",
    { outputs: [{ title: "0" }], metadata: { cinatra: { inputRenderers: [OTHER], renderer: SCREEN } } }],
  ["an output field that is a boolean (the core reads the key \"true\")",
    { outputs: [{ title: true }], metadata: { cinatra: { inputRenderers: { true: OTHER }, renderer: SCREEN } } }],
  ["an output field that is an object (the core reads the key \"[object Object]\")",
    { outputs: [{ title: {} }], metadata: { cinatra: { inputRenderers: { "[object Object]": OTHER }, renderer: SCREEN } } }],
]) {
  test(`a renderer the core does not select, with ${label}, places nothing: the screen is refused`, () => {
    assert.deepEqual(rulesOf(checkAgentFlow(gateAfterWrite(gateComp), MID)), ["oas.publish-own-gate publish"]);
  });
}

test("an InputMessageNode that selects no renderer is drawn with the core's schema-field fallback: an approval gate there is refused", () => {
  // start -> gate (approval, no renderer) -> work -> publish -> later (names the fallback) -> end.
  const f = flow(
    [node("start", "StartNode", {}), node("gate", "InputMessageNode", { riskClass: "approval" }), node("work", "ApiNode", { ...WRITE, publishes: false }),
      node("publish", "ApiNode", { ...WRITE, publishes: true }), node("later", "ApiNode", { ...WRITE, publishes: false, renderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID }),
      node("end", "EndNode")],
    [["start", "gate"], ["gate", "work"], ["work", "publish"], ["publish", "later"], ["later", "end"]],
    { hitlScreens: [SCHEMA_FIELD_FALLBACK_RENDERER_ID] },
  );
  f.$referenced_components.gate.outputs = [{ title: "answer" }];
  const findings = checkAgentFlow(f, { fieldRenderers: [{ id: SCHEMA_FIELD_FALLBACK_RENDERER_ID, midRunHitl: true }] });
  assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate publish"]);
  assert.equal(SCHEMA_FIELD_FALLBACK_RENDERER_ID, "@cinatra-ai/agent-builder:schema-field-fallback");
});

// Adds `later`, an InputMessageNode after the write whose renderer is `renderer`: it places that screen after the write,
// so a test that adds it refuses the screen only through the unplaced reading (not through "placed nowhere").
function withLaterScreen(f, renderer) {
  f.$referenced_components.later = { component_type: "InputMessageNode", id: "later", name: "later", outputs: [{ title: "later" }], metadata: { cinatra: { renderer } } };
  f.nodes.push({ $component_ref: "later" });
  const edge = f.control_flow_connections.find((e) => e.from_node.$component_ref === "publish");
  edge.to_node = { $component_ref: "later" };
  f.control_flow_connections.push({ component_type: "ControlFlowEdge", name: "later_to_end", from_node: { $component_ref: "later" }, to_node: { $component_ref: "end" } });
  return f;
}

test("a component kept under two keys that select different renderers is read as unplaced: the screen is refused, also when a step after the write places it", () => {
  const f = withLaterScreen(inputGate(screenBefore({ riskClass: "read_only" }, WORK_STEP), { inputRenderers: { gate: OTHER, gate2: SCREEN } }), SCREEN);
  f.$referenced_components.gate2 = f.$referenced_components.gate;
  assert.deepEqual(rulesOf(checkAgentFlow(f, MID)), ["oas.publish-own-gate publish"]);
});

test("a selected number is read as unplaced for the screen id it spells: the screen is refused, also when a step after the write places it", () => {
  const f = withLaterScreen(inputGate(screenBefore({ riskClass: "read_only" }, WORK_STEP), { outputs: [{ title: "f" }], inputRenderers: { f: 5 } }), "5");
  f.metadata.cinatra.hitlScreens = ["5"];
  assert.deepEqual(rulesOf(checkAgentFlow(f, { fieldRenderers: [{ id: "5", midRunHitl: true }] })), ["oas.publish-own-gate publish"]);
});

test("a selected list is read as unplaced for the text it spells: an approval gate selecting [screen] in front of the write is refused", () => {
  // start -> gate (approval, selects [SCREEN]) -> publish -> later (places SCREEN after the write) -> end.
  const f = withLaterScreen(flow(
    [node("start", "StartNode", {}), node("gate", "InputMessageNode", { riskClass: "approval", inputRenderers: { f: [SCREEN] } }),
      node("publish", "ApiNode", { ...WRITE, publishes: true }), node("end", "EndNode")],
    [["start", "gate"], ["gate", "publish"], ["publish", "end"]],
    { hitlScreens: [SCREEN] },
  ), SCREEN);
  f.$referenced_components.gate.outputs = [{ title: "f" }];
  // `gate` is refused as an approval InputMessageNode in front of the write in any case; `publish` only through [SCREEN].
  assert.deepEqual(rulesOf(checkAgentFlow(f, MID)), ["oas.publish-own-gate gate", "oas.publish-own-gate publish"]);
});

test("a selection that throws refuses every mid-run screen beside every publishing step, also one a step after the write places", () => {
  // start -> publish -> gate (its output field cannot be turned into a key) -> later (places SCREEN after the write) -> end.
  const f = flow(
    [node("start", "StartNode", {}), node("publish", "ApiNode", { ...WRITE, publishes: true }),
      node("gate", "InputMessageNode", { inputRenderers: {} }), node("later", "InputMessageNode", { renderer: SCREEN }), node("end", "EndNode")],
    [["start", "publish"], ["publish", "gate"], ["gate", "later"], ["later", "end"]],
    { hitlScreens: [SCREEN] },
  );
  f.$referenced_components.gate.outputs = [{ title: { toString: 1 } }];
  f.$referenced_components.later.outputs = [{ title: "later" }];
  assert.deepEqual(rulesOf(checkAgentFlow(f, MID)), ["oas.publish-own-gate publish"]);
});

test("an InputMessageNode with no key in $referenced_components is no step of the core and places nothing: its screen is refused", () => {
  // start -> publish -> (inline InputMessageNode naming SCREEN) -> end.
  const f = flow(
    [node("start", "StartNode", {}), node("publish", "ApiNode", { ...WRITE, publishes: true }), node("end", "EndNode")],
    [["start", "publish"], ["publish", "end"]],
    { hitlScreens: [SCREEN] },
  );
  const inline = { component_type: "InputMessageNode", id: "inline", name: "inline", outputs: [{ title: "x" }], metadata: { cinatra: { renderer: SCREEN } } };
  f.nodes.push(inline);
  f.control_flow_connections[1].to_node = inline;
  f.control_flow_connections.push({ component_type: "ControlFlowEdge", name: "inline_to_end", from_node: inline, to_node: { $component_ref: "end" } });
  assert.deepEqual(rulesOf(checkAgentFlow(f, MID)), ["oas.publish-own-gate publish"]);
});

test("a screen selected by inputRenderers is placed: in front of the later write only, not in front of an earlier one", () => {
  // start -> first (publishes) -> gate (screen via inputRenderers) -> branch -> publish -> end. An unplaced screen would be
  // refused beside both writes; the placed one only beside `publish`.
  const f = flow(
    [node("start", "StartNode", {}), node("first", "ApiNode", { ...WRITE, publishes: true }),
      node("gate", "InputMessageNode", { riskClass: "read_only", inputRenderers: { accountScope: SCREEN, other: 7 } }),
      node("branch", "BranchingNode"), node("publish", "ApiNode", { ...WRITE, publishes: true }), node("end", "EndNode")],
    [["start", "first"], ["first", "gate"], ["gate", "branch"], ["branch", "publish"], ["publish", "end"]],
    { hitlScreens: [SCREEN] },
  );
  f.$referenced_components.gate.outputs = [{ title: "accountScope" }];
  assert.deepEqual(rulesOf(checkAgentFlow(f, MID)), ["oas.publish-own-gate gate", "oas.publish-own-gate publish"]);
});

test("an inputRenderers value on a step that does not run places nothing: the screen stays unplaced and is refused", () => {
  const f = declaredPublishPack({ root: { hitlScreens: [SCREEN] } });
  f.$referenced_components.spare = { component_type: "InputMessageNode", id: "spare", name: "spare", metadata: { cinatra: { inputRenderers: { a: SCREEN } } } };
  assert.deepEqual(rulesOf(checkAgentFlow(f, MID)), ["oas.publish-own-gate publish"]);
});

const PUBLISH_DECISION = Object.freeze({ tool: "email_send", decision: "publish", arguments: { to: "/gate/recipients" } });

test("a confirmations list whose entries name the host's publish decision is no finding on a publishing node", () => {
  assert.deepEqual(checkAgentFlow(declaredPublishPack({ publish: { confirmations: [PUBLISH_DECISION, { ...PUBLISH_DECISION, tool: "b" }] } })), []);
});

for (const [label, entry] of [
  ["a publish decision that also names a gateRenderer", { ...PUBLISH_DECISION, gateRenderer: "@example/publish-agent:send-confirmation" }],
  ["another decision value", { ...PUBLISH_DECISION, decision: "approve" }],
  ["no decision", { tool: "email_send", arguments: {} }],
  ["an entry that is not an object", "publish"],
]) {
  test(`a confirmations entry with ${label} is refused on a publishing node, also beside a publish decision`, () => {
    const f = declaredPublishPack({ publish: { confirmations: [PUBLISH_DECISION, entry] } });
    const findings = checkAgentFlow(f);
    assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate publish"]);
    assert.ok(!JSON.stringify(findings).includes("send-confirmation"), "the text names no value the pack wrote");
  });
}

test("a confirmations entry with a gate renderer on a step inside the publishing node is refused; a publish decision there is not", () => {
  const refused = nestedSendPack({ outer: { publishes: true }, inner: { confirmations: [{ tool: "email_send", gateRenderer: "x" }] } });
  const findings = checkAgentFlow(refused);
  assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate send_flow"]);
  assert.match(findings[0].message, /"send" inside publishing node "send_flow"/);
  assert.deepEqual(checkAgentFlow(nestedSendPack({ outer: { publishes: true }, inner: { confirmations: [PUBLISH_DECISION] } })), []);
});

// ---------------------------------------------------------------------------
// The pack shapes that move their own confirm to the host's publish confirmation (cinatra-ai/cinatra#4150): the steps,
// kinds, riskClass values, renderers and control edges of the real flows (cinatra/oas.json of list-curator-agent 1568a67b, email-outreach-agent d207b189, email-test-delivery-agent 535150c9,
// email-delivery-agent bf578fce and wordpress-agent b5e980b5), cut to what the rules read, with the write step
// declared true. `moved` is the pack once its own confirm is gone.

const LC = "@cinatra-ai/list-curator-agent";
function listCuratorShape({ moved }) {
  const n = [
    node("start", "StartNode", {}),
    node("propose", "ApiNode", READ),
    node("schema_gate", "InputMessageNode", { riskClass: "read_only", renderer: `${LC}:scrape-schema-review`, requiresApproval: true }),
    node("schema_answer_wrap", "PluginTemplateNode", { publishes: false }),
    node("schema_branch", "BranchingNode"),
    node("schema_declined", "OutputMessageNode"),
    node("collect", "ApiNode", { riskClass: "write_safe", requiresApproval: false, publishes: false }),
  ];
  const c = [["start", "propose"], ["propose", "schema_gate"], ["schema_gate", "schema_answer_wrap"], ["schema_answer_wrap", "schema_branch"],
    ["schema_branch", "collect"], ["schema_branch", "propose"], ["schema_branch", "schema_declined"], ["schema_declined", "end"]];
  if (moved) {
    c.push(["collect", "create"]);
  } else {
    n.push(
      node("list_gate", "InputMessageNode", { riskClass: "approval", renderer: `${LC}:final-list-review`, requiresApproval: true }),
      node("list_answer_wrap", "PluginTemplateNode", { publishes: false }),
      node("list_branch", "BranchingNode"),
    );
    c.push(["collect", "list_gate"], ["list_gate", "list_answer_wrap"], ["list_answer_wrap", "list_branch"], ["list_branch", "create"], ["list_branch", "collect"]);
  }
  n.push(node("create", "ApiNode", { riskClass: "write_safe", requiresApproval: false, publishes: true }), node("summary", "OutputMessageNode"), node("end", "EndNode"));
  c.push(["create", "summary"], ["summary", "end"]);
  const screens = [`${LC}:scrape-schema-review`, ...(moved ? [] : [`${LC}:final-list-review`])];
  return flow(n, c, { hitlScreens: screens });
}

test("list-curator shape: with its final list review gone, the schema review before collect is no finding", () => {
  assert.deepEqual(checkAgentFlow(listCuratorShape({ moved: true })), []);
});

test("list-curator shape: the final list review (riskClass approval) in front of create is still refused", () => {
  const findings = checkAgentFlow(listCuratorShape({ moved: false }));
  assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate create"]);
  assert.match(findings[0].message, /final-list-review/);
});

// A subflow kept in the root map under `id`, from steps and [from, to] edges.
function subflowOf(root, id, nodes, control) {
  const sub = flow(nodes, control);
  sub.id = id;
  sub.name = id;
  root.$referenced_components[id] = sub;
  return { $component_ref: id };
}
function container(id, cinatra) {
  return node(id, "FlowNode", cinatra);
}

const EO = "@cinatra-ai/email-outreach-agent";
const SEND_CONFIRMATION = "@cinatra-ai/email-delivery-agent:send-confirmation";
const DRAFTS_REVIEW = "@cinatra-ai/email-drafting-agent:email-drafts-review";
function emailOutreachShape({ moved }) {
  const recipients = container("recipients_flow", { publishes: false });
  const context = container("context_offeringContext", { publishes: false });
  const drafts = container("drafts_flow", { publishes: false });
  const sender = container("sender_flow", { publishes: true });
  const f = flow(
    [node("start", "StartNode", { renderer: `${EO}:setup-form` }), node("context_setup", "ApiNode", { ...WRITE, publishes: false }), recipients, context, drafts, sender,
      node("campaign_summary", "OutputMessageNode"), node("end", "EndNode")],
    [["start", "context_setup"], ["context_setup", "recipients_flow"], ["recipients_flow", "context_offeringContext"],
      ["context_offeringContext", "drafts_flow"], ["drafts_flow", "sender_flow"], ["sender_flow", "campaign_summary"], ["campaign_summary", "end"]],
    {
      hitlScreens: [`${EO}:list-picker`, "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review", "@cinatra-ai/context-selection-agent:context-selector",
        ...(moved ? [] : [DRAFTS_REVIEW, SEND_CONFIRMATION])],
    },
  );
  recipients.comp.subflow = subflowOf(f, "recipients-subflow", [
    node("r-start", "StartNode", {}),
    node("r-scope_gate", "InputMessageNode", { inputRenderers: { accountScope: `${EO}:list-picker` } }),
    // (its outputs[0].title is accountScope, as in the real flow; set below)
    node("r-generate", "ApiNode", { ...READ, renderer: "@cinatra-ai/email-recipient-selection-agent:output" }),
    node("r-review_gate", "InputMessageNode", { riskClass: "read_only", renderer: "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review" }),
    node("r-apply", "ApiNode", { riskClass: "recipients_update", publishes: false }),
    node("r-end", "EndNode"),
  ], [["r-start", "r-scope_gate"], ["r-scope_gate", "r-generate"], ["r-generate", "r-review_gate"], ["r-review_gate", "r-apply"], ["r-apply", "r-end"]]);
  f.$referenced_components["recipients-subflow"].$referenced_components["r-scope_gate"].outputs = [{ title: "accountScope" }];
  context.comp.subflow = subflowOf(f, "context-subflow", [
    node("c-start", "StartNode", {}),
    node("c-resolve", "ApiNode", { publishes: false }),
    node("c-mode", "BranchingNode"),
    node("c-emit", "OutputMessageNode"),
    node("c-select_gate", "InputMessageNode", { riskClass: "read_only", renderer: "@cinatra-ai/context-selection-agent:context-selector" }),
    node("c-finalize", "ApiNode", { publishes: false }),
    node("c-auto", "ApiNode", { publishes: false }),
    node("c-end", "EndNode"),
  ], [["c-start", "c-resolve"], ["c-resolve", "c-mode"], ["c-mode", "c-emit"], ["c-emit", "c-select_gate"], ["c-select_gate", "c-finalize"],
    ["c-finalize", "c-end"], ["c-mode", "c-auto"], ["c-auto", "c-end"]]);
  const draftSteps = [
    node("d-start", "StartNode", {}),
    node("d-draft", "ApiNode", { riskClass: "draft_create", publishes: false, renderer: "@cinatra-ai/email-drafting-agent:output" }),
    node("d-read", "ApiNode", READ),
    node("d-apply", "ApiNode", { riskClass: "draft_update", publishes: false }),
    node("d-end", "EndNode"),
  ];
  const draftEdges = [["d-start", "d-draft"], ["d-draft", "d-read"], ["d-apply", "d-end"]];
  if (moved) draftEdges.push(["d-read", "d-apply"]);
  else {
    draftSteps.push(node("d-approval_gate", "InputMessageNode", { riskClass: "approval", renderer: DRAFTS_REVIEW }));
    draftEdges.push(["d-read", "d-approval_gate"], ["d-approval_gate", "d-apply"]);
  }
  drafts.comp.subflow = subflowOf(f, "drafts-subflow", draftSteps, draftEdges);
  const sendSteps = [
    node("s-start", "StartNode", {}),
    node("s-file_recipients", "ApiNode", { ...WRITE, publishes: false }),
    node("s-send", "ApiNode", { riskClass: "email_send", publishes: false, ...(moved ? { confirmations: [{ ...PUBLISH_DECISION, tool: "email_outreach_send_initial_start" }] } : {}) }),
    node("s-end", "EndNode"),
  ];
  const sendEdges = [["s-file_recipients", "s-send"], ["s-send", "s-end"]];
  if (moved) sendEdges.push(["s-start", "s-file_recipients"]);
  else {
    sendSteps.push(node("s-approval_gate", "InputMessageNode", { riskClass: "approval", renderer: SEND_CONFIRMATION }));
    sendEdges.push(["s-start", "s-approval_gate"], ["s-approval_gate", "s-file_recipients"]);
  }
  sender.comp.subflow = subflowOf(f, "sender-subflow", sendSteps, sendEdges);
  return f;
}

test("email-outreach shape: with its send and drafts approvals gone, the list picker, recipients review and context selector are no finding", () => {
  assert.deepEqual(checkAgentFlow(emailOutreachShape({ moved: true })), []);
});

test("email-outreach shape: the send approval inside sender_flow is still refused", () => {
  const findings = checkAgentFlow(emailOutreachShape({ moved: false }));
  assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate sender_flow"]);
});

test("email-outreach shape: the drafts approval alone, inside drafts_flow in front of sender_flow, is still refused", () => {
  const f = emailOutreachShape({ moved: true });
  const drafts = f.$referenced_components["drafts-subflow"];
  drafts.$referenced_components["d-approval_gate"] = { component_type: "InputMessageNode", id: "d-approval_gate", name: "d-approval_gate", metadata: { cinatra: { riskClass: "approval", renderer: DRAFTS_REVIEW } } };
  drafts.nodes.push({ $component_ref: "d-approval_gate" });
  drafts.control_flow_connections = [["d-start", "d-draft"], ["d-draft", "d-read"], ["d-read", "d-approval_gate"], ["d-approval_gate", "d-apply"], ["d-apply", "d-end"]]
    .map(([from, to]) => ({ component_type: "ControlFlowEdge", name: `${from}_${to}`, from_node: { $component_ref: from }, to_node: { $component_ref: to } }));
  f.metadata.cinatra.hitlScreens.push(DRAFTS_REVIEW);
  const findings = checkAgentFlow(f);
  assert.deepEqual(rulesOf(findings), ["oas.publish-own-gate sender_flow"]);
  assert.match(findings[0].message, /email-drafts-review/);
});

const ETD = "@cinatra-ai/email-test-delivery-agent:input";
// start -> test_form_gate -> parse_action -> branch_on_action -(send)-> [resolve ->] perform_test_send -> test_form_gate; default -> summary.
function emailTestDeliveryShape({ moved, resolveStep = moved }) {
  const n = [
    node("start", "StartNode", {}),
    node("test_form_gate", "InputMessageNode", { riskClass: moved ? "read_only" : "test_send", renderer: ETD, requiresApproval: !moved }),
    node("parse_action", "ApiNode", READ),
    node("branch_on_action", "BranchingNode"),
    node("perform_test_send", "ApiNode", { riskClass: "write", requiresApproval: false, publishes: true }),
    node("test_summary", "OutputMessageNode"),
    node("end", "EndNode"),
  ];
  const c = [["start", "test_form_gate"], ["test_form_gate", "parse_action"], ["parse_action", "branch_on_action"], ["branch_on_action", "test_summary"],
    ["test_summary", "end"], ["perform_test_send", "test_form_gate"]];
  if (resolveStep) {
    n.push(node("resolve_test_request", "ApiNode", { ...WRITE, publishes: false }));
    c.push(["branch_on_action", "resolve_test_request"], ["resolve_test_request", "perform_test_send"]);
  } else {
    c.push(["branch_on_action", "perform_test_send"]);
  }
  return flow(n, c, { hitlScreens: [ETD] });
}

test("email-test-delivery shape: the form as an input screen, with a work step that resolves the request before the send, is no finding", () => {
  assert.deepEqual(checkAgentFlow(emailTestDeliveryShape({ moved: true })), []);
});

test("email-test-delivery shape: the test_send form in front of the send is still refused, also with the resolve step", () => {
  assert.deepEqual(rulesOf(checkAgentFlow(emailTestDeliveryShape({ moved: false, resolveStep: false }))), [
    "oas.publish-own-gate test_form_gate",
    "oas.publish-own-gate perform_test_send",
  ]);
  assert.deepEqual(rulesOf(checkAgentFlow(emailTestDeliveryShape({ moved: false, resolveStep: true }))), ["oas.publish-own-gate perform_test_send"]);
});

test("email-test-delivery shape: a read_only form with only a read_only step and a branch before the send is still refused", () => {
  assert.ok(rulesOf(checkAgentFlow(emailTestDeliveryShape({ moved: true, resolveStep: false }))).includes("oas.publish-own-gate test_form_gate"));
});

// start -> prepare -> [approval_gate ->] file_recipients -> send -> summary -> end.
function emailDeliveryShape({ moved, confirmations }) {
  const n = [node("start", "StartNode", {}), node("prepare", "ApiNode", READ)];
  const c = [["start", "prepare"], ["file_recipients", "send"], ["send", "summary"], ["summary", "end"]];
  if (moved) c.push(["prepare", "file_recipients"]);
  else {
    n.push(node("approval_gate", "InputMessageNode", { riskClass: "approval", renderer: SEND_CONFIRMATION, requiresApproval: true }));
    c.push(["prepare", "approval_gate"], ["approval_gate", "file_recipients"]);
  }
  n.push(
    node("file_recipients", "ApiNode", { ...WRITE, publishes: false }),
    node("send", "ApiNode", { riskClass: "email_send", requiresApproval: false, publishes: true, renderer: "@cinatra-ai/email-delivery-agent:output", confirmations }),
    node("summary", "OutputMessageNode"),
    node("end", "EndNode"),
  );
  return flow(n, c, { hitlScreens: moved ? [] : [SEND_CONFIRMATION] });
}

test("email-delivery shape: with its approval gone and a publish-decision confirmations entry on send, it is no finding", () => {
  assert.deepEqual(checkAgentFlow(emailDeliveryShape({ moved: true, confirmations: [{ ...PUBLISH_DECISION, tool: "email_outreach_send_initial_start" }] })), []);
});

test("email-delivery shape: the send-confirmation approval across file_recipients, and a gate-renderer confirmations entry, are still refused", () => {
  assert.deepEqual(rulesOf(checkAgentFlow(emailDeliveryShape({ moved: false, confirmations: [] }))), ["oas.publish-own-gate send"]);
  assert.deepEqual(rulesOf(checkAgentFlow(emailDeliveryShape({ moved: true, confirmations: [{ tool: "email_outreach_send_initial_start", gateRenderer: SEND_CONFIRMATION }] }))), [
    "oas.publish-own-gate send",
  ]);
});

test("wordpress shape: the page review gate directly in front of edit is still refused, and the pack passes without it", () => {
  const shape = (moved) => flow(
    [node("start", "StartNode", {}), node("compose_change", "ApiNode", READ), node("gather_page_review", "ApiNode", { ...WRITE, publishes: false }),
      ...(moved ? [] : [node("page_review_gate", "InputMessageNode", { riskClass: "read_only", requiresApproval: true })]),
      node("edit", "ApiNode", { ...WRITE, publishes: true }), node("end", "EndNode")],
    [["start", "compose_change"], ["compose_change", "gather_page_review"], ...(moved ? [["gather_page_review", "edit"]] : [["gather_page_review", "page_review_gate"], ["page_review_gate", "edit"]]), ["edit", "end"]],
  );
  assert.deepEqual(rulesOf(checkAgentFlow(shape(false))), ["oas.publish-own-gate page_review_gate"]);
  assert.deepEqual(checkAgentFlow(shape(true)), []);
});

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
