import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  // The launch UI package lives outside this app, in the folder Flap's Launcher runtime takes as-is.
  resolve: { alias: { "@launcher-ui": fileURLToPath(new URL("../../flap-ui/raidpass-launcher", import.meta.url)) } },
  server: { fs: { allow: [repoRoot] } },
  build: { target: "es2022", sourcemap: false },
});
