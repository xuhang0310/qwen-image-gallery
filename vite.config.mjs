import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import config from "./shared/config.json" with { type: "json" };
export default defineConfig({
  plugins: [vue()],
  publicDir: false,
  server: {
    host: "127.0.0.1",
    proxy: { "/api": `http://127.0.0.1:${process.env.PORT || config.port}` },
  },
  build: { outDir: "dist", sourcemap: true },
});
