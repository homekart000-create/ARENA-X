# ARENA X — Step 27 Play Store Preparation

Policy requirements below were checked against official Google documentation on 2026-10-03. Play requirements can change; recheck them in Play Console immediately before submission.

## Completed

- Audited the Step 26 Android project, Capacitor configuration, Gradle configuration, manifests, permissions, signing setup, API configuration, ignore rules, icons, splash resources, and Step 26 documentation.
- Confirmed the application ID and namespace remain `com.arenax.app`, the app name is `ARENA X`, and the existing version remains `1.0.0` / version code `1`.
- Confirmed `local.properties`, Android build outputs, generated web staging, and release keystore file patterns are ignored. No keystore, local properties file, APK, AAB, or production credential file is tracked. The credential-pattern scan found only a deliberate non-secret `rzp_live_notallowed` test sentinel in an existing backend test.
- Confirmed the existing release signing configuration reads its four values from process environment variables, rejects partial signing configuration, and does not fall back to debug signing. No release signing values or keystore are present in this environment.
- Confirmed release API staging requires an externally supplied HTTPS origin and rejects missing, localhost, non-HTTPS, credential-bearing, or non-origin values. No production API origin is configured. The web/PWA source and GitHub Pages configuration were not changed.
- Confirmed the release manifest has cleartext traffic disabled; the separate debug network configuration allows cleartext only for `localhost` and `127.0.0.1`. The app manifest declares `INTERNET` as its only app permission.
- Added Android packaging regression coverage for application identity/version, release signing inputs, debug-signing exclusion, manifest cleartext policy, and app permissions.
- Added authenticated `POST /api/users/me/close` account closure and a profile-page action. It uses the current authenticated session identity only, requires an allowlisted request origin, closes and anonymizes the user transactionally, removes credentials, revokes sessions, and redacts mutable KYC profile identifiers. Any wallet balance remains stored on its closed wallet; no refund, withdrawal, or balance mutation is performed by account closure.
- Preserved wallet, payment, withdrawal, tournament, match, and append-only audit records; the related schema has restrictive user references and append-only mutation triggers. KYC audit events, including their schema-defined review reasons and actor/user references, are retained. This is a description of current schema behavior, not a legal retention claim.
- Created this owner-input checklist. No Play Console upload, submission, production deployment, signing-key creation, or publication was performed.

## Android Release Configuration

- **Package ID / namespace:** `com.arenax.app`
- **App name:** `ARENA X`
- **Version:** `versionName` `1.0.0`; `versionCode` `1`. Keep these values for this release; increment `versionCode` for a subsequent Play upload.
- **SDKs:** `minSdkVersion` 24, `compileSdkVersion` 36, `targetSdkVersion` 36. As of 2026-10-03, the published Google Play requirement for new apps and updates is Android 16 / API 36 or higher from 2026-08-31; this target currently meets that requirement. Recheck the policy before uploading.
- **Release bundle:** The Gradle project has a `release` build type and `bundleRelease` task. A Play upload requires a signed AAB. With no supplied keystore, Gradle reports the release signing configuration as `null`; the release variant does not use the debug key.
- **Signing inputs:** Release signing reads `ANDROID_RELEASE_STORE_FILE`, `ANDROID_RELEASE_STORE_PASSWORD`, `ANDROID_RELEASE_KEY_ALIAS`, and `ANDROID_RELEASE_KEY_PASSWORD` from the build process environment. Configure these only through a protected owner-controlled mechanism. Do not commit them or the keystore.
- **API origin:** `ANDROID_API_BASE_URL` supplies the API origin at Android web-staging/build time. Release staging requires the real production HTTPS origin; there is no production localhost fallback. A missing origin causes the release staging command to stop before syncing/building.
- **Network security:** The main/release manifest has `usesCleartextTraffic="false"`. The debug-only manifest opts into the debug network security configuration, whose base denies cleartext and whose only exceptions are `localhost` and `127.0.0.1`. Mixed content is disabled in Capacitor. No release manifest network-security override or debug-only cleartext setting was present in the merged release manifest.
- **Permissions:** The app source manifest declares `android.permission.INTERNET` only. Dependencies may contribute their own merged manifest declarations; review the final merged manifest again for each release.
- **Icons and splash:** Native launcher PNGs, adaptive icon XML, vector artwork, and splash resources exist. These do not by themselves establish that the separate Play Store listing icon, screenshots, or promotional assets are complete or approved.
- **Release status:** The debug APK build succeeded. The release AAB was not built: the release command stopped because `ANDROID_API_BASE_URL` is not set. A release keystore and credentials are also absent, so no Play-uploadable signed bundle is available.

## Play Store Requirements

