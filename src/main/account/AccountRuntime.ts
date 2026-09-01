import path from 'node:path';
import { app, safeStorage, shell } from 'electron';
import AccountApiClient from './AccountApiClient';
import AccountConfiguration from './AccountConfiguration';
import AccountCredentialVault, { type CredentialCodec } from './AccountCredentialVault';
import AccountError from './AccountErrors';
import GoogleOAuthAuthorizer from './GoogleOAuthAuthorizer';
import AccountService from './AccountService';

/** Electron safeStorage uses the user's login Keychain on macOS. */
class ElectronCredentialCodec implements CredentialCodec {
  encrypt(value: string): Buffer {
    if (!safeStorage.isEncryptionAvailable()) throw new AccountError('unavailable');
    return safeStorage.encryptString(value);
  }

  decrypt(value: Buffer): string {
    if (!safeStorage.isEncryptionAvailable()) throw new AccountError('unavailable');
    return safeStorage.decryptString(value);
  }
}

/** Composes the production account adapters without exposing Electron to the domain service. */
export default class AccountRuntime {
  static create(): AccountService {
    const configuration = new AccountConfiguration();
    const backend = new AccountApiClient(configuration.origin);
    const vault = new AccountCredentialVault(
      () => path.join(app.getPath('userData'), 'account-session.enc'),
      new ElectronCredentialCodec()
    );
    const googleAuthorizer = new GoogleOAuthAuthorizer({
      openExternal: async (url) => {
        await shell.openExternal(url);
      }
    });
    return new AccountService(
      backend,
      vault,
      googleAuthorizer,
      configuration.googleClientId
    );
  }
}
