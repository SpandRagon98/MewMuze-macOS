//! CompanionEngine - the Personal Companion's brain, between the cat and the world.
//!
//!   scheduler jobs ──> refreshWeather / refreshNews / refreshWatches
//!   App callbacks  ──> onCalendar / onMail / tick (idle, focus, full-screen)
//!                            │
//!                  detectors decide what is MEANINGFUL
//!                            │
//!                  SmartNotificationEngine decides WHEN (or never)
//!                            │
//!                  host.show(note)  +  host.play(cat reaction)
//!
//! Everything app-specific arrives through `CompanionHost`, so the whole engine
//! runs under test with a fake clock and no Tauri. It owns no timers: the
//! CompanionScheduler calls it.

import type { CalEventRaw } from "../integrations/calendar";
import type { AnimationName } from "../types/cat";
import { AwayTracker, RECAP_AFTER_MS } from "./away";
import {
  backToBack,
  CALENDAR_DAY_URL,
  describeBackToBack,
  describeChange,
  describeTomorrowFirst,
  diffCalendar,
  toMeetings,
  tomorrowFirst,
  type Meeting,
} from "./calendarCompanion";
import { dayKey, dayPart, localParts, minuteOfDay } from "./clock";
import { datesDue, describeDate } from "./dates";
import { MIN_ACTIVE_FOR_WRAP_MIN, wrapUpDue, wrapUpLines, type DayCounts } from "./endOfDay";
import { decideGreeting } from "./greeting";
import { describeArrivals, needsAttention, type MailMsg } from "./mailCompanion";
import { myDayLines } from "./myDay";
import { companionGet, safeJson } from "./net";
import { fetchHeadlines, freshHeadlines, rememberHeadlines, shortTitle, type Headline } from "./news";
import { SmartNotificationEngine, type CompanionNote, type NoteAction, type NoteKind, type Priority } from "./notify";
import { awayHeading, greeting, resolveLang, welcomeBack, wrapUpHeading } from "./phrases";
import { inWindow, type CompanionSettings, type Watch } from "./profile";
import { activeMinutesToday, emptyRoutine, isEarlyStart, observeActivity, typicalFinish } from "./routine";
import { freshState, HISTORY_CAP, type CompanionState } from "./store";
import { detectTravel, describeTravel } from "./travel";
import { describeFx, evaluateFx, fetchRate, freshWatchState, keywordHit, type WatchState } from "./watchlists";
import {
  catReactionFor,
  describeWeatherEvent,
  detectWeatherEvents,
  isSunny,
  parseMet,
  rainTomorrowMm,
  weatherSummary,
  type WeatherEvent,
  type WeatherSnapshot,
} from "./weather";

export interface HostContext {
  /** A Focus session is running. */
  focus: boolean;
  fullscreen: boolean;
  /** Something else holds the one bubble. */
  slotBusy: boolean;
  /** Seconds since the last input anywhere (the existing privacy-safe signal). */
  idleSeconds: number;
  /** The cat can be seen (not full-screen, not switched off). */
  catVisible: boolean;
  online: boolean;
}

export interface CompanionHost {
  now(): number;
  tz(): string;
  osLanguage(): string;
  settings(): CompanionSettings;
  context(): HostContext;
  show(note: CompanionNote): void;
  play(anim: AnimationName): void;
  dayCounts(): DayCounts;
  remindersToday(): number;
  mailCounts(): { unread: number | null; important: number | null };
  save(state: CompanionState): void;
}

export interface EngineOptions {
  /** Pause between GDELT requests; GDELT asks for one request per 5 seconds. */
  gap?: (ms: number) => Promise<void>;
  fetchWeather?: (lat: number, lon: number) => Promise<WeatherSnapshot | null>;
  fetchHeadlines?: (phrase: string) => Promise<Headline[] | null>;
  fetchRate?: (base: string, quote: string) => Promise<number | null>;
}

/** Idle this briefly counts as "at the machine right now". */
const ACTIVE_WITHIN_S = 60;
const HOUR = 3_600_000;
const GDELT_GAP_MS = 5_500;
/** Offline for this long before the cat mentions it. */
const OFFLINE_NOTICE_MS = 2 * 60_000;
/** Cached headlines older than this are refetched for a briefing. */
const BRIEFING_STALE_MS = 3 * HOUR;

