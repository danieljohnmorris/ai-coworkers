// Tiny HTTP endpoint that lets external events (Linear/Slack/GitHub webhooks
// via smee.io or a tunnel) tell the coworker "wake up now, don't wait for
// the next tick". POST /wake sets a flag the main loop watches.
//
// Also serves:
//   - POST /linear-webhook — HMAC-verified Linear webhook (AIC-36)
//   - GET  /metrics       — Prometheus text format (AIC-67), if enabled
//
// Auth: optional shared secret via WAKE_SECRET env var. If unset the endpoint
// binds to 127.0.0.1 only, which is safe for local use.
//
// One port per coworker (WAKE_PORT env). Multiple coworkers can each listen
// on their own port.

import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { handleLinearWebhookRequest } from "../adapters/linear_webhook.ts";
import { renderMetrics } from "./metrics.ts";

export interface WakeFlag { flag: boolean }

export interface WakeServerOpts {
  secret?: string;                 // shared secret for /wake
  events?: DatabaseSync;           // events.db for /metrics — required if metricsEnabled
  coworkerName?: string;           // label for /metrics output
  metricsEnabled?: boolean;        // default false; set from METRICS_ENABLED env
}

export function startWakeServer(port: number, wake: WakeFlag, opts: string | WakeServerOpts = {}): Server {
  // Back-compat: caller can pass a bare secret string like the old signature.
  const cfg: WakeServerOpts = typeof opts === "string" ? { secret: opts } : opts;
  const secret = cfg.secret;

  const server = createServer(async (req, res) => {
    // GET /metrics — AIC-67. Prometheus scrape endpoint. Public if enabled;
    // scraper typically lives on the same host or a private network.
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

    // AIC-36 — Linear webhook adapter. When LINEAR_WEBHOOK_SECRET is set,
    // POST /linear-webhook verifies the HMAC signature, filters events
    // by LINEAR_WATCHED_TEAMS, and wakes the loop on matching events.
    if (req.url?.startsWith("/linear-webhook")) {
      const linearSecret = process.env.LINEAR_WEBHOOK_SECRET;
      if (!linearSecret) {
        res.writeHead(503); res.end("LINEAR_WEBHOOK_SECRET not configured"); return;
      }
      const watched = (process.env.LINEAR_WATCHED_TEAMS ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      await handleLinearWebhookRequest(req, res, {
        secret: linearSecret,
        watchedTeams: watched.length ? watched : undefined,
        onWake: () => { wake.flag = true; },
      });
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
  // Bind to loopback only when no secret is set. Public endpoints — the
  // wake secret path, the Linear webhook (its own HMAC secret), or the
  // metrics endpoint — need the server reachable from outside.
  const host = secret || process.env.LINEAR_WEBHOOK_SECRET || cfg.metricsEnabled ? "0.0.0.0" : "127.0.0.1";
  server.listen(port, host);
  return server;
}
