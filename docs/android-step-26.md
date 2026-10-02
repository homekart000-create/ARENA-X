# Step 26 — Android packaging

## 1. Scope

Step 26 prepares an Android application wrapper for the existing ARENA X web/PWA project. It does not change the root website or publish to any store. Step 27 has not been started. No production API URL, provider credentials, signing key, keystore, or Play Console details have been supplied or invented.

## 2. Packaging approach

The project uses **Capacitor 8** with a checked-in native Android project. ARENA X is already a multipage static HTML/CSS/JavaScript application with a service worker and manifest; Capacitor packages those local assets in an Android WebView without replacing the UI or moving the app to a remote-only webview. Native plugins are limited to app/back handling, secure external-browser opening, keyboard resizing, splash, and status-bar configuration.

This keeps GitHub Pages and the existing PWA deployment unchanged. The Android build stages only the public HTML, CSS, JavaScript, image assets, manifest, and service worker; it does not copy the backend, docs, tests, environment files, or repository metadata into the WebView bundle.

## 3. Android project structure

- `capacitor.config.json` — Capacitor app identity, staged web directory, plugin and mixed-content settings.
- `android/` — native Gradle project, Android manifest, Java activity, icons, splash resources, and debug/release configuration.
- `scripts/build-android-web.mjs` — isolated web-asset staging and Android API-origin validation.
- `scripts/native-back-navigation.mjs` — bundled native back-button and external-link behavior.
- `android-web/` — generated/ignored staging directory; do not edit or commit it.

## 4. Package ID, app name, and version

- Application ID / namespace: `com.arenax.app`
- App name and launcher label: `ARENA X`
- `versionName`: `1.0.0`
- `versionCode`: `1`
- Minimum SDK: 24
- Compile SDK / target SDK: 36 / 36, from the generated Capacitor 8 Android template

Raise `versionCode` for each subsequent Android upload; do not change the stable application ID.

## 5. Tooling requirements

The native project uses its checked-in Gradle wrapper (Gradle 8.14.3) and Android Gradle Plugin 8.13.0. Install Android Studio with Android SDK Platform 36 and matching build tools, plus a supported JDK (use JDK 21 for this toolchain). `ANDROID_HOME` or `ANDROID_SDK_ROOT` must point to the SDK. Capacitor core/Android are 8.5.2; the CLI is pinned to 8.4.3 because npm audit reported an advisory in the 8.5.x CLI dependency tree. `cap sync` and Capacitor Doctor both succeeded with this combination, and the root dependency audit is clean.

At the time of this check, Node was v24.21.0 and npm v11.19.0. The machine only exposed a Java 8 JRE; `javac` and `keytool` were unavailable. Neither Android Studio nor an Android SDK was found, and `ANDROID_HOME`/`ANDROID_SDK_ROOT` were unset. System Gradle/ADB were not on `PATH`; the checked-in Gradle wrapper downloaded and started Gradle, but `assembleDebug` stopped before Android compilation because the Android Gradle Plugin dependency requires a newer JVM. No APK or AAB was produced.

## 6. API configuration

The Android package uses the existing `ARENA_API_BASE_URL` configuration hook. The staging script injects that value only into generated Android HTML; it does not alter the GitHub Pages pages or their relative asset paths.

Set `ANDROID_API_BASE_URL` to the **origin only** of the real HTTPS API before any release build. The release staging command rejects a missing value, localhost, credentials, non-HTTPS URLs, and URLs containing a path/query/fragment. No production API origin is currently available, so Android staging is explicitly unconfigured and backend operations will show the existing unavailable/error states rather than silently use localhost or pretend to succeed.

For a debug-only local API, the API helper accepts HTTP localhost and the debug manifest allows cleartext only for `localhost`/`127.0.0.1`; all other cleartext is denied by the debug network-security configuration. Use `adb reverse tcp:3000 tcp:3000` when testing an emulator against a host-local API. For authenticated testing, use HTTPS and an appropriately trusted development certificate; do not disable certificate validation.

The packaged app origin is `https://localhost`. For cross-origin API sessions, configure the backend to allow the exact `https://localhost` origin in `CORS_ORIGINS` (with credentials), alongside the normal web origin. Do not use a wildcard. Production auth cookies are already `HttpOnly`, `Secure`, and `SameSite=None`. The Android activity enables third-party cookies only in the app WebView because the local app origin and HTTPS API are cross-origin; the app currently embeds no remote content. Session acceptance still requires live CORS/cookie verification against the deployed API.

