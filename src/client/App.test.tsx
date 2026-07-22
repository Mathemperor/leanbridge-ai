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
      lean: { mode: leanMode, projectConfigured: leanMode !== "demo" },
    }),
    createProof: vi.fn().mockResolvedValue(queued),
    getProof: vi.fn().mockResolvedValue(verified),
    reverify: vi.fn().mockResolvedValue(verified),
  };
}

describe("LeanBridge workbench", () => {
  it("renders a proof-focused source, editor, and verification layout", async () => {
    render(<App api={fakeApi()} pollIntervalMs={0} />);

    expect(screen.getByRole("heading", { name: "把证明交给 Lean，而不是交给运气。" })).toBeInTheDocument();
    expect(screen.getByLabelText("LaTeX 证明")).toBeInTheDocument();
    expect(screen.getByLabelText("Lean 4 代码")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "验证轨迹" })).toBeInTheDocument();
    expect(await screen.findByText("演示模式")).toBeInTheDocument();
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

    expect(await screen.findByText("云端 Lean 已就绪")).toBeInTheDocument();
    expect(screen.getByText("云端使用固定的 Lean 4 / mathlib 环境")).toBeInTheDocument();
    expect(screen.queryByLabelText("Lean / mathlib 工程路径")).not.toBeInTheDocument();
  });
});
