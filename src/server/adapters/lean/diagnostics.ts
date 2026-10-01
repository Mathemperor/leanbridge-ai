import type { DiagnosticSeverity, LeanDiagnostic } from "@shared/proof";

const headerPattern = /^.*?:(\d+):(\d+):\s*(error|warning|information|info)(?:\([^\r\n)]*\))?:\s*(.*)$/i;
const MAX_DIAGNOSTICS = 256;

function severityOf(value: string): DiagnosticSeverity {
  if (value.toLowerCase() === "warning") return "warning";
  if (["information", "info"].includes(value.toLowerCase())) return "info";
  return "error";
}

export function parseLeanOutput(output: string): LeanDiagnostic[] {
  const normalized = output.trim();
  if (!normalized) return [];

  const diagnostics: LeanDiagnostic[] = [];
  let current: LeanDiagnostic | undefined;

  for (const line of normalized.split(/\r?\n/)) {
    const match = headerPattern.exec(line);
    if (match?.[1] && match[2] && match[3]) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) {
        current = undefined;
        continue;
      }
      current = {
        line: Number(match[1]),
        column: Number(match[2]),
        severity: severityOf(match[3]),
        message: match[4] ?? "",
      };
      diagnostics.push(current);
      continue;
    }

    if (current) {
      current.message = `${current.message}\n${line}`.trim();
    }
  }

  return diagnostics.length > 0
    ? diagnostics
    : [{ severity: "error", message: normalized }];
}
