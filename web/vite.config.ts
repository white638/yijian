import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3110" } },
  test: { environment: "jsdom", setupFiles: ["./tests/setup.ts"] },
});
