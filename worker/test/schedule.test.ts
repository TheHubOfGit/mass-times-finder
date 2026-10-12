import { describe, expect, it } from "vitest";
import { easter, expandSchedule, holyDayList, holyDays, type Service, zonedTimeToUtc } from "../src/schedule";

const NY = "America/New_York";

function svc(over: Partial<Service>): Service {
  return {
    kind: "mass", source_type: "Weekend", days: [0], start: "09:00", end: null, language: null,
    comment: null, perpetual: false, holy_day: false, vigil: false, ...over,
  };
}

describe("time zones", () => {
  it("converts New York wall time to UTC across DST", () => {
    expect(zonedTimeToUtc(2026, 10, 18, 9, 0, NY).toISOString()).toBe("2026-10-18T13:00:00.000Z"); // EDT
    expect(zonedTimeToUtc(2026, 12, 20, 9, 0, NY).toISOString()).toBe("2026-12-20T14:00:00.000Z"); // EST
  });

  it("works for other zones", () => {
    expect(zonedTimeToUtc(2026, 10, 18, 9, 0, "America/Los_Angeles").toISOString()).toBe("2026-10-18T16:00:00.000Z");
  });

  it("keeps the same wall time on the day DST ends (Nov 1, 2026)", () => {
    const occ = expandSchedule([svc({ days: [0], start: "11:00" })], NY, { from: new Date("2026-10-31T12:00:00Z"), days: 2 });
    expect(occ[0].localDate).toBe("2026-11-01");
    expect(occ[0].start.toISOString()).toBe("2026-11-01T16:00:00.000Z"); // 11:00 EST
  });
});

describe("holy days", () => {
  it("computes Easter", () => {
    expect(easter(2026)).toBe("2026-04-05");
    expect(easter(2027)).toBe("2027-03-28");
  });

  it("lists US holy days and moves Immaculate Conception off Sunday", () => {
    const h2026 = holyDays(2026);
    expect([...h2026.keys()].sort()).toEqual(["2026-01-01", "2026-08-15", "2026-11-01", "2026-12-08", "2026-12-25"]);
    expect(holyDays(2024).has("2024-12-09")).toBe(true); // Dec 8, 2024 was a Sunday
    expect(holyDays(2026, true).get("2026-05-14")).toBe("Ascension");
  });
});

