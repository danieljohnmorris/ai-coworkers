// Tiny HTTP endpoint that lets external events tell the coworker "wake up
// now, don't wait for the next tick". POST /wake sets a flag the main loop
// watches.
//
// Also serves:
//   - POST /webhook/*  — declarative webhooks loaded from role/WEBHOOKS.json
//                        (see webhooks_loader + webhook_router). Verifies
//                        signatures, filters payloads, and wakes the loop.
//   - GET  /metrics    — Prometheus text format (AIC-67), if enabled.
//
// Auth: optional shared secret via WAKE_SECRET env var. If unset AND no
// webhooks are configured AND metrics is disabled, the endpoint binds to
// 127.0.0.1 only — safe for local use.

import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { renderMetrics } from "./metrics.ts";
import { handleWebhookRequest } from "./webhook_router.ts";
import type { WebhookSpec } from "./webhooks_loader.ts";

export interface WakeFlag { flag: boolean }

export interface WakeServerOpts {
  secret?: string;                         // shared secret for /wake
  events?: DatabaseSync;                   // events.db for /metrics
  coworkerName?: string;                   // label for /metrics output
  metricsEnabled?: boolean;                // default false
  webhooks?: WebhookSpec[];                // declarative webhook specs
  onSensorInvalidate?: (name: string) => void;
  env?: Record<string, string | undefined>; // env used for webhook secretEnv lookup
}

export function startWakeServer(port: number, wake: WakeFlag, opts: string | WakeServerOpts = {}): Server {
  // Back-compat: caller can pass a bare secret string like the old signature.
  const cfg: WakeServerOpts = typeof opts === "string" ? { secret: opts } : opts;
  const secret = cfg.secret;
  const webhooks = cfg.webhooks ?? [];
  const env = cfg.env ?? process.env;

  const server = createServer(async (req, res) => {
    // GET /metrics — Prometheus scrape endpoint.
    if (req.method === "GET" && req.url?.startsWith("/metrics")) {
      if (!cfg.metricsEnabled || !cfg.events) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("metrics disabled (set METRICS_ENABLED=1 and start with events.db)");
        return;
      }
      const body = renderMetrics(cfg.events, cfg.coworkerName ?? "unknown");
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(body);
      return;
    }

    if (req.method !== "POST") { res.writeHead(404); res.end(); return; }

    // Declarative webhooks (/webhook/*).
    if (req.url?.startsWith("/webhook/")) {
      await handleWebhookRequest(req, res, webhooks, {
        onWake: () => { wake.flag = true; },
        ...(cfg.onSensorInvalidate ? { invalidateSensor: cfg.onSensorInvalidate } : {}),
      }, env);
      return;
    }

    if (!req.url?.startsWith("/wake")) { res.writeHead(404); res.end(); return; }
    if (secret) {
      const provided = req.headers["x-wake-secret"];
      if (provided !== secret) {
        res.writeHead(401); res.end("unauthorized"); return;
      }
    }
    wake.flag = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
  });
  // Bind to loopback only when nothing needs to be reachable from outside.
  const needsPublic = Boolean(secret) || webhooks.length > 0 || Boolean(cfg.metricsEnabled);
  const host = needsPublic ? "0.0.0.0" : "127.0.0.1";
  server.listen(port, host);
  return server;
}
