import { useEffect, useState } from "react";
import { useApp } from "../state/AppContext.jsx";
import { apiMessage, normalizeApiError } from "../lib/messages.js";
import { ModeBadge, Notice, TopBar } from "../components/ui.jsx";

// 로그인·회원가입. (회원 기능의 세부 화면은 4번 담당 범위이며 여기서는 앱 진입에 필요한 최소만 둔다.)

export default function Login({ onAdminLogin }) {
  const { login, register, api, config, saver } = useApp();
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
      setError("소속 대학을 선택해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const name = nickname.trim();
      if (mode === "register") {
        await register(name, password, university.id);
        return;
      }
      if (!config.mock && name === "admin") {
        let adminError;
        try {
          onAdminLogin(await api.adminLogin(name, password));
          return;
        } catch (error) {
          if (![401, 429].includes(error.status)) throw error;
          adminError = error;
        }
        // Older member accounts can also have this nickname.
        try { await login(name, password); }
        catch (error) { throw adminError.status === 429 && error.status === 401 ? adminError : error; }
      } else {
        await login(name, password);
      }
      // 이동은 App이 로그인 상태를 보고 처리한다 (저장 대기 러닝이 있으면 결과 화면으로).
    } catch (raw) {
      setError(apiMessage(normalizeApiError(raw)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen screen--login">
      <TopBar right={<ModeBadge />} />
      <section className="hero hero--login">
        <div className="kicker">
          <span className="kicker__dot" /> YOUR CAMPUS, YOUR TEAM
        </div>
        <h1>
          혼자 달린 거리가
          <br />
          우리 학교 점수로.
        </h1>
        <p className="muted">개인 러닝 기록이 모여 대학의 점수가 돼요.</p>
      </section>

      {pending && (
        <Notice tone="warn" title="아직 저장하지 않은 러닝이 있어요">
          로그인하면 바로 이어서 저장해요.
        </Notice>
      )}

      <div className="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>
          로그인
        </button>
        <button type="button" role="tab" aria-selected={mode === "register"} onClick={() => setMode("register")}>
          처음이에요
        </button>
      </div>

      <form className="card form" onSubmit={submit}>
        <label htmlFor="nickname">{mode === "login" ? "닉네임 또는 관리자 아이디" : "닉네임"}</label>
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
            <p className="hint">8자 이상. 비밀번호 찾기 기능이 아직 없으니 꼭 기억해 주세요.</p>
            <UniversityPicker value={university} onChange={setUniversity} />
            <p className="hint">가입 후 홈의 학교 인증에서 학생증·합격증을 제출해 주세요. 승인돼야 내 기록이 대학 점수에 반영돼요.</p>
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
          setError(list.length ? "" : "검색 결과가 없어요.");
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
