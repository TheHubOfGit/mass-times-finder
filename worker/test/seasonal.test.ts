import { describe, expect, it } from "vitest";
import { dayInfo, easterDate, holidayTags, noteAllows, parseNote } from "../src/seasonal";

const allows = (note: string, date: string, extra: string[] = []) => noteAllows(note, dayInfo(date, extra));

describe("calendar", () => {
  it("computes Easter and US holidays", () => {
    expect(easterDate(2027)).toBe("2027-03-28");
    expect([...holidayTags("2026-11-26")]).toEqual(expect.arrayContaining(["thanksgiving", "legal holiday"]));
    expect(holidayTags("2026-09-07").has("labor day")).toBe(true);
    expect(holidayTags("2027-02-10").has("ash wednesday")).toBe(true);
    expect(holidayTags("2026-12-26").has("day after christmas")).toBe(true);
  });
});

describe("ordinal weekdays", () => {
  // Fridays in Oct 2026: 2, 9, 16, 23, 30
  it("'First Fri.' keeps only the first Friday", () => {
    expect(allows("First Fri.", "2026-10-02")).toBe(true);
    expect(allows("First Fri.", "2026-10-09")).toBe(false);
    expect(allows("Sacred Heart Novena. First Fri.", "2026-10-16")).toBe(false);
    expect(allows("1st Fridays", "2026-10-02")).toBe(true);
    expect(allows("First Fridays only. Holy Hour", "2026-10-23")).toBe(false);
    expect(allows("Pierwszy piatek miesiaca |First Friday", "2026-10-30")).toBe(false);
  });
  it("handles lists and 'last'", () => {
    // Saturdays in Oct 2026: 3, 10, 17, 24, 31
    const n = "2nd, 3rd & 4th Saturdays of the month";
    expect([3, 10, 17, 24, 31].map((d) => allows(n, `2026-10-${String(d).padStart(2, "0")}`))).toEqual([false, true, true, true, false]);
    expect(allows("Last Sunday", "2026-10-25")).toBe(true);
    expect(allows("Last Sunday", "2026-10-18")).toBe(false);
    expect(allows("Third Sunday of the month.", "2026-10-18")).toBe(true);
  });
  it("ignores ordinals that don't open a phrase, or name another weekday", () => {
    expect(parseNote("Note: A Healing Mass on 1st Saturday")).toBeNull();
    expect(allows("Eve of First Fridays and Holy Days", "2026-10-08")).toBe(true);
    expect(allows("First Fri.", "2026-10-10")).toBe(true); // note is about Fridays; a Saturday entry is unaffected
  });
});

describe("holiday exceptions", () => {
  it("'Except on Easter, Christmas & New Year days'", () => {
    const n = "Except on Easter, Christmas & New Year days";
    expect(allows(n, "2026-12-25")).toBe(false);
    expect(allows(n, "2027-03-28")).toBe(false);
    expect(allows(n, "2027-01-01")).toBe(false);
    expect(allows(n, "2026-12-27")).toBe(true);
  });
  it("legal holidays and day-after lists", () => {
    const n = "No 7:00am Mass on Legal Holidays or the Day after Christmas, Easter or Thanksgiving.";
    expect(allows(n, "2026-09-07")).toBe(false); // Labor Day
    expect(allows(n, "2026-12-26")).toBe(false);
    expect(allows(n, "2026-11-27")).toBe(false); // day after Thanksgiving
    expect(allows(n, "2026-11-25")).toBe(true);
  });
  it("needs negation: positive mentions do nothing", () => {
    expect(parseNote("Mass at 9am on Legal Holidays")).toBeNull();
    expect(parseNote("Christmas Eve family Mass")).toBeNull();
  });
  it("'except holy days' uses the holy-day tag", () => {
    expect(allows("Except Holy Days", "2026-12-08", ["holy day"])).toBe(false);
    expect(allows("Except Holy Days", "2026-12-09")).toBe(true);
  });
});