## 7. Web/PWA compatibility and offline behavior

Root HTML, scripts, styles, the web manifest, service worker, and PWA icons are copied without rewriting their GitHub Pages paths. Android-only configuration/bootstrap scripts are injected into staged copies. The service worker continues to cache the existing static shell; API requests are not cached. Navigations show the existing offline document when unavailable, while API requests surface the existing backend-unavailable state.

Android serves its packaged assets on Capacitor's secure `https://localhost` origin. No Android production setting enables mixed content. The existing web deployment remains rooted at its current GitHub Pages path.

## 8. Permissions

Only `android.permission.INTERNET` is declared. There is no existing file-upload control or camera, location, contacts, microphone, or notification requirement. No such permissions were added. The generated file provider is not an Android runtime permission.

## 9. Icons and branding

Android launcher resources use the ARENA X lime/charcoal/light palette and a centered AX mark derived from the existing wordmark. Adaptive icons are configured for Android 8.0+ with a dark background and a vector foreground kept within the central safe area; an any-density vector fallback is provided for earlier supported Android versions. The existing PWA `icon-192.png` and `icon-512.png` are unchanged.

## 10. Splash screen and system bars

The native launch theme uses a dark background and centered ARENA X vector mark. Capacitor's splash plugin is configured to auto-hide without showing a second placeholder image. Status and navigation bars use the existing dark theme with light foreground icons; the status bar does not overlay the page. The keyboard plugin resizes the page body for form entry.

## 11. Navigation and external links

The Capacitor App plugin handles Android back presses: it returns through WebView history when possible and exits the app from the root page. The Browser plugin opens external HTTPS anchors in the system browser/custom tab instead of navigating the local application WebView to another origin. A source scan found no current external anchors, `target="_blank"` links, or file upload inputs.

The app is portrait-locked to match the PWA's declared orientation. The existing auth code refreshes the backend session when the document becomes visible, which is the resume path used by the native WebView. The status bar does not overlay content; no custom edge-to-edge mode is enabled. No Android emulator/device was available to verify runtime back, keyboard, orientation, or resume behavior.

## 12. Security configuration

- Native WebView content is packaged locally; the backend API origin is supplied at build time and release builds require HTTPS.
- Release `usesCleartextTraffic` is false. Mixed content is disabled.
- Cleartext access is confined to debug builds and the `localhost`/`127.0.0.1` development domains.
- HTTPS certificate validation has not been bypassed or customized.
- Android backup is disabled to avoid backing up WebView/session state.
- API calls retain `credentials: include`; the app stores no password or session token in JavaScript storage.
- Backend wallet, payment, KYC, withdrawal, room-credential, and authorization controls remain server-side and are not bundled.
- Android web staging is allowlist-based. `.env` files and release keystore patterns are ignored; no provider/backend secret is needed by the Android package.
- Third-party cookies are enabled only for this app's local WebView to support the existing cross-origin `HttpOnly; Secure; SameSite=None` production session cookie. The backend's exact CORS origin and cookie behavior must still be tested in an authorized deployment.

## 13. Signing configuration

No release keystore or signing credentials exist in this repository/environment. The Gradle release build reads these process environment variables only:

- `ANDROID_RELEASE_STORE_FILE`
- `ANDROID_RELEASE_STORE_PASSWORD`
- `ANDROID_RELEASE_KEY_ALIAS`
- `ANDROID_RELEASE_KEY_PASSWORD`

When all four are present, the release build uses them. If only some are set, Gradle fails rather than silently making a partially configured signing setup. If none are set, release outputs are unsigned and are not ready to install or upload. Passwords are not printed or hardcoded. Keystore files (`*.jks`, `*.keystore`) are ignored; keep the actual key outside the repository and back it up securely.

After installing JDK 21, create a private key outside the repository with the interactive `keytool` prompt (do not put passwords on the command line):

```powershell
keytool -genkeypair -v -keystore "$env:USERPROFILE\arenax-release.jks" -alias arenax-release -keyalg RSA -keysize 4096 -validity 10000
```

Then provide the four values through a protected local/CI secret mechanism for the build process. Set `ANDROID_RELEASE_STORE_FILE` to the absolute keystore path and `ANDROID_RELEASE_KEY_ALIAS` to `arenax-release`; enter the store and key passwords only through the protected secret mechanism. Never commit or email the keystore.

## 14. Build commands

From the repository root on Windows:

```powershell
npm ci
npm run android:debug
```

The debug APK output, when the JDK and SDK are installed, is:

