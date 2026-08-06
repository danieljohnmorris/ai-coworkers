import { describe, it, expect } from "vitest";
import { dispatchLinearWebhook } from "./linear_webhook.ts";
import { createHmac } from "node:crypto";

const SECRET = "shhh";
const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

function body(payload: unknown): Buffer { return Buffer.from(JSON.stringify(payload), "utf8"); }

describe("dispatchLinearWebhook", () => {
  it("rejects requests without a signature header", () => {
    const wakes: string[] = [];
    const r = dispatchLinearWebhook(body({ action: "create" }), {}, {
      secret: SECRET, onWake: (rsn) => wakes.push(rsn),
    });
    expect(r.status).toBe(401);
    expect(wakes).toEqual([]);
  });

  it("rejects requests with a bad signature", () => {
    const raw = body({ action: "create", type: "Issue", data: { team: { key: "ILO" } } });
    const r = dispatchLinearWebhook(raw, { "linear-signature": "0".repeat(64) }, {
      secret: SECRET, onWake: () => {},
    });
    expect(r.status).toBe(401);
  });

  it("wakes on a valid signature when no team filter is set", () => {
    const raw = body({ action: "create", type: "Issue", data: { team: { key: "ILO" } } });
    const wakes: string[] = [];
    const r = dispatchLinearWebhook(raw, { "linear-signature": sign(raw.toString("utf8")) }, {
      secret: SECRET, onWake: (rsn) => wakes.push(rsn),
    });
    expect(r.status).toBe(200);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("linear:create:ILO:Issue");
  });

  it("wakes only for events whose team is in watchedTeams", () => {
    const iloRaw = body({ action: "update", type: "Issue", data: { team: { key: "ILO" } } });
    const csRaw = body({ action: "update", type: "Issue", data: { team: { key: "CS" } } });
    const wakes: string[] = [];
    const opts = { secret: SECRET, watchedTeams: ["ILO"], onWake: (rsn: string) => wakes.push(rsn) };

    const rIlo = dispatchLinearWebhook(iloRaw, { "linear-signature": sign(iloRaw.toString("utf8")) }, opts);
    const rCs = dispatchLinearWebhook(csRaw, { "linear-signature": sign(csRaw.toString("utf8")) }, opts);

    expect(rIlo.status).toBe(200);
    expect(rCs.status).toBe(202);
    expect(rCs.body.reason).toMatch(/not watched/);
    expect(wakes).toHaveLength(1);
  });

  it("400s on well-signed but malformed JSON", () => {
    const raw = Buffer.from("{not json,", "utf8");
    const r = dispatchLinearWebhook(raw, { "linear-signature": sign(raw.toString("utf8")) }, {
      secret: SECRET, onWake: () => {},
    });
    expect(r.status).toBe(400);
  });

  it("extracts team key from data.issue.team.key for Comment events", () => {
    const raw = body({ action: "create", type: "Comment", data: { issue: { team: { key: "AIC" } } } });
    const wakes: string[] = [];
    const r = dispatchLinearWebhook(raw, { "linear-signature": sign(raw.toString("utf8")) }, {
      secret: SECRET, watchedTeams: ["AIC"], onWake: (rsn) => wakes.push(rsn),
    });
    expect(r.status).toBe(200);
    expect(wakes[0]).toContain("AIC");
  });
});
