import { createHash } from "node:crypto";
import {
  createProvider, defaultProviderAuthContext,
  type AuthContext, type AuthResult, type ModelsStoreEntry, type Provider, type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { newApiAuth, resolveConnection } from "./auth.ts";
import { buildCatalog, catalogVersion, parseCatalog, type CatalogReport } from "./catalog.ts";
import { APIS, isRecord, type ChatApi, type ChatModel, type NewApiConfig } from "./config.ts";
import { resolveRequestModel, streamWithReference } from "./stream.ts";

const emptyReport = (): CatalogReport => ({ models: [], skipped: [] });
export interface ProviderStatus {
  state: "unconfigured" | "empty" | "cached" | "ready" | "static";
  checkedAt?: number;
  error?: string;
  report: CatalogReport;
}
interface Snapshot extends ModelsStoreEntry { newapi: { scope: string; report: CatalogReport } }
export interface NewApiProvider extends Provider<ChatApi> { getStatus(): ProviderStatus }

export async function fetchCatalog(baseUrl: string, key: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  try {
    const response = await fetcher(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error", signal: requestSignal,
    });
    if (!response.ok) throw new CatalogError(`NewAPI model discovery failed (HTTP ${response.status}).${response.status === 401 || response.status === 403 ? " Check the API token and its permissions." : " Check gateway availability."}`, response.status);
    let payload: unknown;
    try { payload = await response.json(); }
    catch {
      requestSignal.throwIfAborted();
      throw new CatalogError("NewAPI returned invalid JSON from /v1/models. Check the gateway URL.");
    }
    try { return parseCatalog(payload); }
    catch { throw new CatalogError("NewAPI returned an invalid /v1/models catalog. Check the gateway URL and model configuration."); }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof CatalogError) throw error;
    if (requestSignal.aborted) throw new CatalogError("NewAPI model discovery timed out after 10 seconds.");
    // Never include response bodies, credential-bearing URLs, or raw fetch errors.
    throw new CatalogError("Cannot reach NewAPI /v1/models. Check the URL, connectivity, and redirects.");
  }
}
class CatalogError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}
function restore(stored: RefreshModelsContext["stored"], scope: string): Snapshot | undefined {
  const entry = stored as Snapshot | undefined;
  if (!entry || !isRecord(entry.newapi) || entry.newapi.scope !== scope || !Array.isArray(entry.models)
    || !isRecord(entry.newapi.report) || !Array.isArray(entry.newapi.report.models) || !Array.isArray(entry.newapi.report.skipped)) return undefined;
  if (!entry.models.every((model) => model.provider === "newapi" && (!model.type || model.type === "chat")
    && APIS.includes(model.api as ChatApi) && typeof model.id === "string" && typeof model.baseUrl === "string"
    && "contextWindow" in model && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0
    && "maxTokens" in model && Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0
    && "reasoning" in model && typeof model.reasoning === "boolean" && Array.isArray(model.input) && isRecord(model.cost))) return undefined;
  return entry;
}
export interface ProviderOptions {
  fetch?: typeof fetch;
  authContext?: AuthContext;
  /** Resolve pi's configured API key during its cache-only initialization phase. */
  resolveAuth?: (signal: AbortSignal) => Promise<AuthResult | undefined>;
}
export function createNewApiProvider(config: NewApiConfig, options: ProviderOptions = {}): NewApiProvider {
  const authContext = options.authContext ?? defaultProviderAuthContext();
  const fetcher = options.fetch ?? fetch;
  let models: ChatModel[] = [];
  let scope: string | undefined;
  let status: ProviderStatus = { state: "unconfigured", report: emptyReport() };
  const dispatch = createProvider<ChatApi>({
    id: "newapi", name: "NewAPI", auth: { apiKey: newApiAuth(config) }, models: [],
    api: {
      "openai-responses": openAIResponsesApi(), "openai-completions": openAICompletionsApi(),
      "anthropic-messages": anthropicMessagesApi(), "google-generative-ai": googleGenerativeAIApi(),
    },
  });
  const registeredModel = (model: ChatModel) => models.find((entry) => entry.id === model.id);
  const referenceId = (model: ChatModel) => (model.newapi ?? registeredModel(model)?.newapi)?.referenceId;
  return {
    ...dispatch,
    getModels: () => models,
    getAllModels: () => models,
    getStatus: () => structuredClone(status),
    stream: (model, context, opts) => streamWithReference(
      resolveRequestModel(model, registeredModel(model), opts?.env), referenceId(model), context, opts,
      (request, transcript, requestOptions) => dispatch.stream(request, transcript, requestOptions)),
    streamSimple: (model, context, opts) => streamWithReference(
      resolveRequestModel(model, registeredModel(model), opts?.env), referenceId(model), context, opts,
      (request, transcript, requestOptions) => dispatch.streamSimple(request, transcript, requestOptions)),
    async refreshModels(context) {
      let credential = context.credential?.type === "api_key" ? context.credential : undefined;
      let connection: Awaited<ReturnType<typeof resolveConnection>>;
      try {
        if (!credential && options.resolveAuth) {
          const resolved = await options.resolveAuth(context.signal);
          if (resolved?.auth.apiKey) credential = { type: "api_key", key: resolved.auth.apiKey, env: resolved.env };
        }
        connection = await resolveConnection(config, credential, authContext);
      }
      catch (error) {
        context.signal.throwIfAborted();
        await context.publish({ update: () => {
          models = [];
          scope = undefined;
          status = { state: "unconfigured", report: emptyReport(), error: "Invalid NewAPI credentials or gateway URL. Use /login newapi or check the environment settings." };
        } });
        throw error;
      }
      context.signal.throwIfAborted();
      if (!connection) {
        await context.publish({ update: () => { models = []; scope = undefined; status = { state: "unconfigured", report: emptyReport() }; } });
        return;
      }
      // Persist only a digest, never the token. Include config/catalog version so a
      // changed gateway, token, override or pi catalog cannot resurrect stale models.
      const nextScope = createHash("sha256").update(JSON.stringify([3, connection, config, catalogVersion()])).digest("hex");
      if (scope !== nextScope) {
        const cached = restore(context.stored, nextScope);
        if (!await context.publish({ update: () => {
          scope = nextScope;
          models = cached ? structuredClone(cached.models) as ChatModel[] : [];
          status = cached ? { state: "cached", checkedAt: cached.checkedAt, report: structuredClone(cached.newapi.report) }
            : { state: "empty", report: emptyReport() };
        } })) return;
      }
      try {
        if (!config.discovery) {
          const built = buildCatalog(config.models!.map((id) => ({ id, endpoints: [] })), config, connection.baseUrl);
          await context.publish({ update: () => { models = built.models; status = { state: "static", report: built.report }; } });
          return;
        }
        if (!context.allowNetwork || context.signal.aborted) return;
        const age = status.checkedAt === undefined ? undefined : Date.now() - status.checkedAt;
        if (!context.force && age !== undefined && age >= 0 && age < 5 * 60 * 1000) return;
        const catalog = await fetchCatalog(connection.baseUrl, connection.key, context.signal, fetcher);
        const built = buildCatalog(catalog.entries, config, connection.baseUrl, catalog.skipped);
        const checkedAt = Date.now();
        const snapshot: Snapshot = { models: built.models, checkedAt, newapi: { scope: nextScope, report: built.report } };
        await context.publish({ persist: snapshot, update: () => {
          models = built.models;
          status = { state: "ready", checkedAt, report: built.report };
        } });
      } catch (error) {
        context.signal.throwIfAborted();
        const message = error instanceof Error ? error.message : "NewAPI model refresh failed.";
        const rejected = error instanceof CatalogError && (error.status === 401 || error.status === 403);
        await context.publish({ ...(rejected ? { persist: null } : {}), update: () => {
          if (rejected) models = [];
          status = { ...status, state: models.length ? "cached" : "empty", checkedAt: undefined, error: message,
            ...(rejected ? { report: emptyReport() } : {}) };
        } });
        throw error;
      }
    },
  };
}
