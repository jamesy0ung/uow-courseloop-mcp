export const BASE_URL = "https://courses.uow.edu.au";
const SITE_ID = "uow-prod-pres";
const USER_AGENT = "uow-courseloop-mcp/1.0 (handbook lookup MCP server)";

export type PageKind = "courses" | "subjects" | "aos";

export interface FetchResult {
  status: number;
  body: string;
}
export type Fetcher = (url: string, init?: { method: "POST"; body: string }) => Promise<FetchResult>;

export class NotFoundError extends Error {}
export class RateLimitedError extends Error {}

export interface SearchHit {
  title: string;
  code: string;
  uri: string;
  score: number;
  contentTypeLabel: string;
  studyLevel?: string;
  locationDisplay?: string;
  isSuspendedOrDiscontinued?: string;
}

/** One facet of the handbook's search page, e.g. {filterField: "teachingPeriod", filterValue: ["autumn"]}. */
export interface SearchFilter {
  filterField: string;
  filterValue: string[];
  isExactMatch: boolean;
}

export type ContentType = "course" | "subject" | "aos";

export interface Page {
  url: string;
  content: any;
}

const defaultFetcher: Fetcher = async (url, init) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: init?.method ?? "GET",
        body: init?.body,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/json",
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status >= 500 && attempt === 0) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        continue;
      }
      return { status: res.status, body: await res.text() };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
};

export function extractNextData(html: string): any {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Page did not contain __NEXT_DATA__; the site layout may have changed");
  return JSON.parse(m[1]);
}

/**
 * courses.uow.edu.au sits behind CloudFront, which blocks clients (HTTP 403) that send a few
 * hundred requests in under a minute. All network requests go through this throttle.
 */
class Throttle {
  private active = 0;
  private nextStart = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private maxConcurrent: number,
    private minIntervalMs: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // A released slot is handed directly to the next waiter (active is not decremented), so a
    // caller arriving between release and the waiter resuming cannot take the slot as well.
    if (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    const now = Date.now();
    const start = Math.max(now, this.nextStart);
    this.nextStart = start + this.minIntervalMs;
    if (start > now) await new Promise((r) => setTimeout(r, start - now));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const envNumber = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== "" ? n : fallback;
};

export class HandbookClient {
  private cache = new Map<string, { expires: number; value: Promise<FetchResult> }>();
  private fetcher: Fetcher;
  private ttlMs: number;
  private throttle: Throttle;

  constructor(opts: { fetcher?: Fetcher; ttlMs?: number; minIntervalMs?: number; maxConcurrent?: number } = {}) {
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
    // Fixture fetchers in tests don't touch the network, so they skip the throttle by default.
    const live = !opts.fetcher;
    this.throttle = new Throttle(
      opts.maxConcurrent ?? envNumber("UOW_MAX_CONCURRENT", 2),
      opts.minIntervalMs ?? (live ? envNumber("UOW_MIN_INTERVAL_MS", 750) : 0),
    );
  }

  /**
   * Cached, throttled GET (or POST when a body is given) with in-flight de-duplication.
   * Errors and blocked responses are not cached.
   */
  private get(url: string, body?: string): Promise<FetchResult> {
    const key = body ? `${url}\n${body}` : url;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value;
    const value = this.throttle.run(() => this.fetcher(url, body ? { method: "POST", body } : undefined)).then((r) => {
      if (r.status === 403 || r.status === 429) {
        throw new RateLimitedError(
          `courses.uow.edu.au refused the request (HTTP ${r.status}); its CloudFront firewall rate-limits bursts of requests. Wait a few minutes and try again.`,
        );
      }
      return r;
    });
    this.cache.set(key, { expires: now + this.ttlMs, value });
    value.then(
      (r) => {
        if (r.status >= 500) this.cache.delete(key);
      },
      () => this.cache.delete(key),
    );
    return value;
  }

  pageUrl(kind: PageKind, year: number, code: string, offering?: string): string {
    const url = new URL(`${BASE_URL}/${kind}/${year}/${encodeURIComponent(code)}`);
    url.searchParams.set("year", String(year));
    if (offering) url.searchParams.set("offering", offering);
    return url.toString();
  }

  async getPage(kind: PageKind, year: number, code: string, offering?: string): Promise<Page> {
    const url = this.pageUrl(kind, year, code, offering);
    const res = await this.get(url);
    if (res.status === 404) throw new NotFoundError(`No ${kindLabel(kind)} "${code}" found for ${year}`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const content = extractNextData(res.body)?.props?.pageProps?.pageContent;
    if (!content?.code) throw new NotFoundError(`No ${kindLabel(kind)} "${code}" found for ${year}`);
    return { url: this.pageUrl(kind, year, code, offering), content };
  }

  async search(query: string, year: number | "current", size = 20, from = 0): Promise<{ total: number; results: SearchHit[] }> {
    const url = new URL(`${BASE_URL}/api/search/search-all`);
    url.searchParams.set("from", String(from));
    url.searchParams.set("query", query);
    url.searchParams.set("searchType", "advanced");
    url.searchParams.set("siteId", SITE_ID);
    url.searchParams.set("siteYear", String(year));
    url.searchParams.set("size", String(size));
    const res = await this.get(url.toString());
    if (res.status !== 200) throw new Error(`Search failed: HTTP ${res.status}`);
    const data = JSON.parse(res.body)?.data ?? {};
    return { total: data.total ?? 0, results: data.results ?? [] };
  }

  /** The faceted search behind the site's Courses / Majors / Subjects tabs. size is capped at 100 by the API. */
  async searchItems(opts: {
    query: string;
    contenttype: ContentType;
    filters: SearchFilter[];
    from?: number;
    size?: number;
  }): Promise<{ total: number; results: SearchHit[] }> {
    const body = JSON.stringify({
      siteId: SITE_ID,
      query: opts.query,
      contenttype: opts.contenttype,
      searchFilters: opts.filters,
      from: opts.from ?? 0,
      size: Math.min(opts.size ?? 20, 100),
    });
    const res = await this.get(`${BASE_URL}/api/search/search-academic-items`, body);
    if (res.status !== 200) throw new Error(`Search failed: HTTP ${res.status} ${res.body.slice(0, 200)}`);
    const data = JSON.parse(res.body)?.data ?? {};
    return { total: data.total ?? 0, results: data.results ?? [] };
  }

  /** The search page's filter configuration (field names and the allowed values for each facet). */
  async searchConfig(): Promise<any> {
    const res = await this.get(`${BASE_URL}/search`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status} fetching the search page`);
    const config = extractNextData(res.body)?.props?.pageProps?.pageConfig?.[0]?.sections?.search?.[0];
    if (!config?.sub_modules) throw new Error("The search page has no filter configuration; the site layout may have changed");
    return config;
  }
}

function kindLabel(kind: PageKind): string {
  return kind === "courses" ? "course" : kind === "subjects" ? "subject" : "major/minor";
}
