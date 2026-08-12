import { defineConfig } from "vite";

// Tauri expects a fixed dev port and no obfuscation in dev builds.
export default defineConfig({
  root: ".",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { port: 1420, strictPort: true },
  clearScreen: false,
});
