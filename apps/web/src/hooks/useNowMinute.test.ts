import { describe, expect, it } from "vite-plus/test";

import { nowMinuteIso } from "./useNowMinute";

describe("nowMinuteIso", () => {
  it("reads the minute clock as UTC, not local time", () => {
    const iso = nowMinuteIso("2026-09-29T23:30");
    expect(iso).toBe("2026-09-29T23:30:00.000Z");
    expect(Date.parse(iso)).toBe(Date.UTC(2026, 8, 29, 23, 30));
  });
});