export async function fetchMetWeather(lat: number, lon: number): Promise<WeatherSnapshot | null> {
  const res = await companionGet("met", `/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`);
  return res.ok ? parseMet(safeJson(res.body), Date.now()) : null;
}

export class CompanionEngine {
  readonly notify: SmartNotificationEngine;
  private state: CompanionState;
  private away = new AwayTracker();
  private meetings: Meeting[] | null = null;
  /** Mail that arrived during the current absence, for the recap. */
  private awayMail: MailMsg[] = [];
  private offlineSince: number | null = null;
  private offlineAnnounced = false;
  private readonly gap: (ms: number) => Promise<void>;
  private readonly getWeather: (lat: number, lon: number) => Promise<WeatherSnapshot | null>;
  private readonly getHeadlines: (phrase: string) => Promise<Headline[] | null>;
  private readonly getRate: (base: string, quote: string) => Promise<number | null>;

  constructor(
    private readonly host: CompanionHost,
    initial: CompanionState = freshState(),
    opts: EngineOptions = {},
  ) {
    this.state = initial;
    this.notify = new SmartNotificationEngine({}, this.state.notify);
    this.gap = opts.gap ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.getWeather = opts.fetchWeather ?? fetchMetWeather;
    this.getHeadlines = opts.fetchHeadlines ?? fetchHeadlines;
    this.getRate = opts.fetchRate ?? fetchRate;
  }

  // ---- state ----------------------------------------------------------------

  snapshot(): Readonly<CompanionState> {
    return this.state;
  }

  watchState(id: string): WatchState {
    return this.state.watches[id] ?? freshWatchState();
  }

  private persist(): void {
    this.state.notify = this.notify.memory();
    this.host.save(this.state);
  }

  /** "Clear Companion Data": everything learned or remembered. Settings stay. */
  clearData(): void {
    this.state = freshState();
    this.notify.clear();
    this.awayMail = [];
    this.persist();
  }

  /** "Delete Local History": what was seen and said - not the learned routine. */
  deleteHistory(): void {
    this.state = {
      ...this.state,
      history: [],
      newsSeen: [],
      newsBaseline: [],
      newsNotifiedDay: {},
      headlines: {},
      calendar: null,
      weather: null,
    };
    this.notify.clear();
    this.awayMail = [];
    this.persist();
  }

  resetRoutine(): void {
    this.state.routine = emptyRoutine();
    this.persist();
  }

  // ---- the tick ---------------------------------------------------------------

