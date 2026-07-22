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

  const [apiKey = "", backendToken = ""] = contents.toString("utf8").split("\0");
  if (apiKey) runtime.OPENAI_API_KEY = apiKey;
  if (backendToken) runtime.LEANBRIDGE_BACKEND_TOKEN = backendToken;
  contents.fill(0);
  return runtime;
}
