import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CampusRunnerApi } from "@campus-api";
import { AccountRuns } from "../services/account-runs.js";
import { browserStorage } from "../services/run-saver.js";
import { MockApi } from "../mock/mock-api.js";
import { MockGeolocation } from "../mock/mock-geolocation.js";
import { normalizeApiError } from "../lib/messages.js";

// 앱 전체가 공유하는 상태: API 클라이언트, 로그인 회원, GPS 측정기, 저장 서비스.
// 같은 회원은 화면이 바뀌어도 RunTracker를 유지한다. 로그아웃하면 측정을 중단한다. 화면에서는 구독/구독 해제만 한다.

const sessionKey = (scope) => `campusrunner.session.v2.${encodeURIComponent(scope)}`;
const AppContext = createContext(null);

function readConfig() {
  const params = new URLSearchParams(window.location.search);
  const mock = params.has("mock") || import.meta.env.VITE_MOCK === "1";
  const envBase = import.meta.env.VITE_API_BASE_URL;
  // 서버 기본 Listen이 IPv4(127.0.0.1)이므로 localhost(IPv6 ::1로 갈 수 있음)는 127.0.0.1로 바꾼다.
  // 휴대폰에서 PC IP(예: 192.168.0.12:5173)로 접속하면 같은 IP의 8080을 쓴다.
  const host = window.location.hostname === "localhost" ? "127.0.0.1" : window.location.hostname;
  const apiBase = envBase || `${window.location.protocol}//${host}:8080`;
  return {
    mock,
    apiBase,
    scope: mock ? "mock" : new URL(apiBase).href.replace(/\/$/, ""),
    mockFail: Number(params.get("fail") || 0),
    mockReset: params.has("reset"),
    gpsFail: params.get("gpsfail"),
  };
}

function createServices(config) {
  const api = config.mock
    ? new MockApi({ failSubmissions: config.mockFail, reset: config.mockReset })
    : new CampusRunnerApi(config.apiBase);

  const accounts = new AccountRuns({ api, scope: config.scope,
    trackerOptions: () => config.mock ? { geolocation: new MockGeolocation({ failMode: config.gpsFail }) } : {},
    insecureContext: !config.mock && !window.isSecureContext });
  const saved = readSession(config.scope);
  if (saved?.token) api.token = saved.token;
  const binding = accounts.activateSession(saved);
  return { api, accounts, saver: accounts.saver, initialSession: saved, initialBinding: binding };
}

function readSession(scope) {
  try {
    return JSON.parse(browserStorage("sessionStorage")?.getItem(sessionKey(scope)) || "null");
  } catch {
    return null;
  }
}

function writeSession(scope, session) {
  try {
    if (session) browserStorage("sessionStorage")?.setItem(sessionKey(scope), JSON.stringify(session));
    else browserStorage("sessionStorage")?.removeItem(sessionKey(scope));
  } catch {
    /* 저장 실패 시 이번 탭 메모리로만 유지 */
  }
}

