import { app } from 'electron';

/**
 * Decides which Amis backend this run talks to.
 *
 * Development runs are pointed at staging so local work never writes to the
 * production backend; packaged builds always talk to production. Both origins
 * live here so the account API and the feedback API can never drift apart.
 */
export default class BackendEnvironment {
  /** Staging backend, used by every development run. */
  static readonly stagingOrigin = 'https://amis-wifi-backend-staging-y44em4uiqa-uc.a.run.app';

  /** Production backend. Placeholder until the production host is confirmed. */
  static readonly productionOrigin = 'https://amis-wifi-backend-y44em4uiqa-uc.a.run.app';

  /**
   * An unpackaged process is a development one: `npm run dev` and `npm start`
   * launch Electron straight from the repo, only electron-builder packages.
   *
   * `app` is undefined when these classes are loaded outside an Electron
   * runtime (the test suite does exactly that), which also counts as development.
   */
  static isDevelopment(): boolean {
    return !app?.isPackaged;
  }

  /** The backend origin for this run, or for an explicitly stated environment. */
  static resolveOrigin(isDevelopment: boolean = BackendEnvironment.isDevelopment()): string {
    return isDevelopment ? BackendEnvironment.stagingOrigin : BackendEnvironment.productionOrigin;
  }
}
