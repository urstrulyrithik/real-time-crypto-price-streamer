// backend/src/index.ts
// -----------------------------------------------------------------------------
// ConnectRPC server on http://localhost:4000 (matches your frontend transport).
// Adds CORS for http://localhost:3000 (Next.js). IMPORTANT: We do *not* set
// `allowedHeaders` so the middleware reflects request headers like
// `connect-protocol-version` used by ConnectRPC transport.
// Boots headed Playwright and mounts PriceService using a routes *callback*.
// -----------------------------------------------------------------------------

import http from "node:http";
import cors from "cors";

import { PriceService, priceServiceImpl, streamer } from "./price-service";

// Adapter: turns a Connect router (configured via callback) into a Node HTTP handler.
import { connectNodeAdapter } from "@connectrpc/connect-node";

// ----------------------------------------------------------------------------
// Build the Connect handler by giving the adapter a *routes callback*.
// We register the service descriptor + implementation inside this callback.
// ----------------------------------------------------------------------------
const handler = connectNodeAdapter({
  routes: (router) => {
    router.service(PriceService, priceServiceImpl);
  },
});

// ----------------------------------------------------------------------------
/**
 * CORS: allow Next.js at :3000.
 * Note: Do NOT set `allowedHeaders` here — leaving it undefined makes the
 * `cors` package reflect the browser’s Access-Control-Request-Headers, which
 * includes Connect’s custom headers (e.g., connect-protocol-version).
 */
// ----------------------------------------------------------------------------
const corsMiddleware = cors({
  origin: "http://localhost:3000",
  methods: ["GET", "POST", "OPTIONS"],
  // allowedHeaders: undefined, // reflect request headers automatically
  credentials: false,
});

// ----------------------------------------------------------------------------
// Compose CORS + Connect into a basic Node HTTP server.
// ----------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  corsMiddleware(req as any, res as any, () => {
    // Handle preflight quickly (some setups prefer explicit 204 here,
    // but the cors middleware already responds to OPTIONS)
    handler(req, res);
  });
});

// Listen on :4000 to match the browser requests to /price.PriceService/*.
const PORT = Number(process.env.PORT ?? 4000);

// ----------------------------------------------------------------------------
// Boot: ensure headed Playwright is started, then start HTTP server.
// ----------------------------------------------------------------------------
async function main() {
  await streamer.start(); // safe no-op if already running

  server.listen(PORT, () => {
    console.log(`🚀 [api] ConnectRPC server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("❌ [api] Fatal startup error:", err);
  process.exit(1);
});

// ----------------------------------------------------------------------------
// Graceful shutdown for Ctrl+C / SIGTERM.
// ----------------------------------------------------------------------------
async function shutdown() {
  console.log("🛑 [api] Shutting down…");
  server.close(() => {
    console.log("🧹 [api] HTTP server closed.");
  });
  await streamer.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
