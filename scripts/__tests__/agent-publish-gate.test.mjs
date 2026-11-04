// Tests for the agent pack publish gate: the flow rules over in-memory flows,
// and the command line over the committed fixture packs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PUBLISH_GATE_ID_PREFIX,
  RULES,
  checkAgentFlow,
  checkAgentPackage,
} from "../agent-publish-gate.mjs";

const GATE = path.join(import.meta.dirname, "..", "agent-publish-gate.mjs");
const FIX = path.join(import.meta.dirname, "..", "__fixtures__", "agent-publish");

function runGate(args) {
  return spawnSync("node", [GATE, ...args], { encoding: "utf8" });
}

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
