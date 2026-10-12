import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixStartTime, matchKey, normalizeChurch, parseDays, parseLastUpdate, parseTime } from "../src/masstimes";

const fixture = JSON.parse(readFileSync("test/fixtures/normalize-parity.json", "utf8"));

describe("TS normalizer matches sync/normalize.py", () => {
  it("produces identical records for the sample churches", () => {
    fixture.raw.forEach((raw: Record<string, unknown>, i: number) => {
      const ts = normalizeChurch(raw);
      expect(ts).toEqual(fixture.expected[i]);
    });
  });
});

describe("helpers", () => {
  it("parses times", () => {
    expect(parseTime("09:00:00")).toBe("09:00");
    expect(parseTime("")).toBeNull();
    expect(parseTime("1/1/1900 5:00:00 PM")).toBe("17:00");
    expect(parseTime("1/1/1900 12:30:00 AM")).toBe("00:30");
  });
  it("parses days", () => {
    expect(parseDays("Weekdays  ")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays(null)).toEqual([]);
    expect(parseDays("99")).toEqual([]);
  });
  it("fixes source time quirks", () => {
    expect(fixStartTime("00:00", "confession")).toBeNull();
    expect(fixStartTime("00:40", "confession")).toBe("12:40");
    expect(fixStartTime("00:05", "adoration")).toBe("00:05");
    expect(fixStartTime("07:30", "mass")).toBe("07:30");
  });
  it("parses last_update and builds match keys like Python", () => {
    expect(parseLastUpdate("8/19/2026 7:42:16 AM")).toBe("2026-08-19T07:42:16");
    expect(parseLastUpdate("10/23/2024 5:37:54 PM")).toBe("2024-10-23T17:37:54");
    expect(matchKey("Curé of Ars", 40.6612169, -73.5505951)).toBe("cure ars|40.661|-73.551");
    expect(matchKey("Ss. Joachim and Anne", 40.7, -73.7)).toBe("st joachim and anne|40.700|-73.700");
  });
});
