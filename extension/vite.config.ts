import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "../dist-extension"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "index.html") },
  },
});
