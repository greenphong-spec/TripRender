# Trackview — Specification (v0.4)

A desktop GPS track viewer (web UI in a Tauri shell) that **replays** a recorded trip on a real online map,
with a live info card and a speed chart synced to the map. Target look: `expected_UI.png`.

Status: §1–§12 approved for implementation 2026-10-19 (decisions on the v0.1 open questions are in §12). §13 Video export approved 2026-10-20 (decisions in §13.10). §14 Position marker approved 2026-10-20 (decisions in §14.8). §15 Smart zoom approved 2026-10-21 (decisions in §15.8).

---

## 1. Goals and non-goals

**Goals**
- Open GPX / KML / KMZ files from disk (button or drag-and-drop). Everything is parsed in the browser; track files are never uploaded.
- Show the track on a real online basemap (vector tiles, no API key).
- Replay the trip over time at ×N speed, with the travelled part and the remaining part drawn in different colours.
- Show a live info card: elapsed time, speed, distance, elevation and coordinates at the current position.
- Speed chart under the map, synced with the map both ways (scrub the chart → marker moves; play → chart cursor moves).
- Handle every file in `example_GPSfiles/` correctly (§3), including files with no timestamps.

**Non-goals (v1)**
- Editing tracks, routing, uploading or sharing tracks, user accounts.
- Offline maps / tile download (tiles are fetched online; the browser HTTP cache is enough).
- FIT, TCX, NMEA and other formats (the parser layer is pluggable, so they can be added later).
- Several tracks open at once (one file at a time in v1).
- Changes to the GPXSee C++ code — Trackview is a separate app (see §2).
- An Android build. Not in v1, but the code must stay Android-friendly: touch input works, layout works at phone width, no Windows-only APIs. Tauri 2 can build an APK from the same project later.

## 2. Platform decision

| Option | Verdict |
|---|---|
| Extend GPXSee (Qt/C++) | Rejected for v1. It would need a playback engine, split-colour path drawing, a new info overlay and a transport bar across `MapView`, `PathItem` and `GraphView`. The mockup's look is far from the Qt widget style. |
| **Standalone web app in a Tauri 2 desktop shell** | **Chosen.** The mockup is a web layout. Vector maps, fluid animation and the synced chart are cheap to build here. Tauri wraps the app as a small Windows `.exe` that uses the Edge WebView2 already on the PC, and the same project can target Android later. |
| Electron | Rejected: ~150 MB per app and no Android path. |

**Stack**

| Concern | Choice | Version (verified on npm, 2026-10-19) |
|---|---|---|
| Build / dev server | Vite | 8.3.x |
| Language | TypeScript | 7.0.x |
| Map rendering | MapLibre GL JS | 6.15.x |
| Speed chart | uPlot (small, fast, canvas; custom cursor/shading via hooks) | 1.6.32 |
| KMZ unzip | fflate | 0.8.3 |
| XML parsing | Browser `DOMParser` (no dependency) | — |
| Tests | Vitest | latest 3.x/4.x |
| Desktop shell | Tauri 2 (Rust, WebView2) | 2.x |

No framework (React etc.). The UI is small: plain TS modules plus CSS. Node 24 is installed locally.

**Tauri specifics**
- The window opens at 1440×900 (minimum 960×600), titled "Trackview".
- `dragDropEnabled: false` on the window, so HTML5 drag-and-drop reaches the page. (Tauri otherwise captures file drops on Windows.)
- Files are opened through the HTML `<input type=file>` and drop events. No Rust file-system plugin is needed in v1.
- The CSP allows `https:` for tiles, styles, fonts and glyphs, and `blob:` for MapLibre workers.
- Commands: `npm run dev` (browser), `npm run tauri dev` (desktop window, hot reload), `npm run tauri build` (produces `Trackview.exe` and an installer under `src-tauri/target/release/`).

**Deliverable**: a `trackview/` folder at the repo root. `npm run dev` runs it in the browser, `npm run tauri build` produces the desktop `.exe`, and `npm test` runs the tests against `example_GPSfiles/`.

## 3. Sample-file analysis (`example_GPSfiles/`)

| File | Format / producer | Geometry | Time | Speed / course | Points | Distance | Notes |
|---|---|---|---|---|---|---|---|
| `Aug_31,_2026_15_20_59.gpx` | GPX 1.1, Geo Tracker (Android) | 3 `trkseg` | per point, UTC `Z` | `<geotracker:meta s="m/s" c="rad">` per point | 7,536 | 150.1 km | 11 h 47 min gap between seg 2 and seg 3; 16 pauses > 60 s; 5 points with dt ≤ 0; 5 `wpt` (stops; 2 "Current location" pins dated 10 h after the track ends) |
| `phan thiet sai gon cao toc 31.08.gpx` | same | same | same | same | 7,536 | 150.1 km | Same ride; 3 `wpt` |
| `phan thiet sai gon cao toc 31.08 (1).gpx` | same | | | | | | **Byte-identical** to the file above (md5 `e2de407c`) |
| `20260908081016-52100-map.kmz` | KML 2.2, GPS Visualizer export | 1 Placemark, 3 `LineString` (same 3 segments) | **none** | none | 7,536 | 150.1 km | Untimed conversion of the Aug 31 ride; 3 stop Placemarks (Points) |
| `Apr_15,_2022_11_14_28.kml` | KML 2.2 + `gx:`, Geo Tracker | `gx:MultiTrack` → `gx:Track` | `<when>` per point | `SimpleArrayData speed` (m/s), `course` (rad) | 112 | 1.4 km | 1 s sampling |
| `Aug_24,_2026_08_07_19.kml` | same | same | same | same | 362 | 5.1 km | 1 stop Placemark with its own `<TimeStamp>` (its `<when>` must not be counted as a track point) |
| `Sep_13,_2026_11_26_19.kmz` | KMZ (`doc.kml`), Geo Tracker | `gx:Track` | `<when>` | speed, course | 163 | 2.3 km | |
| `Front_2026…part1_4.kmz` | KMZ (`doc.kml`), "DashCam GPS Extractor" | 1 `LineString` | **none per point**; Start/End only, in the Document `<description>` as camera local time (Asia/Saigon, no offset) | none per point; max/avg only in the description | 2,189 | 22.4 km | 355 duplicate consecutive points (vehicle stopped); ~1 Hz (2,189 points over 38 min 15 s); altitude always 0 |

**What this means for the design**

1. Three kinds of timing must be supported: **timed** (GPX `<time>`, KML `gx:Track`), **estimated** (only a start/end time is known) and **untimed** (no time at all). See §5.3.
2. Distance must **not** bridge segment breaks. Bridging adds ~15 km to the Aug 31 ride (165.5 km vs 150.1 km). The within-segment sum, 150.12 km, matches Geo Tracker's own `geotracker:length` of 149.92 km within 0.2 %.
3. Long pauses would make ×N playback useless (11 h 47 min idle = 3 min of nothing even at ×240), so pauses are collapsed by default (§5.4).
4. Recorded speed exists in most files and is cleaner than speed derived from positions, so it is preferred when present.
5. All timestamps are UTC. The rides are in Vietnam, and file names use local time (`15_20_59` = 08:20:59Z), so clock times are shown in a configurable time zone, defaulting to the browser's zone.
6. The largest sample has 7.5k points. The performance target is 100k points (§9).

