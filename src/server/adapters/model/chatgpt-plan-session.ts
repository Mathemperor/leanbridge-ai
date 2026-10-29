import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const REDIRECT = 'http://127.0.0.1:1455/auth/callback';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const REQUIRED_SCOPES = ['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const MAX_BODY = 1_048_576;
const opaque = () => randomBytes(32).toString('base64url');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const clientValid = (value: unknown): value is string => typeof value === 'string' && /^oaiapp_[A-Za-z0-9_-]{1,160}$/.test(value);
const equal = (a: unknown, b: string) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
class PlanError extends Error {}
function fail(code: string): never { throw new PlanError(code); }
const safe = (error: unknown) => error instanceof PlanError ? error : new PlanError('PLAN_TEMPORARY_FAILURE');
const missing = (error: unknown) => object(error).code === 'ENOENT';

export interface PlanAuthState {
  connected: boolean;
  state: 'connected' | 'idle' | 'pending' | 'failed';
  transport?: 'chatgpt-plan';
  expiresAt?: string;
  message?: string;
  completing?: boolean;
  setup?: { authorizationUrl: string; ticket: string; state: string; completeUrl: string };
}
export interface PlanSessionOptions {
  directory: string;
  clientId?: string;
  backendOrigin: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  jwks?: JWTVerifyGetKey;
}
interface Grant {
  version: 1;
  clientId: string;
  subject: string;
  nonce: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  scopes: string[];
  expiresAt: number;
  earliestRefreshAt: number;
  revoked?: boolean;
}
interface Attempt {
  ticket: string;
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
  clientId?: string;
  setup: NonNullable<PlanAuthState['setup']>;
}

const TIER_IDS = ['default', 'priority', 'fast', 'ultrafast', 'auto'];
const TIER_FIELDS = ['service_tiers', 'additional_speed_tiers', 'default_service_tier', 'serviceTiers', 'additionalSpeedTiers', 'defaultServiceTier'];
export interface PlanTierCapability {
  slug: string;
  serviceTiers: string[];
  additionalSpeedTiers: string[];
  defaultServiceTier?: string;
  metadataFields: string[];
}
function knownTiers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 32).map(item => typeof item === 'string' ? item : object(item).id)
    .filter((item): item is string => typeof item === 'string' && TIER_IDS.includes(item)))];
}

/** One process/replica owns the directory. Private volume permissions are the security boundary;
 * a local encryption key does not protect against compromise of the complete volume. */
