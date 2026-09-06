/**
 * Unit conversion tables.
 *
 * Every category except temperature is purely multiplicative, so each unit is
 * stored as "how many base units is one of me" and a conversion is two
 * multiplications. Temperature is affine (it has an offset, not just a scale),
 * so it gets explicit to/from functions rather than being forced into the same
 * shape — 0°C is not 0°F, and pretending otherwise is the classic bug here.
 *
 * Pure data + pure functions: no clock, no I/O, nothing retained. Costs nothing
 * while the panel is closed.
 */

export interface Unit {
  id: string;
  /** Shown in the dropdown. */
  name: string;
  /** Short suffix shown beside the result. */
  symbol: string;
  /** How many base units one of this unit is worth (linear categories only). */
  factor?: number;
  /** Affine categories (temperature) supply explicit conversions instead. */
  toBase?: (v: number) => number;
  fromBase?: (v: number) => number;
}

export interface UnitCategory {
  id: string;
  name: string;
  units: Unit[];
  /** Sensible starting pair, so the panel opens on something useful. */
  defaultFrom: string;
  defaultTo: string;
}

const lin = (id: string, name: string, symbol: string, factor: number): Unit => ({
  id,
  name,
  symbol,
  factor,
});

export const CATEGORIES: UnitCategory[] = [
  {
    id: "length",
    name: "Length",
    defaultFrom: "m",
    defaultTo: "ft",
    units: [
      lin("mm", "Millimetre", "mm", 0.001),
      lin("cm", "Centimetre", "cm", 0.01),
      lin("m", "Metre", "m", 1),
      lin("km", "Kilometre", "km", 1000),
      lin("in", "Inch", "in", 0.0254),
      lin("ft", "Foot", "ft", 0.3048),
      lin("yd", "Yard", "yd", 0.9144),
      lin("mi", "Mile", "mi", 1609.344),
      lin("nmi", "Nautical mile", "nmi", 1852),
    ],
  },
  {
    id: "weight",
    name: "Weight",
    defaultFrom: "kg",
    defaultTo: "lb",
    units: [
      lin("mg", "Milligram", "mg", 0.000001),
      lin("g", "Gram", "g", 0.001),
      lin("kg", "Kilogram", "kg", 1),
      lin("t", "Tonne", "t", 1000),
      lin("oz", "Ounce", "oz", 0.028349523125),
      lin("lb", "Pound", "lb", 0.45359237),
      lin("st", "Stone", "st", 6.35029318),
    ],
  },
  {
    id: "temperature",
    name: "Temperature",
    defaultFrom: "c",
    defaultTo: "f",
    units: [
      // Base is Celsius. Affine, so these carry explicit conversions.
      { id: "c", name: "Celsius", symbol: "°C", toBase: (v) => v, fromBase: (v) => v },
      {
        id: "f",
        name: "Fahrenheit",
        symbol: "°F",
        toBase: (v) => ((v - 32) * 5) / 9,
        fromBase: (v) => (v * 9) / 5 + 32,
      },
      {
        id: "k",
        name: "Kelvin",
        symbol: "K",
        toBase: (v) => v - 273.15,
        fromBase: (v) => v + 273.15,
      },
    ],
  },
  {
    id: "area",
    name: "Area",
    defaultFrom: "m2",
    defaultTo: "ft2",
    units: [
      lin("mm2", "Square millimetre", "mm²", 0.000001),
      lin("cm2", "Square centimetre", "cm²", 0.0001),
      lin("m2", "Square metre", "m²", 1),
      lin("ha", "Hectare", "ha", 10000),
      lin("km2", "Square kilometre", "km²", 1000000),
      lin("in2", "Square inch", "in²", 0.00064516),
      lin("ft2", "Square foot", "ft²", 0.09290304),
      lin("yd2", "Square yard", "yd²", 0.83612736),
      lin("acre", "Acre", "acre", 4046.8564224),
      lin("mi2", "Square mile", "mi²", 2589988.110336),
    ],
  },
  {
    id: "volume",
    name: "Volume",
    defaultFrom: "l",
    defaultTo: "galus",
    units: [
      lin("ml", "Millilitre", "ml", 0.001),
      lin("l", "Litre", "L", 1),
      lin("m3", "Cubic metre", "m³", 1000),
      lin("tsp", "Teaspoon (US)", "tsp", 0.00492892159375),
      lin("tbsp", "Tablespoon (US)", "tbsp", 0.01478676478125),
      lin("cup", "Cup (US)", "cup", 0.2365882365),
      lin("flozus", "Fluid ounce (US)", "fl oz", 0.0295735295625),
      lin("ptus", "Pint (US)", "pt", 0.473176473),
      lin("galus", "Gallon (US)", "gal", 3.785411784),
      lin("galuk", "Gallon (UK)", "gal UK", 4.54609),
    ],
  },
  {
    id: "speed",
    name: "Speed",
    defaultFrom: "kmh",
    defaultTo: "mph",
    units: [
      lin("ms", "Metre / second", "m/s", 1),
      lin("kmh", "Kilometre / hour", "km/h", 1 / 3.6),
      lin("mph", "Mile / hour", "mph", 0.44704),
      lin("fts", "Foot / second", "ft/s", 0.3048),
      lin("kn", "Knot", "kn", 0.514444444444),
    ],
  },
  {
    id: "data",
    name: "Data",
    defaultFrom: "mb",
    defaultTo: "mib",
    units: [
      // Base is the byte. Decimal (SI) and binary (IEC) are both listed
      // because "MB" means different things to a drive maker and to Windows.
      lin("b", "Byte", "B", 1),
      lin("kb", "Kilobyte (1000)", "kB", 1e3),
      lin("mb", "Megabyte (1000)", "MB", 1e6),
      lin("gb", "Gigabyte (1000)", "GB", 1e9),
      lin("tb", "Terabyte (1000)", "TB", 1e12),
      lin("kib", "Kibibyte (1024)", "KiB", 1024),
      lin("mib", "Mebibyte (1024)", "MiB", 1024 ** 2),
      lin("gib", "Gibibyte (1024)", "GiB", 1024 ** 3),
      lin("tib", "Tebibyte (1024)", "TiB", 1024 ** 4),
      lin("bit", "Bit", "bit", 0.125),
      lin("kbit", "Kilobit", "kbit", 125),
      lin("mbit", "Megabit", "Mbit", 125000),
      lin("gbit", "Gigabit", "Gbit", 125000000),
    ],
  },
  {
    id: "energy",
    name: "Energy",
    defaultFrom: "kwh",
    defaultTo: "mj",
    units: [
      lin("j", "Joule", "J", 1),
      lin("kj", "Kilojoule", "kJ", 1000),
      lin("mj", "Megajoule", "MJ", 1e6),
      lin("cal", "Calorie", "cal", 4.184),
      lin("kcal", "Kilocalorie", "kcal", 4184),
      lin("wh", "Watt-hour", "Wh", 3600),
      lin("kwh", "Kilowatt-hour", "kWh", 3.6e6),
      lin("btu", "BTU", "BTU", 1055.05585262),
    ],
  },
  {
    id: "power",
    name: "Power",
    defaultFrom: "kw",
    defaultTo: "hp",
    units: [
      lin("w", "Watt", "W", 1),
      lin("kw", "Kilowatt", "kW", 1000),
      lin("mw", "Megawatt", "MW", 1e6),
      lin("hp", "Horsepower (mech)", "hp", 745.6998715822702),
      lin("ps", "Metric horsepower", "PS", 735.49875),
    ],
  },
  {
    id: "angle",
    name: "Angle",
    defaultFrom: "deg",
    defaultTo: "rad",
    units: [
      lin("deg", "Degree", "°", 1),
      lin("rad", "Radian", "rad", 180 / Math.PI),
      lin("grad", "Gradian", "grad", 0.9),
      lin("turn", "Turn", "turn", 360),
      lin("arcmin", "Arcminute", "′", 1 / 60),
      lin("arcsec", "Arcsecond", "″", 1 / 3600),
    ],
  },
];

