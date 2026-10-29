const MAX_DETAIL_LENGTH = 512;

function redact(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /\b(OPENAI_API_KEY|LEANBRIDGE_BACKEND_TOKEN)\s*=\s*[^\s,;]+/gi,
      "$1=[redacted]",
    );
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return redact(value.trim());
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function safeProviderErrorDetail(error: unknown): string {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : {};
  const parts: string[] = [];
  for (const key of ["status", "code", "type"] as const) {
    const value = scalar(record[key]);
    if (value) parts.push(`${key}=${value}`);
  }
  if (record.name === "ChatGPTPlanError") {
    const fields={param:["service_tier","model","reasoning.effort","input","text.format","store","stream"],providerType:["invalid_request_error","permission_error","authentication_error","rate_limit_error","server_error"],bodyShape:["error","detail","json","event","unavailable"]};
    for (const key of ["param","providerType","bodyShape"] as const) {
      if (typeof record[key] === "string" && fields[key].includes(record[key])) parts.push(`${key}=${record[key]}`);
    }
    if (typeof record.requestId === "string" && /^req_[a-zA-Z0-9_-]{1,100}$/.test(record.requestId)) parts.push(`requestId=${record.requestId}`);
  }
  if (error instanceof Error && error.name !== "Error") {
    parts.push(`name=${redact(error.name)}`);
  }
  const message = error instanceof Error ? error.message : scalar(record.message);
  if (message && parts.length > 0) parts.push(`message=${redact(message)}`);
  return parts.join(" ").slice(0, MAX_DETAIL_LENGTH);
}
