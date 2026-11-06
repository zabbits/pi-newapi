import { createHash } from "node:crypto";
import {
  createProvider, defaultProviderAuthContext,
  type ApiKeyCredential, type AuthContext, type AuthResult, type ModelsStoreEntry,
  type Provider, type ProviderHeaders, type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { newApiAuth, resolveBaseUrl, resolveConnection } from "./auth.ts";
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

function discoveryHeaders(key: string, configured?: ProviderHeaders): Headers {
  const headers = new Headers({ Authorization: `Bearer ${key}`, Accept: "application/json" });
  for (const [name, value] of Object.entries(configured ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}
export async function fetchCatalog(baseUrl: string, headers: Headers, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  try {
    const response = await fetcher(`${baseUrl}/models`, {
      headers,
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
  /** Resolve provider-wide auth, including headers, using the refresh credential. */
  resolveAuth?: (signal: AbortSignal, credential?: ApiKeyCredential) => Promise<AuthResult | undefined>;
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
      // Static model selection precedes pi's --api-key handling. Only the URL
      // and model definitions are needed here; request-time auth still applies.
      if (!config.discovery) {
        try {
          const baseUrl = await resolveBaseUrl(config, credential, authContext);
          context.signal.throwIfAborted();
          const built = baseUrl ? buildCatalog(config.models!.map((id) => ({ id, endpoints: [] })), config, baseUrl) : undefined;
          await context.publish({ update: () => {
            models = built?.models ?? [];
            scope = undefined;
            status = built ? { state: "static", report: built.report } : { state: "unconfigured", report: emptyReport() };
          } });
        } catch (error) {
          context.signal.throwIfAborted();
          await context.publish({ update: () => {
            models = [];
            scope = undefined;
            status = { state: "empty", report: emptyReport(), error: error instanceof Error ? error.message : "NewAPI static model configuration failed." };
          } });
          throw error;
        }
        return;
      }
      let connection: Awaited<ReturnType<typeof resolveConnection>>;
      let headers: Headers;
      try {
        const resolved = await options.resolveAuth?.(context.signal, credential)
          ?? await dispatch.auth.apiKey!.resolve({ ctx: authContext, credential, signal: context.signal });
        if (resolved?.auth.apiKey) credential = { type: "api_key", key: resolved.auth.apiKey, env: resolved.env };
        connection = await resolveConnection(config, credential, authContext);
        headers = connection ? discoveryHeaders(connection.key, resolved?.auth.headers) : new Headers();
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
      // changed gateway, token, access headers, override or pi catalog cannot
      // resurrect stale models. Header values never enter the persisted snapshot.
      const nextScope = createHash("sha256").update(JSON.stringify([4, connection, [...headers], config, catalogVersion()])).digest("hex");
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
        if (!context.allowNetwork || context.signal.aborted) return;
        const age = status.checkedAt === undefined ? undefined : Date.now() - status.checkedAt;
        if (!context.force && age !== undefined && age >= 0 && age < 5 * 60 * 1000) return;
        const catalog = await fetchCatalog(connection.baseUrl, headers, context.signal, fetcher);
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
