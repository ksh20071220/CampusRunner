const EARTH_RADIUS_METERS = 6_371_000;
const MAX_SERVER_POINTS = 20_000;
const DEFAULT_STORAGE_KEY = "campusrunner.active-run.v1";

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function haversineMeters(a, b) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const h =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) *
      Math.cos(latitudeB) *
      Math.sin(longitudeDelta / 2) ** 2;
  const boundedH = Math.min(1, Math.max(0, h));
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(boundedH), Math.sqrt(1 - boundedH));
}

function validPoint(point) {
  return (
    point &&
    Number.isInteger(point.timestamp) &&
    point.timestamp >= 0 &&
    Number.isFinite(point.latitude) &&
    Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.longitude) <= 180
  );
}

/**
 * Collects browser GPS positions for one run.
 *
 * The points match POST /api/runs:
 * { timestamp: UTC Unix seconds, latitude, longitude }.
 * The tracker keeps a local recovery draft. Call markSaved() only after the
 * records/API layer confirms the upload; that layer owns permanent storage.
 */
export class RunTracker {
  constructor({
    geolocation = globalThis.navigator?.geolocation,
    positionOptions = {},
    maxAccuracyMeters = null,
    firstFixTimeoutMs = 30_000,
    maxPoints = MAX_SERVER_POINTS,
    checkpointIntervalMs = 5_000,
    storage = browserStorage(),
    storageKey = DEFAULT_STORAGE_KEY,
    now = () => Date.now(),
  } = {}) {
    if (!geolocation || typeof geolocation.watchPosition !== "function") {
      throw makeError("geolocation_unavailable", "This device does not provide browser geolocation.");
    }
    if (
      maxAccuracyMeters !== null &&
      (!Number.isFinite(maxAccuracyMeters) || maxAccuracyMeters <= 0)
    ) {
      throw new TypeError("maxAccuracyMeters must be a positive number or null.");
    }
    if (!Number.isFinite(firstFixTimeoutMs) || firstFixTimeoutMs <= 0) {
      throw new TypeError("firstFixTimeoutMs must be a positive number.");
    }
    if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > MAX_SERVER_POINTS) {
      throw new RangeError("maxPoints must be between 2 and 20000.");
    }
    if (!Number.isFinite(checkpointIntervalMs) || checkpointIntervalMs < 0) {
      throw new TypeError("checkpointIntervalMs must be a non-negative number.");
    }

    this.geolocation = geolocation;
    this.positionOptions = {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15_000,
      ...positionOptions,
    };
    this.maxAccuracyMeters = maxAccuracyMeters;
    this.firstFixTimeoutMs = firstFixTimeoutMs;
    this.maxPoints = maxPoints;
    this.checkpointIntervalMs = checkpointIntervalMs;
    this.storage = storage;
    this.lastPersistedAt = null;
    this.storageKey = storageKey;
    this.now = now;

    this.status = "idle";
    this.points = [];
    this.distanceMeters = 0;
    this.lastAccuracyMeters = null;
    this.error = null;
    this.storageError = null;
    this.draftSaved = false;
    this.uploadPending = false;
    this.watchId = null;
    this.firstFixTimer = null;
    this.elapsedTimer = null;
    this.startPromise = null;
    this.resolveStart = null;
    this.rejectStart = null;
    this.listeners = new Set();

