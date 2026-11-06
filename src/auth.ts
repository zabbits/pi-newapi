import type { ApiKeyAuth, ApiKeyCredential, AuthContext } from "@earendil-works/pi-ai";
import { normalizeBaseUrl, type NewApiConfig } from "./config.ts";

export function validateKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed || /\s/.test(trimmed)) throw new Error("NewAPI API token must be nonempty and contain no whitespace.");
  return trimmed;
}
// Like pi's Cloudflare auth: the saved key and gateway form one provider credential.
export async function resolveConnection(config: NewApiConfig, credential: ApiKeyCredential | undefined, ctx: AuthContext) {
  const key = credential?.key ?? await ctx.env("NEWAPI_API_KEY");
  const base = credential?.env?.NEWAPI_BASE_URL ?? config.baseUrl ?? await ctx.env("NEWAPI_BASE_URL");
  if (!key || !base) return undefined;
  return { key: validateKey(key), baseUrl: normalizeBaseUrl(base) };
}
export function newApiAuth(config: NewApiConfig): ApiKeyAuth {
  return {
    name: "NewAPI API token",
    async login(interaction) {
      const baseUrl = normalizeBaseUrl(await interaction.prompt({ type: "text", message: "NewAPI gateway URL", placeholder: config.baseUrl ?? "https://your-gateway.example" }));
      const key = validateKey(await interaction.prompt({ type: "secret", message: "NewAPI API token" }));
      interaction.signal.throwIfAborted();
      return { type: "api_key", key, env: { NEWAPI_BASE_URL: baseUrl } };
    },
    async resolve({ ctx, credential, signal }) {
      const connection = await resolveConnection(config, credential, ctx);
      signal.throwIfAborted();
      if (!connection) return undefined;
      return {
        auth: { apiKey: connection.key, headers: { Authorization: `Bearer ${connection.key}` } },
        env: { NEWAPI_BASE_URL: connection.baseUrl },
        source: credential?.key ? "stored NewAPI credential" : "NEWAPI_API_KEY",
      };
    },
  };
}
