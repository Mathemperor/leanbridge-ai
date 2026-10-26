import { randomUUID } from "node:crypto";
import type { LeanDiagnostic, VerificationResult } from "@shared/proof";
import type { LeanVerifier, VerifyOptions } from "@server/domain/ports";

export const LEANWEB_PROJECT = "mathlib-v4.24.0";
export const LEANWEB_URL = "https://live.lean-lang.org";
const ENDPOINT = `wss://live.lean-lang.org/websocket/${LEANWEB_PROJECT}`;
const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Uses the same LSP transport as the official editor. No credentials are sent. */
export class LeanWebVerifier implements LeanVerifier {
  constructor(private readonly endpoint = ENDPOINT) {}

  verify(code: string, options: VerifyOptions = {}): Promise<VerificationResult> {
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? 120_000;
    const uri = `file:///${LEANWEB_PROJECT}/LeanBridge${randomUUID().replaceAll("-", "")}.lean`;
    return new Promise((resolve) => {
      let socket: WebSocket | undefined;
      let opened = false;
      let finished = false;
      let phase: "initialize" | "diagnostics" = "initialize";
      let latest: LeanDiagnostic[] | undefined;
      const send = (message: object) => socket?.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
      const finish = (status: VerificationResult["status"], output: string, diagnostics: LeanDiagnostic[] = []) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // Closing the socket also disposes LeanWeb's per-connection Lean process.
        try {
          if (socket?.readyState === WebSocket.OPEN && opened) {
            send({ method: "textDocument/didClose", params: { textDocument: { uri } } });
          }
          socket?.close();
        } catch { /* A disconnected socket is already disposed. */ }
        resolve({ ok: status === "verified", status, command: `LeanWeb ${LEANWEB_PROJECT} (${LEANWEB_URL})`, durationMs: Date.now() - started, output, diagnostics });
      };
      const unavailable = () => finish("missing", "LeanWeb 未完成验证，连接中断或返回了无效结果。请稍后重试，或在官方编辑器打开代码。");
      const timer = setTimeout(() => finish("timeout", `LeanWeb verification timed out after ${timeoutMs} ms. 未取得最终验证结果。`), timeoutMs);
      try {
        socket = new WebSocket(this.endpoint);
        socket.addEventListener("open", () => {
          if (finished) { socket?.close(); return; }
          send({ id: 1, method: "initialize", params: {
            processId: null, clientInfo: { name: "LeanBridge", version: "0.1" },
            rootUri: `file:///${LEANWEB_PROJECT}`,
            capabilities: { textDocument: { publishDiagnostics: { versionSupport: true } } },
            initializationOptions: { hasWidgets: false },
          } });
        });
        socket.addEventListener("error", unavailable);
        socket.addEventListener("close", unavailable);
        socket.addEventListener("message", (event) => {
          if (finished) return;
          try {
            if (typeof event.data !== "string" || Buffer.byteLength(event.data) > MAX_MESSAGE_BYTES) { unavailable(); return; }
            const message = JSON.parse(event.data);
            if (!message || message.jsonrpc !== "2.0") { unavailable(); return; }
            if (message.id === 1 && phase === "initialize" && !message.method) {
              if (message.error || !message.result?.capabilities) { unavailable(); return; }
              phase = "diagnostics";
              send({ method: "initialized", params: {} });
              send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "lean4", version: 1, text: code } } });
              opened = true;
              // Lean's documented barrier waits until all diagnostics for this
              // document version are emitted. Empty early notifications are not success.
              send({ id: 2, method: "textDocument/waitForDiagnostics", params: { uri, version: 1 } });
            } else if (message.method === "textDocument/publishDiagnostics") {
              const params = message.params;
              if (params?.uri !== uri || params.version !== 1) return;
              if (!Array.isArray(params.diagnostics) || params.diagnostics.length > 2000) { unavailable(); return; }
              latest = params.diagnostics.map((diagnostic: { severity?: number; message?: unknown; range?: { start?: { line?: number; character?: number } } }): LeanDiagnostic => {
                if (typeof diagnostic.message !== "string" || ![1, 2, 3, 4].includes(diagnostic.severity ?? 1)) throw new Error("Invalid diagnostic");
                const position = diagnostic.range?.start;
                return {
                  severity: diagnostic.severity === 2 ? "warning" : (diagnostic.severity ?? 1) === 1 ? "error" : "info",
                  message: diagnostic.message,
                  ...(typeof position?.line === "number" ? { line: position.line + 1 } : {}),
                  ...(typeof position?.character === "number" ? { column: position.character + 1 } : {}),
                };
              });
            } else if (message.id === 2 && phase === "diagnostics" && !message.method) {
              if (message.error || !message.result || latest === undefined) { unavailable(); return; }
              const failed = latest.some((d) => d.severity === "error" || /\b(?:sorry|sorryAx|admit)\b/i.test(d.message));
              const output = latest.map((d) => `${d.line ?? 1}:${d.column ?? 1}: ${d.severity}: ${d.message}`).join("\n");
              finish(failed ? "failed" : "verified", output || `LeanWeb (${LEANWEB_PROJECT}) 已完成真实 Lean 验证，未发现错误。`, latest);
            } else if (message.id !== undefined && message.method) {
              send({ id: message.id, error: { code: -32601, message: "Method not supported" } });
            }
          } catch { unavailable(); }
        });
      } catch { unavailable(); }
    });
  }
}
