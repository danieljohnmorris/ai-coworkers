import { describe, it, expect } from "vitest";
import { isInHours, describeHours, localWallClock, nextInHours, type WorkHoursConfig } from "./work_hours.ts";

// Use UTC as the canonical timezone for most tests so the wall-clock we
// assert on matches the UTC input timestamps directly.

describe("isInHours", () => {
  it("returns true when config is undefined", () => {
    expect(isInHours(undefined)).toBe(true);
  });

  it("returns true when config is set but has no restrictions", () => {
    expect(isInHours({ out_of_hours: "normal", timezone: "UTC" })).toBe(true);
  });

  describe("days-only restriction", () => {
    const cfg: WorkHoursConfig = {
      out_of_hours: "normal",
      timezone: "UTC",
      days: [1, 2, 3, 4, 5], // Mon-Fri
    };
    it("in on Monday", () => {
      // 2026-08-03 is a Monday.
      expect(isInHours(cfg, new Date("2026-08-03T10:00:00Z"))).toBe(true);
    });
    it("in on Friday", () => {
      // 2026-08-07 is a Friday.
      expect(isInHours(cfg, new Date("2026-08-07T23:59:00Z"))).toBe(true);
    });
    it("out on Saturday", () => {
      expect(isInHours(cfg, new Date("2026-08-08T10:00:00Z"))).toBe(false);
    });
    it("out on Sunday", () => {
      expect(isInHours(cfg, new Date("2026-08-09T10:00:00Z"))).toBe(false);
    });
  });

  describe("hours-only restriction", () => {
    const cfg: WorkHoursConfig = {
      out_of_hours: "normal",
      timezone: "UTC",
      start: "09:00",
      end: "18:00",
    };
    it("in at 09:00 exact", () => {
      expect(isInHours(cfg, new Date("2026-08-05T09:00:00Z"))).toBe(true);
    });
    it("out at 08:59", () => {
      expect(isInHours(cfg, new Date("2026-08-05T08:59:00Z"))).toBe(false);
    });
    it("out at 18:00 exact (end is exclusive)", () => {
      expect(isInHours(cfg, new Date("2026-08-05T18:00:00Z"))).toBe(false);
    });
    it("in at 17:59", () => {
      expect(isInHours(cfg, new Date("2026-08-05T17:59:00Z"))).toBe(true);
    });
    it("out at 18:01", () => {
      expect(isInHours(cfg, new Date("2026-08-05T18:01:00Z"))).toBe(false);
    });
  });

  describe("combined days + hours", () => {
    const cfg: WorkHoursConfig = {
      out_of_hours: "normal",
      timezone: "UTC",
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "18:00",
    };
    it("in Weds 12:00", () => {
      expect(isInHours(cfg, new Date("2026-08-05T12:00:00Z"))).toBe(true);
    });
    it("out Weds 20:00", () => {
      expect(isInHours(cfg, new Date("2026-08-05T20:00:00Z"))).toBe(false);
    });
    it("out Sat 12:00", () => {
      expect(isInHours(cfg, new Date("2026-08-08T12:00:00Z"))).toBe(false);
    });
  });

  describe("spanning midnight", () => {
    const cfg: WorkHoursConfig = {
      out_of_hours: "normal",
      timezone: "UTC",
      start: "22:00",
      end: "06:00",
    };
    it("in at 23:00", () => {
      expect(isInHours(cfg, new Date("2026-08-05T23:00:00Z"))).toBe(true);
    });
    it("in at 05:00", () => {
      expect(isInHours(cfg, new Date("2026-08-05T05:00:00Z"))).toBe(true);
    });
    it("out at 12:00", () => {
      expect(isInHours(cfg, new Date("2026-08-05T12:00:00Z"))).toBe(false);
    });
    it("out at 06:00 exact (end exclusive)", () => {
      expect(isInHours(cfg, new Date("2026-08-05T06:00:00Z"))).toBe(false);
    });
    it("in at 22:00 exact", () => {
      expect(isInHours(cfg, new Date("2026-08-05T22:00:00Z"))).toBe(true);
    });
  });

  it("zero-length window is never in-hours", () => {
    const cfg: WorkHoursConfig = { out_of_hours: "normal", timezone: "UTC", start: "09:00", end: "09:00" };
    expect(isInHours(cfg, new Date("2026-08-05T09:00:00Z"))).toBe(false);
  });

  describe("timezone conversion", () => {
    // A fixed absolute time — prove that different TZs give different
    // wall-clocks and hence different in-hours answers.
    const cfg = (timezone: string): WorkHoursConfig => ({
      out_of_hours: "normal",
      timezone,
      start: "09:00",
      end: "18:00",
    });
    it("15:00 UTC is in-hours in Europe/London (16:00 BST)", () => {
      // In August, London is BST (+01:00).
      expect(isInHours(cfg("Europe/London"), new Date("2026-08-05T15:00:00Z"))).toBe(true);
    });
    it("15:00 UTC is out-of-hours in Asia/Tokyo (00:00 JST next day)", () => {
      expect(isInHours(cfg("Asia/Tokyo"), new Date("2026-08-05T15:00:00Z"))).toBe(false);
    });
    it("00:30 UTC is in-hours in Asia/Tokyo (09:30 JST)", () => {
      expect(isInHours(cfg("Asia/Tokyo"), new Date("2026-08-05T00:30:00Z"))).toBe(true);
    });
  });
});

