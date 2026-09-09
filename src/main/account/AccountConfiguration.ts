import BackendEnvironment from '../config/BackendEnvironment';
import AccountError from './AccountErrors';

export interface AccountConfigurationOptions {
  environment?: NodeJS.ProcessEnv;
  /** Overrides the origin this run would otherwise pick for its environment. */
  defaultOrigin?: string;
  defaultGoogleClientId?: string;
}

/** Validates the public Account backend and Google desktop-client configuration. */
export default class AccountConfiguration {
  static readonly defaultGoogleClientId =
    '947027167514-vo8h45360bfev2e79av8k78erbq38rs4.apps.googleusercontent.com';

  readonly origin: string;
  readonly googleClientId: string;

  constructor(options: AccountConfigurationOptions = {}) {
    const environment = options.environment ?? process.env;
    this.origin = this.requireOrigin(
      environment.AMIS_ACCOUNT_BACKEND_ORIGIN ??
        options.defaultOrigin ??
        BackendEnvironment.resolveOrigin()
    );
    this.googleClientId = this.requireGoogleClientId(
      environment.AMIS_GOOGLE_OAUTH_CLIENT_ID ??
        options.defaultGoogleClientId ??
        AccountConfiguration.defaultGoogleClientId
    );
  }

  /** Accepts HTTPS origins plus explicit loopback HTTP used by local development. */
  private requireOrigin(rawOrigin: string): string {
    try {
      const origin = new URL(rawOrigin.trim());
      const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(origin.hostname);
      const hasOnlyAuthority = origin.pathname === '/' && !origin.username && !origin.password &&
        !origin.search && !origin.hash;
      if (!hasOnlyAuthority || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && isLoopback))) {
        throw new AccountError('unavailable');
      }
      return origin.origin;
    } catch (error) {
      if (error instanceof AccountError) throw error;
      throw new AccountError('unavailable');
    }
  }

  /** Rejects empty build placeholders before a broken browser flow can start. */
  private requireGoogleClientId(rawClientId: string): string {
    const clientId = rawClientId.trim();
    if (!clientId || clientId.includes('$(') || clientId.startsWith('YOUR_')) {
      throw new AccountError('unavailable');
    }
    return clientId;
  }
}
