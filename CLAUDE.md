# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rules for this repo

- **Do not commit automatically.** Only run `git commit` when the user explicitly asks for a commit in that turn. Finishing a task, fixing a bug or passing tests is not a reason to commit.
- Git has no global identity on this machine. When the user does ask for a commit, pass it per command: `git -c user.name="phong" -c user.email="greenphong@gmail.com" commit ...` (do not change git config).
- `SPEC.md` is the source of truth for behaviour (timing modes, pauses, spike filter, settings, acceptance criteria in §11, user decisions in §12). Keep it in sync when behaviour changes.
- Keep the code Android-friendly (touch input, phone-width layout, no Windows-only APIs): an Android build via Tauri may follow later.

## Repository layout

- `trackview/` — the app: a GPS track replay viewer (GPX/KML/KMZ) with a Vite + TypeScript web UI in a Tauri 2 desktop shell. All commands below run from here.
- `example_GPSfiles/` — real sample tracks used by the tests. Stored byte-exact (`.gitattributes` `-text`); do not let tools rewrite their line endings.
- `expected_UI.png` — the target mockup.
- The `Aug_31,_2026_15_20_59.gpx` in the root is an untracked duplicate of the sample. Other untracked scratch files (`debug-with-user-settings.md`, `smart-zoom-open-issue.md` in the root, `trackview/wrongzoom.png`, `trackview/trackview - Shortcut.lnk`) are user/session notes and screenshots: leave them out of commits.
- Versions: `SPEC.md` is at v0.6 draft (§17 satellite imagery download, not implemented yet); the app version in `package.json` / `tauri.conf.json` is still `0.1.0`.

## Commands (in `trackview/`)

| Task | Command |
|---|---|
| Browser dev server (port 5173, strict) | `npm run dev` |
| Desktop window with hot reload | `npm run tauri dev` |
| Desktop exe + NSIS installer | `npm run tauri build` → `src-tauri/target/release/trackview.exe`, `src-tauri/target/release/bundle/nsis/` |
| All tests | `npm test` |
| One test file / one test | `npx vitest run test/spikes.test.ts` / `npx vitest run -t "Aug 31"` |
| Type check (TypeScript 7) | `npm run typecheck` |

- Rust is installed via rustup but Git Bash may not have it on PATH: `export PATH="$USERPROFILE/.cargo/bin:$PATH"` before `tauri` commands. A full release build takes ~1 min after the first one.
- The running exe locks the binary; stop it before rebuilding (`Get-Process trackview | Stop-Process`).
- There is no linter; `tsc` runs with `strict`, `noUnusedLocals` and `noUnusedParameters`.

## Architecture

Data flows one way: **file bytes → `RawTrack` → `Track` → playback position → UI**.

1. **Parsing (`src/parse/`)** — `index.ts` sniffs the content (ZIP magic → KMZ via fflate, `<gpx`, `<kml`), with the extension as a fallback. `xml.ts` is a small hand-written XML parser that reduces every element/attribute to its *local name*; it exists because browser-stand-ins (happy-dom) lack namespace wildcards and CDATA support, and it makes parsing identical in WebView2 and in Node tests. Parsers emit a `RawTrack` exactly as found in the file (Geo Tracker `meta@s/@c` and `gx:SimpleArrayData` course are radians → converted to degrees; dashcam KMZ start/end time is parsed from the Document description as UTC+07:00).

2. **Building (`src/model/build.ts`)** — `buildTrack(raw, fileName, BuildSettings)` produces the immutable `Track` of aligned typed arrays (`lat/lon/ele/t/seg/dist/speed/playT`, NaN = missing). Key decisions made here:
   - timing mode: `timed` (≥ 90 % points have time), `estimated` (time hint → times spread evenly per point), `untimed` (timeline built from distance at 50 km/h);
   - distance never bridges segment breaks;
   - speed is recorded if ≥ 90 % present, else derived over a ±2-point window, outliers > 250 km/h interpolated;
   - `playT` is the playback timeline: each pause (gap > threshold or segment break) is collapsed to 1 s when "skip pauses" is on; `pauses[]` records them.
   - Spike removal (`spikes.ts`) runs before arrays are built.
   Changing any `BuildSettings` key rebuilds the whole `Track` from the kept `RawTrack` (`main.ts` → `rebuild()`, position kept by distance). Unit changes do not rebuild; they only re-render.

