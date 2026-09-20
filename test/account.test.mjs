import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import AccountModules from '../dist/main/account/index.js';
import BackendEnvironmentModule from '../dist/main/config/BackendEnvironment.js';
import CountdownTimerModule from '../dist/shared/CountdownTimer.js';

const {
  AccountApiClient,
  AccountConfiguration,
  AccountCredentialVault,
  AccountService,
  GoogleOAuthAuthorizer
} = AccountModules;
const { default: CountdownTimer } = CountdownTimerModule;
const { default: BackendEnvironment } = BackendEnvironmentModule;

const TEST_PROFILE = {
  id: 42,
  email: 'user@example.com',
  displayName: 'Tokkey User',
  emailVerified: true
};

const TEST_CREDENTIAL = {
  profile: TEST_PROFILE,
  accessToken: 'test-access-token',
  accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
  refreshToken: 'test-refresh-token'
};

test('email resend countdown lasts 60 seconds without timer drift', () => {
  const countdown = new CountdownTimer(60);
  const startedAtMs = 10_000;
  const deadlineMs = countdown.start(startedAtMs);

  assert.equal(deadlineMs, 70_000);
  assert.equal(countdown.getSecondsRemaining(deadlineMs, startedAtMs), 60);
  assert.equal(countdown.getSecondsRemaining(deadlineMs, 10_001), 60);
  assert.equal(countdown.getSecondsRemaining(deadlineMs, 69_001), 1);
  assert.equal(countdown.getSecondsRemaining(deadlineMs, deadlineMs), 0);
  assert.equal(countdown.getSecondsRemaining(deadlineMs, deadlineMs + 5_000), 0);
});

/** Records fetch inputs while returning caller-provided Account envelopes. */
class FetchRecorder {
  constructor(...responses) {
    this.responses = responses;
    this.calls = [];
  }

  fetch = async (input, init) => {
    this.calls = [...this.calls, { input: String(input), init }];
    const response = this.responses[this.calls.length - 1];
    if (!response) throw new Error('Unexpected fetch call.');
    return response;
  };
}

/** Reversible non-production codec used to inspect vault behavior without Keychain access. */
class TestCredentialCodec {
  encrypt(value) {
    return Buffer.from(value).reverse();
  }

  decrypt(value) {
    return Buffer.from(value).reverse().toString('utf8');
  }
}

/** In-memory vault whose failure mode verifies publish-after-save ordering. */
class MemoryCredentialVault {
  constructor({ credential = null, shouldFailSave = false } = {}) {
    this.credential = credential;
    this.shouldFailSave = shouldFailSave;
    this.savedCredentials = [];
  }

  async load() {
    return this.credential;
  }

  async save(credential) {
    if (this.shouldFailSave) throw new Error('storage unavailable');
    this.savedCredentials = [...this.savedCredentials, credential];
    this.credential = credential;
  }

  async clear() {
    this.credential = null;
  }
}

/** Backend test adapter that records normalized account intents. */
class RecordingAccountBackend {
  constructor(credential = TEST_CREDENTIAL) {
    this.credential = credential;
    this.emailCodeRequests = [];
    this.emailVerifications = [];
    this.googleProofs = [];
    this.revokedTokens = [];
  }

  async sendEmailVerificationCode(email) {
    this.emailCodeRequests = [...this.emailCodeRequests, email];
  }

  async verifyEmail(email, code) {
    this.emailVerifications = [...this.emailVerifications, { email, code }];
    return this.credential;
  }

  async googleLogin(code, redirectUri, codeVerifier) {
    this.googleProofs = [...this.googleProofs, { code, redirectUri, codeVerifier }];
    return this.credential;
  }

  async logout(refreshToken) {
    this.revokedTokens = [...this.revokedTokens, refreshToken];
  }
}

/** Deterministic authorizer used to keep service tests outside the browser flow. */
class FixedGoogleAuthorizer {
  constructor() {
    this.cancelCount = 0;
  }

  async authorize(clientId) {
    this.clientId = clientId;
    return {
      code: 'google-code',
      redirectUri: 'http://127.0.0.1:49152/oauth/google/callback',
      codeVerifier: 'google-verifier'
    };
  }

  cancelActive() {
    this.cancelCount += 1;
  }
}

