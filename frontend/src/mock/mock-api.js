import { pointAlongLoop } from "./route-shape.js";

/**
 * CampusRunnerApi와 같은 메서드를 가진 가짜 서버. 화면 개발·발표 시연용.
 * 데이터는 이 브라우저의 localStorage에만 저장된다. (?mock=1&reset=1 로 초기화)
 * ?mock=1&fail=2 : 다음 러닝 저장을 2번 네트워크 오류로 실패시켜 재시도 흐름을 확인한다.
 */

const DB_KEY = "campusrunner.mock-db.v1";
const UNIVERSITIES = [
  { id: 1, name: "서울대학교" },
  { id: 2, name: "연세대학교" },
  { id: 3, name: "고려대학교" },
  { id: 4, name: "한양대학교" },
  { id: 5, name: "성균관대학교" },
  { id: 6, name: "중앙대학교" },
  { id: 7, name: "경희대학교" },
  { id: 8, name: "서강대학교" },
];
// 다른 학교의 이번 주 성적 (1인당 평균 m, 참가자)
const OTHER_SCHOOLS = { 2: [5200, 14], 3: [4100, 22], 4: [3650, 9], 5: [2900, 11], 6: [2400, 6], 7: [1800, 5] };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const radians = (d) => (d * Math.PI) / 180;

