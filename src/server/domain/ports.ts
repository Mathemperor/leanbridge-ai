import type { ProofRequest, Translation, VerificationResult } from "@shared/proof";

export interface VerifyOptions {
  projectPath?: string;
  leanCommand?: string;
  lakeCommand?: string;
  timeoutMs?: number;
}

export interface LeanVerifier {
  verify(code: string, options: VerifyOptions): Promise<VerificationResult>;
}

export interface RepairContext {
  source: ProofRequest;
  translation: Translation;
  diagnostics: string;
}

export interface ProofModel {
  translate(source: ProofRequest): Promise<Translation>;
  repair(context: RepairContext): Promise<Translation>;
}
