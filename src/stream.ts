import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream, type AssistantMessage, type StreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { apiBaseUrl, isRecord, type ChatModel } from "./config.ts";

/** Only recompute URLs we derived. Explicit models.json endpoints win. */
export function resolveRequestModel(model: ChatModel, registered: ChatModel | undefined, env?: Record<string, string>): ChatModel {
  const metadata = model.newapi ?? registered?.newapi;
  const defaultBaseUrl = metadata?.defaultBaseUrl ?? registered?.baseUrl;
  if (env?.NEWAPI_BASE_URL && model.baseUrl === defaultBaseUrl) {
    return { ...model, baseUrl: apiBaseUrl(env.NEWAPI_BASE_URL, model.api) };
  }
  return model;
}

/**
 * Pi uses model IDs to choose some wire-format details, notably Gemini thinking.
 * Let its adapter see the reference ID, but keep the gateway alias on the wire,
 * in hooks and in session history. Replaying this alias's own signed history
 * under the reference ID prevents pi from treating it as a model switch.
 */
export function streamWithReference<T extends StreamOptions>(
  model: ChatModel,
  referenceId: string | undefined,
  context: TranscriptContext,
  options: T | undefined,
  stream: (model: ChatModel, context: TranscriptContext, options?: T) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  if (!referenceId || referenceId === model.id) return stream(model, context, options);

  const adapterModel = { ...model, id: referenceId };
  const adapterContext: TranscriptContext = {
    ...context,
    messages: context.messages.map((message) => message.role === "assistant"
      && message.provider === model.provider && message.api === model.api && message.model === model.id
      ? { ...message, model: referenceId } : message),
  };
  const adapterOptions = Object.assign({}, options, {
    onPayload: async (payload: unknown) => {
      if (!isRecord(payload)) throw new Error("NewAPI received an unsupported request payload from pi.");
      const request = { ...payload, model: model.id };
      return await options?.onPayload?.(request, model) ?? request;
    },
    onProviderStreamEvent: options?.onProviderStreamEvent
      ? (event: unknown) => options.onProviderStreamEvent!(event, model) : undefined,
    onResponse: options?.onResponse
      ? (response: Parameters<NonNullable<T["onResponse"]>>[0]) => options.onResponse!(response, model) : undefined,
  });
  // Preserve the adapter's shared live partial-message semantics without
  // mutating its model identity or copying the entire response on every delta.
  const messages = new WeakMap<AssistantMessage, AssistantMessage>();
  const publicMessage = (message: AssistantMessage): AssistantMessage => {
    let view = messages.get(message);
    if (!view) {
      view = { ...message, model: model.id };
      messages.set(message, view);
    }
    Object.assign(view, message, { model: model.id });
    return view;
  };
  const source = stream(adapterModel, adapterContext, adapterOptions);
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        if ("partial" in event) output.push({ ...event, partial: publicMessage(event.partial) });
        else if (event.type === "done") output.push({ ...event, message: { ...event.message, model: model.id } });
        else output.push({ ...event, error: { ...event.error, model: model.id } });
      }
      output.end({ ...await source.result(), model: model.id });
    } catch (error) {
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: options?.signal?.aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : "NewAPI stream failed.", timestamp: Date.now(),
      };
      output.push({ type: "error", reason: message.stopReason as "aborted" | "error", error: message });
      output.end();
    }
  })();
  return output;
}
