import { pointAlongLoop } from "./route-shape.js";

/**
 * navigator.geolocation과 같은 모양의 가상 GPS. 1초마다 트랙을 따라 약 2.8m/s(시속 10km)로 이동한다.
 * ?mock=1&gpsfail=denied 로 권한 거부를 흉내 낼 수 있다.
 */
export class MockGeolocation {
  constructor({ speed = 2.8, failMode = null } = {}) {
    this.speed = speed;
    this.failMode = failMode;
    this.watches = new Map();
    this.nextId = 1;
    this.distance = 0;
  }

  watchPosition(success, error) {
    const id = this.nextId++;
    if (this.failMode === "denied") {
      setTimeout(() => error({ code: 1, message: "User denied Geolocation" }), 600);
      return id;
    }
    const emit = () => {
      const wobble = (Math.random() - 0.5) * 3;
      const { latitude, longitude } = pointAlongLoop(this.distance, wobble);
      success({
        coords: { latitude, longitude, accuracy: 4 + Math.random() * 4 },
        timestamp: Date.now(),
      });
      this.distance += this.speed * (0.9 + Math.random() * 0.2);
    };
    const first = setTimeout(() => {
      emit();
      this.watches.set(id, setInterval(emit, 1000));
    }, 1200);
    this.watches.set(id, first);
    return id;
  }

  clearWatch(id) {
    const handle = this.watches.get(id);
    clearTimeout(handle);
    clearInterval(handle);
    this.watches.delete(id);
  }

  getCurrentPosition(success, error) {
    const id = this.watchPosition(
      (position) => {
        this.clearWatch(id);
        success(position);
      },
      error,
    );
  }
}
