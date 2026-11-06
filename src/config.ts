import { readFile } from "node:fs/promises";
import type { Model } from "@earendil-works/pi-ai";

export const APIS = ["openai-responses", "openai-completions", "anthropic-messages", "google-generative-ai"] as const;
export type ChatApi = typeof APIS[number];
export type ChatModel = Model<ChatApi> & {
  /** Retained through pi's model overlays and persisted catalog snapshots. */
  newapi?: { defaultBaseUrl: string; referenceId?: string };
};
export interface ModelOverride {
  enabled?: boolean;
  chat?: boolean;
  reference?: { provider: string; id: string };
  api?: ChatApi;
  name?: string;
  input?: ChatModel["input"];
  reasoning?: boolean;
  thinkingLevelMap?: ChatModel["thinkingLevelMap"];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Partial<ChatModel["cost"]>;
  compat?: ChatModel["compat"];
}
export interface NewApiConfig {
  baseUrl?: string;
  api?: ChatApi;
  discovery: boolean;
  models?: string[];
  modelOverrides: Record<string, ModelOverride>;
  contextWindow: number;
  maxTokens: number;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("NewAPI baseUrl must be an absolute HTTP(S) URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("NewAPI baseUrl must use HTTP(S), without credentials, query parameters, or a fragment.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  return url.toString().replace(/\/$/, "");
}
export function apiBaseUrl(base: string, api: ChatApi): string {
  const root = normalizeBaseUrl(base).slice(0, -3);
  return api === "anthropic-messages" ? root : `${root}/${api === "google-generative-ai" ? "v1beta" : "v1"}`;
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`NewAPI configuration: ${message}`);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function validApi(value: unknown): value is ChatApi { return APIS.includes(value as ChatApi); }
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  assert(Object.keys(value).every((key) => allowed.includes(key)), `${label} contains an unknown field.`);
}
export function parseConfig(value: unknown, env: NodeJS.ProcessEnv = process.env): NewApiConfig {
  assert(isRecord(value), "expected a JSON object.");
  keys(value, ["baseUrl", "api", "discovery", "models", "modelOverrides", "contextWindow", "maxTokens"], "config");
  const rawBase = env.NEWAPI_BASE_URL ?? value.baseUrl;
  assert(rawBase === undefined || typeof rawBase === "string", "baseUrl must be a string.");
  const api = env.NEWAPI_API || value.api;
  assert(api === undefined || validApi(api), `api must be ${APIS.join(", ")}.`);
  const discovery = value.discovery ?? true;
  assert(typeof discovery === "boolean", "discovery must be a boolean.");
  const ids = env.NEWAPI_MODELS !== undefined ? env.NEWAPI_MODELS.split(",").map((id) => id.trim()).filter(Boolean) : value.models;
  assert(ids === undefined || (Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string" && id.trim())), "models must be a nonempty array of IDs.");
  const contextWindow = env.NEWAPI_CONTEXT_WINDOW ? Number(env.NEWAPI_CONTEXT_WINDOW) : value.contextWindow ?? 32768;
  const maxTokens = env.NEWAPI_MAX_TOKENS ? Number(env.NEWAPI_MAX_TOKENS) : value.maxTokens ?? 4096;
  assert(positive(contextWindow) && positive(maxTokens) && maxTokens <= contextWindow, "token defaults must be positive integers with maxTokens <= contextWindow.");
  const overrides = value.modelOverrides ?? {};
  assert(isRecord(overrides), "modelOverrides must be an object.");
  for (const [id, entry] of Object.entries(overrides)) {
    assert(id.trim() && isRecord(entry), "each model override must be an object with a nonempty ID.");
    keys(entry, ["enabled", "chat", "reference", "api", "name", "input", "reasoning", "thinkingLevelMap", "contextWindow", "maxTokens", "cost", "compat"], `model ${id}`);
    for (const field of ["enabled", "chat", "reasoning"]) assert(entry[field] === undefined || typeof entry[field] === "boolean", `${id}.${field} must be boolean.`);
    assert(entry.name === undefined || (typeof entry.name === "string" && entry.name.trim()), `${id}.name must be a nonempty string.`);
    assert(entry.api === undefined || validApi(entry.api), `${id}.api is unsupported.`);
    assert(entry.reference === undefined || (isRecord(entry.reference) && typeof entry.reference.provider === "string" && entry.reference.provider.trim() && typeof entry.reference.id === "string" && entry.reference.id.trim()), `${id}.reference requires nonempty provider and id.`);
    assert(entry.input === undefined || (Array.isArray(entry.input) && entry.input.length > 0 && entry.input.every((v) => v === "text" || v === "image")), `${id}.input must contain text and/or image.`);
    for (const field of ["contextWindow", "maxTokens"]) assert(entry[field] === undefined || positive(entry[field]), `${id}.${field} must be a positive integer.`);
    if (entry.thinkingLevelMap !== undefined) {
      assert(isRecord(entry.thinkingLevelMap), `${id}.thinkingLevelMap must be an object.`);
      keys(entry.thinkingLevelMap, ["off", "minimal", "low", "medium", "high", "xhigh", "max"], `${id}.thinkingLevelMap`);
      assert(Object.values(entry.thinkingLevelMap).every((v) => v === null || typeof v === "string"), `${id}.thinkingLevelMap values must be strings or null.`);
    }
    if (entry.cost !== undefined) {
      assert(isRecord(entry.cost), `${id}.cost must be an object.`);
      keys(entry.cost, ["input", "output", "cacheRead", "cacheWrite"], `${id}.cost`);
      assert(Object.values(entry.cost).every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0), `${id}.cost rates must be nonnegative numbers.`);
    }
    assert(entry.compat === undefined || isRecord(entry.compat), `${id}.compat must be an object.`);
  }
  assert(discovery || ids !== undefined, "discovery:false requires an explicit models list.");
  return {
    ...(rawBase ? { baseUrl: normalizeBaseUrl(rawBase) } : {}),
    api: api as ChatApi | undefined, discovery, models: ids ? [...new Set((ids as string[]).map((id) => id.trim()))] : undefined,
    modelOverrides: overrides as Record<string, ModelOverride>, contextWindow, maxTokens,
  };
}
export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<NewApiConfig> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !env.NEWAPI_CONFIG) return parseConfig({}, env);
    throw new Error("Cannot read NewAPI configuration. Check NEWAPI_CONFIG or your agent directory's newapi.json.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("NewAPI configuration is not valid JSON."); }
  return parseConfig(parsed, env);
}
