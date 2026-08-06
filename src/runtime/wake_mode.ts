// WAKE_MODE — per-coworker activity source.
//
//   tick    — periodic tick loop only; wake HTTP server NOT started. Classic
//             polling. Safe on hosts with no inbound network reachability.
//   webhook — wake HTTP server only; periodic tick loop is effectively
//             disabled (interval pinned very high). Ticks fire on wake
//             events, startup, or when a ritual/promise happens to be due
//             at the moment a wake comes in. Cheapest steady state; blind
//             if webhooks stop being delivered.
//   both    — default. Both scheduled ticks AND wake server. Belt-and-
//             suspenders.

export type WakeMode = "tick" | "webhook" | "both";

export interface WakeModeParse {
  mode: WakeMode;
  warning?: string;   // set when the raw value was present but unrecognized
}

export function parseWakeMode(raw: string | undefined): WakeModeParse {
  if (raw === undefined || raw === "") return { mode: "both" };
  const lowered = raw.toLowerCase();
  if (lowered === "tick" || lowered === "webhook" || lowered === "both") {
    return { mode: lowered };
  }
  return {
    mode: "both",
    warning: `WAKE_MODE=${raw} unrecognized — falling back to "both"`,
  };
}
