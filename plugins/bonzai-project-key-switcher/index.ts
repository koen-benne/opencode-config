import { Plugin } from "@opencode/plugin"

type BonzaiKeysConfig = {
  default: { apiKey: string }
  remotes: Record<string, { apiKey: string }>
}

const keysFile = `${process.env.HOME}/.config/opencode/bonzai-keys.json`
const providers = ["bonzai-universal", "bonzai-openai", "bedrock", "bonzai-vertex"]

function normalizeRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\.git$/, "")
  const scpStyle = trimmed.match(/^(?:.+@)?([^:]+):(.+)$/)

  if (scpStyle) return `${scpStyle[1]}/${scpStyle[2]}`

  const url = new URL(trimmed)
  return `${url.hostname}/${url.pathname.replace(/^\//, "")}`
}

async function loadKeys(): Promise<BonzaiKeysConfig> {
  const file = Bun.file(keysFile)
  if (!(await file.exists())) throw new Error(`Bonzai key file not found: ${keysFile}`)

  const config = (await file.json()) as BonzaiKeysConfig
  if (!config.default?.apiKey) throw new Error("No default Bonzai API key configured in bonzai-keys.json")
  return config
}

async function keyForProject(config: BonzaiKeysConfig, directory: string): Promise<string> {
  try {
    const process = Bun.spawn(["git", "-C", directory, "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const remote = await new Response(process.stdout).text()

    if ((await process.exited) !== 0) return config.default.apiKey

    return config.remotes[normalizeRemote(remote)]?.apiKey || config.default.apiKey
  } catch {
    return config.default.apiKey
  }
}

export default Plugin.define({
  id: "bonzai-project-key-switcher",
  async setup(ctx: any) {
    const config = await loadKeys()
    const defaultKey = config.default.apiKey

    await ctx.provider.transform((editor: any) => {
      for (const providerID of providers) {
        editor.update(providerID, (provider: any) => {
          provider.settings = { ...provider.settings, apiKey: defaultKey }
        })
      }
    })

    const key = await keyForProject(config, ctx.location.project.canonical)

    for (const providerID of providers) {
      await ctx.session.hook("http.request", (event: any) => {
        event.request.headers.set("Authorization", `Bearer ${key}`)
      }, { providerID })
    }
  },
})
