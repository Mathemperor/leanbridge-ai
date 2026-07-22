import type { ReasoningEffort } from "./adapters/model/openai-proof-model";

const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

export interface RuntimeConfig {
  port: number;
  cloudMode: boolean;
  demoMode: boolean;
  apiKey?: string;
  backendToken?: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  leanProjectPath?: string;
  leanCommand: string;
  lakeCommand: string;
  leanTimeoutMs: number;
  maxRepairAttempts: number;
}

export interface PublicRuntimeConfig {
  provider: "demo" | "openai";
  model: string;
  reasoningEffort: ReasoningEffort;
  maxRepairAttempts: number;
  lean: {
    mode: "demo" | "local" | "cloud";
    projectConfigured: boolean;
  };
}

function booleanValue(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function reasoningEffort(value: string | undefined): ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? value as ReasoningEffort
    : "high";
}

export function loadConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const cloudMode = booleanValue(env.CLOUD_MODE);
  const demoMode = cloudMode ? false : booleanValue(env.DEMO_MODE);
  const apiKey = env.OPENAI_API_KEY?.trim();
  const backendToken = env.LEANBRIDGE_BACKEND_TOKEN?.trim();
  const leanProjectPath = env.LEAN_PROJECT_PATH?.trim();
  if (!demoMode && !apiKey) {
    throw new Error("OPENAI_API_KEY is required unless DEMO_MODE=true");
  }
  if (cloudMode && !backendToken) {
    throw new Error("LEANBRIDGE_BACKEND_TOKEN is required in cloud mode");
  }
  if (cloudMode && !leanProjectPath) {
    throw new Error("LEAN_PROJECT_PATH is required in cloud mode");
  }

  return {
    port: boundedInteger(env.PORT, 4_310, 1, 65_535),
    cloudMode,
    demoMode,
    ...(apiKey ? { apiKey } : {}),
    ...(backendToken ? { backendToken } : {}),
    model: env.OPENAI_MODEL?.trim() || "gpt-5.6",
    reasoningEffort: reasoningEffort(env.OPENAI_REASONING_EFFORT),
    ...(leanProjectPath ? { leanProjectPath } : {}),
    leanCommand: env.LEAN_COMMAND?.trim() || "lean",
    lakeCommand: env.LAKE_COMMAND?.trim() || "lake",
    leanTimeoutMs: boundedInteger(env.LEAN_TIMEOUT_MS, 30_000, 1_000, 300_000),
    maxRepairAttempts: boundedInteger(env.MAX_REPAIR_ATTEMPTS, 3, 0, 5),
  };
}

export function toPublicConfig(config: RuntimeConfig): PublicRuntimeConfig {
  return {
    provider: config.demoMode ? "demo" : "openai",
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    maxRepairAttempts: config.maxRepairAttempts,
    lean: {
      mode: config.cloudMode ? "cloud" : config.demoMode ? "demo" : "local",
      projectConfigured: Boolean(config.leanProjectPath),
    },
  };
}
