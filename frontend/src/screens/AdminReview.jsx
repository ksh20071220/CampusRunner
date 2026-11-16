import { useEffect, useRef } from "react";

const reviewPage = new URL(`${import.meta.env.BASE_URL}verification-admin.html?embedded=1`, window.location.href);

export default function AdminReview({ session, onLogout }) {
  const frame = useRef(null);
  const sent = useRef(false);

  useEffect(() => {
    const receive = (event) => {
      if (event.origin === reviewPage.origin && event.source === frame.current?.contentWindow &&
          event.data?.type === "campusrunner:admin-logout") onLogout();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onLogout]);

  const connect = (event) => {
    const element = event.currentTarget;
    // The frame must still be on the exact review page when it receives the bearer.
    if (sent.current || element.contentDocument?.URL !== reviewPage.href) return;
    sent.current = true;
    element.contentWindow.postMessage({ type: "campusrunner:admin-session", session }, reviewPage.origin);
  };

  return <iframe ref={frame} className="admin-review-frame" src={reviewPage.href}
    title="CampusRunner 관리자 심사" onLoad={connect} />;
}
