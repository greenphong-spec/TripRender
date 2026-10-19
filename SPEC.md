# Trackview — Specification (v0.1, draft for review)

A browser-based GPS track viewer that **replays** a recorded trip on a real online map,
with a live info card and a speed chart synced to the map. Target look: `expected_UI.png`.

Status: specification only — nothing implemented yet. Open questions are in §12.

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

## 2. Platform decision

| Option | Verdict |
|---|---|
| Extend GPXSee (Qt/C++) | Rejected for v1. It would need a playback engine, split-colour path drawing, a new info overlay and a transport bar across `MapView`, `PathItem` and `GraphView`. The mockup's look is far from the Qt widget style. |
| **Standalone web app** | **Chosen.** The mockup is a web layout. Vector maps, fluid animation and the synced chart are cheap to build here, and it runs in any browser on Windows. |

**Stack**

| Concern | Choice | Version (verified on npm, 2026-10-19) |
|---|---|---|
| Build / dev server | Vite | 8.3.x |
| Language | TypeScript | 7.0.x |
| Map rendering | MapLibre GL JS | 6.15.x |
| Speed chart | uPlot (small, fast, canvas; custom cursor/shading via hooks) | 1.6.32 |
| KMZ unzip | fflate | 0.8.3 |
| XML parsing | Browser `DOMParser` (no dependency) | — |

No framework (React etc.). The UI is small: plain TS modules plus CSS. Node 24 is installed locally.

**Deliverable**: `trackview/` folder at the repo root. `npm run dev` starts the dev server; `npm run build` produces a static `dist/` that can be opened from any static host or `npx vite preview`.

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

### 5.3 Timing modes
| Mode | When | Timeline |
|---|---|---|
| `timed` | ≥ 90 % of points have a time | Real timestamps. Points without a time get an interpolated value. |
| `estimated` | No per-point time, but a start/end time is found: dashcam `Start: … End: …` text in `<description>`, or a `TimeSpan` | Times spread **evenly per point** between start and end (the dashcam log is ~1 Hz). The UI shows an "Estimated time" badge. Camera local time is read in the configured time zone (default Asia/Ho_Chi_Minh for this producer). |
| `untimed` | Nothing found | Playback by **distance**: the timeline is built at a nominal 50 km/h. The chart shows **elevation vs distance**, or a distance-only progress bar if elevation is missing. Speed shows "—". Badge "No time data". |

### 5.4 Pauses (timed / estimated)
- A *pause* is a time gap between consecutive points greater than **`pauseThreshold` (default 60 s)**, or any segment break.
- **Skip pauses** toggle (default **on**): each pause takes **1 s** on the playback timeline (`playT`). The marker holds still and the info card shows a "Paused 11 h 47 min" chip during that second. Off: real time is used.
- The chart x-axis follows `playT` (so it uses moving time when skipping), with a thin dashed break mark at each collapsed pause.
- Header and footer show **total time** and **moving time**: "3:54:45 moving · 15:41:33 total".

### 5.5 Derived values
- **Distance**: haversine (R = 6,371,008.8 m), summed within segments only.
- **Speed**: use `speedRec` if ≥ 90 % of points have it. Otherwise derive it as distance/time over a centred ±2-point window. Values above 250 km/h, or implying more than 15 m/s² acceleration, are treated as outliers and replaced by interpolation.
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
| Satellite | Esri World Imagery raster `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` | Optional; personal / non-commercial use under Esri's terms |

- All three endpoints were checked and respond (HTTP 200, 2026-10-19).
- OpenFreeMap: OpenStreetMap data, no API key, no registration, no published request limit. Attribution "© OpenFreeMap © OpenMapTiles Data from OpenStreetMap" stays visible at all times (MapLibre attribution control).
- The style list lives in one config file (`src/map/styles.ts`), so a keyed provider (MapTiler, Stadia) can be added later by pasting a URL and key.
- **No tile database or offline cache** in v1; the browser HTTP cache is enough.
- **Offline / tile failure**: the track, markers and chart still render on a plain background, with a small "Map tiles unavailable — offline?" notice. Playback keeps working.

### 6.2 Layers (top to bottom)
1. Current-position marker: 10 px dot in accent red with a white ring and a 24 px soft halo (pulsing while playing). With course data, a small heading wedge.
2. Waypoints: 8 px blue dots, with the name shown in a tooltip on hover or click.
3. Start: 8 px green dot. End: 9 px black square.
4. **Travelled path**: accent red `#D2401E`, 4 px, round joins.
5. **Remaining path**: slate `#5B6B76`, 3 px.
6. Segment breaks are not joined. During a collapsed pause that spans a segment break, the marker jumps.

Splitting is done by MapLibre `line-gradient` with `lineMetrics: true` on one GeoJSON line per segment, updating the gradient stop at the current progress each frame. This is cheap and avoids rebuilding geometry. If perf tests show this is too slow, fall back to updating a "travelled" source with a sliced coordinate array at a throttled 15 Hz.