describe("expandSchedule", () => {
  // Monday, Oct 12, 2026, 10:00 New York time
  const monday10am = new Date("2026-10-12T14:00:00Z");

  it("expands Weekdays into Monday–Friday and skips past times", () => {
    const occ = expandSchedule([svc({ source_type: "Week Days", days: [1, 2, 3, 4, 5], start: "09:00" })], NY, { from: monday10am, days: 6 });
    expect(occ.map((o) => o.localDate)).toEqual(["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
  });

  it("sorts by start across services", () => {
    const occ = expandSchedule(
      [svc({ days: [1], start: "19:30" }), svc({ days: [1], start: "12:00" })], NY, { from: monday10am, days: 0 },
    );
    expect(occ.map((o) => o.localStart)).toEqual(["12:00", "19:30"]);
  });

  it("marks a confession in progress when it started before `from` but hasn't ended", () => {
    const occ = expandSchedule([svc({ kind: "confession", days: [1], start: "09:30", end: "10:30" })], NY, { from: monday10am, days: 0 });
    expect(occ).toHaveLength(1);
    expect(occ[0].inProgress).toBe(true);
  });

  it("handles adoration that runs past midnight", () => {
    const from = new Date("2026-10-17T04:30:00Z"); // Sat 00:30 local
    const occ = expandSchedule([svc({ kind: "adoration", days: [5], start: "21:00", end: "01:00" })], NY, { from, days: 0 });
    expect(occ[0].inProgress).toBe(true);
    expect(occ[0].localDate).toBe("2026-10-16");
    expect(occ[0].end?.toISOString()).toBe("2026-10-17T05:00:00.000Z");
  });

  it("shows a Mass at 00:40 just after midnight on the right day", () => {
    const occ = expandSchedule([svc({ days: [2], start: "00:40" })], NY, { from: monday10am, days: 2 });
    expect(occ[0].localDate).toBe("2026-10-13");
    expect(occ[0].start.toISOString()).toBe("2026-10-13T04:40:00.000Z");
  });

  it("only schedules Holy Days rows on holy days, and vigils the evening before", () => {
    const services = [
      svc({ source_type: "Holy Days", holy_day: true, days: [1, 2, 3, 4, 5], start: "09:00" }),
      svc({ source_type: "Vigil for Holy Days", holy_day: true, vigil: true, days: [1, 2, 3, 4, 5], start: "17:00" }),
    ];
    // All Saints 2026 is a Sunday, so weekday-only holy-day rows don't apply.
    expect(expandSchedule(services, NY, { from: new Date("2026-10-26T12:00:00Z"), days: 7 })).toHaveLength(0);
    // Immaculate Conception 2026: Tuesday Dec 8. Vigil Monday Dec 7 at 17:00, Mass Tuesday at 09:00.
    const occ = expandSchedule(services, NY, { from: new Date("2026-12-07T12:00:00Z"), days: 3 });
    expect(occ.map((o) => [o.localDate, o.localStart, o.holyDay])).toEqual([
      ["2026-12-07", "17:00", "Immaculate Conception"],
      ["2026-12-08", "09:00", "Immaculate Conception"],
    ]);
  });

  it("skips perpetual adoration and untimed entries", () => {
    const occ = expandSchedule(
      [svc({ kind: "adoration", perpetual: true, days: [], start: null }), svc({ days: [], start: "10:00" })],
      NY, { from: monday10am },
    );
    expect(occ).toHaveLength(0);
  });

  it("filters by kind and by language, falling back to the church language", () => {
    const services = [
      svc({ days: [1], start: "12:00", language: "Spanish" }),
      svc({ days: [1], start: "17:00" }),
      svc({ kind: "confession", days: [1], start: "18:00", end: "19:00" }),
    ];
    const opts = { from: monday10am, days: 0 };
    expect(expandSchedule(services, NY, { ...opts, kinds: ["confession"] })).toHaveLength(1);
    expect(expandSchedule(services, NY, { ...opts, language: "spanish", churchLanguage: "English" })).toHaveLength(1);
    expect(expandSchedule(services, NY, { ...opts, kinds: ["mass"], language: "English", churchLanguage: "English" })
      .map((o) => o.localStart)).toEqual(["17:00"]);
  });

  it("flags occurrences with free-text notes as seasonal", () => {
    const occ = expandSchedule([svc({ days: [0], start: "10:00", comment: "mid-September to mid-June only" })], NY, { from: monday10am });
    expect(occ[0].seasonal).toBe(true);
  });
});

describe("holy day obligations (US)", () => {
  const find = (from: string, to: string, name: string) => holyDayList(from, to).find((h) => h.name === name)!;
  it("lifts the obligation for Jan 1 / Aug 15 / Nov 1 on Saturday or Monday", () => {
    expect(find("2028-01-01", "2028-01-01", "Mary, Mother of God").obligatory).toBe(false); // Saturday
    expect(find("2022-08-15", "2022-08-15", "Assumption of Mary").obligatory).toBe(false); // Monday
    expect(find("2025-08-15", "2025-08-15", "Assumption of Mary").obligatory).toBe(true); // Friday
  });
  it("marks a transferred Immaculate Conception as not obligatory, and Christmas always obligatory", () => {
    expect(find("2024-12-01", "2024-12-31", "Immaculate Conception")).toMatchObject({ date: "2024-12-09", obligatory: false });
    expect(find("2026-12-01", "2026-12-31", "Immaculate Conception")).toMatchObject({ date: "2026-12-08", obligatory: true });
    expect(find("2027-12-25", "2027-12-25", "Christmas")).toMatchObject({ obligatory: true, onSunday: false });
  });
  it("flags holy days that fall on Sunday", () => {
    expect(find("2026-11-01", "2026-11-01", "All Saints").onSunday).toBe(true);
  });
});

describe("holy-day schedule replaces the weekday schedule", () => {
  const services: Service[] = [
    { kind: "mass", source_type: "Week Days", days: [1, 2, 3, 4, 5], start: "08:00", end: null, language: null, comment: null, perpetual: false, holy_day: false, vigil: false },
    { kind: "mass", source_type: "Holy Days", days: [1, 2, 3, 4, 5], start: "07:00", end: null, language: null, comment: null, perpetual: false, holy_day: true, vigil: false },
    { kind: "mass", source_type: "Holy Days", days: [1, 2, 3, 4, 5], start: "19:30", end: null, language: null, comment: null, perpetual: false, holy_day: true, vigil: false },
    { kind: "confession", source_type: "Confessions", days: [2], start: "17:00", end: "18:00", language: null, comment: null, perpetual: false, holy_day: false, vigil: false },
  ];
  it("shows holy-day Masses (not the 8:00 weekday Mass) on Dec 8, 2026, and keeps confessions", () => {
    const occ = expandSchedule(services, "America/New_York", { from: new Date("2026-12-08T05:00:00Z"), days: 0, kinds: ["mass", "confession"] });
    expect(occ.map((o) => `${o.service.kind}@${o.localStart}`)).toEqual(["mass@07:00", "confession@17:00", "mass@19:30"]);
  });
  it("keeps the weekday Mass on ordinary days", () => {
    const occ = expandSchedule(services, "America/New_York", { from: new Date("2026-12-09T05:00:00Z"), days: 0, kinds: ["mass"] });
    expect(occ.map((o) => o.localStart)).toEqual(["08:00"]);
  });
});

describe("special days and parish notes", () => {
  const NY = "America/New_York";
  const svc = (over: Partial<Service>): Service => ({
    kind: "mass", source_type: "Week Days", days: [1, 2, 3, 4, 5], start: "08:00", end: null, language: null,
    comment: null, perpetual: false, holy_day: false, vigil: false, ...over,
  });

  it("Good Friday and Holy Thursday: no regular weekday Masses; confession stays (flagged)", () => {
    // Holy Week 2027: Holy Thursday Mar 25, Good Friday Mar 26
    const services = [svc({}), svc({ kind: "confession", source_type: "Confessions", days: [5], start: "15:00", end: "16:00" })];
    const occ = expandSchedule(services, NY, { from: new Date("2027-03-25T04:00:00Z"), days: 1, kinds: ["mass", "confession"] });
    expect(occ.map((o) => `${o.localDate} ${o.service.kind}`)).toEqual(["2027-03-26 confession"]);
    expect(occ[0]).toMatchObject({ specialDay: "Good Friday", regularSchedule: true });
  });

  it("Christmas: regular weekday Masses flagged, holy-day Masses not", () => {
    const services = [svc({ days: [1, 2, 3, 4, 5], start: "08:00" }), svc({ source_type: "Holy Days", holy_day: true, start: "10:00" })];
    // This church lists holy-day Masses, so its 8:00 weekday Mass is replaced on Christmas.
    const withHoly = expandSchedule(services, NY, { from: new Date("2026-12-25T05:00:00Z"), days: 0, kinds: ["mass"] });
    expect(withHoly.map((o) => [o.localStart, o.specialDay, o.regularSchedule])).toEqual([["10:00", "Christmas", false]]);
    // A church without holy-day Masses keeps its weekday Mass, flagged as regular schedule.
    const without = expandSchedule([services[0]], NY, { from: new Date("2026-12-25T05:00:00Z"), days: 0, kinds: ["mass"] });
    expect(without.map((o) => [o.localStart, o.specialDay, o.regularSchedule])).toEqual([["08:00", "Christmas", true]]);
  });

  it("ordinary days carry no special-day flags", () => {
    const occ = expandSchedule([svc({})], NY, { from: new Date("2026-10-13T04:00:00Z"), days: 0, kinds: ["mass"] });
    expect(occ[0]).toMatchObject({ specialDay: null, regularSchedule: false });
  });

  it("applies parish notes: 'First Fri.' only on the first Friday", () => {
    const occ = expandSchedule([svc({ kind: "adoration", source_type: "Adorations", days: [5], start: "19:00", end: "20:00", comment: "First Fri." })],
      NY, { from: new Date("2026-10-01T04:00:00Z"), days: 30, kinds: ["adoration"] });
    expect(occ.map((o) => o.localDate)).toEqual(["2026-10-02"]);
  });

  it("applies parish notes: 'Suppressed December 24 to January 1'", () => {
    const occ = expandSchedule([svc({ comment: "*Suppressed from December 24 to January 1" })],
      NY, { from: new Date("2026-12-21T05:00:00Z"), days: 14, kinds: ["mass"] });
    expect(occ.map((o) => o.localDate)).toEqual(["2026-12-21", "2026-12-22", "2026-12-23", "2027-01-04"]);
  });
});
