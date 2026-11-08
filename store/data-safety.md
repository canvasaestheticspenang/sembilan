# Data safety (Google Play) and App Privacy (Apple) answers

Basis: Sembilan has no account and no server of ours. Data stays on the device (localStorage). Location and search text go to third-party services to compute routes, search and maps. Verify against the final build before submitting.

Important concept: Apple counts data as "collected" when it leaves the device to the developer OR to third-party partners the developer integrates, unless the exceptions apply. Google counts data as "collected" when it is transmitted off the device, with an exemption for data processed only on-device, and for transfers to a service provider that processes it on the developer's behalf. Whether the routing, search and map servers count as "service providers" or as "third parties" is a legal judgment. These answers take the cautious route (declare location and search as collected and shared). TODO (lawyer): confirm the position; declaring is the safer error.

## A. Google Play Data safety form

### Data collection and security
1. Does your app collect or share any of the required user data types? Yes (location and search queries leave the device to third-party services).
2. Is all of the user data collected by your app encrypted in transit? Yes, all endpoints are HTTPS. TODO (owner): confirm that no http:// endpoint is used in the release build (the only http:// string in index.html is the SVG namespace).
3. Do you provide a way for users to request that their data be deleted? Not applicable in the usual sense because we hold no data; users delete local data in the app or by uninstalling. Answer "Yes" is not accurate for server deletion. Choose the option that says data is not stored by you, and explain in the free text: "All data stays on the device. Uninstalling or clearing app data deletes it. We hold no data on any server." TODO (owner): check the exact wording of the form at submission.
4. Committed to the Play Families Policy? No (not a children's app).
5. Independent security review? No.

### Data types

| Data type | Collected? | Shared? | Purpose | Optional? | Notes |
|---|---|---|---|---|---|
| Location: Approximate location | Yes | Yes | App functionality | No (core feature) | Coordinates sent to routing, maps, weather, POI services |
| Location: Precise location | Yes | Yes | App functionality | No (core feature) | Route start point, position, map viewport. Not stored by us |
| Personal info: name, email, address, user IDs, phone number | No | No | | | The optional family number is stored on device only. It is used to build a wa.me link on user action; it is not transmitted to us. TODO (lawyer): the number is placed in a wa.me URL opened by the user; treat as user-initiated, not collection by us |
| Financial info | No | No | | | |
| Health and fitness | No | No | | | |
| Messages | No | No | | | WhatsApp message is composed on device and sent by the user inside WhatsApp |
| Photos and videos | No | No | | | Avatar photo is stored on device only and never uploaded |
| Audio files / voice | No | No | | | Voice guidance is text-to-speech from the device; no microphone |
| Files and docs | No | No | | | |
| Calendar, contacts | No | No | | | The app does not read the contact list |
| App activity: search history / in-app search | Yes | Yes | App functionality | No | Search text sent to Photon, Nominatim and TomTom (the app ships with a built-in TomTom key). Recent searches kept on device only |
| App activity: other user-generated content | No | No | | | Saved places and trip logs are device-only |
| Web browsing | No | No | | | |
| App info and performance (crash logs, diagnostics) | No | No | | | No crash reporting or analytics |
| Device or other IDs | No | No | | | No advertising ID. Third-party servers see the IP address as in any web request (IP address is not a listed type on its own; mention in privacy policy) |

Sharing exemptions to declare in the form: none claimed. Data "shared" = sent to third parties listed in the privacy policy.

### Free-text description for the form
"Sembilan has no accounts and no servers of ours. Settings, saved places, trip logs and the optional avatar photo stay on the device. Precise location, route points and search text are sent over HTTPS to third-party mapping, routing, search and weather services only to compute routes, find places and display maps. We do not use data for advertising or analytics."

## B. Apple App Privacy (nutrition label)

Question: Do you or your third-party partners collect data from this app? Answer Yes (cautious). TODO (lawyer): if counsel decides the third-party services act purely as processors transmitting data on the user's behalf and are not collecting for their own use, "No" may be arguable. Not recommended: OSM, Photon, TomTom and others log IPs under their own policies.

| Apple data type | Collected | Linked to user? | Used for tracking? | Purposes |
|---|---|---|---|---|
| Location: Precise Location | Yes | No (no account or identifier on our side) | No | App Functionality |
| Location: Coarse Location | Yes | No | No | App Functionality |
| Search History (Usage Data) | Yes | No | No | App Functionality |
| Contact Info (name, email, phone, address) | No | | | |
| Contacts | No | | | |
| Health and Fitness | No | | | |
| Financial Info | No | | | |
| Sensitive Info | No | | | |
| User Content: Photos or Videos | No (avatar stays on device) | | | |
| User Content: Other | No | | | |
| Browsing History | No | | | |
| Identifiers (User ID, Device ID) | No | | | |
| Purchases | No | | | |
| Usage Data: Product Interaction, Advertising Data | No | | | |
| Diagnostics (crash, performance) | No | | | |
| Other Data | No | | | |

Tracking (ATT): No. The app does not link data with other companies' apps or sites for advertising and does not use the advertising identifier. No App Tracking Transparency prompt is needed.
Privacy Policy URL (required): TODO publish privasi.html at a public URL.

## C. Location permission justification

### Foreground location (iOS NSLocationWhenInUseUsageDescription, Android ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION)
English: "Sembilan uses your location to show where you are, calculate routes and give turn-by-turn directions. Your position is sent to map and routing services to do this. It is not stored by us."
Malay: "Sembilan menggunakan lokasi anda untuk menunjukkan kedudukan, mengira laluan dan memberi arahan giliran demi giliran. Kedudukan dihantar kepada perkhidmatan peta dan penghalaan untuk tujuan ini. Kami tidak menyimpannya."

Request the permission only when the user taps "My location" or starts navigation (not at launch).

### Background location (only if the native wrapper keeps navigating with the screen off)
Current behaviour: the web app uses a screen wake lock and foreground geolocation watch (see index.html). It does NOT request background location. Recommended first release: foreground only, no background location permission. This avoids the stricter Google Play background-location review and the Apple "Always" prompt.

If you later add background location (so voice guidance continues when the phone is locked or another app is in front), use these texts:
- Apple NSLocationAlwaysAndWhenInUseUsageDescription: "Sembilan keeps using your location while navigation is active so voice directions continue when the screen is off. Location is not used when you are not navigating."
- Google Play Console background-location declaration: "Core feature: turn-by-turn voice navigation for riders. During an active trip the user may lock the screen or switch app (for example to answer a call), and directions must continue. Location is used only while a trip is active, shown with a persistent notification, and is not stored or sold. Without background access the guidance would stop mid-ride, which is a safety risk." Also needs a short demo video of the feature and the in-app prominent disclosure before the OS prompt.
- Android: foreground service of type "location" with an ongoing notification.
TODO (owner): decide whether v1 ships with background location. If yes, this section needs a review and the data-safety table stays the same.

## D. Other declarations
- Camera / photos: the avatar uses a file picker (input type=file). With a native wrapper use the system photo picker so no broad photo permission is required. Add NSPhotoLibraryUsageDescription only if the wrapper needs it: "Choose a photo to use as your rider avatar. It stays on your device."
- Microphone: not used. Contacts: not used. Notifications: not used in the web app; if added, declare.
- Encryption export compliance (Apple): the app uses only standard HTTPS provided by the OS. Answer: uses encryption, exempt (standard HTTPS). TODO (owner): confirm in App Store Connect.
- Content rights (Apple): the app uses third-party map data under open licences with attribution (Credits screen). TODO (lawyer): confirm.