`android/app/build/outputs/apk/debug/app-debug.apk`

Before release staging, configure the real API origin:

```powershell
$env:ANDROID_API_BASE_URL = 'https://<your-real-api-origin>'
npm run android:release:apk
npm run android:release:aab
```

The API value above is a placeholder, not a production URL. Replace it only with the authorized deployed HTTPS API origin. Outputs are under:

- APK: `android/app/build/outputs/apk/release/` (unsigned filename when release signing is not configured)
- AAB: `android/app/build/outputs/bundle/release/app-release.aab` (unsigned when release signing is not configured)

The release commands require an HTTPS API origin, but signing is optional for producing unsigned QA outputs. A Play-uploadable artifact requires the real protected signing configuration. APK/AAB output directories and generated staging/build contents are ignored by Git.

## 15. Local testing

1. Install JDK 21 and Android Studio/SDK Platform 36; set `JAVA_HOME` and `ANDROID_HOME` or `ANDROID_SDK_ROOT`.
2. Run `npm ci`, then `npm run android:sync`.
3. Open `android/` in Android Studio or run `npm run android:debug`.
4. For a local emulator API, set `ANDROID_API_BASE_URL=http://localhost:3000`, configure `adb reverse tcp:3000 tcp:3000`, and use the debug build only. For real authenticated testing, use the authorized HTTPS API and exact `https://localhost` backend CORS origin.
5. Verify sign-in/session persistence, sign-out/revocation, offline/API-unavailable behavior, navigation/back handling, keyboard/safe-area behavior, links, and wallet/payment/KYC/withdrawal server-side enforcement on a device/emulator.
6. Do not use real-money flows until their independent backend/provider release gates have passed.

## 16. Verification results

- Capacitor 8 Android scaffold created and `cap sync android` completed; five plugins were synchronized.
- Android package configuration: `com.arenax.app`; version `1.0.0` / code `1`.
- Android resource/manifest XML parsing: 20 files, 0 parse failures.
- Android packaging tests: 3 passed, 0 failed. They verify mandatory release API configuration, HTTPS/non-localhost release policy, and staged asset isolation.
- Root npm dependency audit: 0 vulnerabilities after rejecting/removing an optional asset generator whose dependency tree introduced advisories.
- Web staging includes the 15 existing HTML pages and public static assets only; release configuration tests used a reserved `.test` origin and did not build or ship an artifact.
- Existing web pages were navigated at desktop (1365 px) and mobile (390 px) widths: all 15 pages were reachable and showed no horizontal overflow. Protected pages can redirect to login without an authenticated session. Browser API requests failed with `ERR_CONNECTION_REFUSED` because the local backend was not running; this was not live API verification.
- `npm run android:debug` was attempted. It failed before Android compilation because this machine has Java 8, while the Android Gradle Plugin requires a newer JDK. Android SDK/Studio are also absent.
- Release APK/AAB builds are blocked both by missing production API origin and missing JDK/SDK. No APK or AAB exists; none is claimed as generated or signed.
- No Android emulator/browser runtime test, device cookie test, or live backend/API test was possible.

## 17. Existing web/backend regression

The Android builder leaves the existing root HTML/CSS/JS/PWA source unchanged. The Android-specific packaging tests, frontend auth/competition/wallet tests, backend test suite, TypeScript checks/build, JavaScript syntax checks, static path/reference checks, backend and root dependency audits, and `git diff --check` were run for this step. Their final counts and results are reported in the task completion summary.

## 18. Manual requirements and blockers

1. Install a supported JDK (JDK 21 recommended) and Android Studio SDK Platform 36/build tools; configure the environment.
2. Obtain and configure the actual HTTPS production API origin; add the exact `https://localhost` app origin to the authorized backend CORS configuration and verify credentialed session cookies.
3. Run the debug build on an emulator/device and confirm all native behaviors and Android WebView cookie handling.
4. Create and securely back up the release keystore; inject signing values securely only when producing signed release artifacts.
5. Run signed release APK/AAB builds and inspect/signature-verify the outputs.
6. Separately resolve all Step 24 live payment, KYC, payout, database, and production-release blockers recorded in the Step 25 report.

## 19. Step 27 prerequisites

Step 27 is separate and has not started. Before any store/release activity, the project owner must explicitly authorize it, provide the verified production API/deployment, test the app and cookie/CORS behavior on supported devices, establish protected release signing and versioning, complete privacy/security/legal and real-money verification, and review the applicable Play policy requirements. No Play Console listing, upload, or publication was performed.
