---
name: skill-metadata-watched
description: Declares its cinatra-watches block under metadata, the upstream-validator-compatible location (Skills cluster Wave-0 dual-read). The gate must read it from metadata.cinatra-watches.
metadata:
  cinatra-watches:
    primitives:
      - workflow_draft_create
    packages:
      - "@cinatra-ai/blog-pipeline-agent"
    routes: [/api/workflows/preview]
    paths:
      - packages/workflows/src/**
---

This skill declares its watches under `metadata.cinatra-watches` instead of a
bare top-level `cinatra-watches:` key, so the upstream Anthropic SKILL.md
validator (which only allows name/description/license/allowed-tools/metadata at
top level) accepts it. The drift gate reads the nested location PREFERRED.
