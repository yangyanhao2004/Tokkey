import { promises as fileSystem } from 'node:fs';
import path from 'node:path';
import type { AccountCredential } from './AccountApiClient';
import AccountError from './AccountErrors';

export interface CredentialCodec {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface CredentialVault {
  load(): Promise<AccountCredential | null>;
  save(credential: AccountCredential): Promise<void>;
  clear(): Promise<void>;
}

/** Stores one encrypted credential record with an atomic file replacement. */
export default class AccountCredentialVault implements CredentialVault {
  constructor(
    private readonly credentialPath: () => string,
    private readonly codec: CredentialCodec
  ) {}

  async load(): Promise<AccountCredential | null> {
    try {
      const encrypted = await fileSystem.readFile(this.credentialPath());
      const value: unknown = JSON.parse(this.codec.decrypt(encrypted));
      if (!this.isCredential(value)) throw new AccountError('unavailable');
      return value;
    } catch (error) {
      if (this.isMissingFile(error)) return null;
      if (error instanceof AccountError) throw error;
      throw new AccountError('unavailable');
    }
  }

  async save(credential: AccountCredential): Promise<void> {
    const destination = this.credentialPath();
    const temporaryPath = `${destination}.tmp-${process.pid}-${Date.now()}`;
    try {
      const encrypted = this.codec.encrypt(JSON.stringify(credential));
      await fileSystem.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fileSystem.writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await fileSystem.rename(temporaryPath, destination);
    } catch {
      await fileSystem.unlink(temporaryPath).catch(() => undefined);
      throw new AccountError('unavailable');
    }
  }

  async clear(): Promise<void> {
    try {
      await fileSystem.unlink(this.credentialPath());
    } catch (error) {
      if (!this.isMissingFile(error)) throw new AccountError('unavailable');
    }
  }

  /** Rejects corrupted decrypted records before they can restore a session. */
  private isCredential(value: unknown): value is AccountCredential {
    if (!value || typeof value !== 'object') return false;
    const credential = value as Partial<AccountCredential>;
    return Boolean(
      credential.profile &&
      typeof credential.profile.id === 'number' &&
      typeof credential.profile.email === 'string' &&
      (credential.profile.displayName === null || typeof credential.profile.displayName === 'string') &&
      typeof credential.profile.emailVerified === 'boolean' &&
      typeof credential.accessToken === 'string' &&
      typeof credential.accessTokenExpiresAt === 'string' &&
      typeof credential.refreshToken === 'string'
    );
  }

  private isMissingFile(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
  }
}
