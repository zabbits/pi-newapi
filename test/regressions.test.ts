import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createModels, getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore,
  type Api, type AuthContext, type Context, type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildCatalog } from "../src/catalog.ts";
import { parseConfig } from "../src/config.ts";
import extension from "../src/index.ts";
import { createNewApiProvider } from "../src/provider.ts";

const noAmbientAuth: AuthContext = { env: async () => undefined, fileExists: async () => false };
const authContext: AuthContext = { ...noAmbientAuth, env: async (name) => name === "NEWAPI_API_KEY" ? "test-key" : undefined };
const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
async function capture(runtime: Pick<ModelRuntime, "completeSimple">, model: Model<Api>, reasoning: SimpleStreamOptions["reasoning"] = "high") {
  let request: unknown;
  let effective: Model<Api> | undefined;
  const response = await runtime.completeSimple(model, context, { reasoning, onPayload(payload, sentModel) {
    request = payload;
    effective = sentModel;
    throw new Error("captured before network");
  } });
  assert.match(response.errorMessage ?? "", /captured before network/);
  assert.ok(effective);
  return { request, effective, response };
}

test("references preserve reasoning controls, partial restrictions and gateway model identity", async () => {
  const runtime = createModels({ authContext });
  const config = parseConfig({ baseUrl: "https://gateway.example", discovery: false,
    models: ["gemini-3.1-pro-preview", "team-gemini", "team-claude", "team-responses", "team-chat"],
    modelOverrides: {
      "team-gemini": { reference: { provider: "google", id: "gemini-3.1-pro-preview" }, thinkingLevelMap: { high: "HIGH" } },
      "team-claude": { reference: { provider: "anthropic", id: "claude-sonnet-4-5" } },
      "team-responses": { reference: { provider: "openai", id: "o3-pro" } },
      "team-chat": { reference: { provider: "openai", id: "gpt-4o" }, api: "openai-completions" },
    },
  }, {});
  runtime.setProvider(createNewApiProvider(config, { authContext }));
  assert.equal((await runtime.refresh({ allowNetwork: false })).errors.size, 0);
  const canonical = runtime.getModel("newapi", "gemini-3.1-pro-preview")!;
  const alias = runtime.getModel("newapi", "team-gemini")!;
  assert.deepEqual(getSupportedThinkingLevels(alias), getSupportedThinkingLevels(canonical));
  assert.deepEqual(getSupportedThinkingLevels(alias), ["low", "medium", "high"]);
  const original = await capture(runtime, canonical);
  const aliased = await capture(runtime, alias);
  assert.deepEqual((aliased.request as { config: unknown }).config, (original.request as { config: unknown }).config);
  for (const id of ["team-gemini", "team-claude", "team-responses", "team-chat"]) {
    const captured = id === "team-gemini" ? aliased : await capture(runtime, runtime.getModel("newapi", id)!);
    assert.equal((captured.request as { model: string }).model, id);
    assert.equal(captured.effective.id, id);
    assert.equal(captured.response.model, id);
  }
});

