---
name: skill-badvalue
description: a primitive watch value that the extractor can never produce (hyphen, not snake_case) must FAIL LOUD
cinatra-watches:
  primitives: [agent-run]
---
A typo'd watch value (here `agent-run` instead of `agent_run`) parses but can
never match the diff AND suppresses the heuristic — silently disabling this
skill's coverage. The gate must fail loud instead.
