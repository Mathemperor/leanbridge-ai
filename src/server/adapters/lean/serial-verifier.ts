import type { VerificationResult } from "@shared/proof";
import type { LeanVerifier, VerifyOptions } from "@server/domain/ports";

export interface SerialLeanVerifierOptions {
  maxPending?: number;
}

export class SerialLeanVerifier implements LeanVerifier {
  readonly #inner: LeanVerifier;
  readonly #maxPending: number;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(inner: LeanVerifier, options: SerialLeanVerifierOptions = {}) {
    this.#inner = inner;
    this.#maxPending = options.maxPending ?? 8;
  }

  verify(code: string, options: VerifyOptions): Promise<VerificationResult> {
    if (this.#pending >= this.#maxPending) {
      return Promise.reject(new Error("Lean verification queue is full"));
    }

    this.#pending += 1;
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = started + timeoutMs;
    const run = this.#tail.then(() => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return {
          ok: false,
          status: "timeout",
          command: "queued Lean verification",
          durationMs: Date.now() - started,
          output: `Lean verification timed out after ${timeoutMs} ms while waiting in the queue.`,
          diagnostics: [],
        } satisfies VerificationResult;
      }
      return this.#inner.verify(code, { ...options, timeoutMs: remainingMs });
    });
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.#pending -= 1;
    });
  }
}
