const R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from point 1 to point 2, degrees clockwise from north. */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Distance in metres from p to the segment a–c (local equirectangular approximation). */
export function distanceToSegment(
  aLat: number, aLon: number,
  pLat: number, pLon: number,
  cLat: number, cLon: number,
): number {
  const kx = Math.cos(aLat * RAD) * 111320;
  const ky = 110540;
  const bx = (cLon - aLon) * kx;
  const by = (cLat - aLat) * ky;
  const px = (pLon - aLon) * kx;
  const py = (pLat - aLat) * ky;
  const len2 = bx * bx + by * by;
  const f = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - f * bx, py - f * by);
}