  /** Local, cheap, every ~30 s. Never touches the network. */
  tick(): void {
    const s = this.host.settings();
    if (!s.enabled) return;
    const now = this.host.now();
    const tz = this.host.tz();
    const ctx = this.host.context();
    const f = s.features;
    const active = ctx.idleSeconds < ACTIVE_WITHIN_S;
    const lang = resolveLang(s.language, this.host.osLanguage());
    const today = dayKey(now, tz);

    const back = this.away.sample(ctx.idleSeconds, now);
    if (back) this.onReturn(back.awayMs, s, now);

    if (f.routineLearning && active) {
      this.state.routine = observeActivity(this.state.routine, now, tz);
      if (this.state.lastEarlyDay !== today && isEarlyStart(this.state.routine, now, tz)) {
        this.state.lastEarlyDay = today;
        this.submit({ id: `routine:early:${today}`, kind: "routine", priority: "low", lines: ["Early start today?"], cat: "stretch", expiresAt: now + 2 * HOUR }, s);
      }
    }

    if (f.morningGreeting && active && !ctx.fullscreen) {
      const g = decideGreeting(this.state.greet, now, tz, true);
      if (g) {
        this.state.greet = g.next;
        const line = greeting(g.part, lang, s.personality, s.preferredName);
        // The morning greeting IS My Day when there is a day worth summarising.
        const day = g.part === "morning" ? this.myDay(line) : [line];
        this.submit(
          {
            id: `greet:${g.part}:${today}`,
            kind: "greeting",
            priority: "normal",
            lines: day.length >= 3 ? day : [line],
            cat: g.cat,
            expiresAt: now + 90 * 60_000,
          },
          s,
        );
      }
    }

    if (active) {
      for (const due of datesDue(s.importantDates, now, tz)) {
        this.submit({ id: due.id, kind: "date", priority: "normal", lines: [describeDate(due, s.preferredName)], cat: due.when === "today" ? "happy" : undefined }, s);
      }
    }

    if (f.endOfDay && active) {
      const due = wrapUpDue({
        now,
        tz,
        work: s.workHours,
        typicalFinishMin: f.routineLearning ? typicalFinish(this.state.routine, now, tz) : null,
        activeMinToday: f.routineLearning ? activeMinutesToday(this.state.routine, now, tz) : MIN_ACTIVE_FOR_WRAP_MIN,
        lastWrapDay: this.state.lastWrapDay,
      });
      if (due) {
        this.state.lastWrapDay = today;
        const first = f.calendar && this.meetings ? tomorrowFirst(this.meetings, now, tz) : null;
        const tomorrow = first ? describeTomorrowFirst(first, s.timeFormat === "12h", tz).replace(/\.$/, "") : null;
        this.submit(
          { id: `eod:${today}`, kind: "endOfDay", priority: "low", lines: [wrapUpHeading(lang), ...wrapUpLines(this.host.dayCounts(), tomorrow)], cat: "wave", expiresAt: now + 2 * HOUR },
          s,
        );
      }
    }

    if (f.internet) this.watchConnectivity(ctx.online, now, s);

    this.pump();
    this.persist();
  }

  /** Show the next notice if the moment is right. Call when the bubble frees up too. */
  pump(): void {
    const s = this.host.settings();
    if (!s.enabled) return;
    const now = this.host.now();
    const ctx = this.host.context();
    const note = this.notify.next({
      now,
      focus: ctx.focus,
      fullscreen: ctx.fullscreen,
      quiet: inWindow(minuteOfDay(now, this.host.tz()), s.quietHours),
      slotBusy: ctx.slotBusy,
      away: this.away.isAway(),
    });
    if (!note) return;
    this.state.history = [{ at: now, kind: note.kind, text: note.lines[0] }, ...this.state.history].slice(0, HISTORY_CAP);
    this.host.show(note);
    if (note.cat && ctx.catVisible) this.host.play(note.cat);
  }

  // ---- inputs from the existing integrations ---------------------------------

  onCalendar(events: CalEventRaw[]): void {
    const s = this.host.settings();
    if (!s.enabled || !s.features.calendar) {
      this.meetings = null;
      return;
    }
    const now = this.host.now();
    const tz = this.host.tz();
    const h12 = s.timeFormat === "12h";
    const meetings = toMeetings(events);
    this.meetings = meetings;
    const { changes, snapshot } = diffCalendar(this.state.calendar, meetings, now);
    this.state.calendar = snapshot;

    for (const c of changes) {
      const soon = c.meeting.start - now;
      const priority: Priority = soon <= HOUR ? "urgent" : soon <= 2 * HOUR ? "high" : "normal";
      const actions: NoteAction[] = [];
      if (c.meeting.link && c.kind === "moved") actions.push({ id: "open-meeting", label: "Open Meeting", href: c.meeting.link });
      actions.push({ id: "open-calendar", label: "Open Calendar", href: CALENDAR_DAY_URL });
      this.submit(
        {
          id: `cal:${c.kind}:${c.meeting.id}:${c.meeting.start}`,
          kind: "calendar",
          priority,
          lines: [`📅 ${describeChange(c, h12, tz)}`],
          actions,
          group: "calendar",
          expiresAt: c.meeting.start,
          recap: this.away.isAway(),
        },
        s,
      );
    }

    const today = dayKey(now, tz);
    const run = backToBack(meetings, now, tz);
    if (run && this.state.lastB2BDay !== today && run[0].start > now) {
      this.state.lastB2BDay = today;
      this.submit({ id: `cal:b2b:${today}`, kind: "calendar", priority: "low", lines: [`📅 ${describeBackToBack(run, now, tz)}`], expiresAt: run[0].start }, s);
    }

    const trip = detectTravel(meetings, now, tz);
    if (trip) {
      this.submit(
        { id: `travel:${trip.meeting.id}:${trip.when}`, kind: "travel", priority: "low", lines: [`✈ ${describeTravel(trip, now, h12)}`], expiresAt: trip.meeting.start },
        s,
      );
    }
    this.persist();
  }

