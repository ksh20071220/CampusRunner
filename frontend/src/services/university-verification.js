import { normalizeApiError } from "../lib/messages.js";
import { DOCUMENT_TYPES, inspectProof, verificationError } from "./verification-files.js";

const PAGE = 20;
const isUncertain = error => error.code === "network_error" || error.status === 408 || error.status >= 500;

// Metadata only. Photos/preview URLs never enter this store or browser storage.
export class UniversityVerification {
  constructor({ api, user, onProfile = () => {}, onAuthError = () => {} }) {
    this.api = api; this.token = user.token; this.memberId = user.id;
    this.onProfile = onProfile; this.onAuthError = onAuthError;
    this.active = false; this.sequence = 0; this.controller = null;
    this.listeners = new Set();
    this.state = { profile: user, rows: [], hasMore: false, loaded: false, fresh: false,
      loading: false, busy: null, error: null, notice: null, uncertain: false };
  }
  getState = () => this.state;
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  _set(patch) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  connect() { this.active = true; this._set({ loading: false, busy: null, uncertain: this.state.uncertain || Boolean(this.state.busy) }); }
  disconnect() { this.active = false; ++this.sequence; this.controller?.abort(); this.controller = null; }
  _current(version) { return this.active && this.sequence === version && this.api.token === this.token; }
  _operation() {
    this.controller?.abort(); this.controller = new AbortController();
    return { version: ++this.sequence, options: { token: this.token, signal: this.controller.signal } };
  }
  async _read(options, more = false) {
    const [rows, profile] = await Promise.all([
      this.api.universityVerifications(PAGE + 1, more ? this.state.rows.length : 0, options),
      this.api.me(options),
    ]);
    if (profile.id !== this.memberId || rows.some(row => row.member_id !== this.memberId))
      throw verificationError("record_owner_mismatch");
    return { rows, profile };
  }
  _apply({ rows, profile }, more = false) {
    const combined = [...(more ? this.state.rows : []), ...rows.slice(0, PAGE)];
    const seen = new Set();
    this._set({ profile, rows: combined.filter(row => !seen.has(row.id) && seen.add(row.id)),
      hasMore: rows.length > PAGE, loaded: true, fresh: true, uncertain: false });
    this.onProfile(profile, this.token);
  }
  async refresh(more = false) {
    if (!this.active || this.api.token !== this.token || this.state.busy || (more && this.state.loading)) return;
    const { version, options } = this._operation();
    this._set({ loading: true, fresh: false, error: null, notice: null });
    try {
      const result = await this._read(options, more);
      if (this._current(version)) this._apply(result, more);
    } catch (raw) {
      if (this._current(version)) {
        const error = normalizeApiError(raw);
        this._set({ error }); this.onAuthError(error);
      }
    } finally { if (this._current(version)) this._set({ loading: false }); }
  }
  _known(row) {
    const profile = { ...this.state.profile, verification_status: row.status, university_verified: row.status === "approved" };
    this._set({ rows: [row, ...this.state.rows.filter(item => item.id !== row.id)], profile });
    this.onProfile(profile, this.token);
  }
  async _mutate(kind, perform) {
    if (!this.active || this.api.token !== this.token || this.state.busy || !this.state.fresh || this.state.uncertain) return null;
    const { version, options } = this._operation();
    this._set({ busy: kind, loading: false, error: null, notice: null });
    let confirmed = null;
    try {
      confirmed = await perform(options);
      if (!this._current(version)) return null;
      if (confirmed.member_id !== this.memberId) throw verificationError("record_owner_mismatch");
      this._known(confirmed);
      this._set({ notice: kind === "upload" ? "서류를 제출했어요. 운영진이 직접 확인할게요." : "신청을 취소했어요. 제출한 사진도 삭제됐어요." });
      try {
        const result = await this._read(options);
        if (this._current(version)) this._apply(result);
      } catch (raw) {
        if (this._current(version)) { this._set({ error: normalizeApiError(raw), fresh: false }); this.onAuthError(raw); }
      }
      return confirmed;
    } catch (raw) {
      if (!this._current(version)) return null;
      const error = normalizeApiError(raw);
      this._set({ error, uncertain: isUncertain(error), fresh: !isUncertain(error) });
      this.onAuthError(error);
      if (isUncertain(error) || error.status === 409) {
        const oldIds = new Set(this.state.rows.map(row => row.id));
        const pendingIds = new Set(this.state.rows.filter(row => row.status === "pending").map(row => row.id));
        try {
          const result = await this._read(options);
          if (!this._current(version)) return null;
          this._apply(result);
          const received = result.rows.find(row => !oldIds.has(row.id));
          if (kind === "upload" && received) {
            this._set({ error: null, notice: "서버에 접수된 신청을 확인했어요. 아래에서 최신 심사 상태를 확인해 주세요." });
            return received;
          }
          const cancelled = result.rows.find(row => pendingIds.has(row.id) && row.status === "cancelled");
          if (kind === "cancel" && cancelled) {
            this._set({ error: null, notice: "서버에서 신청이 취소된 것을 확인했어요. 새 서류를 제출할 수 있어요." });
            return cancelled;
          }
        } catch { /* Keep uncertain=true until an authoritative refresh succeeds. */ }
      }
      return null;
    } finally { if (this._current(version)) this._set({ busy: null }); }
  }
  submit(file, documentType, consent) {
    if (this.state.profile.university_verified || this.state.rows.some(row => row.status === "pending")) return Promise.resolve(null);
    return this._mutate("upload", async options => {
      if (!consent) throw verificationError("verification_consent_required");
      if (!DOCUMENT_TYPES.some(item => item.value === documentType)) throw verificationError("invalid_document_type");
      await inspectProof(file);
      if (options.signal.aborted || !this.active || this.api.token !== this.token) throw verificationError("request_cancelled");
      return this.api.submitUniversityProof(file, documentType, { ...options, consent: true });
    });
  }
  cancel(id) {
    if (!this.state.rows.some(row => row.id === id && row.status === "pending")) return Promise.resolve(null);
    return this._mutate("cancel", options => this.api.cancelUniversityVerification(id, options));
  }
}
