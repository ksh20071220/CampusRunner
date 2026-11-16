// 휴대폰 실기기 테스트 전용 설정. phone-test.ps1이 사용한다 (자세한 안내: PHONE_TEST_KO.md).
// 기본 vite.config.js에 더해: Cloudflare 터널 주소 허용, /api와 /health를 내 PC의 C 서버로 전달.
// 이렇게 하면 휴대폰은 HTTPS 주소 하나로 화면과 서버를 모두 쓴다.
import { mergeConfig } from "vite";
import base from "./vite.config.js";

export default mergeConfig(base, {
  server: {
    allowedHosts: [".trycloudflare.com"],
    hmr: false,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/health": "http://127.0.0.1:8080",
    },
  },
});
