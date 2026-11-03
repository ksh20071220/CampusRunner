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

/** 뒤로 가기 + 제목 줄 */
export function SubHeader({ title, back = "/home", backLabel, right = null }) {
  return (
    <header className="subheader">
      <button type="button" className="back" onClick={() => navigate(back)}>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M19 12H5m6-6-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{backLabel || "뒤로"}</span>
      </button>
      {title && <h1 className="subheader__title">{title}</h1>}
      {right}
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