## 4. Data model

```ts
interface TrackPoint {
  lat: number; lon: number;       // degrees, WGS84
  ele: number | null;             // metres; null if missing (or always 0 in the dashcam file → treated as missing)
  t: number | null;               // epoch ms (UTC); null for untimed tracks
  speedRec: number | null;        // recorded speed, m/s
  courseRec: number | null;       // recorded course, radians → converted to degrees for display
  seg: number;                    // segment index
}

interface Track {
  name: string;                   // <metadata><name> / <Document><name> / file name
  fileName: string;
  format: 'gpx' | 'kml' | 'kmz';
  timing: 'timed' | 'estimated' | 'untimed';
  points: TrackPoint[];           // sorted and cleaned (§5.2)
  waypoints: Waypoint[];          // name, lat, lon, ele?, t?, desc?
  // derived (§5.5), arrays aligned with points:
  dist: Float64Array;             // cumulative metres (no bridging across segments)
  speed: Float32Array;            // m/s (recorded or derived)
  playT: Float64Array;            // playback-timeline ms (pauses collapsed)
}
```

## 5. Processing pipeline

### 5.1 Parsing
- **Format detection** by extension, then by content sniffing (`<gpx`, `<kml`, ZIP magic `PK\x03\x04`).
- **GPX 1.0/1.1**: `trk/trkseg/trkpt` (`lat`, `lon`, `ele`, `time`), `rte/rtept` as a fallback track, `wpt` → waypoints. Speed, in this order: `<speed>` (GPX 1.0), `gpxtpx:speed` (Garmin TrackPointExtension), `geotracker:meta@s`. Course: `<course>` / `geotracker:meta@c` (radians).
- **KML**: match tags by local name, so it works with any namespace prefix.
  - `gx:Track`: pair the *direct-child* `<when>` and `<gx:coord>` elements in order ("lon lat alt", space-separated). `ExtendedData/SchemaData/gx:SimpleArrayData[@name=speed|course]` → `speedRec` / `courseRec`. Each `gx:Track` inside a `gx:MultiTrack` is one segment.
  - `LineString`: `coordinates` ("lon,lat,alt", whitespace-separated); each LineString is one segment, untimed.
  - `Point` Placemarks → waypoints. Use the Placemark's `TimeStamp/when` if present. Skip "Start"/"End" markers that sit exactly on the track's first/last point.
  - If a file contains both a `gx:Track` and a `LineString`, use the `gx:Track`.
- **KMZ**: unzip with fflate. Use `doc.kml` if present, otherwise the first `*.kml` entry (the 52100 file uses `20260908081016-52100-map.kml`).
- Malformed or empty file → a readable error toast; the app keeps the previous track.

### 5.2 Cleaning
- Drop points with non-finite or out-of-range lat/lon.
- Timed tracks: sort points by `t` within each segment (stable sort), then merge points with identical `t` (keep the last one). This fixes the 5 dt ≤ 0 points in the Aug 31 file.
- Keep duplicate consecutive positions — they represent stopped time.
- **Off-route spike filter** (setting "Remove GPS spikes", default **on**). It removes points that jump away from the route and back. It runs within each segment, comparing each candidate point *p* with the last kept point *a* and the next point *c*. *p* is dropped when either:
  - **detour**: *p* lies more than `spikeDistance` (default **50 m**, configurable 10–500 m) from the line *a*–*c*, **and** (|ap| + |pc|) / |ac| > 3; or
  - **impossible speed** (timed tracks only): the speed implied from *a* to *p* is above 250 km/h.

  This also catches spikes of up to 3 consecutive points, because *c* moves forward while *a* stays put; after 3 points the run is kept as real movement. The first and last point of a segment are never dropped. The number of removed points is shown in the settings panel ("3 spike points removed"). Turning the setting off reloads the track without filtering.
  The samples contain no spikes: the largest deviation from the route is 18 m. So with the default 50 m the filter must remove **0** points from every sample file, and its behaviour is tested with synthetic spikes.

### 5.3 Timing modes
| Mode | When | Timeline |
|---|---|---|
| `timed` | ≥ 90 % of points have a time | Real timestamps. Points without a time get an interpolated value. |
| `estimated` | No per-point time, but a start/end time is found: dashcam `Start: … End: …` text in `<description>`, or a `TimeSpan` | Times spread **evenly per point** between start and end (the dashcam log is ~1 Hz). The UI shows an "Estimated time" badge. Camera local time has no offset in the file and is read as UTC+07:00. Only durations matter for playback, so a wrong offset would only change the clock text. |
| `untimed` | Nothing found | Playback by **distance**: the timeline is built at a nominal 50 km/h. The chart shows **elevation vs distance**, or a distance-only progress bar if elevation is missing. Speed shows "—". Badge "No time data". |

### 5.4 Pauses (timed / estimated)
- A *pause* is a time gap between consecutive points greater than **`pauseThreshold` (default 60 s)**, or any segment break.
- **Skip pauses** toggle (default **on**): each pause takes **1 s** on the playback timeline (`playT`). The marker holds still and the info card shows a "Paused 11 h 47 min" chip during that second. Off: real time is used.
- The chart x-axis follows `playT` (so it uses moving time when skipping), with a thin dashed break mark at each collapsed pause.
- Header and footer show **total time** and **moving time**: "03:27:30 moving · 15:41:33 total".

### 5.5 Derived values
- **Distance**: haversine (R = 6,371,008.8 m), summed within segments only.
- **Speed**: use `speedRec` if ≥ 90 % of points have it. Otherwise derive it as distance/time over a centred ±2-point window. Values above 250 km/h, or implying more than 15 m/s² acceleration, are treated as outliers and replaced by interpolation.
- **Estimated-time tracks (dashcam)**: setting "Speed for estimated timing" = **Derived** (default; computed as above from the estimated times) or **Hidden**. Hidden shows "—" in the info card and the elevation/distance chart instead, and the footer shows the avg/max stated in the file's description (e.g. "Max 99 km/h · Avg 35.2 km/h").
- **Chart smoothing**: a 5-sample moving average for display only. The info card shows the unsmoothed, interpolated value.
- **Stats**: avg speed = moving distance / moving time; max speed = 99th-percentile-capped maximum of speed after outlier removal; total distance; elevation min/max and gain (ignoring changes under 3 m).

### 5.6 Interpolation at any playback time
Binary-search `playT` for the bracketing points i, i+1 and compute the fraction f. Lat/lon (linear is fine at these spacings), ele, dist, speed and clock time are all linear in f. Bearing for the marker arrow: course if recorded, otherwise the bearing from point i to point i+1.

## 6. Map

