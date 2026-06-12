---
name: skill-watched-workflow
description: Use when drafting a workflow. Declares an explicit cinatra-watches block so the gate flags it precisely (declared-watch mode) instead of by verbatim heuristic.
cinatra-watches:
  primitives:
    - workflow_draft_create
    - workflow_template_instantiate
  packages:
    - "@cinatra-ai/blog-pipeline-agent"
  routes:
    - /api/workflows/preview
  paths:
    - packages/workflows/src/draft-actions.ts
    - packages/workflows/src/**
---

Draft with `workflow_draft_create`, then instantiate a template with
`workflow_template_instantiate`. Preview at `/api/workflows/preview`.

This skill declares its dependencies via `cinatra-watches`, so the gate matches
the declared surfaces (and the watched source paths under `packages/workflows/`)
rather than scanning every identifier that appears in this prose. Mentioning an
unrelated identifier like `agent_run_get` here must NOT flag this skill —
declared watches suppress the verbatim heuristic for this skill.
