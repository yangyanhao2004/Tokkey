# Desktop Updates

Tokkey uses `electron-builder` for packaging and `electron-updater` for OTA.
The supported release target is macOS Apple Silicon. The gateway, router, and
TokenHub runtimes are copied outside `app.asar` into their existing per-architecture
resource paths. Updates replace the app bundle, including these runtimes; settings,
models, credentials, and chat data remain in their existing user directories.

## Settings Behavior

Settings > Updates shows Check for Updates, Download Update, download progress,
and Restart to Update. Checking and downloading are manual. Closing the app does
not automatically install a downloaded update. Restarting uses Electron's normal
quit lifecycle, including restoring borrowed configurations and stopping runtimes.
Users should finish active tasks before restarting.

An unpackaged development app or a package without an update feed shows updates as
unavailable. "Up to date" appears only after a successful remote check. Errors
offer Try Again, which checks the feed again before another download attempt.
Prereleases and downgrades are disabled.

## Local Package

Use a current Node.js LTS release. Electron's packaging tools require at least
22.12; the existing ML-DSA tests also need a Node runtime with ML-DSA support.
The three `resources/*/arm64` runtime trees must exist. Rebuild the gateway with
`npm run gateway:freeze` when changing its source.

```sh
npm ci
npm run package:mac
```

This produces an unsigned `out/mac-arm64/Tokkey.app` for package inspection.
It is not suitable for testing signed macOS OTA installation or distributing to
users. Without `TOKKEY_UPDATE_URL`, no update configuration is embedded.

## Signed Release

The bundle ID is `app.tokkey.desktop`. Keep it, the product name, and your signing
identity stable after the first release. Configure a Developer ID Application
certificate in the build Mac's keychain, or supply `CSC_LINK` and
`CSC_KEY_PASSWORD` through your CI secrets. Do not use ad-hoc signing for OTA.

Configure one electron-builder notarization credential method:

- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- `APPLE_API_KEY` (key file path), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
- `APPLE_KEYCHAIN_PROFILE`, optionally with `APPLE_KEYCHAIN`.

Choose a public HTTPS directory on your CDN or object storage. For a public GitHub
release repository, a generic feed can use
`https://github.com/OWNER/RELEASES_REPO/releases/latest/download/`.
Do not embed private repository tokens in the app.

```sh
export TOKKEY_UPDATE_URL='https://updates.example.com/tokkey/stable/'
npm version patch --no-git-tag-version
npm run dist:mac
```

`dist:mac` rebuilds the gateway and app, requires a feed and notarization
credentials, and enforces code signing. It creates a DMG for initial installation,
a ZIP for OTA, blockmaps, and `latest-mac.yml` under `out/`. It does not upload or
publish anything. The feed is embedded in `Contents/Resources/app-update.yml`.

Upload the generated DMG, ZIP, and blockmaps to the configured directory without
renaming them, then publish `latest-mac.yml` last. Keep versioned files immutable
and configure the manifest for revalidation or a short cache lifetime. Retain old
release files for clients already downloading them. Never serve a newer manifest
before all its referenced artifacts are available.

## Release Verification

Run `npm run typecheck` and `npm test`. To use Electron's bundled Node runtime
for tests after building, run
`ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test test/*.test.mjs`.
Verify the signed app with
`codesign --verify --deep --strict` and `spctl --assess --type execute`, and validate
the notarization ticket with `xcrun stapler validate` (each takes the app path).

Before shipping OTA, install signed version A into `/Applications`, publish signed
version B to a test feed, and use Settings to check, download, and restart. Verify
the new version, preserved user data, and all three runtimes. Also test offline
checks, a failed download, retry, and quitting after download without installing.
Unit tests use a fake updater; only this signed two-version test verifies the
native macOS replacement and relaunch path.
