import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { svelte } from "@sveltejs/vite-plugin-svelte";
export default defineConfig({
  plugins: [react(), svelte(), cloudflare()],
  // Svelte Flow is browser-only; prevent its dependency scan from marking
  // Node externals on the Cloudflare Worker environment during development.
  ssr: { noExternal: true },
  server: { host: "0.0.0.0", port: 5173 },
});
