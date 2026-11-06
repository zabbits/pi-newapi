import assert from "node:assert/strict";
import test from "node:test";
import { createModels, InMemoryCredentialStore, InMemoryModelsStore, type AuthContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { parseConfig } from "../src/config.ts";
import { buildCatalog, parseCatalog } from "../src/catalog.ts";
import { createNewApiProvider } from "../src/provider.ts";

// Shapes produced by NewAPI's common/endpoint_type.go, including mixed operation hints.
const catalog = { data: [
  { id: "claude-sonnet-4-5", owned_by: "anthropic", supported_endpoint_types: ["anthropic", "openai"] },
  { id: "gemini-2.5-pro", owned_by: "google", supported_endpoint_types: ["gemini", "openai"] },
  { id: "gpt-5-codex", supported_endpoint_types: ["openai-response"] },
  { id: "gpt-image-1", supported_endpoint_types: ["image-generation", "openai"] },
  { id: "text-embedding-3-small", supported_endpoint_types: ["openai"] },
] };
const config = parseConfig({ baseUrl: "https://gateway.example" }, {});
const env: Record<string, string> = { NEWAPI_API_KEY: "test-key" };
const authContext: AuthContext = { env: async (name) => env[name], fileExists: async () => false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("realistic NewAPI hints preserve native protocols and exclude non-chat operations", () => {
  const parsed = parseCatalog(catalog);
  const { models, report } = buildCatalog(parsed.entries, config, config.baseUrl!);
  assert.deepEqual(models.map((m) => m.api), ["anthropic-messages", "google-generative-ai", "openai-responses"]);
  assert.deepEqual(report.skipped.map((m) => m.id), ["gpt-image-1", "text-embedding-3-small"]);
  const reference = getBuiltinModels("anthropic").find((m) => m.id === "claude-sonnet-4-5")!;
  assert.ok(reference);
  const model = models[0];
  assert.equal(model.reasoning, reference.reasoning);
  assert.deepEqual(model.input, reference.input);
  assert.equal(model.contextWindow, reference.contextWindow);
  assert.equal(model.maxTokens, reference.maxTokens);
  assert.deepEqual(model.thinkingLevelMap, reference.thinkingLevelMap);
  assert.deepEqual(model.compat, reference.compat);
  assert.equal(model.baseUrl, "https://gateway.example");
  assert.equal(model.cost.input, 0); // Upstream prices are not gateway prices.
});

test("allowlists retain discovered metadata; aliases and explicit overrides are applied per model", () => {
  const settings = parseConfig({ models: ["team-model", "gpt-5-codex"], modelOverrides: {
    "team-model": { reference: { provider: "anthropic", id: "claude-sonnet-4-5" }, contextWindow: 64000, maxTokens: 12000, cost: { input: 2 } },
    "gpt-5-codex": { api: "openai-completions" },
  } }, {});
  const entries = parseCatalog({ data: [...catalog.data, { id: "team-model", supported_endpoint_types: ["anthropic", "openai"] }] }).entries;
  const { models } = buildCatalog(entries, settings, "https://host/proxy/v1");
  assert.equal(models.length, 2);
  const alias = models.find((m) => m.id === "team-model")!;
  assert.equal(alias.api, "anthropic-messages");
  assert.equal(alias.baseUrl, "https://host/proxy");
  assert.equal(alias.reasoning, true);
  assert.ok(alias.input.includes("image"));
  assert.equal(alias.maxTokens, 12000);
  assert.equal(alias.cost.input, 2);
  assert.equal(models[0].api, "openai-completions");
});

test("native lifecycle restores scoped cache offline and retains it on temporary failure", async () => {
  const store = new InMemoryModelsStore();
  let calls = 0;
  let fail = false;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    return fail ? json({}, 503) : json(catalog);
  };
  const first = createModels({ authContext, modelsStore: store });
  first.setProvider(createNewApiProvider(config, { authContext, fetch: fetcher }));
  assert.equal((await first.refresh()).errors.size, 0);
  assert.equal(first.getModels("newapi").length, 3);
  const second = createModels({ authContext, modelsStore: store });
  const provider = createNewApiProvider(config, { authContext, fetch: fetcher });
  second.setProvider(provider);
  await second.refresh({ allowNetwork: false });
  assert.equal(calls, 1);
  assert.equal(second.getModels("newapi").length, 3);
  fail = true;
  assert.equal((await second.refresh({ force: true })).errors.size, 1);
  assert.equal(second.getModels("newapi").length, 3);
  assert.equal(provider.getStatus().state, "cached");
  const otherAuth = { ...authContext, env: async () => "different-key" };
  const third = createModels({ authContext: otherAuth, modelsStore: store });
  third.setProvider(createNewApiProvider(config, { authContext: otherAuth, fetch: fetcher }));
  await third.refresh({ allowNetwork: false });
  assert.equal(third.getModels("newapi").length, 0);
  assert.ok(!JSON.stringify(await store.read("newapi")).includes("test-key"));
});

test("/login credentials drive both discovery and inference auth; revoked catalogs are cleared", async () => {
  const credentials = new InMemoryCredentialStore();
  const store = new InMemoryModelsStore();
  let denied = false;
  const provider = createNewApiProvider(config, { authContext, fetch: async (url, init) => {
    assert.equal(url, "https://saved.example/v1/models");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer saved-key");
    return denied ? json({}, 401) : json(catalog);
  } });
  const runtime = createModels({ credentials, authContext, modelsStore: store });
  runtime.setProvider(provider);
  await runtime.login("newapi", "api_key", { prompt: async (p) => p.type === "secret" ? "saved-key" : "https://saved.example", notify() {} });
  await runtime.refresh({ force: true });
  const auth = await runtime.getAuth("newapi");
  assert.equal(auth?.auth.apiKey, "saved-key");
  assert.equal(auth?.env?.NEWAPI_BASE_URL, "https://saved.example/v1");
  denied = true;
  await runtime.refresh({ force: true });
  assert.equal(runtime.getModels("newapi").length, 0);
  assert.equal(await store.read("newapi"), undefined);
});

test("cancellation does not publish a partial catalog; explicit static mode makes no requests", async () => {
  const controller = new AbortController();
  const runtime = createModels({ authContext });
  const provider = createNewApiProvider(config, { authContext, fetch: async (_url, init) => {
    controller.abort();
    init?.signal?.throwIfAborted();
    return json(catalog);
  } });
  runtime.setProvider(provider);
  assert.equal((await runtime.refresh({ signal: controller.signal })).aborted, true);
  assert.equal(runtime.getModels("newapi").length, 0);
  const staticConfig = parseConfig({ ...config, discovery: false, models: ["gpt-5-codex"] }, {});
  runtime.setProvider(createNewApiProvider(staticConfig, { authContext, fetch: async () => { throw new Error("unexpected network"); } }));
  assert.equal((await runtime.refresh({ allowNetwork: false })).errors.size, 0);
  assert.equal(runtime.getModels("newapi")[0].api, "openai-responses");
});
