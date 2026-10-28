# Local plan library

The `plan-library` server plugin stores canonical plans in the local-only Git
repository `~/.opencode/plan`. A project with an origin is identified from its
sanitized origin, so ordinary clones and linked worktrees share one project.
Git repositories without an origin use the absolute `git-common-dir`; non-Git
directories use their canonical path. The readable repository basename is
followed by a hash, and `project.json` records the identity so hash-prefix
collisions cannot silently merge projects. Existing metadata keeps its first
observed display/root values instead of churning when another checkout records.

## Structure and tools

Canonical content is kept at:

```text
projects/<project-id>/<subject-slug>/subject.md
projects/<project-id>/<subject-slug>/plans/<NNN>-<plan-slug>.md
projects/<project-id>/index.md
```

Legacy files outside `projects/` are left in place and are included in the
initial local commit. Slugs are strict lowercase ASCII kebab-case. The
`plan-library_list` tool returns subjects, revisions, statuses, paths, and
short snippets without loading full plan bodies. `plan-library_read` accepts a
subject slug and optional plan number/slug and returns canonical content with
SHA-256 revision hashes. `plan-library_record` accepts only generated slugs and
the current session context; it records an explicitly approved `create`,
`reuse`, or `extend` subject decision and a `new` or `update` plan action.
It never accepts filesystem paths or decides which subject matches.
The global permission rules deny all three actions by default; Build and Plan
may list/read, while only `plan-recorder` may record. The recorder also checks
its agent identity inside the tool executor as a defence-in-depth boundary.

Subject resolution is deliberately human/Sol-owned: use the list snippets and
metadata to propose candidates, then have the human approve the exact subject
slug. `create` must name a missing subject, `reuse` must name an existing one,
and `extend` must name an existing one plus its current subject revision. Extend
may create a new numbered plan or update an existing one. The recorder reports
ambiguity or inconsistency instead of choosing.

New plans receive the next free three-digit number while holding the library
lock. Subject Markdown requires `#`, `## Goal`, `## Decision`, `## In scope`,
`## Out of scope`, and `## Plans`. Plan Markdown requires `#`, `## Goal`,
`## Context`, `## Decisions`, `## Plan`, `## Acceptance criteria`,
`## Verification`, and `## Status`; `## Outcome` is optional. Approved body
Markdown, including code blocks, remains the caller's content.
Updates and extensions require the revision returned by a fresh read, so stale
sessions fail rather than overwrite newer work.

## Git, locking, and lifecycle

Initialization is idempotent, creates a private 0700 root, writes 0600 library
files, and writes a concise README and `.gitignore` when missing. New
repositories use branch `main` where supported. The repository-local identity
is `OpenCode Plan Library` / `opencode-plan@localhost`, with commit signing
disabled locally. Every record operation atomically writes changed files,
regenerates the human-readable project index, stages only those files, and
creates one ordinary local commit containing the project, subject, plan, and
caller session ID. No remote, pull, push, rebase, amend, or other history
rewriting is performed. Plugin Git commands isolate global configuration and
disable hooks; a configured remote makes the plugin refuse writes.

Initialization, numbering, reads, writes, staging, and commits use one exclusive
lock, so readers wait for an in-flight record and then see a committed snapshot.
That lock has timeout and stale-lock recovery that does not steal an old lock from a
live local PID. List/read/record fail closed when the repository is dirty or
staged. Record snapshots touched files and restores them on pre-commit failure;
process crashes can still leave useful partial content, so inspect and recover
manually before retrying. Subject statuses are `active`, `complete`, or
`superseded`; plan statuses are `proposed`, `active`, `blocked`, `complete`, or
`superseded`. Local Git history is useful for revisions but is **not** disk loss
protection: back up `~/.opencode/plan` separately.
