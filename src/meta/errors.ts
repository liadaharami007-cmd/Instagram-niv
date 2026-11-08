/**
 * Classification of Meta Graph API failures into actionable kinds.
 * The safety engine uses the kind to decide: retry, back off, pause the account,
 * or require the user to reconnect. Codes per Meta's Graph API error reference.
 */
export type MetaErrorKind =
  | 'token_invalid'
  | 'permission'
  | 'rate_limit'
  | 'policy_block'
  | 'transient'
  | 'invalid_request';

export interface MetaErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
}

const TOKEN_CODES = new Set([102, 190, 2500]);
const TOKEN_SUBCODES = new Set([458, 459, 460, 463, 464, 467, 492]);
const RATE_CODES = new Set([4, 9, 17, 32, 341, 613]);
const POLICY_CODES = new Set([368]);
const POLICY_SUBCODES = new Set([2207050, 2207051]);

export function classifyMetaError(httpStatus: number, body: MetaErrorBody | undefined): MetaErrorKind {
  const code = body?.code ?? -1;
  const sub = body?.error_subcode ?? -1;
  if (TOKEN_CODES.has(code) || TOKEN_SUBCODES.has(sub)) return 'token_invalid';
  if (POLICY_CODES.has(code) || POLICY_SUBCODES.has(sub)) return 'policy_block';
  if (RATE_CODES.has(code) || (code >= 80000 && code <= 80014) || httpStatus === 429) return 'rate_limit';
  if (code === 10 || code === 3 || (code >= 200 && code <= 299)) return 'permission';
  if (code === 1 || code === 2 || body?.is_transient || httpStatus >= 500 || httpStatus === 0) return 'transient';
  return 'invalid_request';
}

const KIND_HE: Record<MetaErrorKind, string> = {
  token_invalid: 'ההרשאה לחשבון פגה או בוטלה — יש לחבר מחדש את החשבון',
  permission: 'חסרה הרשאה של Meta לפעולה זו',
  rate_limit: 'הגעת למגבלת הקריאות של Meta — הפעולות הושהו זמנית',
  policy_block: 'Meta חסמה זמנית פעולות בחשבון — כל המשימות הושהו',
  transient: 'תקלה זמנית בשרתי Meta — ננסה שוב אוטומטית',
  invalid_request: 'הבקשה נדחתה על ידי Meta',
};

export class MetaApiError extends Error {
  readonly kind: MetaErrorKind;
  readonly httpStatus: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly fbtraceId?: string;
  /** Seconds Meta suggested waiting before retrying (from usage headers), if any. */
  readonly retryAfterSec?: number;

  constructor(httpStatus: number, body: MetaErrorBody | undefined, retryAfterSec?: number, fallbackMessage?: string) {
    const kind = classifyMetaError(httpStatus, body);
    super(body?.message ?? fallbackMessage ?? `Meta API error (HTTP ${httpStatus})`);
    this.name = 'MetaApiError';
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.code = body?.code;
    this.subcode = body?.error_subcode;
    this.fbtraceId = body?.fbtrace_id;
    this.retryAfterSec = retryAfterSec;
  }

  get userMessage(): string {
    return KIND_HE[this.kind];
  }

  toJSON() {
    return { kind: this.kind, message: this.message, code: this.code, subcode: this.subcode, httpStatus: this.httpStatus, fbtraceId: this.fbtraceId };
  }
}

export interface UsageInfo {
  /** Highest utilisation percentage across app-level and business-use-case headers. */
  maxPct: number;
  /** Minutes until access is regained, if Meta reported throttling. */
  regainMinutes: number;
  raw: Record<string, unknown>;
}

/** Parses X-App-Usage / X-Business-Use-Case-Usage headers. */
export function parseUsageHeaders(headers: Headers): UsageInfo | null {
  const raw: Record<string, unknown> = {};
  let maxPct = 0;
  let regainMinutes = 0;
  const take = (o: any) => {
    for (const k of ['call_count', 'total_cputime', 'total_time']) {
      const v = Number(o?.[k]);
      if (Number.isFinite(v)) maxPct = Math.max(maxPct, v);
    }
    const r = Number(o?.estimated_time_to_regain_access);
    if (Number.isFinite(r)) regainMinutes = Math.max(regainMinutes, r);
  };
  for (const h of ['x-app-usage', 'x-business-use-case-usage', 'x-ig-usage']) {
    const v = headers.get(h);
    if (!v) continue;
    try {
      const parsed = JSON.parse(v);
      raw[h] = parsed;
      if (h === 'x-business-use-case-usage') {
        for (const arr of Object.values(parsed)) for (const o of arr as any[]) take(o);
      } else take(parsed);
    } catch {
      /* malformed header — ignore */
    }
  }
  return Object.keys(raw).length ? { maxPct, regainMinutes, raw } : null;
}
