import { normalizeApiError } from "../lib/messages.js";

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
const LEGACY_KEYS = ["campusrunner.pending-run.v1", "campusrunner.active-run.v1"];

export function browserStorage(name = "localStorage") {
  try { return globalThis[name] ?? null; } catch { return null; }
}

export function accountKey(scope, memberId, kind) {
  return `campusrunner.account.v2.${encodeURIComponent(scope)}.${memberId}.${kind}`;
}

function problem(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function makeKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validPoints(points) {
  return Array.isArray(points) && points.length >= 2 && points.length <= 20_000 && points.every((p, i) =>
    p && Number.isInteger(p.timestamp) && p.timestamp >= 0 && p.timestamp <= 4102444800 &&
    Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 &&
    Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180 && (!i || p.timestamp > points[i - 1].timestamp));
}

function samePoints(a, b) {
  return a.length === b.length && a.every((p, i) =>
    p.timestamp === b[i].timestamp && p.latitude === b[i].latitude && p.longitude === b[i].longitude);
}

function retryable(error) {
  return error.code === "network_error" || error.status === 408 || error.status === 429 || error.status >= 500;
}

// Pending GPS, results and retries belong to an authenticated member AND API
// environment. A mutable api.token must never determine a restored run's owner.
export class RunSaver {
  constructor({ api, scope, storage = browserStorage(), resultStorage = browserStorage("sessionStorage"), onSaved = () => {} }) {
    if (!scope || typeof scope !== "string") throw new TypeError("RunSaver requires an API environment scope");
    this.api = api;
    this.scope = scope;
    this.storage = storage;
    this.resultStorage = resultStorage;
    this.onSaved = onSaved;
    this.listeners = new Set();
    this.cache = new Map();
    this.identity = null;
    this.generation = 0;
    this.timer = null;
    this.inflight = null;
    this.connected = false;
    this.legacyUnowned = LEGACY_KEYS.some((key) => Boolean(this._read(key, storage).value));
    this.state = this._empty();
    this.online = () => {
      if (this.identity && this.state.pending && this.state.retryable &&
          (this.state.phase === "failed" || this.state.phase === "retrying")) this.save();
    };
  }

  _empty() {
    return { phase: "idle", pending: null, result: null, error: null, attempt: 0,
      retryable: false, nextRetryAt: null, pendingPersisted: false,
      storageWarning: null, legacyUnowned: this.legacyUnowned, ownerId: null };
  }

  connect() {
    if (typeof window !== "undefined" && !this.connected) {
      window.addEventListener("online", this.online);
      this.connected = true;
    }
  }

  disconnect() {
    if (typeof window !== "undefined" && this.connected) window.removeEventListener("online", this.online);
    this.connected = false;
    this._clearTimer();
  }

  setSession(user) {
    const next = user && Number.isSafeInteger(user.id) && user.id > 0 && typeof user.token === "string" && user.token
      ? { id: user.id, token: user.token } : null;
    if (next?.id === this.identity?.id && next?.token === this.identity?.token) return;
    this._clearTimer();
    ++this.generation;
    this.inflight = null;
    this.identity = next;
    if (!next) { this._set(this._empty()); return; }
    const cached = this.cache.get(next.id);
    if (cached) {
      this._set({ ...cached, phase: cached.pending ? "idle" : cached.phase, error: null, attempt: 0, nextRetryAt: null });
      return;
    }
    const stored = this._read(this._key("pending"), this.storage);
    const candidate = stored.value;
    const valid = candidate && candidate.ownerId === next.id && candidate.scope === this.scope &&
      typeof candidate.key === "string" && candidate.key.length > 0 && candidate.key.length <= 63 && validPoints(candidate.points);
    const last = this._read(this._key("result"), this.resultStorage);
    const result = last.value?.ownerId === next.id && last.value?.scope === this.scope ? last.value.result : null;
    this._set({ ...this._empty(), ownerId: next.id, pending: valid ? candidate : null, result,
      pendingPersisted: Boolean(valid), storageWarning: stored.failed || last.failed
        ? problem("local_storage_unavailable") : candidate && !valid ? problem("invalid_pending_record") : null });
  }

  subscribe(listener) {
    this.listeners.add(listener); listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState() { return this.state; }

  begin(points) {
    if (!this.identity) throw problem("authentication_required", 401);
    if (!validPoints(points)) throw problem("invalid_run");
    const current = this.state.pending;
    if (current && !samePoints(current.points, points)) throw problem("pending_save", 409);
    const pending = current || { key: makeKey(), points: points.map(({ timestamp, latitude, longitude }) =>
      ({ timestamp, latitude, longitude })), createdAt: Date.now(), ownerId: this.identity.id, scope: this.scope };
    const persisted = this._write(this._key("pending"), pending, this.storage);
    this._write(this._key("result"), null, this.resultStorage);
    this._set({ pending, result: null, error: null, attempt: 0, phase: "idle", pendingPersisted: persisted,
      storageWarning: persisted ? null : problem("pending_not_persisted") });
    return this.save();
  }

  save() {
    if (!this.identity || !this.state.pending) return Promise.resolve(this.state.result);
    if (this.inflight) return this.inflight;
    const identity = { ...this.identity };
    const pending = this.state.pending;
    if (pending.ownerId !== identity.id || pending.scope !== this.scope) {
      this._set({ phase: "failed", error: problem("record_owner_mismatch", 403), retryable: false });
      return Promise.resolve(null);
    }
    this._clearTimer();
    const generation = this.generation;
    const active = () => generation === this.generation && this.state.pending?.key === pending.key;
    const persisted = this._write(this._key("pending"), pending, this.storage);
    this._set({ phase: "saving", error: null, nextRetryAt: null, pendingPersisted: persisted,
      storageWarning: persisted ? null : problem("pending_not_persisted") });
    const request = Promise.resolve()
      .then(() => this.api.me({ token: identity.token }))
      .then((me) => {
        if (!active()) return null;
        if (me.id !== identity.id) throw problem("record_owner_mismatch", 403);
        return this.api.submitRun(pending.key, pending.points, { token: identity.token });
      })
      .then((result) => {
        if (!active() || !result) return null;
        this._complete(result, identity);
        return result;
      })
      .catch((raw) => {
        if (!active()) return null;
        const error = normalizeApiError(raw);
        const attempt = this.state.attempt + 1;
        if (error.status === 401) this._set({ phase: "needs_login", error, attempt, retryable: true });
        else if (error.message === "duplicate_run") this._complete(null, identity, error);
        else if (retryable(error) && attempt <= RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[attempt - 1];
          this._set({ phase: "retrying", error, attempt, retryable: true, nextRetryAt: Date.now() + delay });
          this.timer = setTimeout(() => this.save(), delay);
        } else this._set({ phase: "failed", error, attempt, retryable: retryable(error) });
        return null;
      })
      .finally(() => { if (this.inflight === request) this.inflight = null; });
    this.inflight = request;
    return request;
  }

  _complete(result, identity, error = null) {
    this.onSaved(result, identity);
    const removed = this._write(this._key("pending"), null, this.storage);
    const stored = this._write(this._key("result"), result ? { ownerId: identity.id, scope: this.scope, result } : null, this.resultStorage);
    this._set({ phase: "saved", pending: null, result, error, attempt: 0, retryable: false,
      pendingPersisted: false, storageWarning: !removed ? problem("pending_cleanup_failed") : !stored ? problem("result_not_persisted") : null });
  }

  retryNow() { this._set({ attempt: 0 }); return this.save(); }

  discard() {
    this._clearTimer();
    if (this.identity && !this._write(this._key("pending"), null, this.storage)) {
      this._set({ phase: "failed", error: problem("local_delete_failed"), retryable: false,
        storageWarning: problem("pending_cleanup_failed") });
      return false;
    }
    ++this.generation;
    this.inflight = null;
    this._set({ ...this._empty(), ownerId: this.identity?.id ?? null });
    return true;
  }

  acknowledge() { if (this.state.phase === "saved") this._set({ phase: "idle", error: null }); }
  _key(kind) { return accountKey(this.scope, this.identity.id, kind); }
  _clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  _set(patch) {
    this.state = { ...this.state, ...patch };
    if (this.identity) this.cache.set(this.identity.id, this.state);
    for (const listener of this.listeners) { try { listener(this.state); } catch { /* UI listeners do not own persistence. */ } }
  }
  _read(key, storage) {
    try { const raw = storage?.getItem(key); return { value: raw ? JSON.parse(raw) : null, failed: !storage }; }
    catch { return { value: null, failed: true }; }
  }
  _write(key, value, storage) {
    try {
      if (!storage) return false;
      if (value === null) storage.removeItem(key); else storage.setItem(key, JSON.stringify(value));
      return true;
    } catch { return false; }
  }
}