    this._restoreDraft();
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function.");
    }
    this.listeners.add(listener);
    this._notifyOne(listener);
    return () => this.listeners.delete(listener);
  }

  getPoints() {
    return this.points.map((point) => ({ ...point }));
  }

  getSnapshot() {
    const first = this.points[0];
    const last = this.points[this.points.length - 1];
    const isActive = this.status === "running" || this.status === "starting";
    const elapsedSeconds =
      first && last
        ? isActive
          ? Math.max(last.timestamp - first.timestamp, Math.floor(this.now() / 1000) - first.timestamp, 0)
          : Math.max(last.timestamp - first.timestamp, 0)
        : 0;

    const visibleError = this.error || this.storageError;
    return {
      status: this.status,
      pointCount: this.points.length,
      distanceMeters: Math.round(this.distanceMeters * 1000) / 1000,
      elapsedSeconds,
      lastPoint: last ? { ...last } : null,
      lastAccuracyMeters: this.lastAccuracyMeters,
      recoveryAvailable: Boolean(this.storage),
      error: visibleError ? { code: visibleError.code, message: visibleError.message } : null,
    };
  }

  start() {
    if (this.status === "starting") return this.startPromise;
    if (this.status === "running") {
      return Promise.reject(makeError("already_running", "A run is already in progress."));
    }

    const resumeDraft =
      this.status === "recovered" ||
      (this.points.length > 0 && this.uploadPending);

    if (resumeDraft) {
      this.status = "starting";
      this.error = null;
    } else {
      this._reset();
      this.status = "starting";
    }
    this._emit();

    this.startPromise = new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });

    this.firstFixTimer = setTimeout(() => {
      this._fail(makeError("first_fix_timeout", "No GPS position was received before the timeout."));
    }, this.firstFixTimeoutMs);

    try {
      this.watchId = this.geolocation.watchPosition(
        (position) => this._onPosition(position),
        (error) => this._onPositionError(error),
        this.positionOptions,
      );
    } catch (error) {
      this._fail(makeError("geolocation_start_failed", error?.message || "Could not start GPS tracking."));
    }

    return this.startPromise;
  }

  stop() {
    const wasStarting = this.status === "starting";
    this._clearWatch();
    this._clearTimers();

    if (wasStarting && this.rejectStart) {
      this.rejectStart(makeError("stopped_before_first_fix", "Tracking stopped before the first GPS position."));
    }
    this.resolveStart = null;
    this.rejectStart = null;
    this.startPromise = null;

    if (this.status !== "error") this.status = "stopped";
    this._persistDraft(true);
    this._emit();

    const first = this.points[0];
    const last = this.points[this.points.length - 1];
    const canSubmit = this.points.length >= 2;
    return {
      points: this.points.map((point) => ({ ...point })),
      distanceMeters: Math.round(this.distanceMeters * 1000) / 1000,
      elapsedSeconds: first && last ? Math.max(last.timestamp - first.timestamp, 0) : 0,
      canSubmit,
      reason: canSubmit ? null : "at_least_two_positions_required",
      recoveryAvailable: Boolean(this.storage),
    };
  }

  /** Remove the local draft after the server confirms that this run was saved. */
  markSaved() {
    // Remote acknowledgement is final even if local cleanup fails.
    this.uploadPending = false;
    try {
      this.storage?.removeItem(this.storageKey);
      this.draftSaved = false;
      this.storageError = null;
      this.error = null;
      if (this.points.length > 0) this.status = "stopped";
    } catch {
      this.storageError = makeError("local_storage_failed", "The saved GPS draft could not be cleared.");
    }
    this._emit();
  }

  /** Discard a recovered or unsaved run and clear its local draft. */
  discardDraft() {
    this._clearWatch();
    this._clearTimers();
    if (this.rejectStart) {
      this.rejectStart(makeError("run_discarded", "The unsaved run was discarded."));
    }
    this.resolveStart = null;
    this.rejectStart = null;
    this.startPromise = null;
    this.points = [];
    this.distanceMeters = 0;
    this.lastAccuracyMeters = null;
    this.error = null;
    this.uploadPending = false;
    this.status = "idle";
    this.markSaved();
  }

  dispose() {
    this.stop();
    this.listeners.clear();
  }

  _restoreDraft() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (
        saved?.version !== 1 ||
        !Array.isArray(saved.points) ||
        saved.points.length < 1 ||
        saved.points.length > this.maxPoints ||
        !saved.points.every(validPoint) ||
        saved.points.some((point, index, points) => index > 0 && point.timestamp <= points[index - 1].timestamp)
      ) {
        throw new Error("The saved GPS draft has an unsupported or invalid format.");
      }

      this.points = saved.points.map(({ timestamp, latitude, longitude }) => ({
        timestamp,
        latitude,
        longitude,
      }));
      this.distanceMeters = this._calculateDistance(this.points);
      this.status = "recovered";
      this.draftSaved = true;
      this.uploadPending = true;
      this.lastPersistedAt = this.now();
    } catch (error) {
      this.storageError = makeError(
        "saved_run_invalid",
        error?.message || "The saved GPS draft could not be restored.",
      );
    }
  }

  _reset() {
    this._clearWatch();
    this._clearTimers();
    this.status = "idle";
    this.points = [];
    this.distanceMeters = 0;
    this.lastAccuracyMeters = null;
    this.error = null;
    this.uploadPending = false;
    this.storageError = null;
    this.lastPersistedAt = null;
    this.startPromise = null;
    this.resolveStart = null;
    this.rejectStart = null;
  }

  _onPosition(position) {
    if (this.status !== "starting" && this.status !== "running") return;

    const coordinates = position?.coords;
    const latitude = coordinates?.latitude;
    const longitude = coordinates?.longitude;
    const accuracy = Number.isFinite(coordinates?.accuracy) ? coordinates.accuracy : null;
    const timestampMs = Number.isFinite(position?.timestamp) ? position.timestamp : this.now();

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180 ||
      !Number.isFinite(timestampMs) ||
      timestampMs < 0
    ) {
      this._setError(makeError("invalid_position", "The GPS position was invalid."));
      return;
    }

    if (this.maxAccuracyMeters !== null && (accuracy === null || accuracy > this.maxAccuracyMeters)) {
      this.lastAccuracyMeters = accuracy;
      this._setError(makeError("poor_accuracy", "The GPS accuracy is not good enough yet."));
      return;
    }

    const point = {
      timestamp: Math.floor(timestampMs / 1000),
      latitude,
      longitude,
    };
    const last = this.points[this.points.length - 1];

    if (last && point.timestamp < last.timestamp) {
      this._setError(makeError("out_of_order_position", "An older GPS position was ignored."));
      return;
    }

    if (last && point.timestamp === last.timestamp) {
      if (
        (accuracy === null && this.lastAccuracyMeters !== null) ||
        (accuracy !== null &&
          this.lastAccuracyMeters !== null &&
          accuracy >= this.lastAccuracyMeters)
      ) {
        return;
      }

      if (this.points.length > 1) {
        const previous = this.points[this.points.length - 2];
        this.distanceMeters -= haversineMeters(previous, last);
        this.points[this.points.length - 1] = point;
        this.distanceMeters += haversineMeters(previous, point);
      } else {
        this.points[0] = point;
      }
    } else {
      if (this.points.length >= this.maxPoints) {
        this._fail(makeError("point_limit", "The run reached the GPS point limit and must be saved."));
        return;
      }
      if (last) this.distanceMeters += haversineMeters(last, point);
      this.points.push(point);
    }

    this.lastAccuracyMeters = accuracy;
    this.error = null;
    this.uploadPending = true;
    this._persistDraft();

    if (this.status === "starting") {
      this.status = "running";
      if (this.firstFixTimer !== null) clearTimeout(this.firstFixTimer);
      this.firstFixTimer = null;
      this.elapsedTimer = setInterval(() => this._emit(), 1000);

      const resolve = this.resolveStart;
      this.resolveStart = null;
      this.rejectStart = null;
      this.startPromise = null;
      resolve?.(this.getSnapshot());
    }

    this._emit();
  }

  _onPositionError(positionError) {
    const messages = {
      1: "Location permission was denied.",
      2: "The device could not determine its location.",
      3: "Waiting for a GPS position timed out.",
    };
    const code = Number(positionError?.code);
    const error = makeError(
      code === 1 ? "permission_denied" : "position_unavailable",
      messages[code] || positionError?.message || "GPS tracking failed.",
    );

    if (code === 1) {
      this._fail(error);
      return;
    }
    this._setError(error);
  }

  _setError(error) {
    this.error = error;
    this._emit();
  }

  _fail(error) {
    if (this.status === "error" || this.status === "stopped") return;
    this._clearWatch();
    this._clearTimers();
    this.status = "error";
    this.error = error;

    const reject = this.rejectStart;
    this.resolveStart = null;
    this.rejectStart = null;
    this.startPromise = null;
    reject?.(error);
    this._emit();
  }

  _persistDraft(force = false) {
    // Keep saved points available to the result screen, but never recreate their
    // recovery draft when stop()/dispose() runs again after acknowledgement.
    if (!this.uploadPending || !this.storage || this.points.length === 0) return;
    const now = this.now();
    if (!force && this.lastPersistedAt !== null && now - this.lastPersistedAt < this.checkpointIntervalMs) return;
    try {
      this.storage.setItem(
        this.storageKey,
        JSON.stringify({
          version: 1,
          points: this.points,
        }),
      );
      this.draftSaved = true;
      this.lastPersistedAt = now;
      this.storageError = null;
    } catch {
      this.draftSaved = false;
      this.storageError = makeError("local_storage_failed", "GPS recovery could not be saved on this device.");
    }
  }

  _calculateDistance(points) {
    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
      total += haversineMeters(points[index - 1], points[index]);
    }
    return total;
  }

  _clearWatch() {
    if (this.watchId === null) return;
    this.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  _clearTimers() {
    if (this.firstFixTimer !== null) clearTimeout(this.firstFixTimer);
    if (this.elapsedTimer !== null) clearInterval(this.elapsedTimer);
    this.firstFixTimer = null;
    this.elapsedTimer = null;
  }

  _notifyOne(listener) {
    try {
      listener(this.getSnapshot());
    } catch {
      // A screen listener should not interrupt GPS collection.
    }
  }

  _emit() {
    for (const listener of this.listeners) this._notifyOne(listener);
  }
}
