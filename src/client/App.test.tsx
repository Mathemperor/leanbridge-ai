// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProofJob } from "@shared/proof";
import type { LeanBridgeApi } from "./api";
import { App } from "./App";

const queued: ProofJob = {
  id: "job-1",
  mode: "latex",
  status: "queued",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  events: [{ at: "2026-07-18T00:00:00.000Z", status: "queued", label: "任务已进入队列" }],
  attempts: [],
};

const verified: ProofJob = {
  ...queued,
  status: "verified",
  updatedAt: "2026-07-18T00:00:01.000Z",
  translation: {
    normalizedSource: "Truth is true.",
    theoremSummary: "真命题的引入",
    assumptions: [],
    imports: ["Mathlib"],
    leanCode: "import Mathlib\ntheorem truth : True := by trivial",
    notes: [],
  },
  verification: {
    ok: true,
    status: "verified",
    command: "lake env lean Main.lean",
    durationMs: 14,
    output: "Lean verification succeeded.",
    diagnostics: [],
    exitCode: 0,
  },
  attempts: [],
  events: [...queued.events, { at: "2026-07-18T00:00:01.000Z", status: "verified", label: "Lean 验证通过" }],
};

function fakeApi(leanMode: "demo" | "local" | "cloud" = "demo"): LeanBridgeApi {
  return {
    getConfig: vi.fn().mockResolvedValue({
      provider: leanMode === "demo" ? "demo" : "openai",
      model: "gpt-5.6",
      reasoningEffort: "high",
      maxRepairAttempts: 3,
      grounding: { tavily: false },
      lean: { mode: leanMode, projectConfigured: leanMode !== "demo" },
    }),
    createProof: vi.fn().mockResolvedValue(queued),
    getProof: vi.fn().mockResolvedValue(verified),
    reverify: vi.fn().mockResolvedValue(verified),
  };
}

