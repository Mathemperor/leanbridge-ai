import type { ReasoningEffort } from "./adapters/model/openai-proof-model";

const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const MODEL_PROVIDERS = ["openai", "nebius"] as const;
const DEFAULT_NEBIUS_BASE_URL = "https://api.tokenfactory.us-central1.nebius.com/v1/";
const DEFAULT_NEBIUS_MODEL = "nvidia/nemotron-3-super-120b-a12b";

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface RuntimeConfig {
  port: number;
  cloudMode: boolean;
  demoMode: boolean;
  provider: ModelProvider;
  apiKey?: string;
  backendToken?: string;
  model: string;
  baseURL?: string;
  reasoningEffort: ReasoningEffort;
  tavilyGroundingEnabled: boolean;
  tavilyApiKey?: string;
  leanProjectPath?: string;
  leanCommand: string;
  lakeCommand: string;
  leanTimeoutMs: number;
  maxRepairAttempts: number;
}

export interface PublicRuntimeConfig {
  provider: "demo" | ModelProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  maxRepairAttempts: number;
  grounding: {
    tavily: boolean;
  };
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

function modelProvider(value: string | undefined): ModelProvider {
  const normalized = value?.trim().toLowerCase() || "openai";
  if (!MODEL_PROVIDERS.includes(normalized as ModelProvider)) {
    throw new Error(`MODEL_PROVIDER must be one of: ${MODEL_PROVIDERS.join(", ")}`);
  }
  return normalized as ModelProvider;
}

export function loadConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const cloudMode = booleanValue(env.CLOUD_MODE);
  const demoMode = cloudMode ? false : booleanValue(env.DEMO_MODE);
  const provider = modelProvider(env.MODEL_PROVIDER);
  const apiKey = provider === "nebius"
    ? env.NEBIUS_API_KEY?.trim()
    : env.OPENAI_API_KEY?.trim();
  const backendToken = env.LEANBRIDGE_BACKEND_TOKEN?.trim();
  const leanProjectPath = env.LEAN_PROJECT_PATH?.trim();
  const tavilyRequested = booleanValue(env.TAVILY_GROUNDING_ENABLED);
  const tavilyApiKey = env.TAVILY_API_KEY?.trim();
  const tavilyGroundingEnabled = !demoMode && tavilyRequested;

  if (!demoMode && !apiKey) {
    throw new Error(`${provider === "nebius" ? "NEBIUS_API_KEY" : "OPENAI_API_KEY"} is required unless DEMO_MODE=true`);
  }
  if (tavilyGroundingEnabled && provider !== "nebius") {
    throw new Error("TAVILY_GROUNDING_ENABLED requires MODEL_PROVIDER=nebius");
  }
  if (tavilyGroundingEnabled && !tavilyApiKey) {
    throw new Error("TAVILY_API_KEY is required when TAVILY_GROUNDING_ENABLED=true");
  }
  if (cloudMode && !backendToken) {
    throw new Error("LEANBRIDGE_BACKEND_TOKEN is required in cloud mode");
  }
  if (cloudMode && !leanProjectPath) {
    throw new Error("LEAN_PROJECT_PATH is required in cloud mode");
  }

  const model = provider === "nebius"
    ? env.NEBIUS_MODEL?.trim() || DEFAULT_NEBIUS_MODEL
    : env.OPENAI_MODEL?.trim() || "gpt-5.6";
  const baseURL = provider === "nebius"
    ? env.NEBIUS_BASE_URL?.trim() || DEFAULT_NEBIUS_BASE_URL
    : undefined;

  return {
    port: boundedInteger(env.PORT, 4_310, 1, 65_535),
    cloudMode,
    demoMode,
    provider,
    ...(apiKey ? { apiKey } : {}),
    ...(backendToken ? { backendToken } : {}),
    model,
    ...(baseURL ? { baseURL } : {}),
    reasoningEffort: reasoningEffort(env.OPENAI_REASONING_EFFORT),
    tavilyGroundingEnabled,
    ...(tavilyGroundingEnabled && tavilyApiKey ? { tavilyApiKey } : {}),
    ...(leanProjectPath ? { leanProjectPath } : {}),
    leanCommand: env.LEAN_COMMAND?.trim() || "lean",
    lakeCommand: env.LAKE_COMMAND?.trim() || "lake",
    leanTimeoutMs: boundedInteger(env.LEAN_TIMEOUT_MS, 30_000, 1_000, 300_000),
    maxRepairAttempts: boundedInteger(env.MAX_REPAIR_ATTEMPTS, 3, 0, 5),
  };
}

export function toPublicConfig(config: RuntimeConfig): PublicRuntimeConfig {
  return {
    provider: config.demoMode ? "demo" : config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    maxRepairAttempts: config.maxRepairAttempts,
    grounding: {
      tavily: config.tavilyGroundingEnabled,
    },
    lean: {
      mode: config.cloudMode ? "cloud" : config.demoMode ? "demo" : "local",
      projectConfigured: Boolean(config.leanProjectPath),
    },
  };
}
