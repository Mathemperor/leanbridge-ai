import { MODEL_SERVICE_TIERS, type ModelServiceTier } from "@shared/codex-options";
const MAX_STREAM_BYTES = 2 * 1024 * 1024;

const messages = {
  CODEX_TIMEOUT: "ChatGPT 订阅生成超时，请缩小题目后重试。",
  CODEX_OUTPUT_LIMIT: "ChatGPT 订阅输出超过处理上限，请缩小题目后重试。",
  CODEX_USAGE_LIMIT: "ChatGPT 订阅额度暂时不可用，请等待额度恢复后重试。",
  CODEX_AUTH_REQUIRED: "请在工作台重新连接 ChatGPT 订阅账号。",
  CODEX_MODEL_UNAVAILABLE: "当前订阅暂不能使用所选模型或推理强度，请选择其他配置后重试。",
  CODEX_SPEED_UNAVAILABLE: "当前账号或模型不支持所选速度，请选择标准档后重试。未自动更换模型或计费方式。",
  CODEX_IMAGE_REJECTED: "ChatGPT 拒绝了图片输入，请检查图片格式或重新导出图片。",
  CODEX_IMAGE_TRANSCRIPTION_REQUIRED: "Transcribe the image before text-only formalization or repair.",
  CODEX_UPSTREAM_UNAVAILABLE: "ChatGPT 上游连接暂时不可用，请稍后重试。",
  CODEX_RESPONSE_FAILED: "ChatGPT 订阅未完成生成，请重试并保留诊断码。",
  CODEX_RESPONSE_INCOMPLETE: "ChatGPT 订阅生成未完成，请缩小题目后重试。",
  CODEX_STREAM_INCOMPLETE: "ChatGPT 订阅连接在生成完成前中断，请重试。",
  CODEX_STREAM_INVALID: "ChatGPT 订阅返回了无效的响应流，请重试。",
  CODEX_RESPONSE_INVALID: "ChatGPT 订阅生成结果无效，请重试。",
  CODEX_TRANSCRIPTION_INVALID: "ChatGPT 图片识别结果无效，请重新识别或调整图片。",
} as const;

export type PlanResponseErrorCode = keyof typeof messages;

// Constructors accept categorical metadata only. Provider prose, JSON parser
// errors, abort reasons and fetch errors may contain proof data or credentials.
export class PlanResponseError extends Error {
  readonly code: PlanResponseErrorCode;
  readonly status?: number;
  readonly type?: string;

  constructor(code: PlanResponseErrorCode, metadata: { status?: number; type?: string } = {}) {
    super(messages[code]);
    this.name = "ChatGPTPlanError";
    this.code = code;
    if (metadata.status !== undefined) this.status = metadata.status;
    if (metadata.type !== undefined && Object.hasOwn(providerErrors, metadata.type)) this.type = metadata.type;
  }
}

const providerErrors: Record<string, PlanResponseErrorCode> = {
  rate_limit_exceeded: "CODEX_USAGE_LIMIT",
  subscription_sharing_usage_limit_exceeded: "CODEX_USAGE_LIMIT",
  subscription_sharing_usage_unavailable: "CODEX_UPSTREAM_UNAVAILABLE",
  usage_limit_reached: "CODEX_USAGE_LIMIT",
  insufficient_quota: "CODEX_USAGE_LIMIT",
  model_not_found: "CODEX_MODEL_UNAVAILABLE",
  unsupported_model: "CODEX_MODEL_UNAVAILABLE",
  unsupported_reasoning_effort: "CODEX_MODEL_UNAVAILABLE",
  invalid_image: "CODEX_IMAGE_REJECTED",
  invalid_image_format: "CODEX_IMAGE_REJECTED",
  image_parse_error: "CODEX_IMAGE_REJECTED",
  invalid_api_key: "CODEX_AUTH_REQUIRED",
  invalid_token: "CODEX_AUTH_REQUIRED",
  token_expired: "CODEX_AUTH_REQUIRED",
  server_error: "CODEX_UPSTREAM_UNAVAILABLE",
};