3. **Position → sample (`src/model/interpolate.ts`)** — `sampleAt(track, pos)` binary-searches `playT` and interpolates. Inside a pause the position holds at the last point before it (so the marker jumps across segment breaks).

4. **Playback (`src/player.ts`)** — a rAF clock over `playT` (`pos += dt × rate`, frame delta capped). It emits position and state events; `main.ts` fans them out to the map, chart, info card and readout. Every seek (chart, keyboard) goes through `player.seek`.

5. **Map (`src/map/trackmap.ts`)** — MapLibre GL 6. The line layers live in `tracklayers.ts` (shared with the video export map): the track is split into 32-point line chunks; travelled chunks are recoloured with **feature-state** (`done`) and a small `trk-head` source draws the partial chunk up to the marker, so no geometry is rebuilt per frame. Markers are HTML `Marker`s; the position marker is a `MarkerView` (`marker.ts`: dot / arrow / built-in SVG icon / imported image, rotate or flip by the screen angle). Camera modes (off / north up / heading up / keep in view) use `ViewSmoother` in `camera.ts`: a lag-free average over a window centred on the position, sized in *video* seconds × rate, never crossing a segment break. Smart zoom (`smartzoom.ts`, §15) sets the follow-camera zoom from the smoothed look-ahead speed (curve between Near/Far zoom, Auto speeds = ½×/2× the track average, capped by playback rate, rate-limited by `ZoomFollower`); on the live map a zoom change made by the user between frames becomes an offset. Since §16 that calculation runs once per track (`zoomcurve.ts` simulates it and reduces it to <= 60 control points, linear between them); the live map and the export read `curveAt(knots, pos)`, and `ui/zoomstrip.ts` (strip under the chart) lets the user drag the points. Edited curves are saved per file in `localStorage` (`trackview.zoomcurves.v1`, keyed by recorded time). `ui/smartzoomfields.ts` is the input group shared by the settings drawer and the export dialog. Sources/layers are re-added on every `style.load` (styles are switched with `diff: false`), and feature-state is re-applied. If the style fails to load (offline) it falls back to `BLANK_STYLE` and shows a notice.

6. **Chart (`src/ui/chart.ts`)** — uPlot, x = `playT` seconds, y = smoothed speed (or elevation when there is no speed). Travelled shading is drawn in the `drawClear` hook plus a gradient fill; the red cursor/handle are DOM elements inside `u.over`. The chart only redraws when the cursor moves a whole pixel.

7. **Video export (`src/export/`)** — `timeline.ts` maps frame index → playback position (rate presets in `presets.ts`, fit-to-duration, range, intro/outro). `render.ts` owns a hidden MapLibre map at the output size (`.export-map`, off-screen); per frame it `jumpTo`s the camera, waits for tiles (`settle`), copies the WebGL canvas into a 2D canvas and draws markers plus `overlays.ts` (info card, chart strip, title, attribution). `encode.ts` encodes with Mediabunny (WebCodecs H.264 → MP4, VP9/WebM fallback); desktop streams to a file picked with the Tauri dialog/fs plugins, the browser buffers then downloads. `exportpanel.ts` is the drawer UI.