export class ChatGPTPlanSession {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly jwks: JWTVerifyGetKey;
  private readonly backendOrigin: string;
  private initialization: Promise<void> | undefined;
  private key!: Buffer;
  private hostId!: string;
  private grant: Grant | undefined;
  // A rotating refresh may consume the previous token before the disk write succeeds.
  // Retain its validated replacement for write retries, but never serve it until saved.
  // Process loss before the first successful durable write can still require reconnect;
  // an in-memory candidate cannot bridge that unavoidable provider/storage boundary.
  private pendingPersistence: Grant | undefined;
  private attempt: Attempt | undefined;
  private completing = false;
  private lastFailure: string | undefined;
  private refreshPromise: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: PlanSessionOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    if (options.clientId && !clientValid(options.clientId)) fail('PLAN_OAUTH_CLIENT');
    try {
      const origin = new URL(options.backendOrigin);
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) fail('PLAN_BACKEND_ORIGIN');
      this.backendOrigin = origin.origin;
    } catch { fail('PLAN_BACKEND_ORIGIN'); }
    this.jwks = options.jwks ?? createRemoteJWKSet(new URL('/.well-known/jwks.json', ISSUER), {
      [customFetch]: this.fetchImpl, timeoutDuration: 15_000,
    });
  }

  async status(): Promise<PlanAuthState> {
    try {
      await this.initialize();
      if (this.completing) return { connected: false, state: 'pending', transport: 'chatgpt-plan', completing: true, message: '正在确认订阅授权，请稍候。' };
      if (this.attempt && this.attempt.expiresAt > this.now()) return this.pendingState(this.attempt);
      if (this.grant) {
        await this.accessToken();
        return this.connectedState();
      }
      return { connected: false, state: this.lastFailure ? 'failed' : 'idle', transport: 'chatgpt-plan', ...(this.lastFailure ? { message: this.lastFailure } : {}) };
    } catch (error) { return { connected: false, state: 'failed', transport: 'chatgpt-plan', message: safe(error).message }; }
  }

  async startLogin(): Promise<PlanAuthState> {
    try {
      await this.initialize();
      // Refresh outside the serialization queue: accessToken itself queues refreshes.
      if (this.grant && !this.grant.revoked) {
        await this.accessToken();
        return this.connectedState();
      }
      return await this.serial(async () => {
        // A callback may have finished while this begin request waited for the queue.
        if (this.grant && !this.grant.revoked) return this.connectedState();
        if (this.attempt && this.attempt.expiresAt > this.now()) return this.pendingState(this.attempt);
        const clientId = this.grant?.clientId ?? this.options.clientId;
        const state = opaque(), nonce = opaque(), verifier = opaque(), ticket = opaque();
        const url = new URL('/api/accounts/authorize', ISSUER);
        url.search = new URLSearchParams({ client_id: clientId ?? 'dynamic_agent_client', ext_agent_host_id: this.hostId,
          response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES, resource: RESOURCE, state, nonce,
          code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
        if (!clientId) url.searchParams.set('agent_name_hint', 'LeanBridge AI');
        const setup = { authorizationUrl: url.toString(), ticket, state, completeUrl: `${this.backendOrigin}/api/subscription/callback` };
        this.attempt = { ticket, state, nonce, verifier, expiresAt: this.now() + 600_000, ...(clientId ? { clientId } : {}), setup };
        this.lastFailure = undefined;
        return this.pendingState(this.attempt);
      });
    } catch (error) { throw safe(error); }
  }

  async completeLogin(input: { ticket: string; state: string; code: string; clientId?: string }): Promise<PlanAuthState> {
    try {
      await this.initialize();
      return await this.serial(async () => {
        const attempt = this.attempt;
        if (!attempt || !equal(input.ticket, attempt.ticket)) fail('PLAN_OAUTH_TICKET');
        if (this.now() >= attempt.expiresAt) { this.attempt = undefined; fail('PLAN_OAUTH_EXPIRED'); }
        if (!equal(input.state, attempt.state)) fail('PLAN_OAUTH_STATE');
        if (attempt.clientId && input.clientId !== undefined && input.clientId !== attempt.clientId) fail('PLAN_OAUTH_CLIENT');
        const clientId = attempt.clientId ?? input.clientId;
        if (!clientValid(clientId)) fail('PLAN_OAUTH_CLIENT');
        if (!nonempty(input.code) || input.code.length > 8192) fail('PLAN_OAUTH_CODE');
        // Consume before network activity; every valid ticket gets at most one exchange.
        this.attempt = undefined;
        this.completing = true;
        try {
          const response = await this.tokenRequest({ grant_type: 'authorization_code', client_id: clientId,
            code: input.code, redirect_uri: REDIRECT, code_verifier: attempt.verifier, resource: RESOURCE });
          const grant = await this.validateGrant(response, clientId, attempt.nonce);
          await this.save(grant);
          this.grant = grant;
          this.pendingPersistence = undefined;
          this.lastFailure = undefined;
          return this.connectedState();
        } finally { this.completing = false; }
      });
    } catch (error) { const failure = safe(error); this.lastFailure = failure.message; throw failure; }
  }

  async inspectLogin(input: { state: string; ticket: string }): Promise<{ authorizationUrl: string }> {
    try {
      await this.initialize();
      return await this.serial(async () => {
        const attempt = this.attempt;
        if (!attempt || !equal(input.ticket, attempt.ticket)) fail('PLAN_OAUTH_TICKET');
        if (this.now() >= attempt.expiresAt) fail('PLAN_OAUTH_EXPIRED');
        if (!equal(input.state, attempt.state)) fail('PLAN_OAUTH_STATE');
        return { authorizationUrl: attempt.setup.authorizationUrl };
      });
    } catch (error) { throw safe(error); }
  }

  async accessToken(): Promise<string> {
    try {
      await this.initialize();
      if (this.grant?.revoked) {
        // Persist the revocation when storage recovers; disk failure cannot undo it.
        if (this.pendingPersistence) await this.serial(() => this.persistPending()).catch(() => {});
        fail('PLAN_RECONNECT_REQUIRED');
      }
      if (!this.grant) fail('PLAN_RECONNECT_REQUIRED');
      if (this.pendingPersistence || this.refreshPromise || this.needsRefresh(this.grant)) {
        if (!this.refreshPromise) {
          const refresh = this.serial(() => this.refresh());
          this.refreshPromise = refresh;
          void refresh.finally(() => { if (this.refreshPromise === refresh) this.refreshPromise = undefined; }).catch(() => {});
        }
        await this.refreshPromise;
      }
      if (!this.grant || this.grant.revoked) fail('PLAN_RECONNECT_REQUIRED');
      if (this.grant.expiresAt <= this.now()) fail('PLAN_REFRESH_NOT_YET_ALLOWED');
      return this.grant.accessToken;
    } catch (error) { throw safe(error); }
  }

  async catalog(): Promise<Array<{ slug: string; display_name?: string; visibility: string }>> {
    try {
      return (await this.catalogRows()).map(row => {
        return { slug: row.slug, ...(nonempty(row.display_name) ? { display_name: row.display_name.slice(0, 256) } : {}), visibility: 'list' };
      });
    } catch (error) { throw safe(error); }
  }

  /** Diagnostic-only projection: never retain descriptions, arbitrary tier names or opaque auth metadata. */
  async inspectTierCatalog(signal?: AbortSignal): Promise<PlanTierCapability[]> {
    try {
      return (await this.catalogRows(signal)).map(row => {
        const defaultServiceTier = [row.default_service_tier, row.defaultServiceTier]
          .find((value): value is string => typeof value === 'string' && TIER_IDS.includes(value));
        return {slug: row.slug,
          serviceTiers: [...new Set([...knownTiers(row.service_tiers), ...knownTiers(row.serviceTiers)])],
          additionalSpeedTiers: [...new Set([...knownTiers(row.additional_speed_tiers), ...knownTiers(row.additionalSpeedTiers)])],
          ...(defaultServiceTier ? {defaultServiceTier} : {}),
          metadataFields: TIER_FIELDS.filter(field => Object.hasOwn(row, field)),
        };
      });
    } catch (error) { throw safe(error); }
  }

  private async catalogRows(signal?: AbortSignal): Promise<Array<Record<string, unknown> & {slug: string}>> {
    const token = await this.accessToken();
    if(signal?.aborted)fail('PLAN_CATALOG_UNAVAILABLE');
    const timeout=AbortSignal.timeout(30_000);
    const response = await this.fetchImpl(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: signal ? AbortSignal.any([timeout,signal]) : timeout });
    if (!response.ok) { await response.body?.cancel(); fail('PLAN_CATALOG_UNAVAILABLE'); }
    const body = object(await this.readJson(response));
    if (!Array.isArray(body.models)) fail('PLAN_CATALOG_INVALID');
    return body.models.filter(item => object(item).visibility === 'list').map(item => {
      const row = object(item);
      if (!nonempty(row.slug) || row.slug.length > 256) fail('PLAN_CATALOG_INVALID');
      return {...row, slug: row.slug};
    });
  }

  private connectedState(): PlanAuthState {
    return { connected: true, state: 'connected', transport: 'chatgpt-plan', expiresAt: new Date(this.grant!.expiresAt).toISOString() };
  }
  private pendingState(attempt: Attempt): PlanAuthState {
    return { connected: false, state: 'pending', transport: 'chatgpt-plan', expiresAt: new Date(attempt.expiresAt).toISOString(), setup: { ...attempt.setup } };
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  private needsRefresh(grant: Grant): boolean { return this.now() >= Math.max(grant.expiresAt - 120_000, grant.earliestRefreshAt); }

  private async refresh(): Promise<void> {
    // Always finish the previous rotation's write before considering another refresh.
    if (this.pendingPersistence) await this.persistPending();
    const previous = this.grant;
    if (!previous || previous.revoked) fail('PLAN_RECONNECT_REQUIRED');
    if (!this.needsRefresh(previous)) return;
    let response: Record<string, unknown>;
    try {
      response = await this.tokenRequest({ grant_type: 'refresh_token', client_id: previous.clientId, refresh_token: previous.refreshToken, resource: RESOURCE });
    } catch (error) {
      if (error instanceof PlanError && error.message === 'PLAN_RECONNECT_REQUIRED') {
        const revoked = { ...previous, revoked: true };
        this.grant = revoked;
        this.pendingPersistence = revoked;
        await this.persistPending().catch(() => {});
      }
      throw error;
    }
    const next = await this.validateGrant(response, previous.clientId, previous.nonce, previous);
    this.pendingPersistence = next;
    await this.persistPending();
    this.lastFailure = undefined;
  }

  private async persistPending(): Promise<void> {
    const candidate = this.pendingPersistence;
    if (!candidate) return;
    await this.save(candidate);
    this.grant = candidate;
    this.pendingPersistence = undefined;
  }

  private async tokenRequest(fields: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString(), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (response.status >= 500 || response.status === 429) { await response.body?.cancel(); fail('PLAN_TEMPORARY_FAILURE'); }
    const body = object(await this.readJson(response));
    if (!response.ok) {
      if (fields.grant_type === 'refresh_token' && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'invalid_client', 'unauthorized_client'].includes(String(body.error))) fail('PLAN_RECONNECT_REQUIRED');
      fail('PLAN_OAUTH_EXCHANGE_FAILED');
    }
    return body;
  }

  private async validateGrant(body: Record<string, unknown>, clientId: string, nonce: string, previous?: Grant): Promise<Grant> {
    if (!nonempty(body.access_token) || !nonempty(body.refresh_token) || !nonempty(body.id_token) || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
      || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 31_536_000) fail('PLAN_OAUTH_TOKEN_RESPONSE');
    // RFC 6749 allows refresh responses to omit an unchanged scope; a provided scope must retain every granted scope.
    const scopes = body.scope === undefined && previous ? previous.scopes : typeof body.scope === 'string' ? [...new Set(body.scope.split(/\s+/).filter(Boolean))] : [];
    if (![...REQUIRED_SCOPES, ...(previous?.scopes ?? [])].every(scope => scopes.includes(scope))) fail('PLAN_OAUTH_SCOPES');
    let identity;
    try {
      ({ payload: identity } = await jwtVerify(body.id_token, this.jwks, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', ...(previous ? [] : ['nonce'])], currentDate: new Date(this.now()), clockTolerance: 5 }));
    } catch { fail('PLAN_OAUTH_ID_TOKEN'); }
    if (!nonempty(identity.sub) || typeof identity.iat !== 'number' || identity.iat > this.now() / 1000 + 5 || (previous && identity.sub !== previous.subject)) fail('PLAN_OAUTH_ID_TOKEN');
    if ((!previous || identity.nonce !== undefined) && !equal(identity.nonce, nonce)) fail('PLAN_OAUTH_NONCE');
    if (identity.azp !== undefined && identity.azp !== clientId) fail('PLAN_OAUTH_CLIENT');
    if (Array.isArray(identity.aud) && identity.aud.length > 1 && identity.azp !== clientId) fail('PLAN_OAUTH_CLIENT');
    const expiresAt = this.now() + body.expires_in * 1000;
    let earliestRefreshAt = 0;
    if (body.earliest_refresh_at !== undefined && body.earliest_refresh_at !== null) {
      const raw = body.earliest_refresh_at;
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) earliestRefreshAt = raw < 1e12 ? raw * 1000 : raw;
      else if (typeof raw === 'string') earliestRefreshAt = /^\d+(\.\d+)?$/.test(raw) ? (Number(raw) < 1e12 ? Number(raw) * 1000 : Number(raw)) : Date.parse(raw);
      else earliestRefreshAt = NaN;
      // An unfamiliar hint never causes an early refresh; expiry is the conservative fallback.
      if (!Number.isFinite(earliestRefreshAt) || earliestRefreshAt < 0) earliestRefreshAt = expiresAt;
    }
    return { version: 1, clientId, subject: identity.sub, nonce, accessToken: body.access_token, refreshToken: body.refresh_token,
      idToken: body.id_token, scopes, expiresAt, earliestRefreshAt };
  }

  private async readJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) fail('PLAN_RESPONSE_INVALID');
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY) fail('PLAN_RESPONSE_TOO_LARGE');
        chunks.push(value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { fail('PLAN_RESPONSE_INVALID'); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  private initialize(): Promise<void> {
    this.initialization ??= this.load().catch(() => { throw new PlanError('PLAN_STORAGE_UNAVAILABLE'); });
    return this.initialization;
  }
  private async load(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.options.directory, 0o700);
    let encrypted: Buffer | undefined;
    try {
      const info = await stat(join(this.options.directory, 'session.enc'));
      if (info.size > MAX_BODY) fail('PLAN_STORAGE_UNAVAILABLE');
      encrypted = await readFile(join(this.options.directory, 'session.enc'));
    } catch (error) { if (!missing(error)) throw error; }
    const keyPath = join(this.options.directory, 'session.key');
    try { this.key = await readFile(keyPath); }
    catch (error) {
      if (!missing(error) || encrypted) throw error;
      this.key = randomBytes(32); await this.atomicWrite('session.key', this.key);
    }
    if (this.key.length !== 32) fail('PLAN_STORAGE_UNAVAILABLE');
    if (process.platform !== 'win32') await chmod(keyPath, 0o600);
    const hostPath = join(this.options.directory, 'host.json');
    try { this.hostId = object(JSON.parse(await readFile(hostPath, 'utf8'))).hostId as string; }
    catch (error) {
      if (!missing(error)) throw error;
      this.hostId = `urn:uuid:${randomUUID()}`;
      await this.atomicWrite('host.json', Buffer.from(JSON.stringify({ hostId: this.hostId })));
    }
    if (!/^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(this.hostId)) fail('PLAN_STORAGE_UNAVAILABLE');
    if (process.platform !== 'win32') await chmod(hostPath, 0o600);
    if (encrypted) {
      if (encrypted.length < 30 || encrypted[0] !== 1) fail('PLAN_STORAGE_UNAVAILABLE');
      const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(1, 13));
      decipher.setAAD(Buffer.from('leanbridge-chatgpt-plan-v1'));
      decipher.setAuthTag(encrypted.subarray(13, 29));
      const record = object(JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(29)), decipher.final()]).toString('utf8')));
      if (record.version !== 1 || !clientValid(record.clientId) || !nonempty(record.subject) || !nonempty(record.nonce) || !nonempty(record.accessToken)
        || !nonempty(record.refreshToken) || !nonempty(record.idToken) || !Array.isArray(record.scopes) || !record.scopes.every(nonempty)
        || !REQUIRED_SCOPES.every(scope => (record.scopes as string[]).includes(scope)) || typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)
        || typeof record.earliestRefreshAt !== 'number' || !Number.isFinite(record.earliestRefreshAt)) fail('PLAN_STORAGE_UNAVAILABLE');
      this.grant = record as unknown as Grant;
      if (process.platform !== 'win32') await chmod(join(this.options.directory, 'session.enc'), 0o600);
    }
  }
  private async save(grant: Grant): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('leanbridge-chatgpt-plan-v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(grant), 'utf8'), cipher.final()]);
    await this.atomicWrite('session.enc', Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]));
  }
  private async atomicWrite(name: string, contents: Buffer): Promise<void> {
    const destination = join(this.options.directory, name);
    const temporary = join(this.options.directory, `.${name}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
      await rename(temporary, destination);
      // POSIX directory fsync makes the rename durable. Windows cannot open directories this way.
      if (process.platform !== 'win32') {
        const directory = await open(this.options.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}
