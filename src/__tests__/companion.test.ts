import { describe, expect, it, vi } from "vitest";
import { dayKey, daysBetween, formatClock, formatSpokenClock, localParts, startOfLocalDay, zoneOffsetMinutes } from "../companion/clock";
import { decideGreeting, EMPTY_GREET } from "../companion/greeting";
import { greeting, resolveLang, welcomeBack } from "../companion/phrases";
import { DEFAULT_COMPANION, inWindow, sanitizeCompanion, type CompanionSettings } from "../companion/profile";
import { catReactionFor, describeWeatherEvent, detectWeatherEvents, parseMet, rainTomorrowMm, type WeatherHour, type WeatherSnapshot } from "../companion/weather";
import { backToBack, describeChange, diffCalendar, freeWindows, toMeetings } from "../companion/calendarCompanion";
import { describeArrivals, mailScore, needsAttention } from "../companion/mailCompanion";
import { AwayTracker } from "../companion/away";
import { wrapUpDue, wrapUpLines } from "../companion/endOfDay";
import { emptyRoutine, isEarlyStart, observeActivity, typicalStart } from "../companion/routine";
import { SmartNotificationEngine, type CompanionNote, type NotifyContext } from "../companion/notify";
import { CompanionScheduler, MAX_BACKOFF_MS, type SchedulerEnv } from "../companion/scheduler";
import { effectiveMode, intervalFactor, UNKNOWN_POWER } from "../companion/power";
import { datesDue, describeDate } from "../companion/dates";
import { describeTravel, detectTravel } from "../companion/travel";
import { myDayLines } from "../companion/myDay";
import { describeFx, evaluateFx, freshWatchState, keywordHit, parseFrankfurter } from "../companion/watchlists";
import { freshHeadlines, parseGdelt, type Headline } from "../companion/news";
import { parseNominatim } from "../companion/location";
import { freshState, parseState } from "../companion/store";
import { ACTIONS, notInstalled, transition, voiceChatAvailable, type ModuleAction, type ModuleStatus } from "../companion/modules";

const canDo = (s: ModuleStatus, a: ModuleAction) => ACTIONS[s.state].includes(a);
import { ModelLifecycleManager, type LifecycleEnv } from "../companion/lifecycle";
import { CompanionEngine, type CompanionHost, type HostContext } from "../companion/engine";
import type { CalEventRaw } from "../integrations/calendar";
import { calendarAlert } from "../integrations/calendar";
import { sanitizeSettings } from "../settings/settingsStore";

const MIN = 60_000;
const HOUR = 3_600_000;
const IST = "Asia/Kolkata";
const NY = "America/New_York";

// ---- time ----------------------------------------------------------------------

describe("time awareness", () => {
  it("handles DST: 23- and 25-hour days in New York", () => {
    const springDay = Date.UTC(2026, 2, 8, 17); // Sun 8 Mar 2026, the jump forward
    const start = startOfLocalDay(springDay, NY);
    expect(start).toBe(Date.UTC(2026, 2, 8, 5)); // local midnight was EST
    expect(startOfLocalDay(springDay + 24 * HOUR, NY) - start).toBe(23 * HOUR);
    const fallDay = Date.UTC(2026, 10, 1, 17); // Sun 1 Nov 2026, the fall back
    expect(startOfLocalDay(fallDay + 24 * HOUR, NY) - startOfLocalDay(fallDay, NY)).toBe(25 * HOUR);
  });

  it("takes zone offsets from the tz database, DST included", () => {
    expect(zoneOffsetMinutes(Date.UTC(2026, 0, 15), IST, NY)).toBe(630);
    expect(zoneOffsetMinutes(Date.UTC(2026, 6, 15), IST, NY)).toBe(570);
    expect(zoneOffsetMinutes(Date.UTC(2026, 6, 15), "Asia/Kathmandu", IST)).toBe(15);
  });

  it("puts date boundaries where the user's wall clock does", () => {
    const t = Date.UTC(2026, 8, 10, 18, 45); // 00:15 on the 11th in India
    expect(dayKey(t, "UTC")).toBe("2026-09-10");
    expect(dayKey(t, IST)).toBe("2026-09-11");
    expect(localParts(t, IST).hour).toBe(0);
    expect(daysBetween(Date.UTC(2026, 11, 31, 12), Date.UTC(2027, 0, 1, 12), "UTC")).toBe(1);
  });

  it("formats 12- and 24-hour clocks", () => {
    const t = Date.UTC(2026, 8, 10, 11, 30); // 17:00 IST
    expect(formatClock(t, true, IST)).toBe("5:00 PM");
    expect(formatSpokenClock(t, true, IST)).toBe("5 PM");
    expect(formatClock(t, false, IST)).toBe("17:00");
    expect(formatClock(Date.UTC(2026, 8, 9, 18, 30), true, IST)).toBe("12:00 AM");
  });
});

describe("greetings", () => {
  const at = (h: number, m = 0, day = 10) => Date.UTC(2026, 8, day, h, m) - 330 * MIN; // IST wall time
  it("greets once per day, on the first active moment, with a stretch in the morning", () => {
    const g = decideGreeting(EMPTY_GREET, at(8), IST, true)!;
    expect(g.part).toBe("morning");
    expect(g.cat).toBe("stretch");
    expect(decideGreeting(g.next, at(10), IST, true)).toBeNull();
    expect(decideGreeting(g.next, at(18), IST, true)).toBeNull();
    const tomorrow = decideGreeting(g.next, at(7, 30, 11), IST, true)!;
    expect(tomorrow.part).toBe("morning");
  });

  it("never greets an empty room", () => {
    expect(decideGreeting(EMPTY_GREET, at(8), IST, false)).toBeNull();
  });

  it("greets the afternoon with a wave when that is the first activity", () => {
    const g = decideGreeting(EMPTY_GREET, at(13), IST, true)!;
    expect(g.part).toBe("afternoon");
    expect(g.cat).toBe("wave");
  });

  it("asks 'still up?' once a night - not again after midnight", () => {
    const first = decideGreeting(EMPTY_GREET, at(22, 30), IST, true)!;
    expect(first.part).toBe("late");
    expect(decideGreeting(first.next, at(0, 30, 11), IST, true)).toBeNull();
    // A fresh night asks again.
    const next = decideGreeting(first.next, at(1, 0, 12), IST, true);
    expect(next?.part).toBe("late");
  });

  it("speaks the chosen language and personality", () => {
    expect(greeting("morning", "en", "cozy", "Sandy")).toBe("Good morning, Sandy ☀️");
    expect(greeting("late", "en", "cozy", "Sandy")).toBe("Still up, Sandy? 🌙");
    expect(greeting("evening", "en", "cozy", "")).toBe("Good evening 🌆");
    expect(greeting("late", "en", "savage", "Sandy")).toMatch(/^Still up, Sandy\? .*🙄/u);
    // The calm voices stay emoji-free.
    expect(greeting("morning", "en", "professional", "Sandy")).toBe("Good morning, Sandy.");
    expect(welcomeBack("en", "Sandy")).toBe("Welcome back, Sandy.");
    expect(resolveLang("auto", "hi-IN")).toBe("hi");
    expect(resolveLang("auto", "en-GB")).toBe("en");
    expect(resolveLang("hinglish", "en-GB")).toBe("hinglish");
  });
});

