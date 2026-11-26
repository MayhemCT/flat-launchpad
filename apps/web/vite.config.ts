import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiOrigin = process.env.API_ORIGIN ?? "https://raidpass.dry-dust-1399.workers.dev";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  // The launch UI package lives outside this app, in the folder Flap's Launcher runtime takes as-is.
  resolve: { alias: { "@launcher-ui": fileURLToPath(new URL("../../flap-ui/raidpass-launcher", import.meta.url)) } },
  // The pages read the Pool Launch index from /api. Locally that is the live Worker, unless API_ORIGIN says otherwise.
  server: { fs: { allow: [repoRoot] }, proxy: { "/api": { target: apiOrigin, changeOrigin: true } } },
  preview: { proxy: { "/api": { target: apiOrigin, changeOrigin: true } } },
  build: { target: "es2022", sourcemap: false },
});
