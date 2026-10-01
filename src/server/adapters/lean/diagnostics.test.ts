import { describe, expect, it } from "vitest";
import { parseLeanOutput } from "./diagnostics";

describe("parseLeanOutput", () => {
  it("maps a multiline Lean error to its source location", () => {
    const diagnostics = parseLeanOutput("Main.lean:4:12: error: unsolved goals\n⊢ False");

    expect(diagnostics).toEqual([
      {
        line: 4,
        column: 12,
        severity: "error",
        message: "unsolved goals\n⊢ False",
      },
    ]);
  });

  it("recognizes warning and information severities", () => {
    const diagnostics = parseLeanOutput([
      "Main.lean:1:1: warning: declaration uses 'sorry'",
      "Main.lean:2:1: information: build note",
    ].join("\n"));

    expect(diagnostics.map(({ severity }) => severity)).toEqual(["warning", "info"]);
  });

  it("retains named Lean diagnostics before an ordinary error", () => {
    const diagnostics = parseLeanOutput([
      "Main.lean:4:6: error(lean.unknownIdentifier): Unknown identifier `add_comm`",
      "Main.lean:3:50: error: unsolved goals",
      "a b : ℕ",
      "⊢ a + b = b + a",
    ].join("\n"));

    expect(diagnostics).toEqual([
      { line: 4, column: 6, severity: "error", message: "Unknown identifier `add_comm`" },
      { line: 3, column: 50, severity: "error", message: "unsolved goals\na b : ℕ\n⊢ a + b = b + a" },
    ]);
  });

  it("separates named warnings from preceding multiline errors", () => {
    expect(parseLeanOutput([
      "C:\\proofs\\Main.lean:3:1: error: unsolved goals",
      "⊢ False",
      "C:\\proofs\\Main.lean:5:2: warning(linter.unusedVariables): unused variable `n`",
    ].join("\r\n"))).toEqual([
      { line: 3, column: 1, severity: "error", message: "unsolved goals\n⊢ False" },
      { line: 5, column: 2, severity: "warning", message: "unused variable `n`" },
    ]);
  });

  it("returns a general error when output has no location header", () => {
    expect(parseLeanOutput("lean process failed")).toEqual([
      { severity: "error", message: "lean process failed" },
    ]);
  });

  it("bounds the number of retained compiler diagnostics", () => {
    const output = Array.from(
      { length: 300 },
      (_, index) => `Main.lean:${index + 1}:1: error: failure ${index + 1}`,
    ).join("\n");

    expect(parseLeanOutput(output)).toHaveLength(256);
  });
});
