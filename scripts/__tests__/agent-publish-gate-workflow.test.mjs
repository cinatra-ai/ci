// Tests for the reusable caller of the agent pack publish gate
// (.github/workflows/agent-publish-gate.yml): its inputs, its read-only permissions,
// the pinned steps, that caller inputs reach the engine only through the environment,
// and that the self-check runs the engine and its tests on this repository.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { load } from "../lib/vendor/js-yaml/js-yaml.mjs";

const NAME = "agent-publish-gate";
const ENGINE = ".agent-publish-gate/scripts/agent-publish-gate.mjs";

function readText(rel) {
  return readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
}

function readWorkflow(name) {
  return load(readText(`.github/workflows/${name}.yml`));
}

test("agent-publish-gate workflow: a reusable workflow with the four inputs and their defaults", () => {
  const workflow = readWorkflow(NAME);
  const call = workflow.on?.workflow_call;
  assert.ok(call, "the workflow is triggered by workflow_call");
  assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
  const inputs = call.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ["format", "package", "ref", "use_slim"]);
  assert.equal(inputs.package.type, "string");
  assert.equal(inputs.package.default, ".");
  assert.equal(inputs.format.type, "string");
  assert.equal(inputs.format.default, "text");
  assert.equal(inputs.ref.type, "string");
  assert.equal(inputs.ref.default, "main");
  assert.equal(inputs.use_slim.type, "boolean");
  assert.equal(inputs.use_slim.default, false);
  assert.equal(call.secrets, undefined, "the gate takes no secrets");
});

test("agent-publish-gate workflow: one read-only, bounded job on the standard runner unless slim is asked", () => {
  const workflow = readWorkflow(NAME);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), [NAME]);
  const job = workflow.jobs[NAME];
  assert.equal(job.permissions, undefined, "the job does not widen the workflow permissions");
  assert.equal(job["continue-on-error"], undefined);
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 15);
  const expression = job["runs-on"].replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  assert.equal(runInNewContext(expression, { inputs: { use_slim: false } }), "ubuntu-latest");
  assert.equal(runInNewContext(expression, { inputs: {} }), "ubuntu-latest");
  assert.equal(runInNewContext(expression, { inputs: { use_slim: true } }), "ubuntu-slim");
});

test("agent-publish-gate workflow: every action is pinned to a full commit", () => {
  const job = readWorkflow(NAME).jobs[NAME];
  const uses = job.steps.filter(step => step.uses).map(step => step.uses);
  assert.ok(uses.length >= 3);
  for (const use of uses) assert.match(use, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, use);
});

test("agent-publish-gate workflow: it checks out the caller, then this repository at the ref input into its own folder", () => {
  const steps = readWorkflow(NAME).jobs[NAME].steps;
  const checkouts = steps.filter(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkouts.length, 2);
  assert.equal(checkouts[0].with, undefined, "the first checkout is the caller at the event's own ref");
  assert.deepEqual(checkouts[1].with, {
    repository: "cinatra-ai/ci",
    ref: "${{ inputs.ref }}",
    path: ".agent-publish-gate",
  });
  const node = steps.find(step => step.uses?.startsWith("actions/setup-node@"));
  assert.equal(String(node?.with?.["node-version"]), "24");
  assert.ok(steps.indexOf(checkouts[1]) < steps.findIndex(step => step.run));
});

test("agent-publish-gate workflow: caller inputs reach the engine only through the environment", () => {
  const steps = readWorkflow(NAME).jobs[NAME].steps;
  const runs = steps.filter(step => step.run);
  assert.equal(runs.length, 1);
  const [gate] = runs;
  assert.deepEqual(gate.env, {
    APG_PACKAGE: "${{ inputs.package }}",
    APG_FORMAT: "${{ inputs.format }}",
  });
  assert.ok(!gate.run.includes("${{"), "no expression is expanded into the shell text");
  assert.ok(gate.run.includes(`node ${ENGINE}`));
  assert.ok(gate.run.includes('--package "$APG_PACKAGE"'));
  assert.ok(gate.run.includes('--format "$APG_FORMAT"'));
});

test("self-check: runs the engine tests and the workflow tests", () => {
  const selfCheck = readWorkflow("self-check");
  const testStep = selfCheck.jobs["self-check"].steps.find(step => step.name === "Tests");
  assert.ok(testStep, "the self-check job has its Tests step");
  assert.ok(testStep.run.includes("scripts/__tests__/agent-publish-gate.test.mjs"));
  assert.ok(testStep.run.includes("scripts/__tests__/agent-publish-gate-workflow.test.mjs"));
});

test("self-check: the engine passes the declared fixture and fails the undeclared fixture", () => {
  const steps = readWorkflow("self-check").jobs["self-check"].steps;
  const dogfood = steps.find(step => step.run?.includes("scripts/agent-publish-gate.mjs"));
  assert.ok(dogfood, "a self-check step runs the engine");
  assert.match(
    dogfood.run,
    /node scripts\/agent-publish-gate\.mjs --package scripts\/__fixtures__\/agent-publish\/declared-publish\n/,
  );
  assert.match(
    dogfood.run,
    /if node scripts\/agent-publish-gate\.mjs --package scripts\/__fixtures__\/agent-publish\/undeclared-publish; then\n[\s\S]*exit 1\n\s*fi/,
  );
});

test("README: names the caller of the reusable workflow", () => {
  const readme = readText("README.md");
  assert.ok(readme.includes(`uses: cinatra-ai/ci/.github/workflows/${NAME}.yml@<sha>`));
});