describe("profile settings", () => {
  it("starts with every internet- or account-based feature off", () => {
    expect(DEFAULT_COMPANION.features.weather).toBe(false);
    expect(DEFAULT_COMPANION.features.news).toBe(false);
    expect(DEFAULT_COMPANION.features.watchlists).toBe(false);
    expect(DEFAULT_COMPANION.powerMode).toBe("balanced");
    expect(sanitizeSettings({}).companion).toEqual(DEFAULT_COMPANION);
  });

  it("sanitises a hand-edited file", () => {
    const c = sanitizeCompanion({
      preferredName: "Sandy\n",
      language: "klingon",
      location: { mode: "city", label: "X", lat: 12.971599, lon: null },
      watches: [{ kind: "fx", base: "US", quote: "INR" }, { kind: "keyword", phrase: "Pixel launch" }],
      features: { weather: "yes", news: true },
    });
    expect(c.preferredName).toBe("Sandy");
    expect(c.language).toBe("auto");
    expect(c.location.mode).toBe("off"); // needs both coordinates
    expect(c.watches.map((w) => w.kind)).toEqual(["keyword"]);
    expect(c.features.weather).toBe(false);
    expect(c.features.news).toBe(true);
  });

  it("handles overnight windows (quiet hours)", () => {
    const q = { enabled: true, start: 23 * 60, end: 7 * 60 };
    expect(inWindow(23 * 60 + 30, q)).toBe(true);
    expect(inWindow(3 * 60, q)).toBe(true);
    expect(inWindow(12 * 60, q)).toBe(false);
    expect(inWindow(3 * 60, { ...q, enabled: false })).toBe(false);
  });
});

// ---- weather ---------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 10, 8); // 08:00 UTC
function snap(fn: (i: number) => Partial<WeatherHour>, count = 40, from = NOW): WeatherSnapshot {
  const hours: WeatherHour[] = [];
  for (let i = 0; i < count; i++) hours.push({ t: from + i * HOUR, temp: 25, humidity: null, wind: 2, precip: 0, symbol: "partlycloudy", ...fn(i) });
  return { fetchedAt: from, hours };
}
const kinds = (s: WeatherSnapshot, mem = { lastDayMax: null }) => detectWeatherEvents(s, NOW, "UTC", mem).events.map((e) => e.kind);

describe("weather significance", () => {
  it("parses MET Norway compact forecasts and rejects anything else", () => {
    const json = {
      properties: {
        timeseries: [
          { time: "2026-09-10T08:00:00Z", data: { instant: { details: { air_temperature: 27.5, relative_humidity: 70, wind_speed: 3 } }, next_1_hours: { summary: { symbol_code: "lightrain_day" }, details: { precipitation_amount: 0.6 } } } },
          { time: "2026-09-13T00:00:00Z", data: { instant: { details: { air_temperature: 20 } }, next_6_hours: { summary: { symbol_code: "rain" }, details: { precipitation_amount: 6 } } } },
        ],
      },
    };
    const s = parseMet(json, NOW)!;
    expect(s.hours[0]).toMatchObject({ temp: 27.5, symbol: "lightrain", precip: 0.6 });
    expect(s.hours[1].precip).toBe(1); // 6 mm over 6 hours
    expect(parseMet({ nope: true }, NOW)).toBeNull();
    expect(parseMet("<html>", NOW)).toBeNull();
  });

  it("does not notify because 28°C became 29°C", () => {
    expect(kinds(snap((i) => ({ temp: i < 4 ? 28 : 29 })))).toEqual([]);
  });

  it("announces rain arriving - and heavy rain - but not rain that is already falling", () => {
    expect(kinds(snap((i) => (i === 3 ? { precip: 1.2, symbol: "rain" } : {})))).toEqual(["rain"]);
    expect(kinds(snap((i) => (i === 3 ? { precip: 5, symbol: "heavyrain" } : {})))).toEqual(["heavyRain"]);
    expect(kinds(snap((i) => (i < 6 ? { precip: 2, symbol: "rain" } : {})))).toEqual([]);
  });

  it("recognises storms, snow, heat, unusual cold and big day-on-day swings", () => {
    expect(kinds(snap((i) => (i === 2 ? { symbol: "rainandthunder", precip: 3 } : {})))).toContain("storm");
    expect(kinds(snap((i) => (i === 5 ? { symbol: "snow", precip: 1, temp: 0 } : {})))).toContain("snow");
    expect(kinds(snap((i) => (i === 4 ? { temp: 36, humidity: 60 } : {})))).toContain("heat");
    expect(kinds(snap((i) => (i === 6 ? { temp: 2 } : {})))).toContain("cold");
    const swing = detectWeatherEvents(snap(() => ({ temp: 30 })), NOW, "UTC", { lastDayMax: { day: "2026-09-09", max: 20 } });
    expect(swing.events.find((e) => e.kind === "swing")?.value).toBe(10);
  });

  it("gives the same fact the same id, so the notification engine says it once", () => {
    const s = snap((i) => (i === 3 ? { precip: 1.2, symbol: "rain" } : {}));
    const a = detectWeatherEvents(s, NOW, "UTC", { lastDayMax: null }).events[0];
    const b = detectWeatherEvents(s, NOW + 20 * MIN, "UTC", { lastDayMax: null }).events[0];
    expect(a.id).toBe(b.id);
    const engine = new SmartNotificationEngine();
    const note = (id: string): CompanionNote => ({ id, kind: "weather", priority: "normal", lines: ["Rain"], createdAt: NOW });
    expect(engine.submit(note(a.id), NOW).outcome).toBe("queued");
    expect(engine.submit(note(b.id), NOW + 20 * MIN)).toEqual({ outcome: "ignored", reason: "duplicate" });
  });

  it("words it in the cat's voice and picks an existing animation", () => {
    const ev = { kind: "rain" as const, at: Date.UTC(2026, 8, 10, 17), id: "x" };
    expect(describeWeatherEvent(ev, "Sandy", true, "c", "UTC")).toBe("Rain's coming, Sandy. Showers expected around 5 PM.");
    expect(describeWeatherEvent({ kind: "heat", at: NOW, id: "h", value: 41 }, "", true, "f", "UTC")).toContain("106°F");
    expect(catReactionFor("rain")).toBe("lookUp");
    expect(catReactionFor("cold")).toBe("shake");
    expect(catReactionFor("heat")).toBe("overheat");
    expect(catReactionFor("storm")).toBe("startled");
  });

  it("sums tomorrow's rain for the rain-tomorrow watch", () => {
    const s = snap((i) => (i >= 20 && i < 23 ? { precip: 1 } : {}));
    expect(rainTomorrowMm(s, NOW, "UTC")).toBe(3);
  });
});

