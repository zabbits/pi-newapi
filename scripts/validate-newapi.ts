/** Run only against a fresh, disposable instance of the official NewAPI binary. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createModels, InMemoryCredentialStore, InMemoryModelsStore, type Context } from "@earendil-works/pi-ai";
import { createNewApiProvider } from "../src/provider.ts";
import { parseConfig } from "../src/config.ts";

const binary = process.env.NEWAPI_TEST_BINARY;
assert.ok(binary, "Set NEWAPI_TEST_BINARY to an official NewAPI executable. This script creates and removes its own database.");
const directory = await mkdtemp(join(tmpdir(), "pi-newapi-real-"));
const fixture = join(directory, "fixture.txt");
const marker = "newapi-real-tool-result";
const thoughtSignature = Buffer.from("signed-gemini-fixture").toString("base64");
await writeFile(fixture, marker);
const captured: Array<{ url: string; body: any }> = [];
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

// The upstream is controlled; authentication, catalog generation, routing and
// protocol handling between pi and this upstream run through real NewAPI.
function respond(res: ServerResponse, url: string, done: boolean) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (data: object, event?: string) => res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
  const args = JSON.stringify({ path: fixture });
  const text = "NewAPI verified.";
  if (url.includes("/responses")) {
    const emit = (type: string, data: object) => send({ type, ...data }, type);
    const item = done ? { id: "msg_test", type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }], status: "completed" }
      : { id: "fc_test", type: "function_call", call_id: "call_read", name: "read", arguments: args, status: "completed" };
    emit("response.created", { response: { id: "resp_test", status: "in_progress", output: [] } });
    emit("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", content: [] } });
    emit(done ? "response.output_text.delta" : "response.function_call_arguments.delta", { output_index: 0, content_index: 0, delta: done ? text : args });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", { response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
  } else if (url.includes("/messages")) {
    const emit = (type: string, data: object) => send({ type, ...data }, type);
    emit("message_start", { message: { id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    emit("content_block_start", { index: 0, content_block: done ? { type: "text", text: "" } : { type: "tool_use", id: "call_read", name: "read", input: {} } });
    emit("content_block_delta", { index: 0, delta: done ? { type: "text_delta", text } : { type: "input_json_delta", partial_json: args } });
    emit("content_block_stop", { index: 0 });
    emit("message_delta", { delta: { stop_reason: done ? "end_turn" : "tool_use" }, usage: { output_tokens: 10 } });
    emit("message_stop", {});
  } else if (url.includes(":streamGenerateContent")) {
    send({ candidates: [{ index: 0, content: { role: "model", parts: [done ? { text } : { functionCall: { name: "read", args: { path: fixture } }, thoughtSignature }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } });
  } else {
    const emit = (delta: object, finish_reason: string | null = null) => send({ id: "chat_test", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta, finish_reason }] });
    emit({ role: "assistant" });
    emit(done ? { content: text } : { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: args } }] });
    emit({}, done ? "stop" : "tool_calls");
    send({ id: "chat_test", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
    res.write("data: [DONE]\n\n");
  }
  res.end();
}
const upstream = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    captured.push({ url: req.url!, body });
    respond(res, req.url!, JSON.stringify(body).includes(marker));
  } catch { res.writeHead(500).end(); }
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamAddress = upstream.address();
assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
const reserved = createServer();
reserved.listen(0, "127.0.0.1");
await once(reserved, "listening");
const address = reserved.address();
assert.ok(address && typeof address !== "string");
await new Promise<void>((resolve) => reserved.close(() => resolve()));
const base = `http://127.0.0.1:${address.port}`;
const server = spawn(binary, ["--port", String(address.port)], { cwd: directory, env: { PATH: process.env.PATH, HOME: directory, SESSION_SECRET: randomBytes(32).toString("hex"), TRUSTED_PROXIES: "none", DEFAULT_LANGUAGE: "en", MEMORY_CACHE_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
server.stdout.on("data", (data) => { logs = (logs + data).slice(-12000); });
server.stderr.on("data", (data) => { logs = (logs + data).slice(-12000); });
let access: string | undefined;
async function api(path: string, body?: unknown, method = body ? "POST" : "GET"): Promise<any> {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "Accept-Language": "en", ...(access ? { Authorization: `Bearer ${access}`, "New-Api-User": "1" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const result = await response.json() as any;
  assert.ok(response.ok && result.success !== false, `${method} ${path}: ${JSON.stringify(result)}`);
  return result.data;
}
try {
  for (let attempt = 0; ; attempt++) {
    try { await api("/api/setup"); break; }
    catch (error) { if (attempt > 100 || server.exitCode !== null) throw error; await delay(100); }
  }
  const password = randomBytes(20).toString("hex");
  await api("/api/setup", { username: "pi_test", password, confirmPassword: password, SelfUseModeEnabled: true });
  const login = await api("/api/user/login", { username: "pi_test", password });
  access = login.access_token;
  assert.ok(access);
  for (const [type, name, models] of [
    [1, "openai", "gpt-4o,o3-pro,gpt-image-1,text-embedding-3-small"],
    [14, "anthropic", "claude-sonnet-4-5"], [24, "gemini", "gemini-2.5-pro,team-gemini"],
  ] as const) await api("/api/channel/", { mode: "single", channel: { type, name, models, key: "upstream-test-only", base_url: `http://127.0.0.1:${upstreamAddress.port}`, group: "default", status: 1,
    model_mapping: JSON.stringify({ "team-gemini": "gemini-3.1-pro-preview" }),
  } });
  await api("/api/pricing"); // Refresh NewAPI's real endpoint metadata cache.
  await api("/api/token/", { name: "pi-validation", unlimited_quota: true, expired_time: -1, group: "default" });
  const tokens = await api("/api/token/");
  const tokenId = tokens.items[0].id;
  const tokenData = await api(`/api/token/${tokenId}/key`, {});
  const key = tokenData.key;
  assert.ok(typeof key === "string");
  const discovered = await (await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })).json() as any;
  console.log("Actual NewAPI catalog:", JSON.stringify(discovered.data.map(({ id, supported_endpoint_types }: any) => ({ id, supported_endpoint_types }))));
  const credentials = new InMemoryCredentialStore();
  const store = new InMemoryModelsStore();
  const config = parseConfig({ baseUrl: base, modelOverrides: {
    "team-gemini": { reference: { provider: "google", id: "gemini-3.1-pro-preview" }, thinkingLevelMap: { high: "HIGH" } },
  } }, {});
  const provider = createNewApiProvider(config);
  const runtime = createModels({ credentials, modelsStore: store });
  runtime.setProvider(provider);
  await runtime.login("newapi", "api_key", { prompt: async (p) => p.type === "secret" ? key : base, notify() {} });
  assert.equal((await runtime.refresh()).errors.size, 0);
  assert.deepEqual(runtime.getModels("newapi").map((m) => m.id).sort(), ["gpt-4o", "o3-pro", "claude-sonnet-4-5", "gemini-2.5-pro", "team-gemini"].sort());
  for (const [id, path] of [["gpt-4o", "/v1/chat/completions"], ["o3-pro", "/v1/responses"], ["claude-sonnet-4-5", "/v1/messages"], ["gemini-2.5-pro", ":streamGenerateContent"], ["team-gemini", "gemini-3.1-pro-preview:streamGenerateContent"]]) {
    const model = runtime.getModel("newapi", id)!;
    const context: Context = { messages: [{ role: "user", content: [{ type: "text", text: "Read the fixture and describe this image." }, { type: "image", data: image, mimeType: "image/png" }], timestamp: Date.now() }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] };
    const before = captured.length;
    const result = await runtime.completeSimple(model, context, { reasoning: model.reasoning ? "high" : undefined, signal: AbortSignal.timeout(15000) });
    assert.equal(result.stopReason, "toolUse", `${id}: ${result.errorMessage}`);
    assert.equal(result.model, id);
    const call = result.content.find((part) => part.type === "toolCall");
    assert.ok(call && call.name === "read");
    assert.equal(call.arguments.path, fixture);
    context.messages.push(result, { role: "toolResult", toolCallId: call.id, toolName: "read", content: [{ type: "text", text: await readFile(fixture, "utf8") }], isError: false, timestamp: Date.now() });
    const answer = await runtime.completeSimple(model, context, { reasoning: model.reasoning ? "high" : undefined, signal: AbortSignal.timeout(15000) });
    assert.equal(answer.stopReason, "stop", `${id}: ${answer.errorMessage}`);
    assert.equal(answer.model, id);
    assert.ok(answer.content.some((part) => part.type === "text" && part.text === "NewAPI verified."));
    const request = captured[before];
    assert.ok(request.url.includes(path), `${id}: unexpected upstream path ${request.url}`);
    assert.ok(JSON.stringify(request.body).includes(image), `${id}: image was not forwarded`);
    if (model.reasoning) assert.ok(request.body.reasoning || request.body.thinking || request.body.generationConfig?.thinkingConfig, `${id}: missing thinking configuration`);
    if (id === "team-gemini") {
      assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
      assert.equal(request.body.generationConfig.thinkingConfig.thinkingBudget, undefined);
      assert.ok(JSON.stringify(captured[before + 1].body).includes(thoughtSignature), "Alias lost its tool-call thought signature on replay");
    }
    console.log(`Verified ${id}: ${model.api}, vision, ${model.reasoning ? "reasoning, " : ""}streaming and tool round trip`);
  }
  // Reuse the full token's catalog store with a different, restricted token.
  await api("/api/token/", { name: "pi-limited", unlimited_quota: true, expired_time: -1, group: "default", model_limits_enabled: true, model_limits: "gpt-4o" });
  const limitedToken = (await api("/api/token/")).items.find((token: any) => token.name === "pi-limited");
  assert.ok(limitedToken);
  const limitedKey = (await api(`/api/token/${limitedToken.id}/key`, {})).key;
  const limitedCredentials = new InMemoryCredentialStore();
  await limitedCredentials.modify("newapi", async () => ({ type: "api_key", key: limitedKey, env: { NEWAPI_BASE_URL: base } }));
  const limited = createModels({ credentials: limitedCredentials, modelsStore: store });
  limited.setProvider(createNewApiProvider(config));
  await limited.refresh({ allowNetwork: false });
  assert.equal(limited.getModels("newapi").length, 0, "Restricted token restored a different token's catalog");
  assert.equal((await limited.refresh()).errors.size, 0);
  assert.deepEqual(limited.getModels("newapi").map((model) => model.id), ["gpt-4o"]);
  await api(`/api/token/${limitedToken.id}`, undefined, "DELETE");
  assert.equal((await limited.refresh({ force: true })).errors.size, 1);
  assert.equal(limited.getModels("newapi").length, 0);
  assert.equal(await store.read("newapi"), undefined);
  console.log("Verified token model restrictions, cache isolation, and revocation");
  const agentDir = join(directory, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ newapi: await credentials.read("newapi") }), { mode: 0o600 });
  await writeFile(join(agentDir, "newapi.json"), JSON.stringify({ modelOverrides: config.modelOverrides }));
  const cli = process.env.PI_TEST_CLI || fileURLToPath(new URL("../node_modules/.bin/pi", import.meta.url));
  const packagePath = fileURLToPath(new URL("..", import.meta.url));
  const args = ["--no-approve", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes"];
  const options = { cwd: directory, env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: agentDir }, timeout: 25000, maxBuffer: 2 * 1024 * 1024 };
  const run = promisify(execFile);
  await run(cli, ["install", packagePath], options);
  // A fresh directory: verify CLI startup, without a previous --list-models priming the cache.
  const pending = run(cli, [...args, "--provider", "newapi", "--model", "o3-pro", "--no-session", "--tools", "read", "--print", "Read the fixture."], options);
  pending.child.stdin?.end();
  const output = await pending;
  assert.match(output.stdout, /NewAPI verified\./);
  const offline = await run(cli, [...args, "--offline", "--list-models", "newapi"], options);
  assert.match(offline.stdout, /o3-pro/);
  assert.doesNotMatch(offline.stdout, /gpt-image-1|text-embedding/);
  console.log("Verified package installation, fresh pi CLI startup with stored credentials, then offline cached listing");
  const saved = await readFile(join(agentDir, "models-store.json"), "utf8");
  assert.ok(!saved.includes(key));
  // Also exercise the installed extension's host-auth bridge: no saved token or
  // environment key, only pi's models.json credential and the gateway setting.
  await rm(join(agentDir, "auth.json"));
  await writeFile(join(agentDir, "newapi.json"), JSON.stringify({ baseUrl: base, modelOverrides: config.modelOverrides }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { newapi: { apiKey: key } } }), { mode: 0o600 });
  const configured = await run(cli, [...args, "--list-models", "newapi"], options);
  assert.match(configured.stdout, /team-gemini/);
  const configuredOffline = await run(cli, [...args, "--offline", "--list-models", "newapi"], options);
  assert.match(configuredOffline.stdout, /team-gemini/);
  console.log("Verified installed extension offline with a models.json API key");
  console.log("Real NewAPI validation passed.");
} catch (error) {
  console.error("Validation failed:", error);
  console.error("Gateway log tail:", logs.slice(-5000));
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), delay(3000)]);
  if (server.exitCode === null) server.kill("SIGKILL");
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
