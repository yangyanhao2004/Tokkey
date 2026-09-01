import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import AccountError from './AccountErrors';

export interface GoogleOAuthProof {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface GoogleAuthorizing {
  authorize(clientId: string): Promise<GoogleOAuthProof>;
  cancelActive(): void;
}

export interface GoogleOAuthAuthorizerOptions {
  timeoutMs?: number;
  openExternal: (url: string) => Promise<void>;
}

/** One system-browser Google OAuth flow with S256 PKCE and a loopback callback. */
export default class GoogleOAuthAuthorizer implements GoogleAuthorizing {
  static readonly callbackPath = '/oauth/google/callback';
  static readonly authorizationTimeoutMs = 120_000;

  private readonly timeoutMs: number;
  private readonly openExternal: (url: string) => Promise<void>;
  private activeAttempt: GoogleOAuthAttempt | null = null;

  constructor(options: GoogleOAuthAuthorizerOptions) {
    this.timeoutMs = options.timeoutMs ?? GoogleOAuthAuthorizer.authorizationTimeoutMs;
    this.openExternal = options.openExternal;
  }

  /** Starts exactly one attempt and releases its listener on every terminal path. */
  async authorize(clientId: string): Promise<GoogleOAuthProof> {
    const normalizedClientId = clientId.trim();
    if (!normalizedClientId || this.activeAttempt) throw new AccountError('unavailable');

    const attempt = new GoogleOAuthAttempt({
      clientId: normalizedClientId,
      timeoutMs: this.timeoutMs,
      openExternal: this.openExternal
    });
    this.activeAttempt = attempt;
    try {
      return await attempt.authorize();
    } finally {
      if (this.activeAttempt === attempt) this.activeAttempt = null;
    }
  }

  /** Cancels a pending browser attempt when its page/window disappears. */
  cancelActive(): void {
    this.activeAttempt?.cancel();
  }
}

interface GoogleOAuthAttemptOptions {
  clientId: string;
  timeoutMs: number;
  openExternal: (url: string) => Promise<void>;
}

/** Owns the listener, secrets, timeout, and terminal state for one OAuth attempt. */
class GoogleOAuthAttempt {
  private readonly state = randomBytes(24).toString('base64url');
  private readonly codeVerifier = randomBytes(32).toString('base64url');
  private readonly server: Server;
  private readonly callbackPromise: Promise<string>;
  private callbackResolve!: (code: string) => void;
  private callbackReject!: (error: AccountError) => void;
  private timeout: NodeJS.Timeout | null = null;
  private isSettled = false;

  constructor(private readonly options: GoogleOAuthAttemptOptions) {
    this.server = createServer((request, response) => this.handleRequest(request, response));
    this.callbackPromise = new Promise<string>((resolve, reject) => {
      this.callbackResolve = resolve;
      this.callbackReject = reject;
    });
    // Listener startup can fail before this promise is awaited; attach a handler immediately.
    void this.callbackPromise.catch(() => undefined);
  }

  async authorize(): Promise<GoogleOAuthProof> {
    this.timeout = setTimeout(() => this.fail(new AccountError('unavailable')), this.options.timeoutMs);
    try {
      const redirectUri = await this.startServer();
      const authorizationUrl = this.createAuthorizationUrl(redirectUri);
      try {
        await this.options.openExternal(authorizationUrl);
      } catch {
        throw new AccountError('unavailable');
      }
      const code = await this.callbackPromise;
      return { code, redirectUri, codeVerifier: this.codeVerifier };
    } catch (error) {
      if (error instanceof AccountError) throw error;
      throw new AccountError('unavailable');
    } finally {
      if (this.timeout) clearTimeout(this.timeout);
      await this.closeServer();
    }
  }

  cancel(): void {
    this.fail(new AccountError('unavailable'));
  }

  /** Binds only IPv4 loopback and resolves after the OS confirms the port is live. */
  private startServer(): Promise<string> {
    return new Promise((resolve, reject) => {
      const handleStartupError = (): void => reject(new AccountError('unavailable'));
      this.server.once('error', handleStartupError);
      this.server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        this.server.off('error', handleStartupError);
        this.server.on('error', () => this.fail(new AccountError('unavailable')));
        const address = this.server.address() as AddressInfo | null;
        if (!address || address.address !== '127.0.0.1') {
          reject(new AccountError('unavailable'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}${GoogleOAuthAuthorizer.callbackPath}`);
      });
    });
  }

  /** Creates the installed-app authorization request without logging its secrets. */
  private createAuthorizationUrl(redirectUri: string): string {
    const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorizationUrl.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: this.state,
      prompt: 'select_account',
      code_challenge: createHash('sha256').update(this.codeVerifier).digest('base64url'),
      code_challenge_method: 'S256'
    }).toString();
    return authorizationUrl.toString();
  }

  /** Treats invalid probes as recoverable and only terminates on a matching callback. */
  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || requestUrl.pathname !== GoogleOAuthAuthorizer.callbackPath) {
      this.respond(response, false);
      return;
    }
    if (requestUrl.searchParams.get('state') !== this.state) {
      this.respond(response, false);
      return;
    }
    if (requestUrl.searchParams.has('error')) {
      this.respond(response, false, () => this.fail(new AccountError('rejected')));
      return;
    }
    const code = requestUrl.searchParams.get('code');
    if (!code) {
      this.respond(response, false);
      return;
    }
    this.respond(response, true, () => this.succeed(code));
  }

  /** Returns a fixed local page without reflecting callback values into HTML. */
  private respond(response: ServerResponse, isSuccess: boolean, onFlushed?: () => void): void {
    const title = isSuccess ? 'Google sign-in complete' : 'Google sign-in request rejected';
    const body = `<html><body><h3>${title}</h3><p>You can return to Tokiie.</p></body></html>`;
    response.writeHead(isSuccess ? 200 : 400, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
      'Cache-Control': 'no-store'
    });
    response.end(body, onFlushed);
  }

  private succeed(code: string): void {
    if (this.isSettled) return;
    this.isSettled = true;
    this.callbackResolve(code);
  }

  private fail(error: AccountError): void {
    if (this.isSettled) return;
    this.isSettled = true;
    this.callbackReject(error);
    void this.closeServer();
  }

  private closeServer(): Promise<void> {
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}
