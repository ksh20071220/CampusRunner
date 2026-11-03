// 저장 전 미리보기용 거리 계산 (서버와 같은 Haversine, 지구 반지름 6,371,000m).
// 최종 기록은 항상 서버 응답 값을 쓴다.

const R = 6_371_000;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
}

export function previewOf(points) {
  if (!Array.isArray(points) || points.length === 0) return { distance: 0, seconds: 0 };
  let distance = 0;
  for (let i = 1; i < points.length; i += 1) distance += haversine(points[i - 1], points[i]);
  return { distance, seconds: points[points.length - 1].timestamp - points[0].timestamp };
}
