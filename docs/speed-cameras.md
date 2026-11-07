# Speed-camera / AES data for Sembilan: sources and licences

Researched 2026-11-07 from current public pages (links below). This is a summary, not legal advice.

## Verdict

| Source | Usable? | Licence | Notes |
|---|---|---|---|
| OpenStreetMap via Overpass (`highway=speed_camera`, `enforcement=maxspeed`, `maxspeed=*`) | Yes, this is what the app uses | ODbL 1.0, credit "OpenStreetMap contributors" | Incomplete and uneven; no AES-specific tag. |
| data.gov.my "Senarai Lokasi AES / AWAS JPJ (Lampu Isyarat) mengikut Negeri" | Not used (no coordinates, 2021) | Creative Commons Attribution (as shown on the dataset page) | CSV with state, district, road, KM marker, limit, compound. No lat/lon. Last updated 21 Nov 2021. Publisher not stated on the page. |
| JPJ / PDRM / MIROS / KKM own APIs or lists with coordinates | None found | n/a | JPJ has announced AES locations in press releases (text only). No open, machine-readable, georeferenced list found. |
| Motorist.my, Carlist, Paultan, Newswav tables | No | Copyright of the publishers, no data licence | Text tables compiled by private sites, no coordinates; not redistributable. |
| Waze, Google, TuJu, Lapan, other apps | No (excluded by instruction) | Proprietary / crowdsourced under app terms | Not used anywhere. |

## OpenStreetMap

- Fixed cameras: node `highway=speed_camera`, optional `maxspeed=*` (limit enforced), `direction=*` (degrees or N/NE/...), `ref`, `operator`. Newer style: relation `type=enforcement` + `enforcement=maxspeed` with `device`, `from`, `to` members; the device node may carry only `enforcement=maxspeed`. The builder reads `highway=speed_camera` nodes, `enforcement=maxspeed` nodes and `device` nodes of enforcement relations. It does not read the relation's own `maxspeed`, so limits are only filled when the node has one. Limits on ways (`maxspeed` on roads) are not used yet; the "known limit" shown in the app is the camera's own `maxspeed`.
- OSM has no tag for AES vs. AWAS. The builder marks a camera as type 1 only if name/operator/ref/brand/description contains AES, AWAS or JPJ; everything else is type 0.
- Licence: ODbL 1.0. Credit "(c) OpenStreetMap contributors" and state the data is under the ODbL (https://www.openstreetmap.org/copyright). Share-alike: a database derived from OSM data (our `data/cameras.json`) must be offered under the ODbL. The repository's LICENSE is all-rights-reserved, so `data/cameras.json` carries `src` = "OpenStreetMap contributors, ODbL 1.0" and the in-app settings text credits OSM. The owner should add a line to LICENSE/README saying that `data/` (OSM-derived) is ODbL, not all-rights-reserved.
- OSM wiki note for navigation software: some countries prohibit dynamic camera-warning devices, so apps should let users opt out. Sembilan has the "Speed camera alerts" setting (default on).
- Overpass fair use (overpass-api.de, FOSSGIS): stay far below ~10,000 queries and 1 GB per day (divide by 100 for regular automated use), identify the app with a User-Agent, no parallel scripts, wait 30 s after HTTP 429/406, do not use it for commercial services. One query a week with retry/backoff fits this. The script falls back to overpass.private.coffee.

## Malaysian official data

- archive.data.gov.my (the older CKAN portal) has "Data Menerangkan Senarai Lokasi AES / AWAS JPJ (Lampu Isyarat) Mengikut Negeri", CSV, nine columns (NEGERI, DAERAH, TARIKH KAMERA BEROPERASI, JENIS CAMERA, KM, JALAN, HAD LAJU, JUMLAH KOMPAUN, TINDAKAN MAHKAMAH). Licence on the page: Creative Commons Attribution. No coordinates, so it would need geocoding from road name and KM marker (error-prone), and it is five years old. It could be a cross-check for OSM later, with attribution to the publisher, but cannot be shown as camera positions as is.
- Government open data in Malaysia is generally released under the "Terms of Use Government Open Data 1.0" (free, worldwide, commercial use allowed, credit the source, do not imply endorsement, do not present withdrawn data as current). That is the DOSM wording; the data.gov.my page itself says CC Attribution.
- Legal context found: police asked Waze users not to publish roadblocks, but it was a request, and no Malaysian law was cited that makes reporting enforcement an offence. Fixed AES/AWAS locations have been published by JPJ itself. Not legal advice; the owner may want to confirm before launch.

## Limits

- OSM coverage of Malaysian cameras is partial; mobile (police) cameras and many AES/AWAS units are probably not mapped. The app says: "Not all cameras are listed; obey signs."
- Direction is not used to filter alerts (OSM `direction` is ambiguous), so a camera on the opposite carriageway within 25 m of the route can trigger a warning.
- The bounding box also covers Singapore, Brunei and bits of neighbours; harmless but present.
- Limits come only from the camera node's own `maxspeed`; otherwise the banner shows no limit.

## Sources

- https://wiki.openstreetmap.org/wiki/Tag:highway=speed_camera
- https://wiki.openstreetmap.org/wiki/Relation:enforcement
- https://www.openstreetmap.org/copyright
- https://wiki.openstreetmap.org/wiki/Overpass_API (public instance usage policy)
- https://archive.data.gov.my/data/dataset/senarai-lokasi-aes-awas-jpj-lampu-isyarat-mengikut-negeri/resource/37498b15-f6a5-46b5-bedd-01d8f443c97c
- https://www.dosm.gov.my/portal-main/article/term-of-use
- https://www.thesundaily.my/gear-up/police-ask-motorists-not-to-publicise-their-roadblocks-or-presence-on-waze-OC10569711
- https://www.motorist.my/article/4645/latest-aes-awas-camera-locations-across-malaysia-2026 (checked: private site, no coordinates, not used)

## Files

- `scripts/build_cameras.py` builds `data/cameras.json` (weekly in `.github/workflows/update-data.yml`; `data/cameras.json` does not exist until the first successful run, and the app treats a missing file as "no camera data").
- `tests/fixtures/overpass-mock.json` is a synthetic Overpass answer (made-up IDs and coordinates, not real cameras) and `tests/fixtures/cameras-expected.json` its hand-checked output.
