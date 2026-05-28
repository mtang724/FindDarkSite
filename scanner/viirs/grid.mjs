/** Rectangular grid generator for bbox (national/regional) scans. */
const EARTH_RADIUS_KM = 6371;
const toDeg = (rad) => rad * 180 / Math.PI;
const toRad = (deg) => deg * Math.PI / 180;

export function generateBboxGridPoints(minLng, minLat, maxLng, maxLat, stepKm) {
  const points = [];
  const latStep = toDeg(stepKm / EARTH_RADIUS_KM);
  for (let lat = minLat; lat <= maxLat; lat += latStep) {
    const cosLat = Math.cos(toRad(lat));
    if (cosLat <= 0) continue;
    const lngStep = toDeg(stepKm / (EARTH_RADIUS_KM * cosLat));
    for (let lng = minLng; lng <= maxLng; lng += lngStep) {
      points.push({
        lat: Math.round(lat * 100000) / 100000,
        lng: Math.round(lng * 100000) / 100000,
      });
    }
  }
  return points;
}
