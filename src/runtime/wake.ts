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

export interface WakeFlag { flag: boolean }

export function startWakeServer(port: number, wake: WakeFlag, secret?: string): Server {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/wake")) {
      res.writeHead(404); res.end(); return;
    }
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
  // Bind to loopback only when no secret is set.
  const host = secret ? "0.0.0.0" : "127.0.0.1";
  server.listen(port, host);
  return server;
}
