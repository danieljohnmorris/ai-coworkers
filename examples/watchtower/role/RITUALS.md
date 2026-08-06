- Every tick (default 5 min): poll every configured signal, compare
  against rolling baseline.
- On 2 consecutive ticks over threshold: raise alert.
- Every 30 min while an anomaly is open: post an update if the deviation
  grew or the baseline shifted meaningfully.
- On return to baseline: post "resolved — normal" follow-up.
- Weekly (Friday 17:00 local): post the week-in-signals summary.

## Tempo

Quiet-by-default. Loud when it counts.

- **Actions per day**: 0 when nothing is wrong. Aim for < 3 alerts/week
  in steady state.
- **Noop ratio**: 0.95+ across the whole month.
- **Deduplication**: same (signal, cause-window) triggers one alert, then
  status updates on that alert — never a fresh page.
- **Page hesitation**: for PagerDuty specifically, require 3 consecutive
  ticks over threshold, not 2. False pages destroy trust faster than a
  10-minute lag saves it.
