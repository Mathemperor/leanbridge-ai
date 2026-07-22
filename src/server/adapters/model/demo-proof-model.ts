import type { ProofRequest, Translation } from "@shared/proof";
import type { ProofModel, RepairContext } from "@server/domain/ports";

const DEMO_CODE = `import Mathlib

/-- A deterministic demonstration theorem used when no API key is configured. -/
theorem leanBridgeDemo (a b : Nat) : a + b = b + a := by
  exact Nat.add_comm a b`;

function sourceText(source: ProofRequest): string {
  if (source.mode === "latex") return source.latex;
  return `演示模式手写证明转录${source.context ? `：${source.context}` : ""}`;
}

export class DemoProofModel implements ProofModel {
  async translate(source: ProofRequest): Promise<Translation> {
    return {
      normalizedSource: sourceText(source),
      theoremSummary: "自然数加法交换律（演示输出）",
      assumptions: ["a 与 b 是自然数"],
      imports: ["Mathlib"],
      leanCode: DEMO_CODE,
      notes: ["当前为演示模式；配置 OPENAI_API_KEY 后将对真实输入进行转录和形式化。"],
    };
  }

  async repair(context: RepairContext): Promise<Translation> {
    return {
      ...context.translation,
      leanCode: DEMO_CODE,
      notes: [...context.translation.notes, "演示模式根据编译诊断生成了确定性修复。"],
    };
  }
}
