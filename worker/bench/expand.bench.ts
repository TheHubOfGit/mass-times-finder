import { readFileSync } from "node:fs";
import { expandSchedule } from "../src/schedule";
const churches = JSON.parse(readFileSync("../data/churches-nyc-li.json", "utf8")).churches.slice(0, 150);
const from = new Date("2026-10-14T16:00:00Z");
for (const days of [2, 7]) {
  for (let warm = 0; warm < 3; warm++) for (const c of churches) expandSchedule(c.services, c.timezone, { from, days, kinds: ["mass"] });
  const t0 = performance.now(); let n = 0;
  for (let rep = 0; rep < 20; rep++) for (const c of churches) n += expandSchedule(c.services, c.timezone, { from, days, kinds: ["mass"] }).length;
  console.log(`days=${days}: ${((performance.now() - t0) / 20).toFixed(2)} ms per 150-church request (${n / 20} occurrences)`);
}