  /**
   * New mail from the existing Gmail poll. While the user is at the machine
   * the existing mail stack already shows it; the companion only keeps count
   * of what arrives during an absence, for the recap.
   */
  onMail(fresh: MailMsg[]): void {
    const s = this.host.settings();
    if (!s.enabled || !s.features.gmail || fresh.length === 0) return;
    if (this.away.isAway()) this.awayMail.push(...fresh);
  }

  /** Important unread messages among a batch (for My Day). */
  static importantCount(msgs: MailMsg[]): number {
    return msgs.filter((m) => m.unread !== false && needsAttention(m)).length;
  }

  // ---- network jobs (scheduled) -----------------------------------------------

  /** The last forecast fetched, for chat questions about the weather. */
  cachedWeather(): WeatherSnapshot | null {
    return this.state.weather;
  }

  async refreshWeather(): Promise<boolean> {
    const s = this.host.settings();
    const loc = s.location;
    if (!s.enabled || !s.features.weather || loc.lat === null || loc.lon === null || s.internetPaused) return true;
    const snap = await this.getWeather(loc.lat, loc.lon);
    if (!snap) return false;
    this.onWeather(snap);
    return true;
  }

  onWeather(snap: WeatherSnapshot): void {
    const s = this.host.settings();
    const now = this.host.now();
    const tz = this.host.tz();
    this.state.weather = snap;
    const { events, memory } = detectWeatherEvents(snap, now, tz, this.state.weatherMem);
    this.state.weatherMem = memory;
    for (const ev of events) this.submit(this.weatherNote(ev, s, now, tz), s);

    // The relaxed sunny-morning reaction: the cat only, no words.
    const ctx = this.host.context();
    const today = dayKey(now, tz);
    if (dayPart(localParts(now, tz).hour) === "morning" && this.state.lastSunnyDay !== today && isSunny(snap, now) && ctx.catVisible && ctx.idleSeconds < ACTIVE_WITHIN_S) {
      this.state.lastSunnyDay = today;
      this.host.play(catReactionFor("sunny") ?? "happy");
    }
    this.persist();
  }

  private weatherNote(ev: WeatherEvent, s: CompanionSettings, now: number, tz: string): CompanionNote {
    const soon = ev.at - now <= 2 * HOUR;
    const priority: Priority =
      ev.kind === "storm" ? (soon ? "urgent" : "high") : ev.kind === "heavyRain" ? "high" : "normal";
    const lasting = ev.kind === "heat" || ev.kind === "swing";
    return {
      id: ev.id,
      kind: "weather",
      priority,
      lines: [describeWeatherEvent(ev, s.preferredName, s.timeFormat === "12h", s.temperature, tz)],
      cat: catReactionFor(ev.kind),
      group: "weather",
      createdAt: now,
      // "Rain's coming" is stale once it is raining.
      expiresAt: lasting ? now + 8 * HOUR : ev.at + 30 * 60_000,
      recap: this.away.isAway(),
    };
  }

  async refreshNews(): Promise<boolean> {
    const s = this.host.settings();
    if (!s.enabled || !s.features.news || s.interests.length === 0 || s.internetPaused) return true;
    const now = this.host.now();
    const today = dayKey(now, this.host.tz());
    let anyOk = false;
    for (const [i, interest] of s.interests.entries()) {
      if (i > 0) await this.gap(GDELT_GAP_MS);
      const items = await this.getHeadlines(interest);
      if (!items) continue;
      anyOk = true;
      this.state.headlines[interest] = { at: now, items: items.slice(0, 5) };
      const fresh = freshHeadlines(items, this.state.newsSeen);
      this.state.newsSeen = rememberHeadlines(this.state.newsSeen, items);
      // The first fetch for an interest is a baseline: everything is "new" then.
      if (!this.state.newsBaseline.includes(interest)) {
        this.state.newsBaseline.push(interest);
        continue;
      }
      if (fresh.length && this.state.newsNotifiedDay[interest] !== today) {
        this.state.newsNotifiedDay[interest] = today;
        const top = fresh[0];
        this.submit(
          {
            id: `news:${top.url}`,
            kind: "news",
            priority: "low",
            lines: [`📰 ${interest}: ${shortTitle(top.title)}`],
            actions: [{ id: "open", label: "Open", href: top.url }],
            group: "news",
            expiresAt: now + 12 * HOUR,
          },
          s,
        );
      }
    }
    this.persist();
    return anyOk;
  }

