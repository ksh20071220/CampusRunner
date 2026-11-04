import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../state/AppContext.jsx";
import { apiMessage, normalizeApiError } from "../lib/messages.js";
import { dateTime, duration, km, pace } from "../lib/format.js";
import { Badge, Empty, Notice, Spinner } from "./ui.jsx";
import { navigate } from "../lib/router.js";

const PAGE = 200;
const STEP = 20;

// List pages are independent of the server aggregates used by the graph/header.
export default function RecordHistory() {
  const { api, dataVersion, handleAuthError } = useApp();
  const [runs, setRuns] = useState([]);
  const [visible, setVisible] = useState(STEP);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const offset = useRef(0), generation = useRef(0), busy = useRef(false);

  const load = useCallback(async (reset = false) => {
    if (busy.current && !reset) return;
    const version = reset ? ++generation.current : generation.current;
    if (reset) { offset.current = 0; setRuns([]); setVisible(STEP); setHasMore(true); }
    busy.current = true; setLoading(true); setError(null);
    try {
      const rows = await api.myRuns(PAGE, offset.current);
      if (version !== generation.current) return;
      offset.current += rows.length;
      setRuns(previous => {
        const seen = new Set(previous.map(run => run.id));
        return [...previous, ...rows.filter(run => !seen.has(run.id))];
      });
      setHasMore(rows.length === PAGE);
      if (!reset) setVisible(value => value + STEP);
    } catch (raw) {
      if (version !== generation.current) return;
      setError(normalizeApiError(raw)); handleAuthError(raw);
    } finally {
      if (version === generation.current) { busy.current = false; setLoading(false); }
    }
  }, [api, handleAuthError]);

  useEffect(() => {
    load(true);
    return () => { ++generation.current; busy.current = false; };
  }, [load, dataVersion]);

  return <section>
    <h2 className="section-title">과거 기록</h2>
    {loading && !runs.length && <Spinner />}
    {error && <Notice tone="bad" title="기록 목록 불러오기 실패" action={
      <button type="button" className="btn btn--ghost btn--small" onClick={() => load()}>다시 시도</button>
    }>{apiMessage(error)}</Notice>}
    {!loading && !error && !runs.length && <Empty title="기록 없음" action={
      <button type="button" className="btn btn--primary" onClick={() => navigate("/run")}>첫 러닝 시작하기</button>
    }>러닝 저장 시 표시</Empty>}
    <ul className="run-list">{runs.slice(0, visible).map(run => <li key={run.id}>
      <a href={`#/records/${run.id}`} className="run-item">
        <div className="run-item__main">
          <span className="run-item__date">{dateTime(run.started_at)}</span>
          <span className="run-item__meta">{duration(run.duration_seconds)} · {pace(run.pace_seconds_per_km)}/km
            {!run.accepted && <Badge tone="bad">의심</Badge>}</span>
        </div>
        <span className={`run-item__distance ${run.accepted ? "" : "is-flagged"}`}>{km(run.distance_m)}<small>km</small></span>
        <span className="chevron" aria-hidden="true">›</span>
      </a>
    </li>)}</ul>
    {(visible < runs.length || hasMore) && !error && <button type="button" className="btn btn--outline btn--block" disabled={loading}
      onClick={() => visible < runs.length ? setVisible(value => value + STEP) : load()}>
      {loading ? "불러오는 중…" : "기록 더 보기"}
    </button>}
  </section>;
}