Every item below that needs an owner decision, URL, asset, account, or declaration is **REQUIRES OWNER INPUT**. Do not infer answers from the UI or substitute test values.

1. **Production HTTPS API and environment — REQUIRES OWNER INPUT.** Deploy and identify the real production backend HTTPS origin, production environment, and operational owner. Confirm the exact `https://localhost` app origin is permitted for credentialed API sessions and verify authentication/session behavior against the deployed service. Do not use a `.test`, localhost, or staging API origin for a production build.
2. **Production signing — REQUIRES OWNER INPUT.** Create or provide the real release/upload keystore, alias, and passwords; securely back up the key; choose the Play App Signing arrangement; and configure the four release inputs via protected secrets. No signing credentials were created or supplied.
3. **Versioning — REQUIRES OWNER INPUT for the next upload.** This preparation retains version `1.0.0` / code `1`; confirm the final release version and use a new, higher version code for any later update.
4. **Store listing and assets — REQUIRES OWNER INPUT.** Supply and approve the high-resolution Play listing icon, short and full descriptions, screenshots for the intended device types, and any feature graphic/video required or chosen for the listing. Review the existing native/PWA icon artwork for suitability; do not assume it is a compliant final listing asset. Confirm the console's current size/count rules when uploading.
5. **Privacy policy and support — REQUIRES OWNER INPUT.** Provide a public, working privacy-policy URL and support contact/details; ensure the policy describes actual collection, use, sharing, retention, security, and deletion practices and is accessible from the app and listing as required. No privacy-policy URL was found in the repository.
6. **Data Safety and data deletion — REQUIRES OWNER INPUT.** Complete the Data safety and Data deletion forms from actual deployed behavior. ARENA X now has an authenticated in-app account closure action; it closes/anonymizes the user record, removes credentials, revokes sessions, and redacts mutable KYC profile identifiers. Financial, competition, and append-only audit history remains linked to the anonymized closed user as described below. Google Play also requires a web resource through which users can request account/data deletion; no hosted deletion-request URL exists in the repository. The owner must supply and verify that public resource and ensure the app/store disclosures match actual behavior.
7. **Content rating — REQUIRES OWNER INPUT.** Complete the Play Console content-rating questionnaire accurately for the app's actual content and functionality.
8. **Target audience, ads, and age treatment — REQUIRES OWNER INPUT.** Declare the intended age groups, target audience, and whether the app contains ads. Confirm any Families/child-directed obligations if applicable; no audience or ad declaration is assumed here.
9. **App access — REQUIRES OWNER INPUT.** Provide reviewer instructions and a working review/test account or other access path for any login-gated areas, including any required OTP or special access steps. Do not put production credentials in this document or a public listing. No reviewer access details were supplied.
10. **Financial features declaration — REQUIRES OWNER INPUT.** Google requires a Financial features declaration for apps published on Play, including apps that declare no financial features. ARENA X contains account and wallet/payment/KYC/withdrawal-related flows; the owner must classify and declare the actual functionality (including wallet, payments/transfers, and withdrawals where applicable) in Play Console. Do not select “no financial features” or claim regulatory status without verifying the real implementation and business model.
11. **Financial/game and territory compliance — REQUIRES OWNER INPUT.** Determine the actual products, entry-fee/prize/withdrawal behavior, age restrictions, territories, applicable financial or real-money game policies, and any licenses/approvals required for those markets. This step makes no legal, regulatory, payment-provider, KYC, or payout-readiness claim.
12. **Play Console account and testing gates — REQUIRES OWNER INPUT.** Confirm the developer account's owner/verification status and account type/creation date. Google documents a production-access closed-test gate for certain newer personal developer accounts (at least 12 opted-in testers for 14 continuous days); determine whether it applies to this account. Internal testing, closed testing, and production are separate tracks; no test track has been uploaded or run.

Official references checked:

