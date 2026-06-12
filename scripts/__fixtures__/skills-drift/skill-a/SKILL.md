---
name: skill-a-dispatch
description: Use when the user wants to RUN an existing agent via agent_run.
---

The single canonical dispatch path is `agent_run { packageName, inputParams }`.
After dispatch, poll with `agent_run_get` until the run is `completed`.

Dispatch the toolkit agent `@cinatra-ai/email-outreach-agent` with `agent_run`.
The passthrough route is `/api/agents/passthrough` for the browser bridge.