export function findCategory(id: string): UnitCategory | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

export function findUnit(category: UnitCategory, id: string): Unit | undefined {
  return category.units.find((u) => u.id === id);
}

/**
 * Convert between two units of the same category.
 *
 * Throws if the units belong to different categories — silently returning a
 * number there would be worse than failing, since the answer would be wrong
 * with no indication.
 */
export function convert(value: number, categoryId: string, fromId: string, toId: string): number {
  const category = findCategory(categoryId);
  if (!category) throw new Error(`Unknown category "${categoryId}"`);
  const from = findUnit(category, fromId);
  const to = findUnit(category, toId);
  if (!from || !to) throw new Error("Unknown unit");

  const base = from.toBase ? from.toBase(value) : value * (from.factor ?? 1);
  return to.fromBase ? to.fromBase(base) : base / (to.factor ?? 1);
}

/**
 * Display formatting for converted values.
 *
 * Conversions span a huge dynamic range (nanometres to light-years' worth of
 * bytes), so this keeps significant digits rather than a fixed decimal count.
 */
export function formatConverted(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs < 1e-6 || abs >= 1e15) return value.toExponential(6).replace(/\.?0+e/, "e");
  // Six significant decimals is plenty for a desk converter, and trailing
  // zeros are trimmed so 1 m -> 100 cm rather than 100.000000 cm.
  const fixed = value.toFixed(Math.max(0, 6 - Math.floor(Math.log10(abs))));
  return String(Number(fixed));
}
