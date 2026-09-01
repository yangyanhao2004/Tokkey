import type { AccountProfile } from '../../shared/types';
import AccountError from './AccountErrors';

export interface AccountCredential {
  profile: AccountProfile;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
}

interface AccountEnvelope<T> {
  code?: unknown;
  data?: T;
}

interface AuthResponseData {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresInSeconds?: unknown;
  user?: unknown;
}

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Backend seam used by AccountService and its isolated tests. */
export interface AccountBackend {
  sendEmailVerificationCode(email: string): Promise<void>;
  verifyEmail(email: string, code: string): Promise<AccountCredential>;
  googleLogin(code: string, redirectUri: string, codeVerifier: string): Promise<AccountCredential>;
  logout(refreshToken: string): Promise<void>;
}

/** Narrow Account v1 HTTP client with fixed routes and safe error classification. */
export default class AccountApiClient implements AccountBackend {
  private static readonly requestTimeoutMs = 15_000;

  constructor(
    private readonly origin: string,
    private readonly fetchImplementation: FetchImplementation = fetch
  ) {}

  /** Requests backend-owned verification-code generation and delivery. */
  async sendEmailVerificationCode(email: string): Promise<void> {
    await this.send('/api/v1/auth/email-verification-code/send', { email });
  }

  /** Exchanges an email challenge for one complete credential record. */
  async verifyEmail(email: string, code: string): Promise<AccountCredential> {
    return this.sendAuth('/api/v1/auth/email/verify', { email, code });
  }

  /** Exchanges a Google authorization proof without exposing it outside main. */
  async googleLogin(code: string, redirectUri: string, codeVerifier: string): Promise<AccountCredential> {
    return this.sendAuth('/api/v1/auth/google/login', { code, redirectUri, codeVerifier });
  }

  /** Best-effort remote refresh-token revocation used after local cleanup. */
  async logout(refreshToken: string): Promise<void> {
    await this.send('/api/v1/auth/logout', { refreshToken });
  }

  private async sendAuth(path: string, body: object): Promise<AccountCredential> {
    const envelope = await this.send<AuthResponseData>(path, body);
    return this.parseCredential(envelope.data);
  }

  /** Performs one bounded JSON request and validates the Account envelope. */
  private async send<T = unknown>(path: string, body: object): Promise<AccountEnvelope<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AccountApiClient.requestTimeoutMs);
    try {
      const response = await this.fetchImplementation(`${this.origin}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      let envelope: AccountEnvelope<T>;
      try {
        envelope = await this.parseEnvelope<T>(response);
      } catch (error) {
        if (!response.ok) throw this.errorForStatus(response.status, undefined);
        throw error;
      }
      if (!response.ok) {
        throw this.errorForStatus(response.status, envelope.code);
      }
      if (envelope.code !== 'OK') {
        throw this.errorForBackendCode(envelope.code);
      }
      return envelope;
    } catch (error) {
      if (error instanceof AccountError) throw error;
      throw new AccountError('unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Decodes only the envelope fields needed for stable response classification. */
  private async parseEnvelope<T>(response: Response): Promise<AccountEnvelope<T>> {
    try {
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object') throw new AccountError('invalidResponse');
      return value as AccountEnvelope<T>;
    } catch (error) {
      if (error instanceof AccountError) throw error;
      throw new AccountError('invalidResponse');
    }
  }

  private errorForStatus(status: number, backendCode: unknown): AccountError {
    if (status === 408 || status === 429 || status >= 500) {
      return new AccountError('unavailable');
    }
    return typeof backendCode === 'string'
      ? this.errorForBackendCode(backendCode)
      : new AccountError(status >= 400 && status < 500 ? 'rejected' : 'invalidResponse');
  }

  private errorForBackendCode(code: unknown): AccountError {
    if (typeof code !== 'string') return new AccountError('invalidResponse');
    return code.startsWith('AUTH_') || code === 'VALIDATION_FAILED'
      ? new AccountError('rejected')
      : new AccountError('unavailable');
  }

  /** Requires the complete credential/profile shape before it can reach storage. */
  private parseCredential(data: AuthResponseData | undefined): AccountCredential {
    if (!data || typeof data !== 'object') throw new AccountError('invalidResponse');
    const { accessToken, refreshToken, expiresInSeconds } = data;
    const profile = this.parseProfile(data.user);
    if (
      typeof accessToken !== 'string' || !accessToken ||
      typeof refreshToken !== 'string' || !refreshToken ||
      typeof expiresInSeconds !== 'number' || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0
    ) {
      throw new AccountError('invalidResponse');
    }
    return {
      profile,
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + expiresInSeconds * 1_000).toISOString(),
      refreshToken
    };
  }

  private parseProfile(value: unknown): AccountProfile {
    if (!value || typeof value !== 'object') throw new AccountError('invalidResponse');
    const profile = value as Record<string, unknown>;
    if (
      typeof profile.id !== 'number' || !Number.isFinite(profile.id) ||
      typeof profile.email !== 'string' || !profile.email ||
      (profile.displayName !== null && profile.displayName !== undefined && typeof profile.displayName !== 'string') ||
      typeof profile.emailVerified !== 'boolean'
    ) {
      throw new AccountError('invalidResponse');
    }
    return {
      id: profile.id,
      email: profile.email,
      displayName: typeof profile.displayName === 'string' ? profile.displayName : null,
      emailVerified: profile.emailVerified
    };
  }
}
