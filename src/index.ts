import { join } from "node:path";
import { getAgentDir, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { loadConfig } from "./config.ts";
import { createNewApiProvider } from "./provider.ts";

export default async function newApiExtension(pi: ExtensionAPI): Promise<void> {
  const config = await loadConfig(process.env.NEWAPI_CONFIG ?? join(getAgentDir(), "newapi.json"));
  let host: Pick<ModelRuntime, "getProvider"> | undefined;
  const authContext = defaultProviderAuthContext();
  const provider = createNewApiProvider(config, {
    authContext,
    resolveAuth: async (signal, credential) => host?.getProvider("newapi")?.auth.apiKey?.resolve({ ctx: authContext, credential, signal }),
  });
  pi.registerProvider(provider);
  // pi 1.5 resolves an explicit --model before its background catalog refresh.
  // Bootstrap this same native provider with pi's credential/catalog stores so a
  // first-run CLI invocation works too. Failures retain cache and remain visible
  // in /newapi; they must not prevent registration or /login.
  const bootstrap = await ModelRuntime.create({ refreshOnCreate: false });
  host = bootstrap;
  bootstrap.registerNativeProvider(provider);
  const initial = await bootstrap.refresh({ providers: ["newapi"], allowNetwork: process.env.PI_OFFLINE === undefined, signal: AbortSignal.timeout(12000) });
  let refreshError = initial.errors.get("newapi")?.message;
  if (refreshError === provider.getStatus().error) refreshError = undefined;
  pi.registerCommand("newapi", {
    description: "Show NewAPI model configuration; /newapi refresh refreshes the catalog",
    handler: async (args, ctx) => {
      host = ctx.modelRegistry;
      if (args.trim() && args.trim() !== "refresh") { ctx.ui.notify("Usage: /newapi [refresh]", "info"); return; }
      if (args.trim() === "refresh") {
        const result = await ctx.modelRegistry.refresh({ providers: ["newapi"], force: true, allowNetwork: process.env.PI_OFFLINE === undefined, signal: AbortSignal.timeout(15000) });
        refreshError = result.errors.get("newapi")?.message;
        if (refreshError === provider.getStatus().error) refreshError = undefined;
        if (result.aborted) ctx.ui.notify("NewAPI refresh cancelled or timed out.", "warning");
      }
      const status = provider.getStatus();
      const lines = [`NewAPI: ${status.state}; ${provider.getModels().length} chat models`];
      if (status.state === "unconfigured") lines.push("Use /login newapi, or set NEWAPI_BASE_URL and NEWAPI_API_KEY before starting pi.");
      if (process.env.PI_OFFLINE !== undefined) lines.push("Offline mode: network discovery disabled.");
      if (status.error) lines.push(status.error);
      if (refreshError && refreshError !== status.error) lines.push(refreshError);
      for (const info of status.report.models) {
        const model = provider.getModels().find((m) => m.id === info.id)!;
        lines.push(`${info.id}: ${info.api}; context ${model.contextWindow}, output ${model.maxTokens}; ${model.input.join("+")}; reasoning ${model.reasoning ? "on" : "off"}; metadata ${info.source}; price ${info.pricing}`);
        for (const note of info.notes) lines.push(`  ${note}`);
      }
      for (const item of status.report.skipped) lines.push(`Skipped ${item.id}: ${item.reason}`);
      ctx.ui.notify(lines.join("\n"), status.error || refreshError ? "warning" : "info");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    host = ctx.modelRegistry;
    const status = provider.getStatus();
    const error = status.error ?? refreshError;
    if (error) ctx.ui.notify(`${error} ${provider.getModels().length ? "Using cached models." : "No NewAPI models loaded."} See /newapi.`, "warning");
    else if (status.report.models.some((model) => model.source === "defaults")) ctx.ui.notify("Some NewAPI models have unknown capabilities. Use /newapi to review their defaults.", "warning");
  });
}
