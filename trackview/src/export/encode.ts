import {
  BufferTarget, CanvasSource, canEncodeVideo, Mp4OutputFormat, Output, Quality, StreamTarget, WebMOutputFormat,
  type StreamTargetChunk, type Target,
} from 'mediabunny';

// WebCodecs encoding + MP4/WebM muxing with Mediabunny (§13.1), and where the file goes (§13.6).

export interface Codec {
  codec: 'avc' | 'vp9';
  ext: 'mp4' | 'webm';
  mime: string;
}

const CODECS: Codec[] = [
  { codec: 'avc', ext: 'mp4', mime: 'video/mp4' },
  { codec: 'vp9', ext: 'webm', mime: 'video/webm' },
];

/** H.264 in MP4 if the encoder supports the size, else VP9 in WebM, else null. */
export async function pickCodec(w: number, h: number, fps: number, bitrate: number): Promise<Codec | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const c of CODECS) {
    try {
      if (await canEncodeVideo(c.codec, { width: w, height: h, frameRate: fps, quality: new Quality({ bitrate }) })) return c;
    } catch {
      /* try the next codec */
    }
  }
  return null;
}

export const isTauri = () => '__TAURI_INTERNALS__' in window;

/** Where the encoded bytes go: a file on disk (desktop) or memory (browser). */
export interface Sink {
  target: Target;
  /** Desktop: the chosen path. */
  path: string | null;
  /** After finalize: the video as a Blob (browser) or null (already on disk). */
  result(mime: string): Blob | null;
  /** Close and delete a partial file. */
  discard(): Promise<void>;
  close(): Promise<void>;
}

export function memorySink(): Sink {
  const target = new BufferTarget();
  return {
    target,
    path: null,
    result: (mime) => (target.buffer ? new Blob([target.buffer], { type: mime }) : null),
    discard: async () => {},
    close: async () => {},
  };
}

/** Desktop: ask for the file first (the native Save As dialog), then stream into it (§13.7). */
export async function fileSink(suggestedName: string, codec: Codec): Promise<Sink | null> {
  const [{ save }, fs] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: codec.ext === 'mp4' ? 'MP4 video' : 'WebM video', extensions: [codec.ext] }],
  });
  if (!path) return null;
  const file = await fs.open(path, { write: true, create: true, truncate: true });
  let closed = false;
  let pos = 0;
  const close = async () => {
    if (closed) return;
    closed = true;
    await file.close();
  };
  const writable = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      if (chunk.position !== pos) await file.seek(chunk.position, fs.SeekMode.Start);
      await file.write(chunk.data);
      pos = chunk.position + chunk.data.byteLength;
    },
    close,
    abort: close,
  });
  return {
    target: new StreamTarget(writable, { chunked: true }),
    path,
    result: () => null,
    async discard() {
      await close().catch(() => {});
      await fs.remove(path).catch(() => {});
    },
    close,
  };
}

/** Encoder for frames drawn on `canvas`. */
export class VideoWriter {
  private output: Output;
  private source: CanvasSource;

  constructor(canvas: HTMLCanvasElement, codec: Codec, private fps: number, bitrate: number, sink: Sink) {
    this.output = new Output({
      format: codec.ext === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat(),
      target: sink.target,
    });
    this.source = new CanvasSource(canvas, { codec: codec.codec, quality: new Quality({ bitrate }), keyFrameInterval: 2 });
    this.output.addVideoTrack(this.source, { frameRate: fps });
  }

  start(): Promise<void> {
    return this.output.start();
  }

  /** Add the canvas as frame k; resolves when the encoder can take more (back-pressure). */
  add(k: number): Promise<void> {
    return this.source.add(k / this.fps, 1 / this.fps);
  }

  finalize(): Promise<void> {
    return this.output.finalize();
  }

  cancel(): Promise<void> {
    return this.output.state === 'canceled' || this.output.state === 'finalized' ? Promise.resolve() : this.output.cancel();
  }
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
