// Remove comments and strings before checking import commands. In particular,
// Lean block comments nest; a non-greedy regexp is not sufficient here.
function executableText(code: string): string {
  let output = "";
  let depth = 0;
  let string = false;
  for (let i = 0; i < code.length; i += 1) {
    const pair = code.slice(i, i + 2);
    if (depth > 0) {
      if (pair === "/-") { depth += 1; i += 1; }
      else if (pair === "-/") { depth -= 1; i += 1; }
      else if (code[i] === "\n") output += "\n";
      continue;
    }
    if (string) {
      if (code[i] === "\\") i += 1;
      else if (code[i] === '"') string = false;
      else if (code[i] === "\n") output += "\n";
      continue;
    }
    if (pair === "/-") { depth = 1; output += " "; i += 1; }
    else if (pair === "--") {
      while (i < code.length && code[i] !== "\n") i += 1;
      output += "\n";
    } else if (code[i] === '"') { string = true; output += " "; }
    else output += code[i];
  }
  return output;
}

export function cloudImportBudgetDiagnostic(code: string): string | undefined {
  const imports = executableText(code).matchAll(/^\s*(?:(?:public|meta)\s+)*import\s+(?:all\s+)?([^\s;]+)/gm);
  for (const match of imports) {
    const module = match[1]?.replace(/[«»]/g, "");
    if (module !== "Mathlib" && module !== "Mathlib.Tactic") continue;
    return `当前云端内存为 512 MB；import ${module} 会加载过大的库，因此未启动编译。请只导入证明所需的具体模块，保留原命题与假设。` +
      "\n例如：自然数基础证明使用 import Init；实数证明使用 import Mathlib.Data.Real.Basic；仅在需要时添加 import Mathlib.Tactic.Linarith。" +
      "\nUse a module header and focused imports, never import Mathlib or Mathlib.Tactic. Prefer an existing theorem or elementary proof over loading large tactic libraries. This is a resource diagnostic, not a Lean proof result.";
  }
  return undefined;
}
