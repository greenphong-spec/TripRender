#!/usr/bin/env node
// Headless overlay renderer (SPEC §19).
//
// Renders map clips with the video-export map (overlay.html + src/overlay/main.ts) in a headless
// Chrome/Edge and encodes them with ffmpeg, so another tool (dashvid) can lay the map over its own footage.
//
//   node tools/overlay-render.mjs job.json
//
// job.json:
// {
//   "track": "C:/path/track.gpx",          GPX / KML / KMZ with a time on every point
//   "ffmpeg": "ffmpeg",                     optional path
//   "width": 600, "height": 420,            output size (even numbers)
//   "dpr": 1.33,                            map pixel ratio: lines, labels and the marker scale with it
//   "mapStyle": "streets",                  light | streets | satellite
//   "camera": "heading",                    heading | north | keep | overview
//   "tilt": 0, "zoom": 16,                  zoom is used when "smartZoom" is false
//   "smartZoom": true, "smart": { "near": 17, "far": 14 },
//   "marker": { "icon": "car", "sizePx": 24 },
//   "crf": 12,
//   "clips": [ { "out": "C:/x/clip1.mp4", "t0": 1760680000000, "rate": 3, "fps": 30, "frames": 240,
//                "camera": "overview" } ],                  camera is optional (default: the job's)
//   "stills": [ { "out": "C:/x/still.png", "t": 1760680000000, "rate": 1 } ]
// }
// Clip frame k shows track time t0 + k / fps × rate seconds (t0 in epoch ms, UTC).

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobPath = process.argv[2];
if (!jobPath) {
  console.error('usage: node tools/overlay-render.mjs job.json');
  process.exit(2);
}
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
const clips = job.clips ?? [];
const stills = job.stills ?? [];

// Software WebGL: this PC has no GPU driver, and headless Chrome refuses SwiftShader without the flag.
const BROWSER_ARGS = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];

async function launch() {
  let last;
  for (const channel of [job.browser, 'chrome', 'msedge'].filter(Boolean)) {
    try {
      return await chromium.launch({ channel, headless: true, args: BROWSER_ARGS });
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`Could not start Chrome or Edge: ${last?.message ?? last}`);
}

function encoder(out, fps) {
  const args = [
    '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv444p',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', String(job.crf ?? 12),
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    out,
  ];
  return spawn(job.ffmpeg || 'ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
}

const pngBytes = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 5199, strictPort: false },
});
await server.listen();
const url = `${server.resolvedUrls.local[0].replace(/\/$/, '')}/overlay.html`;
const browser = await launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`[page] ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForFunction(() => window.trackviewOverlay?.ready, null, { timeout: 120_000 });
  const info = await page.evaluate((j) => window.trackviewOverlay.load(j), {
    fileName: path.basename(job.track),
    data: fs.readFileSync(job.track).toString('base64'),
    width: job.width,
    height: job.height,
    dpr: job.dpr,
    mapStyle: job.mapStyle,
    camera: job.camera,
    tilt: job.tilt,
    zoom: job.zoom,
    smartZoom: job.smartZoom,
    smart: job.smart,
    marker: job.marker,
  });
  if (!info.styleOk) console.warn('! map style could not be loaded (offline?): the map has a plain background');

  const frame = (t, rate, fps) => page.evaluate((f) => window.trackviewOverlay.frame(f), { t, rate, fps });

  for (const s of stills) {
    await page.evaluate(() => window.trackviewOverlay.reset());
    fs.mkdirSync(path.dirname(s.out), { recursive: true });
    fs.writeFileSync(s.out, pngBytes(await frame(s.t, s.rate ?? 1, 30)));
    console.log(`still ${s.out}`);
  }

  const total = clips.reduce((n, c) => n + c.frames, 0);
  let done = 0, lastLog = 0;
  const t0 = Date.now();
  for (const [ci, clip] of clips.entries()) {
    await page.evaluate((cam) => window.trackviewOverlay.camera(cam), clip.camera ?? job.camera ?? 'heading');
    fs.mkdirSync(path.dirname(clip.out), { recursive: true });
    const part = clip.out.replace(/(\.\w+)$/, '.part$1');
    const ff = encoder(part, clip.fps);
    const exited = once(ff, 'exit');
    for (let k = 0; k < clip.frames; k++) {
      const t = clip.t0 + (k / clip.fps) * clip.rate * 1000;
      if (!ff.stdin.write(pngBytes(await frame(t, clip.rate, clip.fps)))) await once(ff.stdin, 'drain');
      done++;
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        const per = (Date.now() - t0) / done;
        console.log(`map clip ${ci + 1}/${clips.length}  frame ${done}/${total}  ` +
          `${per.toFixed(0)} ms/frame, ~${Math.ceil((per * (total - done)) / 60000)} min left`);
      }
    }
    ff.stdin.end();
    const [code] = await exited;
    if (code !== 0) throw new Error(`ffmpeg failed (${code}) on ${clip.out}`);
    fs.renameSync(part, clip.out);
  }
  if (total) {
    const end = await page.evaluate(() => window.trackviewOverlay.info());
    console.log(`map: ${total} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s` +
      (end.missingFrames ? `, ${end.missingFrames} with missing tiles` : ''));
  }
} catch (err) {
  failed = true;
  console.error(err?.stack ?? String(err));
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
