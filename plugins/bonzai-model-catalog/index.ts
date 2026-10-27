import { appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"

const KEYS_FILE = `${process.env.HOME}/.config/opencode/bonzai-keys.json`
const BONZAI_URL = "https://connect.iobonzai.com"
const MODELS_DEV_URL = "https://models.dev/api.json"
const BEDROCK = "bedrock"
const OPENAI = "bonzai-openai"
const UNIVERSAL = "bonzai-universal"
const VERTEX = "bonzai-vertex"
const REFRESH_MS = 60 * 60 * 1000
const MIN_CONTEXT = 100_000
const CACHE_KEY = "inventory"
const DEFAULT_EFFORTS = ["low", "medium", "high"]
const ADAPTIVE_THINKING = { type: "adaptive", display: "summarized" }

type Json = Record<string, any>
type Inventory = Record<string, Json[]>

const MODELS_DEV_PROVIDER: Record<string, string> = {
  azure: "azure",
  bedrock: "amazon-bedrock",
  vertex_ai: "google-vertex",
  mistral: "mistral",
}

const perMillion = (perToken: unknown) => (typeof perToken === "number" ? Math.round(perToken * 1e9) / 1e3 : 0)

async function getJson(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

async function defaultApiKey(): Promise<string | undefined> {
  const file = Bun.file(KEYS_FILE)
  if (!(await file.exists())) return undefined
  const config = (await file.json()) as { default?: { apiKey?: string } }
  return config.default?.apiKey || undefined
}

function isUsable(entry: Json) {
  const info = entry.model_info ?? {}
  return (
    info.mode === "chat" &&
    info.supports_function_calling === true &&
    (info.max_input_tokens ?? 0) >= MIN_CONTEXT &&
    !entry.model_name.startsWith("uncompliant-")
  )
}

function providerFor(route: string, backendID: string) {
  if (route === "azure") return OPENAI
  if (!backendID.includes("claude")) return UNIVERSAL
  return route === "vertex_ai" ? VERTEX : BEDROCK
}

function ids(providerID: string, backendID: string, names: string[]) {
  if (providerID === BEDROCK) return { id: backendID, modelID: backendID }
  const shortest = [...names].sort((a, b) => a.length - b.length)[0]
  if (providerID === VERTEX) {
    return { id: backendID.replace(/@.*$/, ""), modelID: names.find((name) => name.endsWith("-vertex")) ?? shortest }
  }
  const id = names.includes(backendID) ? backendID : shortest
  return { id, modelID: id }
}

function dedupe(entries: Json[]) {
  const groups = new Map<string, Json[]>()
  for (const entry of entries) {
    const backend = entry.litellm_params.model as string
    groups.set(backend, [...(groups.get(backend) ?? []), entry])
  }
  return [...groups.entries()].map(([backend, group]) => {
    const [route, ...rest] = backend.split("/")
    const backendID = rest.join("/")
    const names = group.map((entry) => entry.model_name as string)
    const providerID = providerFor(route, backendID)
    return { ...ids(providerID, backendID, names), providerID, route, backendID, info: group[0].model_info as Json }
  })
}

function lookup(modelsDev: Json, route: string, backendID: string): Json | undefined {
  const preferred = modelsDev[MODELS_DEV_PROVIDER[route]]?.models?.[backendID]
  if (preferred) return preferred
  const bare = backendID.replace(/^[a-z]+\./, "")
  for (const provider of Object.values<Json>(modelsDev)) {
    const match = provider.models?.[backendID] ?? provider.models?.[bare]
    if (match) return match
  }
}

function costs(info: Json) {
  const base = {
    input: perMillion(info.input_cost_per_token),
    output: perMillion(info.output_cost_per_token),
    cache: { read: perMillion(info.cache_read_input_token_cost), write: perMillion(info.cache_creation_input_token_cost) },
  }
  const tiers = [128, 200, 272, 512].flatMap((k) => {
    const input = info[`input_cost_per_token_above_${k}k_tokens`]
    if (typeof input !== "number") return []
    return [{
      tier: { type: "context", size: k * 1000 },
      input: perMillion(input),
      output: perMillion(info[`output_cost_per_token_above_${k}k_tokens`] ?? info.output_cost_per_token),
      cache: {
        read: perMillion(info[`cache_read_input_token_cost_above_${k}k_tokens`] ?? info.cache_read_input_token_cost),
        write: perMillion(info[`cache_creation_input_token_cost_above_${k}k_tokens`] ?? info.cache_creation_input_token_cost),
      },
    }]
  })
  return [base, ...tiers]
}

function variants(providerID: string, backendID: string, info: Json, dev: Json | undefined) {
  if (!info.supports_reasoning) return []
  const options: Json[] | undefined = dev?.reasoning_options
  const effort = options ? options.find((option) => option.type === "effort") : { values: DEFAULT_EFFORTS }
  if (!effort) return []
  const efforts = (effort.values ?? DEFAULT_EFFORTS).filter((value: string) => value !== "none")
  if (providerID === UNIVERSAL || providerID === OPENAI) return efforts.map((id: string) => ({ id, settings: { reasoningEffort: id } }))
  const version = /(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(backendID)
  const major = Number(version?.[2])
  const minor = Number(version?.[3] ?? 0)
  const manualThinking = (major === 3 && minor === 7) || (major === 4 && minor < 6)
  if (providerID === VERTEX) {
    return efforts.map((id: string) => ({ id, settings: { ...(manualThinking ? {} : { thinking: ADAPTIVE_THINKING }), effort: id } }))
  }
  return efforts.map((id: string) => ({
    id,
    body: { additionalModelRequestFields: { ...(manualThinking ? {} : { thinking: ADAPTIVE_THINKING }), output_config: { effort: id } } },
  }))
}

function toModel(model: ReturnType<typeof dedupe>[number], dev: Json | undefined) {
  const { id, modelID, providerID, backendID, info } = model
  const input = ["text"]
  if (info.supports_vision) input.push("image")
  if (info.supports_pdf_input) input.push("pdf")
  return {
    id, modelID, providerID,
    ...(dev?.family ? { family: dev.family } : {}),
    name: dev?.name?.replace(/ \((EU|Global|US)\)$/, "") ?? id,
    capabilities: { tools: true, input, output: ["text"] },
    variants: variants(providerID, backendID, info, dev),
    time: { released: dev?.release_date ? Date.parse(dev.release_date) : 0 },
    cost: costs(info),
    status: dev?.status === "beta" ? "beta" : "active",
    enabled: true,
    limit: { context: dev?.limit?.context ?? info.max_input_tokens, input: info.max_input_tokens, output: info.max_output_tokens ?? dev?.limit?.output ?? 32_000 },
  }
}

async function fetchInventory(apiKey: string): Promise<Inventory> {
  const [bonzai, modelsDev] = await Promise.all([
    getJson(`${BONZAI_URL}/model/info`, { Authorization: `Bearer ${apiKey}` }),
    getJson(MODELS_DEV_URL).catch(() => ({})),
  ])
  const inventory: Inventory = { [BEDROCK]: [], [VERTEX]: [], [OPENAI]: [], [UNIVERSAL]: [] }
  for (const model of dedupe(bonzai.data.filter(isUsable))) {
    const dev = lookup(modelsDev, model.route, model.backendID)
    if (dev?.status !== "deprecated") inventory[model.providerID].push(toModel(model, dev))
  }
  return inventory
}

const logError = (error: unknown) =>
  appendFile(join(tmpdir(), "opencode-bonzai-model-catalog.log"), `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`).catch(() => {})

export default Plugin.define({
  id: "bonzai-model-catalog",
  async setup(ctx: any) {
    let inventory: Inventory = ((await ctx.storage.get(CACHE_KEY)) as Inventory | undefined) ?? {}

    await ctx.provider.transform((editor: any) => {
      for (const [providerID, models] of Object.entries(inventory)) {
        editor.models.set(providerID, models)
      }
    })

    const refresh = async () => {
      const apiKey = await defaultApiKey()
      if (!apiKey) throw new Error("No default Bonzai API key configured in bonzai-keys.json")
      inventory = await fetchInventory(apiKey)
      await ctx.storage.set(CACHE_KEY, inventory)
      await ctx.provider.reload()
    }

    const run = () => refresh().catch(logError)
    void run()
    const timer = setInterval(run, REFRESH_MS)
    return () => clearInterval(timer)
  },
})
