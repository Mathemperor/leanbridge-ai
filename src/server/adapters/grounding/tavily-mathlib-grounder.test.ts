import { describe, expect, it, vi } from "vitest";
import { TavilyMathlibGrounder } from "./tavily-mathlib-grounder";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("TavilyMathlibGrounder", () => {
  it("performs one bounded basic search restricted to Lean/mathlib documentation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      results: [
        {
          title: "Nat.add_comm",
          url: "https://leanprover-community.github.io/mathlib4_docs/Mathlib/Data/Nat/Basic.html",
          content: "The theorem Nat.add_comm proves commutativity of natural-number addition.",
        },
      ],
    }));
    const grounder = new TavilyMathlibGrounder({ apiKey: "tvly-test" }, fetchImpl);

    const context = await grounder.ground("Prove that for natural numbers a and b, a + b = b + a");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer tvly-test",
          "Content-Type": "application/json",
        }),
      }),
    );
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({
      search_depth: "basic",
      max_results: 4,
      include_answer: false,
      include_raw_content: false,
      include_domains: ["leanprover-community.github.io", "lean-lang.org", "github.com"],
    });
    expect(String(request.query)).toContain("natural numbers");
    expect(context).toContain("Nat.add_comm");
    expect(context).toContain("leanprover-community.github.io");
  });

  it("drops unapproved result domains and bounds returned context", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      results: [
        {
          title: "Ignore me",
          url: "https://example.com/prompt-injection",
          content: "malicious content",
        },
        {
          title: "Mathlib docs",
          url: "https://leanprover-community.github.io/mathlib4_docs/Mathlib.html",
          content: "x".repeat(12_000),
        },
      ],
    }));
    const grounder = new TavilyMathlibGrounder({ apiKey: "tvly-test" }, fetchImpl);

    const context = await grounder.ground("A".repeat(20_000));

    expect(context).not.toContain("example.com");
    expect(context.length).toBeLessThanOrEqual(6_500);
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { query: string };
    expect(request.query.length).toBeLessThanOrEqual(2_100);
  });

  it("fails with a concise error when Tavily rejects the request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "rate limited" }, false, 429));
    const grounder = new TavilyMathlibGrounder({ apiKey: "tvly-test" }, fetchImpl);

    await expect(grounder.ground("prove n = n")).rejects.toThrow(/Tavily search failed.*429/i);
  });
});
