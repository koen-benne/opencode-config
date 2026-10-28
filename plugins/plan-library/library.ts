import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const DISABLED_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null"

export const PLAN_LIBRARY_SCHEMA = "opencode-plan/v1"
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const README = `# OpenCode Plan Library

This directory is a local-only, Git-backed library of OpenCode plans. Canonical
plans live below projects/<project-id>/<subject-slug>/; legacy plans remain
outside projects/ and are preserved in place.

The repository deliberately has no remote. Local Git history is not a backup;
copy this directory separately if the plans matter.
`

const GITIGNORE = `# OpenCode Plan Library coordination files
.plan-library.lock/
*.plan-library-tmp-*
`

type GitResult = { stdout: string; stderr: string }

export type ProjectIdentity = {
  id: string
  displayName: string
  canonicalRoot: string
  vcs: "git" | "none"
  origin?: string
  identityHash: string
  identitySource: string
}

export type LibraryOptions = {
  root: string
  lockTimeoutMs?: number
  staleLockMs?: number
  /** Narrow failure/abort injection used only by isolated tests. */
  testFailurePoint?: FailurePoint
  testHook?: (point: FailurePoint) => void | Promise<void>
}

export type FailurePoint = "after-first-write" | "before-stage" | "after-stage" | "before-commit" | "after-commit"

export type RecordInput = {
  decision: "create" | "reuse" | "extend"
  subjectSlug: string
  subjectTitle?: string
  subjectStatus?: "active" | "complete" | "superseded"
  subjectContent?: string
  planAction: "new" | "update"
  planSlug: string
  planTitle?: string
  planContent: string
  planStatus?: "proposed" | "active" | "blocked" | "complete" | "superseded"
  planNumber?: number
  expectedSubjectRevision?: string
  expectedPlanRevision?: string
}

type ProjectLocation = {
  identity: ProjectIdentity
  directory: string
  projectPath: string
  metadataPath: string
  metadataExists: boolean
}

type LockOptions = Required<Pick<LibraryOptions, "lockTimeoutMs" | "staleLockMs">>

const defaultLockOptions: LockOptions = {
  lockTimeoutMs: 30_000,
  staleLockMs: 10 * 60_000,
}

function fail(message: string): never {
  throw new Error(`Plan library: ${message}`)
}

export function assertRecorderAgent(agent: string | undefined): void {
  if (agent !== "plan-recorder") fail("record is restricted to the plan-recorder agent")
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail("operation cancelled")
}

async function testPoint(options: LibraryOptions, point: FailurePoint): Promise<void> {
  await options.testHook?.(point)
  if (options.testFailurePoint === point) fail(`injected failure at ${point}`)
}

async function git(root: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
  checkAborted(signal)
  try {
    const result = await execFileAsync("git", ["-C", root, "-c", `core.hooksPath=${DISABLED_HOOKS_PATH}`, ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      signal,
      env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
    } as never)
    return { stdout: String(result.stdout), stderr: String(result.stderr) }
  } catch (error) {
    const details = error as { stderr?: string; message?: string }
    throw new Error(details.stderr?.trim() || details.message || "git command failed")
  }
}

