import { createHmac } from 'node:crypto';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { MetaApiError, parseUsageHeaders, type UsageInfo } from './errors.ts';

export type Provider = 'instagram_login' | 'facebook_login';

export interface GraphRequest {
  provider: Provider;
  token: string;
  path: string;
  params?: Record<string, string | number | undefined>;
  method?: 'GET' | 'POST';
  accountId?: string;
}

export interface GraphResponse<T> {
  data: T;
  usage: UsageInfo | null;
}

export type FetchLike = typeof fetch;

/**
 * Minimal Graph API client. Every call is timed, logged to api_calls (without the token),
 * and failures are raised as MetaApiError with a safety classification.
 */
export class GraphClient {
  private readonly config: Config;
  private readonly db?: Db;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  /** Observers notified of usage headers (the safety engine subscribes). */
  onUsage?: (accountId: string, usage: UsageInfo) => void;

  constructor(config: Config, db?: Db, fetchImpl: FetchLike = fetch, timeoutMs = 20_000) {
    this.config = config;
    this.db = db;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  baseUrl(provider: Provider): string {
    const base = provider === 'instagram_login' ? this.config.meta.instagramGraphBase : this.config.meta.facebookGraphBase;
    return `${base}/${this.config.meta.graphVersion}`;
  }

  async request<T = any>(req: GraphRequest): Promise<GraphResponse<T>> {
    const url = new URL(`${this.baseUrl(req.provider)}/${req.path.replace(/^\//, '')}`);
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.params ?? {})) if (v !== undefined) params[k] = String(v);
    params.access_token = req.token;
    if (req.provider === 'facebook_login' && this.config.meta.fbAppSecret) {
      params.appsecret_proof = createHmac('sha256', this.config.meta.fbAppSecret).update(req.token).digest('hex');
    }
    const method = req.method ?? 'GET';
    let body: URLSearchParams | undefined;
    if (method === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    else body = new URLSearchParams(params);

    const started = Date.now();
    let status = 0;
    let usage: UsageInfo | null = null;
    try {
      const res = await this.fetchImpl(url, { method, body, signal: AbortSignal.timeout(this.timeoutMs) });
      status = res.status;
      usage = parseUsageHeaders(res.headers);
      if (usage && req.accountId) this.onUsage?.(req.accountId, usage);
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = undefined;
      }
      if (!res.ok || json?.error || json === undefined) {
        const retryAfter = usage?.regainMinutes ? usage.regainMinutes * 60 : Number(res.headers.get('retry-after')) || undefined;
        throw new MetaApiError(status, json?.error, retryAfter, json === undefined ? `Non-JSON response (HTTP ${status})` : undefined);
      }
      this.log(req, method, status, Date.now() - started, usage);
      return { data: json as T, usage };
    } catch (err) {
      const e = err instanceof MetaApiError ? err : new MetaApiError(0, { message: `Network error: ${(err as Error).message}`, is_transient: true });
      this.log(req, method, status, Date.now() - started, usage, e);
      throw e;
    }
  }

  /** Follows `paging.next` cursors up to maxPages. */
  async paginate<T = any>(req: GraphRequest, maxPages = 5): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const { data } = await this.request<{ data: T[]; paging?: { cursors?: { after?: string }; next?: string } }>({
        ...req,
        params: { ...req.params, after },
      });
      out.push(...(data.data ?? []));
      after = data.paging?.next ? data.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }

  private log(req: GraphRequest, method: string, status: number, ms: number, usage: UsageInfo | null, err?: MetaApiError) {
    if (!this.db) return;
    try {
      this.db.run(
        'INSERT INTO api_calls (account_id, method, path, status, error_code, error_kind, duration_ms, usage_pct, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        req.accountId ?? null,
        method,
        `${req.provider === 'instagram_login' ? 'ig' : 'fb'}:/${req.path.replace(/^\//, '')}`,
        status,
        err?.code ?? null,
        err?.kind ?? null,
        ms,
        usage?.maxPct ?? null,
        Date.now(),
      );
    } catch {
      /* monitoring must never break a request */
    }
  }
}
