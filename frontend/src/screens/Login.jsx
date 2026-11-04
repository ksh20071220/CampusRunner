import { useEffect, useState } from "react";
import { useApp } from "../state/AppContext.jsx";
import { apiMessage, normalizeApiError } from "../lib/messages.js";
import { BrandMark, ModeBadge, Notice } from "../components/ui.jsx";

// 로그인·회원가입. (회원 기능의 세부 화면은 4번 담당 범위이며 여기서는 앱 진입에 필요한 최소만 둔다.)

export default function Login() {
  const { login, register, config, saver } = useApp();
  const [mode, setMode] = useState("login");
  const [nickname, setNickname] = useState(config.mock ? "새벽러너" : "");
  const [password, setPassword] = useState(config.mock ? "password123" : "");
  const [university, setUniversity] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = saver.getState().pending;

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (mode === "register" && !university) {
      setError("소속 대학 선택");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") await login(nickname.trim(), password);
      else await register(nickname.trim(), password, university.id);
      // 이동은 App이 로그인 상태를 보고 처리한다 (저장 대기 러닝이 있으면 결과 화면으로).
    } catch (raw) {
      setError(apiMessage(normalizeApiError(raw)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen screen--login">
      <div className="login-mode">
        <ModeBadge />
      </div>
      {/* 로고를 화면 가운데보다 조금 위에 크게 두고, 그 아래에 로그인 칸을 둔다 */}
      <h1 className="login-brand" aria-label="CampusRunner">
        <BrandMark />
        <span className="login-brand__name" aria-hidden="true">
          campus<span className="brand-light">runner</span>
          <span className="brand-dot">.</span>
        </span>
      </h1>

      {pending && (
        <Notice tone="warn" title="저장되지 않은 러닝 1건">
          로그인 후 자동 저장
        </Notice>
      )}

      <div className="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>
          로그인
        </button>
        <button type="button" role="tab" aria-selected={mode === "register"} onClick={() => setMode("register")}>
          회원가입
        </button>
      </div>

      <form className="card form" onSubmit={submit}>
        <label htmlFor="nickname">닉네임</label>
        <input
          id="nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          autoComplete="username"
          maxLength={30}
          required
        />
        <label htmlFor="password">비밀번호</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={8}
          required
        />
        {mode === "register" && (
          <>
            <p className="hint">8자 이상 · 비밀번호 찾기 미지원</p>
            <UniversityPicker value={university} onChange={setUniversity} />
            <p className="hint">학생증 인증 승인 후 대학 점수 반영</p>
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? "확인 중…" : mode === "login" ? "로그인" : "가입하고 시작하기"}
        </button>
      </form>
      {!config.mock && <p className="foot-note">서버: {config.apiBase}</p>}
    </div>
  );
}

function UniversityPicker({ value, onChange }) {
  const { api } = useApp();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setError("");
    setResults([]);
    if (value || query.trim().length < 1) {
      setResults([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      api
        .universities({ q: query.trim() })
        .then((list) => {
          if (!active) return;
          setResults(list.slice(0, 8));
          setError(list.length ? "" : "검색 결과 없음");
        })
        .catch((raw) => active && setError(apiMessage(normalizeApiError(raw))));
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [api, query, value]);

  if (value) {
    return (
      <div className="picked">
        <span>
          <small>소속 대학</small>
          {value.name}
        </span>
        <button type="button" className="btn btn--ghost btn--small" onClick={() => onChange(null)}>
          변경
        </button>
      </div>
    );
  }

  return (
    <div className="picker">
      <label htmlFor="university">소속 대학</label>
      <input
        id="university"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="학교 이름으로 검색"
        autoComplete="off"
      />
      {results.length > 0 && (
        <ul className="picker__list">
          {results.map((u) => (
            <li key={u.id}>
              <button type="button" onClick={() => onChange(u)}>
                {u.name}
                {u.regions?.length > 0 && <small>{u.regions.slice(0, 2).join(" · ")}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="hint">{error}</p>}
    </div>
  );
}