async function gitQuiet(root: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
  try {
    return (await git(root, args, signal)).stdout.trim()
  } catch {
    return undefined
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function rejectSymlink(target: string, label: string): Promise<void> {
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) fail(`refusing a symbolic link for ${label}: ${target}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function relativePath(root: string, target: string): string {
  const relative = path.relative(root, target).split(path.sep).join("/")
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    fail(`refusing a path outside the library root: ${target}`)
  }
  return relative
}

function assertSlug(slug: string, label = "slug"): string {
  if (!SLUG_PATTERN.test(slug)) fail(`${label} must be strict kebab-case (for example, my-subject)`)
  return slug
}

export function validateSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

function normalizedSlug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized || "project"
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export async function revisionForFile(file: string): Promise<string> {
  return sha256(await fs.readFile(file))
}

function redactOrigin(value: string): string {
  const trimmed = value.trim().replace(/\.git$/, "")
  const scp = !trimmed.includes("://") ? trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/) : undefined
  if (scp) return `${scp[1]}/${scp[2]}`
  try {
    const url = new URL(trimmed)
    return `${url.hostname}${url.port ? `:${url.port}` : ""}/${url.pathname.replace(/^\//, "")}`
  } catch {
    return trimmed.replace(/\/\/[^/]+@/, "//")
  }
}

async function canonicalDirectory(directory: string): Promise<string> {
  try {
    return await fs.realpath(path.resolve(directory))
  } catch {
    return path.resolve(directory)
  }
}

export async function deriveProjectIdentity(directory: string): Promise<ProjectIdentity> {
  const inputDirectory = await canonicalDirectory(directory)
  const gitRootRaw = await gitQuiet(inputDirectory, ["rev-parse", "--show-toplevel"])
  const gitRoot = gitRootRaw ? await canonicalDirectory(gitRootRaw) : undefined
  const commonDirRaw = gitRoot ? await gitQuiet(inputDirectory, ["rev-parse", "--git-common-dir"]) : undefined
  const commonDir = commonDirRaw
    ? await canonicalDirectory(path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(inputDirectory, commonDirRaw))
    : undefined
  const canonicalRoot = gitRoot || inputDirectory
  const originRaw = gitRoot ? await gitQuiet(canonicalRoot, ["remote", "get-url", "origin"]) : undefined
  const origin = originRaw ? redactOrigin(originRaw) : undefined
  const identitySource = origin
    ? `git-origin|origin=${origin}`
    : commonDir
      ? `git-common|common=${commonDir}`
      : `nongit|root=${canonicalRoot}`
  const identityHash = sha256(identitySource)
  const displayName = normalizedSlug(origin
    ? origin.split("/").filter(Boolean).at(-1) || path.basename(canonicalRoot)
    : commonDir && path.basename(commonDir) === ".git"
      ? path.basename(path.dirname(commonDir))
      : path.basename(canonicalRoot))
  return {
    id: `${displayName}-${identityHash.slice(0, 12)}`,
    displayName,
    canonicalRoot,
    vcs: gitRoot ? "git" : "none",
    ...(origin ? { origin } : {}),
    identityHash,
    identitySource,
  }
}

async function writeAtomic(target: string, content: string): Promise<boolean> {
  await rejectSymlink(target, "a canonical file")
  if (await exists(target)) {
    const old = await fs.readFile(target, "utf8")
    if (old === content) {
      await fs.chmod(target, 0o600).catch(() => undefined)
      return false
    }
  }
  const parent = path.dirname(target)
  await fs.mkdir(parent, { recursive: true })
  const temporary = path.join(parent, `.plan-library-tmp-${randomUUID()}`)
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
    await fs.rename(temporary, target)
    return true
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function acquireLock(root: string, options: LockOptions, signal?: AbortSignal): Promise<() => Promise<void>> {
  const lockPath = path.join(root, ".plan-library.lock")
  const started = Date.now()
  while (true) {
    checkAborted(signal)
    try {
      await fs.mkdir(lockPath)
      const owner = `${randomUUID()}\n${process.pid}\n${Date.now()}\n`
      await fs.writeFile(path.join(lockPath, "owner"), owner, { encoding: "utf8", mode: 0o600 })
      let released = false
      return async () => {
        if (released) return
        released = true
        try {
          if ((await fs.readFile(path.join(lockPath, "owner"), "utf8")) === owner) {
            await fs.rm(lockPath, { recursive: true, force: true })
          }
        } catch {
          // Another process may have recovered the lock; never remove its lock.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        const age = Date.now() - (await fs.stat(lockPath)).mtimeMs
        if (age > options.staleLockMs) {
          let ownerPid: number | undefined
          try {
            const ownerLines = (await fs.readFile(path.join(lockPath, "owner"), "utf8")).split(/\r?\n/)
            ownerPid = Number(ownerLines[1])
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
          if (!ownerPid || !(await processIsAlive(ownerPid))) {
            const stale = `${lockPath}.stale-${randomUUID()}`
            if ((await fs.rename(lockPath, stale).then(() => true).catch(() => false))) {
              await fs.rm(stale, { recursive: true, force: true }).catch(() => undefined)
              continue
            }
          }
        }
      } catch {
        // The lock disappeared between stat and inspection; retry.
      }
      if (Date.now() - started >= options.lockTimeoutMs) {
        fail(`timed out waiting for the exclusive lock (${lockPath})`)
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let onAbort: (() => void) | undefined
        const cleanup = () => {
          if (onAbort && signal) signal.removeEventListener("abort", onAbort)
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        }, 50)
        if (signal) {
          onAbort = () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            cleanup()
            reject(new Error("Plan library: operation cancelled"))
          }
          signal.addEventListener("abort", onAbort, { once: true })
        }
      })
    }
  }
}

async function withLock<T>(options: LibraryOptions, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const root = path.resolve(options.root)
  await fs.mkdir(root, { recursive: true })
  await fs.chmod(root, 0o700).catch(() => undefined)
  const release = await acquireLock(root, { ...defaultLockOptions, ...options }, signal)
  try {
    return await operation()
  } finally {
    await release()
  }
}

async function assertNoRemote(root: string): Promise<void> {
  const remotes = await git(root, ["remote"]).then((result) => result.stdout.trim())
  if (remotes) fail(`refusing to write: the local plan repository has remote(s) configured (${remotes})`)
}

async function initializeUnlocked(root: string): Promise<void> {
  const repository = await gitQuiet(root, ["rev-parse", "--git-dir"])
  const wasRepository = repository !== undefined
  if (!wasRepository) {
    try {
      await git(root, ["init", "--quiet", "--initial-branch=main"])
    } catch {
      await git(root, ["init", "--quiet"])
      await git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]).catch(() => undefined)
    }
  }
  await assertNoRemote(root)
  await git(root, ["config", "user.name", "OpenCode Plan Library"])
  await git(root, ["config", "user.email", "opencode-plan@localhost"])
  await git(root, ["config", "commit.gpgsign", "false"])
  await git(root, ["config", "core.hooksPath", DISABLED_HOOKS_PATH])

  const changed: string[] = []
  if (!(await exists(path.join(root, "README.md")))) {
    if (await writeAtomic(path.join(root, "README.md"), README)) changed.push("README.md")
  } else await fs.chmod(path.join(root, "README.md"), 0o600).catch(() => undefined)
  if (!(await exists(path.join(root, ".gitignore")))) {
    if (await writeAtomic(path.join(root, ".gitignore"), GITIGNORE)) changed.push(".gitignore")
  } else await fs.chmod(path.join(root, ".gitignore"), 0o600).catch(() => undefined)

  const head = await gitQuiet(root, ["rev-parse", "--verify", "HEAD"])
  if (!head) {
    changed.push("README.md", ".gitignore")
    changed.push(...(await legacyMarkdownFiles(root)))
    const unique = [...new Set(changed)]
    await git(root, ["add", "--", ...unique])
    await git(root, ["commit", "--only", "--no-verify", "--quiet", "-m", "plan: initialize local library", "--", ...unique])
    return
  }

  if (changed.length) {
    const unique = [...new Set(changed)]
    await git(root, ["add", "--", ...unique])
    await git(root, ["commit", "--only", "--no-verify", "--quiet", "-m", "plan: add local library metadata", "--", ...unique])
  }
}

async function legacyMarkdownFiles(root: string): Promise<string[]> {
  const result: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "projects" || entry.name === ".plan-library.lock") continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile() && entry.name.endsWith(".md")) result.push(relativePath(root, absolute))
    }
  }
  await visit(root)
  return result.sort()
}

