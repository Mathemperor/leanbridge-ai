import type { ReasoningEffort } from "./adapters/model/openai-proof-model";
import { codexCatalog, type CodexCatalog } from "@shared/codex-options";

const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const MODEL_PROVIDERS = ["openai", "nebius", "codex"] as const;
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
  accessPassword?: string;
  model: string;
  baseURL?: string;
  reasoningEffort: ReasoningEffort;
  codexTimeoutMs: number;
  tavilyGroundingEnabled: boolean;
  tavilyApiKey?: string;
  leanProjectPath?: string;
  leanVerifier: "local" | "leanweb";
  leanCommand: string;
  lakeCommand: string;
  leanTimeoutMs: number;
  maxRepairAttempts: number;
}

export interface PublicRuntimeConfig {
  codexCatalog?: CodexCatalog;
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
    verifier?: "local" | "leanweb";
    version?: string;
    serviceUrl?: string;
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
  const apiKey = provider === "codex" ? undefined : provider === "nebius"
    ? env.NEBIUS_API_KEY?.trim()
    : env.OPENAI_API_KEY?.trim();
  const backendToken = env.LEANBRIDGE_BACKEND_TOKEN?.trim();
  const accessPassword = env.LEANBRIDGE_ACCESS_PASSWORD?.trim();
  if (accessPassword && (accessPassword.length < 16 || accessPassword.length > 256 ||
    [env.OPENAI_API_KEY?.trim(), env.NEBIUS_API_KEY?.trim(), env.TAVILY_API_KEY?.trim(), backendToken].includes(accessPassword))) {
    throw new Error("LEANBRIDGE_ACCESS_PASSWORD must be 16-256 characters and different from service credentials");
  }
  const leanProjectPath = env.LEAN_PROJECT_PATH?.trim();
  const leanVerifier = env.LEAN_VERIFIER?.trim() || "local";
  if (leanVerifier !== "local" && leanVerifier !== "leanweb") throw new Error("LEAN_VERIFIER must be local or leanweb");
  const tavilyRequested = booleanValue(env.TAVILY_GROUNDING_ENABLED);
  const tavilyApiKey = env.TAVILY_API_KEY?.trim();
  const tavilyGroundingEnabled = !demoMode && tavilyRequested;

  if (!demoMode && provider !== "codex" && !apiKey) {
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
  if (cloudMode && leanVerifier === "local" && !leanProjectPath) {
    throw new Error("LEAN_PROJECT_PATH is required in cloud mode");
  }

  const model = provider === "codex" ? env.CODEX_MODEL?.trim() || "gpt-6-astra" : provider === "nebius"
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
    ...(accessPassword ? { accessPassword } : {}),
    model,
    ...(baseURL ? { baseURL } : {}),
    reasoningEffort: reasoningEffort(provider === "codex" ? env.CODEX_REASONING_EFFORT : env.OPENAI_REASONING_EFFORT),
    codexTimeoutMs: boundedInteger(env.CODEX_GENERATION_TIMEOUT_MS, 900_000, 30_000, 1_800_000),
    tavilyGroundingEnabled,
    ...(tavilyGroundingEnabled && tavilyApiKey ? { tavilyApiKey } : {}),
    ...(leanProjectPath ? { leanProjectPath } : {}),
    leanVerifier,
    leanCommand: env.LEAN_COMMAND?.trim() || "lean",
    lakeCommand: env.LAKE_COMMAND?.trim() || "lake",
    leanTimeoutMs: boundedInteger(env.LEAN_TIMEOUT_MS, leanVerifier === "leanweb" ? 120_000 : cloudMode ? 240_000 : 30_000, 1_000, 600_000),
    maxRepairAttempts: boundedInteger(env.MAX_REPAIR_ATTEMPTS, 3, 0, 5),
  };
}

export function toPublicConfig(config: RuntimeConfig): PublicRuntimeConfig {
  return {
    ...(config.provider === "codex" && !config.demoMode ? { codexCatalog: codexCatalog(config) } : {}),
    provider: config.demoMode ? "demo" : config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    maxRepairAttempts: config.maxRepairAttempts,
    grounding: {
      tavily: config.tavilyGroundingEnabled,
    },
    lean: {
      mode: config.cloudMode ? "cloud" : config.demoMode ? "demo" : "local",
      projectConfigured: config.leanVerifier === "leanweb" || Boolean(config.leanProjectPath),
      verifier: config.leanVerifier,
      ...(config.leanVerifier === "leanweb" ? { version: "4.24.0", serviceUrl: "https://live.lean-lang.org" } : {}),
    },
  };
}
