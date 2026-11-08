/**
 * TEST-ONLY stand-in for Meta's Graph API. It mirrors the real response shapes and error
 * envelopes so the full pipeline (client → safety → queue → storage) can be exercised
 * without network access. It is never loaded by the production server.
 */
import { createServer, type Server } from 'node:http';

export interface Injected {
  match: RegExp;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  times: number;
}

export function createFakeGraph() {
  const state = {
    followers: 1520,
    follows: 310,
    media: 42,
    username: 'niv.studio',
    igUserId: '17841400000000001',
    unsupportedMetrics: new Set<string>(),
    businessAccounts: new Map<string, { followers_count: number; media_count: number; name: string }>([
      ['competitor.one', { followers_count: 9000, media_count: 300, name: 'Competitor One' }],
      ['target.biz', { followers_count: 4000, media_count: 120, name: 'Target Biz' }],
    ]),
    usageHeader: null as string | null,
    containers: new Map<string, { status: string; params: Record<string, string> }>(),
    published: [] as string[],
    publishQuota: 3,
    comments: [] as { mediaId: string; id: string; text: string; username: string; timestamp: string }[],
    replies: [] as { commentId: string; message: string }[],
    messages: [] as { recipient: any; message: any }[],
    subscriptions: [] as string[],
    calls: [] as string[],
  };
  const injected: Injected[] = [];

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const err = (code: number, message: string, status = 400, subcode?: number) =>
    json(status, { error: { message, type: 'OAuthException', code, error_subcode: subcode, fbtrace_id: 'TEST' } });

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const params = new URLSearchParams(url.search);
    if (init?.body instanceof URLSearchParams) for (const [k, v] of init.body) params.set(k, v);
    const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
    state.calls.push(`${init?.method ?? 'GET'} ${url.host}${path}`);

    for (const inj of injected) {
      if (inj.times > 0 && inj.match.test(path)) {
        inj.times--;
        return json(inj.status, inj.body, inj.headers);
      }
    }
    const usage: Record<string, string> = state.usageHeader ? { 'x-app-usage': state.usageHeader } : {};
    const token = params.get('access_token') ?? '';
    if (token === 'revoked-token-xxxxxxxxxxxxxxxx') return err(190, 'Error validating access token: The session has been invalidated', 400, 460);

    // OAuth endpoints
    if (path === '/oauth/access_token' && url.host.startsWith('api.')) return json(200, { data: [{ access_token: 'short-lived-token-xxxxxxxxxxxx', user_id: state.igUserId, permissions: 'instagram_business_basic,instagram_business_manage_insights' }] });
    if (path === '/access_token') return json(200, { access_token: 'long-lived-token-xxxxxxxxxxxxxxx', token_type: 'bearer', expires_in: 5184000 });
    if (path === '/refresh_access_token') return json(200, { access_token: 'refreshed-token-xxxxxxxxxxxxxxx', token_type: 'bearer', expires_in: 5184000 });
    if (path === '/oauth/access_token') return json(200, { access_token: 'fb-user-token-xxxxxxxxxxxxxxxxxx', token_type: 'bearer', expires_in: 5184000 });
    if (path === '/me/permissions') return json(200, { data: ['instagram_basic', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement'].map((permission) => ({ permission, status: 'granted' })) });
    if (path === '/me/accounts')
      return json(200, { data: [{ id: '1050000000000001', name: 'Niv Page', access_token: 'page-token-xxxxxxxxxxxxxxxxxxxx', instagram_business_account: { id: state.igUserId, username: state.username, followers_count: state.followers, follows_count: state.follows, media_count: state.media } }] });

    const method = init?.method ?? 'GET';
    const ig = state.igUserId;
    if (path === `/${ig}/content_publishing_limit`) return json(200, { data: [{ quota_usage: state.publishQuota, config: { quota_total: 100, quota_duration: 86400 } }] });
    if (path === `/${ig}/media` && method === 'POST') {
      const id = `1800000000000${state.containers.size + 1}`;
      state.containers.set(id, { status: params.get('video_url') ? 'IN_PROGRESS' : 'FINISHED', params: Object.fromEntries(params) });
      return json(200, { id });
    }
    if (path === `/${ig}/media_publish`) {
      const c = state.containers.get(params.get('creation_id') ?? '');
      if (!c || c.status !== 'FINISHED') return err(9007, 'Media ID is not available', 400, 2207027);
      c.status = 'PUBLISHED';
      const id = `1790000000555${state.published.length + 1}`;
      state.published.push(id);
      return json(200, { id });
    }
    const container = state.containers.get(path.slice(1));
    if (container) return json(200, { id: path.slice(1), status_code: container.status, status: container.status === 'ERROR' ? 'Error: 2207026' : undefined });
    if (path.startsWith('/179000000055') && params.get('fields') === 'permalink') return json(200, { permalink: `https://www.instagram.com/p/${path.slice(-4)}/` });
    if (path === `/${ig}/subscribed_apps` || path.endsWith('/subscribed_apps')) {
      state.subscriptions.push(params.get('subscribed_fields') ?? '');
      return json(200, { success: true });
    }
    if (path === `/${ig}/messages`) {
      state.messages.push({ recipient: JSON.parse(params.get('recipient') ?? '{}'), message: JSON.parse(params.get('message') ?? '{}') });
      return json(200, { recipient_id: '1', message_id: `mid.${state.messages.length}` });
    }
    const replies = path.match(/^\/(\d+)\/replies$/);
    if (replies) {
      state.replies.push({ commentId: replies[1], message: params.get('message') ?? '' });
      return json(200, { id: `1810000000${state.replies.length}` });
    }
    const comments = path.match(/^\/(\d+)\/comments$/);
    if (comments) return json(200, { data: state.comments.filter((c) => c.mediaId === comments[1]).map(({ mediaId: _m, ...c }) => ({ ...c, from: { id: `99${c.id}`, username: c.username } })) });

    const profile = () => ({ id: state.igUserId, user_id: state.igUserId, username: state.username, name: 'Niv Studio', account_type: 'BUSINESS', followers_count: state.followers, follows_count: state.follows, media_count: state.media });
    if (path === '/me') return json(200, profile(), usage);

    const insights = path.match(/^\/(\d+)\/insights$/);
    if (insights && insights[1] === state.igUserId) {
      const metrics = (params.get('metric') ?? '').split(',');
      const bad = metrics.find((m) => state.unsupportedMetrics.has(m));
      if (bad) return err(100, `(#100) metric[0] must be one of the following values: ... (${bad})`);
      const until = Number(params.get('until'));
      if (metrics[0] === 'follower_count') {
        const values = [1, 2, 3].map((i) => ({ value: 10 + i, end_time: new Date((until - i * 86400) * 1000).toISOString().replace('.000Z', '+0000') }));
        return json(200, { data: [{ name: 'follower_count', period: 'day', values }] }, usage);
      }
      if (metrics[0] === 'follows_and_unfollows')
        return json(200, { data: [{ name: 'follows_and_unfollows', total_value: { value: 9, breakdowns: [{ dimension_keys: ['follow_type'], results: [{ dimension_values: ['FOLLOWER'], value: 7 }, { dimension_values: ['NON_FOLLOWER'], value: 2 }] }] } }] }, usage);
      return json(200, { data: metrics.map((m, i) => ({ name: m, period: 'day', total_value: { value: 100 + i } })) }, usage);
    }
    const mediaInsights = path.match(/^\/(\d+)\/insights$/);
    if (mediaInsights) {
      const metrics = (params.get('metric') ?? '').split(',');
      return json(200, { data: metrics.map((m) => ({ name: m, values: [{ value: 50 }] })) });
    }
    if (path === `/${state.igUserId}/media`) {
      const now = Date.now();
      return json(200, { data: [1, 2, 3].map((i) => ({ id: `1790000000000000${i}`, caption: `post ${i}`, media_type: 'IMAGE', media_product_type: 'FEED', permalink: `https://www.instagram.com/p/x${i}/`, timestamp: new Date(now - i * 86400000).toISOString(), like_count: 20 * i, comments_count: i })) });
    }
    if (path === `/${state.igUserId}/stories`) return json(200, { data: [{ id: '17900000000000099', media_type: 'IMAGE', permalink: 'https://www.instagram.com/stories/x/1/', timestamp: new Date().toISOString() }] });
    if (path === `/${state.igUserId}`) {
      const fields = params.get('fields') ?? '';
      const bd = fields.match(/business_discovery\.username\(([^)]+)\)/);
      if (bd) {
        const a = state.businessAccounts.get(bd[1]);
        if (!a) return err(110, 'Invalid user id', 400, 2207013);
        return json(200, { business_discovery: { username: bd[1], ...a, id: '1' }, id: state.igUserId });
      }
      return json(200, profile(), usage);
    }
    return err(100, `Unsupported get request (test fake: ${path})`);
  }

  return {
    state,
    fetch: handle as typeof fetch,
    inject(match: RegExp, status: number, body: unknown, times = 1, headers?: Record<string, string>) {
      injected.push({ match, status, body, times, headers });
    },
    /** Serves the fake over HTTP for full-process end-to-end runs. */
    listen(port = 0): Promise<Server> {
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length ? new URLSearchParams(Buffer.concat(chunks).toString()) : undefined;
        const r = await handle(`http://${req.headers.host}${req.url}`, { method: req.method, body });
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(await r.text());
      });
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
    },
  };
}
