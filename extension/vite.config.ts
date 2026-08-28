import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const target = process.env.TABLOOM_BROWSER_TARGET ?? "chromium";

export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: false,
  plugins: [react()],
  define: { __TABLOOM_BROWSER_TARGET__: JSON.stringify(target) },
  build: {
    outDir: resolve(import.meta.dirname, `../dist-extension/${target}`),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "index.html") },
  },
});
