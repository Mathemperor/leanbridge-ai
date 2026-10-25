import { resolve } from "node:path";
import { createApp } from "./app";
import { TavilyMathlibGrounder } from "./adapters/grounding/tavily-mathlib-grounder";
import { DemoLeanVerifier } from "./adapters/lean/demo-verifier";
import { PinnedLeanReadinessVerifier, ProcessLeanVerifier } from "./adapters/lean/process-verifier";
import { SerialLeanVerifier } from "./adapters/lean/serial-verifier";
import { DemoProofModel } from "./adapters/model/demo-proof-model";
import { NebiusProofModel } from "./adapters/model/nebius-proof-model";
import { OpenAIProofModel } from "./adapters/model/openai-proof-model";
import { CodexProofModel, CodexSession, runCodexCommand } from "./adapters/model/codex-proof-model";
import { loadConfig, toPublicConfig } from "./config";
import { ProofPipeline } from "./domain/proof-pipeline";
import { RuntimeMemoryCoordinator, triggerGarbageCollection } from "./domain/runtime-memory";
import { loadRuntimeEnvironment } from "./secret-env";

const config = loadConfig(loadRuntimeEnvironment(process.env));
const memoryCoordinator = config.cloudMode ? new RuntimeMemoryCoordinator({ evictAfterEachLean: false }) : undefined;
const tavilyGrounder = config.tavilyGroundingEnabled
  ? new TavilyMathlibGrounder({ apiKey: config.tavilyApiKey as string })
  : undefined;
const model = config.demoMode
  ? new DemoProofModel()
  : config.provider === "codex"
    ? new CodexProofModel(
        { model: config.model, reasoningEffort: config.reasoningEffort },
        runCodexCommand,
        memoryCoordinator,
      )
  : config.provider === "nebius"
    ? new NebiusProofModel({
        apiKey: config.apiKey as string,
        model: config.model,
        baseURL: config.baseURL as string,
      }, undefined, tavilyGrounder)
    : new OpenAIProofModel({
        apiKey: config.apiKey as string,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
      });
const baseVerifier = config.demoMode ? new DemoLeanVerifier() : new ProcessLeanVerifier({ cloudMode: config.cloudMode });
const verifier = config.cloudMode
  ? new SerialLeanVerifier(baseVerifier, { coordinator: memoryCoordinator })
  : baseVerifier;
const readinessVerifier = config.demoMode
  ? undefined
  : config.cloudMode
    ? new PinnedLeanReadinessVerifier(verifier)
    : verifier;
const verifyDefaults = {
  timeoutMs: config.leanTimeoutMs,
  leanCommand: config.leanCommand,
  lakeCommand: config.lakeCommand,
  ...(config.leanProjectPath ? { projectPath: config.leanProjectPath } : {}),
};
const pipeline = new ProofPipeline({
  model,
  verifier,
  maxRepairAttempts: config.maxRepairAttempts,
  verifyDefaults,
});

const app = createApp({
  pipeline,
  publicConfig: toPublicConfig(config),
  clientDirectory: resolve(process.cwd(), "dist/client"),
  ...(config.backendToken ? { backendToken: config.backendToken } : {}),
  ...(config.accessPassword ? { accessPassword: config.accessPassword } : {}),
  cloudMode: config.cloudMode,
  ...(config.provider === "codex" ? { codexSession: new CodexSession() } : {}),
  ...(readinessVerifier
    ? {
        readinessVerifier,
        readinessOptions: verifyDefaults,
      }
    : {}),
});

app.listen(config.port, () => {
  if (config.cloudMode) {
    triggerGarbageCollection();
  }
  console.log(`LeanBridge AI is running on http://localhost:${config.port}`);
});
