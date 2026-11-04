/** Browser ES module. Authentication token stays in memory; the UI owns session UX. */
export class CampusRunnerApi {
  constructor(baseUrl = "http://127.0.0.1:8080", { timeoutMs = 15000, uploadTimeoutMs = 45000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    if (![timeoutMs, uploadTimeoutMs].every(n => Number.isFinite(n) && n > 0 && n <= 300000))
      throw new TypeError("Request timeouts must be between 0 and 300000 ms");
    this.timeoutMs = timeoutMs;
    this.uploadTimeoutMs = uploadTimeoutMs;
    this._token = null;
    this.sessionVersion = 0;
  }
  get token() { return this._token; }
  set token(value) {
    if (this._token !== value) { this._token = value; ++this.sessionVersion; }
  }
  _sessionChanged(version) {
    if (this.sessionVersion !== version) {
      const error = new Error("session_changed"); error.status = 409; throw error;
    }
  }
  async _fetchJson(path, options, { signal, timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController();
    let timer, onAbort;
    const stopped = new Promise((_, reject) => {
      const fail = (code, status) => {
        const error = new Error(code); error.code = code; error.status = status;
        reject(error); controller.abort();
      };
      onAbort = () => fail("request_cancelled", 0);
      if (signal?.aborted) onAbort();
      else {
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => fail("request_timeout", 408), timeoutMs);
      }
    });
    const request = async () => {
      if (controller.signal.aborted) return stopped;
      const response = await fetch(this.baseUrl + path, { ...options, signal: controller.signal, credentials: "omit" });
      const data = response.status === 204 ? null : await response.json();
      if (!response.ok) {
        const error = new Error(data?.error || "request_failed"); error.status = response.status;
        const retry = response.headers?.get("Retry-After");
        if (retry && /^\d+$/.test(retry)) error.retryAfterSeconds = Math.min(Number(retry), 86400);
        throw error;
      }
      return data;
    };
    try { return await Promise.race([stopped, request()]); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
  }
  request(path, { method = "GET", body, token = this.token, signal } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return this._fetchJson(path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }, { signal });
  }
  universities(filters = {}) {
    const query = new URLSearchParams(filters).toString();
    return this.request(`/api/universities${query ? '?' + query : ''}`, { token: null });
  }
  async register(nickname, password, universityId) {
    const user = await this.request("/api/auth/register", {
      method: "POST", body: { nickname, password, university_id: universityId }, token: null,
    });
    this.token = user.token;
    return user;
  }
  async login(nickname, password) {
    const user = await this.request("/api/auth/login", { method: "POST", body: { nickname, password }, token: null });
    this.token = user.token;
    return user;
  }
  async logout() {
    const token = this.token, version = this.sessionVersion;
    await this.request("/api/auth/logout", { method: "POST", body: {}, token });
    if (this.sessionVersion === version) this.token = null;
  }
  async logoutAll() {
    const token = this.token, version = this.sessionVersion;
    await this.request("/api/auth/logout-all", { method: "POST", body: {}, token });
    this._sessionChanged(version);
    this.token = null;
  }
  async changePassword(currentPassword, newPassword) {
    const token = this.token, version = this.sessionVersion;
    const user = await this.request("/api/me/password", {
      method: "PATCH", body: { current_password: currentPassword, new_password: newPassword }, token,
    });
    this._sessionChanged(version);
    this.token = user.token;
    return user;
  }
  /** Ask the user to confirm permanent deletion before calling this method. */
  async deleteAccount(password) {
    const token = this.token, version = this.sessionVersion;
    await this.request("/api/me", { method: "DELETE", body: { password, confirmation: "DELETE" }, token });
    this._sessionChanged(version);
    this.token = null;
  }
  me({ token = this.token, signal } = {}) { return this.request("/api/me", { token, signal }); }
  updateProfile(profile) { return this.request("/api/me", { method: "PATCH", body: profile }); }
  /** Generate key ONCE at the end of a run and retain it for every network retry.
   * points: [{ timestamp: UTC integer seconds, latitude, longitude }, ...]. */
  submitRun(key, points, { token = this.token, signal } = {}) { return this.request("/api/runs", { method: "POST", body: { key, points }, token, signal }); }
  rankings(from, to, limit = 100, offset = 0) {
    const query = new URLSearchParams({ from, to, limit, offset });
    return this.request(`/api/rankings?${query}`, { token: null });
  }
  universityStats(universityId, from, to) {
    const query = new URLSearchParams({ from, to });
    return this.request(`/api/universities/${encodeURIComponent(universityId)}/stats?${query}`, { token: null });
  }
  myRuns(limit = 50, offset = 0) {
    return this.request(`/api/me/runs?${new URLSearchParams({ limit, offset })}`);
  }
  myRun(id) { return this.request(`/api/me/runs/${encodeURIComponent(id)}`); }
  myStats(from, to) { return this.request(`/api/me/stats?${new URLSearchParams({ from, to })}`); }
  /** bucket: 'day' | 'week'. [from,to) must be whole buckets (max 366); returns one entry per bucket. */
  myStatsSeries(from, to, bucket) {
    return this.request(`/api/me/stats/series?${new URLSearchParams({ from, to, bucket })}`);
  }
  universityVerifications(limit = 20, offset = 0) {
    return this.request(`/api/me/university-verifications?${new URLSearchParams({ limit, offset })}`);
  }
  universityVerification(id) {
    return this.request(`/api/me/university-verifications/${encodeURIComponent(id)}`);
  }
  cancelUniversityVerification(id) {
    return this.request(`/api/me/university-verifications/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} });
  }
  /** Show the consent/masking notice to the user before passing consent:true. */
  async submitUniversityProof(file, documentType, { consent = false, signal } = {}) {
    if (!consent) throw new Error('verification_consent_required');
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('jpeg_or_png_up_to_5mb_required');
    return this._fetchJson('/api/me/university-verifications', {
      method: 'POST', credentials: 'omit', body: file,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': file.type,
        'X-Document-Type': documentType, 'X-Verification-Consent': '1' },
    }, { signal, timeoutMs: this.uploadTimeoutMs });
  }
}
