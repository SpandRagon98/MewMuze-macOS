import type { CatAccessory } from "./spriteLoader";

/**
 * Calendar-driven costumes.
 *
 * Pure and date-injected so it is fully unit-testable and never depends on the
 * machine clock at import time. Returns null on ordinary days, in which case
 * the cat simply wears whatever the user picked.
 */
export function seasonalAccessoryFor(date: Date): CatAccessory | null {
  const month = date.getMonth(); // 0 = January
  const day = date.getDate();

  // Halloween season — the whole of October.
  if (month === 9) return "witchHat";
  // Festive December.
  if (month === 11) return "santaHat";
  // New Year's celebration, first few days of January.
  if (month === 0 && day <= 5) return "partyHat";
  // Deep winter after the new year.
  if (month === 0 || month === 1) return "scarf";
  // Spring blossom.
  if (month >= 2 && month <= 4) return "flowerCrown";
  return null;
}

/** Friendly label for the costume the calendar has chosen. */
export function seasonalLabel(accessory: CatAccessory): string {
  switch (accessory) {
    case "santaHat":
      return "Festive santa hat";
    case "witchHat":
      return "Spooky witch hat";
    case "partyHat":
      return "New Year party hat";
    case "flowerCrown":
      return "Spring flower crown";
    case "scarf":
      return "Cosy winter scarf";
    default:
      return "";
  }
}
