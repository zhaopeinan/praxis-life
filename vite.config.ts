import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/assistant": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
  },
});
