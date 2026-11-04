import { navigate } from "../lib/router.js";
import { useApp } from "../state/AppContext.jsx";

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path d="M10 9h14l-3 5H9l-3 5h13l-3 5H2L10 9Z" fill="currentColor" />
        <path d="m24 17 5-8h-3l-5 8h3Z" fill="currentColor" />
      </svg>
    </span>
  );
}

export function TopBar({ right = null }) {
  return (
    <header className="topbar">
      <a className="brand" href="#/home" aria-label="CampusRunner 홈">
        <BrandMark />
        <span>
          campus<span className="brand-light">runner</span>
          <span className="brand-dot">.</span>
        </span>
      </a>
      {right}
    </header>
  );
}

// 화면 곳곳에서 쓰는 선 아이콘 (24px 격자, 1.8px 선). 글자 대신 아이콘만 쓸 때는 버튼에 aria-label을 단다.
const ICONS = {
  back: "M15 5l-7 7 7 7",
  logout: "M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9",
  fit: "M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4",
  locate: "M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  home: "M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z",
};

export function Icon({ name, size = 22 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path d={ICONS[name]} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 홈 아이콘 + 가운데 제목. (back, backLabel은 기존 화면 호환용으로 남겨 둔다) */
export function SubHeader({ title, back = "/home", backLabel, right = null }) {
  return (
    <header className="subheader">
      <div className="subheader__left">
        <button type="button" className="icon-button" onClick={() => navigate("/home")} aria-label="홈으로">
          <Icon name="home" size={22} />
        </button>
      </div>
      {title && <h1 className="subheader__title">{title}</h1>}
      <div className="subheader__right">{right}</div>
    </header>
  );
}

export function Badge({ tone = "muted", children }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function Stat({ label, value, unit, big = false }) {
  return (
    <div className={`stat ${big ? "stat--big" : ""}`}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}

export function Spinner({ label = "불러오는 중" }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner__dot" />
      <span>{label}</span>
    </div>
  );
}

export function Notice({ tone = "info", title, children, action = null }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <div>
        {title && <strong>{title}</strong>}
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}

export function Empty({ title, children, action = null }) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M4 18c3-6 6-9 8-9s3 3 8 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="4" cy="18" r="2" fill="currentColor" />
        </svg>
      </div>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

const TABS = [
  { route: "home", path: "/home", label: "홈", icon: "M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z" },
  { route: "run", path: "/run", label: "러닝", icon: "M13 4a2 2 0 1 0 0 .01M9 20l3-6 3 2v4M7 12l3-4 4 1 2 3h3" },
  { route: "records", path: "/records", label: "기록", icon: "M5 19V9m7 10V5m7 14v-7" },
  { route: "rankings", path: "/rankings", label: "대학", icon: "M8 21h8m-4-4v4M7 4h10v5a5 5 0 0 1-10 0V4Zm0 2H4v1a3 3 0 0 0 3 3m10-4h3v1a3 3 0 0 1-3 3" },
];

export function BottomNav({ active }) {
  const current = active === "record" ? "records" : active === "result" ? "run" : active;
  return (
    <nav className="bottom-nav" aria-label="주요 화면">
      {TABS.map((tab) => (
        <a
          key={tab.route}
          href={`#${tab.path}`}
          className={`bottom-nav__item ${current === tab.route ? "is-active" : ""}`}
          aria-current={current === tab.route ? "page" : undefined}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d={tab.icon} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{tab.label}</span>
        </a>
      ))}
    </nav>
  );
}

export function ModeBadge() {
  const { config } = useApp();
  if (!config.mock) return null;
  return <span className="mode-label">목업 모드</span>;
}