test("pi model endpoint overrides survive authentication and actual adapter dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newapi-overrides-"));
  try {
    const modelsPath = join(directory, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { newapi: {
      baseUrl: "https://override.example/anthropic",
    } } }));
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("newapi", async () => ({ type: "api_key", key: "test-key", env: { NEWAPI_BASE_URL: "https://gateway.example" } }));
    const host = await ModelRuntime.create({ credentials, modelsPath, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
    const config = parseConfig({ discovery: false, models: ["claude-sonnet-4-5"] }, {});
    host.registerNativeProvider(createNewApiProvider(config));
    await host.refresh({ providers: ["newapi"], allowNetwork: false });
    const first = await capture(host, host.getModel("newapi", "claude-sonnet-4-5")!);
    assert.equal(first.effective.baseUrl, "https://override.example/anthropic");
    await writeFile(modelsPath, JSON.stringify({ providers: { newapi: { models: [
      { id: "claude-sonnet-4-5", api: "anthropic-messages", baseUrl: "https://override.example/model-endpoint" },
    ] } } }));
    await host.refresh({ providers: ["newapi"], allowNetwork: false });
    const second = await capture(host, host.getModel("newapi", "claude-sonnet-4-5")!);
    assert.equal(second.effective.baseUrl, "https://override.example/model-endpoint");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("host-configured API keys restore offline caches and invalidate them after key changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newapi-credentials-"));
  try {
    const modelsPath = join(directory, "models.json");
    const configure = (apiKey: string) => writeFile(modelsPath, JSON.stringify({ providers: { newapi: { apiKey } } }));
    await configure("configured-key");
    const credentials = new InMemoryCredentialStore();
    const modelsStore = new InMemoryModelsStore();
    let calls = 0;
    const makeHost = async () => {
      const host = await ModelRuntime.create({ credentials, modelsStore, modelsPath, refreshOnCreate: false });
      host.registerNativeProvider(createNewApiProvider(parseConfig({ baseUrl: "https://gateway.example" }, {}), {
        authContext: noAmbientAuth,
        resolveAuth: (signal, credential) => host.getProvider("newapi")!.auth.apiKey!.resolve({ ctx: noAmbientAuth, credential, signal }),
        fetch: async (_url, init) => {
          calls++;
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer configured-key");
          return new Response(JSON.stringify({ data: [{ id: "gpt-4o", supported_endpoint_types: ["openai"] }] }));
        },
      }));
      return host;
    };
    const online = await makeHost();
    assert.equal((await online.refresh({ providers: ["newapi"], allowNetwork: true })).errors.size, 0);
    assert.equal(online.getModels("newapi").length, 1);
    const offline = await makeHost();
    assert.equal((await offline.refresh({ providers: ["newapi"], allowNetwork: false })).errors.size, 0);
    assert.equal(offline.getModels("newapi").length, 1);
    assert.equal(calls, 1);
    await configure("changed-key");
    await offline.refresh({ providers: ["newapi"], allowNetwork: false });
    assert.equal(offline.getModels("newapi").length, 0);
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("static models register before a request-time API key is supplied", async () => {
  const runtime = createModels({ authContext: noAmbientAuth });
  const provider = createNewApiProvider(parseConfig({ baseUrl: "https://gateway.example", discovery: false, models: ["gpt-4o"] }, {}), {
    authContext: noAmbientAuth,
    fetch: async () => { throw new Error("Static mode must not fetch a catalog"); },
  });
  runtime.setProvider(provider);
  assert.equal((await runtime.refresh({ allowNetwork: false })).errors.size, 0);
  const model = runtime.getModel("newapi", "gpt-4o");
  assert.ok(model, "Model selection must succeed without a saved or environment key");
  assert.equal(provider.getStatus().state, "static");
  assert.equal((await runtime.getAvailable("newapi")).length, 0);
  let dispatched = false;
  const result = await runtime.completeSimple(model, context, { apiKey: "inline-key", onPayload(payload) {
    assert.equal((payload as { model: string }).model, "gpt-4o");
    dispatched = true;
    throw new Error("captured inline-key request");
  } });
  assert.equal(dispatched, true);
  assert.match(result.errorMessage ?? "", /captured inline-key request/);
});

test("discovery uses host access headers with saved keys and scopes cached catalogs to them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newapi-access-"));
  try {
    const modelsPath = join(directory, "models.json");
    const configure = (secret: string) => writeFile(modelsPath, JSON.stringify({ providers: { newapi: {
      apiKey: "unused-configured-key",
      headers: { "CF-Access-Client-Id": "access-client", "CF-Access-Client-Secret": secret, aCcEpT: "application/vnd.newapi+json" },
    } } }));
    await configure("access-secret");
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("newapi", async () => ({ type: "api_key", key: "saved-key", env: { NEWAPI_BASE_URL: "https://saved.example" } }));
    const modelsStore = new InMemoryModelsStore();
    let calls = 0;
    const makeHost = async () => {
      const host = await ModelRuntime.create({ credentials, modelsStore, modelsPath, refreshOnCreate: false });
      host.registerNativeProvider(createNewApiProvider(parseConfig({ baseUrl: "https://unused.example" }, {}), {
        authContext: noAmbientAuth,
        resolveAuth: (signal, credential) => host.getProvider("newapi")!.auth.apiKey!.resolve({ ctx: noAmbientAuth, credential, signal }),
        fetch: async (url, init) => {
          calls++;
          assert.equal(url, "https://saved.example/v1/models");
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), "Bearer saved-key");
          assert.equal(headers.get("cf-access-client-id"), "access-client");
          assert.equal(headers.get("cf-access-client-secret"), "access-secret");
          assert.equal(headers.get("accept"), "application/vnd.newapi+json");
          return new Response(JSON.stringify({ data: [{ id: "gpt-4o", supported_endpoint_types: ["openai"] }] }));
        },
      }));
      return host;
    };
    const online = await makeHost();
    assert.equal((await online.refresh({ providers: ["newapi"], allowNetwork: true })).errors.size, 0);
    assert.equal(online.getModels("newapi").length, 1);
    const snapshot = JSON.stringify(await modelsStore.read("newapi"));
    for (const secret of ["saved-key", "access-client", "access-secret"]) assert.ok(!snapshot.includes(secret));
    const offline = await makeHost();
    assert.equal((await offline.refresh({ providers: ["newapi"], allowNetwork: false })).errors.size, 0);
    assert.equal(offline.getModels("newapi").length, 1);
    assert.equal(calls, 1);
    await configure("changed-access-secret");
    assert.equal((await offline.refresh({ providers: ["newapi"], allowNetwork: false })).errors.size, 0);
    assert.equal(offline.getModels("newapi").length, 0, "Changed access headers must invalidate the old catalog");
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("static catalog failures retain an actionable status; documented references resolve", async () => {
  const provider = createNewApiProvider(parseConfig({ baseUrl: "https://gateway.example", discovery: false,
    models: ["gpt-4o"], modelOverrides: { "gpt-4o": { contextWindow: 100, maxTokens: 200 } },
  }, {}), { authContext });
  const runtime = createModels({ authContext });
  runtime.setProvider(provider);
  assert.equal((await runtime.refresh({ allowNetwork: false })).errors.size, 1);
  assert.match(provider.getStatus().error ?? "", /maxTokens exceeds contextWindow for gpt-4o/);
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const examples = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.ok(examples.length);
  for (const [, text] of examples) {
    const config = parseConfig(JSON.parse(text), {});
    const entries = (config.models ?? Object.keys(config.modelOverrides)).map((id) => ({ id, endpoints: [] }));
    assert.doesNotThrow(() => buildCatalog(entries, config, "https://gateway.example"));
  }
});

test("/newapi refresh exposes host errors that occur before provider refresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newapi-command-"));
  const before = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith("NEWAPI_")) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = directory;
    process.env.PI_OFFLINE = "1";
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi: Pick<ExtensionAPI, "registerProvider" | "on" | "registerCommand"> = {
      registerProvider() {}, on() { return () => {}; },
      registerCommand(_name, command) { handler = command.handler; },
    };
    await extension(pi as ExtensionAPI);
    assert.ok(handler);
    const notifications: string[] = [];
    const ctx = { modelRegistry: {
      refresh: async () => ({ aborted: false, errors: new Map([["newapi", new Error("Cannot read models-store.json")]]) }),
    }, ui: { notify: (text: string) => notifications.push(text) } } as unknown as ExtensionCommandContext;
    await handler("refresh", ctx);
    assert.ok(notifications.some((text) => text.includes("Cannot read models-store.json")));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    await rm(directory, { recursive: true, force: true });
  }
});
