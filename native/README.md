# Sembilan native app (Capacitor 8, iOS and Android)

The web/PWA build is unchanged. The native app is the same `index.html` in a Capacitor shell, with
real background location (foreground service on Android, background location mode on iOS), native
voice and screen keep-awake. All native code is in the `NATIVE BRIDGE` block of `index.html`.

| Need | Plugin | Why |
|---|---|---|
| Background GPS | `@capacitor-community/background-geolocation` | Free (MIT), maintained, Capacitor 8 support. The Transistorsoft plugin needs a paid licence for Android release builds. |
| Voice | `@capacitor-community/text-to-speech` | Native engine, works with the screen locked (iOS audio background mode). |
| Screen on | `@capacitor-community/keep-awake` | Native replacement for the Wake Lock API. |
| Shell | `@capacitor/core`, `cli`, `ios`, `android`, `app`, `splash-screen` | |

Requirements: Node 22+, Xcode 16+ and CocoaPods or SwiftPM (Mac), Android Studio with JDK 21 and Android SDK 35+.
An Apple Developer account (USD 99/year) and a Google Play developer account (USD 25 once) are needed to publish.

## 1. Install and build the web assets

```sh
npm i
npm run cap:build-web          # creates www/ (about 1.4 MB, no data/places)
```

`www/` contains the app, a local copy of Leaflet (so the native app works offline) and `data/`
without `data/places` (180 MB+). The native app fetches places from
`https://canvasaestheticspenang.github.io/sembilan/data/places/` (constant `REMOTE_DATA_BASE` in
`index.html`). To bundle the shards instead: `node scripts/build-www.js --with-places`.

The service worker is not registered on native; Capacitor serves the files from the app bundle.

## 2. Add the platforms (once)

```sh
npx cap add ios        # Mac only
npx cap add android
npm run cap:sync       # rebuilds www/ and copies it plus plugins into ios/ and android/
```

Run `npm run cap:sync` after every change to `index.html`. Commit `ios/` and `android/`.

## 3. Icons and splash

Put a 1024x1024 `assets/icon-only.png`, `assets/icon-foreground.png` (logo on transparent, keep the
logo inside the centre 66%), `assets/icon-background.png` (or a solid colour) and a 2732x2732
`assets/splash.png` (and `splash-dark.png`) in `assets/`, then:

```sh
npx capacitor-assets generate --iconBackgroundColor '#0f766e' --splashBackgroundColor '#0f766e'
```

This generates the iOS app icon set, the Android adaptive icon (foreground + background) and splash
screens. `icon.svg` / `icon-512.png` in the repo root can be exported to 1024 px as the source.

## 4. iOS (on a Mac)

```sh
npx cap open ios
```

In Xcode: select the `App` target, Signing and Capabilities, pick your Team, bundle id
`com.canvasaesthetics.sembilan`. Add the capability **Background Modes** and tick **Location updates**
and **Audio, AirPlay, and Picture in Picture**.

Edit `ios/App/App/Info.plist` and add:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>Sembilan needs your location to show where you are on the map and to guide your route.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>Sembilan keeps using your location while the screen is off so turn-by-turn guidance keeps working during your trip.</string>
<key>UIBackgroundModes</key>
<array>
  <string>location</string>
  <string>audio</string>
</array>
```

Malay strings: create `ios/App/App/ms.lproj/InfoPlist.strings` (add the file in Xcode, and add Malay under Project, Info, Localizations; also keep `en.lproj/InfoPlist.strings` with the English text):

```
"NSLocationWhenInUseUsageDescription" = "Sembilan memerlukan lokasi anda untuk menunjukkan kedudukan anda pada peta dan memandu laluan anda.";
"NSLocationAlwaysAndWhenInUseUsageDescription" = "Sembilan terus menggunakan lokasi anda semasa skrin dimatikan supaya panduan arah kekal berfungsi sepanjang perjalanan anda.";
```

App Review tip: in the review notes say that background location is used only while a navigation
session is active, and attach a short screen recording.

## 5. Android

```sh
npx cap open android
```

Edit `android/app/src/main/AndroidManifest.xml`, inside `<manifest>` (the plugin adds some of these itself; duplicates are harmless):

```xml
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

Foreground-service notification text (shown while navigating) is set in the bridge and follows the
app language:

- English: title "Sembilan is using your location", text "Navigation is active"
- Malay: title "Sembilan sedang menjejak lokasi", text "Navigasi aktif"

Notification icon, channel name and colour: add `android/app/src/main/res/values/strings.xml` entries
as described in the plugin README (`capacitor_background_geolocation_notification_icon`, `..._color`)
if you want something other than the launcher icon. On Android 13+ the user must accept the
notification permission or the background service will not start.

Play Console: background location needs a permission declaration form and a short demo video
(Policy, App content, Sensitive permissions). Use the English and Malay wording above; core feature =
turn-by-turn navigation that continues with the screen off. Without approval, background updates are
rejected on production tracks (internal testing works without review).

Adaptive icon and splash come from step 3. Check `android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`.

## 6. Signing and release

Android:

```sh
keytool -genkeypair -v -keystore sembilan-release.jks -alias sembilan -keyalg RSA -keysize 2048 -validity 10000
```

Keep the keystore and its passwords safe and out of git. In Android Studio: Build, Generate Signed
App Bundle, choose Android App Bundle, your keystore, `release`. Or enrol in Play App Signing and
sign with an upload key. Bump `versionCode` and `versionName` in `android/app/build.gradle` for each upload.

iOS: Xcode, set the version and build number on the `App` target, destination "Any iOS Device (arm64)",
Product, Archive, Distribute App, App Store Connect, Upload.

## 7. Testing tracks

- **TestFlight**: after upload, in App Store Connect open the app, TestFlight, wait for processing,
  answer the export-compliance question (the app uses only standard HTTPS: choose exempt), add internal
  testers (no review) or an external group (needs a short Beta App Review).
- **Play internal testing**: Play Console, Testing, Internal testing, Create release, upload the `.aab`,
  add testers by email in a list, copy the opt-in link and send it. Available within minutes.

## 8. Things to check on a real device

1. Start navigation, lock the phone, drive or walk: the dot keeps moving and voice prompts still play.
2. Android: the persistent "Sembilan is using your location" notification appears while navigating.
3. Places search works (fetched from GitHub Pages; needs a data connection).
4. The routing, Overpass, TomTom and weather services all answer from `https://localhost` / `capacitor://localhost` (CORS). If a service refuses, route it through `CapacitorHttp` (`"plugins": {"CapacitorHttp": {"enabled": true}}` in `capacitor.config.json`).
5. Android 10+ asks for "Allow all the time" in system settings for background location; the plugin shows the prompt/`openSettings()`.

## Dev notes

- Web fallback: with no `window.Capacitor` the bridge uses `navigator.geolocation`, `speechSynthesis` and `navigator.wakeLock` exactly as before.
- Tests: `tests/native.test.js` covers both the fallback and a fake Capacitor.
- `android.useLegacyBridge: true` is in `capacitor.config.json` on the background-geolocation plugin's advice (otherwise updates stop after about 5 minutes in the background).
