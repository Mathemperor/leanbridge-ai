import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { LeanWebVerifier } from "./leanweb-verifier";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(onWait: (socket: ServerSocket, uri: string) => void) {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("No test address");
  server.on("connection", (socket) => {
    let uri = "";
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } }));
      }
      if (message.method === "textDocument/didOpen") uri = message.params.textDocument.uri;
      if (message.method === "textDocument/waitForDiagnostics") onWait(socket, uri);
    });
  });
  return new LeanWebVerifier(`ws://127.0.0.1:${address.port}`);
}
function diagnostics(socket: ServerSocket, uri: string, items: unknown[] = [], version = 1) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: items } }));
}
function complete(socket: ServerSocket) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }));
}
const error = { severity: 1, message: "Tactic rfl failed", range: { start: { line: 3, character: 2 } } };

describe("LeanWeb verification protocol", () => {
  it("waits for the completion barrier, even after empty diagnostics", async () => {
    let release!: () => void;
    let waiting!: () => void;
    const reached = new Promise<void>((resolve) => { waiting = resolve; });
    const verifier = await fixture((socket, uri) => {
      diagnostics(socket, uri);
      release = () => { diagnostics(socket, uri, [error]); complete(socket); };
      waiting();
    });
    let settled = false;
    const result = verifier.verify("example : (1 : Nat) = 2 := by rfl", { timeoutMs: 1000 }).then((r) => { settled = true; return r; });
    await reached;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    expect(await result).toMatchObject({ ok: false, status: "failed", diagnostics: [{ severity: "error", line: 4, column: 3 }] });
  });

  it("accepts completed matching diagnostics and ignores other documents/versions", async () => {
    const verifier = await fixture((socket, uri) => {
      diagnostics(socket, uri, [error], 0);
      diagnostics(socket, `${uri}.other`, [error]);
      diagnostics(socket, uri);
      complete(socket);
    });
    expect(await verifier.verify("import Mathlib\nexample : True := by trivial", {})).toMatchObject({ ok: true, status: "verified" });
  });

  it("rejects sorry reported as a Lean warning", async () => {
    const verifier = await fixture((socket, uri) => {
      diagnostics(socket, uri, [{ severity: 2, message: "declaration uses 'sorry'" }]);
      complete(socket);
    });
    expect(await verifier.verify("example : True := by trivial", {})).toMatchObject({ ok: false, status: "failed" });
  });

  it("never accepts a completion response without matching diagnostics", async () => {
    const verifier = await fixture((socket, uri) => { diagnostics(socket, uri, [], 0); complete(socket); });
    expect(await verifier.verify("example : True := by trivial", {})).toMatchObject({ ok: false, status: "missing" });
  });

  it("fails closed when the server disconnects", async () => {
    const verifier = await fixture((socket, uri) => { diagnostics(socket, uri); socket.close(); });
    expect(await verifier.verify("example : True := by trivial", {})).toMatchObject({ ok: false, status: "missing" });
  });

  it("times out and releases the connection", async () => {
    const verifier = await fixture(() => {});
    expect(await verifier.verify("example : True := by trivial", { timeoutMs: 80 })).toMatchObject({ ok: false, status: "timeout" });
  });

  it.each(["not-json", JSON.stringify({ jsonrpc: "2.0", id: 2, error: { message: "worker failed" } })])("fails closed on invalid protocol or server errors", async (data) => {
    const verifier = await fixture((socket) => socket.send(data));
    expect(await verifier.verify("example : True := by trivial", {})).toMatchObject({ ok: false, status: "missing" });
  });
});