/** Browser opener that proves and completes the real temporary callback listener. */
class LoopbackBrowserProbe {
  async open(authorizationUrl) {
    this.authorizationUrl = new URL(authorizationUrl);
    const redirectUri = this.authorizationUrl.searchParams.get('redirect_uri');
    const state = this.authorizationUrl.searchParams.get('state');
    assert.ok(redirectUri);
    assert.ok(state);

    const callbackUrl = new URL(redirectUri);
    assert.equal(callbackUrl.hostname, '127.0.0.1');
    assert.equal(callbackUrl.pathname, '/oauth/google/callback');
    assert.notEqual(callbackUrl.port, '0');

    // A completed HTTP response proves listen() finished before the browser opener ran.
    const wrongPathResponse = await fetch(`${callbackUrl.origin}/wrong-path`);
    assert.equal(wrongPathResponse.status, 400);

    const wrongStateResponse = await fetch(`${redirectUri}?state=wrong&code=ignored`);
    assert.equal(wrongStateResponse.status, 400);

    const successUrl = new URL(redirectUri);
    successUrl.searchParams.set('state', state);
    successUrl.searchParams.set('code', 'google-authorization-code');
    const successResponse = await fetch(successUrl);
    assert.equal(successResponse.status, 200);
    assert.match(await successResponse.text(), /return to Tokkey/);
  }
}

/** Captures the live redirect so cancellation can be tested before a callback arrives. */
class CancellableBrowserProbe {
  constructor() {
    this.opened = new Promise((resolve) => {
      this.resolveOpened = resolve;
    });
  }

  async open(authorizationUrl) {
    const requestUrl = new URL(authorizationUrl);
    this.redirectUri = requestUrl.searchParams.get('redirect_uri');
    this.resolveOpened();
  }
}

test('account configuration uses the environment default and permits loopback development overrides', () => {
  // Outside a packaged Electron build this run counts as development, so the
  // resolved default is staging rather than the production host.
  const resolved = new AccountConfiguration({ environment: {} });
  assert.equal(resolved.origin, BackendEnvironment.stagingOrigin);
  assert.match(resolved.googleClientId, /\.apps\.googleusercontent\.com$/);

  assert.equal(BackendEnvironment.resolveOrigin(true), BackendEnvironment.stagingOrigin);
  assert.equal(BackendEnvironment.resolveOrigin(false), BackendEnvironment.productionOrigin);

  const development = new AccountConfiguration({
    environment: {
      AMIS_ACCOUNT_BACKEND_ORIGIN: 'http://127.0.0.1:8080/',
      AMIS_GOOGLE_OAUTH_CLIENT_ID: 'fixture-client-id'
    }
  });
  assert.equal(development.origin, 'http://127.0.0.1:8080');
  assert.equal(development.googleClientId, 'fixture-client-id');
});

