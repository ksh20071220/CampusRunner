// 목업용 캠퍼스 트랙: 직선 300m 두 개 + 반지름 60m 반원 두 개 (한 바퀴 약 977m)

const CENTER = { latitude: 37.4602, longitude: 126.9515 };
const STRAIGHT = 300;
const RADIUS = 60;
const ROTATION = (-18 * Math.PI) / 180;
export const LOOP_LENGTH = 2 * STRAIGHT + 2 * Math.PI * RADIUS;

function toLatLng(x, y) {
  const rx = x * Math.cos(ROTATION) - y * Math.sin(ROTATION);
  const ry = x * Math.sin(ROTATION) + y * Math.cos(ROTATION);
  const latitude = CENTER.latitude + ry / 111_320;
  const longitude = CENTER.longitude + rx / (111_320 * Math.cos((CENTER.latitude * Math.PI) / 180));
  return { latitude: Number(latitude.toFixed(7)), longitude: Number(longitude.toFixed(7)) };
}

/** 출발점에서 distance(m)만큼 트랙을 따라간 좌표 */
export function pointAlongLoop(distance, wobble = 0) {
  let d = ((distance % LOOP_LENGTH) + LOOP_LENGTH) % LOOP_LENGTH;
  const half = STRAIGHT / 2;
  const arc = Math.PI * RADIUS;
  let x;
  let y;
  if (d < STRAIGHT) {
    x = -half + d;
    y = -RADIUS;
  } else if ((d -= STRAIGHT) < arc) {
    const a = -Math.PI / 2 + d / RADIUS;
    x = half + RADIUS * Math.cos(a);
    y = RADIUS * Math.sin(a);
  } else if ((d -= arc) < STRAIGHT) {
    x = half - d;
    y = RADIUS;
  } else {
    d -= STRAIGHT;
    const a = Math.PI / 2 + d / RADIUS;
    x = -half + RADIUS * Math.cos(a);
    y = RADIUS * Math.sin(a);
  }
  return toLatLng(x + wobble, y + wobble * 0.6);
}
