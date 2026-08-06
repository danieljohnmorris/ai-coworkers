// Tiny HTTP endpoint that lets external events (Linear/Slack/GitHub webhooks
// via smee.io or a tunnel) tell the coworker "wake up now, don't wait for
// the next tick". POST /wake sets a flag the main loop watches.
//
// Auth: optional shared secret via WAKE_SECRET env var. If unset the endpoint
// binds to 127.0.0.1 only, which is safe for local use.
//
// One port per coworker (WAKE_PORT env). Multiple coworkers can each listen
// on their own port.

import { createServer, type Server } from "node:http";
import { handleLinearWebhookRequest } from "../adapters/linear_webhook.ts";

export interface WakeFlag { flag: boolean }

export function startWakeServer(port: number, wake: WakeFlag, secret?: string): Server {
  const server = createServer(async (req, res) => {
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
  // wake secret path OR the Linear webhook (its own HMAC secret) — need
  // the server reachable from outside.
  const host = secret || process.env.LINEAR_WEBHOOK_SECRET ? "0.0.0.0" : "127.0.0.1";
  server.listen(port, host);
  return server;
}
