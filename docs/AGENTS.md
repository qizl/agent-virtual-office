# Documentation Collaboration Rules

This file is the documentation entry point for the `docs/` tree of the agent-virtual-office repository.

## Table of Contents

- [1. Authority](#1-authority)
- [2. Plan Placement](#2-plan-placement)
- [3. Existing Documentation](#3-existing-documentation)
- [4. File Maintenance Contract](#4-file-maintenance-contract)

## 1. Authority

- Documentation governance for AI-collaboration documents (classification, naming, language, record templates, traceability) is delegated to the ai-engineering-kit `documentation-workflow` skill. Goal/Progress/Test delivery records and their transitions are owned by the `delivery-workflow` skill.
- The root `AGENTS.md` and `.agentcortex/` governance remain authoritative for the engineering workflow; this file governs only where durable design/plan documents live.

## 2. Plan Placement

- This repository maintains implementation source code only. Development plans, design notes, and refactor plans for features implemented here are maintained in the `aiengineeringkit` maintenance repository, at `docs/development/<feature-prefix>-YYYY-MM-DD.md` — Chinese body, `Delivery Contract Version: 2`, with a Feature List, startup verification (`VER-*`), and a Codex Best-Practice Review section.
- The feature prefix is stable lowercase kebab-case and is reused across classifications in the maintenance repository (`docs/goals/`, `docs/tests/`, `docs/features/`).
- Do not create new plan or spec documents inside this repository.

## 3. Existing Documentation

- Pre-existing directories (`docs/specs/`, `docs/adr/`, `docs/architecture/`, `docs/design/`, `docs/reviews/`) remain as historical material under their own governance surfaces. Do not add new plan documents to them; new plans go to the maintenance repository per §2.

## 4. File Maintenance Contract

```json
{
  "contract_version": 1,
  "scope": "docs",
  "inherit": true,
  "git_policy": "tracked",
  "content_classes": ["documentation"],
  "templates": [],
  "naming": {"plans": "maintained externally in aiengineeringkit docs/development"},
  "archives": [],
  "validation": {"index_documentation": false}
}
```
