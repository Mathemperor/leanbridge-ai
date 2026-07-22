import type { VerificationResult } from "@shared/proof";
import type { LeanVerifier } from "@server/domain/ports";

export class DemoLeanVerifier implements LeanVerifier {
  async verify(): Promise<VerificationResult> {
    return {
      ok: true,
      status: "verified",
      command: "demo lean Main.lean",
      durationMs: 12,
      output: "Lean verification succeeded in demonstration mode.",
      diagnostics: [],
      exitCode: 0,
    };
  }
}
