import type { ProofJob, ProofRequest } from "@shared/proof";

export interface ClientRuntimeConfig {
  provider: "demo" | "openai";
  model: string;
  reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  maxRepairAttempts: number;
  lean: {
    mode: "demo" | "local" | "cloud";
    projectConfigured: boolean;
  };
}

export interface LeanBridgeApi {
  getConfig(): Promise<ClientRuntimeConfig>;
  createProof(request: ProofRequest): Promise<ProofJob>;
  getProof(id: string): Promise<ProofJob>;
  reverify(id: string, code: string): Promise<ProofJob>;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json() as { error?: string } & T;
  if (!response.ok) throw new Error(body.error ?? `请求失败（${response.status}）`);
  return body;
}

export const browserApi: LeanBridgeApi = {
  getConfig: () => requestJson<ClientRuntimeConfig>("/api/config"),
  createProof: (request) => requestJson<ProofJob>("/api/proofs", {
    method: "POST",
    body: JSON.stringify(request),
  }),
  getProof: (id) => requestJson<ProofJob>(`/api/proofs/${id}`),
  reverify: (id, code) => requestJson<ProofJob>(`/api/proofs/${id}/verify`, {
    method: "POST",
    body: JSON.stringify({ code }),
  }),
};