describe("LeanBridge workbench", () => {
  it("recovers from a transient polling failure", async () => {
    const api = fakeApi();
    vi.mocked(api.getProof).mockRejectedValueOnce(new Error("temporary network failure"));
    const user = userEvent.setup();
    render(<App api={api} pollIntervalMs={0} />);
    await user.type(screen.getByLabelText("LaTeX 证明"), "Truth");
    await user.click(screen.getByRole("button", { name: "生成并验证" }));
    expect(await screen.findByText("Lean 验证通过")).toBeInTheDocument();
    expect(api.getProof).toHaveBeenCalledTimes(2);
  });

  it("preserves a manually edited proof when a new submission fails", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<App api={api} pollIntervalMs={0} />);
    await user.type(screen.getByLabelText("LaTeX 证明"), "Truth");
    await user.click(screen.getByRole("button", { name: "生成并验证" }));
    await screen.findByText("Lean 验证通过");
    fireEvent.change(screen.getByLabelText("Lean 4 代码"), { target: { value: "theorem keep_me : True := by trivial" } });
    vi.mocked(api.createProof).mockRejectedValueOnce(new Error("Server busy"));
    await user.click(screen.getByRole("button", { name: "生成并验证" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server busy");
    expect(screen.getByLabelText("Lean 4 代码")).toHaveValue("theorem keep_me : True := by trivial");
  });

  it("waits for capabilities before allowing image input", () => {
    const api = fakeApi();
    vi.mocked(api.getConfig).mockReturnValue(new Promise(() => {}));
    render(<App api={api} />);
    expect(screen.getByRole("tab", { name: "手写图片" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "生成并验证" })).toBeDisabled();
  });

  it("pauses after three polling failures and lets the user reconnect", async () => {
    const api = fakeApi();
    vi.mocked(api.getProof).mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<App api={api} pollIntervalMs={0} />);
    await user.type(screen.getByLabelText("LaTeX 证明"), "Truth");
    await user.click(screen.getByRole("button", { name: "生成并验证" }));
    const retry = await screen.findByRole("button", { name: "重新连接任务" });
    expect(api.getProof).toHaveBeenCalledTimes(3);
    vi.mocked(api.getProof).mockResolvedValue(verified);
    await user.click(retry);
    expect(await screen.findByText("Lean 验证通过")).toBeInTheDocument();
  });
  it("renders a proof-focused source, editor, and verification layout", async () => {
    render(<App api={fakeApi()} pollIntervalMs={0} />);

    expect(screen.getByRole("heading", { name: "把证明交给 Lean，而不是交给运气。" })).toBeInTheDocument();
    expect(screen.getByLabelText("LaTeX 证明")).toBeInTheDocument();
    expect(screen.getByLabelText("Lean 4 代码")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "验证轨迹" })).toBeInTheDocument();
    expect(await screen.findByText("演示模式")).toBeInTheDocument();
  });

  it("identifies the Nebius Nemotron runtime in the product UI", async () => {
    const api = fakeApi("cloud");
    api.getConfig = vi.fn().mockResolvedValue({
      provider: "nebius",
      model: "nvidia/nemotron-3-super-120b-a12b",
      reasoningEffort: "high",
      maxRepairAttempts: 3,
      grounding: { tavily: false },
      lean: { mode: "cloud", projectConfigured: true },
    });

    render(<App api={api} pollIntervalMs={0} />);

    expect(await screen.findByText("Nebius · NVIDIA Nemotron")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "手写图片" })).toBeDisabled();
    expect(screen.getByText("Nemotron 生成 · Lean 验证 · 诊断驱动修复")).toBeInTheDocument();
  });

  it("shows Tavily mathlib grounding when the bonus integration is active", async () => {
    const api = fakeApi("cloud");
    api.getConfig = vi.fn().mockResolvedValue({
      provider: "nebius",
      model: "nvidia/nemotron-3-super-120b-a12b",
      reasoningEffort: "high",
      maxRepairAttempts: 3,
      grounding: { tavily: true },
      lean: { mode: "cloud", projectConfigured: true },
    });

    render(<App api={api} pollIntervalMs={0} />);

    expect(await screen.findByText("Tavily mathlib grounding")).toBeInTheDocument();
  });

  it("submits LaTeX and displays verified Lean", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<App api={api} pollIntervalMs={0} />);

    await user.type(screen.getByLabelText("LaTeX 证明"), "Prove that True holds.");
    await user.click(screen.getByRole("button", { name: "生成并验证" }));

    expect(await screen.findByText("Lean 验证通过")).toBeInTheDocument();
    await waitFor(() => {
      expect((screen.getByLabelText("Lean 4 代码") as HTMLTextAreaElement).value).toContain("theorem truth");
    });
    expect(api.createProof).toHaveBeenCalledWith(expect.objectContaining({
      mode: "latex",
      latex: "Prove that True holds.",
    }));
  });

  it("switches to handwriting input and rejects unsupported files", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<App api={fakeApi()} pollIntervalMs={0} />);

    await user.click(screen.getByRole("tab", { name: "手写图片" }));
    const input = screen.getByLabelText("上传手写证明图片");
    await user.upload(input, new File(["<svg />"], "proof.svg", { type: "image/svg+xml" }));

    expect(await screen.findByText("仅支持 PNG、JPEG 或 WebP 图片")).toBeInTheDocument();
  });

  it("re-verifies manually edited Lean", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<App api={api} pollIntervalMs={0} />);
    await user.type(screen.getByLabelText("LaTeX 证明"), "Truth");
    await user.click(screen.getByRole("button", { name: "生成并验证" }));
    await screen.findByText("Lean 验证通过");

    const editor = screen.getByLabelText("Lean 4 代码");
    fireEvent.change(editor, { target: { value: "theorem manual : True := by trivial" } });
    await user.click(screen.getByRole("button", { name: "重新验证" }));

    await waitFor(() => expect(api.reverify).toHaveBeenCalledWith("job-1", "theorem manual : True := by trivial"));
  });

  it("uses the fixed Lean project and hides path controls in cloud mode", async () => {
    render(<App api={fakeApi("cloud")} pollIntervalMs={0} />);

    expect(await screen.findByText("云端 Lean 环境已配置")).toBeInTheDocument();
    expect(screen.getByText("云端使用固定的 Lean 4 / mathlib 环境")).toBeInTheDocument();
    expect(screen.queryByLabelText("Lean / mathlib 工程路径")).not.toBeInTheDocument();
  });
});