// ---- calendar ----------------------------------------------------------------------

const ev = (summary: string, h: number, m: number, extra: Partial<CalEventRaw> = {}): CalEventRaw => ({
  summary,
  year: 2026,
  month: 9,
  day: 10,
  hour: h,
  minute: m,
  allDay: false,
  utc: true,
  durationMin: 30,
  ...extra,
});

describe("calendar companion", () => {
  it("keeps a one-off meeting's id when it moves, and tells recurring instances apart by their original slot", () => {
    const [a] = toMeetings([ev("Review", 10, 0, { uid: "u1" })]);
    const [b] = toMeetings([ev("Review", 10, 30, { uid: "u1" })]);
    expect(a.id).toBe(b.id);
    const moved = toMeetings([ev("Sync", 16, 30, { uid: "w", recurring: true, origYear: 2026, origMonth: 9, origDay: 10, origHour: 16, origMinute: 0 })])[0];
    const orig = toMeetings([ev("Sync", 16, 0, { uid: "w", recurring: true })])[0];
    expect(moved.id).toBe(orig.id);
    expect(moved.movedFrom).toBe(orig.start);
  });

  it("reports nothing on the first fetch, then moves and cancellations", () => {
    const now = Date.UTC(2026, 8, 10, 8);
    const first = diffCalendar(null, toMeetings([ev("Review", 16, 0, { uid: "u1" }), ev("1:1", 12, 0, { uid: "u2" }), ev("Late", 20, 0, { uid: "u3" })]), now);
    expect(first.changes).toEqual([]);
    const second = diffCalendar(first.snapshot, toMeetings([ev("Review", 16, 30, { uid: "u1" }), ev("1:1", 12, 0, { uid: "u2", cancelled: true })]), now);
    const byKind = Object.fromEntries(second.changes.map((c) => [`${c.kind}:${c.meeting.title}`, c]));
    expect(Object.keys(byKind).sort()).toEqual(["cancelled:1:1", "cancelled:Late", "moved:Review"]);
    expect(describeChange(byKind["moved:Review"], true, "UTC")).toBe("Review moved from 4 PM to 4:30 PM.");
  });

  it("does not call a meeting cancelled just because it slid out of the fetch window", () => {
    const now = Date.UTC(2026, 8, 10, 8);
    const first = diffCalendar(null, toMeetings([ev("Soon", 8, 10, { uid: "s" })]), now);
    expect(diffCalendar(first.snapshot, [], now).changes).toEqual([]);
  });

  it("finds back-to-back runs and free windows", () => {
    const now = Date.UTC(2026, 8, 10, 8);
    const day = toMeetings([ev("A", 13, 0), ev("B", 13, 35), ev("C", 14, 10), ev("D", 16, 0)]);
    expect(backToBack(day, now, "UTC")?.map((m) => m.title)).toEqual(["A", "B", "C"]);
    const free = freeWindows(day, now, "UTC", { start: 9 * 60, end: 18 * 60 });
    expect(free.map((w) => [new Date(w.start).getUTCHours(), new Date(w.end).getUTCHours()])).toEqual([
      [9, 13],
      [14, 16],
      [16, 18],
    ]);
  });

  it("never alerts for a cancelled meeting", () => {
    const now = Date.UTC(2026, 8, 10, 9, 55);
    expect(calendarAlert([ev("Review", 10, 0)], now, 10, "")?.message).toContain("Review in 5 minutes");
    expect(calendarAlert([ev("Review", 10, 0, { cancelled: true })], now, 10, "")).toBeNull();
  });
});

// ---- mail ------------------------------------------------------------------------

describe("email importance", () => {
  const mail = (from: string, subject: string, important = false) => ({ uid: Math.random(), from, subject, important });
  it("scores Gmail's Important marker and attention words up, bulk mail down", () => {
    expect(needsAttention(mail("Priya", "Lunch?", true))).toBe(true);
    expect(needsAttention(mail("Priya", "Contract approval needed"))).toBe(false); // +2 alone is not enough
    expect(needsAttention(mail("Priya", "Re: Contract approval needed"))).toBe(true);
    expect(mailScore(mail("newsletter@shop.com", "Weekly deals: 50% off"))).toBeLessThan(0);
  });

  it("summarises an absence with sender and subject only", () => {
    const batch = [
      mail("Priya Sharma <priya@x.com>", "Urgent: invoice overdue", true),
      mail("Boss", "Interview schedule", true),
      ...Array.from({ length: 12 }, () => mail("noreply@news.com", "Your daily digest")),
    ];
    const lines = describeArrivals(batch, true)!;
    expect(lines[0]).toBe("14 emails arrived while you were away. Two may need your attention.");
    expect(lines[1]).toBe("Priya Sharma: Urgent: invoice overdue");
    expect(lines).toHaveLength(3);
  });

  it("stays quiet about a few unimportant emails", () => {
    expect(describeArrivals([mail("noreply@x.com", "Digest"), mail("promo@y.com", "Sale")], false)).toBeNull();
  });
});

// ---- away / end of day / routine ------------------------------------------------------

describe("while you were away", () => {
  it("reports a return exactly once per real absence", () => {
    const t = new AwayTracker();
    expect(t.sample(300, 0)).toBeNull(); // 5 min idle: not away
    expect(t.sample(700, 1000)).toBeNull(); // now away
    expect(t.isAway()).toBe(true);
    expect(t.sample(900, 200_000)).toBeNull(); // still away
    const back = t.sample(2, 1_500_000)!;
    expect(back.awayMs).toBe(1_500_000 - (1000 - 700_000));
    expect(t.sample(1, 1_501_000)).toBeNull();
  });
});

describe("end of day", () => {
  const base = { tz: "UTC", work: { enabled: true, start: 9 * 60, end: 18 * 60 }, typicalFinishMin: null, activeMinToday: 300, lastWrapDay: "" };
  it("offers the wrap-up at the end of the working day, once", () => {
    expect(wrapUpDue({ ...base, now: Date.UTC(2026, 8, 10, 17, 50) })).toBe(true);
    expect(wrapUpDue({ ...base, now: Date.UTC(2026, 8, 10, 15, 0) })).toBe(false);
    expect(wrapUpDue({ ...base, now: Date.UTC(2026, 8, 10, 17, 50), lastWrapDay: "2026-09-10" })).toBe(false);
    expect(wrapUpDue({ ...base, now: Date.UTC(2026, 8, 10, 17, 50), activeMinToday: 20 })).toBe(false);
  });

  it("lists what happened without scoring it", () => {
    const lines = wrapUpLines({ focusSessions: 4, remindersDone: 1 }, "Tomorrow's first meeting: Standup at 10 AM");
    expect(lines).toEqual(["4 focus sessions completed", "1 reminder finished", "Tomorrow's first meeting: Standup at 10 AM"]);
    expect(lines.join(" ")).not.toMatch(/score|%|productiv|great|bad/i);
  });
});