test('Account API sends fixed JSON routes and decodes the complete auth credential', async () => {
  const responseBody = {
    code: 'OK',
    message: 'success',
    data: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresInSeconds: 3600,
      user: TEST_PROFILE
    }
  };
  const fetchRecorder = new FetchRecorder(
    new Response(JSON.stringify({ code: 'OK', data: null }), { status: 200 }),
    new Response(JSON.stringify(responseBody), { status: 200 })
  );
  const client = new AccountApiClient('https://accounts.example.com', fetchRecorder.fetch);

  await client.sendEmailVerificationCode('user@example.com');
  const credential = await client.verifyEmail('user@example.com', '123456');

  assert.equal(fetchRecorder.calls[0].input, 'https://accounts.example.com/api/v1/auth/email-verification-code/send');
  assert.equal(fetchRecorder.calls[0].init.headers.Authorization, undefined);
  assert.equal(fetchRecorder.calls[0].init.body, JSON.stringify({ email: 'user@example.com' }));
  assert.equal(fetchRecorder.calls[1].input, 'https://accounts.example.com/api/v1/auth/email/verify');
  assert.equal(fetchRecorder.calls[1].init.body, JSON.stringify({ email: 'user@example.com', code: '123456' }));
  assert.deepEqual(credential.profile, TEST_PROFILE);
  assert.equal(credential.accessToken, 'access-token');
  assert.equal(credential.refreshToken, 'refresh-token');
  assert.match(credential.accessTokenExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('Account API maps a non-JSON server failure to temporary unavailability', async () => {
  const fetchRecorder = new FetchRecorder(new Response('gateway unavailable', { status: 503 }));
  const client = new AccountApiClient('https://accounts.example.com', fetchRecorder.fetch);
  await assert.rejects(client.sendEmailVerificationCode('user@example.com'), (error) => {
    assert.equal(error.code, 'unavailable');
    return true;
  });
});

test('credential vault replaces one encrypted record and clears it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tokkey-account-'));
  const credentialPath = path.join(directory, 'account-session.enc');
  const vault = new AccountCredentialVault(() => credentialPath, new TestCredentialCodec());
  try {
    await vault.save(TEST_CREDENTIAL);
    const bytes = await readFile(credentialPath);
    assert.equal(bytes.includes(Buffer.from('test-access-token')), false);
    assert.deepEqual(await vault.load(), TEST_CREDENTIAL);
    await vault.clear();
    assert.equal(await vault.load(), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('email service normalizes input and publishes authentication only after vault save', async () => {
  const backend = new RecordingAccountBackend();
  const vault = new MemoryCredentialVault();
  const service = new AccountService(backend, vault, new FixedGoogleAuthorizer(), 'client-id');

  assert.deepEqual(await service.requestEmailCode('  USER@Example.COM  '), { ok: true, value: null });
  const result = await service.verifyEmail('  USER@Example.COM  ', ' 123456 ');

  assert.deepEqual(backend.emailCodeRequests, ['user@example.com']);
  assert.deepEqual(backend.emailVerifications, [{ email: 'user@example.com', code: '123456' }]);
  assert.deepEqual(vault.savedCredentials, [TEST_CREDENTIAL]);
  assert.deepEqual(result, {
    ok: true,
    value: { status: 'authenticated', profile: TEST_PROFILE }
  });
});

test('storage failure leaves the service signed out and revokes the issued refresh token', async () => {
  const backend = new RecordingAccountBackend();
  const vault = new MemoryCredentialVault({ shouldFailSave: true });
  const service = new AccountService(backend, vault, new FixedGoogleAuthorizer(), 'client-id');

  const signInResult = await service.verifyEmail('user@example.com', '123456');
  const stateResult = await service.getState();

  assert.equal(signInResult.ok, false);
  assert.equal(signInResult.error.code, 'unavailable');
  assert.deepEqual(backend.revokedTokens, ['test-refresh-token']);
  assert.deepEqual(stateResult, { ok: true, value: { status: 'signedOut', profile: null } });
});

test('an expired access token is discarded, revoked, and reported as signed out', async () => {
  const backend = new RecordingAccountBackend();
  const vault = new MemoryCredentialVault({
    credential: { ...TEST_CREDENTIAL, accessTokenExpiresAt: '2020-01-01T00:00:00.000Z' }
  });
  const service = new AccountService(backend, vault, new FixedGoogleAuthorizer(), 'client-id');

  const stateResult = await service.getState();

  assert.deepEqual(stateResult, { ok: true, value: { status: 'signedOut', profile: null } });
  assert.equal(vault.credential, null);
  assert.deepEqual(backend.revokedTokens, ['test-refresh-token']);
});

test('a still-valid access token restores the authenticated profile', async () => {
  const backend = new RecordingAccountBackend();
  const vault = new MemoryCredentialVault({ credential: TEST_CREDENTIAL });
  const service = new AccountService(backend, vault, new FixedGoogleAuthorizer(), 'client-id');

  const stateResult = await service.getState();

  assert.deepEqual(stateResult, { ok: true, value: { status: 'authenticated', profile: TEST_PROFILE } });
  assert.deepEqual(backend.revokedTokens, []);
});

test('Google authorizer spawns, validates, and closes an IPv4 loopback callback server', async () => {
  const browserProbe = new LoopbackBrowserProbe();
  const authorizer = new GoogleOAuthAuthorizer({
    timeoutMs: 2_000,
    openExternal: (url) => browserProbe.open(url)
  });

  const proof = await authorizer.authorize('desktop-client-id');
  assert.equal(browserProbe.authorizationUrl.hostname, 'accounts.google.com');
  assert.equal(browserProbe.authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.match(browserProbe.authorizationUrl.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(proof.code, 'google-authorization-code');
  assert.match(proof.codeVerifier, /^[A-Za-z0-9_-]{43}$/);

  await assert.rejects(fetch(proof.redirectUri));
});

test('cancelling Google authorization closes its pending loopback listener', async () => {
  const browserProbe = new CancellableBrowserProbe();
  const authorizer = new GoogleOAuthAuthorizer({
    timeoutMs: 2_000,
    openExternal: (url) => browserProbe.open(url)
  });

  const authorization = authorizer.authorize('desktop-client-id');
  await browserProbe.opened;
  assert.equal((await fetch(browserProbe.redirectUri)).status, 400);
  authorizer.cancelActive();
  await assert.rejects(authorization, (error) => {
    assert.equal(error.code, 'unavailable');
    return true;
  });
  await assert.rejects(fetch(browserProbe.redirectUri));
});

test('Google service sends its proof to the backend and persists the returned credential', async () => {
  const backend = new RecordingAccountBackend();
  const vault = new MemoryCredentialVault();
  const authorizer = new FixedGoogleAuthorizer();
  const service = new AccountService(backend, vault, authorizer, 'desktop-client-id');

  const result = await service.signInWithGoogle();

  assert.equal(authorizer.clientId, 'desktop-client-id');
  assert.deepEqual(backend.googleProofs, [{
    code: 'google-code',
    redirectUri: 'http://127.0.0.1:49152/oauth/google/callback',
    codeVerifier: 'google-verifier'
  }]);
  assert.deepEqual(vault.savedCredentials, [TEST_CREDENTIAL]);
  assert.equal(result.ok, true);
});
