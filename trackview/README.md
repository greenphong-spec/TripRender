# Trackview

Desktop GPS track replay viewer (GPX / KML / KMZ) on an online map, with ×N playback,
a live info card and a synced speed chart. Specification: [`../SPEC.md`](../SPEC.md).

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies (once) |
| `npm run dev` | Run in the browser at http://localhost:5173 |
| `npm run tauri dev` | Run as a desktop window with hot reload |
| `npm run tauri build` | Build `src-tauri/target/release/trackview.exe` and an NSIS installer under `src-tauri/target/release/bundle/nsis/` |
| `npm test` | Run the tests against `../example_GPSfiles/` |
| `npm run typecheck` | TypeScript check |

The desktop build needs Rust (installed with `winget install Rustlang.Rustup`) and Edge WebView2 (preinstalled on Windows 10/11).

## Layout

```
src/parse/     xml.ts (small XML parser), gpx.ts, kml.ts, index.ts (format detection, KMZ unzip)
src/model/     build.ts (cleaning, timing, speed, pauses, stats), spikes.ts, interpolate.ts, units.ts
src/map/       trackmap.ts (MapLibre layers, markers, follow), styles.ts (OpenFreeMap, Esri)
src/ui/        chart.ts (uPlot), infocard.ts, settingspanel.ts
src/player.ts  playback clock
src/main.ts    wiring: header, playback bar, file open / drop, keyboard
src-tauri/     Tauri 2 shell
```

## Keyboard

Space play/pause · ←/→ ±10 s (Shift ±60 s) · Home/End · `+`/`-` playback speed

## Map data

Basemaps are loaded online without an API key: OpenFreeMap (© OpenMapTiles, data © OpenStreetMap contributors)
and Esri World Imagery for the satellite style (personal use).
