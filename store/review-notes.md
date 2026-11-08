# Notes for Apple App Review and Google Play reviewers

## Short version (paste into "Notes for Review")
Sembilan is a free turn-by-turn navigation app for Malaysia aimed at motorcycle riders. No sign-in is required and there is no account, so no demo credentials are needed. All user data (settings, saved places, trip logs, optional avatar photo) stays on the device. Location is requested only when navigation or "My location" is used. Because the reviewer is unlikely to be in Malaysia, use the steps below to test without travelling.

## How to test navigation without driving
1. Open the app. Allow location "While Using" when prompted (or deny: the app still works with a manually chosen start point).
2. Tap the search box and search "KLCC" or "Gurney Plaza, Penang". Pick a result.
3. In the route screen choose a start point other than "My location": search "Penang Bridge" or tap the map to set the start. Routes are computed between any two points in Malaysia, so no movement is needed.
4. Tap Start. The app shows turn-by-turn instructions and ETA. Voice guidance can be toggled in Settings.
5. To see guidance advance without moving: use the simulator or location tools of your test setup.
   - iOS: Xcode or the Simulator, Features > Location > City Run / Freeway Drive, or a GPX file.
   - Android: Emulator Extended Controls > Location > Routes, or a mock-location app.
   TODO (owner): consider adding an in-app "Demo drive" mode that replays a built-in route, so reviewers need no tools. This is the most reliable way to avoid a rejection for "could not verify core functionality".
6. Rider mode: Settings > Rider mode on. Rain forecast along the route, rain radar and no-motorcycle road warnings appear on routes in Malaysia.
7. Family WhatsApp (optional): Settings > Family number > enter any number, then use the trip report or safe-arrival button. The app opens WhatsApp with a pre-filled message; nothing is sent until the user presses send. If WhatsApp is not installed the link opens in the browser.
8. Outside Malaysia the map works but search is biased to Malaysia, Singapore and Brunei, and toll, rain and road-warning data cover Malaysia only.

## Network and services
The app needs internet for routing, search, map tiles and weather. It contacts: OSRM and Valhalla routing servers, Photon and Nominatim search, OpenFreeMap, OpenStreetMap and Esri map tiles, Overpass (places), Open-Meteo, RainViewer, and TomTom (the app ships with a built-in key; reviewers do not need one). If a public server is briefly busy, routing falls back to another server automatically; retry after a moment.
TODO (owner): the public OSM-based servers have fair-use policies and no uptime guarantee. A reviewer hitting a rate limit could cause a rejection. Consider a paid or self-hosted routing and tile service for release.

## Permissions
- Location (While Using): needed for the core feature (see data-safety.md section C).
- No background location in v1 (if this changes, update this file).
- No camera, microphone or contacts. The avatar photo uses the system picker.

## Why a native app and not only a web page (guideline 4.2 and Play equivalent)
Stating this plainly because Apple may reject thin web wrappers. Points to confirm and implement in the native shell; do not claim anything not built:
1. Reliable device GPS with high accuracy and screen-off or lock-screen behaviour better than a mobile browser (wake lock handling, optional foreground service on Android).
2. Native text-to-speech and audio session handling so voice directions play over music and Bluetooth/helmet intercoms and duck other audio. Browsers cannot reliably do this.
3. Offline resilience: installed app shell, cached map tiles and the Malaysia points-of-interest file work with weak signal, which is common on rural roads.
4. Home-screen presence, full-screen display without browser chrome, and system-level sharing/deep links (wa.me hand-off to WhatsApp).
5. App-level safety features for riders: rain alerts along the route, no-motorcycle road warnings, safe-arrival message.
TODO (owner): items 1, 2 and 4 depend on what the chosen wrapper (for example Capacitor) actually implements. Before submission, add at least one real native capability (native TTS or audio session, native geolocation plugin, share sheet) so the app is clearly more than a bookmarked website. Remove any point above that is not true.

## Safety and policy points reviewers often check
- Safety warning shown on first launch and in Terms: do not operate the phone while riding.
- Routes and ETAs are labelled as estimates.
- No user accounts, no purchases, no ads, no tracking, no user-generated content shared with others.
- Third-party data is credited in Settings > Credits & copyright.
- Privacy Policy and Terms: privasi.html and terma.html (public URLs TODO).
- Google Play: the app does not collect location in the background and does not use the Accessibility API.
- Apple: Maps and navigation apps must not imply guaranteed accuracy; wording is "estimate".
