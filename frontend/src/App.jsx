import { useEffect } from "react";
import { useApp, useTrackerSnapshot } from "./state/AppContext.jsx";
import { navigate, useRoute } from "./lib/router.js";
import { duration, km } from "./lib/format.js";
import { BottomNav, Spinner } from "./components/ui.jsx";
import Login from "./screens/Login.jsx";
import Home from "./screens/Home.jsx";
import Run from "./screens/Run.jsx";
import Result from "./screens/Result.jsx";
import Records from "./screens/Records.jsx";
import RecordDetail from "./screens/RecordDetail.jsx";
import Verification from "./screens/Verification.jsx";
import Rankings from "./screens/Rankings.jsx";

export default function App() {
  const { user, authChecked, saver } = useApp();
  const route = useRoute();
  const snapshot = useTrackerSnapshot();
  const running = snapshot.status === "running" || snapshot.status === "starting";

  // 로그인 상태에 맞게 주소 정리
  useEffect(() => {
    if (!authChecked) return;
    if (!user && route.name !== "login") navigate("/login", { replace: true });
    if (user && route.name === "login") navigate(saver.getState().pending ? "/result" : "/home", { replace: true });
  }, [user, authChecked, route.name, saver]);

  if (!authChecked) {
    return (
      <div className="app">
        <Spinner label="로그인 확인 중" />
      </div>
    );
  }
  if (!user) {
    return (
      <div className="app">
        <Login />
      </div>
    );
  }

  const hideNav = route.name === "login" || (route.name === "run" && running);

  return (
    <div className={`app ${hideNav ? "" : "app--with-nav"}`}>
      {running && route.name !== "run" && <RunningBar snapshot={snapshot} />}
      <Screen route={route} />
      {!hideNav && <BottomNav active={route.name} />}
    </div>
  );
}

function Screen({ route }) {
  switch (route.name) {
    case "run":
      return <Run />;
    case "result":
      return <Result />;
    case "records":
      return <Records />;
    case "record":
      return <RecordDetail id={route.params.id} />;
    case "verification":
      return <Verification />;
    case "rankings":
      return <Rankings />;
    default:
      return <Home />;
  }
}

/** 러닝 중 다른 화면을 볼 때 상단에 떠 있는 진행 표시. 측정은 계속된다. */
function RunningBar({ snapshot }) {
  return (
    <button type="button" className="running-bar" onClick={() => navigate("/run")}>
      <span className="pulse" aria-hidden="true" />
      <span>러닝 중</span>
      <b>{km(snapshot.distanceMeters)}km</b>
      <b>{duration(snapshot.elapsedSeconds)}</b>
      <span className="running-bar__go">돌아가기 ›</span>
    </button>
  );
}
