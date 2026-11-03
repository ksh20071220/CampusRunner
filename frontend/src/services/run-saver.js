import { normalizeApiError } from "../lib/messages.js";

// 러닝 종료 후 서버 저장을 담당한다. (역할 2번이 나중에 교체·확장하기 쉽도록 화면과 분리)
//
// 규칙 (BACKEND_HANDOFF [7], [12]):
// - key는 러닝 종료 때 "한 번만" 만든다. 재시도마다 새로 만들지 않는다.
// - 실패하면 같은 key와 같은 points로 다시 보낸다. 서버가 이미 저장했다면 200으로 기존 결과를 준다.
// - 서버 성공을 확인한 뒤에만 RunTracker.markSaved()로 GPS 임시본을 지운다.
// - 저장 대기 중인 {key, points}는 localStorage에 보관해 새로고침 뒤에도 같은 key로 재시도한다.

const PENDING_KEY = "campusrunner.pending-run.v1";
const RESULT_KEY = "campusrunner.last-result.v1";
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

function makeKey() {
  // crypto.randomUUID()는 HTTPS에서만 있다. 휴대폰 HTTP 테스트를 위해 getRandomValues로 대체한다.
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function samePoints(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every(
    (p, i) => p.timestamp === b[i].timestamp && p.latitude === b[i].latitude && p.longitude === b[i].longitude,
  );
}

function isRetryable(error) {
  if (error.code === "network_error") return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

export class RunSaver {
  constructor({ api, storage = globalThis.localStorage, onSaved = () => {} }) {
    this.api = api;
    this.storage = storage;
    this.onSaved = onSaved;
    this.listeners = new Set();
    this.timer = null;
    this.inflight = null;
    this.state = {
      phase: "idle", // idle | saving | retrying | saved | failed | needs_login
      pending: this._read(PENDING_KEY),
      result: this._read(RESULT_KEY, globalThis.sessionStorage),
      error: null,
      attempt: 0,
      retryable: false,
      nextRetryAt: null,
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        if (this.state.pending && (this.state.phase === "failed" || this.state.phase === "retrying")) this.save();
      });
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState() {
    return this.state;
  }

  /** 러닝 종료 직후 호출. 같은 points로 다시 부르면 기존 key를 재사용한다. */
  begin(points) {
    const current = this.state.pending;
    const pending =
      current && samePoints(current.points, points)
        ? current
        : { key: makeKey(), points, createdAt: Date.now() };
    this._write(PENDING_KEY, pending);
    this._set({ pending, result: null, error: null, attempt: 0, phase: "idle" });
    this._write(RESULT_KEY, null, globalThis.sessionStorage);
    return this.save();
  }

  /** 대기 중인 저장을 (재)시도한다. 진행 중이면 같은 Promise를 돌려준다. */
  save() {
    if (!this.state.pending) return Promise.resolve(this.state.result);
    if (this.inflight) return this.inflight;
    this._clearTimer();
    const { key, points } = this.state.pending;
    this._set({ phase: "saving", error: null, nextRetryAt: null });

    this.inflight = this.api
      .submitRun(key, points)
      .then((result) => {
        // 임시 GPS 기록을 먼저 지우고 나서 대기 요청을 지운다. 중간에 앱이 꺼져도
        // 대기 요청이 남아 같은 key로 재전송되므로 중복 저장되지 않는다.
        this.onSaved(result);
        this._write(PENDING_KEY, null);
        this._write(RESULT_KEY, result, globalThis.sessionStorage);
        this._set({ phase: "saved", pending: null, result, error: null, attempt: 0, retryable: false });
        return result;
      })
      .catch((raw) => {
        const error = normalizeApiError(raw);
        const attempt = this.state.attempt + 1;
        if (error.status === 401) {
          this._set({ phase: "needs_login", error, attempt, retryable: true });
        } else if (error.message === "duplicate_run") {
          // 같은 GPS가 이미 다른 key로 저장됨 = 저장은 끝난 상태. 임시본만 정리한다.
          this.onSaved(null);
          this._write(PENDING_KEY, null);
          this._set({ phase: "saved", pending: null, result: null, error, attempt, retryable: false });
        } else if (isRetryable(error) && attempt <= RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[attempt - 1];
          this._set({ phase: "retrying", error, attempt, retryable: true, nextRetryAt: Date.now() + delay });
          this.timer = setTimeout(() => this.save(), delay);
        } else {
          this._set({ phase: "failed", error, attempt, retryable: isRetryable(error) });
        }
        return null;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** 수동 재시도: 자동 재시도 횟수를 초기화하고 바로 보낸다. */
  retryNow() {
    this._set({ attempt: 0 });
    return this.save();
  }

  /** 저장하지 않고 버린다 (형식 오류 등 서버가 영구 거부한 경우). */
  discard() {
    this._clearTimer();
    this._write(PENDING_KEY, null);
    this._set({ phase: "idle", pending: null, error: null, attempt: 0, retryable: false });
  }

  /** 결과 화면을 떠날 때 저장 완료 상태를 정리한다. */
  acknowledge() {
    if (this.state.phase === "saved") this._set({ phase: "idle", error: null });
  }

  _clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        /* 화면 오류가 저장 흐름을 멈추지 않게 한다 */
      }
    }
  }

  _read(key, storage = this.storage) {
    try {
      const raw = storage?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _write(key, value, storage = this.storage) {
    try {
      if (value === null) storage?.removeItem(key);
      else storage?.setItem(key, JSON.stringify(value));
    } catch {
      /* 저장소를 못 써도 메모리 상태로 계속 진행한다 */
    }
  }
}