  async refreshWatches(): Promise<boolean> {
    const s = this.host.settings();
    if (!s.enabled || !s.features.watchlists || s.internetPaused) return true;
    const now = this.host.now();
    const tz = this.host.tz();
    const today = dayKey(now, tz);
    const rates = new Map<string, number | null>();
    let failures = 0;
    let checked = 0;
    let firstNet = true;

    for (const w of s.watches.filter((x) => !x.paused)) {
      const st = this.watchState(w.id);
      if (w.kind === "fx") {
        const pair = `${w.base}/${w.quote}`;
        if (!rates.has(pair)) rates.set(pair, await this.getRate(w.base, w.quote));
        const rate = rates.get(pair) ?? null;
        checked++;
        if (rate === null) {
          failures++;
          this.state.watches[w.id] = { ...st, lastChecked: now, lastError: "Could not reach the rate service" };
          continue;
        }
        const r = evaluateFx(w, st, rate, now);
        this.state.watches[w.id] = r.state;
        if (r.fire) this.fireWatch(w, describeFx(w, rate), s, now);
      } else if (w.kind === "rain-tomorrow") {
        const snap = this.state.weather;
        checked++;
        if (!snap) {
          this.state.watches[w.id] = { ...st, lastChecked: now, lastError: "Needs Weather Awareness and a location" };
          continue;
        }
        const mm = rainTomorrowMm(snap, now, tz);
        const fire = mm >= 1 && st.lastFiredDay !== today;
        this.state.watches[w.id] = { ...st, lastChecked: now, lastValue: Math.round(mm * 10) / 10, lastFiredDay: fire ? today : st.lastFiredDay, lastError: null };
        if (fire) this.fireWatch(w, `Rain expected tomorrow (about ${Math.round(mm)} mm).`, s, now);
      } else {
        if (!firstNet) await this.gap(GDELT_GAP_MS);
        firstNet = false;
        const items = await this.getHeadlines(w.phrase);
        checked++;
        if (!items) {
          failures++;
          this.state.watches[w.id] = { ...st, lastChecked: now, lastError: "Could not reach the news service" };
          continue;
        }
        const hit = keywordHit(w.phrase, items.map((h) => h.title));
        const fire = hit !== null && st.lastFiredDay !== today;
        this.state.watches[w.id] = { ...st, lastChecked: now, lastFiredDay: fire ? today : st.lastFiredDay, lastError: null };
        if (fire) {
          const url = items.find((h) => h.title === hit)?.url;
          this.fireWatch(w, `In the news: ${shortTitle(hit!, 60)}`, s, now, url);
        }
      }
    }
    this.persist();
    return checked === 0 || failures < checked;
  }

  private fireWatch(w: Watch, line: string, s: CompanionSettings, now: number, href?: string): void {
    this.submit(
      {
        id: `watch:${w.id}:${line}`,
        kind: "watch",
        priority: "high",
        lines: [`👀 ${w.label ? `${w.label}: ` : ""}${line}`],
        actions: href ? [{ id: "open", label: "Open", href }] : undefined,
        group: "watch",
        expiresAt: now + 12 * HOUR,
        recap: this.away.isAway(),
      },
      s,
    );
  }

  // ---- on demand ------------------------------------------------------------

