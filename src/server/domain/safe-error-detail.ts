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
  if (error instanceof Error && error.name !== "Error") {
    parts.push(`name=${redact(error.name)}`);
  }
  const message = error instanceof Error ? error.message : scalar(record.message);
  if (message && parts.length > 0) parts.push(`message=${redact(message)}`);
  return parts.join(" ").slice(0, MAX_DETAIL_LENGTH);
}
