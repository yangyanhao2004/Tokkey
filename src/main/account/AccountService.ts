import type {
  AccountOperationResult,
  AccountState
} from '../../shared/types';
import type { AccountBackend, AccountCredential } from './AccountApiClient';
import type { CredentialVault } from './AccountCredentialVault';
import AccountError from './AccountErrors';
import type { GoogleAuthorizing } from './GoogleOAuthAuthorizer';

/** Coordinates validation, external auth, atomic persistence, and public state. */
export default class AccountService {
  private credential: AccountCredential | null = null;
  private restorePromise: Promise<void> | null = null;
  private hasRestored = false;

  constructor(
    private readonly backend: AccountBackend,
    private readonly vault: CredentialVault,
    private readonly googleAuthorizer: GoogleAuthorizing,
    private readonly googleClientId: string
  ) {}

  async getState(): Promise<AccountOperationResult<AccountState>> {
    return this.perform(async () => {
      await this.restoreIfNeeded();
      await this.discardExpiredSession();
      return this.currentState();
    });
  }

  async requestEmailCode(rawEmail: string): Promise<AccountOperationResult<null>> {
    return this.perform(async () => {
      await this.backend.sendEmailVerificationCode(this.normalizeEmail(rawEmail));
      return null;
    });
  }

  async verifyEmail(rawEmail: string, rawCode: string): Promise<AccountOperationResult<AccountState>> {
    return this.perform(async () => {
      await this.restoreIfNeeded();
      const email = this.normalizeEmail(rawEmail);
      const code = rawCode.trim();
      if (!/^\d{6}$/.test(code)) throw new AccountError('invalidCode');
      const credential = await this.backend.verifyEmail(email, code);
      await this.establishSession(credential);
      return this.currentState();
    });
  }

  async signInWithGoogle(): Promise<AccountOperationResult<AccountState>> {
    return this.perform(async () => {
      await this.restoreIfNeeded();
      const proof = await this.googleAuthorizer.authorize(this.googleClientId);
      const credential = await this.backend.googleLogin(
        proof.code,
        proof.redirectUri,
        proof.codeVerifier
      );
      await this.establishSession(credential);
      return this.currentState();
    });
  }

  /** Stops the loopback listener without waiting for its total timeout. */
  cancelGoogleSignIn(): void {
    this.googleAuthorizer.cancelActive();
  }

  async signOut(): Promise<AccountOperationResult<AccountState>> {
    return this.perform(async () => {
      await this.restoreIfNeeded();
      const refreshToken = this.credential?.refreshToken ?? null;
      await this.vault.clear();
      this.credential = null;
      if (refreshToken) {
        // Local sign-out is authoritative; network revocation is best effort.
        await this.backend.logout(refreshToken).catch(() => undefined);
      }
      return this.currentState();
    });
  }

  /**
   * Drops a session whose access token has already lapsed. There is no refresh
   * exchange, so an expired token means the user must sign in again; the
   * in-memory drop is authoritative and cleanup is best effort because the
   * session is already dead either way.
   */
  private async discardExpiredSession(): Promise<void> {
    if (!this.credential || !this.hasExpired(this.credential.accessTokenExpiresAt)) return;
    const refreshToken = this.credential.refreshToken;
    this.credential = null;
    await this.vault.clear().catch(() => undefined);
    await this.backend.logout(refreshToken).catch(() => undefined);
  }

  /** An unreadable expiry cannot be trusted, so it counts as expired. */
  private hasExpired(accessTokenExpiresAt: string): boolean {
    const expiresAtMs = Date.parse(accessTokenExpiresAt);
    return Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now();
  }

  /** Saves before publishing authenticated state and revokes on storage failure. */
  private async establishSession(credential: AccountCredential): Promise<void> {
    try {
      await this.vault.save(credential);
      this.credential = credential;
      this.hasRestored = true;
    } catch {
      this.credential = null;
      await this.backend.logout(credential.refreshToken).catch(() => undefined);
      throw new AccountError('unavailable');
    }
  }

  private async restoreIfNeeded(): Promise<void> {
    if (this.hasRestored) return;
    if (!this.restorePromise) {
      this.restorePromise = this.vault.load().then((credential) => {
        this.credential = credential;
        this.hasRestored = true;
      });
    }
    try {
      await this.restorePromise;
    } finally {
      if (!this.hasRestored) this.restorePromise = null;
    }
  }

  private currentState(): AccountState {
    return this.credential
      ? { status: 'authenticated', profile: this.credential.profile }
      : { status: 'signedOut', profile: null };
  }

  private normalizeEmail(rawEmail: string): string {
    const email = rawEmail.trim().toLowerCase();
    if (!email.includes('@')) throw new AccountError('invalidEmail');
    return email;
  }

  /** Centralizes safe error projection for every renderer-facing operation. */
  private async perform<T>(operation: () => Promise<T>): Promise<AccountOperationResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return { ok: false, error: AccountError.publicError(error) };
    }
  }
}