describe("localWallClock", () => {
  it("returns correct weekday and minutes in UTC", () => {
    // 2026-08-05 is a Wednesday → ISO weekday 3.
    const wc = localWallClock(new Date("2026-08-05T14:30:00Z"), "UTC");
    expect(wc.weekday).toBe(3);
    expect(wc.minutes).toBe(14 * 60 + 30);
  });
});

describe("describeHours", () => {
  it("describes undefined as 24/7", () => {
    expect(describeHours(undefined)).toBe("24/7");
  });
  it("describes Mon-Fri contiguous run as a range", () => {
    expect(
      describeHours({
        out_of_hours: "webhook_only",
        timezone: "Europe/London",
        days: [1, 2, 3, 4, 5],
        start: "09:00",
        end: "18:00",
      }),
    ).toBe("Mon-Fri 09:00-18:00 Europe/London (out-of-hours: webhook_only)");
  });
  it("describes non-contiguous days as a comma list", () => {
    expect(
      describeHours({
        out_of_hours: "reduced",
        timezone: "UTC",
        days: [1, 3, 5],
      }),
    ).toBe("Mon,Wed,Fri any time UTC (out-of-hours: reduced)");
  });
  it("describes empty days as every day", () => {
    expect(
      describeHours({ out_of_hours: "normal", timezone: "UTC" }),
    ).toContain("every day");
  });
});

describe("nextInHours", () => {
  it("returns null when config is undefined", () => {
    expect(nextInHours(undefined)).toBeNull();
  });
  it("returns now (approximately) when currently in-hours", () => {
    const cfg: WorkHoursConfig = { out_of_hours: "normal", timezone: "UTC", start: "09:00", end: "18:00" };
    const now = new Date("2026-08-05T12:00:00Z");
    expect(nextInHours(cfg, now)).toEqual(now);
  });
  it("finds the next in-hours slot after an out-of-hours moment", () => {
    const cfg: WorkHoursConfig = {
      out_of_hours: "webhook_only",
      timezone: "UTC",
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "18:00",
    };
    // Sat 2026-08-08 12:00 UTC — next slot is Mon 2026-08-10 09:00 UTC.
    const t = nextInHours(cfg, new Date("2026-08-08T12:00:00Z"));
    expect(t).not.toBeNull();
    expect(t!.toISOString()).toBe("2026-08-10T09:00:00.000Z");
  });

  describe("narrow window (W3 regression)", () => {
    const narrow: WorkHoursConfig = {
      out_of_hours: "webhook_only",
      timezone: "UTC",
      start: "09:00",
      end: "09:10",
    };

    it("in-hours at 09:05 with a 10-minute window", () => {
      // Note: 09:05 is inside 09:00-09:10 → nextInHours returns now.
      const now = new Date("2026-08-05T09:05:00Z");
      expect(nextInHours(narrow, now)!.toISOString()).toBe(now.toISOString());
    });

    it("out at 09:11 finds tomorrow 09:00, not later same day", () => {
      // A 15-minute scan starting from 09:11 would step to 09:26 and never
      // hit the 09:00-09:10 slot. The boundary-snap strategy jumps to
      // tomorrow 09:00.
      const t = nextInHours(narrow, new Date("2026-08-05T09:11:00Z"));
      expect(t).not.toBeNull();
      expect(t!.toISOString()).toBe("2026-08-06T09:00:00.000Z");
    });

    it("out at 09:11 with weekday restriction skips to next allowed day", () => {
      // 2026-08-07 is Friday. Mon-Fri only. Next allowed 09:00 is Mon 2026-08-10.
      const wkCfg: WorkHoursConfig = { ...narrow, days: [1, 2, 3, 4, 5] };
      const t = nextInHours(wkCfg, new Date("2026-08-07T09:11:00Z"));
      expect(t).not.toBeNull();
      expect(t!.toISOString()).toBe("2026-08-10T09:00:00.000Z");
    });
  });

  it("spanning-midnight window returns now when currently inside overnight period", () => {
    const cfg: WorkHoursConfig = {
      out_of_hours: "webhook_only",
      timezone: "UTC",
      start: "22:00",
      end: "06:00",
    };
    // 02:00 UTC is inside the 22:00-06:00 spanning-midnight window.
    const now = new Date("2026-08-05T02:00:00Z");
    expect(nextInHours(cfg, now)!.toISOString()).toBe(now.toISOString());
  });
});
