---
name: spec-tree
description: Interactively build a decision tree for an RSpec spec, then render it as a structured spec list
---

## What I do

Guide the user through building an RSpec spec structure for a job by thinking in terms of a decision tree, then render it as a readable spec list.

## Workflow

### Phase 1: understand the domain

Ask the user to describe the thing to be tested:
- What does it do at the top level?
- What external services or APIs does it call?
- What does it persist?
- What are the key failure modes?

Read any relevant files the user points to (existing specs, domain docs, persistence models) before proceeding.

### Phase 2: build the tree interactively

Work top-down. At each level, ask:

1. **What always happens?** (unconditional `it` blocks at the top of `#perform`)
2. **What are the branching conditions?** (the `context` blocks — idempotency checks, missing data, upstream errors)
3. **For each branch: what is the observable outcome?** (not implementation steps — what changed in the database, what was or wasn't called)
4. **What failure paths share the same shape?** (candidates for a shared example)
5. **What happy-path assertions belong together?** (candidate for a wrapping context like "when the file contains valid data")

After each level, render the partial tree and ask: "does this look right, or are there branches missing?"

### Phase 3: render the spec list

Once the tree is agreed on, render it in two forms:

**Tree view** — a visual ASCII tree using `├──`, `└──`, `│` showing the decision flow, shared examples expanded inline, `✓` on leaf assertions.

**Spec list** — the flat RSpec skeleton using `shared_examples`, `context`, `describe`, and `it` with descriptions filled in. No Ruby implementation — descriptions only.

## Conventions to follow

- `context` for conditional state ("when ...", "when no ... exists")
- `describe` for non-conditional groupings (payload shapes, mapping rules)
- Shared example names in `"double quotes"`, all-caps for failure shared examples (e.g. `"IT FAILS SAFELY AND LOUDLY"`) to make them visually distinct
- Concept language in descriptions, not class names ("does not create a new forecast", not "does not create a new Maritime::Forecast")
- Observable outcomes only — never test implementation steps
- One representative domain/case is enough when the code path is identical across variants; call this out explicitly
- "always happens" tests sit at the outer `describe "#perform"` level, not inside any context