### 6.3 Map controls (bottom-right, 44 px square white buttons)
- Zoom in (+), zoom out (−).
- **Fit / follow** (crosshair icon). One click fits the whole track. While playing, it toggles **follow mode**: the camera pans to keep the marker inside the middle 60 % of the view. Any manual pan cancels follow.
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
- "Drop a file or" + **Open file** button (teal `#0F5C5C`), plus GPX / KML / KMZ format chips (static labels).
- The whole window is a drop target. While dragging over it, show a full-window dashed overlay "Drop GPX, KML or KMZ".

### 7.2 Info card (top-left overlay, 270 px wide, white, 12 px radius, soft shadow)
- **AT** label + elapsed playback time, large monospace (`HH:MM:SS`). Below it, smaller: the clock time and date in the configured time zone (e.g. "15:45:30 · 31 Aug").
- 2×2 grid: **Speed** (km/h, 1 decimal), **Distance** (km, 1 decimal), **Elevation** (m, integer), **Position** (lat/lon, 5 decimals, with N/S/E/W).
- Badges when they apply: "Estimated time", "No time data", "Paused …".
- Values update at most every 100 ms (to avoid flicker) using tabular digits.
- Collapsible to just the time row (chevron) on small screens.

### 7.3 Playback bar
- **Play/Pause** — 44 px teal circle. Space bar toggles it.
- **Speed chips** — ×60, ×120 (default), ×240 as in the mockup, plus a "▾" menu for ×1, ×10, ×30, ×600, ×1200. On load the default is auto-picked: the smallest listed speed that makes the whole replay ≤ 90 s. Examples: Aug 31 (3 h 55 min moving) → ×240 (59 s); Apr 15 (2 min) → ×10 (12 s).
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

### 7.7 Empty state
With no file loaded: the map shows the default view (last viewed area, or Vietnam if none saved), the chart area shows "Open a GPX, KML or KMZ file to replay it", and playback controls are disabled. A "Try a sample" link loads a bundled copy of `Sep_13,_2026_11_26_19.kmz` (small, timed, with recorded speed).

## 8. Playback engine
- State: `playing: boolean`, `rate: number`, `pos: number` (ms on the playback timeline), `duration`.
- A `requestAnimationFrame` loop: `pos += (now − last) × rate`, clamped to `[0, duration]`. The frame delta is capped at 100 ms, so a background tab doesn't jump.
- One `onPosition(pos)` event fans out to: the map marker and gradient, the info card (throttled to 100 ms), the chart cursor and the follow camera.
- Seeking from the chart, keyboard or end-of-track goes through the same `seek(pos)` call.
- Settings saved in `localStorage` (wrapped in try/catch): rate, skip-pauses, pause threshold, time zone, map style, last map view.

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
  public/samples/Sep_13,_2026_11_26_19.kmz
  src/
    main.ts                 app wiring
    state.ts                playback state + event bus
    parse/ gpx.ts kml.ts kmz.ts detect.ts
    model/ clean.ts timing.ts derive.ts interpolate.ts
    map/ map.ts styles.ts layers.ts controls.ts
    ui/ header.ts infocard.ts playbar.ts chart.ts dropzone.ts toast.ts
    styles/ tokens.css app.css
  test/ (Vitest) parse.*.test.ts derive.test.ts interpolate.test.ts
```

## 11. Acceptance criteria
Tests run against the files in `example_GPSfiles/`:

1. **Aug 31 GPX**: 3 segments, 7,536 points (after merging same-time duplicates: 7,531 or more). Distance is 150.1 km ± 0.5 km and is **not** 165 km. Speed uses recorded `s`, and the max is about 115 km/h. Skip pauses on: the replay timeline is about 3 h 55 min, and ×240 finishes in ≤ 60 s. 5 waypoints are shown.
2. **Both "phan thiet…" GPX files** load identically to each other.
3. **52100 KMZ**: untimed mode, 3 segments, about 150 km. The chart shows elevation vs distance. 3 stop waypoints are shown. No crash on the CDATA names.
4. **Apr 15 / Aug 24 KML, Sep 13 KMZ**: timed mode with recorded speed. Point counts are 112 / 362 / 163, and the stop Placemark's `<when>` is not counted as a point.
5. **Dashcam KMZ**: estimated mode. Times run from 08:41:09 to 09:19:24 +07:00, distance is 22.4 km, the elevation tile shows "—" (all altitudes are 0), and the "Estimated time" badge is visible.
6. Dragging the chart handle moves the map marker and updates the info card in the same frame. Playing moves the chart cursor.
7. The travelled path is red up to exactly the marker, and the rest is slate.
8. With the network disabled, a file still loads, plays and charts, and the offline notice is shown.
9. The layout matches `expected_UI.png` at 1440×900, with no horizontal scroll at 375 px width.

## 12. Open questions
1. **Pause threshold**: is 60 s the right default? Geo Tracker's own "stops" are about 2 min.
2. **Time zone**: should the default be the browser's zone or always Asia/Ho_Chi_Minh?
3. **Units**: metric only, or a km/h ↔ mph toggle? (The Geo Tracker waypoint descriptions use ft/mi.)
4. **Dashcam estimated speed**: show the derived speed (distance per estimated second, which is noisy where the camera dropped samples), or show only the file's stated avg/max?
5. **Satellite style**: keep Esri imagery (terms limit it to personal use), or drop it?
6. **Delivery**: a dev server / static folder is assumed. Should it also be wrapped as a desktop app (e.g. Tauri) later?
