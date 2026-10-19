import { unzipSync } from 'fflate';
import type { RawTrack } from '../model/types';
import { parseGpx } from './gpx';
import { parseKml } from './kml';

const utf8 = new TextDecoder('utf-8');

function isZip(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

function kmlFromKmz(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name.toLowerCase().endsWith('.kml') });
  const names = Object.keys(files);
  const main = names.find((n) => n.toLowerCase() === 'doc.kml') ?? names.sort()[0];
  if (!main) throw new Error('KMZ archive contains no .kml file');
  return utf8.decode(files[main]);
}

/** Parse a GPX, KML or KMZ file. Format comes from the content, with the extension as a tie-breaker. */
export function parseTrackFile(fileName: string, bytes: Uint8Array): RawTrack {
  if (isZip(bytes)) return parseKml(kmlFromKmz(bytes), 'kmz');
  const text = utf8.decode(bytes);
  const head = text.slice(0, 4096);
  if (/<gpx[\s>]/.test(head)) return parseGpx(text);
  if (/<kml[\s>]/.test(head)) return parseKml(text);
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'gpx') return parseGpx(text);
  if (ext === 'kml') return parseKml(text);
  throw new Error('Unsupported file: expected GPX, KML or KMZ');
}