describe("routine learning", () => {
  /** Simulate a day active from `startMin` for three hours (UTC wall clock). */
  function day(stats: ReturnType<typeof emptyRoutine>, date: number, startMin: number) {
    let s = stats;
    for (let m = 0; m < 180; m++) s = observeActivity(s, date + (startMin + m) * MIN, "UTC");
    return s;
  }
  const monday = Date.UTC(2026, 8, 7);

  it("notices an unusually early start after a week of normal ones", () => {
    let s = emptyRoutine();
    for (let d = 0; d < 5; d++) s = day(s, monday + d * 86_400_000, 9 * 60 + 30); // Mon-Fri 9:30
    s = day(s, monday + 7 * 86_400_000, 9 * 60 + 30); // next Monday rolls Friday in
    expect(typicalStart(s, monday + 8 * 86_400_000, "UTC")).toBe(9 * 60 + 30);
    const early = observeActivity(s, monday + 8 * 86_400_000 + 7 * HOUR, "UTC");
    expect(isEarlyStart(early, monday + 8 * 86_400_000 + 7 * HOUR, "UTC")).toBe(true);
    const normal = observeActivity(s, monday + 8 * 86_400_000 + 9 * HOUR + 15 * MIN, "UTC");
    expect(isEarlyStart(normal, monday + 8 * 86_400_000 + 9 * HOUR + 15 * MIN, "UTC")).toBe(false);
  });

  it("says nothing before it has enough history, and forgets everything on reset", () => {
    let s = emptyRoutine();
    s = day(s, monday, 9 * 60 + 30);
    s = observeActivity(s, monday + 86_400_000 + 6 * HOUR, "UTC");
    expect(isEarlyStart(s, monday + 86_400_000 + 6 * HOUR, "UTC")).toBe(false);
    expect(emptyRoutine().weekday.first.n).toBe(0);
  });

  it("stores only numbers and day keys - never content", () => {
    let s = emptyRoutine();
    s = day(s, monday, 600);
    const strings = JSON.stringify(s).match(/"[^"]*":"([^"]*)"/g) ?? [];
    expect(strings.every((kv) => /"day":"\d{4}-\d{2}-\d{2}"/.test(kv))).toBe(true);
  });
});

// ---- notifications ----------------------------------------------------------------

describe("SmartNotificationEngine", () => {
  const t0 = Date.UTC(2026, 8, 10, 8);
  const ctx = (over: Partial<NotifyContext> = {}): NotifyContext => ({ now: t0, focus: false, fullscreen: false, quiet: false, slotBusy: false, away: false, ...over });
  const note = (id: string, over: Partial<CompanionNote> = {}): CompanionNote => ({ id, kind: "news", priority: "normal", lines: [id], createdAt: t0, ...over });

  it("shows the most important first", () => {
    const n = new SmartNotificationEngine();
    n.submit(note("low", { priority: "low", kind: "routine" }), t0);
    n.submit(note("high", { priority: "high", kind: "weather" }), t0);
    expect(n.next(ctx())?.id).toBe("high");
    expect(n.next(ctx())?.id).toBe("low");
  });

  it("respects per-kind cooldowns, which high priority skips", () => {
    const n = new SmartNotificationEngine();
    n.submit(note("a", { kind: "weather" }), t0);
    n.submit(note("b", { kind: "weather" }), t0);
    expect(n.next(ctx())?.id).toBe("a");
    expect(n.next(ctx({ now: t0 + HOUR }))).toBeNull(); // weather cooldown is 3 h
    expect(n.next(ctx({ now: t0 + 3 * HOUR + 1 }))?.id).toBe("b");
    n.submit(note("c", { kind: "weather", priority: "high" }), t0 + 3 * HOUR + 2);
    expect(n.next(ctx({ now: t0 + 3 * HOUR + 3 }))?.id).toBe("c");
  });

  it("holds everything but urgent during Focus and quiet hours, then releases it", () => {
    const n = new SmartNotificationEngine();
    n.submit(note("normal"), t0);
    n.submit(note("urgent", { priority: "urgent", kind: "calendar" }), t0);
    expect(n.next(ctx({ focus: true }))?.id).toBe("urgent");
    expect(n.next(ctx({ focus: true }))).toBeNull();
    expect(n.next(ctx({ quiet: true }))).toBeNull();
    expect(n.next(ctx())?.id).toBe("normal");
  });

  it("queues while a full-screen app is in front, and while the bubble is taken", () => {
    const n = new SmartNotificationEngine();
    n.submit(note("x", { priority: "urgent" }), t0);
    expect(n.next(ctx({ fullscreen: true }))).toBeNull();
    expect(n.next(ctx({ slotBusy: true }))).toBeNull();
    expect(n.next(ctx({ away: true }))).toBeNull();
    expect(n.next(ctx())?.id).toBe("x");
  });

  it("drops what went stale in the queue", () => {
    const n = new SmartNotificationEngine();
    n.submit(note("rain", { expiresAt: t0 + 30 * MIN }), t0);
    expect(n.next(ctx({ now: t0 + HOUR }))).toBeNull();
    expect(n.submit(note("old", { expiresAt: t0 - 1 }), t0)).toEqual({ outcome: "ignored", reason: "expired" });
  });

  it("merges a group into one card", () => {
    const n = new SmartNotificationEngine();
    n.submit(note("m1", { group: "cal", kind: "calendar", lines: ["Review moved"], actions: [{ id: "open-calendar", label: "Open Calendar" }] }), t0);
    n.submit(note("m2", { group: "cal", kind: "calendar", priority: "high", lines: ["1:1 cancelled"], actions: [{ id: "open-calendar", label: "Open Calendar" }] }), t0);
    const card = n.next(ctx())!;
    expect(card.lines).toEqual(["1:1 cancelled", "Review moved"]);
    expect(card.actions).toHaveLength(1);
    expect(n.pending()).toHaveLength(0);
  });

  it("caps notices per hour and backs off kinds the user keeps dismissing", () => {
    const n = new SmartNotificationEngine({ cooldownMs: { news: 0 } });
    for (let i = 0; i < 8; i++) n.submit(note(`n${i}`), t0);
    let shown = 0;
    while (n.next(ctx({ now: t0 + shown }))) shown++;
    expect(shown).toBe(6);
    const base = n.cooldownFor("weather");
    for (let i = 0; i < 3; i++) n.dismissed("weather", 1500);
    expect(n.cooldownFor("weather")).toBe(base * 2);
    n.dismissed("weather", 20_000);
    expect(n.cooldownFor("weather")).toBe(base);
  });
});

// ---- scheduler -----------------------------------------------------------------------

function fakeEnv() {
  let now = 0;
  let online = true;
  let fullscreen = false;
  let seq = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  const env: SchedulerEnv = {
    now: () => now,
    setTimer: (fn, ms) => {
      timers.push({ at: now + ms, fn, id: ++seq });
      return seq;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    online: () => online,
    fullscreen: () => fullscreen,
    random: () => 0.5, // jitter factor exactly 1
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    env,
    pending: () => timers.length,
    setOnline: (v: boolean) => (online = v),
    setFullscreen: (v: boolean) => (fullscreen = v),
    now: () => now,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
        await flush();
      }
      now = end;
    },
  };
}

