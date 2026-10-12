import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Mass Times Finder",
        short_name: "Mass Times",
        description: "Find the next Mass, confession or adoration near you. Data from MassTimes.org.",
        theme_color: "#8c2f39",
        background_color: "#f7f3ec",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/v1\//, /^\/mcp/],
        runtimeCaching: [
          { urlPattern: /\/v1\/churches\/[^/]+$/, handler: "StaleWhileRevalidate", options: { cacheName: "churches", expiration: { maxEntries: 200 } } },
          { urlPattern: /\/v1\//, handler: "NetworkFirst", options: { cacheName: "api", networkTimeoutSeconds: 6, expiration: { maxEntries: 100, maxAgeSeconds: 7 * 86400 } } },
          { urlPattern: /^https:\/\/tiles\.openfreemap\.org\//, handler: "CacheFirst", options: { cacheName: "tiles", expiration: { maxEntries: 800, maxAgeSeconds: 30 * 86400 } } },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  // MapLibre loads its web worker relative to its own module URL; pre-bundling breaks that.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  server: {
    port: 5173,
    proxy: { "/v1": "http://localhost:8790", "/mcp": "http://localhost:8790" },
  },
});
