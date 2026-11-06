import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const backendExamples = fileURLToPath(new URL("../backend/examples", import.meta.url));
const frontendRoot = fileURLToPath(new URL(".", import.meta.url));

const adminAssets = new Map([
  ["verification-admin.html", "text/html"],
  ["verification-admin.css", "text/css"],
  ["verification-admin.js", "text/javascript"],
]);
const readAdminAsset = name => readFileSync(`${backendExamples}/${name}`);

export default defineConfig({
  plugins: [react(), {
    name: "campusrunner-admin-page",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = request.url?.split("?")[0].slice(1);
        const type = adminAssets.get(name);
        if (!type || !["GET", "HEAD"].includes(request.method)) return next();
        response.setHeader("Content-Type", `${type}; charset=utf-8`);
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.end(request.method === "HEAD" ? undefined : readAdminAsset(name));
      });
    },
    generateBundle() {
      for (const name of adminAssets.keys()) {
        this.emitFile({ type: "asset", fileName: name, source: readAdminAsset(name) });
      }
    },
  }],
  resolve: {
    alias: {
      // 백엔드 담당이 관리하는 API 클라이언트를 복사하지 않고 그대로 사용한다.
      "@campus-api": `${backendExamples}/api-client.js`,
    },
  },
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    fs: { allow: [frontendRoot, backendExamples] },
  },
  preview: { host: "localhost", port: 5173, strictPort: true },
});
