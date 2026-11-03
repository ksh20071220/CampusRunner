import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 비동기 데이터 불러오기. deps가 바뀌면 다시 부르고, 늦게 도착한 이전 응답은 버린다.
 * 반환: { data, error, loading, reload }
 */
export function useAsync(load, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(load)
      .then(
        (data) => id === seq.current && setState({ data, error: null, loading: false }),
        (error) => id === seq.current && setState((s) => ({ data: s.data, error, loading: false })),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    run();
  }, [run]);
  return { ...state, reload: run };
}

/**
 * 러닝 중 화면 꺼짐 방지 (Screen Wake Lock API). 지원하지 않는 브라우저에서는 조용히 무시한다.
 * 탭이 다시 보이면 잠금을 다시 요청한다. 화면이 꺼진 뒤의 GPS 수집은 브라우저가 보장하지 않는다.
 */
export function useWakeLock(active) {
  const [supported] = useState(() => typeof navigator !== "undefined" && "wakeLock" in navigator);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active || !supported) return undefined;
    let sentinel = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (document.visibilityState !== "visible") return;
        sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          sentinel.release();
          return;
        }
        setHeld(true);
        sentinel.addEventListener("release", () => setHeld(false));
      } catch {
        setHeld(false);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && (!sentinel || sentinel.released)) acquire();
    };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      sentinel?.release().catch(() => {});
      setHeld(false);
    };
  }, [active, supported]);
  return { supported, held };
}

/** 러닝 중에 탭을 닫거나 새로고침하려 하면 브라우저 확인 창을 띄운다. */
export function useLeaveGuard(active) {
  useEffect(() => {
    if (!active) return undefined;
    const handler = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [active]);
}

/** 화면이 꺼지거나 다른 앱으로 전환된 시간을 센다. (GPS 끊김 안내용) */
export function useHiddenNotice(active) {
  const [hiddenFor, setHiddenFor] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    let hiddenAt = null;
    const onChange = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt) {
        const seconds = Math.round((Date.now() - hiddenAt) / 1000);
        hiddenAt = null;
        if (seconds >= 10) setHiddenFor(seconds);
      }
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [active]);
  return [hiddenFor, () => setHiddenFor(0)];
}
