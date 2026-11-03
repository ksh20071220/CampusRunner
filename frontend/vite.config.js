import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const backendExamples = fileURLToPath(new URL("../backend/examples", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 백엔드 담당이 관리하는 API 클라이언트를 복사하지 않고 그대로 사용한다.
      "@campus-api": `${backendExamples}/api-client.js`,
    },
  },
  server: {
    host: true, // 같은 Wi-Fi의 휴대폰에서 PC IP로 접속할 수 있게 한다.
    port: 5173,
    strictPort: true,
    fs: { allow: [".."] },
  },
  preview: { host: true, port: 5173, strictPort: true },
});
