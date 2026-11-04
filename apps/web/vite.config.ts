import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // changeOrigin stays false and xfwd stays off, so the orchestrator's dev guard sees a loopback Host and no forwarding headers.
      "/auth": { target: "http://127.0.0.1:8787", changeOrigin: false },
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: false },
    },
  },
});
