import { readFileSync, unlinkSync } from "node:fs";

const SECRET_FILE_ENV = "LEANBRIDGE_SECRET_FILE";

export function loadRuntimeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runtime = { ...env };
  const secretFile = runtime[SECRET_FILE_ENV]?.trim();
  delete runtime[SECRET_FILE_ENV];
  if (!secretFile) return runtime;

  let contents: Buffer;
  try {
    contents = readFileSync(secretFile);
  } finally {
    unlinkSync(secretFile);
  }

  const [openaiApiKey = "", nebiusApiKey = "", backendToken = ""] = contents
    .toString("utf8")
    .split("\0");
  if (openaiApiKey) runtime.OPENAI_API_KEY = openaiApiKey;
  if (nebiusApiKey) runtime.NEBIUS_API_KEY = nebiusApiKey;
  if (backendToken) runtime.LEANBRIDGE_BACKEND_TOKEN = backendToken;
  contents.fill(0);
  return runtime;
}
