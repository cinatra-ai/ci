---
name: skill-b-authoring
description: Use when authoring an agent and reviewing it before publish.
---

Author with `agent_source_write_files`, validate with `agent_source_validate`,
then `agent_source_publish`. Dispatch the reviewer `@cinatra-ai/email-outreach-agent`
and the linter `@cinatra-ai/lint-policy-agent` via `agent_run`.
