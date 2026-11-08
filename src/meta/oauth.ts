import type { Config } from '../config.ts';
import { MetaApiError } from './errors.ts';
import type { FetchLike, GraphClient, Provider } from './graph-client.ts';

/** Only the permissions this product actually uses — minimises App Review scope. */
export const SCOPES: Record<Provider, string[]> = {
  instagram_login: ['instagram_business_basic', 'instagram_business_manage_insights'],
  facebook_login: ['instagram_basic', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement', 'business_management'],
};

export interface ConnectedProfile {
  igUserId: string;
  appScopedUserId?: string;
  username: string;
  name?: string;
  accountType?: string;
  profilePictureUrl?: string;
  followersCount?: number;
  followsCount?: number;
  mediaCount?: number;
  fbPageId?: string;
  token: string;
  tokenExpiresAt: number | null;
  scopes: string[];
}

export const IG_PROFILE_FIELDS = 'user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count';
export const FB_IG_FIELDS = 'id,username,name,profile_picture_url,followers_count,follows_count,media_count';

export class MetaOAuth {
  private readonly config: Config;
  private readonly graph: GraphClient;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(config: Config, graph: GraphClient, fetchImpl: FetchLike = fetch, now: () => number = Date.now) {
    this.config = config;
    this.graph = graph;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  isConfigured(provider: Provider): boolean {
    const m = this.config.meta;
    return provider === 'instagram_login' ? Boolean(m.igAppId && m.igAppSecret) : Boolean(m.fbAppId && m.fbAppSecret);
  }

  redirectUri(provider: Provider): string {
    return `${this.config.publicBaseUrl}/api/oauth/${provider}/callback`;
  }

  authorizeUrl(provider: Provider, state: string): string {
    const m = this.config.meta;
    if (provider === 'instagram_login') {
      const u = new URL(`${m.instagramOAuthBase}/oauth/authorize`);
      u.search = new URLSearchParams({
        enable_fb_login: '0',
        force_authentication: '1',
        client_id: m.igAppId,
        redirect_uri: this.redirectUri(provider),
        response_type: 'code',
        scope: SCOPES.instagram_login.join(','),
        state,
      }).toString();
      return u.toString();
    }
    const u = new URL(`${m.facebookOAuthBase}/${m.graphVersion}/dialog/oauth`);
    u.search = new URLSearchParams({
      client_id: m.fbAppId,
      redirect_uri: this.redirectUri(provider),
      response_type: 'code',
      scope: SCOPES.facebook_login.join(','),
      state,
    }).toString();
    return u.toString();
  }

  private async json(url: string | URL, init?: RequestInit): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new MetaApiError(0, { message: `Network error: ${(err as Error).message}`, is_transient: true });
    }
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new MetaApiError(res.status, undefined, undefined, `Non-JSON response from Meta (HTTP ${res.status})`);
    }
    if (!res.ok || body.error || body.error_type) {
      const e = body.error ?? { message: body.error_message, code: body.code };
      throw new MetaApiError(res.status, e);
    }
    return body;
  }

  /** Exchanges an OAuth code for a long-lived token and returns every IG account it grants. */
  async exchangeCode(provider: Provider, code: string): Promise<ConnectedProfile[]> {
    const m = this.config.meta;
    if (provider === 'instagram_login') {
      const short = await this.json(`${m.instagramApiBase}/oauth/access_token`, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: m.igAppId,
          client_secret: m.igAppSecret,
          grant_type: 'authorization_code',
          redirect_uri: this.redirectUri(provider),
          code,
        }),
      });
      const entry = Array.isArray(short.data) ? short.data[0] : short;
      const long = await this.exchangeInstagramLongLived(entry.access_token);
      const scopes = typeof entry.permissions === 'string' ? entry.permissions.split(',') : (entry.permissions ?? SCOPES.instagram_login);
      return [await this.profileFromInstagramToken(long.token, long.expiresAt, scopes)];
    }

    const tokenUrl = new URL(`${m.facebookGraphBase}/${m.graphVersion}/oauth/access_token`);
    tokenUrl.search = new URLSearchParams({ client_id: m.fbAppId, client_secret: m.fbAppSecret, redirect_uri: this.redirectUri(provider), code }).toString();
    const short = await this.json(tokenUrl);
    const longUrl = new URL(`${m.facebookGraphBase}/${m.graphVersion}/oauth/access_token`);
    longUrl.search = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: m.fbAppId, client_secret: m.fbAppSecret, fb_exchange_token: short.access_token }).toString();
    const long = await this.json(longUrl);
    return this.profilesFromFacebookUserToken(long.access_token);
  }

  async exchangeInstagramLongLived(shortToken: string): Promise<{ token: string; expiresAt: number }> {
    const u = new URL(`${this.config.meta.instagramGraphBase}/access_token`);
    u.search = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: this.config.meta.igAppSecret, access_token: shortToken }).toString();
    const r = await this.json(u);
    return { token: r.access_token, expiresAt: this.now() + Number(r.expires_in ?? 5_184_000) * 1000 };
  }

  /** Long-lived Instagram-Login tokens (60 days) can be refreshed once they are 24h old. */
  async refreshInstagramToken(token: string): Promise<{ token: string; expiresAt: number }> {
    const u = new URL(`${this.config.meta.instagramGraphBase}/refresh_access_token`);
    u.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token }).toString();
    const r = await this.json(u);
    return { token: r.access_token, expiresAt: this.now() + Number(r.expires_in ?? 5_184_000) * 1000 };
  }

  async profileFromInstagramToken(token: string, expiresAt: number | null, scopes: string[]): Promise<ConnectedProfile> {
    const { data: me } = await this.graph.request({ provider: 'instagram_login', token, path: 'me', params: { fields: `id,${IG_PROFILE_FIELDS}` } });
    return {
      igUserId: String(me.user_id ?? me.id),
      appScopedUserId: me.id ? String(me.id) : undefined,
      username: me.username,
      name: me.name,
      accountType: me.account_type,
      profilePictureUrl: me.profile_picture_url,
      followersCount: me.followers_count,
      followsCount: me.follows_count,
      mediaCount: me.media_count,
      token,
      tokenExpiresAt: expiresAt,
      scopes,
    };
  }

  /** Resolves every Instagram professional account linked to the user's Facebook Pages. */
  async profilesFromFacebookUserToken(userToken: string): Promise<ConnectedProfile[]> {
    const perms = await this.graph.request<{ data: { permission: string; status: string }[] }>({ provider: 'facebook_login', token: userToken, path: 'me/permissions' });
    const scopes = perms.data.data.filter((p) => p.status === 'granted').map((p) => p.permission);
    const pages = await this.graph.paginate<any>({
      provider: 'facebook_login',
      token: userToken,
      path: 'me/accounts',
      params: { fields: `id,name,access_token,instagram_business_account{${FB_IG_FIELDS}}`, limit: 50 },
    });
    return pages
      .filter((p) => p.instagram_business_account && p.access_token)
      .map((p) => {
        const ig = p.instagram_business_account;
        return {
          igUserId: String(ig.id),
          username: ig.username,
          name: ig.name,
          accountType: 'BUSINESS_OR_CREATOR',
          profilePictureUrl: ig.profile_picture_url,
          followersCount: ig.followers_count,
          followsCount: ig.follows_count,
          mediaCount: ig.media_count,
          fbPageId: String(p.id),
          token: p.access_token, // Page tokens derived from a long-lived user token do not expire.
          tokenExpiresAt: null,
          scopes,
        };
      });
  }
}