export async function ensurePlanLibrary(options: LibraryOptions, signal?: AbortSignal): Promise<void> {
  await withLock(options, async () => initializeUnlocked(path.resolve(options.root)), signal)
}

async function assertRepositoryClean(root: string, operation: string): Promise<void> {
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (status.stdout.trim()) {
    fail(`${operation} refused: the plan repository has uncommitted changes; inspect and recover manually before retrying`)
  }
}

async function withCanonicalRead<T>(
  options: LibraryOptions,
  directory: string,
  operation: string,
  signal: AbortSignal | undefined,
  callback: (root: string, location: ProjectLocation) => Promise<T>,
): Promise<T> {
  checkAborted(signal)
  return withLock(options, async () => {
    const root = path.resolve(options.root)
    await initializeUnlocked(root)
    await assertRepositoryClean(root, operation)
    checkAborted(signal)
    const location = await locateProject(root, directory)
    return callback(root, location)
  }, signal)
}

function projectMetadata(identity: ProjectIdentity): string {
  return `${JSON.stringify({
    schema: PLAN_LIBRARY_SCHEMA,
    projectId: identity.id,
    displayName: identity.displayName,
    canonicalRoot: identity.canonicalRoot,
    vcs: identity.vcs,
    origin: identity.origin,
    identityHash: identity.identityHash,
    identitySource: identity.identitySource,
  }, null, 2)}\n`
}

async function locateProject(root: string, directory: string): Promise<ProjectLocation> {
  const identity = await deriveProjectIdentity(directory)
  const projectsRoot = path.join(root, "projects")
  await fs.mkdir(projectsRoot, { recursive: true })
  for (const hashLength of [12, 20, 64]) {
    const id = `${identity.displayName}-${identity.identityHash.slice(0, hashLength)}`
    const projectPath = path.join(projectsRoot, id)
    const metadataPath = path.join(projectPath, "project.json")
    if (!(await exists(projectPath))) {
      return { identity: { ...identity, id }, directory, projectPath, metadataPath, metadataExists: false }
    }
    await rejectSymlink(projectPath, "a project directory")
    if (!(await isDirectory(projectPath))) continue
    if (await exists(metadataPath)) {
      await rejectSymlink(metadataPath, "project metadata")
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { identityHash?: string; identitySource?: string }
      if (metadata.identityHash === identity.identityHash && metadata.identitySource === identity.identitySource) {
        const stored = metadata as Partial<ProjectIdentity>
        return {
          identity: {
            ...identity,
            id,
            displayName: typeof stored.displayName === "string" ? stored.displayName : identity.displayName,
            canonicalRoot: typeof stored.canonicalRoot === "string" ? stored.canonicalRoot : identity.canonicalRoot,
            ...(typeof stored.origin === "string" ? { origin: stored.origin } : identity.origin ? { origin: identity.origin } : {}),
          },
          directory,
          projectPath,
          metadataPath,
          metadataExists: true,
        }
      }
      continue
    }
    if ((await fs.readdir(projectPath)).length === 0) {
      return { identity: { ...identity, id }, directory, projectPath, metadataPath, metadataExists: false }
    }
  }
  fail(`project identity collision could not be resolved for ${identity.displayName}`)
}

