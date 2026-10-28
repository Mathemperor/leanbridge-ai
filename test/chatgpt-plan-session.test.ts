import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ChatGPTPlanSession } from '../src/server/adapters/model/chatgpt-plan-session';

const directories: string[] = [];
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const clientId = 'oaiapp_session_test';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256' }] });
});
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

async function fixture(existingClient: string | undefined = clientId) {
  const directory = await mkdtemp(join(tmpdir(), 'plan-session-')); directories.push(directory);
  let now = Date.now();
  let auth: URL;
  let counter = 0;
  let refreshCount = 0;
  let mode = 'ok';
  let claims: Record<string, unknown> = {};
  let tokenOverrides: Record<string, unknown> = {};
  let onExchange: (() => Promise<void>) | undefined;
  const requests: URLSearchParams[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.openai.com/v1/models') {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer access-${counter}`);
      return Response.json({ models: [{ slug: 'plan-model', display_name: 'Plan Model', visibility: 'list' }, { slug: 'hidden-model', visibility: 'hide' }] });
    }
    expect(url).toBe('https://auth.openai.com/api/accounts/oauth/token');
    const body = new URLSearchParams(String(init?.body)); requests.push(body);
    const refresh = body.get('grant_type') === 'refresh_token';
    if (refresh) {
      refreshCount++;
      expect(body.get('client_id')).toBe(clientId);
      expect(body.get('resource')).toBe('https://api.openai.com/v1');
      expect(body.get('refresh_token')).toBe(`refresh-${counter}`);
      if (mode === 'network') throw new Error('SECRET_UPSTREAM_BODY');
      if (mode === '500') return new Response('SECRET_UPSTREAM_BODY', { status: 500 });
      if (mode === 'invalid_grant') return Response.json({ error: 'invalid_grant', error_description: 'SECRET_UPSTREAM_BODY' }, { status: 400 });
      if (['invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(mode)) return Response.json({ error: mode }, { status: 400 });
      if (mode === 'malformed') return new Response('SECRET_UPSTREAM_BODY', { status: 200 });
    } else {
      expect(body.get('redirect_uri')).toBe('http://127.0.0.1:59255/auth/callback');
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(auth.searchParams.get('code_challenge'));
      await onExchange?.();
    }
    counter++;
    const id_token = await new SignJWT({ sub: 'test-subject', nonce: auth.searchParams.get('nonce'), ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://auth.openai.com').setAudience(clientId)
      .setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(now / 1000) + 3600).sign(keys.privateKey);
    return Response.json({ access_token: `access-${counter}`, refresh_token: `refresh-${counter}`, id_token,
      expires_in: 3600, token_type: 'Bearer', scope: scopes, ...tokenOverrides });
  };
  const options = { directory, ...(existingClient ? { clientId: existingClient } : {}), backendOrigin: 'https://leanbridge.example', fetchImpl, now: () => now, jwks };
  const session = new ChatGPTPlanSession(options);
  const start = async () => {
    const state = await session.startLogin();
    auth = new URL(state.setup!.authorizationUrl);
    return state.setup!;
  };
  const login = async () => { const setup = await start(); return session.completeLogin({ ticket: setup.ticket, state: setup.state, code: 'one-use-code', clientId }); };
  return { directory, session, options, start, login, requests, get refreshCount() { return refreshCount; },
    advance: (ms: number) => { now += ms; }, setMode: (value: string) => { mode = value; },
    setClaims: (value: Record<string, unknown>) => { claims = value; }, setTokens: (value: Record<string, unknown>) => { tokenOverrides = value; },
    setExchangeHandler: (value: () => Promise<void>) => { onExchange = value; } };
}

describe('ChatGPTPlanSession', () => {
  it('persists an encrypted grant across restart without exposing tokens in status or setup', async () => {
    const f = await fixture();
    expect(await f.session.status()).toMatchObject({ connected: false, state: 'idle' });
    expect(await f.login()).toMatchObject({ connected: true, state: 'connected', transport: 'chatgpt-plan' });
    const restarted = new ChatGPTPlanSession(f.options);
    expect(await restarted.accessToken()).toBe('access-1');
    expect(JSON.stringify(await restarted.status())).not.toMatch(/access-1|refresh-1|id_token|test-subject/);
    const bytes = await Promise.all((await readdir(f.directory)).map(name => readFile(join(f.directory, name))));
    expect(bytes.some(bytes => bytes.includes(Buffer.from('access-1')) || bytes.includes(Buffer.from('refresh-1')))).toBe(false);
    expect(await restarted.catalog()).toEqual([{ slug: 'plan-model', display_name: 'Plan Model', visibility: 'list' }]);
  });
  it('uses a stable host and fresh state nonce PKCE and ticket, with pinned completion and loopback targets', async () => {
    const f = await fixture('');
    const first = await f.start();
    const second = await new ChatGPTPlanSession(f.options).startLogin();
    const a = new URL(first.authorizationUrl), b = new URL(second.setup!.authorizationUrl);
    expect(a.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(a.searchParams.get('agent_name_hint')).toBe('LeanBridge AI');
    expect(a.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:[a-f0-9-]{36}$/);
    expect(a.searchParams.get('ext_agent_host_id')).toBe(b.searchParams.get('ext_agent_host_id'));
    for (const field of ['state', 'nonce', 'code_challenge']) expect(a.searchParams.get(field)).not.toBe(b.searchParams.get(field));
    expect(first.ticket).not.toBe(second.setup!.ticket);
    expect(first.completeUrl).toBe('https://leanbridge.example/api/subscription/callback');
    expect(a.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:59255/auth/callback');
    expect(a.searchParams.has('code_verifier')).toBe(false);
  });
  it('serializes refresh and atomically persists rotating tokens for restart and the next refresh', async () => {
    const f = await fixture(); await f.login(); f.advance(3_550_000);
    expect(await Promise.all(Array.from({ length: 12 }, () => f.session.accessToken()))).toEqual(Array(12).fill('access-2'));
    expect(f.refreshCount).toBe(1);
    const restarted = new ChatGPTPlanSession(f.options);
    expect(await restarted.accessToken()).toBe('access-2');
    f.advance(3_550_000);
    expect(await restarted.accessToken()).toBe('access-3');
    expect(f.refreshCount).toBe(2);
  });
  it.each(['network', '500', 'malformed'])('preserves durable authorization on transient %s failure and sanitizes errors', async mode => {
    const f = await fixture(); await f.login(); f.advance(3_550_000); f.setMode(mode);
    await expect(f.session.accessToken()).rejects.toThrow(/^PLAN_/);
    const failed = await f.session.status();
    expect(JSON.stringify(failed)).not.toMatch(/SECRET|access-1|refresh-1/);
    f.setMode('ok');
    expect(await new ChatGPTPlanSession(f.options).accessToken()).toBe('access-2');
  });
  it('marks confirmed invalid_grant as reconnect-required across restart', async () => {
    const f = await fixture(); await f.login(); f.advance(3_550_000); f.setMode('invalid_grant');
    await expect(f.session.accessToken()).rejects.toThrow('PLAN_RECONNECT_REQUIRED');
    f.setMode('ok');
    expect(await new ChatGPTPlanSession(f.options).status()).toMatchObject({ connected: false, state: 'failed', message: 'PLAN_RECONNECT_REQUIRED' });
    expect(f.refreshCount).toBe(1);
  });
  it('rejects state/client substitution before exchange and rejects concurrent callback replay', async () => {
    const f = await fixture(); const setup = await f.start();
    const input = { ticket: setup.ticket, state: setup.state, code: 'one-use-code', clientId };
    await expect(f.session.completeLogin({ ...input, state: 'wrong' })).rejects.toThrow('PLAN_OAUTH_STATE');
    await expect(f.session.completeLogin({ ...input, clientId: 'oaiapp_wrong' })).rejects.toThrow('PLAN_OAUTH_CLIENT');
    expect(f.requests).toHaveLength(0);
    const results = await Promise.allSettled([f.session.completeLogin(input), f.session.completeLogin(input)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.requests).toHaveLength(1);
    await expect(f.session.completeLogin(input)).rejects.toThrow('PLAN_OAUTH_TICKET');
  });
  it('rejects expired tickets and never saves an identity on failed nonce or scope validation', async () => {
    const f = await fixture();
    let setup = await f.start(); f.advance(600_001);
    await expect(f.session.completeLogin({ ...setup, code: 'code' })).rejects.toThrow('PLAN_OAUTH_EXPIRED');
    f.setClaims({ nonce: 'wrong' }); setup = await f.start();
    await expect(f.session.completeLogin({ ...setup, code: 'code' })).rejects.toThrow('PLAN_OAUTH_NONCE');
    expect((await f.session.status()).connected).toBe(false);
    f.setClaims({}); f.setTokens({ scope: 'openid offline_access' }); setup = await f.start();
    await expect(f.session.completeLogin({ ...setup, code: 'code' })).rejects.toThrow('PLAN_OAUTH_SCOPES');
    expect((await new ChatGPTPlanSession(f.options).status()).connected).toBe(false);
  });
  it.each([{ access_token: {} }, { refresh_token: '' }, { id_token: '' }, { token_type: 'Basic' }])('rejects malformed token response %j', async override => {
    const f = await fixture(); f.setTokens(override);
    await expect(f.login()).rejects.toThrow(/^PLAN_/);
    expect((await f.session.status()).connected).toBe(false);
  });
});

it('inspects only the saved unexpired one-use setup without exposing backend-held secrets', async () => {
  const f = await fixture(); const setup = await f.start();
  expect(await f.session.inspectLogin({ state: setup.state, ticket: setup.ticket })).toEqual({ authorizationUrl: setup.authorizationUrl });
  await expect(f.session.inspectLogin({ state: 'wrong', ticket: setup.ticket })).rejects.toThrow('PLAN_OAUTH_STATE');
  await expect(f.session.inspectLogin({ state: setup.state, ticket: 'wrong' })).rejects.toThrow('PLAN_OAUTH_TICKET');
  await f.session.completeLogin({ ...setup, code: 'code' });
  await expect(f.session.inspectLogin(setup)).rejects.toThrow('PLAN_OAUTH_TICKET');
  const other = await fixture(); const expired = await other.start(); other.advance(600_000);
  await expect(other.session.inspectLogin(expired)).rejects.toThrow('PLAN_OAUTH_EXPIRED');
});

it.each(['seconds', 'milliseconds', 'iso', 'unknown'])('respects earliest_refresh_at %s without issuing an early refresh', async format => {
  const f = await fixture(); const scheduled = f.options.now() + 3_590_000;
  const hint = format === 'seconds' ? scheduled / 1000 : format === 'milliseconds' ? scheduled : format === 'iso' ? new Date(scheduled).toISOString() : { unfamiliar: true };
  f.setTokens({ earliest_refresh_at: hint }); await f.login(); f.advance(3_550_000);
  expect(await f.session.accessToken()).toBe('access-1'); expect(f.refreshCount).toBe(0);
  f.advance(format === 'unknown' ? 50_001 : 40_001);
  f.setTokens({}); expect(await f.session.accessToken()).toBe('access-2'); expect(f.refreshCount).toBe(1);
});

it('preserves scopes if refresh omits them and rejects a reduced granted scope', async () => {
  const f = await fixture(); await f.login(); f.advance(3_550_000); f.setTokens({ scope: undefined });
  expect(await f.session.accessToken()).toBe('access-2');
  f.advance(3_550_000); f.setTokens({ scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct' });
  await expect(f.session.accessToken()).rejects.toThrow('PLAN_OAUTH_SCOPES');
});

it('accepts dynamic issued client once and persists it for all later login attempts', async () => {
  const f = await fixture(''); await f.login();
  f.advance(3_550_000); f.setMode('invalid_grant');
  await expect(f.session.accessToken()).rejects.toThrow('PLAN_RECONNECT_REQUIRED');
  const restarted = new ChatGPTPlanSession(f.options);
  const setup = (await restarted.startLogin()).setup!;
  const url = new URL(setup.authorizationUrl);
  expect(url.searchParams.get('client_id')).toBe(clientId);
  expect(url.searchParams.has('agent_name_hint')).toBe(false);
});

it.each(['signature', 'issuer', 'audience', 'expired', 'subject'])('rejects invalid ID-token %s without saving authorization', async problem => {
  const f = await fixture(); const setup = await f.start(); const now = Math.floor(f.options.now() / 1000);
  const nonce = new URL(setup.authorizationUrl).searchParams.get('nonce');
  let token = await new SignJWT({ nonce, sub: problem === 'subject' ? '' : 'test-subject' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(problem === 'issuer' ? 'https://attacker.example' : 'https://auth.openai.com')
    .setAudience(problem === 'audience' ? 'oaiapp_other' : clientId).setIssuedAt(now).setExpirationTime(problem === 'expired' ? now - 30 : now + 3600).sign(keys.privateKey);
  if (problem === 'signature') token = token.slice(0, -20) + 'aaaaaaaaaaaaaaaaaaaa';
  f.setTokens({ id_token: token });
  await expect(f.session.completeLogin({ ...setup, code: 'code' })).rejects.toThrow('PLAN_OAUTH_ID_TOKEN');
  expect((await new ChatGPTPlanSession(f.options).status()).connected).toBe(false);
});

it('rejects multi-audience ID tokens without an authorized-party binding', async () => {
  const f = await fixture(); const setup = await f.start(); const now = Math.floor(f.options.now() / 1000);
  const id_token = await new SignJWT({ sub: 'test-subject', nonce: new URL(setup.authorizationUrl).searchParams.get('nonce') })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://auth.openai.com')
    .setAudience([clientId, 'oaiapp_other']).setIssuedAt(now).setExpirationTime(now + 3600).sign(keys.privateKey);
  f.setTokens({ id_token });
  await expect(f.session.completeLogin({ ...setup, code: 'code' })).rejects.toThrow('PLAN_OAUTH_CLIENT');
});

it('does not refresh before a future earliest_refresh_at even after access token expiry', async () => {
  const f = await fixture(); f.setTokens({ earliest_refresh_at: f.options.now() + 3_700_000 }); await f.login(); f.advance(3_600_001);
  await expect(f.session.accessToken()).rejects.toThrow('PLAN_REFRESH_NOT_YET_ALLOWED'); expect(f.refreshCount).toBe(0);
});

it.each(['oversize', 'parser', 'status'])('bounds catalog %s responses and never exposes upstream body contents', async failure => {
  const f = await fixture(); await f.login();
  const session = new ChatGPTPlanSession({ ...f.options, fetchImpl: async () => failure === 'oversize' ? new Response('SECRET'.repeat(200_000))
    : failure === 'parser' ? new Response('SECRET_UPSTREAM_BODY') : new Response('SECRET_UPSTREAM_BODY', { status: 500 }) });
  await expect(session.catalog()).rejects.toThrow(/^PLAN_/);
  try { await session.catalog(); } catch (error) { expect(String(error)).not.toMatch(/SECRET/); }
  expect((await session.status()).connected).toBe(true);
});

it('never replaces the previous durable identity if a reconnect save cannot be committed', async () => {
  const f = await fixture(); await f.login();
  f.advance(3_550_000); f.setMode('invalid_grant');
  await expect(f.session.accessToken()).rejects.toThrow('PLAN_RECONNECT_REQUIRED'); f.setMode('ok');
  const destination = join(f.directory, 'session.enc'), backup = join(f.directory, 'session.backup');
  await rename(destination, backup); await mkdir(destination);
  try {
    await expect(f.login()).rejects.toThrow(/^PLAN_/);
    await expect(f.session.accessToken()).rejects.toThrow('PLAN_RECONNECT_REQUIRED');
  } finally {
    await rm(destination, { recursive: true }); await rename(backup, destination);
  }
  await expect(new ChatGPTPlanSession(f.options).accessToken()).rejects.toThrow('PLAN_RECONNECT_REQUIRED');
  expect((await readdir(f.directory)).some(name => name.endsWith('.tmp'))).toBe(false);
});

it('fails closed on authenticated ciphertext corruption without overwriting it', async () => {
  const f = await fixture(); await f.login(); const path = join(f.directory, 'session.enc');
  const bytes = await readFile(path); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await writeFile(path, bytes);
  const restarted = new ChatGPTPlanSession(f.options);
  expect(await restarted.status()).toMatchObject({ connected: false, state: 'failed', message: 'PLAN_STORAGE_UNAVAILABLE' });
  await expect(restarted.accessToken()).rejects.toThrow('PLAN_STORAGE_UNAVAILABLE');
  expect(await readFile(path)).toEqual(bytes);
});

it('keeps the same pending setup through protected status polling and repeated begin clicks', async () => {
  const f = await fixture(); const setup = await f.start();
  expect((await f.session.status()).setup).toEqual(setup);
  expect((await f.session.startLogin()).setup).toEqual(setup);
  expect((await f.session.status()).expiresAt).toBe(new Date(f.options.now() + 600_000).toISOString());
  await f.session.completeLogin({ ...setup, code: 'code' });
  expect(await f.session.startLogin()).toMatchObject({ connected: true, state: 'connected' });
  expect((await f.session.startLogin()).setup).toBeUndefined();
});

it('does not issue setup when begin encounters a temporary refresh failure', async () => {
  const f = await fixture(); await f.login(); f.advance(3_550_000); f.setMode('network');
  await expect(f.session.startLogin()).rejects.toThrow('PLAN_TEMPORARY_FAILURE');
  expect((await f.session.status()).setup).toBeUndefined();
});

it('a begin click queued during callback exchange cannot invalidate that exchange', async () => {
  const f = await fixture(); const setup = await f.start();
  const complete = f.session.completeLogin({ ...setup, code: 'code' });
  const begin = f.session.startLogin();
  expect(await complete).toMatchObject({ connected: true });
  expect(await begin).toMatchObject({ connected: true });
  expect((await f.session.status()).setup).toBeUndefined();
});

it('keeps status polling pending while the consumed callback is exchanging and then reports connected', async () => {
  const f = await fixture(); const setup = await f.start();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.setExchangeHandler(async () => { entered(); await held; });
  const completion = f.session.completeLogin({ ...setup, code: 'code' });
  await started;
  try {
    expect(await f.session.status()).toMatchObject({ connected: false, state: 'pending', transport: 'chatgpt-plan', completing: true });
    expect((await f.session.status()).setup).toBeUndefined();
  } finally { release(); }
  expect(await completion).toMatchObject({ connected: true });
  expect(await f.session.status()).toMatchObject({ connected: true, state: 'connected' });
  await expect(f.session.completeLogin({ ...setup, code: 'replay' })).rejects.toThrow('PLAN_OAUTH_TICKET');
});

it('retries persisting the same rotated grant after a write failure without reusing the consumed refresh token', async () => {
  const f = await fixture(); await f.login(); f.advance(3_550_000);
  const destination = join(f.directory, 'session.enc'), backup = join(f.directory, 'session.backup');
  await rename(destination, backup); await mkdir(destination);
  try {
    await expect(f.session.accessToken()).rejects.toThrow(/^PLAN_/);
    expect(f.refreshCount).toBe(1);
    await expect(f.session.accessToken()).rejects.toThrow(/^PLAN_/);
    expect(f.refreshCount).toBe(1);
    expect((await f.session.status()).connected).toBe(false);
    expect(f.refreshCount).toBe(1);
  } finally {
    await rm(destination, { recursive: true }); await rename(backup, destination);
  }
  expect(await Promise.all(Array.from({ length: 8 }, () => f.session.accessToken()))).toEqual(Array(8).fill('access-2'));
  expect(f.refreshCount).toBe(1);
  const restarted = new ChatGPTPlanSession(f.options);
  expect(await restarted.accessToken()).toBe('access-2');
  f.advance(3_550_000);
  expect(await restarted.accessToken()).toBe('access-3');
  expect(f.refreshCount).toBe(2);
});

it('retains confirmed revocation in memory when its write fails and never refreshes or serves it again', async () => {
  const f = await fixture(); await f.login(); f.advance(3_550_000); f.setMode('invalid_grant');
  const destination = join(f.directory, 'session.enc'), backup = join(f.directory, 'session.backup');
  await rename(destination, backup); await mkdir(destination);
  try {
    await expect(f.session.accessToken()).rejects.toThrow('PLAN_RECONNECT_REQUIRED');
    f.setMode('ok');
    await expect(f.session.accessToken()).rejects.toThrow('PLAN_RECONNECT_REQUIRED');
    await expect(f.session.catalog()).rejects.toThrow('PLAN_RECONNECT_REQUIRED');
    expect(await f.session.status()).toMatchObject({ connected: false, message: 'PLAN_RECONNECT_REQUIRED' });
    expect(f.refreshCount).toBe(1);
  } finally {
    await rm(destination, { recursive: true }); await rename(backup, destination);
  }
  await expect(f.session.accessToken()).rejects.toThrow('PLAN_RECONNECT_REQUIRED');
  await expect(new ChatGPTPlanSession(f.options).accessToken()).rejects.toThrow('PLAN_RECONNECT_REQUIRED');
  expect(f.refreshCount).toBe(1);
});

it.each(['invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])('allows reconnect with the saved client after terminal refresh error %s', async code => {
  const f = await fixture(); await f.login(); f.advance(3_550_000); f.setMode(code);
  await expect(f.session.accessToken()).rejects.toThrow('PLAN_RECONNECT_REQUIRED');
  const restarted = new ChatGPTPlanSession(f.options);
  await expect(restarted.accessToken()).rejects.toThrow('PLAN_RECONNECT_REQUIRED');
  const setup = (await restarted.startLogin()).setup!;
  expect(new URL(setup.authorizationUrl).searchParams.get('client_id')).toBe(clientId);
  expect(f.refreshCount).toBe(1);
});