### 6.1 Basemap — online, free, no key
| Style | Source | Use |
|---|---|---|
| **Light (default)** | OpenFreeMap `https://tiles.openfreemap.org/styles/positron` | Clean grey-green look matching the mockup |
| Streets | OpenFreeMap `…/styles/liberty` | Colourful street map |
| Satellite | Esri World Imagery raster `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` | No key needed; fine for this personal desktop use. Attribution "Esri, Maxar, Earthstar Geographics" shown. Replace it only if the app is ever published. |

- All three endpoints were checked and respond (HTTP 200, 2026-10-19).
- OpenFreeMap: OpenStreetMap data, no API key, no registration, no published request limit. Attribution "© OpenFreeMap © OpenMapTiles Data from OpenStreetMap" stays visible at all times (MapLibre attribution control).
- The style list lives in one config file (`src/map/styles.ts`), so a keyed provider (MapTiler, Stadia) can be added later by pasting a URL and key.
- **No tile database or offline cache** in v1; the browser HTTP cache is enough.
- **Offline / tile failure**: the track, markers and chart still render on a plain background, with a small "Map tiles unavailable — offline?" notice. Playback keeps working.

### 6.2 Layers (top to bottom)
1. Current-position marker: by default the built-in **car** icon (§14.1), 24 px, accent red, rotating with the heading, with a soft halo (pulsing while playing). The alternative "Dot" type is a 10 px dot in accent red with a white ring and a 24 px soft halo, plus a small heading wedge when course data exists. Shape, image and size can be changed (§14).
2. Waypoints: 8 px blue dots, with the name shown in a tooltip on hover or click.
3. Start: 8 px green dot. End: 9 px black square.
4. **Travelled path**: accent red `#D2401E`, 4 px, round joins.
5. **Remaining path**: slate `#5B6B76`, 3 px.
6. Segment breaks are not joined. During a collapsed pause that spans a segment break, the marker jumps.

Splitting is done by MapLibre `line-gradient` with `lineMetrics: true` on one GeoJSON line per segment, updating the gradient stop at the current progress each frame. This is cheap and avoids rebuilding geometry. If perf tests show this is too slow, fall back to updating a "travelled" source with a sliced coordinate array at a throttled 15 Hz.

### 6.3 Map controls (bottom-right, 44 px square white buttons)
- **Zoom readout** above the buttons: the current map zoom with one decimal ("z 14.2"; "z 15.2 auto" while Smart zoom drives it, §15), updated live while zooming. Clicking the readout toggles Smart zoom on/off (§15.5). A small copy icon next to it copies the number to the clipboard (toast "Zoom 14.2 copied"), so it can be reused later, e.g. typed into Export video → Zoom (§13.3, which also has "Use current map zoom").
- Zoom in (+), zoom out (−).
- **Fit / follow** (crosshair icon). When stopped, one click fits the whole track. While playing, each click moves to the next **camera mode** (§13.4): Off → Follow north up → Follow heading up → Keep in view → Off. The button shows the active mode. "Keep in view" pans the camera to keep the marker inside the middle 60 % of the view. Any manual pan or rotate sets the mode to Off.
- Style switcher (layers icon): Light / Streets / Satellite.
- On file load: fit the track bounds with 60 px padding (plus room for the info card).

## 7. UI layout (from `expected_UI.png`)

```
┌─ Header 56px ──────────────────────────────────────────────────────────────┐
│ [logo] Trackview │ [morning_ride.gpx] 29.2 km · 01:12:00 · 241 points       │
│                            Drop a file or [Open file]  [GPX][KML][KMZ]      │
├─ Map (flex) ───────────────────────────────────────────────────────────────┤
│ ┌ Info card ┐                                                              │
│ │ AT 00:24:29 │                                           [+]              │
│ │ Speed  Distance│                                        [−]              │
│ │ Elev.  Position│                                        [⌖]              │
│ └────────────┘                                            [▤]              │
│ [attribution]                                                              │
├─ Playback bar 64px ────────────────────────────────────────────────────────┤
│ (▶)  [×60 ×120 ×240 ▾]  00:24:29 / 01:12:00   Avg 24.3 km/h  Max 37.2  Dist │
├─ Chart 140px ──────────────────────────────────────────────────────────────┤
│ km/h  ▒▒▒ travelled shaded ▒▒▒ │cursor+handle│ remaining                    │
└────────────────────────────────────────────────────────────────────────────┘
```

### 7.1 Header
- Logo mark and "Trackview".
- File chip (monospace) with the file name; the full name is in a tooltip if truncated.
- Summary: distance · duration (moving) · point count.
- **Settings** gear button at the far right (§7.7).
- "Drop a file or" + **Open file** button (teal `#0F5C5C`), plus GPX / KML / KMZ format chips (static labels).
- The whole window is a drop target. While dragging over it, show a full-window dashed overlay "Drop GPX, KML or KMZ".

