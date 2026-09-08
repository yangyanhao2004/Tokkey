/** Keeps local packages and signed OTA releases on the same resource layout. */
class PackagingConfiguration {
  constructor(environment = process.env) {
    this.environment = environment;
  }

  create() {
    const isRelease = this.environment.TOKKEY_RELEASE === '1';
    const updateUrl = this.updateUrl();
    if (isRelease) this.validateRelease(updateUrl);

    return {
      appId: 'app.tokkey.desktop',
      productName: 'Tokkey',
      directories: { output: 'out' },
      asar: true,
      npmRebuild: false,
      files: ['dist/**/*', 'package.json', '!dist/**/*.map'],
      extraResources: ['GatewayRuntime', 'RouterRuntime', 'TokenHubRuntime'].map((name) => ({
        from: `resources/${name}/arm64`,
        to: `${name}/arm64`,
        filter: ['**/*']
      })),
      artifactName: '${productName}-${version}-${arch}.${ext}',
      // A null publisher prevents inference from the private source repository.
      publish: updateUrl ? [{ provider: 'generic', url: updateUrl }] : null,
      forceCodeSigning: isRelease,
      mac: {
        target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
        category: 'public.app-category.productivity',
        type: 'distribution',
        hardenedRuntime: true,
        // The bundled Python and llama runtimes dlopen sibling libraries, so the
        // hardened runtime needs library validation relaxed for them to launch.
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.inherit.plist',
        notarize: isRelease,
        ...(isRelease ? {} : { identity: null })
      }
    };
  }

  updateUrl() {
    const value = this.environment.TOKKEY_UPDATE_URL?.trim();
    if (!value) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('TOKKEY_UPDATE_URL must be an HTTPS directory URL without credentials, a query, or a fragment.');
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  }

  validateRelease(updateUrl) {
    if (!updateUrl) throw new Error('Set TOKKEY_UPDATE_URL before building an OTA release.');
    const environment = this.environment;
    const hasAppleId = environment.APPLE_ID && environment.APPLE_APP_SPECIFIC_PASSWORD && environment.APPLE_TEAM_ID;
    const hasApiKey = environment.APPLE_API_KEY && environment.APPLE_API_KEY_ID && environment.APPLE_API_ISSUER;
    if (!hasAppleId && !hasApiKey && !environment.APPLE_KEYCHAIN_PROFILE) {
      throw new Error('Configure Apple notarization credentials before building an OTA release; see docs/updates.md.');
    }
    if (environment.CSC_NAME === '-') throw new Error('OTA releases require a Developer ID certificate, not ad-hoc signing.');
  }
}

module.exports = PackagingConfiguration;
