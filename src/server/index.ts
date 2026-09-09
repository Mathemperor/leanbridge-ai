import { resolve } from "node:path";
import { createApp } from "./app";
import { TavilyMathlibGrounder } from "./adapters/grounding/tavily-mathlib-grounder";
import { DemoLeanVerifier } from "./adapters/lean/demo-verifier";
import { ProcessLeanVerifier } from "./adapters/lean/process-verifier";
import { SerialLeanVerifier } from "./adapters/lean/serial-verifier";
import { DemoProofModel } from "./adapters/model/demo-proof-model";
import { NebiusProofModel } from "./adapters/model/nebius-proof-model";
import { OpenAIProofModel } from "./adapters/model/openai-proof-model";
import { loadConfig, toPublicConfig } from "./config";
import { ProofPipeline } from "./domain/proof-pipeline";
import { loadRuntimeEnvironment } from "./secret-env";

const config = loadConfig(loadRuntimeEnvironment(process.env));
const tavilyGrounder = config.tavilyGroundingEnabled
  ? new TavilyMathlibGrounder({ apiKey: config.tavilyApiKey as string })
  : undefined;
const model = config.demoMode
  ? new DemoProofModel()
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
const baseVerifier = config.demoMode ? new DemoLeanVerifier() : new ProcessLeanVerifier();
const verifier = config.cloudMode ? new SerialLeanVerifier(baseVerifier) : baseVerifier;
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
  cloudMode: config.cloudMode,
  ...(config.demoMode
    ? {}
    : {
        readinessVerifier: verifier,
        readinessOptions: verifyDefaults,
      }),
});

app.listen(config.port, () => {
  console.log(`LeanBridge AI is running on http://localhost:${config.port}`);
});