### 7.2 Info card (top-left overlay, 270 px wide, white, 12 px radius, soft shadow)
- **AT** label + elapsed playback time, large monospace (`HH:MM:SS`). The timeline always runs from 00:00:00 to the track duration. The real clock time appears only here, as a small line under the elapsed time (e.g. "15:45:30 · 31 Aug 2026", in the PC's time zone; "—" for untimed tracks).
- 2×2 grid: **Speed** (km/h or mph, 1 decimal), **Distance** (km or mi, 1 decimal), **Elevation** (m or ft, integer), **Position** (lat/lon, 5 decimals, with N/S/E/W).
- Badges when they apply: "Estimated time", "No time data", "Paused …".
- Values update at most every 100 ms (to avoid flicker) using tabular digits.
- Collapsible to just the time row (chevron) on small screens.

### 7.3 Playback bar
- **Play/Pause** — 44 px teal circle. Space bar toggles it.
- **Speed chips** — ×60, ×120 (default), ×240 as in the mockup, plus a "▾" menu for ×1, ×10, ×30, ×600, ×1200. On load the default is auto-picked: the smallest listed speed that makes the whole replay ≤ 90 s. Examples: Aug 31 (3 h 28 min after collapsing pauses) → ×240 (52 s); Apr 15 (2 min) → ×10 (12 s).
- **Time readout**: `elapsed / total` (monospace), using the playback timeline.
- Stats on the right: Avg, Max, Distance.
- When playback reaches the end, it stops with the marker on the end point. Pressing Play again restarts from the beginning.
- Keyboard: Space = play/pause; ←/→ = step 10 s of track time (Shift = 60 s); Home/End = jump to start/end; `+`/`-` = next/previous speed.

### 7.4 Speed chart
- Area chart of speed (km/h) over the playback timeline; untimed tracks show elevation over distance instead.
- Teal line `#1F5F5B` with a light teal fill. The travelled region gets a light red tint `#FBEDEA` and grey fill.
- Y axis label "km/h" top-left, with 3–4 faint horizontal gridlines. The X axis shows no labels (as in the mockup); the time shows in a hover tooltip.
- **Cursor**: a red vertical line at the playback position, with a draggable red handle below the plot. Dragging the handle or clicking anywhere on the chart seeks there. Seeking pauses playback; it resumes if it was playing before the drag started.
- **Hover**: a blue dot on the line plus a tooltip (time, speed, distance) and a ghost marker on the map. Hover does not move playback.
- Collapsed pauses are drawn as dashed vertical break marks.

### 7.5 Visual tokens
| Token | Value |
|---|---|
| Accent (travelled, cursor) | `#D2401E` |
| Primary (buttons, chart line) | `#0F5C5C` / `#1F5F5B` |
| Remaining path | `#5B6B76` |
| Waypoint blue | `#1E5AA8` |
| Start green / end black | `#2E7D4F` / `#1A1A1A` |
| Surfaces | `#FFFFFF` panels, `#F2F3EF` page |
| Font | IBM Plex Sans (UI) + IBM Plex Mono (numbers), from Google Fonts with system fallback |

Light theme only in v1; all colours are CSS variables, so a dark theme can be added later.

### 7.6 Responsive
- ≥ 1024 px: the layout above.
- < 1024 px: the stats move to a second row of the playback bar.
- < 640 px: the info card collapses to a single line, the chart is 100 px tall, map controls are 40 px, and the header shows the file chip only (the open button becomes an icon).

### 7.7 Settings panel
A right-side drawer (360 px; full width on a phone) opened from the header gear. Changes apply immediately and are saved (§8).

| Setting | Options | Default |
|---|---|---|
| Units | Metric (km/h, km, m) / Imperial (mph, mi, ft) | Metric |
| Map style | Light / Streets / Satellite | Light |
| Skip pauses | on / off | on |
| Pause threshold | 10 s – 30 min | 60 s |
| Remove GPS spikes | on / off, plus the spike distance (10–500 m) | on, 50 m |
| Speed for estimated timing | Derived / Hidden | Derived |
| Camera while playing (§13.4) | Off / Follow north up / Follow heading up / Keep in view | Keep in view |
| Smart zoom (§15) | on / off, plus Near zoom, Far zoom, slow and fast speed (text inputs) | off; 17 / 13; speeds from the track average (½× / 2×) |
| Position marker (§14) | Dot / Arrow / built-in icon / imported image; size; colour; rotation | Car icon, 24 px, accent red, rotate |

The panel also shows read-only file info: format, producer (`creator`), timing mode, number of points and segments, and spike points removed.

### 7.8 Empty state
With no file loaded: the map shows the default view (last viewed area, or Vietnam if none saved), the chart area shows "Open a GPX, KML or KMZ file to replay it", and playback controls are disabled. A "Try a sample" link loads a bundled copy of `Sep_13,_2026_11_26_19.kmz` (small, timed, with recorded speed).

## 8. Playback engine
- State: `playing: boolean`, `rate: number`, `pos: number` (ms on the playback timeline), `duration`.
- A `requestAnimationFrame` loop: `pos += (now − last) × rate`, clamped to `[0, duration]`. The frame delta is capped at 100 ms, so a background tab doesn't jump.
- One `onPosition(pos)` event fans out to: the map marker and gradient, the info card (throttled to 100 ms), the chart cursor and the follow camera.
- Seeking from the chart, keyboard or end-of-track goes through the same `seek(pos)` call.
- Settings saved in `localStorage` (wrapped in try/catch; WebView2 keeps it between app launches): every setting in §7.7 (including the camera mode and the position marker with its imported image), the last export options (§13.6), the last playback rate and the last map view.

## 9. Performance targets
| Item | Target |
|---|---|
| Parse + derive, 7.5k-point GPX (1.7 MB) | < 300 ms |
| Parse + derive, 100k points | < 2 s, with no frozen UI (spinner shown) |
| Playback frame rate | 60 fps on a mid-range laptop for 100k points |
| Chart | Line simplified to ≤ 2 points per horizontal pixel for drawing |
| Map line | Douglas–Peucker simplification per zoom by MapLibre (built in); no manual decimation unless it fails the 60 fps target |

## 10. Project structure
```
trackview/
  index.html
  package.json, tsconfig.json, vite.config.ts
  public/samples/sample.kmz  copy of Sep_13,_2026_11_26_19.kmz ("Try a sample")
  src/
    main.ts                 app wiring: header, playback bar, open/drop, keyboard, toast
    player.ts               playback clock + auto rate
    settings.ts             settings model + persistence
    parse/ xml.ts gpx.ts kml.ts index.ts   (own small XML parser; KMZ unzip in index.ts)
    model/ types.ts geo.ts build.ts spikes.ts interpolate.ts units.ts series.ts (chart values, shared with the video)
    map/ trackmap.ts styles.ts tracklayers.ts camera.ts marker.ts smartzoom.ts
                            (track line layers shared with the export map; camera modes §13.4; position marker §14; smart zoom §15)
    export/ presets.ts timeline.ts render.ts overlays.ts encode.ts exportpanel.ts   (video export §13)
    ui/ chart.ts infocard.ts settingspanel.ts markerpanel.ts smartzoomfields.ts (§15.2 inputs, used in settings and export)
    styles/ tokens.css app.css
  test/ (Vitest) samples.test.ts spikes.test.ts build.test.ts export.test.ts smartzoom.test.ts
  src-tauri/                Tauri 2 shell (Cargo.toml, tauri.conf.json, src/main.rs, icons/)
```

## 11. Acceptance criteria
Tests run against the files in `example_GPSfiles/`:

1. **Aug 31 GPX**: 3 segments, 7,536 points (after merging same-time duplicates: 7,531 or more). Distance is 150.1 km ± 0.5 km and is **not** 165 km. Speed uses recorded `s`, and the max is about 115 km/h. Skip pauses on: the replay timeline is about 3 h 28 min (all 17 pauses collapsed, including Geo Tracker's ~2 min stops), and ×240 finishes in ≤ 60 s. 5 waypoints are shown.
2. **Both "phan thiet…" GPX files** load identically to each other.
3. **52100 KMZ**: untimed mode, 3 segments, about 150 km. The chart shows elevation vs distance. 3 stop waypoints are shown. No crash on the CDATA names.
4. **Apr 15 / Aug 24 KML, Sep 13 KMZ**: timed mode with recorded speed. Point counts are 112 / 362 / 163, and the stop Placemark's `<when>` is not counted as a point.
5. **Dashcam KMZ**: estimated mode. Times run from 08:41:09 to 09:19:24 +07:00, distance is 22.4 km, the elevation tile shows "—" (all altitudes are 0), and the "Estimated time" badge is visible.
6. Dragging the chart handle moves the map marker and updates the info card in the same frame. Playing moves the chart cursor.
7. The travelled path is red up to exactly the marker, and the rest is slate.
8. With the network disabled, a file still loads, plays and charts, and the offline notice is shown.
9. The layout matches `expected_UI.png` at 1440×900, with no horizontal scroll at 375 px width.
10. **Spike filter**: it removes 0 points from every sample file. On a synthetic copy of the Apr 15 track with 1-, 2- and 3-point spikes injected 300 m off-route, every spike point is removed and no other point is.
11. **Units**: switching to Imperial shows the Aug 31 distance as 93.3 mi and its max speed as about 71 mph, with no reload needed.
12. **Desktop**: `npm run tauri build` produces a working `Trackview.exe`. In it, drag-and-drop of a file from Explorer works, tiles load, and settings survive a restart.

## 12. Decisions (v0.1 open questions, answered 2026-10-19)
| # | Question | Decision |
|---|---|---|
| 1 | Pause threshold | Keep 60 s (configurable). Additionally, add the **off-route spike filter** (§5.2), on by default. |
| 2 | Time zone | Not important. The timeline runs 0 → duration; the clock time is shown only as a text line in the info card, in the PC's zone (§7.2). |
| 3 | Units | Metric by default; Imperial in settings (§7.7). |
| 4 | Dashcam speed | Derived speed by default; can be set to Hidden in settings (§5.5). |
| 5 | Satellite | Keep Esri World Imagery as the simple no-key option for personal use (§6.1). |
| 6 | Delivery | Desktop app on Windows via **Tauri 2** now (§2); keep the code Android-ready for a later APK. |

---

## 13. Video export (v0.3)

Render the replay of the loaded track to a video file: the map with the travelled/remaining path and the moving marker, with the info card and speed chart optionally burned in. Status: **approved 2026-10-20**; the decisions are in §13.10.

### 13.1 How it works
- Rendering is **offline, frame by frame**, not a screen recording. For each output frame the export computes the playback position, moves a dedicated off-screen map there, **waits until every tile in view has loaded**, then grabs the frame. The video is smooth and has no missing tiles however slow the PC or network is; rendering may take longer or shorter than the video itself.
- The export uses its **own hidden MapLibre map**, sized to the output resolution with `pixelRatio` 1 and `preserveDrawingBuffer: true`. The visible map, the player and the rest of the UI are not touched (they are blocked behind the export dialog while it renders).
- Each frame is composed on a 2D canvas at the output size (map canvas → start/end and position markers → overlays §13.5 → attribution), encoded with **WebCodecs `VideoEncoder`** (H.264) and muxed to **MP4** with **Mediabunny** (pure TS, no ffmpeg; check the current version on npm when implementing). WebCodecs exists in WebView2, Chrome and the Android WebView, so no native code is needed and the feature stays Android-friendly.
- If H.264 is not supported (`VideoEncoder.isConfigSupported`), fall back to **VP9 in WebM**. If that also fails, export is disabled with an explanation.
- Frames are fed with back-pressure (each frame waits for Mediabunny's `CanvasSource.add`, which waits for the encoder and the writer), so memory stays flat however long the video is.
- Bitrate is passed as `new Quality({ bitrate })`. (A bare number is not a bitrate in Mediabunny: it made the H.264 check fail and produced ~12× larger files.)

### 13.2 Playback speed (video time vs track time)
The video covers the playback timeline `playT` (§5.4), so **Skip pauses** applies exactly as on screen: each collapsed pause takes 1 s of track time.

| Option | Rate | Aug 31 GPX (3 h 28 min moving) | Dashcam KMZ (38 min) |
|---|---|---|---|
| **Realtime** | ×1 | 3 h 28 min video | 38 min |
| ×2 | ×2 | 1 h 44 min | 19 min |
| ×4 | ×4 | 52 min | 9 min 34 s |
| ×10 (default) | ×10 | 20 min 50 s | 3 min 50 s |
| ×30 | ×30 | 6 min 56 s | 1 min 17 s |
| ×60 | ×60 | 3 min 28 s | 38 s |
| **Fit to duration** | track duration ÷ target | target 60 s → ×208 | 60 s → ×38 |

- The preset list (rates, labels and the default) is **one constant in one file** (`src/export/presets.ts`), so presets can be added, removed or re-ordered later without touching the dialog or the renderer. The dialog builds its chips from that list.

- **Realtime is the slowest option**: there is no slow motion. "Fit to duration" takes 10 s up to the track duration (mm:ss input); a longer target is clamped to realtime.
- Before rendering, the dialog shows the resulting **rate, video length, frame count and estimated file size**. If the video would be longer than 30 min it warns ("3 h 28 min video, ~12 GB — consider ×10 or Fit to duration") but still allows it.
- **Range**: whole track (default) or **From / To** on the playback timeline. "Use current position" buttons fill From/To from the player, so part of a trip can be picked by scrubbing the chart.

### 13.3 Zoom
- **Zoom level** slider 3–18 (MapLibre zoom), default **14** (about 2–3 km across a 1920 px frame; streets readable). Slider labels: 10 "Region", 12 "City", 14 "Streets", 16 "Close".
- "Use current map zoom" copies the zoom of the visible map.
- The zoom is fixed for the whole video, except:
  - **Intro** (default on): 2 s on the whole-track overview, then a 1.5 s fly-in to the chosen zoom at the start point.
  - **Outro** (default on): a 1.5 s zoom-out to the overview at the end, held for 2 s.
- Zoom does not apply to the "Whole track" camera mode (§13.4).

### 13.4 Camera — tracking the vehicle
| Mode | Behaviour |
|---|---|
| **Follow, north up** (default) | The marker stays at the frame centre and the map moves under it. North is up. |
| **Follow, heading up** | The marker sits at 65 % of the frame height (more road ahead is visible) and the map rotates so the direction of travel points up. Optional **3D tilt** 0–60° (default 0). |
| **Keep in view** | The camera only pans when the marker leaves the middle 60 % of the frame (the on-screen follow rule, §6.3). Less motion. |
| **Whole track** | Static camera fitted to the track (or the selected range) with 8 % padding. Only the marker and the path colours change. |

- Camera motion is **smoothed in video time**, not track time, so it looks the same at every rate. Because the whole track is known in advance, the smoothing is an average over a window **centred** on the position (no lag, unlike a time-constant filter, which would leave the camera kilometres behind at ×200): position over ±0.3 s of video, bearing (as unit vectors) over ±1.0 s. Near a segment end the window shrinks equally on both sides, so the average stays on the marker.
- Bearing for heading-up: recorded course if present, otherwise the bearing over the next ~30 m of track (avoids jitter at 1 Hz sampling). Below 3 km/h the bearing is held, so the map does not spin while stopped.
- At a segment break (marker jump) the camera cuts instead of panning.

**On-screen use:** the same modes (except Whole track) replace the old follow on/off toggle in the live viewer. §7.7 "Camera while playing" picks the mode (Off / Follow north up / Follow heading up / Keep in view; default Keep in view, matching the old behaviour), and the fit/follow button (§6.3) cycles through them. The camera code is shared (`src/map/camera.ts`), so what you see while playing is what the video shows. The old `follow: boolean` setting migrates to Keep in view (true) or Off (false).

### 13.5 Output and overlays
| Option | Choices | Default |
|---|---|---|
| Resolution | 1280×720 · 1920×1080 · 3840×2160 (if the encoder supports it) · 1080×1920 vertical (phone) · 1080×1080 square | 1920×1080 |
| Frame rate | 30 / 60 fps | 30 |
| Quality | Standard (8 Mbps at 1080p30) / High (16 Mbps); scaled by pixel count and fps | Standard |
| Map style | Light / Streets / Satellite | the current style |
| Info card | on / off — the §7.2 card (time, speed, distance, elevation, position), top-left | on |
| Speed chart strip | on / off — the §7.4 chart with travelled shading and cursor, along the bottom 16 % of the frame | on |
| Title | off / file name / custom text, top-centre | off |
| Time shown | elapsed (00:00:00 →) / real clock time / both | both (as in the app) |

- Overlays are drawn straight onto the canvas with the app's tokens (§7.5) and fonts, scaled by the frame's shorter side ÷ 1080 (so a vertical 1080×1920 frame uses the 1080 p sizes). They are not DOM screenshots.
- In the follow modes the camera keeps the marker centred in the map area **above** the chart strip; the whole-track overview also leaves room for the info card.
- The **map attribution** ("© OpenFreeMap © OpenMapTiles Data from OpenStreetMap", or the Esri line for satellite) is always drawn bottom-right and cannot be turned off; the tile licences require it.
- Units follow the app setting (§7.7).

### 13.6 Dialog and flow
1. An **Export video** button (film icon) in the playback bar next to the speed chips; disabled with no track. Shortcut `E`.
2. The dialog is a right drawer like Settings (full screen on a phone). It holds §13.2–§13.5 plus a **live preview**: a small frame at the output aspect ratio showing the current position with the chosen camera, zoom and overlays, updated as options change.
3. **Render** → progress view: frame `n / N`, percent, elapsed and remaining time, and a thumbnail of the latest frame. **Cancel** stops at once and discards the output.
4. When done: **Save**. In the desktop app, a native Save As dialog (Tauri `plugin-dialog` + `plugin-fs`); in the browser, a normal download. Suggested name `<track name>_<rate>_<resolution>.mp4`, e.g. `Aug_31_2026_x10_1080p.mp4` or `…_60s_1080p.mp4`.
5. The last used export options are saved with the other settings (§8).

### 13.7 Robustness
- **Tile wait** per frame: up to 10 s for the map to become idle; after that the frame is rendered with whatever has loaded, and the end screen reports "12 frames rendered with missing tiles". Offline, export still works on the plain background (§6.1) after a warning.
- The wait draws the map (`map.redraw()`, synchronous) once to request the tiles, then waits on map `data`/`error` events **without drawing** until all tiles and sources are loaded, then draws once more. Drawing on every event cost ~25 draws per frame.
- Raster fade (`raster-fade-duration`) and symbol fade (`fadeDuration`) are 0 on the export map, so every frame shows fully drawn tiles.
- Track data stays local; only tile requests go to the network, as in the viewer.
- Memory: at most ~10 frames in flight. In the desktop app the encoded output streams to the chosen file (Mediabunny stream target → Tauri fs), so the Save As dialog comes **before** rendering there. The browser build buffers in memory and warns above ~2 GB.
- The export loop is a promise chain, not `requestAnimationFrame`, so it keeps going while the window is minimised or in the background.

### 13.8 Performance targets
| Item | Target |
|---|---|
| Render speed, 1080p30, tiles cached | ≥ 30 frames/s on a mid-range laptop (render at least as fast as the video plays) |
| Render speed, tiles not cached | network-bound; the first Aug 31 export at ×10 (37.5k frames) under 30 min |
| Extra memory during export | < 500 MB, independent of video length |

Measured 2026-10-20 on the development PC, whose browser has no GPU driver (WebGL runs on "Microsoft Basic Render Driver", i.e. the CPU): about 0.5 s per 1080p frame with tiles cached, most of it reading the WebGL frame back. A PC with a working GPU driver is expected to be much faster.

### 13.9 Acceptance criteria
1. **Apr 15 KML, Realtime, 1080p30, Follow north up, zoom 16**: a 2 min MP4 (± 1 frame, plus intro/outro if on) that plays in Windows Media Player / Films & TV and VLC. The marker is centred in every frame; no blank tiles with the network on.
2. **Aug 31 GPX, Fit to duration 60 s**: the video lasts 60 s plus intro/outro, the dialog shows ×208, the 11 h 47 min pause takes 1 s of track time, and at segment breaks the camera cuts.
3. **Heading up** on the Aug 24 KML: the direction of travel points up, and the map does not spin while the vehicle is stopped.
4. **Whole track**: the camera never moves, and the whole track (or the selected range) is visible.
5. **Range**: From/To taken from chart positions gives a video starting and ending at those positions.
6. **Overlays**: info card values in a frame equal the app's info card at the same position; the attribution is visible in every frame.
7. **Cancel** stops within 1 s and leaves no file. Export does not change the visible map, the player position or any setting except the saved export options.
8. **Vertical 1080×1920** output works, with the overlays laid out for portrait.
9. **Dashcam KMZ** (estimated time) exports with the "Estimated time" badge in the info card.
10. Unit tests (no MapLibre needed): frame index → playback position (rate, fit-to-duration, range, intro/outro) and the camera smoothing.

### 13.10 Decisions (answered 2026-10-20)
| # | Question | Decision |
|---|---|---|
| 1 | Speed range | Realtime is the **slowest** speed (no slow motion). Presets ×1, ×2, ×4, ×10, ×30, ×60 plus Fit to duration. The preset list is a single constant that is easy to change later (§13.2). |
| 2 | Default rate | ×10 |
| 3 | Camera modes in the live viewer | Yes: they replace the follow toggle, with shared code (§13.4, §6.3) |
| 4 | Info card and speed chart in the video | Both on by default |
| 5 | Default resolution / frame rate | 1920×1080, 30 fps |
| 6 | Intro/outro overview shots | On by default |
| 7 | Audio | None (silent video) |
| 8 | Range | Whole track by default; From/To range available |

---

## 14. Position marker (v0.3)

The moving marker that shows the vehicle's current position can be changed: its shape, an imported image, its size and how it rotates. The same marker is used on the live map and in exported videos (§13), drawn by one shared module (`src/map/marker.ts`).

### 14.1 Marker types
| Type | Look | Rotates with heading |
|---|---|---|
| **Dot** | The v0.1 marker (§6.2): coloured dot, white ring, halo, small heading wedge when course is known | wedge only |
| **Arrow** | A navigation arrow (chevron shape) in the marker colour with a white outline and soft shadow | yes (default) |
| **Built-in icon** (default: car) | A small bundled SVG set: car (the default icon), motorbike, bicycle, walker, truck, boat. Top-down drawings so that rotating them looks natural | yes (default) |
| **Imported image** | A PNG, JPG, WebP or SVG file chosen by the user (e.g. a photo of their own car or a logo) | per §14.3 |

### 14.2 Size and colour
- **Size** slider 12–128 px, default **24 px** (the marker's longest side; images keep their aspect ratio). The Dot's diameter is 0.75 × the size (24 px → the v0.1 18 px dot). On the live map the size is in CSS pixels. In video it is defined for 1080 p and scaled with the output height (48 px at 2160 p).
- **Colour** (Dot, Arrow, built-in icons): accent red `#D2401E` by default; a small palette (red, teal, blue, green, black, white) plus a custom colour picker. Imported images keep their own colours.
- **Halo** on/off (default on): the soft pulsing halo behind the marker. For images it is a soft circular shadow, so the image stands out on satellite maps.

### 14.3 Rotation
| Option | Behaviour |
|---|---|
| **Rotate with heading** | The marker turns so its front points in the direction of travel. |
| **Flip left/right** | The image is never rotated, only mirrored so it faces left when travelling west and right when travelling east. Meant for side-view pictures (a car seen from the side), which look wrong when rotated. |
| **Fixed** | Never rotated or flipped. |

- Default: Rotate for Arrow and built-in icons; Fixed for imported images.
- **"Image front points"** (imported images only): Up / Right / Down / Left, or an angle 0–359°. It tells the app which way the picture faces, so a car photo facing right still drives forward. Default Up.
- Heading uses the same smoothing as the heading-up camera (§13.4): recorded course if present, else bearing over the next ~30 m, held below 3 km/h, averaged over a centred window of ±0.5 s of video (shorter than the camera's ±1.0 s, so the icon follows turns more closely). So the icon does not twitch on 1 Hz data or spin while stopped.
- In **Follow heading up** camera mode the map rotates instead, so a rotating marker effectively points straight up all the time; this is expected.
- Rotation is relative to the map: when the map is rotated by the user or the camera, the marker still points along the road.

### 14.4 Importing an image
- **Import image…** button in the marker settings; the image file can also be dropped onto the marker preview. The file picker accepts `.png .jpg .jpeg .webp .svg`.
- Limit: 5 MB per file. On import the image is **scaled down to at most 256 px** on its longest side and stored as a PNG data URL in the settings (§8), so it survives restarts. SVGs are rasterised the same way.
- SVGs are only ever loaded through an `<img>`/`ImageBitmap` (never inserted into the page as markup), so scripts inside an SVG cannot run.
- An unreadable or oversized file shows an error toast and keeps the current marker.
- One imported image is kept at a time; importing a new one replaces it. "Remove image" goes back to the previous non-image type.
- The CSP needs `img-src data: blob:` for the stored image (check `tauri.conf.json`).

### 14.5 Settings UI
A **Position marker** group in the settings panel (§7.7):
- A live **preview** on a small map-coloured tile, showing the marker moving in a circle so rotation can be checked.
- Type chips: Dot · Arrow · Icon (opens the built-in icon grid) · Image.
- Size slider with the value in px, colour palette, Halo toggle, Rotation (Rotate / Flip / Fixed), and "Image front points" for imported images.
- **Reset marker** returns to the default (car icon, 24 px, accent red, Rotate, halo on).
- The video export dialog (§13.6) shows the current marker and has a link "Change marker…" that opens this group. There are no separate marker settings for video.

Settings shape (one key in `localStorage`, §8):
```ts
marker: {
  kind: 'dot' | 'arrow' | 'icon' | 'image';   // default 'icon' (car)
  icon: 'car' | 'motorbike' | 'bicycle' | 'walker' | 'truck' | 'boat';   // default 'car'
  sizePx: number;          // 12–128, default 24
  color: string;           // '#D2401E'
  halo: boolean;           // true
  rotation: 'rotate' | 'flip' | 'fixed';
  imageFrontDeg: number;   // 0 = up, 90 = right
  imageDataUrl: string | null;
}
```

### 14.6 Rendering
- Live map: the marker stays an HTML `Marker` (§6.2 layer 1). Rotation and flip are a CSS `transform` on the picture inside it, using the screen angle (travel bearing − map bearing), so the marker follows map rotation. Only the transform changes per frame; the element is rebuilt only when the settings change.
- Built-in shapes are inline SVG strings in `marker.ts` with a tight viewBox and the front pointing up.
- Video: the same image is drawn on the frame canvas with `drawImage` from an `ImageBitmap` prepared once at the output scale.
- Start, end and waypoint markers are not affected.

### 14.7 Acceptance criteria
1. Each type (Dot, Arrow, each built-in icon, an imported PNG and SVG) shows on the live map and in an exported video at the chosen size.
2. **Size**: at 64 px the marker measures 64 px on screen (longest side) and 64 px in a 1080p video frame, 128 px at 2160p.
3. **Rotate**: on the Aug 24 KML the arrow points along the track at every moment of the replay and does not spin while stopped.
4. **Flip**: a right-facing side-view image faces left on west-bound parts and right on east-bound parts, and is never upside down.
5. **Image front points = Right**: a right-facing image in Rotate mode drives forward.
6. The imported image survives an app restart. A 10 MB file or a renamed text file is rejected with a toast.
7. An SVG containing a `<script>` is displayed without running the script.
8. Changing the marker during playback does not interrupt playback.
9. On a fresh install (no saved settings) the marker is the car icon, 24 px, accent red, rotating with the heading.

### 14.8 Decisions (answered 2026-10-20)
| # | Question | Decision |
|---|---|---|
| 1 | Built-in icon set | Car, motorbike, bicycle, walker, truck, boat. **Car** is the default icon (pre-selected when the Icon type is chosen). |
| 2 | Default marker | The **car** icon (changed 2026-10-20 from the dot); Dot and Arrow remain available |
| 3 | Imported images | One at a time; a library can come later |
| 4 | Separate markers for live map and video | No: one setting for both |

---

## 15. Smart zoom while playing (v0.4)

While playing, the camera keeps the vehicle **in the centre of the map** and changes the **zoom with the speed**: slow (city streets, stops, junctions) → zoomed in, close to the vehicle; fast (highway) → zoomed out, so more of the route ahead is visible. Status: **approved 2026-10-21**; the decisions are in §15.8.

### 15.1 Where it applies
- An on/off option **Smart zoom** next to "Camera while playing" (§7.7), default **off**; once turned on it stays on (saved, §8).
- It works with the two centred camera modes, **Follow north up** and **Follow heading up** (§13.4). Turning Smart zoom on while the camera is Off or Keep in view switches the camera to Follow north up, because the vehicle must stay centred.
- Everything else of the follow modes stays as is: centre smoothing, heading-up rotation, camera cut at segment breaks.
- The same settings drive the video export (§15.6).

### 15.2 Speed → zoom, based on the track's average speed
The target zoom comes from the vehicle's speed through a curve between a **Near zoom** (slow end) and a **Far zoom** (fast end). Where the curve sits is taken from the loaded track's **average moving speed** (§5.5), so a city walk and a highway ride both use the whole zoom range:

| | Slow speed (→ Near zoom) | Average speed (→ middle zoom) | Fast speed (→ Far zoom) |
|---|---|---|---|
| Default rule | ½ × average | average | 2 × average |
| Default zoom | **17** "Close" | 15 | **13** |
| Aug 31 GPX (avg 43.4 km/h) | 22 km/h | 43 km/h | 87 km/h |
| Dashcam KMZ (avg 35.2 km/h) | 18 km/h | 35 km/h | 70 km/h |
| Aug 24 KML (avg 15.8 km/h) | 8 km/h | 16 km/h | 32 km/h |

- Below the slow speed the zoom is the Near zoom; above the fast speed it is the Far zoom. In between it is interpolated over **log(speed)**, so the average speed falls exactly on the middle zoom.
- Speeds are rounded to whole km/h (mph in Imperial). The slow speed is at least 5 km/h.
- Map width for reference (1440 px map at 11° N): zoom 17 ≈ 0.85 km, 15 ≈ 3.4 km, 13 ≈ 13.5 km.

**Editable values.** The four values are **text inputs** (number fields) in the Smart zoom group of the settings panel and in the export dialog (§15.6), showing the values in use:

| Field | Default | Range |
|---|---|---|
| Near zoom | 17 | 3–20, one decimal |
| Far zoom | 13 | 3–20, one decimal, below Near zoom |
| Slow speed | **Auto** = ½ × the track average | 1–300 km/h, below Fast speed |
| Fast speed | **Auto** = 2 × the track average | 2–400 km/h |

- While the speeds are on Auto, the fields show the computed values with an "auto" hint ("22 km/h · auto from avg 43.4"). Typing a value switches that field to custom; a **"Use track average"** link puts both speeds back on Auto.
- Custom values and both zoom levels are saved (§8) and apply to every track until reset. Auto values are recomputed for each loaded track.
- Invalid input (empty, out of range, slow ≥ fast, far ≥ near) is not applied: the field shows a red outline and keeps the last valid value.
- The zoom readout (§6.3) shows the live value with "auto": "z 15.2 auto".

### 15.3 Which speed
- The speed fed into the curve is the **smoothed** track speed, averaged over a window centred on the position (like the camera smoothing, §13.4), but longer: ±8 s of screen/video time. One-second dips (a pothole brake, GPS noise) do not move the zoom.
- Because the window is measured in screen/video time, it spans more of the track at high rates (×60: ±8 min of driving). Then the zoom follows the longer-term speed and short stops do not zoom in; this is intended (no pumping). Checked on Aug 31: at ×10 the zoom moves smoothly between 13.0 and 14.5 through a town section; at ×60 it stays about 13.2.
- **Look-ahead**: the window is shifted 2 s of screen/video time forward, so the zoom starts to widen *before* the vehicle speeds up onto a highway and closes in before it slows into a junction.
- Collapsed pauses and stops (speed below 3 km/h, §13.4): the zoom eases to the Near zoom and holds.
- Tracks without speed (untimed, or "Hidden" estimated speed, §5.5): Smart zoom is unavailable; the option is disabled with the tooltip "Needs speed data".

### 15.4 Playback rate and keeping it calm
- **Rate widening**: at high rates the speed curve alone would make the map scroll too fast (at ×120 a car at 60 km/h covers 2 km per screen second). So the zoom is also limited so that the vehicle moves at most **½ of the map width per second** on screen: target = min(curve zoom, rate-limited zoom). This only ever zooms further **out**, never closer than the curve.
- **Rate limit**: the zoom changes by at most **0.5 zoom level per second** of screen time (one level = map scale ×2), with ease-in/out, so the map never "pumps".
- **Dead band**: changes smaller than 0.25 zoom level are ignored.
- Zoom changes continuously (fractional zoom), never in jumps; tiles of the neighbouring level are shown while the next ones load.
- Seeking (chart, keyboard) or changing the playback rate while playing: the zoom jumps straight to the target at the new position, no animation.

### 15.5 Manual control
- **Zoom readout click** (§6.3) toggles Smart zoom on/off from the map; the copy function moves to a small copy icon next to the readout.
- Mouse wheel, pinch or the +/− buttons **do not turn Smart zoom off**. They shift the whole curve by the change (an offset, e.g. +1 = everything one level closer). The offset is kept until the next file load or a click on the fit button, and is not saved.
- Dragging the map still turns the camera Off (§6.3), and Smart zoom with it, until the next fit or file load.

### 15.6 Video export
- The export camera (§13.4) gets **Zoom: Fixed / Smart**. With Smart, the Zoom slider (§13.3) is replaced by the same four text inputs (Near zoom, Far zoom, Slow speed, Fast speed, with Auto and "Use track average"). They are the **same saved values** as in the settings panel: editing them in either place changes both, so what plays on screen is what the video shows.
- In the video, §15.3–§15.4 timing is measured in video seconds and the rate widening uses the output frame width, so it looks the same at every rate and resolution.
- With a From/To range (§13.2), Auto speeds still come from the whole track's average.
- Intro/outro (§13.3) fly in to / out from the smart zoom at the start / end point.
- "Whole track" camera: Smart zoom does not apply (the option is hidden).

### 15.7 Acceptance criteria
1. **Aug 31 GPX**, Smart zoom on, Auto speeds (22 / 87 km/h), ×10: in town at ~30 km/h the map shows about zoom 16; on the expressway at ~100 km/h zoom 13; the vehicle stays centred all the time.
2. At ×240 on the same track the view is wider than at ×10 (rate widening), and the vehicle never crosses more than half the map width per second.
3. The zoom never changes faster than 0.5 level per second, and does not change for a 2 s brake.
4. While stopped (dashcam KMZ: 355 duplicate points), the zoom settles at the Near zoom and holds.
5. Typing Slow speed 40 / Fast speed 120 is applied at once and saved; "Use track average" restores 22 / 87 on Aug 31. Slow 90 / Fast 80 is rejected with a red outline.
6. Values edited in the export dialog show up in the settings panel and vice versa; a Smart-zoom video of Aug 31 at ×60 zooms out on the expressway and in through town.
7. Mouse-wheel zoom during playback shifts the zoom and keeps following; a drag turns the camera off; clicking the zoom readout toggles "auto".
8. Untimed 52100 KMZ: the option is disabled with "Needs speed data".
9. Unit tests (no MapLibre): average → Auto speeds, speed → zoom curve, rate widening, rate limit, dead band and look-ahead.

### 15.8 Decisions (answered 2026-10-21)
| # | Question | Decision |
|---|---|---|
| 1 | Speed → zoom range | Based on the track's **average speed** (slow = ½×, fast = 2× the average; zoom 17 → 13), with **text inputs** to edit Near/Far zoom and Slow/Fast speed, shared with the video export (§15.2, §15.6) |
| 2 | Playback rate widens the view | Yes: zoom out further so the vehicle moves at most ½ map width per second; never closer than the speed curve (§15.4) |
| 3 | Default | Off (opt-in); remembered once turned on |
| 4 | Video export | Yes, "Zoom: Fixed / Smart" with the same values (§15.6) |
| 5 | Quick access | Click the zoom readout to toggle; copy moves to a copy icon next to it (§6.3, §15.5) |
