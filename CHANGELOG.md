# Changelog

All versions are deployed via Codemagic → TestFlight. Railway redeploys automatically on push.

## v7 — 2026-03-16
### Added
- Hourly strip: horizontal scrollable 24h forecast with weather icons, temperature and precipitation bars
- Wind direction arrow: rotating ↑ indicator next to wind speed
- Precipitation shown per model in the model breakdown cards
- Radar map section prepared for future integration (RainViewer API + Leaflet.js, see app.js comments)
- Hourly weather codes added to backend response (used for icons in hourly strip)

## v6 — 2026-03-16
### Added
- SMHI (pmp3g 3km model) as 6th weather source
- Wsymb2 → WMO weather code mapping
- SMHI shown in light blue in model chart

## v5 — 2026-03-16
### Added
- YR (met.no) as 5th weather source
- YR symbol codes mapped to WMO codes
- Wind converted m/s → km/h, UTC → local time

## v4 — 2026-03-16
### Fixed
- Removed debug alert popups added in v3

## v3 — 2026-03-16
### Fixed
- iOS app now loads static files from local bundle (removed server.url)
- All API fetch calls updated to use absolute Railway URL
- Force-remove server.url from ios/App/App/capacitor.config.json after cap sync
- Added debug alerts to diagnose geolocation (removed in v4)

## v2 — 2026-03-16
### Fixed
- Geolocation timeout increased to 30s with enableHighAccuracy
- Forced fresh ios/ directory recreation in Codemagic (rm -rf ios)
- Added version label to header for build verification

## v1 — 2026-03-16
### Initial release
- ECMWF, GFS, ICON, GEM ensemble forecast via Open-Meteo
- Swedish UI (sv-SE)
- Hourly chart (12h/24h/48h) starting from current time
- Temperature table with per-range step intervals
- Model breakdown with per-model chart
- Geolocation support
- iOS app via Capacitor + Codemagic + TestFlight
- Backend on Railway (FastAPI + uvicorn)