describe("date ranges and seasons", () => {
  it("'Suppressed December 24 to January 1' wraps the year", () => {
    const n = "*Suppressed from December 24 to January 1";
    expect(allows(n, "2026-12-24")).toBe(false);
    expect(allows(n, "2026-12-31")).toBe(false);
    expect(allows(n, "2027-01-01")).toBe(false);
    expect(allows(n, "2027-01-02")).toBe(true);
    expect(allows(n, "2026-12-23")).toBe(true);
  });
  it("named endpoints: 'not from July 4 to Labor Day', 'Not on Civic Holidays or from July 1 to Labor Day'", () => {
    expect(allows("not from July 4 to Labor Day", "2026-08-15")).toBe(false);
    expect(allows("not from July 4 to Labor Day", "2026-09-08")).toBe(true);
    const n = "Not on Civic Holidays or from July 1 to Labor Day";
    expect(allows(n, "2026-07-20")).toBe(false);
    expect(allows(n, "2026-10-12")).toBe(false); // Columbus Day
    expect(allows(n, "2026-10-13")).toBe(true);
  });
  it("'Paused from the 2nd week of July to the 2nd week of Sept.'", () => {
    const n = "Paused from the 2nd week of July to the 2nd week of Sept.";
    expect(allows(n, "2026-07-05")).toBe(true);
    expect(allows(n, "2026-08-01")).toBe(false);
    expect(allows(n, "2026-09-20")).toBe(true);
  });
  it("active-only ranges need 'only' or a bare range", () => {
    const n = "mid-September to mid-June only";
    expect(allows(n, "2026-07-12")).toBe(false);
    expect(allows(n, "2026-10-12")).toBe(true);
    expect(allows(n, "2027-06-10")).toBe(true);
    // "…October to June ONLY": no overnight adoration in July.
    expect(allows("Begins First Fridays at 7:45 pm -October to June ONLY, overnight till Saturday", "2026-07-03")).toBe(false);
    expect(allows("Begins First Fridays at 7:45 pm -October to June ONLY, overnight till Saturday", "2026-10-02")).toBe(true);
  });
  it("month lists", () => {
    expect(allows("July and August", "2026-07-12")).toBe(true);
    expect(allows("July and August", "2026-10-12")).toBe(false);
    expect(allows("Except in July & August", "2026-08-02")).toBe(false);
    expect(allows("Exposition. Paused in July & August", "2026-07-10")).toBe(false);
    expect(allows("Exposition. Paused in July & August", "2026-10-09")).toBe(true);
    expect(parseNote("May vary")).toBeNull();
  });
  it("summer and semesters", () => {
    expect(allows("Suspended for the Summer", "2026-07-15")).toBe(false);
    expect(allows("Summer", "2026-10-15")).toBe(false);
    expect(allows("Summer", "2026-07-15")).toBe(true);
    expect(allows("Family Mass, except in the Summer months", "2026-08-02")).toBe(false);
    expect(allows("Semester Only", "2026-07-15")).toBe(false);
    expect(allows("*Fall and Spring semesters only", "2026-10-15")).toBe(true);
    expect(allows("*Fall and Spring semesters only", "2026-12-28")).toBe(false);
  });
  it("ordinal plus season in one phrase", () => {
    const n = "First Tuesdays -October to June ONLY. TLM";
    expect(allows(n, "2026-10-06")).toBe(true); // 1st Tue of Oct
    expect(allows(n, "2026-10-13")).toBe(false); // 2nd Tue
    expect(allows(n, "2027-07-06")).toBe(false); // 1st Tue of July, out of season
    expect(allows("4th Thursdays, except in July & August", "2026-10-22")).toBe(true);
    expect(allows("4th Thursdays, except in July & August", "2026-10-15")).toBe(false);
    expect(allows("First Fridays (Sept to June), following 12:15 pm Mass", "2027-07-02")).toBe(false);
  });
  it("drops conflicting ordinal rules, reads 'civil holidays'", () => {
    expect(parseNote("1st & 3rd Sundays in English; 2nd & 4th Sundays in Malayalam")).toBeNull();
    expect(allows("1st and 3rd Fridays, except on Civil Holidays. Ends w/Benediction", "2026-10-02")).toBe(true);
    expect(allows("Family Mass except July-Labor Day (in German on first Sundays)", "2026-08-02")).toBe(false);
    expect(allows("Family Mass except July-Labor Day (in German on first Sundays)", "2026-10-11")).toBe(true);
  });
  it("skips notes and conditionals", () => {
    expect(parseNote("If not a Holy Day of obligation, regular Mass schedule applies. Check bulletin")).toBeNull();
    expect(allows("Note: Mass w/Anointing of the Sick on 1st Saturday, EXCEPT in July & August", "2026-07-11")).toBe(true);
  });
  it("indefinite suspension", () => {
    expect(allows("2nd Sundays only. SUSPENDED until further notice. Please check bulletin", "2026-10-11")).toBe(false);
  });
  it("leaves ordinary notes alone", () => {
    for (const n of ["Miraculous Medal Novena", "Rosary", "Lower Hall", "or by appointment", "Mass in English and Italian"]) {
      expect(parseNote(n)).toBeNull();
    }
  });
});
