import { expect, test, describe, afterEach } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import {
  assertRecorderAgent,
  deriveProjectIdentity,
  ensurePlanLibrary,
  listPlans,
  readPlan,
  recordPlan,
  validateCanonicalMarkdown,
  validateSlug,
} from "./library"

const temporaryRoots: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = `/tmp/opencode/${prefix}-${randomUUID()}`
  await fs.mkdir(directory, { recursive: true })
  temporaryRoots.push(directory)
  return directory
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(process.stdout).text()
  const stderr = await new Response(process.stderr).text()
  if ((await process.exited) !== 0) throw new Error(stderr || `git ${args.join(" ")} failed`)
  return stdout.trim()
}

async function existsForTest(file: string): Promise<boolean> {
  try {
    await fs.lstat(file)
    return true
  } catch {
    return false
  }
}

const subject = `# Approved subject\n\n## Goal\n\nReach the approved goal.\n\n## Decision\n\nThe human approved this subject.\n\n## In scope\n\nThe explicitly approved work.\n\n## Out of scope\n\nEverything else.\n\n## Plans\n\nThe plans below track execution.\n`
const plan = `# Approved plan\n\n## Goal\n\nReach the approved goal.\n\n## Context\n\nContext from the approved decision.\n\n## Decisions\n\nPreserve the approved scope.\n\n## Plan\n\n- Preserve the approved scope.\n\n\`\`\`ts\nconst rich = true\n\`\`\`\n\n## Acceptance criteria\n\nThe approved result is demonstrable.\n\n## Verification\n\nRun the relevant checks.\n\n## Status\n\nproposed\n`

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("plan library validation and identity", () => {
  test("record executor guard accepts only plan-recorder", async () => {
    expect(() => assertRecorderAgent("plan-recorder")).not.toThrow()
    const marker = `/tmp/opencode/guard-no-write-${randomUUID()}`
    expect(() => assertRecorderAgent("build")).toThrow(/plan-recorder agent/i)
    expect(() => assertRecorderAgent(undefined)).toThrow(/plan-recorder agent/i)
    expect(await existsForTest(marker)).toBe(false)
  })

  test("accepts only strict kebab-case and required Markdown", () => {
    expect(validateSlug("subject-2")).toBe(true)
    expect(validateSlug("Subject-2")).toBe(false)
    expect(validateSlug("subject_2")).toBe(false)
    expect(validateCanonicalMarkdown("subject", subject)).toBe(true)
    expect(validateCanonicalMarkdown("plan", plan)).toBe(true)
    expect(validateCanonicalMarkdown("plan", "# Missing sections\n")).toBe(false)
  })

  test("derives stable, collision-resistant identities", async () => {
    const first = await temporaryDirectory("same-name-a")
    const second = await temporaryDirectory("same-name-b")
    const firstAgain = await deriveProjectIdentity(first)
    const firstAgain2 = await deriveProjectIdentity(first)
    const secondIdentity = await deriveProjectIdentity(second)
    expect(firstAgain.id).toBe(firstAgain2.id)
    expect(firstAgain.id).not.toBe(secondIdentity.id)
    expect(firstAgain.id).toMatch(/^[a-z0-9-]+-[a-f0-9]{12}$/)
    expect(firstAgain.vcs).toBe("none")
  })

  test("groups linked worktrees and same-origin clones", async () => {
    const main = await temporaryDirectory("git-main")
    await git(main, "init", "--quiet", "--initial-branch=main")
    await fs.writeFile(path.join(main, "README.md"), "fixture\n", "utf8")
    await git(main, "add", "README.md")
    await git(main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture")
    await git(main, "remote", "add", "origin", "/tmp/opencode/shared-plan-origin.git")
    const linked = await temporaryDirectory("git-linked")
    await fs.rm(linked, { recursive: true, force: true })
    await git(main, "worktree", "add", "--detach", "--quiet", linked, "HEAD")
    const mainIdentity = await deriveProjectIdentity(main)
    const linkedIdentity = await deriveProjectIdentity(linked)
    expect(linkedIdentity.id).toBe(mainIdentity.id)
    expect(linkedIdentity.identitySource).toBe(mainIdentity.identitySource)
    const library = await temporaryDirectory("identity-library")
    await recordPlan({ root: library }, main, "ses-main", {
      decision: "create",
      subjectSlug: "stable-subject",
      subjectContent: subject,
      planAction: "new",
      planSlug: "first-plan",
      planContent: plan,
    })
    const metadataPath = path.join(library, "projects", mainIdentity.id, "project.json")
    const metadataBefore = await fs.readFile(metadataPath, "utf8")
    await recordPlan({ root: library }, linked, "ses-linked", {
      decision: "reuse",
      subjectSlug: "stable-subject",
      planAction: "new",
      planSlug: "linked-plan",
      planContent: plan,
    })
    expect(await fs.readFile(metadataPath, "utf8")).toBe(metadataBefore)

    const bare = await temporaryDirectory("git-origin")
    await git(bare, "init", "--bare", "--quiet")
    const cloneSource = await temporaryDirectory("git-source")
    await git(cloneSource, "init", "--quiet", "--initial-branch=main")
    await fs.writeFile(path.join(cloneSource, "README.md"), "clone fixture\n", "utf8")
    await git(cloneSource, "add", "README.md")
    await git(cloneSource, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture")
    await git(cloneSource, "remote", "add", "origin", bare)
    await git(cloneSource, "push", "--quiet", "origin", "main")
    const cloneOne = await temporaryDirectory("clone-one")
    const cloneTwo = await temporaryDirectory("clone-two")
    await fs.rm(cloneOne, { recursive: true, force: true })
    await fs.rm(cloneTwo, { recursive: true, force: true })
    await git(path.dirname(cloneOne), "clone", "--quiet", bare, cloneOne)
    await git(path.dirname(cloneTwo), "clone", "--quiet", bare, cloneTwo)
    const cloneOneIdentity = await deriveProjectIdentity(cloneOne)
    const cloneTwoIdentity = await deriveProjectIdentity(cloneTwo)
    expect(cloneOneIdentity.id).toBe(cloneTwoIdentity.id)
    expect(cloneOneIdentity.identitySource).toBe(cloneTwoIdentity.identitySource)
  })

  test("groups no-origin linked worktrees but separates unrelated repositories", async () => {
    const main = await temporaryDirectory("no-origin-main")
    await git(main, "init", "--quiet", "--initial-branch=main")
    await fs.writeFile(path.join(main, "README.md"), "fixture\n", "utf8")
    await git(main, "add", "README.md")
    await git(main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture")
    const linked = await temporaryDirectory("no-origin-linked")
    await fs.rm(linked, { recursive: true, force: true })
    await git(main, "worktree", "add", "--detach", "--quiet", linked, "HEAD")
    const unrelated = await temporaryDirectory("no-origin-unrelated")
    await git(unrelated, "init", "--quiet", "--initial-branch=main")
    const mainIdentity = await deriveProjectIdentity(main)
    const linkedIdentity = await deriveProjectIdentity(linked)
    const unrelatedIdentity = await deriveProjectIdentity(unrelated)
    expect(linkedIdentity.id).toBe(mainIdentity.id)
    expect(unrelatedIdentity.id).not.toBe(mainIdentity.id)
  })
})

describe("plan library repository lifecycle", () => {
  test("initialization is idempotent and preserves legacy bytes", async () => {
    const root = await temporaryDirectory("init")
    const legacy = path.join(root, "bookboost", "legacy.md")
    await fs.mkdir(path.dirname(legacy), { recursive: true })
    await fs.writeFile(legacy, "legacy bytes\n", "utf8")
    const before = await fs.readFile(legacy)
    await ensurePlanLibrary({ root })
    await ensurePlanLibrary({ root })
    expect(await fs.readFile(legacy)).toEqual(before)
    expect(await git(root, "remote")).toBe("")
    expect(await git(root, "branch", "--show-current")).toBe("main")
    expect(await git(root, "config", "--local", "commit.gpgsign")).toBe("false")
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(root, "README.md"))).mode & 0o777).toBe(0o600)
    expect(await git(root, "rev-list", "--count", "HEAD")).toBe("1")
    expect(await git(root, "status", "--porcelain")).toBe("")
  })

  test("refuses an existing remote and recovers a stale lock", async () => {
    const root = await temporaryDirectory("remote")
    await git(root, "init", "--quiet")
    await git(root, "remote", "add", "origin", "https://example.invalid/no-push")
    await expect(ensurePlanLibrary({ root })).rejects.toThrow(/remote/i)

    const isolated = await temporaryDirectory("stale-lock")
    await fs.mkdir(path.join(isolated, ".plan-library.lock"))
    const old = new Date(Date.now() - 20 * 60_000)
    await fs.utimes(path.join(isolated, ".plan-library.lock"), old, old)
    await ensurePlanLibrary({ root: isolated, staleLockMs: 1_000 })
    expect(await git(isolated, "rev-list", "--count", "HEAD")).toBe("1")

    const liveLock = await temporaryDirectory("live-lock")
    await fs.mkdir(path.join(liveLock, ".plan-library.lock"))
    await fs.writeFile(path.join(liveLock, ".plan-library.lock", "owner"), `test-owner\n${process.pid}\n0\n`, "utf8")
    const staleTime = new Date(Date.now() - 20 * 60_000)
    await fs.utimes(path.join(liveLock, ".plan-library.lock"), staleTime, staleTime)
    const started = Date.now()
    await expect(ensurePlanLibrary({ root: liveLock, staleLockMs: 1, lockTimeoutMs: 100 })).rejects.toThrow(/timed out|lock/i)
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
  })

  test("isolates plugin Git commands from failing hooks", async () => {
    const root = await temporaryDirectory("hooks")
    const hooks = await temporaryDirectory("hook-bin")
    const markerDirectory = await temporaryDirectory("hook-marker-dir")
    const marker = path.join(markerDirectory, "hook-marker")
    await fs.mkdir(hooks, { recursive: true })
    const hook = path.join(hooks, "pre-commit")
    await fs.writeFile(hook, `#!/bin/sh\nprintf marker > ${marker}\nexit 1\n`, "utf8")
    await fs.chmod(hook, 0o700)
    await git(root, "init", "--quiet", "--initial-branch=main")
    await git(root, "config", "core.hooksPath", hooks)
    await ensurePlanLibrary({ root })
    const project = await temporaryDirectory("hook-project")
    await recordPlan({ root }, project, "ses-hook", {
      decision: "create",
      subjectSlug: "hook-subject",
      subjectContent: subject,
      planAction: "new",
      planSlug: "hook-plan",
      planContent: plan,
    })
    expect(await existsForTest(marker)).toBe(false)
    expect(await git(root, "config", "core.hooksPath")).toBe("/dev/null")
    expect(await git(root, "status", "--porcelain")).toBe("")
  })
})