function providerFailure(value: unknown, status?: number): PlanResponseError {
  const error = record(value);
  if (error?.param === "service_tier" && (error.code === "subscription_sharing_unsupported_capability" || error.code === "unsupported_value" || error.code === "invalid_value")) {
    return new PlanResponseError("CODEX_SPEED_UNAVAILABLE", status === undefined ? {} : {status});
  }
  const type = typeof error?.code === "string" && Object.hasOwn(providerErrors, error.code) ? error.code : undefined;
  const code = type ? providerErrors[type]! : status === 401 || status === 403 ? "CODEX_AUTH_REQUIRED"
    : status === 429 ? "CODEX_USAGE_LIMIT" : status !== undefined && status >= 500 ? "CODEX_UPSTREAM_UNAVAILABLE" : "CODEX_RESPONSE_FAILED";
  return new PlanResponseError(code, { ...(status !== undefined ? { status } : {}), ...(type ? { type } : {}) });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function terminalText(response: Record<string, unknown>): string | undefined {
  if (!Array.isArray(response.output)) return undefined;
  const texts: string[] = [];
  for (const item of response.output) {
    const message = record(item);
    if (message?.type !== "message" || !Array.isArray(message.content)) continue;
    for (const item of message.content) {
      const content = record(item);
      if (content?.type === "output_text" && typeof content.text === "string") texts.push(content.text);
    }
  }
  return texts.length ? texts.join("") : undefined;
}

async function failureMetadata(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader=response.body.getReader(), decoder=new TextDecoder("utf-8",{fatal:true});
  let bytes=0, text="";
  try {
    for (;;) {
      const chunk=await reader.read();
      if (chunk.done) break;
      bytes+=chunk.value.byteLength;
      if (bytes>16*1024) return undefined;
      text+=decoder.decode(chunk.value,{stream:true});
    }
    return JSON.parse(text+decoder.decode());
  } catch { return undefined; }
  finally { void reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

export async function readPlanStream(response: Response, options: { signal?: AbortSignal; onCompleted?: (metadata:{serviceTier?: ModelServiceTier})=>void } = {}): Promise<string> {
  if (!response.ok) {
    const body=await failureMetadata(response);
    throw providerFailure(record(body)?.error ?? body, response.status);
  }
  if (!response.body) throw new PlanResponseError("CODEX_STREAM_INCOMPLETE");

  // OAuth Responses has been observed to omit Content-Type. Completion is
  // established by the SSE protocol, never by the header or HTTP success alone.
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, buffer = "", eventName = "", text = "";
  let data: string[] = [];
  let result: string | undefined;
  let rejectAborted!: (error: PlanResponseError) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = () => {
    void reader.cancel().catch(() => {});
    rejectAborted(new PlanResponseError("CODEX_TIMEOUT"));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  function dispatch(): void {
    const raw = data.join("\n"), named = eventName;
    data = []; eventName = "";
    if (!raw || raw === "[DONE]") return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new PlanResponseError("CODEX_STREAM_INVALID"); }
    const event = record(parsed);
    if (!event) throw new PlanResponseError("CODEX_STREAM_INVALID");
    const type = typeof event.type === "string" ? event.type : named;
    if (type === "response.output_text.delta") {
      if (typeof event.delta !== "string") throw new PlanResponseError("CODEX_STREAM_INVALID");
      text += event.delta;
    } else if (type === "response.completed") {
      const completed = record(event.response);
      if (completed?.status !== "completed") throw new PlanResponseError("CODEX_RESPONSE_INCOMPLETE");
      result = terminalText(completed) ?? text;
      if (!result.trim()) throw new PlanResponseError("CODEX_RESPONSE_INVALID");
      const tier=completed.service_tier;
      options.onCompleted?.(typeof tier === "string" && MODEL_SERVICE_TIERS.includes(tier as ModelServiceTier) ? {serviceTier:tier as ModelServiceTier} : {});
    } else if (type === "response.incomplete") {
      throw new PlanResponseError("CODEX_RESPONSE_INCOMPLETE");
    } else if (type === "response.failed" || type === "error") {
      throw providerFailure(record(event.response)?.error ?? event.error ?? event);
    }
  }

  function line(value: string): void {
    if (value === "") { dispatch(); return; }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon === -1 ? value : value.slice(0, colon);
    const raw = colon === -1 ? "" : value.slice(colon + 1);
    const content = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "data") data.push(content);
    else if (field === "event") eventName = content;
  }

  function drain(final = false): void {
    while (result === undefined) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) return;
      const index = match.index;
      if (buffer[index] === "\r" && index === buffer.length - 1 && !final) return;
      const width = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      const value = buffer.slice(0, index);
      buffer = buffer.slice(index + width);
      line(value);
    }
  }

  try {
    if (options.signal?.aborted) throw new PlanResponseError("CODEX_TIMEOUT");
    while (result === undefined) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (options.signal?.aborted) throw new PlanResponseError("CODEX_TIMEOUT");
      if (chunk.done) {
        buffer += decoder.decode(); drain(true);
        if (result === undefined) throw new PlanResponseError("CODEX_STREAM_INCOMPLETE");
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new PlanResponseError("CODEX_OUTPUT_LIMIT");
      buffer += decoder.decode(chunk.value, { stream: true });
      drain();
    }
    return result;
  } catch (error) {
    if (error instanceof PlanResponseError) throw error;
    throw new PlanResponseError("CODEX_STREAM_INVALID");
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
