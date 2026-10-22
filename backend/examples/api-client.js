/** Browser ES module. Authentication token stays in memory; the UI owns session UX. */
export class CampusRunnerApi {
  constructor(baseUrl = "http://127.0.0.1:8080") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = null;
  }
  async request(path, { method = "GET", body, token = this.token } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(this.baseUrl + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      const error = new Error(data?.error || "request_failed");
      error.status = response.status;
      throw error;
    }
    return data;
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
    await this.request("/api/auth/logout", { method: "POST", body: {} });
    this.token = null;
  }
  me() { return this.request("/api/me"); }
  updateProfile(profile) { return this.request("/api/me", { method: "PATCH", body: profile }); }
  /** Generate key ONCE at the end of a run and retain it for every network retry.
   * points: [{ timestamp: UTC integer seconds, latitude, longitude }, ...]. */
  submitRun(key, points) { return this.request("/api/runs", { method: "POST", body: { key, points } }); }
  rankings(from, to, limit = 100, offset = 0) {
    const query = new URLSearchParams({ from, to, limit, offset });
    return this.request(`/api/rankings?${query}`, { token: null });
  }
  myRuns(limit = 50, offset = 0) {
    return this.request(`/api/me/runs?${new URLSearchParams({ limit, offset })}`);
  }
  myRun(id) { return this.request(`/api/me/runs/${encodeURIComponent(id)}`); }
  myStats(from, to) { return this.request(`/api/me/stats?${new URLSearchParams({ from, to })}`); }
  universityVerifications(limit = 20, offset = 0) {
    return this.request(`/api/me/university-verifications?${new URLSearchParams({ limit, offset })}`);
  }
  cancelUniversityVerification(id) {
    return this.request(`/api/me/university-verifications/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} });
  }
  /** Show the consent/masking notice to the user before passing consent:true. */
  async submitUniversityProof(file, documentType, { consent = false } = {}) {
    if (!consent) throw new Error('verification_consent_required');
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('jpeg_or_png_up_to_5mb_required');
    const response = await fetch(this.baseUrl + '/api/me/university-verifications', {
      method: 'POST', credentials: 'omit', body: file,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': file.type,
        'X-Document-Type': documentType, 'X-Verification-Consent': '1' },
    });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || 'upload_failed'); error.status = response.status; throw error; }
    return data;
  }
}