  /** The My Day card's lines. `greetingLine` replaces the default opener. */
  myDay(greetingLine?: string): string[] {
    const s = this.host.settings();
    const now = this.host.now();
    const tz = this.host.tz();
    const h12 = s.timeFormat === "12h";
    const lang = resolveLang(s.language, this.host.osLanguage());
    const part = dayPart(localParts(now, tz).hour);
    const mail = s.features.gmail ? this.host.mailCounts() : { unread: null, important: null };
    return myDayLines({
      now,
      tz,
      h12,
      greeting: greetingLine ?? greeting(part, lang, s.personality, s.preferredName),
      weather:
        s.features.weather && this.state.weather && now - this.state.weather.fetchedAt < 6 * HOUR
          ? weatherSummary(this.state.weather, now, tz, s.temperature, h12)
          : null,
      meetings: s.features.calendar ? this.meetings : null,
      work: s.workHours.enabled ? s.workHours : null,
      importantMail: mail.important,
      unreadMail: mail.unread,
      remindersToday: this.host.remindersToday(),
      dates: datesDue(s.importantDates, now, tz).filter((d) => d.when === "today"),
      dateLine: (d) => describeDate(d, s.preferredName),
    });
  }

  /** On-demand news briefing: cached headlines, refreshed if stale. */
  async briefing(): Promise<string[]> {
    const s = this.host.settings();
    if (!s.features.news || s.interests.length === 0) return ["Add an interest in Settings → Companion to get a briefing."];
    const now = this.host.now();
    const stale = s.interests.some((i) => !this.state.headlines[i] || now - this.state.headlines[i].at > BRIEFING_STALE_MS);
    if (stale && !s.internetPaused) await this.refreshNews();
    const lines: string[] = [];
    for (const i of s.interests) {
      const top = this.state.headlines[i]?.items[0];
      if (top) lines.push(`${i}: ${shortTitle(top.title, 60)}`);
    }
    return lines.length ? ["Your briefing:", ...lines.slice(0, 6)] : ["No fresh headlines for your interests right now."];
  }

  // ---- helpers ------------------------------------------------------------------

  private onReturn(awayMs: number, s: CompanionSettings, now: number): void {
    if (!s.features.whileAway) {
      this.awayMail = [];
      return;
    }
    const lang = resolveLang(s.language, this.host.osLanguage());
    const mail = this.awayMail;
    this.awayMail = [];
    if (awayMs < RECAP_AFTER_MS) return; // a coffee, not an absence
    const held = this.notify.drainRecap(now);
    const items = [...(describeArrivals(mail, true) ?? []).slice(0, 2), ...held.map((n) => n.lines[0])];
    // Nothing happened: no manufactured recap. The cat just says hello.
    const lines = items.length ? [welcomeBack(lang, s.preferredName), awayHeading(lang), ...items.slice(0, 5)] : [welcomeBack(lang, s.preferredName)];
    const actions = held.flatMap((n) => n.actions ?? []).filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i);
    this.submit(
      { id: `away:${now}`, kind: "away", priority: items.length ? "high" : "low", lines, cat: "wave", actions: actions.slice(0, 2), expiresAt: now + HOUR },
      s,
    );
  }

  private watchConnectivity(online: boolean, now: number, s: CompanionSettings): void {
    if (!online) {
      this.offlineSince ??= now;
      if (!this.offlineAnnounced && now - this.offlineSince >= OFFLINE_NOTICE_MS) {
        this.offlineAnnounced = true;
        this.submit({ id: `net:off:${this.offlineSince}`, kind: "system", priority: "low", lines: ["You're offline. I'll catch up when you're back."], expiresAt: now + HOUR }, s);
      }
      return;
    }
    if (this.offlineAnnounced) {
      this.submit({ id: `net:on:${now}`, kind: "system", priority: "low", lines: ["Back online."], expiresAt: now + 10 * 60_000 }, s);
    }
    this.offlineSince = null;
    this.offlineAnnounced = false;
  }

  private submit(note: Omit<CompanionNote, "createdAt"> & { createdAt?: number }, s: CompanionSettings): void {
    const now = this.host.now();
    // Without Important Alerts nothing may break through Focus or quiet hours.
    const priority: Priority = note.priority === "urgent" && !s.features.importantAlerts ? "high" : note.priority;
    this.notify.submit({ ...note, priority, createdAt: note.createdAt ?? now }, now);
  }
}

export type { NoteKind };
