import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_ORCHESTRATOR_PORT = "8787";

export default defineConfig(({ mode }) => {
  // The PORT prefix keeps the signing key in the same file out of reach of this config.
  const port = loadEnv(mode, REPO_ROOT, "PORT").PORT || DEFAULT_ORCHESTRATOR_PORT;
  const target = `http://127.0.0.1:${port}`;
  return {
    plugins: [react()],
    server: {
      proxy: {
        // changeOrigin stays false and xfwd stays off, so the orchestrator's dev guard sees a loopback Host and no forwarding headers.
        "/auth": { target, changeOrigin: false },
      },
    },
  };
});
