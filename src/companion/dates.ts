//! Important dates the user chose to tell the cat about. Stored locally, never synced.

import { daysBetween, localParts } from "./clock";
import type { ImportantDate } from "./profile";

export interface DueDate {
  date: ImportantDate;
  when: "today" | "tomorrow";
  /** De-duplication id: once per date, per occurrence, per "when". */
  id: string;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** The epoch-ms noon of this date's next relevant occurrence, in `tz`'s calendar terms. */
function occurrence(d: ImportantDate, year: number): { y: number; m: number; day: number } {
  // A 29 February birthday is celebrated on the 28th in other years.
  const day = d.month === 2 && d.day === 29 && !isLeap(year) ? 28 : d.day;
  return { y: year, m: d.month, day };
}

export function datesDue(dates: ImportantDate[], now: number, tz: string): DueDate[] {
  const out: DueDate[] = [];
  const today = localParts(now, tz);
  for (const d of dates) {
    const years = d.year ? [d.year] : [today.year, today.year + 1];
    for (const y of years) {
      const o = occurrence(d, y);
      // Compare whole local days, so DST and time of day cannot shift a date.
      const target = Date.UTC(o.y, o.m - 1, o.day, 12);
      const delta = daysBetween(Date.UTC(today.year, today.month - 1, today.day, 12), target, "UTC");
      if (delta === 0 || (delta === 1 && d.dayBefore)) {
        const when = delta === 0 ? "today" : "tomorrow";
        out.push({ date: d, when, id: `date:${d.id}:${o.y}-${o.m}-${o.day}:${when}` });
        break;
      }
    }
  }
  return out;
}

export function describeDate(due: DueDate, name: string): string {
  const { label, kind } = due.date;
  const today = due.when === "today";
  const luck = name ? ` Good luck, ${name}.` : " Good luck.";
  switch (kind) {
    case "birthday":
      return today ? `It's ${label}'s birthday today.` : `${label}'s birthday is tomorrow.`;
    case "anniversary":
      return today ? `Today is ${label}.` : `${label} is tomorrow.`;
    case "interview":
      return today ? `Your ${label} is today.${luck}` : `Your ${label} is tomorrow.${luck}`;
    case "deadline":
      return today ? `${label} is due today.` : `${label} is due tomorrow.`;
    default:
      return today ? `${label} is today.` : `${label} is tomorrow.`;
  }
}
