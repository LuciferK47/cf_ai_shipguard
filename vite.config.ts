import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import agents from "agents/vite";

// `npm run dev:offline` swaps Workers AI for a local stand-in (dev/offline) so the
// app runs without a Cloudflare login. Everything else is the normal app.
const offline = process.env.SHIPGUARD_OFFLINE === "1";

export default defineConfig({
  plugins: [
    agents(),
    react(),
    cloudflare(
      offline
        ? {
            configPath: "./dev/offline/wrangler.jsonc",
            auxiliaryWorkers: [
              { configPath: "./dev/offline/ai/wrangler.jsonc" }
            ]
          }
        : {}
    ),
    tailwindcss()
  ]
});
