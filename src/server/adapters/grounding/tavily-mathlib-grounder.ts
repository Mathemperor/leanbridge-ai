const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const MAX_QUERY_SOURCE_CHARS = 1_850;
const MAX_CONTEXT_CHARS = 6_400;
const MAX_RESULT_CONTENT_CHARS = 1_350;
const MAX_RESULTS = 4;

const INCLUDE_DOMAINS = [
  "leanprover-community.github.io",
  "lean-lang.org",
  "github.com",
] as const;

export interface MathlibGrounder {
  ground(source: string): Promise<string>;
}

export interface TavilyMathlibGrounderConfig {
  apiKey: string;
}

interface TavilySearchResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

interface TavilySearchResponse {
  results?: unknown;
}

function allowedUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  if (url.hostname === "leanprover-community.github.io") return true;
  if (url.hostname === "lean-lang.org" || url.hostname.endsWith(".lean-lang.org")) return true;
  if (url.hostname !== "github.com") return false;

  return [
    "/leanprover-community/mathlib4",
    "/leanprover/lean4",
  ].some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
}

function compactText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function resultContext(result: TavilySearchResult): string {
  const url = typeof result.url === "string" ? result.url : "";
  if (!allowedUrl(url)) return "";

  const title = compactText(result.title, 220) || "Lean/mathlib reference";
  const content = compactText(result.content, MAX_RESULT_CONTENT_CHARS);
  if (!content) return "";
  return `[${title}] ${url}\n${content}`;
}

export class TavilyMathlibGrounder implements MathlibGrounder {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(config: TavilyMathlibGrounderConfig, fetchImpl: typeof fetch = fetch) {
    this.#apiKey = config.apiKey;
    this.#fetch = fetchImpl;
  }

  async ground(source: string): Promise<string> {
    const boundedSource = source.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_SOURCE_CHARS);
    if (!boundedSource) return "";

    const query = `Lean 4 mathlib theorem documentation for: ${boundedSource}`;
    const response = await this.#fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: MAX_RESULTS,
        include_answer: false,
        include_raw_content: false,
        include_domains: [...INCLUDE_DOMAINS],
      }),
    });

    if (!response.ok) {
      throw new Error(`Tavily search failed with status ${response.status}`);
    }

    const body = await response.json() as TavilySearchResponse;
    const results = Array.isArray(body.results) ? body.results as TavilySearchResult[] : [];
    return results
      .map(resultContext)
      .filter(Boolean)
      .join("\n\n")
      .slice(0, MAX_CONTEXT_CHARS);
  }
}