describe("CompanionScheduler", () => {
  it("keeps exactly one timer for every job", async () => {
    const f = fakeEnv();
    const s = new CompanionScheduler(f.env);
    s.start();
    for (const id of ["a", "b", "c"]) s.register({ id, intervalMs: 60_000, network: false, run: () => undefined });
    expect(f.pending()).toBe(1);
    await f.advance(60_000);
    expect(s.counters.runs).toBe(3);
    expect(s.counters.wakeups).toBe(1); // all three due together: one wake-up
    expect(f.pending()).toBe(1);
  });

  it("backs off exponentially on failure, caps it, and recovers", async () => {
    const f = fakeEnv();
    const s = new CompanionScheduler(f.env);
    s.start();
    let ok = false;
    s.register({ id: "w", intervalMs: 60_000, network: true, run: () => ok });
    await f.advance(60_000);
    const gap = () => s.stats()[0].nextDue - (s.stats()[0].lastRun ?? 0);
    expect(gap()).toBe(120_000);
    await f.advance(120_000);
    expect(gap()).toBe(240_000);
    for (let i = 0; i < 12; i++) await f.advance(gap());
    expect(gap()).toBe(MAX_BACKOFF_MS);
    ok = true;
    await f.advance(gap());
    expect(s.stats()[0].failures).toBe(0);
    expect(gap()).toBe(60_000);
  });

  it("waits out offline spells without counting them as failures", async () => {
    const f = fakeEnv();
    const s = new CompanionScheduler(f.env);
    s.start();
    const run = vi.fn(() => true);
    s.register({ id: "net", intervalMs: 30 * 60_000, network: true, run });
    f.setOnline(false);
    await f.advance(30 * 60_000);
    expect(run).not.toHaveBeenCalled();
    expect(s.stats()[0].failures).toBe(0);
    f.setOnline(true);
    s.notifyOnline();
    await f.advance(3_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stretches intervals in Battery Saver and on battery - network work most", () => {
    const s = new CompanionScheduler(fakeEnv().env);
    const net = { id: "n", intervalMs: 60 * 60_000, network: true, run: () => undefined };
    const local = { id: "l", intervalMs: 30_000, network: false, run: () => undefined };
    expect(s.effectiveInterval(net)).toBe(60 * 60_000);
    s.setOnBattery(true);
    expect(s.effectiveInterval(net)).toBe(90 * 60_000);
    expect(s.effectiveInterval(local)).toBe(30_000);
    s.setMode("saver");
    expect(s.effectiveInterval(net)).toBe(180 * 60_000);
    expect(s.effectiveInterval(local)).toBe(60_000);
    s.setMode("performance");
    expect(s.effectiveInterval(net)).toBe(60 * 60_000);
    expect(intervalFactor("balanced", false, true)).toBe(1);
  });

  it("reschedules pending work when the mode changes", async () => {
    const f = fakeEnv();
    const s = new CompanionScheduler(f.env);
    s.start();
    const run = vi.fn();
    s.register({ id: "n", intervalMs: 60 * 60_000, network: true, run });
    s.setMode("saver");
    await f.advance(2 * 60 * 60_000);
    expect(run).not.toHaveBeenCalled();
    await f.advance(60 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("defers network work while full-screen, keeps local work running", async () => {
    const f = fakeEnv();
    const s = new CompanionScheduler(f.env);
    s.start();
    const net = vi.fn();
    const mail = vi.fn();
    const local = vi.fn();
    s.register({ id: "net", intervalMs: 60_000, network: true, run: net });
    s.register({ id: "mail", intervalMs: 60_000, network: true, runInFullscreen: true, run: mail });
    s.register({ id: "local", intervalMs: 60_000, network: false, run: local });
    f.setFullscreen(true);
    await f.advance(60_000);
    expect(net).not.toHaveBeenCalled();
    expect(mail).toHaveBeenCalledTimes(1);
    expect(local).toHaveBeenCalledTimes(1);
    f.setFullscreen(false);
    await f.advance(5 * 60_000);
    expect(net).toHaveBeenCalled();
  });

  it("never runs a job twice at once", async () => {
    const f = fakeEnv();
    const s = new CompanionScheduler(f.env);
    s.start();
    let release = () => {};
    s.register({ id: "slow", intervalMs: 60_000, network: false, run: () => new Promise<void>((r) => (release = r)) });
    await f.advance(60_000);
    expect(await s.runNow("slow")).toBe(false);
    release();
  });

  it("treats the OS battery saver as Battery Saver", () => {
    expect(effectiveMode("performance", { ...UNKNOWN_POWER, osSaver: true, known: true })).toBe("saver");
    expect(effectiveMode("balanced", UNKNOWN_POWER)).toBe("balanced");
  });
});

// ---- dates, travel, My Day, watches, news -------------------------------------------

describe("important dates", () => {
  const d = (over: object) => ({ id: "1", label: "Riya", kind: "birthday" as const, month: 9, day: 10, year: null, dayBefore: true, ...over });
  it("mentions a date on the day and the day before", () => {
    const now = Date.UTC(2026, 8, 10, 6);
    expect(describeDate(datesDue([d({})], now, "UTC")[0], "Sandy")).toBe("It's Riya's birthday today.");
    const interview = datesDue([d({ label: "interview", kind: "interview", day: 11, year: 2026 })], now, "UTC")[0];
    expect(describeDate(interview, "Sandy")).toBe("Your interview is tomorrow. Good luck, Sandy.");
    expect(datesDue([d({ day: 11, dayBefore: false })], now, "UTC")).toEqual([]);
  });

  it("celebrates 29 February on the 28th in other years", () => {
    expect(datesDue([d({ month: 2, day: 29 })], Date.UTC(2027, 1, 28, 6), "UTC")[0]?.when).toBe("today");
  });
});

describe("travel context", () => {
  it("only reads travel from an obviously travel-titled event", () => {
    const now = Date.UTC(2026, 8, 10, 3);
    const trip = detectTravel(toMeetings([ev("Flight to London", 9, 0)]), now, IST)!;
    expect(trip.city).toBe("london");
    expect(describeTravel(trip, now, true)).toMatch(/^Travelling to London today\? It's .* there now \(4h 30m behind\)\.$/);
    expect(detectTravel(toMeetings([ev("London office sync", 9, 0)]), now, IST)).toBeNull();
  });
});

describe("My Day", () => {
  it("is compact, deterministic and only says what is true", () => {
    const now = Date.UTC(2026, 8, 10, 7, 30); // 07:30 UTC
    const meetings = toMeetings([ev("Standup", 9, 30, { durationMin: 60 }), ev("Review", 12, 0, { durationMin: 60 }), ev("1:1", 13, 0, { durationMin: 120 }), ev("Sync", 15, 0, { durationMin: 180 })]);
    const lines = myDayLines({
      now,
      tz: "UTC",
      h12: true,
      greeting: "Good morning, Sandy.",
      weather: { now: "27°C, partly cloudy", later: "Rain after 5 PM" },
      meetings,
      work: null,
      importantMail: 2,
      unreadMail: 9,
      remindersToday: 3,
      dates: [],
      dateLine: () => "",
    });
    expect(lines).toEqual([
      "Good morning, Sandy.",
      "27°C, partly cloudy · Rain after 5 PM",
      "4 meetings today · First at 9:30 AM",
      "90-minute free window before lunch",
      "2 important emails",
      "3 reminders",
    ]);
    const bare = myDayLines({ ...{ now, tz: "UTC", h12: true, greeting: "Hi." }, weather: null, meetings: null, work: null, importantMail: null, unreadMail: null, remindersToday: 0, dates: [], dateLine: () => "" });
    expect(bare).toEqual(["Hi."]);
  });
});

describe("watchlists", () => {
  const w = { id: "w", kind: "fx" as const, label: "", paused: false, base: "USD", quote: "INR", threshold: 90, direction: "above" as const, phrase: "" };
  it("fires once per crossing and re-arms after moving back", () => {
    let st = freshWatchState();
    let r = evaluateFx(w, st, 89.5, 1);
    expect(r.fire).toBe(false);
    r = evaluateFx(w, (st = r.state), 90.1, 2);
    expect(r.fire).toBe(true);
    r = evaluateFx(w, (st = r.state), 90.4, 3);
    expect(r.fire).toBe(false); // still above: said once
    r = evaluateFx(w, (st = r.state), 89.9, 4);
    expect(r.state.armed).toBe(false); // inside the hysteresis band
    r = evaluateFx(w, (st = r.state), 89.5, 5);
    expect(r.state.armed).toBe(true);
    expect(evaluateFx(w, r.state, 90.2, 6).fire).toBe(true);
    expect(st.lastChecked).toBe(4);
    expect(describeFx(w, 90.23)).toBe("USD/INR is above 90 - now 90.23.");
  });

  it("parses rates and matches keyword watches on whole phrases", () => {
    expect(parseFrankfurter({ rates: { INR: 83.1 } }, "INR")).toBe(83.1);
    expect(parseFrankfurter({ message: "not found" }, "INR")).toBeNull();
    expect(keywordHit("Pixel 11 launch", ["Google sets Pixel 11 launch for October", "Other"])).toContain("Pixel 11");
    expect(keywordHit("Pixel 11 launch", ["Pixel phones on sale"])).toBeNull();
  });
});

describe("news and location parsing", () => {
  it("keeps only https articles and one copy of a syndicated headline", () => {
    const items = parseGdelt({
      articles: [
        { url: "https://a.example/1", title: "Big AI model released today", domain: "a.example", seendate: "20260910T081500Z" },
        { url: "https://b.example/1", title: "Big AI model released today", domain: "b.example" },
        { url: "http://c.example/1", title: "Insecure but otherwise fine headline" },
        { url: "https://d.example/1", title: "short" },
      ],
    });
    expect(items.map((i) => i.url)).toEqual(["https://a.example/1"]);
    expect(items[0].seen).toBe(Date.UTC(2026, 8, 10, 8, 15));
    expect(parseGdelt("rate limited")).toEqual([]);
    const h = (url: string): Headline => ({ url, title: url, domain: "", seen: 0 });
    expect(freshHeadlines([h("1"), h("2")], ["1"]).map((x) => x.url)).toEqual(["2"]);
  });

  it("rounds searched places to about a kilometre", () => {
    const [p] = parseNominatim([{ lat: "12.971599", lon: "77.594566", display_name: "Bengaluru, Bangalore North, Karnataka, India" }]);
    expect(p).toEqual({ label: "Bengaluru, India", lat: 12.97, lon: 77.59 });
    expect(parseNominatim({ error: "x" })).toEqual([]);
  });
});

// ---- store, modules, lifecycle ----------------------------------------------------------

describe("companion store", () => {
  it("survives garbage and keeps every good field of a partly bad blob", () => {
    expect(parseState("{not json")).toEqual(freshState());
    expect(parseState(JSON.stringify({ v: 2 }))).toEqual(freshState());
    const s = parseState(JSON.stringify({ v: 1, lastWrapDay: "2026-09-09", history: "nope", greet: { lastDay: "2026-09-10", lastLateDay: "" } }));
    expect(s.lastWrapDay).toBe("2026-09-09");
    expect(s.history).toEqual([]);
    expect(s.greet.lastDay).toBe("2026-09-10");
  });
});

describe("module framework (Phase 1)", () => {
  it("allows only legal state transitions, and never installs a corrupt download", () => {
    expect(transition("not-installed", "download")).toBe("downloading");
    expect(transition("downloading", "pause")).toBe("paused");
    expect(transition("paused", "resume")).toBe("downloading");
    expect(transition("downloading", "downloaded")).toBe("verifying");
    expect(transition("verifying", "corrupt")).toBe("error");
    expect(transition("verifying", "verified")).toBe("installed");
    expect(transition("installed", "remove")).toBe("not-installed");
    expect(transition("not-installed", "verified")).toBeNull();
    expect(transition("installed", "download")).toBeNull();
  });

  it("offers each action only where it makes sense (Phase 2: downloads unlocked)", () => {
    expect(canDo(notInstalled("voice"), "download")).toBe(true);
    expect(canDo(notInstalled("chat"), "remove")).toBe(false);
    expect(canDo({ ...notInstalled("chat"), state: "installed" }, "download")).toBe(false);
    expect(canDo({ ...notInstalled("chat"), state: "downloading" }, "pause")).toBe(true);
    expect(canDo({ ...notInstalled("chat"), state: "paused" }, "resume")).toBe(true);
    expect(canDo({ ...notInstalled("chat"), state: "verifying" }, "cancel")).toBe(false);
    expect(canDo({ ...notInstalled("voice"), state: "error" }, "retry")).toBe(true);
  });

  it("offers Voice Chat only when both independent modules are installed", () => {
    const installed = (id: "voice" | "chat"): ModuleStatus => ({ ...notInstalled(id), state: "installed" });
    expect(voiceChatAvailable(notInstalled("voice"), notInstalled("chat"))).toBe(false);
    expect(voiceChatAvailable(installed("voice"), notInstalled("chat"))).toBe(false);
    expect(voiceChatAvailable(notInstalled("voice"), installed("chat"))).toBe(false);
    expect(voiceChatAvailable(installed("voice"), installed("chat"))).toBe(true);
  });
});

describe("ModelLifecycleManager", () => {
  function env() {
    const timers = new Map<number, () => void>();
    let id = 0;
    const e: LifecycleEnv = { setTimer: (fn) => (timers.set(++id, fn), id), clearTimer: (h) => timers.delete(h as number), cpuThreads: 8 };
    return { e, fireAll: async () => { for (const [k, fn] of [...timers]) { timers.delete(k); fn(); } await Promise.resolve(); await Promise.resolve(); }, count: () => timers.size };
  }
  const loader = () => ({ load: vi.fn(async (_opts: { threads: number }) => undefined), unload: vi.fn(async () => undefined) });

  it("keeps models unloaded until a session asks, and unloads after the grace period", async () => {
    const { e, fireAll, count } = env();
    const m = new ModelLifecycleManager(e);
    const l = loader();
    m.register("chat", l);
    expect(m.state("chat")).toBe("unloaded");
    expect(l.load).not.toHaveBeenCalled();
    await m.acquire("chat");
    await m.acquire("chat"); // same session, no reload
    expect(l.load).toHaveBeenCalledTimes(1);
    expect(l.load.mock.calls[0][0].threads).toBe(4); // Balanced: half the cores
    m.release("chat");
    expect(count()).toBe(0); // still held once
    m.release("chat");
    expect(count()).toBe(1);
    await fireAll();
    expect(m.state("chat")).toBe("unloaded");
    expect(l.unload).toHaveBeenCalledTimes(1);
  });

  it("uses fewer threads and a shorter grace period in Battery Saver", () => {
    const m = new ModelLifecycleManager(env().e);
    m.setMode("saver");
    expect(m.threads()).toBe(2);
    expect(m.idleUnloadMs()).toBe(20_000);
  });

  it("isolates a failed load and an absent module", async () => {
    const m = new ModelLifecycleManager(env().e);
    await expect(m.acquire("voice")).rejects.toThrow("not installed");
    m.register("voice", { load: async () => Promise.reject(new Error("corrupt model")), unload: async () => undefined });
    await expect(m.acquire("voice")).rejects.toThrow("corrupt model");
    expect(m.state("voice")).toBe("failed");
    expect(m.anyLoaded()).toBe(false);
  });
});

// ---- the engine, end to end with a fake host ----------------------------------------------

function harness(settingsPatch: Partial<CompanionSettings> = {}, opts: ConstructorParameters<typeof CompanionEngine>[2] = {}) {
  let now = Date.UTC(2026, 8, 10, 3, 30); // 09:00 IST, a Thursday
  let settings = sanitizeCompanion({ ...DEFAULT_COMPANION, preferredName: "Sandy", ...settingsPatch });
  const ctx: HostContext = { focus: false, fullscreen: false, slotBusy: false, idleSeconds: 5, catVisible: true, online: true };
  const shown: CompanionNote[] = [];
  const played: string[] = [];
  const host: CompanionHost = {
    now: () => now,
    tz: () => IST,
    osLanguage: () => "en-IN",
    settings: () => settings,
    context: () => ctx,
    show: (n) => shown.push(n),
    play: (a) => played.push(a),
    dayCounts: () => ({ focusSessions: 2, remindersDone: 3 }),
    remindersToday: () => 1,
    mailCounts: () => ({ unread: 4, important: 2 }),
    save: () => undefined,
  };
  const engine = new CompanionEngine(host, freshState(), { gap: async () => undefined, ...opts });
  return {
    engine,
    ctx,
    shown,
    played,
    advance: (ms: number) => (now += ms),
    set: (p: Partial<CompanionSettings>) => (settings = { ...settings, ...p }),
    now: () => now,
  };
}
const istEv = (summary: string, istH: number, istM: number, extra: Partial<CalEventRaw> = {}) => {
  const t = new Date(Date.UTC(2026, 8, 10, istH, istM) - 330 * MIN);
  return ev(summary, t.getUTCHours(), t.getUTCMinutes(), { day: t.getUTCDate(), ...extra });
};

describe("CompanionEngine", () => {
  it("greets once in the morning with My Day, and plays the stretch", () => {
    const h = harness();
    h.engine.tick();
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].lines[0]).toBe("Good morning, Sandy ☀️");
    expect(h.shown[0].lines).toContain("2 important emails");
    expect(h.played).toEqual(["stretch"]);
    h.advance(MIN);
    h.engine.tick();
    expect(h.shown).toHaveLength(1);
  });

  it("does nothing at all when the companion is off", () => {
    const h = harness({ enabled: false });
    h.engine.tick();
    expect(h.shown).toEqual([]);
  });

  it("announces a calendar change with safe actions only", () => {
    const h = harness();
    h.engine.tick(); // greeting out of the way
    h.engine.onCalendar([istEv("Product Review", 16, 0, { uid: "pr", link: "https://meet.google.com/abc-defg-hij" })]);
    h.engine.onCalendar([istEv("Product Review", 16, 30, { uid: "pr", link: "https://meet.google.com/abc-defg-hij" })]);
    h.engine.pump();
    const card = h.shown[1];
    expect(card.lines[0]).toBe("📅 Product Review moved from 4 PM to 4:30 PM.");
    expect(card.actions?.map((a) => a.label)).toEqual(["Open Meeting", "Open Calendar"]);
    expect(card.actions?.every((a) => a.href?.startsWith("https://"))).toBe(true);
  });

  it("lets urgent notices through Focus only with Important Alerts on", () => {
    for (const importantAlerts of [true, false]) {
      const h = harness();
      h.set({ features: { ...DEFAULT_COMPANION.features, importantAlerts } });
      h.engine.tick();
      h.ctx.focus = true;
      h.engine.onCalendar([istEv("Standup", 9, 40, { uid: "s" })]);
      h.engine.onCalendar([istEv("Standup", 9, 40, { uid: "s", cancelled: true })]);
      h.engine.pump();
      expect(h.shown.length).toBe(importantAlerts ? 2 : 1);
    }
  });

  it("recaps a real absence - and does not manufacture one", () => {
    const h = harness();
    h.engine.tick();
    h.engine.onCalendar([istEv("4 PM Sync", 16, 0, { uid: "sync" })]);
    h.ctx.idleSeconds = 11 * 60;
    h.engine.tick(); // away now
    h.engine.onCalendar([istEv("4 PM Sync", 16, 30, { uid: "sync" })]);
    h.engine.onMail([
      { uid: 1, from: "Priya", subject: "Re: contract approval", important: true },
      { uid: 2, from: "noreply@news.com", subject: "Digest" },
    ]);
    h.engine.pump();
    expect(h.shown).toHaveLength(1); // nothing shown to an empty room
    h.advance(25 * MIN);
    h.ctx.idleSeconds = 2;
    h.engine.tick();
    const recap = h.shown[1];
    expect(recap.lines.slice(0, 3)).toEqual(["Welcome back, Sandy.", "While you were away:", "2 emails arrived while you were away. One may need your attention."]);
    expect(recap.lines).toContain("Priya: Re: contract approval");
    expect(recap.lines).toContain("📅 4 PM Sync moved from 4 PM to 4:30 PM.");
    expect(recap.cat).toBe("wave");

    const quiet = harness();
    quiet.engine.tick();
    quiet.ctx.idleSeconds = 11 * 60;
    quiet.engine.tick();
    quiet.advance(25 * MIN);
    quiet.ctx.idleSeconds = 2;
    quiet.engine.tick();
    expect(quiet.shown[1].lines).toEqual(["Welcome back, Sandy."]);
  });

  it("offers the end-of-day wrap-up with tomorrow's first meeting", () => {
    const h = harness({ features: { ...DEFAULT_COMPANION.features, endOfDay: true, routineLearning: false, morningGreeting: false }, workHours: { enabled: true, start: 570, end: 1080 } });
    h.engine.onCalendar([ev("Standup", 4, 30, { day: 11, uid: "t" })]); // 10 AM IST tomorrow
    h.advance(8 * HOUR + 50 * MIN); // 17:50 IST
    h.engine.tick();
    const wrap = h.shown.find((n) => n.kind === "endOfDay")!;
    expect(wrap.lines).toEqual(["Looks like you're wrapping up.", "2 focus sessions completed", "3 reminders finished", "Tomorrow's first meeting: Standup at 10 AM"]);
  });

  it("treats an internet failure as a failure (for backoff) and never fetches while paused", async () => {
    const fetchWeather = vi.fn(async () => null);
    const h = harness({ features: { ...DEFAULT_COMPANION.features, weather: true }, location: { mode: "city", label: "Bengaluru", lat: 12.97, lon: 77.59 } }, { fetchWeather });
    expect(await h.engine.refreshWeather()).toBe(false);
    expect(h.shown).toEqual([]);
    h.set({ internetPaused: true });
    expect(await h.engine.refreshWeather()).toBe(true);
    expect(fetchWeather).toHaveBeenCalledTimes(1);
  });

  it("surfaces weather through the notification engine, with the cat's reaction", async () => {
    const start = Date.UTC(2026, 8, 10, 3); // 08:30 IST
    const s = snap((i) => (i === 3 ? { precip: 5, symbol: "heavyrain" } : {}), 40, start);
    const h = harness({ features: { ...DEFAULT_COMPANION.features, weather: true, morningGreeting: false }, location: { mode: "city", label: "X", lat: 1, lon: 1 } }, { fetchWeather: async () => s });
    expect(await h.engine.refreshWeather()).toBe(true);
    h.engine.pump();
    expect(h.shown[0].lines[0]).toBe("Heavy rain's coming, Sandy. Expected around 11:30 AM.");
    expect(h.played).toContain("lookUp");
    await h.engine.refreshWeather();
    h.engine.pump();
    expect(h.shown).toHaveLength(1); // said once
  });

  it("uses the first news fetch as a silent baseline, then at most one headline a day", async () => {
    let batch: Headline[] = [{ url: "https://x/1", title: "F1: Old news headline here", domain: "x", seen: 1 }];
    const h = harness({ features: { ...DEFAULT_COMPANION.features, news: true, morningGreeting: false }, interests: ["Formula 1"] }, { fetchHeadlines: async () => batch });
    await h.engine.refreshNews();
    h.engine.pump();
    expect(h.shown).toEqual([]);
    batch = [{ url: "https://x/2", title: "F1: A genuinely new headline", domain: "x", seen: 2 }, ...batch];
    await h.engine.refreshNews();
    h.engine.pump();
    expect(h.shown[0].lines[0]).toBe("📰 Formula 1: F1: A genuinely new headline");
    batch = [{ url: "https://x/3", title: "F1: Yet another new headline", domain: "x", seen: 3 }, ...batch];
    await h.engine.refreshNews();
    h.advance(7 * HOUR);
    h.engine.pump();
    expect(h.shown).toHaveLength(1);
  });

  it("checks watches, remembers Last Checked, and fires once", async () => {
    const watches = [{ id: "fx1", kind: "fx" as const, label: "", paused: false, base: "USD", quote: "INR", threshold: 90, direction: "above" as const, phrase: "" }];
    let rate = 90.5;
    const h = harness({ features: { ...DEFAULT_COMPANION.features, watchlists: true, morningGreeting: false }, watches }, { fetchRate: async () => rate });
    await h.engine.refreshWatches();
    h.engine.pump();
    expect(h.shown[0].lines[0]).toBe("👀 USD/INR is above 90 - now 90.50.");
    expect(h.engine.watchState("fx1").lastChecked).toBe(h.now());
    rate = 91;
    h.advance(HOUR);
    await h.engine.refreshWatches();
    h.engine.pump();
    expect(h.shown).toHaveLength(1);
  });

  it("learns the routine locally; reset forgets it, Delete History keeps it, Clear Data drops all", () => {
    const h = harness({ features: { ...DEFAULT_COMPANION.features, morningGreeting: false } });
    h.engine.tick();
    expect(h.engine.snapshot().routine.dayActiveMin).toBe(1);
    h.engine.deleteHistory();
    expect(h.engine.snapshot().routine.dayActiveMin).toBe(1);
    h.engine.resetRoutine();
    expect(h.engine.snapshot().routine.dayActiveMin).toBe(0);
    h.engine.tick();
    h.engine.clearData();
    expect(h.engine.snapshot()).toEqual(freshState());
  });

  it("does not learn when Routine Learning is off", () => {
    const h = harness({ features: { ...DEFAULT_COMPANION.features, routineLearning: false, morningGreeting: false } });
    h.engine.tick();
    expect(h.engine.snapshot().routine.dayActiveMin).toBe(0);
  });

  it("mentions going offline only after a while, and coming back", () => {
    const h = harness({ features: { ...DEFAULT_COMPANION.features, internet: true, morningGreeting: false } });
    h.ctx.online = false;
    h.engine.tick();
    expect(h.shown).toEqual([]);
    h.advance(3 * MIN);
    h.engine.tick();
    expect(h.shown[0].lines[0]).toBe("You're offline. I'll catch up when you're back.");
    h.ctx.online = true;
    h.advance(31 * MIN); // system notices have a 30-minute cooldown
    h.engine.tick();
    expect(h.shown[1].lines[0]).toBe("Back online.");
  });
});
