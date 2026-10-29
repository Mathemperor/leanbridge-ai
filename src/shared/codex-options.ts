export const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];
export const CODEX_SPEEDS = ["standard", "fast"] as const;
export type CodexSpeed = typeof CODEX_SPEEDS[number];
export const MODEL_SERVICE_TIERS = ["default", "fast", "priority", "auto"] as const;
export type ModelServiceTier = typeof MODEL_SERVICE_TIERS[number];
export interface CodexSettings { model: string; reasoningEffort: CodexReasoningEffort; speed?: CodexSpeed }
export interface CodexModelOption { id: string; label: string; description: string; reasoningEfforts: CodexReasoningEffort[] }
export interface CodexCatalog { models: CodexModelOption[]; defaultModel: string; defaultReasoningEffort: CodexReasoningEffort; speeds?: CodexSpeed[]; defaultSpeed?: CodexSpeed }

// Public Codex subscription model metadata, checked 2026-10-24. Account access
// is still checked by Codex itself; never substitute a model or API provider.
const models: CodexModelOption[] = [
  ["gpt-6-astra", "GPT-6 Astra", "复杂推理与形式化证明"],
  ["gpt-6.1-sol", "GPT-6.1 Sol", "通用推理与代码任务"],
  ["gpt-6-sol", "GPT-6 Sol", "上一代通用模型"],
  ["gpt-6-luna", "GPT-6 Luna", "较轻量的任务"],
  ["gpt-5.6-sol", "GPT-5.6 Sol", "5.6 系列通用模型"],
  ["gpt-5.6-terra", "GPT-5.6 Terra", "5.6 系列均衡模型"],
  ["gpt-5.6-luna", "GPT-5.6 Luna", "5.6 系列轻量模型"],
].map(([id, label, description]) => ({ id: id!, label: label!, description: description!, reasoningEfforts: CODEX_REASONING_EFFORTS.filter(e => e !== "ultra" || !id!.endsWith("luna")) }));

export function resolveCodexSettings(selection: { model?: string | undefined; reasoningEffort?: string | undefined; speed?: string | undefined }, defaults = { model: "gpt-6-astra", reasoningEffort: "high" }): CodexSettings {
  const model = selection.model ?? defaults.model;
  const reasoningEffort = selection.reasoningEffort ?? defaults.reasoningEffort;
  const option = models.find(m => m.id === model);
  if (!option) throw new Error("请选择支持的 Codex 模型。");
  if (!option.reasoningEfforts.includes(reasoningEffort as CodexReasoningEffort)) throw new Error("所选模型不支持该推理强度，请重新选择。");
  if (selection.speed !== undefined && !CODEX_SPEEDS.includes(selection.speed as CodexSpeed)) throw new Error("请选择标准或快速档。");
  return { model, reasoningEffort: reasoningEffort as CodexReasoningEffort, ...(selection.speed ? {speed: selection.speed as CodexSpeed} : {}) };
}

export function codexCatalog(defaults: { model: string; reasoningEffort: string }): CodexCatalog {
  const selected = resolveCodexSettings({}, defaults);
  return { models: structuredClone(models), defaultModel: selected.model, defaultReasoningEffort: selected.reasoningEffort, speeds:[...CODEX_SPEEDS], defaultSpeed:"standard" };
}
