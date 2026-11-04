---
name: debug-with-user-settings
description: "Lessons from the smart zoom bug: reproduce with the user's saved settings/rate, judge by what they see, verify in the app, question the design"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3273c419-9193-45bd-9bfe-03c433e761da
  modified: 2026-10-21T15:42:35.375Z
---

When the user reports wrong app behaviour in Trackview:

1. **Reproduce with their real setup.** Read their saved settings and use the playback rate they used, not defaults. Desktop settings are in WebView2 localStorage: `%LOCALAPPDATA%\com.phong.trackview\EBWebView\Default\Local Storage\leveldb\*.log`, key `trackview.settings.v1` (grep the JSON with Python, latin-1 decode).
2. **Ask for specifics when the report is vague** ("reversed"): time in the track, rate, the value shown and the value expected. A screenshot with time, speed and readout is what cracks it.
3. **Define "fixed" by what the user expects to see on screen** (e.g. "8.8 km/h, below the slow speed → Near zoom"), and write the regression test with that absolute expectation, not a weak relative check or a statistical score.
4. **Don't rationalise leftover symptoms.** If the fix still looks muted or odd, suspect the design (here: a speed window that grew with the rate, longer than the track's speed phases), say so, and propose changing it, then update SPEC.md.
5. **Check in the real app (dev server + sample) before handing over an exe.**
6. Scripted text edits must fail loudly when the target text isn't found (assert), then check the diff.

**Why:** Smart zoom "reversed" bug (2026-10-21): I simulated with defaults (Near 17/Far 13) while the user had Near 20/Far 14.6, judged the first fix by a correlation score, explained away the weak response, shipped an exe, and the user found it still wrong. It took a second round and their screenshot.

**How to apply:** Run through these steps at the start of any "it behaves wrong" report, before proposing a fix. See [[trackview-direction]].
