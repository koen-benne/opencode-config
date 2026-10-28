import { homedir } from "node:os"
import { assertRecorderAgent, ensurePlanLibrary, listPlans, readPlan, recordPlan } from "./library"

import { Plugin } from "@opencode/plugin"

const root = process.env.OPENCODE_PLAN_LIBRARY_ROOT || `${homedir()}/.opencode/plan`

function sessionDirectory(context: any, ctx: any): string {
  return context?.directory || context?.worktree || ctx.location?.project?.canonical || ctx.location?.directory || process.cwd()
}

const listInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

const readInput = {
  type: "object",
  properties: {
    subjectSlug: { type: "string", description: "Strict kebab-case subject slug." },
    planNumber: { type: "integer", minimum: 1, maximum: 999, description: "Optional 1-999 canonical plan number." },
    planSlug: { type: "string", description: "Required with planNumber; strict kebab-case." },
  },
  required: ["subjectSlug"],
  additionalProperties: false,
} as const

const recordInput = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["create", "reuse", "extend"] },
    subjectSlug: { type: "string", description: "Strict kebab-case subject slug." },
    subjectTitle: { type: "string" },
    subjectStatus: { type: "string", enum: ["active", "complete", "superseded"] },
    subjectContent: { type: "string", description: "Approved subject Markdown with # title, ## Goal, ## Decision, ## In scope, ## Out of scope, and ## Plans when creating or extending." },
    planAction: { type: "string", enum: ["new", "update"] },
    planSlug: { type: "string", description: "Strict kebab-case plan slug." },
    planTitle: { type: "string" },
    planContent: { type: "string", description: "Approved plan Markdown with # title, ## Goal, ## Context, ## Decisions, ## Plan, ## Acceptance criteria, ## Verification, and ## Status." },
    planStatus: { type: "string", enum: ["proposed", "active", "blocked", "complete", "superseded"] },
    planNumber: { type: "integer", minimum: 1, maximum: 999, description: "Required when updating a plan." },
    expectedSubjectRevision: { type: "string", description: "SHA-256 from the latest plan_library_read for extensions." },
    expectedPlanRevision: { type: "string", description: "SHA-256 from the latest plan_library_read for updates." },
  },
  required: ["decision", "subjectSlug", "planAction", "planSlug", "planContent"],
  additionalProperties: false,
} as const

export default Plugin.define({
  id: "plan-library",
  async setup(ctx: any) {
    await ensurePlanLibrary({ root })
    await ctx.tool.transform((editor: any) => {
      editor.namespace({
        name: "plan-library",
        description: "Local-only OpenCode Plan Library. Tools derive project identity from the current session and never accept filesystem paths.",
      })
      editor.add({
        name: "list",
        description: "List canonical subjects and plan metadata/snippets for the current project without loading full plan bodies.",
        input: listInput,
        options: { namespace: "plan-library", codemode: false },
        execute: async (_input: unknown, context: any) => ({
          content: JSON.stringify(await listPlans({ root }, sessionDirectory(context, ctx), context.signal)),
        }),
      })
      editor.add({
        name: "read",
        description: "Read one canonical subject and, optionally, one selected canonical plan with SHA-256 revisions.",
        input: readInput,
        options: { namespace: "plan-library", codemode: false },
        execute: async (input: any, context: any) => ({
          content: JSON.stringify(await readPlan({ root }, sessionDirectory(context, ctx), input.subjectSlug, input.planNumber, input.planSlug, context.signal)),
        }),
      })
      editor.add({
        name: "record",
        description: "Record an explicitly approved create/reuse/extend decision and new/update canonical Markdown; only plan-recorder may write and each operation commits atomically.",
        input: recordInput,
        options: { namespace: "plan-library", codemode: false },
        execute: async (input: any, context: any) => {
          assertRecorderAgent(context?.agent)
          return { content: JSON.stringify(await recordPlan({ root }, sessionDirectory(context, ctx), context.sessionID || "unknown-session", input, context.signal)) }
        },
      })
    })
  },
})