function haversine(a, b) {
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function analyze(points) {
  let distance = 0;
  let maxSegment = 0;
  let maxGap = 0;
  for (let i = 1; i < points.length; i += 1) {
    const d = haversine(points[i - 1], points[i]);
    const dt = points[i].timestamp - points[i - 1].timestamp;
    distance += d;
    maxSegment = Math.max(maxSegment, d / dt);
    maxGap = Math.max(maxGap, dt);
  }
  const duration = points[points.length - 1].timestamp - points[0].timestamp;
  const average = duration > 0 ? distance / duration : 0;
  const reasons = [];
  let flags = 0;
  if (maxSegment > 10) (flags |= 1), reasons.push("fast_segment");
  if (average > 6) (flags |= 4), reasons.push("fast_average");
  if (maxGap > 120) (flags |= 8), reasons.push("gps_gap");
  if (duration > 21600) (flags |= 16), reasons.push("long_duration");
  return { distance, duration, average, maxSegment, flags, reasons };
}

function makeRunPoints(startedAt, meters, speed) {
  const points = [];
  const seconds = Math.round(meters / speed);
  const offset = Math.random() * 900;
  for (let t = 0; t <= seconds; t += 5) {
    points.push({ timestamp: startedAt + t, ...pointAlongLoop(offset + t * speed, (Math.random() - 0.5) * 2) });
  }
  return points;
}

function apiError(status, code) {
  const error = new Error(code);
  error.status = status;
  return error;
}

export class MockApi {
  constructor({ failSubmissions = 0, reset = false } = {}) {
    this.token = null;
    this.failSubmissions = failSubmissions;
    if (reset) localStorage.removeItem(DB_KEY);
    this.db = this._load() || this._seed();
  }

  // ---- 저장소 ----
  _load() {
    try {
      return JSON.parse(localStorage.getItem(DB_KEY));
    } catch {
      return null;
    }
  }
  _persist() {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(this.db));
    } catch {
      /* 용량 초과 시 메모리로만 유지 */
    }
  }
  _seed() {
    const db = { members: [], runs: [], nextRunId: 1, sessions: {} };
    db.members.push({ id: 1, nickname: "새벽러너", password: "password123", university_id: 1, verification_status: "approved" });
    const now = Math.floor(Date.now() / 1000);
    // 최근 10주 동안 주 1~3회 러닝
    for (let week = 9; week >= 0; week -= 1) {
      const runsThisWeek = week === 0 ? 1 : 1 + ((week * 7) % 3);
      for (let r = 0; r < runsThisWeek; r += 1) {
        const startedAt = now - week * 7 * 86400 - (r * 2 + 1) * 86400 - 3600 * (2 + r);
        if (startedAt > now - 3600) continue;
        const meters = 2200 + ((week * 37 + r * 53) % 30) * 110;
        const speed = 2.6 + ((10 - week) * 0.05) + (r % 2) * 0.15; // 점점 빨라지는 기록
        this._insertRun(db, 1, makeRunPoints(startedAt, meters, speed), `seed-${week}-${r}`);
      }
    }
    // 의심 기록 하나 (자전거처럼 빠름)
    this._insertRun(db, 1, makeRunPoints(now - 12 * 86400, 6000, 8.5), "seed-bike");
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    return db;
  }

  _insertRun(db, memberId, points, key) {
    const member = db.members.find((m) => m.id === memberId);
    const a = analyze(points);
    const run = {
      id: db.nextRunId++,
      key,
      member_id: memberId,
      university_id: member.university_id,
      started_at: points[0].timestamp,
      ended_at: points[points.length - 1].timestamp,
      duration_seconds: a.duration,
      distance_m: Math.round(a.distance * 1000) / 1000,
      average_mps: a.average,
      max_segment_mps: a.maxSegment,
      max_window_mps: a.maxSegment,
      pace_seconds_per_km: a.distance > 0 ? (a.duration * 1000) / a.distance : null,
      flags: a.flags,
      accepted: a.flags === 0,
      policy_version: 1,
      reasons: a.reasons,
      points,
    };
    db.runs.push(run);
    return run;
  }

  _public(run) {
    const { points, member_id, ...rest } = run;
    const member = this.db.members.find((m) => m.id === member_id);
    return { ...rest, counts_for_university: run.accepted && run.distance_m > 0 && member?.verification_status === "approved" };
  }

  _me(token = this.token) {
    const memberId = this.db.sessions[token];
    const member = this.db.members.find((m) => m.id === memberId);
    if (!member) throw apiError(401, "authentication_required");
    return member;
  }

  _profile(member) {
    const university = UNIVERSITIES.find((u) => u.id === member.university_id);
    return {
      id: member.id,
      nickname: member.nickname,
      university_id: member.university_id,
      university_name: university?.name || "",
      verification_status: member.verification_status,
      university_verified: member.verification_status === "approved",
    };
  }

  _session(member) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    this.db.sessions[token] = member.id;
    this._persist();
    this.token = token;
    return { ...this._profile(member), token, expires_at: Math.floor(Date.now() / 1000) + 7 * 86400 };
  }

  // ---- CampusRunnerApi와 같은 메서드 ----
  async universities(filters = {}) {
    await wait(150);
    const q = filters.q || "";
    return UNIVERSITIES.filter((u) => u.name.includes(q)).map((u) => ({ ...u, kind: "대학교", regions: [], aliases: [], campuses: [] }));
  }

  async register(nickname, password, universityId) {
    await wait(300);
    if (this.db.members.some((m) => m.nickname === nickname)) throw apiError(409, "nickname_taken");
    if (new TextEncoder().encode(password).length < 8) throw apiError(400, "invalid_credentials_format");
    const member = { id: this.db.members.length + 1, nickname, password, university_id: universityId, verification_status: "not_submitted" };
    this.db.members.push(member);
    return this._session(member);
  }

  async login(nickname, password) {
    await wait(300);
    const member = this.db.members.find((m) => m.nickname === nickname && m.password === password);
    if (!member) throw apiError(401, "invalid_credentials");
    return this._session(member);
  }

  async logout() {
    delete this.db.sessions[this.token];
    this._persist();
    this.token = null;
  }

  async me({ token = this.token } = {}) {
    await wait(120);
    return this._profile(this._me(token));
  }

  async submitRun(key, points, { token = this.token } = {}) {
    await wait(700);
    if (this.failSubmissions > 0) {
      this.failSubmissions -= 1;
      throw new TypeError("Failed to fetch");
    }
    const member = this._me(token);
    if (!Array.isArray(points) || points.length < 2) throw apiError(400, "invalid_point_count");
    const existing = this.db.runs.find((r) => r.member_id === member.id && r.key === key);
    if (existing) return this._public(existing);
    const run = this._insertRun(this.db, member.id, points, key);
    this._persist();
    return this._public(run);
  }

  async myRuns(limit = 50, offset = 0) {
    await wait(200);
    const member = this._me();
    return this.db.runs
      .filter((r) => r.member_id === member.id)
      .sort((a, b) => b.started_at - a.started_at || b.id - a.id)
      .slice(offset, offset + limit)
      .map((r) => this._public(r));
  }

  async myRun(id) {
    await wait(200);
    const member = this._me();
    const run = this.db.runs.find((r) => r.id === Number(id) && r.member_id === member.id);
    if (!run) throw apiError(404, "not_found");
    return { ...this._public(run), points: run.points };
  }

  async myStats(from, to) {
    await wait(150);
    const member = this._me();
    const runs = this.db.runs.filter((r) => r.member_id === member.id && r.started_at >= from && r.started_at < to);
    return {
      distance_m: runs.filter((r) => r.accepted).reduce((sum, r) => sum + r.distance_m, 0),
      accepted_runs: runs.filter((r) => r.accepted).length,
      flagged_runs: runs.filter((r) => !r.accepted).length,
      duration_seconds: runs.filter(r => r.accepted && r.distance_m > 0).reduce((sum,r) => sum+r.duration_seconds,0),
      pace_seconds_per_km: (() => {
        const accepted = runs.filter(r => r.accepted && r.distance_m > 0);
        const distance = accepted.reduce((sum,r) => sum+r.distance_m,0);
        return distance ? accepted.reduce((sum,r) => sum+r.duration_seconds,0)*1000/distance : null;
      })(),
    };
  }

  _rankings(from, to) {
    const rows = UNIVERSITIES.map((u) => {
      const runs = this.db.runs.filter((r) => {
        const member = this.db.members.find((m) => m.id === r.member_id);
        return r.university_id === u.id && r.accepted && r.distance_m > 0 && member?.verification_status === "approved" && r.started_at >= from && r.started_at < to;
      });
      let distance = runs.reduce((sum, r) => sum + r.distance_m, 0);
      let participants = new Set(runs.map((r) => r.member_id)).size;
      let runCount = runs.length;
      const fake = OTHER_SCHOOLS[u.id];
      if (fake) {
        const scale = Math.max(1, (to - from) / (7 * 86400)) ** 0.6;
        participants += fake[1];
        distance += fake[0] * fake[1] * Math.min(scale, 6);
        runCount += fake[1] * 2;
      }
      return { university_id: u.id, university_name: u.name, distance_m: distance, participants, runs: runCount, average_distance_m: participants ? distance / participants : 0 };
    });
    rows.sort((a, b) => b.average_distance_m - a.average_distance_m || a.university_id - b.university_id);
    let rank = 0;
    rows.forEach((row, i) => {
      if (i === 0 || row.average_distance_m !== rows[i - 1].average_distance_m) rank = i + 1;
      row.rank = rank;
    });
    return rows;
  }

  async rankings(from, to, limit = 100, offset = 0) {
    await wait(250);
    return this._rankings(from, to).slice(offset, offset + limit);
  }

  async universityStats(universityId, from, to) {
    await wait(150);
    const row = this._rankings(from, to).find((r) => r.university_id === Number(universityId));
    if (!row) throw apiError(404, "not_found");
    return row;
  }
}
