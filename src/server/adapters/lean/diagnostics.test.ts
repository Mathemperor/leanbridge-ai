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
