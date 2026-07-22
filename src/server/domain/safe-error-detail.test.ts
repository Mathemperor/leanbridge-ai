import { describe, expect, it } from "vitest";
import { safeProviderErrorDetail } from "./safe-error-detail";

describe("safeProviderErrorDetail", () => {
  it("preserves provider metadata while redacting credentials", () => {
    const error = Object.assign(
      new Error("Incorrect API key sk-proj-super-secret; Authorization: Bearer backend-secret"),
      { status: 401, code: "invalid_api_key", type: "invalid_request_error" },
    );

    const detail = safeProviderErrorDetail(error);

    expect(detail).toMatch(/status=401/);
    expect(detail).toMatch(/code=invalid_api_key/);
    expect(detail).toMatch(/type=invalid_request_error/);
    expect(detail).toContain("sk-[redacted]");
    expect(detail).toContain("Bearer [redacted]");
    expect(detail).not.toMatch(/super-secret|backend-secret/);
  });

  it("bounds provider error details", () => {
    expect(safeProviderErrorDetail(Object.assign(new Error("x".repeat(2_000)), { status: 500 })).length)
      .toBeLessThanOrEqual(512);
  });

  it("does not expose an unclassified plain error message", () => {
    expect(safeProviderErrorDetail(new Error("provider secret details"))).toBe("");
  });
});
