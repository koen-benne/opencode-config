import { Plugin } from "@opencode/plugin"

type BillingConfig = {
  default: { apiKey: string }
  remotes: Record<string, { apiKey: string }>
}

const billingFile = `${process.env.HOME}/.config/opencode/billing.json`

function normalizeRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\.git$/, "")
  const scpStyle = trimmed.match(/^(?:.+@)?([^:]+):(.+)$/)

  if (scpStyle) return `${scpStyle[1]}/${scpStyle[2]}`

  const url = new URL(trimmed)
  return `${url.hostname}/${url.pathname.replace(/^\//, "")}`
}

async function keyForProject(directory: string): Promise<string | undefined> {
  const file = Bun.file(billingFile)
  if (!(await file.exists())) return undefined

  const config = (await file.json()) as BillingConfig
  const fallback = config.default.apiKey || undefined
  try {
    const process = Bun.spawn(["git", "-C", directory, "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const remote = await new Response(process.stdout).text()

    if ((await process.exited) !== 0) return fallback

    const mapped = config.remotes[normalizeRemote(remote)]?.apiKey
    return mapped || fallback
  } catch {
    return fallback
  }
}

export default Plugin.define({
  id: "bonzai-project-key-switcher",
  async setup(ctx: any) {
    const key = await keyForProject(ctx.location.project.canonical)
    if (!key) return

    const setAuthorization = (event: any) => {
      event.headers.authorization = `Bearer ${key}`
    }

    await ctx.session.hook("model.request", setAuthorization, { providerID: "bonzai" })
    await ctx.session.hook("model.request", setAuthorization, { providerID: "bedrock" })
  },
})