describe("plan library recording", () => {
  test("records, lists, reads, numbers, and rejects stale updates", async () => {
    const root = await temporaryDirectory("record")
    const project = await temporaryDirectory("project")
    const created = await recordPlan({ root }, project, "ses-create", {
      decision: "create",
      subjectSlug: "approved-subject",
      subjectContent: subject,
      planAction: "new",
      planSlug: "initial-plan",
      planContent: plan,
    })
    expect(created.plan.number).toBe(1)
    const selected = await readPlan({ root }, project, "approved-subject", 1, "initial-plan")
    expect(selected.plan.content).toContain("const rich = true")
    const listed = await listPlans({ root }, project)
    expect(listed.subjects[0].plans[0].snippet).toContain("Context from the approved decision")
    expect(listed.subjects[0].goal).toContain("Reach the approved goal")
    expect(listed.subjects[0].inScope).toContain("explicitly approved work")
    expect(listed.subjects[0].outOfScope).toContain("Everything else")

    const second = await recordPlan({ root }, project, "ses-second", {
      decision: "reuse",
      subjectSlug: "approved-subject",
      planAction: "new",
      planSlug: "follow-up",
      planContent: plan.replace("Approved plan", "Follow-up plan"),
    })
    expect(second.plan.number).toBe(2)

    const selectedSubject = await readPlan({ root }, project, "approved-subject")
    const extended = await recordPlan({ root }, project, "ses-extend-new", {
      decision: "extend",
      subjectSlug: "approved-subject",
      subjectContent: subject.replace("The explicitly approved work.", "The explicitly approved work plus the approved extension."),
      planAction: "new",
      planSlug: "approved-extension",
      planContent: plan.replace("Approved plan", "Approved extension"),
      expectedSubjectRevision: selectedSubject.subject.revision,
    })
    expect(extended.plan.number).toBe(3)
    expect((await readPlan({ root }, project, "approved-subject")).subject.content).toContain("approved extension")

    await expect(recordPlan({ root }, project, "ses-stale", {
      decision: "reuse",
      subjectSlug: "approved-subject",
      planAction: "update",
      planNumber: 1,
      planSlug: "initial-plan",
      planContent: plan.replace("approved scope", "stale scope"),
      expectedPlanRevision: "0".repeat(64),
    })).rejects.toThrow(/revision conflict/i)
  })

  test("serializes concurrent allocations for one subject", async () => {
    const root = await temporaryDirectory("concurrent")
    const project = await temporaryDirectory("project")
    await recordPlan({ root }, project, "ses-seed", {
      decision: "create",
      subjectSlug: "concurrent-subject",
      subjectContent: subject,
      planAction: "new",
      planSlug: "seed",
      planContent: plan,
    })
    const [left, right] = await Promise.all([
      recordPlan({ root }, project, "ses-left", { decision: "reuse", subjectSlug: "concurrent-subject", planAction: "new", planSlug: "left", planContent: plan }),
      recordPlan({ root }, project, "ses-right", { decision: "reuse", subjectSlug: "concurrent-subject", planAction: "new", planSlug: "right", planContent: plan }),
    ])
    expect(new Set([left.plan.number, right.plan.number])).toEqual(new Set([2, 3]))
    expect(await git(root, "status", "--porcelain")).toBe("")
  })

  test("readers wait for an in-flight record and see one committed snapshot", async () => {
    const root = await temporaryDirectory("reader-wait")
    const project = await temporaryDirectory("project")
    let release!: () => void
    let reached!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    const firstWrite = new Promise<void>((resolve) => { reached = resolve })
    const recordPromise = recordPlan({
      root,
      testHook: async (point) => {
        if (point === "after-first-write") {
          reached()
          await paused
        }
      },
    }, project, "ses-reader-wait", {
      decision: "create",
      subjectSlug: "reader-subject",
      subjectContent: subject,
      planAction: "new",
      planSlug: "reader-plan",
      planContent: plan,
    })
    await firstWrite
    let listDone = false
    let readDone = false
    const listPromise = listPlans({ root }, project).then((value) => { listDone = true; return value })
    const readPromise = readPlan({ root }, project, "reader-subject").then((value) => { readDone = true; return value })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(listDone).toBe(false)
    expect(readDone).toBe(false)
    release()
    await recordPromise
    const [listed, selected] = await Promise.all([listPromise, readPromise])
    expect(listed.subjects[0].slug).toBe("reader-subject")
    expect(selected.subject.content).toContain("## Decision")
  })

  test("aborts before writing and while waiting for the lock", async () => {
    const root = await temporaryDirectory("abort")
    const project = await temporaryDirectory("project")
    await ensurePlanLibrary({ root })
    const before = await git(root, "rev-parse", "HEAD")
    const beforeController = new AbortController()
    beforeController.abort()
    await expect(recordPlan({ root }, project, "ses-before-abort", {
      decision: "create",
      subjectSlug: "never-written",
      subjectContent: subject,
      planAction: "new",
      planSlug: "never-written",
      planContent: plan,
    }, beforeController.signal)).rejects.toThrow(/cancel/i)
    expect(await git(root, "rev-parse", "HEAD")).toBe(before)
    expect(await git(root, "status", "--porcelain")).toBe("")

    let release!: () => void
    let reached!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    const firstWrite = new Promise<void>((resolve) => { reached = resolve })
    const recordPromise = recordPlan({
      root,
      testHook: async (point) => {
        if (point === "after-first-write") {
          reached()
          await paused
        }
      },
    }, project, "ses-held-lock", {
      decision: "create",
      subjectSlug: "held-lock-subject",
      subjectContent: subject,
      planAction: "new",
      planSlug: "held-lock-plan",
      planContent: plan,
    })
    await firstWrite
    const waitingController = new AbortController()
    const waiting = listPlans({ root }, project, waitingController.signal)
    setTimeout(() => waitingController.abort(), 30)
    await expect(waiting).rejects.toThrow(/cancel/i)
    release()
    await recordPromise
    expect(await git(root, "status", "--porcelain")).toBe("")
  })

  test("rolls back injected failures and finishes after post-write cancellation", async () => {
    const root = await temporaryDirectory("recovery")
    const project = await temporaryDirectory("project")
    await expect(recordPlan({ root, testFailurePoint: "after-first-write" }, project, "ses-failure", {
      decision: "create",
      subjectSlug: "recoverable-subject",
      subjectContent: subject,
      planAction: "new",
      planSlug: "recoverable-plan",
      planContent: plan,
    })).rejects.toThrow(/injected failure/i)
    expect(await git(root, "status", "--porcelain")).toBe("")
    expect((await listPlans({ root }, project)).subjects).toHaveLength(0)

    for (const [index, point] of ["before-stage", "after-stage", "before-commit"].entries()) {
      const slug = `retry-${index}`
      await expect(recordPlan({ root, testFailurePoint: point as "before-stage" | "after-stage" | "before-commit" }, project, `ses-${slug}-failure`, {
        decision: "create",
        subjectSlug: slug,
        subjectContent: subject,
        planAction: "new",
        planSlug: "retry-plan",
        planContent: plan,
      })).rejects.toThrow(/injected failure/i)
      expect(await git(root, "status", "--porcelain")).toBe("")
      await recordPlan({ root }, project, `ses-${slug}-retry`, {
        decision: "create",
        subjectSlug: slug,
        subjectContent: subject,
        planAction: "new",
        planSlug: "retry-plan",
        planContent: plan,
      })
    }

    const controller = new AbortController()
    const committed = await recordPlan({
      root,
      testHook: (point) => {
        if (point === "after-first-write") controller.abort()
      },
    }, project, "ses-post-write-abort", {
      decision: "create",
      subjectSlug: "recoverable-subject",
      subjectContent: subject,
      planAction: "new",
      planSlug: "recoverable-plan",
      planContent: plan,
    }, controller.signal)
    expect(committed.plan.number).toBe(1)
    expect(controller.signal.aborted).toBe(true)
    expect(await git(root, "status", "--porcelain")).toBe("")

    await expect(recordPlan({ root, testFailurePoint: "after-commit" }, project, "ses-after-commit", {
      decision: "create",
      subjectSlug: "post-commit-subject",
      subjectContent: subject,
      planAction: "new",
      planSlug: "post-commit-plan",
      planContent: plan,
    })).rejects.toThrow(/injected failure/i)
    expect((await listPlans({ root }, project)).subjects.some((entry: any) => entry.slug === "post-commit-subject")).toBe(true)
    expect(await git(root, "status", "--porcelain")).toBe("")
  })

  test("fails closed on dirty canonical repositories", async () => {
    const root = await temporaryDirectory("dirty")
    const project = await temporaryDirectory("project")
    await recordPlan({ root }, project, "ses-clean", {
      decision: "create",
      subjectSlug: "dirty-subject",
      subjectContent: subject,
      planAction: "new",
      planSlug: "dirty-plan",
      planContent: plan,
    })
    await fs.writeFile(path.join(root, "unreviewed.txt"), "do not treat this as canonical\n", "utf8")
    await expect(listPlans({ root }, project)).rejects.toThrow(/uncommitted changes/i)
    await git(root, "add", "unreviewed.txt")
    await expect(readPlan({ root }, project, "dirty-subject")).rejects.toThrow(/uncommitted changes/i)
    await git(root, "restore", "--staged", "--", "unreviewed.txt")
    await fs.rm(path.join(root, "unreviewed.txt"))
  })
})