8. **Other UI (`src/ui/`)** — `phoneview.ts` (§18 phone view: sizes `#map` to the phone's CSS size with a CSS scale to fit, draws the export `Overlays` over it, and tells `TrackMap.setFrame` the strip inset; phone-scale export resolutions carry `dpr` in `presets.ts` and the export map uses it as `pixelRatio`), `infocard.ts` (the info card, updated every 100 ms), `settingspanel.ts` (settings drawer form), `markerpanel.ts` (§14 position-marker group in that drawer). Display helpers in `src/model/`: `series.ts` (5-point smoothed chart series in display units), `units.ts` (metric/imperial conversion and formatting), `geo.ts` (haversine, bearing, distance to a segment). Colours are CSS tokens in `src/styles/tokens.css`.

`main.ts` is the composition root (header, playback bar, file open/drop, keyboard, settings → rebuild/re-render). Settings live in `localStorage` key `trackview.settings.v1` (`settings.ts`; persisted by WebView2 across launches).

## Testing with sample files

- **Do not use big files (tracks over 30 minutes) for testing**: manual checks, browser runs, video export renders and new tests. Use the short samples instead:
  - `Apr_15,_2022_11_14_28.kml`: 2 min, timed, recorded speed
  - `Sep_13,_2026_11_26_19.kmz`: 8 min, timed, recorded speed
  - `Aug_24,_2026_08_07_19.kml`: 19 min of playback (26 min total), timed, recorded speed, 1 stop waypoint
- Over 30 min, avoid: `Aug_31,_2026_15_20_59.gpx` and both `phan thiet …` copies (3 h 28 min playback, 15 h 41 min total), the dashcam `Front_…part1_4.kmz` (38 min), and the untimed `…52100-map.kmz` (3 h at the nominal 50 km/h).
- The existing unit tests that SPEC §11 / §13.9 / §15.7 tie to those long files stay as they are; only add new uses of them when a criterion explicitly names one.

## Gotchas

- MapLibre 6 needs its worker URL set explicitly: `trackmap.ts` imports `maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` and calls `setWorkerUrl` (Vite `worker.format: 'es'`). Without this the map stays blank with "Worker failed to load".
- uPlot scales are only valid after its first commit: position-dependent work at creation must go in the `ready` hook (`valToPos` returns NaN before that).
- Tauri window has `dragDropEnabled: false` so HTML5 drop events reach the page; the CSP in `src-tauri/tauri.conf.json` must allow any new remote host (tiles, fonts).
- Basemaps are online and keyless: OpenFreeMap styles and Esri World Imagery (`src/map/styles.ts`).
- Dev server can serve the samples (`server.fs.allow` includes `../example_GPSfiles`) at `/@fs/C:/Claude/NoWhere/38_GPX_viewer/example_GPSfiles/<name>`; encode spaces as `%20` but leave commas unencoded, or Vite returns `index.html`. In dev, `window.trackview` exposes `{ player, map, chart, info }` for debugging.
- Export map: MapLibre sets `position: relative` on its container, so `.export-map` needs the `.export-map.maplibregl-map` selector to stay `fixed` off-screen (otherwise it lands in the body grid and breaks the layout). `settle()` must not redraw on every `data` event: draws are expensive (this PC's browser has no GPU driver — "Microsoft Basic Render Driver" — so WebGL runs on the CPU, ~0.5 s per 1080p frame).
- Mediabunny: pass bitrate as `new Quality({ bitrate })`; a bare number is not a bitrate (H.264 check fails, files ~12× too big).
- In dev, `window.trackview.exportPanel` is exposed too; to load a sample from the console, fetch it from `/@fs/...` and dispatch a `drop` event with a `DataTransfer` on `window`.
- To reproduce a bug report, use the user's saved settings, not defaults. The desktop app's localStorage is in `%LOCALAPPDATA%\com.phong.trackview\EBWebView\Default\Local Storage\leveldb\*.log` (grep the `trackview.settings.v1` / `trackview.zoomcurves.v1` JSON, decoding as latin-1).
- Avoid O(n²) work in `build.ts`/parsers: files can have 100k+ points and parsing runs on the UI thread (`test/build.test.ts` guards the time-fill path).
