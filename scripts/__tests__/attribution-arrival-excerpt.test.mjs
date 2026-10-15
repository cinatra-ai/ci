// The attribution gate's arrival reader reads GitHub by GitHub's published schema, and the excerpt and the conformance corpus it is
// held to are the merge road's own, byte for byte.
//
// fixtures/github-rest-excerpt.json is a minimal excerpt of GitHub's published REST description and documentation at pinned commits:
// the type, nullability, requiredness and enum of every field an arrival reader uses, the issue-event types and the review states.
// fixtures/approval-corpus/ is the conformance corpus of the merge-time reader (the authority of whether an owner's approval counts at
// a head). Both are vendored from that reader's repository; fixtures/approval-corpus.pin.json pins every file's sha256 and the
// commit they came from. Every closed set of the gate's arrival reader is compared here with the excerpt's.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ACTIVITY_KINDS, ARRIVAL_FIELD_KINDS, ARRIVAL_SCHEMAS, DECIDING_STATES, HEAD_ACTIVITY_KINDS, HEAD_EVENTS, OPTIONAL_FIELDS,
  REVIEW_STATES, TIMELINE_EVENTS, collectHeadArrival, headArrivalVerdict, makeApprovalAt,
} from "../truthful-attribution-gate.mjs";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const EXCERPT = JSON.parse(fs.readFileSync(path.join(FIXTURES, "github-rest-excerpt.json"), "utf8"));
const PIN = JSON.parse(fs.readFileSync(path.join(FIXTURES, "approval-corpus.pin.json"), "utf8"));
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const sorted = (values) => [...values].sort();

function vendoredFiles() {
  const names = fs.readdirSync(path.join(FIXTURES, "approval-corpus")).map((name) => "approval-corpus/" + name);
  return sorted([...names, "github-rest-excerpt.json"]);
}

test("the vendored excerpt and corpus are the pinned bytes of the merge-time reader's commit", () => {
  assert.match(PIN.sourceCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual(vendoredFiles(), sorted(Object.keys(PIN.files)), "the vendored files are exactly the pinned ones");
  for (const [name, digest] of Object.entries(PIN.files)) {
    assert.equal(sha256(fs.readFileSync(path.join(FIXTURES, name))), digest, name + " differs from its pinned bytes");
  }
  const whole = sha256(Object.keys(PIN.files).sort().map((name) => `${PIN.files[name]}  ${name}\n`).join(""));
  assert.equal(whole, PIN.setSha256, "the digest of the whole set");
});

test("the excerpt's sources are pinned", () => {
  const { rest, eventTypes, reviewStates } = EXCERPT.sources;
  assert.equal(rest.repository, "github/rest-api-description");
  assert.equal(rest.commit, "02a2bc3d6b42b69c18938c31b434342aa08fcd2b");
  assert.equal(rest.path, "descriptions/api.github.com/api.github.com.2026-03-10.json");
  for (const source of [rest, eventTypes, reviewStates]) {
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(eventTypes.repository, "github/docs");
  assert.equal(eventTypes.commit, reviewStates.commit);
});

test("every closed set of the arrival reader is the published one", () => {
  for (const [name, ours] of [["review.state", REVIEW_STATES], ["activity.activity_type", ACTIVITY_KINDS], ["timeline.event", TIMELINE_EVENTS]]) {
    assert.equal(new Set(ours).size, ours.length, name);
    assert.deepEqual(sorted(ours), sorted(EXCERPT.enums[name]), name);
  }
  assert.deepEqual(sorted(ACTIVITY_KINDS), sorted(EXCERPT.endpoints.activity.fields.activity_type.enum));
  // the head-moving issue events are the published list's, named
  assert.deepEqual(sorted(HEAD_EVENTS), sorted(Object.keys(EXCERPT.headMovingEvents)));
  for (const event of HEAD_EVENTS) assert.ok(TIMELINE_EVENTS.includes(event), event);
  // every activity type but a deletion sets the head, a merge of the pull request and a merge-queue merge among them
  assert.deepEqual(sorted(HEAD_ACTIVITY_KINDS), sorted(ACTIVITY_KINDS.filter((kind) => kind !== "branch_deletion")));
  for (const kind of ["pr_merge", "merge_queue_merge"]) assert.ok(HEAD_ACTIVITY_KINDS.includes(kind), kind);
  for (const state of DECIDING_STATES) assert.ok(REVIEW_STATES.includes(state), state);
  for (const state of REVIEW_STATES) assert.ok(ARRIVAL_FIELD_KINDS.reviewState(state), state);
  for (const event of TIMELINE_EVENTS) assert.ok(ARRIVAL_FIELD_KINDS.timelineEvent(event), event);
  for (const kind of ACTIVITY_KINDS) assert.ok(ARRIVAL_FIELD_KINDS.activityKind(kind), kind);
  // a name outside the published lists is refused
  assert.ok(!ARRIVAL_FIELD_KINDS.timelineEvent("head_ref_teleported"));
  assert.ok(!ARRIVAL_FIELD_KINDS.reviewState("BRAND_NEW"));
  assert.ok(!ARRIVAL_FIELD_KINDS.activityKind("branch_teleport"));
});

test("every field the arrival reader uses is described, and admits null exactly where GitHub returns it", () => {
  for (const [endpoint, schema] of Object.entries(ARRIVAL_SCHEMAS)) {
    const described = EXCERPT.endpoints[endpoint];
    assert.ok(described, endpoint + " is read but the excerpt does not describe it");
    for (const [dotted, kind] of Object.entries(schema)) {
      assert.ok(Object.hasOwn(described.fields, dotted), `${endpoint}.${dotted} is read but the excerpt does not describe it`);
      const shapes = described.fields[dotted].shapes || [described.fields[dotted]];
      const nullable = shapes.some((shape) => shape.nullable), required = shapes.every((shape) => shape.required);
      assert.equal(ARRIVAL_FIELD_KINDS[kind](null), nullable,
        `${endpoint}.${dotted}: the reader ${ARRIVAL_FIELD_KINDS[kind](null) ? "admits" : "refuses"} null, the excerpt documents nullable=${nullable}`);
      // a timeline row's fields depend on its event (the reader selects them by it)
      if (endpoint !== "timeline") assert.equal((OPTIONAL_FIELDS[endpoint] || []).includes(dotted), !required, `${endpoint}.${dotted}: requiredness`);
    }
  }
  // a review's user and a check suite's head branch are nullable: such a row is passed over, never a refusal of the reading
  assert.ok(ARRIVAL_FIELD_KINDS.nullUser(null) && ARRIVAL_FIELD_KINDS.branchNameOrNull(null));
});

test("a review id is int64 and orders nothing; a login is a free string", () => {
  assert.equal(EXCERPT.endpoints.review.fields.id.format, "int64");
  assert.ok(ARRIVAL_FIELD_KINDS.reviewId(2 ** 62) && !ARRIVAL_FIELD_KINDS.reviewId(1e19) && !ARRIVAL_FIELD_KINDS.reviewId(0));
  for (const login of ["mona_cat", "a.b", "Kelvin", "x".repeat(200), "with space"]) assert.ok(ARRIVAL_FIELD_KINDS.login(login), login);
  assert.ok(!ARRIVAL_FIELD_KINDS.login(""));
});

test("the arrival rule never reads a commit's own date", () => {
  for (const reader of [collectHeadArrival, headArrivalVerdict, makeApprovalAt]) {
    const code = reader.toString().split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
    assert.ok(!/committer|author\.date|\.author\b/.test(code), reader.name + " reads a commit's own date");
  }
});
