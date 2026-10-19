import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), svelte(), tailwindcss()],
  base: "/workers-chat/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: { host: "0.0.0.0", port: 5173 },
});
