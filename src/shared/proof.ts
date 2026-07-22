import { z } from "zod";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const imageDataUrlPattern = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

function decodedBase64Bytes(value: string): number {
  const match = imageDataUrlPattern.exec(value);
  if (!match?.[2]) return Number.POSITIVE_INFINITY;
  const base64 = match[2];
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export const imageDataUrlSchema = z
  .string()
  .regex(imageDataUrlPattern, "仅支持 PNG、JPEG 或 WebP 图片")
  .refine((value) => decodedBase64Bytes(value) <= MAX_IMAGE_BYTES, "图片不能超过 10 MiB");

const commonRequestFields = {
  projectPath: z.string().trim().max(4_096).optional(),
  autoRepair: z.boolean().default(true),
};

export const proofRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("latex"),
    latex: z.string().trim().min(1, "请输入 LaTeX 或文字证明").max(50_000),
    ...commonRequestFields,
  }),
  z.object({
    mode: z.literal("image"),
    imageDataUrl: imageDataUrlSchema,
    context: z.string().trim().max(10_000).optional(),
    ...commonRequestFields,
  }),
]);

export type ProofRequest = z.infer<typeof proofRequestSchema>;
export type ProofMode = ProofRequest["mode"];

export const translationSchema = z.object({
  normalizedSource: z.string().min(1).max(100_000),
  theoremSummary: z.string().min(1).max(20_000),
  assumptions: z.array(z.string().max(4_000)).max(64),
  imports: z.array(z.string().max(512)).max(64),
  leanCode: z.string().min(1).max(200_000),
  notes: z.array(z.string().max(4_000)).max(64),
});

export type Translation = z.infer<typeof translationSchema>;

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface LeanDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
  line?: number;
  column?: number;
}

export type VerificationStatus = "verified" | "failed" | "timeout" | "missing";

export interface VerificationResult {
  ok: boolean;
  status: VerificationStatus;
  command: string;
  durationMs: number;
  output: string;
  diagnostics: LeanDiagnostic[];
  exitCode?: number;
}

export type ProofJobStatus =
  | "queued"
  | "reading"
  | "translating"
  | "verifying"
  | "repairing"
  | "verified"
  | "failed";

export interface ProofEvent {
  at: string;
  status: ProofJobStatus;
  label: string;
  detail?: string;
}

export interface ProofAttempt {
  number: number;
  kind: "initial" | "repair" | "manual";
  translation: Translation;
  verification?: VerificationResult;
}

export interface ProofJob {
  id: string;
  mode: ProofMode;
  status: ProofJobStatus;
  createdAt: string;
  updatedAt: string;
  events: ProofEvent[];
  attempts: ProofAttempt[];
  translation?: Translation;
  verification?: VerificationResult;
  error?: string;
}

export function sanitizeLeanCode(value: string): string {
  const trimmed = value.trim();
  const code = trimmed
    .replace(/^```(?:lean4?|text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  if (/\b(?:sorry|admit)\b/.test(code)) {
    throw new Error("Generated Lean contains a proof placeholder");
  }
  if (/(?:#\s*(?:eval|reduce)\b|\b(?:axiom|by_elab|constant|elab|elab_rules|extern|foreign|include_bytes|include_str|initialize|macro|partial|run_cmd|run_tac|syntax|unsafe)\b|@\[\s*implemented_by\b)/.test(code)) {
    throw new Error("Generated Lean contains an unsafe Lean construct");
  }
  return code;
}