export function AppProvider({ children }) {
  const config = useMemo(readConfig, []);
  const services = useMemo(() => createServices(config), [config]);
  const { api, accounts, saver } = services;
  const [binding, setBinding] = useState(services.initialBinding);

  // 토큰은 sessionStorage(탭을 닫으면 삭제)에 둔다. 러닝 중 실수로 새로고침해도 다시 로그인하지 않게 한다.
  const [session, setSession] = useState(services.initialSession);
  const [authChecked, setAuthChecked] = useState(!session);
  const [dataVersion, setDataVersion] = useState(0);

  const applySession = useCallback(
    (user) => {
      const next = user ? { ...user, token: user.token ?? api.token } : null;
      api.token = next?.token ?? null;
      setBinding(accounts.activateSession(next));
      writeSession(config.scope, next);
      setSession(next);
      setAuthChecked(true);
    },
    [api, accounts, config.scope],
  );

  // 저장된 토큰이 아직 유효한지 확인하고 프로필을 최신으로 맞춘다.
  useEffect(() => {
    if (!session?.token) return;
    let alive = true;
    const token = session.token;
    const current = () => alive && api.token === token;
    api
      .me({ token })
      .then((me) => current() && applySession({ ...me, token }))
      .catch((error) => {
        if (current() && normalizeApiError(error).status === 401) applySession(null);
      })
      .finally(() => current() && setAuthChecked(true));
    return () => {
      alive = false;
    };
    // 최초 1회만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { saver.connect(); return () => saver.disconnect(); }, [saver]);

  // 저장 완료되면 홈/기록 화면이 다시 불러오도록 버전을 올린다.
  useEffect(
    () =>
      saver.subscribe((state) => {
        if (state.phase === "saved") setDataVersion((v) => v + 1);
      }),
    [saver],
  );

  // 로그인 상태에서 저장 대기 중인 러닝이 있으면 바로 다시 보낸다. (새로고침·재로그인 후)
  useEffect(() => {
    if (session?.token && authChecked && saver.getState().pending) saver.save();
  }, [session?.token, authChecked, saver]);

  const login = useCallback(
    async (nickname, password) => {
      const user = await api.login(nickname, password);
      applySession(user);
      return user;
    },
    [api, applySession],
  );

  const register = useCallback(
    async (nickname, password, universityId) => {
      const user = await api.register(nickname, password, universityId);
      applySession(user);
      return user;
    },
    [api, applySession],
  );

  const logout = useCallback(async () => {
    const request = api.logout();
    applySession(null);
    try {
      await request;
    } catch {
      /* 서버 세션이 이미 만료돼도 화면에서는 로그아웃 처리 */
    }
  }, [api, applySession]);

  const refreshMe = useCallback(async () => {
    const token = api.token;
    try {
      const me = await api.me({ token });
      if (api.token === token) applySession({ ...me, token });
      return me;
    } catch (error) {
      if (api.token === token && normalizeApiError(error).status === 401) applySession(null);
      throw error;
    }
  }, [api, applySession]);

  // Only a response for the still-current member may refresh the displayed profile.
  const syncProfile = useCallback((profile, token) => {
    if (api.token !== token || profile.id !== accounts.memberId) return;
    applySession({ ...profile, token });
    setDataVersion(version => version + 1);
  }, [api, accounts, applySession]);

  /** 화면에서 API 401을 받으면 로그인 화면으로 보내기 위해 세션을 비운다. */
  const handleAuthError = useCallback(
    (error) => {
      if (normalizeApiError(error).status === 401) applySession(null);
    },
    [applySession],
  );

  const value = useMemo(
    () => ({
      config,
      api, saver,
      ...binding,
      user: session,
      authChecked,
      login,
      register,
      logout,
      refreshMe,
      syncProfile,
      handleAuthError,
      dataVersion,
    }),
    [config, api, saver, binding, session, authChecked, login, register, logout, refreshMe, syncProfile, handleAuthError, dataVersion],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

const IDLE_SNAPSHOT = {
  status: "unavailable",
  pointCount: 0,
  distanceMeters: 0,
  elapsedSeconds: 0,
  lastPoint: null,
  lastAccuracyMeters: null,
  error: null,
};

/** RunTracker 상태를 React 화면에 연결한다. */
export function useTrackerSnapshot() {
  const { tracker } = useApp();
  const [snapshot, setSnapshot] = useState(() => (tracker ? tracker.getSnapshot() : IDLE_SNAPSHOT));
  // subscribe는 등록 즉시 현재 값을 한 번 보내고, 이후 변경·1초마다 다시 보낸다.
  useEffect(() => {
    if (tracker) return tracker.subscribe(setSnapshot);
    setSnapshot(IDLE_SNAPSHOT);
    return undefined;
  }, [tracker]);
  return snapshot;
}

/** 화면 데이터 요청이 401이면 세션을 비워 로그인 화면으로 보낸다. */
export function useAuthErrorGuard(error) {
  const { handleAuthError } = useApp();
  useEffect(() => {
    if (error) handleAuthError(error);
  }, [error, handleAuthError]);
}

export function useSaverState() {
  const { saver } = useApp();
  return useSyncExternalStore(
    useCallback((onChange) => saver.subscribe(onChange), [saver]),
    () => saver.getState(),
  );
}
