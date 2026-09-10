import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
export default defineConfig(({ mode }) => {
  const edition =
    loadEnv(mode, ".", "VITE_").VITE_EDITION ||
    (mode === "online" ? "online" : "local");
  return {
    plugins: [react()],
    define: { "import.meta.env.VITE_EDITION": JSON.stringify(edition) },
    build: { outDir: edition === "online" ? "dist-online" : "dist" },
    server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3110" } },
    test: { environment: "jsdom", setupFiles: ["./tests/setup.ts"] },
  };
});
