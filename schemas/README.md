---
title: "Kitfly Schemas"
description: "Schema versioning policy for site.yaml and theme.yaml"
last_updated: "2026-02-05"
---

# Schemas

Kitfly ships JSON Schemas for editor validation and migration detection.

## Versioned Folders

Schemas live under versioned folders:

- `schemas/v0/` - alpha schemas (Kitfly v0.x.x)
- `schemas/v1/` - stable schemas (when Kitfly reaches v1.x.x)

The `v0/` folder name indicates the maturity track, not the exact schema content version.

## Embedded Version

Each schema includes:

- `$id` - canonical identity (absolute URI)
- `$version` - schema content version (semver string)

Standalone sites are detached copies, so schemas must be self-describing.

## Backward Compatibility

For convenience, `schemas/site.schema.json` and `schemas/theme.schema.json` remain as thin wrappers
that `$ref` the latest `schemas/v0/*` schemas.

Plugin-related schemas follow the same pattern:

- `schemas/plugin.schema.json` → `schemas/v0/plugin.schema.json`
- `schemas/plugin-registry.schema.json` → `schemas/v0/plugin-registry.schema.json`
- `schemas/plugins.schema.json` → `schemas/v0/plugins.schema.json`

Shared definitions live in:

- `schemas/v0/common.schema.json` (shared `$defs` referenced by multiple schemas)