function parseFrontmatter(content: string): { values: Record<string, string>; body: string; rawLines: string[] } {
  const match = content.match(/^---(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)---(?:(?:\r\n|\r|\n))?/)
  if (!match) return { values: {}, body: content, rawLines: [] }
  const values: Record<string, string> = {}
  const rawLines = match[1].split(/\r\n|\r|\n/)
  for (const line of rawLines) {
    const parsed = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!parsed) continue
    let value = parsed[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[parsed[1]] = value
  }
  return { values, body: content.slice(match[0].length), rawLines }
}

function yamlValue(value: string | number): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value)
}

type Fence = { character: "`" | "~"; length: number; closePrefixes: string[]; contentPrefixes: string[]; container: boolean }

function openingFence(line: string): Fence | undefined {
  let position = 0
  const leading = line.match(/^ */)?.[0] || ""
  position = leading.length
  let closePrefix = leading
  let container = leading.length >= 4

  while (position < line.length) {
    const padding = line.slice(position).match(/^ */)?.[0] || ""
    if (padding) {
      if (!container || padding.length > 3) return undefined
      position += padding.length
      closePrefix += padding
    }

    if (line[position] === ">") {
      container = true
      position += 1
      closePrefix += ">"
      if (line[position] === " ") {
        position += 1
        closePrefix += " "
      }
      continue
    }

    const list = line.slice(position).match(/^(?:[-+*]|\d{1,9}[.)]) {1,4}/)
    if (list) {
      container = true
      position += list[0].length
      closePrefix += " ".repeat(list[0].length)
      continue
    }
    break
  }

  const match = line.slice(position).match(/^(`{3,}|~{3,})(.*)$/)
  if (!match) return undefined
  if (match[1][0] === "`" && match[2].includes("`")) return undefined
  const exactPrefix = line.slice(0, position)
  const basePrefixes = container ? [exactPrefix, closePrefix] : [""]
  const closePrefixes = basePrefixes.flatMap((prefix) => Array.from({ length: 4 }, (_, index) => `${prefix}${" ".repeat(index)}`))
  const contentPrefixes = container
    ? Array.from({ length: 4 }, (_, index) => `${closePrefix}${" ".repeat(index)}`)
    : []
  return {
    character: match[1][0] as Fence["character"],
    length: match[1].length,
    closePrefixes: [...new Set(closePrefixes)],
    contentPrefixes: [...new Set(contentPrefixes)],
    container,
  }
}

function closesFence(line: string, fence: Fence): boolean {
  for (const prefix of fence.closePrefixes) {
    if (!line.startsWith(prefix)) continue
    const match = line.slice(prefix.length).match(/^([`~]+)[ \t]*$/)
    if (!match || match[1].length < fence.length) continue
    if (match[1].split("").every((character) => character === fence.character)) return true
  }
  return false
}

function isBlankMarkdownLine(line: string): boolean {
  return /^[ \t]*$/.test(line)
}

function belongsToFenceContainer(line: string, fence: Fence): boolean {
  return !fence.container || isBlankMarkdownLine(line) || fence.contentPrefixes.some((prefix) => line.startsWith(prefix)) || closesFence(line, fence)
}

function failUnexpectedTab(kind: "subject" | "plan", lineNumber: number): never {
  fail(`${kind} content contains an unexpected tab character (U+0009) on line ${lineNumber}; tabs are allowed only inside fenced code blocks`)
}

function assertMarkdownControls(kind: "subject" | "plan", content: string): void {
  let fence: Fence | undefined
  let deferredTabLine: number | undefined
  let position = 0
  let lineNumber = 1

  while (position <= content.length) {
    let end = position
    while (end < content.length && content[end] !== "\n" && content[end] !== "\r") end += 1
    const line = content.slice(position, end)
    if (fence && !belongsToFenceContainer(line, fence)) {
      if (deferredTabLine !== undefined) failUnexpectedTab(kind, deferredTabLine)
      fence = undefined
    }
    const inFence = fence !== undefined
    for (let index = 0; index < line.length; index += 1) {
      const code = line.charCodeAt(index)
      if (code === 9 && inFence) {
        deferredTabLine ??= lineNumber
        continue
      }
      if ((code >= 0 && code <= 31) || code === 127) {
        const value = `U+${code.toString(16).padStart(4, "0").toUpperCase()}`
        if (code === 9) {
          failUnexpectedTab(kind, lineNumber)
        }
        fail(`${kind} content contains an unexpected ASCII control character (${value}) on line ${lineNumber}`)
      }
    }

    if (fence) {
      if (closesFence(line, fence)) {
        fence = undefined
        deferredTabLine = undefined
      }
    } else {
      fence = openingFence(line)
    }

    if (end === content.length) break
    position = content[end] === "\r" && content[end + 1] === "\n" ? end + 2 : end + 1
    lineNumber += 1
  }

  if (deferredTabLine !== undefined) {
    failUnexpectedTab(kind, deferredTabLine)
  }
}