- [Target API level requirements](https://developer.android.com/google/play/requirements/target-sdk)
- [Android App Bundles](https://developer.android.com/guide/app-bundle)
- [App signing](https://developer.android.com/studio/publish/app-signing)
- [Testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465)
- [Store listing requirements and assets](https://support.google.com/googleplay/android-developer/answer/9866151)
- [Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Privacy policy and app access instructions](https://support.google.com/googleplay/android-developer/answer/9859455)
- [Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Content rating](https://support.google.com/googleplay/android-developer/answer/9859655)
- [Target audience and content](https://support.google.com/googleplay/android-developer/answer/9867159)
- [Financial features declaration](https://support.google.com/googleplay/android-developer/answer/13849271)
- [Financial Services policy](https://support.google.com/googleplay/android-developer/answer/9876821)

## Production Blockers

- No real production HTTPS API origin or deployed production environment is configured. The release command fails with: `ANDROID_API_BASE_URL must be set to the production HTTPS API origin before a release build.`
- No release keystore or release signing credentials are available. The Gradle release variant is unsigned (`signingReport`: `Config: null`) and is not upload-ready.
- No release AAB was produced. The AAB attempt stopped at API-origin validation before Gradle bundle generation; no fake API origin was supplied to bypass it.
- No Play Console listing assets, privacy-policy URL, support contact, app access instructions/test account, or owner-approved Data Safety, deletion, rating, audience, advertising, financial-feature, and territory declarations were supplied.
- The authenticated in-app account closure is implemented, but the required public web account/data deletion-request resource and URL remain **REQUIRES OWNER INPUT**. The backend endpoint `POST /api/users/me/close` is an authenticated API route, not a substitute for a public web resource.
- Account closure preserves records referenced by restrictive foreign keys and append-only triggers. It clears direct user profile identifiers (full name, username, email, phone, date of birth, avatar), removes the password credential, revokes active sessions and roles, and nulls mutable KYC profile fields (`legal_name`, `country`, `date_of_birth`, `verification_reference`, `rejection_reason`). The user row remains with `status='closed'` and deterministic deleted-account identifiers so existing foreign keys continue to resolve. Wallet balances remain unchanged on the now-inaccessible closed account; no payout/refund or financial adjustment is implied.
- The schema keeps wallet balances, wallet transactions, ledger entries/events, payment/withdrawal/payout records, tournament/team/registration/match/result records, and append-only KYC, wallet, withdrawal, and payout audit events. Some historical result snapshots and free-text audit reasons may contain names or other supplied text; they are retained under existing schema behavior. No claim is made that a particular retention period or legal basis applies. The owner must review actual obligations and update the design/disclosures if deletion or retention policy requires it.
- The Android device/emulator runtime, production API/CORS/cookie behavior, and internal-track release have not been tested in this step.
- The Step 26 documentation calls out separate prior live payment, KYC, payout, database, and production-release blockers. Step 27 did not independently revalidate or clear those items; they remain release gates until their owners verify them.

## Verification

- `npm run test:android:packaging` — **PASS**, 4 tests.
- Backend account deletion tests — included in `npm test --prefix backend` and cover authenticated self-closure, unauthenticated rejection, foreign-user targeting, all-session invalidation, wallet/ledger retention, and safe profile/history handling.
- `node --test tests\frontend-auth.test.cjs tests\frontend-competition.test.cjs tests\frontend-wallet.test.cjs` — **PASS**, 40 tests.
- `npm test --prefix backend` — **PASS**, 120 tests.
- `npm run typecheck --prefix backend` — **PASS**.
- `npm run build --prefix backend` — **PASS**.
- `node --check` across 32 tracked `.js`, `.mjs`, and `.cjs` files — **PASS**.
- `android\gradlew.bat -p android --no-daemon help :app:processReleaseMainManifest :app:signingReport` — **PASS**. Gradle 8.14.3 configured successfully; the only output warnings were the existing `flatDir` repository metadata warnings.
- Generated merged release manifest validation — **PASS**: package `com.arenax.app`, version `1.0.0` / code `1`, min SDK 24, target SDK 36, `usesCleartextTraffic=false`, no release network-security override, and no `debuggable=true`.
- Release signing report — **PASS**: debug variant uses its debug configuration; release variant reports `Config: null`, with no debug-signing fallback.
- `npm run android:debug` — **PASS**. The debug APK is at `android/app/build/outputs/apk/debug/app-debug.apk` and is ignored by Git; it is not a release artifact.
- `npm run android:release:aab` — **BLOCKED as expected** before `cap sync`/Gradle: no `ANDROID_API_BASE_URL` is set. No placeholder or fake production origin was used.
- Credential/file scan — **PASS with one documented test sentinel**: no tracked keystore, local.properties, APK/AAB, Google services file, or real production credential was found. `backend/.env.example` is an example file; an existing backend test contains the non-secret marker `rzp_live_notallowed` / `placeholder`.

## Release Procedure

The following is a future sequence, not a record of completed release actions:

1. Deploy the production HTTPS backend.
2. Configure the verified production API origin through `ANDROID_API_BASE_URL`.
3. Create/provide the protected signing keystore.
4. Configure release signing through protected environment/secret inputs.
5. Build the signed AAB with `npm run android:release:aab`.
6. Verify the AAB contents, application ID/version, network policy, and signing certificate.
7. Upload to Play Console internal testing.
8. Test the internal release on supported devices and verify production API, login/session, and all enabled features.
9. Complete Play Console declarations, including financial features and all applicable policy forms.
10. Complete the store listing and required assets.
11. Complete and verify privacy, account deletion, and Data Safety requirements.
12. Submit for review only after the owner has cleared every production blocker above.
