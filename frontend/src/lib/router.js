import { useEffect, useState } from "react";

// 해시 기반 화면 이동: #/home, #/run, #/result, #/records, #/records/12, #/rankings, #/login
// 서버 설정 없이 정적 파일만으로 새로고침·뒤로 가기가 동작한다.

const ROUTES = [
  { name: "home", pattern: /^\/home$/ },
  { name: "run", pattern: /^\/run$/ },
  { name: "result", pattern: /^\/result$/ },
  { name: "records", pattern: /^\/records$/ },
  { name: "record", pattern: /^\/records\/(\d+)$/, params: ["id"] },
  { name: "verification", pattern: /^\/verification$/ },
  { name: "rankings", pattern: /^\/rankings$/ },
  { name: "login", pattern: /^\/login$/ },
];

export function parseHash(hash = window.location.hash) {
  const path = hash.replace(/^#/, "") || "/home";
  for (const route of ROUTES) {
    const match = path.match(route.pattern);
    if (match) {
      const params = {};
      (route.params || []).forEach((key, index) => {
        params[key] = match[index + 1];
      });
      return { name: route.name, params, path };
    }
  }
  return { name: "home", params: {}, path: "/home" };
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (window.location.hash === target) return;
  if (replace) {
    window.history.replaceState(null, "", target);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = path;
  }
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash());
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
