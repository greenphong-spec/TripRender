---
name: smart-zoom-open-issue
description: "OPEN (2026-10-21): smart zoom still looks wrong in the exe on Sep 13 KMZ at x10 after two fixes; next steps"
metadata:
  node_type: memory
  type: project
  originSessionId: 3273c419-9193-45bd-9bfe-03c433e761da
  modified: 2026-10-21T16:24:04.629Z
---

**Status 2026-10-21 (late, user stopped for the night): NOT solved.** User tested the 22:46 exe and says smart zoom is still wrong on `Sep_13,_2026_11_26_19.kmz` (8 min, auto rate ×10). Their screenshot `trackview/wrongzoom.png`: at 2:00, 8.8 km/h, readout "z 17.2 auto" (they expect close to Near zoom). Their saved settings: Near 20, Far 14.6, Auto speeds (9/34 km/h), camera north, ×10.

**Done so far (uncommitted, on top of commit 2b9e6d7):** `trackview/src/map/smartzoom.ts` `lookAheadSpeed` uses Gaussian weights and caps the window at ±30 s / look-ahead 7.5 s of track time; new Sep 13 test in `test/smartzoom.test.ts`; SPEC §15.3 rewritten + §15.7 criterion 10. All 53 tests pass. Unit simulation says z ≈ 19.7 at 2:00 with their settings, so the **live app disagrees with the pure-function simulation**.

**Next session, start here:**
1. Run the dev server, load Sep 13 with their settings (Near 20/Far 14.6) at ×10, log per frame: pos, `smart.target`, follower z, `map.getZoom()`, `smart.offset`, dt, `jumped`. Do it before changing code (see [[debug-with-user-settings]]).
2. Suspects in the live path (`trackview/src/map/trackmap.ts` update): the manual-offset detection (`map.getZoom() !== autoZoom` → `smart.shift`) may accumulate a spurious offset; `isZooming()` skipping frames; real dt / `jumped` logic in `SmartZoom.update`; the readout or main.ts changing zoom; whether the speed the app feeds matches the test build of the track (settings like skip pauses/spikes).
3. Ask the user what exactly looks wrong over the first 3 min (direction, amount, timing) if the logs don't make it obvious.

**Why:** user asked to note this for the next session.