function canonicalMarkdown(kind: "subject" | "plan", content: string, metadata: Record<string, string | number>): string {
  if (typeof content !== "string" || !content.trim()) fail(`${kind} content must not be empty`)
  assertMarkdownControls(kind, content)
  const parsed = parseFrontmatter(content)
  const body = /(?:\r\n|\r|\n)$/.test(parsed.body) ? parsed.body : `${parsed.body}\n`
  const lineStart = "(?:^|[\\r\\n])"
  const required = kind === "subject"
    ? [new RegExp(`${lineStart}#\\s+\\S`, "im"), new RegExp(`${lineStart}##\\s+Goal\\b`, "im"), new RegExp(`${lineStart}##\\s+Decision\\b`, "im"), new RegExp(`${lineStart}##\\s+In scope\\b`, "im"), new RegExp(`${lineStart}##\\s+Out of scope\\b`, "im"), new RegExp(`${lineStart}##\\s+Plans\\b`, "im")]
    : [new RegExp(`${lineStart}#\\s+\\S`, "im"), new RegExp(`${lineStart}##\\s+Goal\\b`, "im"), new RegExp(`${lineStart}##\\s+Context\\b`, "im"), new RegExp(`${lineStart}##\\s+Decisions\\b`, "im"), new RegExp(`${lineStart}##\\s+Plan\\b`, "im"), new RegExp(`${lineStart}##\\s+Acceptance criteria\\b`, "im"), new RegExp(`${lineStart}##\\s+Verification\\b`, "im"), new RegExp(`${lineStart}##\\s+Status\\b`, "im")]
  if (required.some((pattern) => !pattern.test(body))) {
    fail(`${kind} content is missing required Markdown headings`)
  }
  const reserved = new Set(Object.keys(metadata))
  const extraFrontmatter = parsed.rawLines.filter((line) => {
    const key = line.match(/^([A-Za-z0-9_-]+):\s*/)?.[1]
    return !key || !reserved.has(key)
  })
  const header = Object.entries(metadata).map(([key, value]) => `${key}: ${yamlValue(value)}`).concat(extraFrontmatter)
  return `---\n${header.join("\n")}\n---\n${body}`
}

export function validateCanonicalMarkdown(kind: "subject" | "plan", content: string): boolean {
  try {
    canonicalMarkdown(kind, content, {})
    return true
  } catch {
    return false
  }
}

function snippet(content: string): string {
  const body = parseFrontmatter(content).body
    .replace(/^```[\s\S]*?```/gm, " ")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[`*_>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return body.length > 240 ? `${body.slice(0, 237)}...` : body
}

function sectionSummary(content: string, heading: string): string {
  const body = parseFrontmatter(content).body
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = body.match(new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s+|^#\\s+|$)`, "im"))
  if (!match) return ""
  const value = match[1]
    .replace(/^```[\s\S]*?```/gm, " ")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[`*_>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return value.length > 240 ? `${value.slice(0, 237)}...` : value
}

function titleFrom(values: Record<string, string>, fallback: string): string {
  return values.title || fallback
}

async function projectEntries(location: ProjectLocation): Promise<{ subjects: any[]; files: Map<string, string> }> {
  const subjects: any[] = []
  const files = new Map<string, string>()
  const root = path.dirname(path.dirname(location.projectPath))
  if (!(await exists(location.projectPath))) return { subjects, files }
  for (const subjectEntry of await fs.readdir(location.projectPath, { withFileTypes: true })) {
    if (!subjectEntry.isDirectory() || subjectEntry.name === ".git") continue
    const subjectSlug = subjectEntry.name
    if (!validateSlug(subjectSlug)) continue
    if ((await fs.lstat(path.join(location.projectPath, subjectSlug))).isSymbolicLink()) continue
    const subjectPath = path.join(location.projectPath, subjectSlug, "subject.md")
    if (!(await exists(subjectPath))) continue
    const subjectContent = await fs.readFile(subjectPath, "utf8")
    const subjectRevision = sha256(subjectContent)
    files.set(subjectSlug, subjectContent)
    const subjectMeta = parseFrontmatter(subjectContent).values
    const plans: any[] = []
    const plansPath = path.join(location.projectPath, subjectSlug, "plans")
    if (await exists(plansPath)) await rejectSymlink(plansPath, "a plans directory")
    if (await isDirectory(plansPath)) {
      for (const planEntry of (await fs.readdir(plansPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const match = planEntry.name.match(/^(\d{3})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/)
        if (!planEntry.isFile() || !match) continue
        const planPath = path.join(plansPath, planEntry.name)
        const planContent = await fs.readFile(planPath, "utf8")
        const planMeta = parseFrontmatter(planContent).values
        plans.push({
          number: Number(match[1]),
          slug: match[2],
          title: titleFrom(planMeta, match[2]),
          status: planMeta.status || "unknown",
          path: relativePath(root, planPath),
          revision: sha256(planContent),
          snippet: snippet(planContent),
        })
      }
    }
    subjects.push({
      slug: subjectSlug,
      title: titleFrom(subjectMeta, subjectSlug),
      status: subjectMeta.status || "active",
      goal: sectionSummary(subjectContent, "Goal"),
      inScope: sectionSummary(subjectContent, "In scope"),
      outOfScope: sectionSummary(subjectContent, "Out of scope"),
      path: relativePath(root, subjectPath),
      revision: subjectRevision,
      snippet: snippet(subjectContent),
      plans,
    })
  }
  subjects.sort((a, b) => a.slug.localeCompare(b.slug))
  return { subjects, files }
}

function indexMarkdown(location: ProjectLocation, subjects: any[]): string {
  const lines = [
    `# Plan Index: ${location.identity.displayName}`,
    "",
    `- Project ID: ${location.identity.id}`,
    `- Repository: ${location.identity.canonicalRoot}`,
    `- VCS: ${location.identity.vcs}`,
    "",
    "## Subjects",
    "",
  ]
  if (!subjects.length) lines.push("No canonical subjects recorded yet.", "")
  for (const subject of subjects) {
    lines.push(`### ${subject.title} (${subject.slug})`, "", `- Status: ${subject.status}`, `- Subject: ${subject.path}`, `- Revision: ${subject.revision}`)
    if (!subject.plans.length) lines.push("- Plans: none")
    else {
      lines.push("- Plans:")
      for (const plan of subject.plans) lines.push(`  - ${String(plan.number).padStart(3, "0")} ${plan.title} — ${plan.status} — ${plan.revision.slice(0, 12)}`)
    }
    lines.push("")
  }
  return `${lines.join("\n")}\n`
}

