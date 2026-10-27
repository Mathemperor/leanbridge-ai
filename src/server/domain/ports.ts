import type { ImageTranscription, ProofRequest, Translation, VerificationResult } from "@shared/proof";

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
  transcribeImage?(source: Extract<ProofRequest, {mode:"image"}>): Promise<ImageTranscription>;
  translate(source: ProofRequest): Promise<Translation>;
  repair(context: RepairContext): Promise<Translation>;
}
