import type { AnyModel, Api, Model } from "@earendil-works/pi-ai";
import { getAllBuiltinModels, getBuiltinProviders, getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { APIS, apiBaseUrl, isRecord, type ChatApi, type ChatModel, type NewApiConfig } from "./config.ts";

const ENDPOINT_API = new Map<string, ChatApi>([
  ["openai-response", "openai-responses"], ["openai", "openai-completions"],
  ["anthropic", "anthropic-messages"], ["gemini", "google-generative-ai"],
]);
const NON_CHAT = new Set(["image-generation", "embeddings", "jina-rerank", "openai-video", "audio", "moderations"]);
// Some NewAPI versions describe only the channel protocol for these operations.
const NON_CHAT_ID = /(?:^|\/)(?:text-embedding-|embedding-|rerank(?:er)?[-/]|(?:text|omni)-moderation-|whisper(?:-|$)|tts(?:-|$)|dall-e(?:-|$)|gpt-image(?:-|$)|sora(?:-|$))/i;
const PRIORITY = ["openai", "anthropic", "google", "deepseek", "xai", "mistral", "moonshotai", "zai", "minimax"];
let builtins: Map<string, AnyModel[]> | undefined;
function catalogIndex(): Map<string, AnyModel[]> {
  if (builtins) return builtins;
  builtins = new Map();
  const rank = (id: string) => PRIORITY.includes(id) ? PRIORITY.indexOf(id) : PRIORITY.length;
  const providers = getBuiltinProviders().sort((a, b) => rank(a) - rank(b));
  for (const provider of providers) for (const model of getAllBuiltinModels(provider)) {
    const entries = builtins.get(model.id) ?? [];
    entries.push(model);
    builtins.set(model.id, entries);
  }
  return builtins;
}
export const catalogVersion = () => getBuiltinModelDataGeneratedAt();
export interface CatalogEntry { id: string; owner?: string; endpoints: string[] }
export interface CatalogReport {
  models: Array<{ id: string; api: ChatApi; source: string; pricing: "configured" | "unknown"; notes: string[] }>;
  skipped: Array<{ id: string; reason: string }>;
}
export function parseCatalog(payload: unknown): { entries: CatalogEntry[]; skipped: CatalogReport["skipped"] } {
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("NewAPI returned an invalid /v1/models response.");
  const entries = new Map<string, CatalogEntry>();
  const skipped: CatalogReport["skipped"] = [];
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
      skipped.push({ id: "(invalid entry)", reason: "Missing model ID" });
      continue;
    }
    const id = item.id.trim();
    const raw = item.supported_endpoint_types;
    if (raw != null && (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !x.trim()))) {
      skipped.push({ id, reason: "Invalid supported_endpoint_types" });
      continue;
    }
    const previous = entries.get(id);
    entries.set(id, {
      id, owner: typeof item.owned_by === "string" ? item.owned_by : previous?.owner,
      endpoints: [...new Set([...(previous?.endpoints ?? []), ...((raw ?? []) as string[]).map((x) => x.trim())])],
    });
  }
  if (payload.data.length > 0 && entries.size === 0) throw new Error("NewAPI's model catalog contains no valid entries.");
  return { entries: [...entries.values()], skipped };
}
export function buildCatalog(entries: CatalogEntry[], config: NewApiConfig, baseUrl: string, initialSkipped: CatalogReport["skipped"] = []) {
  const models: ChatModel[] = [];
  const report: CatalogReport = { models: [], skipped: [...initialSkipped] };
  const wanted = config.models && new Set(config.models);
  const found = new Set(entries.map((entry) => entry.id));
  for (const id of wanted ?? []) if (!found.has(id)) report.skipped.push({ id, reason: "Not available to this API token" });
  for (const entry of entries) {
    if (wanted && !wanted.has(entry.id)) continue;
    const overrides = Object.hasOwn(config.modelOverrides, entry.id) ? config.modelOverrides[entry.id] : {};
    const skip = (reason: string) => report.skipped.push({ id: entry.id, reason });
    if (overrides.enabled === false) { skip("Disabled in newapi.json"); continue; }
    const candidates = catalogIndex().get(overrides.reference?.id ?? entry.id) ?? [];
    const reference = overrides.reference;
    const candidate = reference ? candidates.find((m) => m.provider === reference.provider)
      : candidates.find((m) => m.provider === entry.owner) ?? candidates[0];
    if (reference && (!candidate || (candidate.type && candidate.type !== "chat"))) {
      throw new Error(`No built-in chat model matches the reference configured for ${entry.id}.`);
    }
    const known = candidate && (!candidate.type || candidate.type === "chat") ? candidate as Model<Api> : undefined;
    if (overrides.chat !== true && (entry.endpoints.some((e) => NON_CHAT.has(e)) || (candidate && !known) || NON_CHAT_ID.test(entry.id))) {
      skip("Non-chat operation; use chat:true only for a verified chat-capable model"); continue;
    }
    const explicitApi = overrides.api ?? config.api;
    // Preserve NewAPI's preference order. A user override can correct global/channel hints.
    const advertised = entry.endpoints.map((e) => ENDPOINT_API.get(e)).find(Boolean);
    const api = explicitApi ?? advertised ?? (entry.endpoints.length === 0
      ? (known && APIS.includes(known.api as ChatApi) ? known.api as ChatApi : "openai-completions") : undefined);
    if (!api) { skip("No supported chat protocol advertised"); continue; }
    const notes: string[] = [];
    const configuredCapabilities = overrides.input !== undefined && overrides.reasoning !== undefined
      && overrides.contextWindow !== undefined && overrides.maxTokens !== undefined;
    if (!known && !configuredCapabilities) notes.push("Unknown model: default capabilities; configure reference or per-model limits/input/reasoning");
    if (!entry.endpoints.length && !explicitApi) notes.push("No endpoint metadata: protocol inferred from catalog/default");
    if (explicitApi && entry.endpoints.length && !entry.endpoints.some((e) => ENDPOINT_API.get(e) === explicitApi)) notes.push("Explicit API override is not advertised by the gateway");
    const sameApi = known?.api === api;
    const contextWindow = overrides.contextWindow ?? known?.contextWindow ?? config.contextWindow;
    const maxTokens = overrides.maxTokens ?? Math.min(known?.maxTokens ?? config.maxTokens, contextWindow);
    if (maxTokens > contextWindow) throw new Error(`maxTokens exceeds contextWindow for ${entry.id}.`);
    const model: ChatModel = {
      id: entry.id, name: overrides.name ?? known?.name ?? entry.id, provider: "newapi", api,
      baseUrl: apiBaseUrl(baseUrl, api),
      newapi: {
        defaultBaseUrl: apiBaseUrl(baseUrl, api),
        ...(reference && known ? { referenceId: known.id } : {}),
      },
      reasoning: overrides.reasoning ?? known?.reasoning ?? false,
      input: overrides.input ?? known?.input ?? ["text"],
      contextWindow, maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...overrides.cost },
      ...(known?.inputLimits ? { inputLimits: structuredClone(known.inputLimits) } : {}),
      ...(sameApi && known?.thinkingLevelMap ? { thinkingLevelMap: structuredClone(known.thinkingLevelMap) } : {}),
      ...(sameApi && known?.compat ? { compat: structuredClone(known.compat) } : {}),
      ...(overrides.thinkingLevelMap ? { thinkingLevelMap: {
        ...(sameApi ? known?.thinkingLevelMap : {}), ...overrides.thinkingLevelMap,
      } } : {}),
      ...(overrides.compat ? { compat: { ...(sameApi ? known?.compat : {}), ...overrides.compat } } : {}),
    };
    models.push(model);
    report.models.push({ id: entry.id, api, source: known ? `${known.provider}/${known.id}` : configuredCapabilities ? "configured" : "defaults", pricing: overrides.cost ? "configured" : "unknown", notes });
  }
  return { models, report };
}