function safeExpected(value: string | undefined, label: string): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} revision must be a SHA-256 hash from a fresh read`)
  return value
}

type FileSnapshot = { path: string; existed: boolean; content?: Uint8Array; mode?: number }

async function snapshotFiles(files: string[]): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = []
  for (const file of [...new Set(files)]) {
    await rejectSymlink(file, "a touched canonical file")
    try {
      const stat = await fs.stat(file)
      snapshots.push({ path: file, existed: true, content: await fs.readFile(file), mode: stat.mode & 0o777 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      snapshots.push({ path: file, existed: false })
    }
  }
  return snapshots
}

async function writeAtomicBytes(target: string, content: Uint8Array, mode = 0o600): Promise<void> {
  await rejectSymlink(target, "a canonical file")
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = path.join(path.dirname(target), `.plan-library-tmp-${randomUUID()}`)
  try {
    await fs.writeFile(temporary, content, { mode })
    await fs.rename(temporary, target)
    await fs.chmod(target, mode).catch(() => undefined)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function restoreSnapshots(root: string, snapshots: FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    await rejectSymlink(snapshot.path, "a touched canonical file during recovery")
    if (snapshot.existed) {
      await writeAtomicBytes(snapshot.path, snapshot.content!, snapshot.mode || 0o600)
    } else if (await exists(snapshot.path)) {
      await fs.rm(snapshot.path)
    }
  }
  const paths = snapshots.map((snapshot) => relativePath(root, snapshot.path))
  const staged = await git(root, ["diff", "--cached", "--name-only", "--", ...paths])
  if (staged.stdout.trim()) await git(root, ["restore", "--staged", "--", ...paths])
}

async function removeEmptyDirectories(directories: string[]): Promise<void> {
  for (const directory of [...new Set(directories)].sort((a, b) => b.length - a.length)) {
    try {
      if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error
    }
  }
}

async function head(root: string): Promise<string> {
  const value = await gitQuiet(root, ["rev-parse", "HEAD"])
  if (!value) fail("plan repository has no HEAD")
  return value
}

function sessionCommitPart(sessionID: string): string {
  return sessionID.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 160) || "unknown-session"
}

async function stagedPaths(root: string): Promise<Set<string>> {
  const output = await git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"]).then((result) => result.stdout)
  return new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
}

async function commitOperation(root: string, pathsToCommit: string[], message: string, options: LibraryOptions, state: { committed: boolean }): Promise<string> {
  const unique = [...new Set(pathsToCommit)].sort()
  if (!unique.length) fail("operation produced no changed files")
  const staged = await stagedPaths(root)
  const overlap = unique.filter((file) => staged.has(file))
  if (overlap.length) fail(`refusing to overwrite pre-staged changes: ${overlap.join(", ")}`)
  await testPoint(options, "before-stage")
  await git(root, ["add", "--", ...unique])
  await testPoint(options, "after-stage")
  await testPoint(options, "before-commit")
  await git(root, ["commit", "--only", "--no-verify", "--quiet", "-m", message, "--", ...unique])
  state.committed = true
  await testPoint(options, "after-commit")
  const commit = await gitQuiet(root, ["rev-parse", "HEAD"])
  if (!commit) fail("commit completed but its hash could not be read; inspect the clean local repository")
  return commit
}

export async function listPlans(options: LibraryOptions, directory: string, signal?: AbortSignal): Promise<any> {
  return withCanonicalRead(options, directory, "list", signal, async (_root, location) => {
    const entries = await projectEntries(location)
    checkAborted(signal)
    return { project: location.identity, subjects: entries.subjects }
  })
}

export async function readPlan(options: LibraryOptions, directory: string, subjectSlug: string, planNumber?: number, planSlug?: string, signal?: AbortSignal): Promise<any> {
  assertSlug(subjectSlug, "subject slug")
  if (planNumber !== undefined && (!Number.isInteger(planNumber) || planNumber < 1 || planNumber > 999)) fail("plan number must be an integer from 1 to 999")
  if (planNumber !== undefined) assertSlug(planSlug || "", "plan slug")
  return withCanonicalRead(options, directory, "read", signal, async (root, location) => {
    await rejectSymlink(path.join(location.projectPath, subjectSlug), "a subject directory")
    const subjectPath = path.join(location.projectPath, subjectSlug, "subject.md")
    await rejectSymlink(subjectPath, "a subject file")
    if (!(await exists(subjectPath))) fail(`subject does not exist: ${subjectSlug}`)
    const subjectContent = await fs.readFile(subjectPath, "utf8")
    const result: any = {
      project: location.identity,
      subject: { slug: subjectSlug, path: relativePath(root, subjectPath), content: subjectContent, revision: sha256(subjectContent) },
    }
    if (planNumber !== undefined) {
      const plansPath = path.join(location.projectPath, subjectSlug, "plans")
      await rejectSymlink(plansPath, "a plans directory")
      const planPath = path.join(plansPath, `${String(planNumber).padStart(3, "0")}-${planSlug}.md`)
      if (!(await exists(planPath))) fail(`plan does not exist: ${subjectSlug}/${String(planNumber).padStart(3, "0")}-${planSlug}`)
      await rejectSymlink(planPath, "a plan file")
      const planContent = await fs.readFile(planPath, "utf8")
      result.plan = { number: planNumber, slug: planSlug, path: relativePath(root, planPath), content: planContent, revision: sha256(planContent) }
    }
    checkAborted(signal)
    return result
  })
}

export async function recordPlan(options: LibraryOptions, directory: string, sessionID: string, input: RecordInput, signal?: AbortSignal): Promise<any> {
  assertSlug(input.subjectSlug, "subject slug")
  assertSlug(input.planSlug, "plan slug")
  if (!["create", "reuse", "extend"].includes(input.decision)) fail("decision must be create, reuse, or extend")
  if (!["new", "update"].includes(input.planAction)) fail("plan action must be new or update")
  if (input.decision === "create" && input.planAction !== "new") fail("create decisions must create a new plan")
  if (input.decision === "create" && !input.subjectContent) fail("create decisions require approved subject content")
  if (input.decision === "extend" && !input.subjectContent) fail("extend decisions require approved subject content")
  if (input.decision === "reuse" && input.subjectContent !== undefined) fail("reuse cannot change subject content; use extend for that")
  if (input.planAction === "update") safeExpected(input.expectedPlanRevision, "plan")
  if (input.decision === "extend") safeExpected(input.expectedSubjectRevision, "subject")
  if (input.planAction === "update" && (!Number.isInteger(input.planNumber) || input.planNumber! < 1 || input.planNumber! > 999)) fail("updates require an existing plan number from 1 to 999")
  checkAborted(signal)

  return withLock(options, async () => {
    const root = path.resolve(options.root)
    await initializeUnlocked(root)
    await assertNoRemote(root)
    await assertRepositoryClean(root, "record")
    checkAborted(signal)
    const location = await locateProject(root, directory)
    const subjectDirectory = path.join(location.projectPath, input.subjectSlug)
    const subjectPath = path.join(subjectDirectory, "subject.md")
    await rejectSymlink(subjectDirectory, "a subject directory")
    await rejectSymlink(subjectPath, "a subject file")
    const subjectExists = await exists(subjectPath) || await exists(subjectDirectory)
    if (input.decision === "create" && subjectExists) fail(`cannot create subject because it already exists: ${input.subjectSlug}`)
    if (input.decision !== "create" && !subjectExists) fail(`cannot ${input.decision} missing subject: ${input.subjectSlug}`)
    if (subjectExists && !(await isDirectory(subjectDirectory))) fail(`subject path is not a directory: ${input.subjectSlug}`)
    if (subjectExists && !(await exists(subjectPath))) fail(`subject directory has no canonical subject.md: ${input.subjectSlug}`)

    const existingSubject = subjectExists ? await fs.readFile(subjectPath, "utf8") : undefined
    if (input.decision === "extend" && sha256(existingSubject || "") !== input.expectedSubjectRevision) fail("subject revision conflict; reread before extending")
    const subjectMeta = existingSubject ? parseFrontmatter(existingSubject).values : {}
    const subjectMarkdown = input.subjectContent === undefined ? undefined : canonicalMarkdown("subject", input.subjectContent, {
      schema: PLAN_LIBRARY_SCHEMA,
      kind: "subject",
      project_id: location.identity.id,
      subject_slug: input.subjectSlug,
      title: input.subjectTitle || titleFrom(subjectMeta, input.subjectSlug),
      status: input.subjectStatus || subjectMeta.status || "active",
    })

    let planNumber: number
    let planPath: string
    let existingPlan: string | undefined
    if (input.planAction === "update") {
      planNumber = input.planNumber!
      planPath = path.join(subjectDirectory, "plans", `${String(planNumber).padStart(3, "0")}-${input.planSlug}.md`)
      if (!(await exists(planPath))) fail(`cannot update missing plan: ${input.subjectSlug}/${input.planSlug}`)
      await rejectSymlink(path.join(subjectDirectory, "plans"), "a plans directory")
      await rejectSymlink(planPath, "a plan file")
      existingPlan = await fs.readFile(planPath, "utf8")
      if (sha256(existingPlan) !== input.expectedPlanRevision) fail("plan revision conflict; reread before updating")
    } else {
      const plansDirectory = path.join(subjectDirectory, "plans")
      await rejectSymlink(plansDirectory, "a plans directory")
      const occupied = new Set<number>()
      if (await isDirectory(plansDirectory)) {
        for (const entry of await fs.readdir(plansDirectory)) {
          const match = entry.match(/^(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/)
          if (match) occupied.add(Number(match[1]))
        }
      }
      planNumber = Array.from({ length: 999 }, (_, index) => index + 1).find((number) => !occupied.has(number)) || 0
      if (!planNumber) fail("no 3-digit plan numbers remain for this subject")
      planPath = path.join(subjectDirectory, "plans", `${String(planNumber).padStart(3, "0")}-${input.planSlug}.md`)
    }
    const planMeta = existingPlan ? parseFrontmatter(existingPlan).values : {}
    const planMarkdown = canonicalMarkdown("plan", input.planContent, {
      schema: PLAN_LIBRARY_SCHEMA,
      kind: "plan",
      project_id: location.identity.id,
      subject_slug: input.subjectSlug,
      plan_number: planNumber,
      plan_slug: input.planSlug,
      title: input.planTitle || titleFrom(planMeta, input.planSlug),
      status: input.planStatus || planMeta.status || "proposed",
    })

    const indexPath = path.join(location.projectPath, "index.md")
    const touched = [location.metadataPath, indexPath, planPath, ...(subjectMarkdown === undefined ? [] : [subjectPath])]
    const snapshots = await snapshotFiles(touched)
    const headBefore = await head(root)
    const state = { committed: false }
    let firstWrite = true
    const changed: string[] = []
    const writeTracked = async (target: string, content: string): Promise<void> => {
      if (await writeAtomic(target, content)) {
        changed.push(relativePath(root, target))
        if (firstWrite) {
          firstWrite = false
          await testPoint(options, "after-first-write")
        }
      }
    }

    try {
      // Cancellation is checked before the first canonical write. Once this
      // transaction starts, it finishes its commit or enters recovery.
      checkAborted(signal)
      await fs.mkdir(path.dirname(planPath), { recursive: true })
      await writeTracked(location.metadataPath, projectMetadata(location.identity))
      if (subjectMarkdown !== undefined) await writeTracked(subjectPath, subjectMarkdown)
      await writeTracked(planPath, planMarkdown)
      const entries = await projectEntries(location)
      await writeTracked(indexPath, indexMarkdown(location, entries.subjects))
      const commit = await commitOperation(root, changed, `plan: ${location.identity.id}/${input.subjectSlug}/${input.planSlug} (session ${sessionCommitPart(sessionID)})`, options, state)
      return {
        projectId: location.identity.id,
        subject: { slug: input.subjectSlug, path: relativePath(root, subjectPath), revision: sha256(subjectMarkdown || existingSubject || "") },
        plan: { number: planNumber, slug: input.planSlug, path: relativePath(root, planPath), revision: sha256(planMarkdown) },
        commit,
      }
    } catch (error) {
      const currentHead = await gitQuiet(root, ["rev-parse", "HEAD"])
      if (currentHead && currentHead !== headBefore) state.committed = true
      if (state.committed) throw error
      try {
        await restoreSnapshots(root, snapshots)
        await removeEmptyDirectories([path.dirname(planPath), subjectDirectory, location.projectPath])
        await assertRepositoryClean(root, "recovery")
      } catch (recoveryError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; automatic recovery failed, inspect the plan repository manually: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`)
      }
      throw error
    }
  }, signal)
}
