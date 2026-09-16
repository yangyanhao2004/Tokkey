# Tokkey

Desktop application built with [Electron](https://www.electronjs.org/).

## Requirements

- Node.js 22.12+ (a current LTS release is recommended for packaging)
- npm 10+

## Getting started

```bash
npm install   # install dependencies
npm run build # compile TypeScript and copy renderer assets
npm start     # run the app
npm run dev   # run with DevTools open
npm run evidence -- --width 1200 --height 800 --output .artifacts/renderer
```

`npm start` and `npm run dev` build the app automatically. TypeScript source is
compiled from `src/` into `dist/`, which is the directory Electron runs.

`npm run evidence` builds a hidden, deterministic renderer window at the
specified Figma content size, captures `renderer.png`, and retains
`renderer-evidence.json` plus `manifest.json` with viewport and semantic element
geometry. Failed captures retain `manifest.json` and `error.txt`. The PNG is
diagnostic evidence; it is not an automatic Figma pixel-diff assertion.

## Project structure

```
src/
├── main/                 # main process (Node side)
│   ├── main.ts           # entry point, boots TokkeyApp
│   ├── TokkeyApp.ts      # app lifecycle + main window
│   ├── IpcController.ts  # all IPC handlers exposed to the renderer
│   ├── preload.ts        # context bridge, exposes window.tokkey
│   ├── gateway/          # local inference gateway subprocess supervisor
│   ├── mcp/              # MCP catalog scanning and configuration
│   ├── mcpnskills/       # skill discovery, install, and deployment
│   └── models/           # local model catalog and download lifecycle
├── renderer/             # renderer process (UI side)
│   ├── index.html        # entry page — currently an empty shell
│   └── window.d.ts       # type declaration for the preload bridge
└── shared/               # contracts shared by both processes
    └── types.ts          # IPC data and bridge contracts
```

> The renderer has no UI right now. `index.html` is an empty shell so the app
> still opens a window; every main-process capability below is still registered
> and reachable over IPC, waiting for a new front end. When you add one, restore
> the stylesheet copy step in the `build` script.

## Local inference gateway

The app runs a loopback-only HTTP gateway as a Python subprocess. It is backed
by the LiteLLM **SDK** (not the LiteLLM proxy CLI) and exposes chat completions,
Responses, and Anthropic Messages over `127.0.0.1`, plus a small management API
for model routes. It was migrated from the Amis-Wifi repository; the OpenSquilla
router difficulty classifier was dropped in the process, which removed
scikit-learn, onnxruntime, lightgbm, scipy, and numpy from the runtime.

```
runtime/amis-gateway/       # Python package, pyproject.toml, uv.lock, tests
src/main/gateway/            # main-process supervisor
├── GatewayProcessManager.ts # spawn, readiness, crash restart, shutdown
├── GatewayRuntimeLocator.ts # finds the frozen executable to run
├── GatewayPortResolver.ts   # picks the port, reclaims it from stale helpers
└── GatewayHealthProbe.ts    # verifies a listener belongs to this app launch
```

### Development setup

```bash
brew install uv                # or https://docs.astral.sh/uv/
npm run gateway:sync           # create runtime/amis-gateway/.venv
npm run gateway:test           # run the Python test suite
```

The virtualenv is for editing and testing the Python source; the app never runs
it. `npm run dev`, `start`, and `evidence` each re-run `gateway:freeze` first,
so a change under `runtime/amis-gateway/src` reaches the app on the next launch
without a separate command. `AMIS_GATEWAY_EXECUTABLE=/path/to/amis-gateway`
overrides the bundle for one run.

`npm test` deliberately does *not* freeze: the gateway tests drive the
supervisor against fakes, so making the JavaScript suite depend on uv and
PyInstaller would buy nothing.

### How the supervisor behaves

- The gateway starts after the main window, so its boot never delays first
  paint, and a startup failure leaves the rest of the app usable.
- The gateway itself is unauthenticated: it listens on loopback only, so a key
  checked at its door would guard nothing the operating system does not already
  guard. Credentials are a per-model concern instead — a local model server is
  called with none, a route with a stored key uses that key, and a route without
  one forwards whatever the calling agent sent.
- Each launch generates an instance id. A listener is adopted
  only if `/health/liveness` reports that same instance id and a matching
  `runtime_protocol_version`, so an orphan from a previous launch is never
  mistaken for the current gateway.
- Port 4033 is preferred. An orphan left by a previous launch of *this* app is
  terminated and the port reclaimed; a port held by any other process is left
  alone and a free port is used instead. Ownership is matched on the executable
  path, because the Amis-Wifi desktop app ships this same gateway and must never
  be killed by this app.
- An unexpected exit is relaunched with exponential backoff, capped at five
  consecutive attempts. Quitting the app stops the gateway.

### The frozen runtime

`npm run gateway:freeze` runs PyInstaller against
`runtime/amis-gateway/packaging/amis-gateway.spec` and writes a self-contained
bundle to `resources/GatewayRuntime/<arch>/amis-gateway/`. The executable there
carries its own CPython and every dependency in a sibling `_internal/`
directory, so no user PATH, Homebrew package, or system Python is involved at
runtime — the supervisor spawns it with nothing but `--host` and `--port`.

A freeze takes ~17s and is not incremental in any useful sense: PyInstaller
re-runs its dependency analysis and rewrites the whole 99MB `COLLECT` tree every
time. `--clean` is left off so the `runtime/amis-gateway/build/` cache is reused,
but that only saves ~2s of the 17 — use `npm run gateway:freeze:clean` after
changing dependencies or the spec, when a stale cache is the likelier suspect.

Rebuilds are not byte-reproducible: `_internal/base_library.zip` (1.3MB) embeds
timestamps and so differs on every run. The frozen bundle and the
`runtime/amis-gateway/build/` cache are ignored by Git; only the gateway source,
packaging inputs, and dependency lockfile are committed.

PyInstaller cannot cross-compile: the bundle always matches the machine that
built it. The packaged target is arm64 macOS, which is the only target the app
supports today (`TokenHubRuntimeLocator` already refuses anything else). An
Intel or Linux build must be produced on that host and land in its own `<arch>`
folder — `process.arch` names the folder verbatim, so Intel macOS is `x64/`.

### Other runtime resources

Router executables are supplied separately and are ignored by Git. Before
running the router or packaging the app, place the matching executable at
`resources/RouterRuntime/<goarch>/router/router-<goos>-<goarch>` (for example,
`resources/RouterRuntime/arm64/router/router-darwin-arm64` on Apple Silicon).
For development, `AMIS_ROUTER_EXECUTABLE=/path/to/router` can override this path.
The router's Go source and build tooling are not included in this repository.

TokenHub obtains its server executable from the Dongle. Its Jinja chat template
under `resources/TokenHubRuntime/` remains committed; local server binaries and
shared libraries are ignored.

## Adding a renderer API

1. Add the handler to `IpcController.handlers` in `src/main/IpcController.ts`.
2. Expose it on `window.tokkey` in `src/main/preload.ts`.

Context isolation is on and node integration is off, so the renderer can only
reach the main process through the channels listed in those two files.

## Packaging

`npm run package:mac` builds an unsigned Apple Silicon app for local inspection.
`npm run dist:mac` builds signed, notarized DMG/ZIP releases and OTA metadata with
electron-builder. Settings uses electron-updater for manual check, download, and
restart actions. See [Desktop Updates](docs/updates.md) for signing credentials,
the update feed, publishing, and release verification.

### macOS code signing and notarization

Signing identifies the developer who built the app. Notarization submits the
signed app to Apple for automated checks so it can be distributed outside the
Mac App Store. Tokkey uses a **Developer ID Application** certificate for its
DMG/ZIP releases and OTA updates.

Your Mac's Apple Account can be different from your Apple Developer account.
There is no need to change the account used for iCloud or macOS. The certificate
and private key live in your current macOS user's **login Keychain**; the Apple
Developer website and notarization use your developer account separately.

#### 1. Create a certificate signing request (one time per signing key)

An active paid Apple Developer Program membership and permission to create
Developer ID certificates are required. Full Xcode is not required for this
manual certificate workflow.

1. Open **Keychain Access** and select **login** in the left sidebar.
2. In the macOS menu bar at the very top of the screen, choose **Keychain Access
   > Certificate Assistant > Request a Certificate From a Certificate Authority**.
   This menu is outside the Keychain Access window; move the pointer to the top
   of the screen if the menu bar is hidden.
3. Enter your developer email and name, leave the CA email blank, and select
   **Saved to disk**.
4. Save the `.certSigningRequest` file. Keychain Access also creates the matching
   private key locally; keep it for the next step.

#### 2. Issue and install the Developer ID Application certificate

1. Sign in to [Apple Developer Certificates](https://developer.apple.com/account/resources/certificates/add)
   with your **developer account**.
2. Select **Developer ID Application**, then **G2 Sub-CA** when asked to choose
   an intermediary. Do not select Developer ID Installer or an App Store
   distribution certificate for this workflow.
3. Upload the CSR, continue, and download the issued `.cer` file.
4. On the same Mac that generated the CSR, open Keychain Access, select **login**,
   and choose **File > Import Items** to import the `.cer` into that keychain.
5. Under **My Certificates**, expand the certificate and confirm that its
   private key appears beneath it. The `.cer` alone cannot sign an app.

If importing reports **error -25294**, macOS could not find the destination
keychain. Explicitly select **login**, rather than iCloud, and retry with
**File > Import Items**. If asked to unlock the keychain, use your **Mac login
password**, not your Apple Developer account password.

#### 3. Verify the signing identity and repair a missing trust chain

```sh
security find-identity -v -p codesigning
```

For this project's developer team, the expected identity is:

```text
Developer ID Application: Wange Zhiyuan (Beijing) Intelligent Technology Co., Ltd. (NXPRFQRFXA)
```

If Keychain Access says the certificate is **not trusted**, check whether Apple's
**Developer ID Certification Authority (G2)** intermediate certificate is missing.
This was the cause during our setup. Download the intermediate from Apple's
official website, verify it against macOS's trusted roots, and import it only
after verification succeeds:

```sh
curl -fL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer \
  -o /tmp/DeveloperIDG2CA.cer
security verify-cert -c /tmp/DeveloperIDG2CA.cer -p basic
security add-certificates -k "$HOME/Library/Keychains/login.keychain-db" \
  /tmp/DeveloperIDG2CA.cer
security find-identity -v -p codesigning
```

The Developer ID Application identity should now appear in the valid identities
list. Reopen Keychain Access to refresh its displayed status. Do not work around
a broken chain by changing the certificate to **Always Trust**. If it remains
invalid, inspect its validity dates, private key, and certificate chain before
building a release.

Back up the certificate **with its private key** by exporting it from Keychain
Access as a password-protected `.p12`. To sign on another Mac or in CI, import
that backup or configure electron-builder with `CSC_LINK` (the `.p12` path) and
`CSC_KEY_PASSWORD`. Keep the backup and passwords out of the repository.

#### 4. Configure notarization credentials (one time per build Mac)

Install Apple's command-line tools if they are not already available:

```sh
xcode-select --install
```

Sign in to [account.apple.com](https://account.apple.com) with your **developer
account**, then open **Sign-In and Security > App-Specific Passwords** and
generate a password for notarization. Store it in a Keychain profile:

```sh
xcrun notarytool store-credentials "tokkey-notary" \
  --apple-id "develop@cpilot.net" \
  --team-id "NXPRFQRFXA"
```

Replace the email placeholder with your developer account email and enter the
app-specific password at the prompt. This is not your Mac login password or your
normal Apple Account password. The profile stores credentials in Keychain, so
the password does not need to appear in shell history or source files.

#### 5. Build and verify each release

**Before building each new release for distribution, increase the app version.**
OTA only offers versions newer than the installed version; rebuilding with the
same version will not notify existing users of an update.

```sh
npm version patch --no-git-tag-version
```

For example, this changes `0.1.0` to `0.1.1` in both `package.json` and
`package-lock.json`, without creating a Git commit or tag. Use `minor` or `major`
instead of `patch` when appropriate. Bump once per new release, then build:

```sh
export APPLE_KEYCHAIN_PROFILE="tokkey-notary"
export TOKKEY_UPDATE_URL="https://github.com/cPilot-GUI/Tokkey/releases/latest/download/"
npm run dist:mac
```

electron-builder automatically discovers the Developer ID certificate in your
Keychain. This command rebuilds the gateway and app, signs the app, notarizes it,
and creates the DMG, ZIP, blockmaps, and `latest-mac.yml` under `out/`. It requires
signing and notarization configuration and does **not** publish the files.

Note: build is fast, but Apples'notarization can take hours, so be patient!
Once it succeeds, you will see messaging like this:
```
• signing         file=out/mac-arm64/Tokkey.app platform=darwin type=distribution identityName=Developer ID Application: Wange Zhiyuan (Beijing) Intelligent Technology Co., Ltd. (NXPRFQRFXA) identityHash=037C67D74DECB4AB4ADC5312B7A38A84AA3A3904 provisioningProfile=none

  • notarization successful
  • building        target=macOS zip arch=arm64 file=out/Tokkey-0.1.0-arm64.zip
  • building        target=DMG arch=arm64 file=out/Tokkey-0.1.0-arm64.dmg
  • downloading     label=dmgbuild-bundle-arm64-75c8a6c.tar.gz
    [==================================================================================] 100% | dmgbuild-bundle-arm64-75c8a6c.tar.gz
  • building block map  blockMapFile=out/Tokkey-0.1.0-arm64.zip.blockmap
  • building block map  blockMapFile=out/Tokkey-0.1.0-arm64.dmg.blockmap
```

Verify the resulting app before distribution:

```sh
codesign --verify --deep --strict out/mac-arm64/Tokkey.app
spctl --assess --type execute out/mac-arm64/Tokkey.app
xcrun stapler validate out/mac-arm64/Tokkey.app
```

#### 6. Publish and test OTA

`npm run dist:mac` only generates artifacts; upload them to **GitHub Release
assets**, not to the repository's source files. The repository must be public
for the configured unauthenticated update feed.

1. Open [Tokkey Releases](https://github.com/cPilot-GUI/Tokkey/releases) and click
   **Draft a new release**.
2. Under **Choose a tag**, select or create a tag matching the built app version,
   such as `v0.1.1` for version `0.1.1`. Select the intended release commit as the
   target when creating a new tag.
3. Enter a title such as **Tokkey v0.1.1** and describe the changes.
4. Drag the current build's release files from `out/` into the attachments area:
   the `.dmg` for initial installation, `.zip` for OTA, and generated `.blockmap`
   files for incremental downloads. Upload **`latest-mac.yml` last**. Preserve
   every filename and use artifacts from the same build; do not upload the
   unpacked `mac-arm64/` directory or builder diagnostic files.
5. Wait for every upload to finish. Click **Save draft** to keep the release
   unpublished while checking the assets.
6. Edit the draft, leave **Set as a pre-release** unchecked, select **Set as the
   latest release**, and click **Publish release** when ready.

The updater uses this base URL:

```text
https://github.com/cPilot-GUI/Tokkey/releases/latest/download/
```

The base URL is not a browsable directory and may return 404 when opened directly.
After publishing, verify that
[latest-mac.yml](https://github.com/cPilot-GUI/Tokkey/releases/latest/download/latest-mac.yml)
and the filenames it references are downloadable. Draft releases are not
available through this public update feed.

For each subsequent update, bump the version, rebuild, verify, and create a new
release with its own complete set of assets. Avoid replacing files in an already
published release: users may be downloading them, and the manifest's checksums
must match. Keep the bundle ID (`app.tokkey.desktop`), product name, and signing
identity consistent across releases.

Before enabling OTA for users, install signed version A into `/Applications`,
build and publish a higher version B using the same feed and signing identity,
then test **Settings > Check for Updates > Download Update > Restart to Update**.
Confirm the new version, preserved user data, and working bundled runtimes.
An unsigned `npm run package:mac` build cannot validate the signed OTA path.
