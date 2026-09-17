//! Settings pages for the Personal Companion (Paper build): Companion, Voice,
//! Chat, the companion half of Notifications, and Privacy & Battery.
//!
//! Plain words on the surface; engine names, model files and diagnostics sit
//! behind "Technical details" or "Advanced".

import { useEffect, useState } from "react";
import type { CompanionSettings, CompanionFeatures, ConversationStyle, ImportantDate, ImportantDateKind, Personality, PowerMode, Watch, WatchKind } from "../companion/profile";
import { MAX_INTERESTS, MAX_WATCHES, SHORTCUT_PATTERN } from "../companion/profile";
import { ACTIONS, LITE_RECOMMENDED_MB, MODULES, STATE_LABEL, formatBytes, notInstalled, usable, voiceChatAvailable, type ModuleAction, type ModuleId, type ModuleSpec, type ModuleStatus } from "../companion/modules";
import { NET_SERVICES, type NetStats } from "../companion/net";
import { deviceLocation, searchCity, type Place } from "../companion/location";
import type { HistoryEntry } from "../companion/store";
import type { WatchState } from "../companion/watchlists";
import type { JobStats } from "../companion/scheduler";
import type { PowerStatus } from "../companion/power";
import { PROVIDERS, tauriProviders, testConnection, type ExternalId, type ProviderBridge } from "../companion/providers";
import { confirmAction } from "./ConfirmDialog";
import { Icon, type IconName } from "./icons";
import { Advanced, Page, Row, Section, Select, Toggle } from "./settingsKit";

export interface CompanionStatus {
  timeZone: string;
  history: HistoryEntry[];
  watches: Record<string, WatchState>;
  routine: { typicalStart: number | null; typicalFinish: number | null; daysLearned: number };
  scheduler: { wakeups: number; runs: number; networkRuns: number; failures: number; jobs: JobStats[] };
  net: NetStats | null;
  power: PowerStatus;
  effectiveMode: PowerMode;
  weatherUpdated: number | null;
  /** Local AI right now: what is installed and what is running. */
  ai?: { voice: string; chat: string; chatLoaded: boolean; chatMemoryMB: number; voiceBusy?: boolean; totalMemoryMB?: number };
}

export interface CompanionPanelApi {
  status: () => Promise<CompanionStatus>;
  clearData: () => void;
  deleteHistory: () => void;
  resetRoutine: () => void;
  showMyDay: () => void;
  briefing: () => void;
  checkWatches: () => void;
  modules: {
    status: (id: ModuleId) => Promise<ModuleStatus>;
    download: (id: ModuleId) => Promise<void>;
    pause: (id: ModuleId) => Promise<void>;
    cancel: (id: ModuleId) => Promise<void>;
    /** Resolves with the bytes freed. */
    remove: (id: ModuleId) => Promise<number>;
    subscribe: (cb: (id: ModuleId) => void) => Promise<() => void>;
  };
  memory: {
    /** Everything MewMuze keeps between chats, in plain words. */
    list: () => Promise<{ id: string; label: string }[]>;
    forget: (id: string) => Promise<void>;
    clear: () => Promise<void>;
  };
  /** The Diary - the user's own record, separate from memory. */
  diary?: {
    count: () => Promise<number>;
    clear: () => Promise<void>;
    dir: () => Promise<string>;
  };
}

type SetC = (patch: Partial<CompanionSettings>) => void;
interface PageProps {
  value: CompanionSettings;
  onChange: (next: CompanionSettings) => void;
  api: CompanionPanelApi | null;
}

const FEATURES: { key: keyof CompanionFeatures; label: string; hint: string }[] = [
  { key: "morningGreeting", label: "Morning greeting", hint: "Says hello the first time you sit down each day." },
  { key: "weather", label: "Weather", hint: "Speaks up only for rain, storms, heat, cold or a big change." },
  { key: "calendar", label: "Calendar", hint: "Mentions moved, cancelled or back-to-back meetings." },
  { key: "gmail", label: "Email", hint: "Points out mail that may need you — sender and subject only." },
  { key: "routineLearning", label: "Learn my routine", hint: "Notices when you usually start, finish and are heads-down, on this computer only." },
  { key: "whileAway", label: "While you were away", hint: "A short recap when you come back, only if something happened." },
  { key: "endOfDay", label: "End-of-day wrap-up", hint: "A gentle look back at the day. No scores." },
  { key: "internet", label: "Internet status", hint: "Tells you when you go offline and come back." },
  { key: "news", label: "News about my interests", hint: "Only topics you choose, at most once a day each." },
  { key: "watchlists", label: "My watches", hint: "Your own \"tell me when…\" checks." },
];

const MODE_INFO: Record<PowerMode, { label: string; hint: string }> = {
  balanced: { label: "Balanced", hint: "Recommended for most people." },
  saver: { label: "Battery Saver", hint: "Uses less processing power." },
  performance: { label: "Performance", hint: "Faster chat replies." },
};

const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromHHMM = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
};
const ago = (t: number | null) => {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};
const every = (ms: number) => (ms >= 3_600_000 ? `every ${+(ms / 3_600_000).toFixed(1)} h` : `every ${Math.round(ms / 60_000)} min`);
const newId = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Live companion numbers, polled only while a page that shows them is open. */
export function useCompanionStatus(api: CompanionPanelApi | null, on = true): CompanionStatus | null {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  useEffect(() => {
    if (!on || !api) return;
    let alive = true;
    const pull = () => void api.status().then((s) => alive && setStatus(s));
    pull();
    const t = setInterval(pull, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, on]);
  return status;
}

// ---- modules ------------------------------------------------------------------

const ACTION_LABEL: Record<ModuleAction, string> = {
  download: "Download",
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel",
  retry: "Try again",
  remove: "Remove",
  update: "Update",
};

/** Install state of both optional modules, kept live while mounted. */
export function useModules(api: CompanionPanelApi | null) {
  const [status, setStatus] = useState<Partial<Record<ModuleId, ModuleStatus>>>({});
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const refresh = (id: ModuleId) => void api.modules.status(id).then((s) => alive && setStatus((prev) => ({ ...prev, [id]: s })));
    MODULES.forEach((m) => refresh(m.id));
    let stop = () => {};
    void api.modules.subscribe(refresh).then((s) => (alive ? (stop = s) : s()));
    return () => {
      alive = false;
      stop();
    };
  }, [api]);

  const act = async (id: ModuleId, action: ModuleAction) => {
    if (!api) return;
    setNote("");
    const m = MODULES.find((x) => x.id === id)!;
    try {
      if (action === "download" || action === "resume" || action === "retry" || action === "update") {
        if (
          action === "download" &&
          !(await confirmAction({
            title: `Download ${m.name}?`,
            message: `${formatBytes(m.downloadBytes)} from the official sources. Every file is checked before it is installed.`,
            confirmLabel: "Download",
          }))
        )
          return;
        await api.modules.download(id);
      } else if (action === "pause") await api.modules.pause(id);
      else if (action === "cancel") await api.modules.cancel(id);
      else if (action === "remove") {
        if (!(await confirmAction({ title: `Remove ${m.name}?`, message: "Its files are deleted now. Your settings stay.", confirmLabel: "Remove", danger: true }))) return;
        const freed = await api.modules.remove(id);
        setNote(`${m.name} removed — ${formatBytes(freed)} freed.`);
      }
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e));
    }
    const s = await api.modules.status(id);
    setStatus((prev) => ({ ...prev, [id]: s }));
  };
  const get = (id: ModuleId) => status[id] ?? notInstalled(id);
  return { get, act, note };
}

const MODULE_ICON: Record<ModuleId, IconName> = { voice: "mic", chat: "chat", "chat-lite": "chat" };

export function ModuleCard({ spec, status: st, onAct, disabled = false }: { spec: ModuleSpec; status: ModuleStatus; onAct: (a: ModuleAction) => void; disabled?: boolean }) {
  const busy = st.state === "downloading" || st.state === "verifying" || st.state === "installing";
  const ok = usable(st);
  const pct = Math.round(st.progress * 100);
  return (
    <div className="mm-card mm-module">
      <span className="mm-module-icon">
        <Icon name={MODULE_ICON[spec.id]} size={22} />
      </span>
      <div>
        <h3 className="mm-module-title">
          {spec.name}
          <span className={`mm-badge${ok ? " ok" : st.state === "error" ? " danger" : busy ? " info" : ""}`}>{STATE_LABEL[st.state]}</span>
        </h3>
        <p className="mm-module-text">{spec.tagline}</p>
        <p className="mm-module-meta">
          Runs on your computer · {ok ? `Uses ${formatBytes(st.storageBytes)} of storage` : `Download ${formatBytes(spec.downloadBytes)}`}
        </p>
      </div>
      <div className="mm-module-actions">
        {ACTIONS[st.state].map((a) => (
          <button key={a} className={`mm-btn${a === "download" || a === "resume" || a === "retry" || a === "update" ? " primary" : a === "remove" ? " danger" : ""}`} disabled={disabled} onClick={() => onAct(a)}>
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>
      <div className="mm-module-extra">
        {(busy || st.state === "paused") && (
          <div className="module-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${pct}%` }} />
            <em>
              {STATE_LABEL[st.state]} · {formatBytes(st.bytesDone)} of {formatBytes(st.bytesTotal ?? spec.downloadBytes)} ({pct}%)
            </em>
          </div>
        )}
        {st.error && <p className="cmp-error">{st.error}</p>}
        <details className="mm-tech">
          <summary>Technical details</summary>
          <dl>
            <dt>Engine</dt>
            <dd>{spec.engine}</dd>
            <dt>Model</dt>
            <dd>{spec.model}</dd>
            <dt>Licence</dt>
            <dd>{spec.license}</dd>
            <dt>Version</dt>
            <dd>{st.version ?? "—"}</dd>
            <dt>Download</dt>
            <dd>{formatBytes(spec.downloadBytes)}, checked against published SHA-256 fingerprints</dd>
            <dt>Privacy</dt>
            <dd>{spec.privacy}</dd>
          </dl>
        </details>
      </div>
    </div>
  );
}

// ---- Companion ------------------------------------------------------------------

export function CompanionPage({ value: c, onChange, api, gmailConnected, calendarConnected }: PageProps & { gmailConnected: boolean; calendarConnected: boolean }) {
  const set: SetC = (patch) => onChange({ ...c, ...patch });
  const setFeature = (k: keyof CompanionFeatures, v: boolean) => set({ features: { ...c.features, [k]: v } });
  const status = useCompanionStatus(api);
  return (
    <Page title="Personal Companion" sub="MewMuze keeps an eye on your day and only speaks up when something matters.">
      <Section>
        <Toggle label="Personal Companion" hint="Off means the cat behaves exactly as before." checked={c.enabled} onChange={(v) => set({ enabled: v })} />
        <Row label="My Day" hint="Your day on one small card. Also in the cat's menu.">
          <button className="mm-btn" disabled={!api} onClick={() => api?.showMyDay()}>
            Show My Day
          </button>
        </Row>
      </Section>

      <Profile c={c} set={set} />

      <Section title="Smart updates" sub="Choose what MewMuze pays attention to.">
        {FEATURES.map((f) => {
          const needs = f.key === "gmail" && !gmailConnected ? "Connect Gmail in Connections first." : f.key === "calendar" && !calendarConnected ? "Connect Google Calendar in Connections first." : null;
          return <Toggle key={f.key} label={f.label} hint={needs ?? f.hint} checked={c.features[f.key]} onChange={(v) => setFeature(f.key, v)} />;
        })}
      </Section>

      <Awareness c={c} set={set} api={api} />
      <ImportantDates c={c} set={set} />

      <Advanced label="Watches and routine">
        <Watches c={c} set={set} status={status} api={api} />
      </Advanced>
    </Page>
  );
}

function Profile({ c, set }: { c: CompanionSettings; set: SetC }) {
  return (
    <Section title="About you">
      <Row label="What should MewMuze call you?" hint="Leave empty to use the name in Tools.">
        <input className="sk-input" aria-label="Preferred name" maxLength={40} placeholder="Sandy" value={c.preferredName} onChange={(e) => set({ preferredName: e.target.value })} />
      </Row>
      <Select label="Language" hint="How MewMuze talks to you." value={c.language} options={[["auto", "Match my computer"], ["en", "English"], ["hi", "Hindi"], ["hinglish", "Hinglish"]] as const} onChange={(v) => set({ language: v })} />
      <Select label="Time format" value={c.timeFormat} options={[["12h", "12-hour"], ["24h", "24-hour"]] as const} onChange={(v) => set({ timeFormat: v })} />
      <Select label="Temperature" value={c.temperature} options={[["c", "Celsius"], ["f", "Fahrenheit"]] as const} onChange={(v) => set({ temperature: v })} />
      <Row label="Personality" hint="How MewMuze sounds in messages and chat.">
        <div className="sk-chips">
          {(["cozy", "playful", "savage", "minimal", "professional"] as Personality[]).map((p) => (
            <button key={p} className={`sk-chip${c.personality === p ? " on" : ""}`} aria-pressed={c.personality === p} onClick={() => set({ personality: p })}>
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </Row>
      <Toggle label="Work hours" hint="Used for free-time suggestions and the wrap-up." checked={c.workHours.enabled} onChange={(v) => set({ workHours: { ...c.workHours, enabled: v } })} />
      {c.workHours.enabled && (
        <Row label="Work from / to">
          <div className="sk-stepper">
            <input type="time" className="sk-input" aria-label="Work starts" value={toHHMM(c.workHours.start)} onChange={(e) => set({ workHours: { ...c.workHours, start: fromHHMM(e.target.value) } })} />
            <span className="sk-sep">–</span>
            <input type="time" className="sk-input" aria-label="Work ends" value={toHHMM(c.workHours.end)} onChange={(e) => set({ workHours: { ...c.workHours, end: fromHHMM(e.target.value) } })} />
          </div>
        </Row>
      )}
    </Section>
  );
}

function Awareness({ c, set, api }: { c: CompanionSettings; set: SetC; api: CompanionPanelApi | null }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [locMsg, setLocMsg] = useState("");
  const [interest, setInterest] = useState("");
  const choosePlace = (p: Place, mode: "city" | "device") => {
    set({ location: { mode, label: p.label, lat: p.lat, lon: p.lon } });
    setResults(null);
    setLocMsg("");
  };
  return (
    <>
      <Section title="Weather location">
        <Row label={c.location.mode === "off" ? "No location set" : c.location.label || "Approximate location"} hint="Rounded to about 1 km. Forecast by MET Norway (CC BY 4.0).">
          {c.location.mode !== "off" && (
            <button className="mm-btn" onClick={() => set({ location: { mode: "off", label: "", lat: null, lon: null } })}>
              Clear
            </button>
          )}
        </Row>
        <Row label="Find a city">
          <div className="sk-stepper">
            <input className="sk-input" placeholder="e.g. Bengaluru" aria-label="City" maxLength={80} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && query.trim().length > 1 && void searchCity(query).then(setResults)} />
            <button className="mm-btn" disabled={query.trim().length < 2 || c.internetPaused} onClick={() => void searchCity(query).then(setResults)}>
              Search
            </button>
          </div>
        </Row>
        {results && results.length === 0 && <Row label="No places found" hint="Or the search could not be reached." />}
        {results?.map((p) => (
          <Row key={`${p.lat},${p.lon}`} label={p.label} hint="Search by OpenStreetMap Nominatim · © OpenStreetMap contributors">
            <button className="mm-btn" onClick={() => choosePlace(p, "city")}>
              Use
            </button>
          </Row>
        ))}
        <Row label="Use my approximate location" hint={locMsg || "Asks Windows once. Nothing is tracked."}>
          <button className="mm-btn" onClick={() => void deviceLocation().then((p) => (p ? choosePlace(p, "device") : setLocMsg("Windows location is off or unavailable — type a city instead.")))}>
            Locate
          </button>
        </Row>
      </Section>

      <Section title="Interests" sub="Topics MewMuze may bring you news about.">
        <Row label="Your topics" hint={c.interests.length === 0 ? 'None yet — try "Formula 1" or "Microsoft".' : undefined} stack>
          <div className="sk-chips">
            {c.interests.map((i) => (
              <button key={i} className="sk-chip on" aria-label={`Remove ${i}`} onClick={() => set({ interests: c.interests.filter((x) => x !== i) })}>
                {i} <Icon name="close" size={12} />
              </button>
            ))}
          </div>
          <div className="sk-stepper">
            <input className="sk-input" placeholder="Add a topic" aria-label="Add a topic" maxLength={40} value={interest} onChange={(e) => setInterest(e.target.value)} />
            <button
              className="mm-btn"
              disabled={interest.trim().length < 2 || c.interests.length >= MAX_INTERESTS}
              onClick={() => {
                if (!c.interests.includes(interest.trim())) set({ interests: [...c.interests, interest.trim()] });
                setInterest("");
              }}
            >
              Add
            </button>
          </div>
        </Row>
        <Row label="Brief me now" hint="Headlines for your topics, on request. Source: GDELT Project.">
          <button className="mm-btn" disabled={!api || !c.features.news || c.interests.length === 0} onClick={() => api?.briefing()}>
            Brief me
          </button>
        </Row>
      </Section>
    </>
  );
}

function ImportantDates({ c, set }: { c: CompanionSettings; set: SetC }) {
  const [draft, setDraft] = useState({ label: "", kind: "birthday" as ImportantDateKind, date: "", yearly: true });
  const addDate = () => {
    const [y, m, d] = draft.date.split("-").map(Number);
    if (!draft.label.trim() || !m || !d) return;
    const next: ImportantDate = { id: newId("date"), label: draft.label.trim(), kind: draft.kind, month: m, day: d, year: draft.yearly ? null : y, dayBefore: true };
    set({ importantDates: [...c.importantDates, next] });
    setDraft({ ...draft, label: "", date: "" });
  };
  return (
    <Section title="Important dates" sub="Birthdays and big days. MewMuze reminds you the day before.">
      {c.importantDates.map((d) => (
        <Row key={d.id} label={d.label} hint={`${d.kind} · ${d.day}/${d.month}${d.year ? `/${d.year}` : " · every year"}`}>
          <button className="mm-btn" onClick={() => set({ importantDates: c.importantDates.filter((x) => x.id !== d.id) })}>
            Delete
          </button>
        </Row>
      ))}
      <Row label="Add a date" stack>
        <div className="sk-stepper">
          <input className="sk-input" placeholder="Riya's birthday" aria-label="What is it?" maxLength={60} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          <select className="sk-input" aria-label="Kind" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ImportantDateKind })}>
            <option value="birthday">Birthday</option>
            <option value="anniversary">Anniversary</option>
            <option value="interview">Interview</option>
            <option value="deadline">Deadline</option>
            <option value="event">Personal event</option>
          </select>
          <input type="date" className="sk-input" aria-label="Date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
          <label className="sk-hint">
            <input type="checkbox" checked={draft.yearly} onChange={(e) => setDraft({ ...draft, yearly: e.target.checked })} /> Every year
          </label>
          <button className="mm-btn primary" disabled={!draft.label.trim() || !draft.date} onClick={addDate}>
            Add
          </button>
        </div>
      </Row>
    </Section>
  );
}

function Watches({ c, set, status, api }: { c: CompanionSettings; set: SetC; status: CompanionStatus | null; api: CompanionPanelApi | null }) {
  const [kind, setKind] = useState<WatchKind>("fx");
  const [draft, setDraft] = useState({ base: "USD", quote: "INR", threshold: "90", direction: "above" as "above" | "below", phrase: "" });
  const add = () => {
    const w: Watch = {
      id: newId("watch"),
      kind,
      label: kind === "fx" ? `${draft.base}/${draft.quote} ${draft.direction} ${draft.threshold}` : kind === "rain-tomorrow" ? "Rain tomorrow" : draft.phrase.trim(),
      paused: false,
      base: draft.base.toUpperCase(),
      quote: draft.quote.toUpperCase(),
      threshold: Number(draft.threshold) || 0,
      direction: draft.direction,
      phrase: draft.phrase.trim(),
    };
    set({ watches: [...c.watches, w] });
  };
  const valid = kind === "fx" ? /^[A-Za-z]{3}$/.test(draft.base) && /^[A-Za-z]{3}$/.test(draft.quote) && Number(draft.threshold) > 0 : kind === "keyword" ? draft.phrase.trim().length >= 2 : true;
  return (
    <>
      <h3 className="mm-section-title">My watches</h3>
      {!c.features.watchlists && <Row label="My watches is off" hint="Watches are kept but not checked. Turn it on in Smart updates." />}
      {c.watches.length === 0 && <Row label="Nothing watched yet" hint="Create one below." />}
      {c.watches.map((w) => {
        const st = status?.watches[w.id];
        return (
          <Row
            key={w.id}
            label={w.label || w.phrase}
            hint={
              <>
                {w.paused ? "Paused" : `Last checked ${ago(st?.lastChecked ?? null)}`}
                {st?.lastValue !== null && st?.lastValue !== undefined && ` · now ${st.lastValue}`}
                {st?.lastError && ` · ${st.lastError}`}
              </>
            }
          >
            <div className="sk-stepper">
              <button className="mm-btn" onClick={() => set({ watches: c.watches.map((x) => (x.id === w.id ? { ...x, paused: !x.paused } : x)) })}>
                {w.paused ? "Resume" : "Pause"}
              </button>
              <button className="mm-btn" onClick={() => set({ watches: c.watches.filter((x) => x.id !== w.id) })}>
                Delete
              </button>
            </div>
          </Row>
        );
      })}
      <Row label="Check now" hint="Currency: ECB daily rates (Frankfurter). News: GDELT.">
        <button className="mm-btn" disabled={!api || !c.features.watchlists || c.internetPaused} onClick={() => api?.checkWatches()}>
          Check
        </button>
      </Row>
      <Row label="Create a watch" stack>
        <div className="sk-chips">
          {(
            [
              ["fx", "Currency crosses a level"],
              ["rain-tomorrow", "Rain tomorrow"],
              ["keyword", "Something in the news"],
            ] as [WatchKind, string][]
          ).map(([k, l]) => (
            <button key={k} className={`sk-chip${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>
              {l}
            </button>
          ))}
        </div>
        <div className="sk-stepper">
          {kind === "fx" && (
            <>
              <input className="sk-input narrow" aria-label="From currency" maxLength={3} value={draft.base} onChange={(e) => setDraft({ ...draft, base: e.target.value })} />
              <span className="sk-sep">/</span>
              <input className="sk-input narrow" aria-label="To currency" maxLength={3} value={draft.quote} onChange={(e) => setDraft({ ...draft, quote: e.target.value })} />
              <select className="sk-input" aria-label="Direction" value={draft.direction} onChange={(e) => setDraft({ ...draft, direction: e.target.value as "above" | "below" })}>
                <option value="above">goes above</option>
                <option value="below">goes below</option>
              </select>
              <input className="sk-input narrow" aria-label="Level" inputMode="decimal" value={draft.threshold} onChange={(e) => setDraft({ ...draft, threshold: e.target.value })} />
            </>
          )}
          {kind === "rain-tomorrow" && <span className="sk-hint">Uses your weather location — no extra requests.</span>}
          {kind === "keyword" && <input className="sk-input wide" placeholder="e.g. Pixel 11 launch" aria-label="Words to watch for" maxLength={60} value={draft.phrase} onChange={(e) => setDraft({ ...draft, phrase: e.target.value })} />}
          <button className="mm-btn primary" disabled={!valid || c.watches.length >= MAX_WATCHES} onClick={add}>
            Create
          </button>
        </div>
      </Row>
    </>
  );
}

// ---- Voice ------------------------------------------------------------------

export function VoicePage({ value: c, onChange, api }: PageProps) {
  const set: SetC = (patch) => onChange({ ...c, ...patch });
  const setVoice = (patch: Partial<CompanionSettings["voice"]>) => set({ voice: { ...c.voice, ...patch } });
  const [shortcut, setShortcut] = useState(c.voice.shortcut);
  const valid = SHORTCUT_PATTERN.test(shortcut);
  const modules = useModules(api);
  const voice = MODULES.find((m) => m.id === "voice")!;
  return (
    <Page title="Voice" sub="Talk to MewMuze and dictate into any app. Everything is transcribed on this computer.">
      <Section title="Local Voice" bare>
        <ModuleCard spec={voice} status={modules.get("voice")} onAct={(a) => void modules.act("voice", a)} disabled={!api} />
        {modules.note && <p className="sk-hint sk-conn-on">{modules.note}</p>}
      </Section>
      <Section title="Dictation">
        <Row label="Dictation shortcut" hint="Press to start listening, press again to stop.">
          <div className="sk-stepper">
            <input className="sk-input" aria-label="Dictation shortcut" value={shortcut} maxLength={30} onChange={(e) => setShortcut(e.target.value)} aria-invalid={!valid} />
            <button className="mm-btn" disabled={!valid || shortcut === c.voice.shortcut} onClick={() => setVoice({ shortcut })}>
              Set
            </button>
          </div>
        </Row>
        <Select label="After dictating" hint="The text is always on your clipboard too." value={c.voice.insertMode} options={[["paste", "Type it into the app I'm using"], ["copy", "Only copy it"]] as const} onChange={(v) => setVoice({ insertMode: v })} />
        <Select label="Spoken language" value={c.voice.language} options={[["auto", "Detect automatically"], ["en", "English"], ["hi", "Hindi"]] as const} onChange={(v) => setVoice({ language: v })} />
        <Toggle label="Spoken punctuation" hint='Say "comma", "full stop" or "new line".' checked={c.voice.spokenPunctuation} onChange={(v) => setVoice({ spokenPunctuation: v })} />
      </Section>
    </Page>
  );
}

// ---- Chat -------------------------------------------------------------------

const STYLES: readonly [ConversationStyle, string][] = [
  ["auto", "Automatic"],
  ["mewmuze", "MewMuze"],
  ["listener", "Listener"],
  ["coach", "Coach"],
  ["playful", "Playful"],
  ["direct", "Direct"],
];

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/;

/**
 * Settings → Chat → Chat with. The key goes straight to the OS credential
 * vault through Rust; this page only ever learns whether one is there.
 */
export function ChatWith({ value: c, onChange, localInstalled, keys = tauriProviders }: { value: CompanionSettings; onChange: (next: CompanionSettings) => void; localInstalled: boolean; keys?: ProviderBridge }) {
  const setChat = (patch: Partial<CompanionSettings["chat"]>) => onChange({ ...c, chat: { ...c.chat, ...patch } });
  const p = c.chat.provider;
  const ext: ExternalId | null = p === "local" ? null : p;
  const [connected, setConnected] = useState<Record<ExternalId, boolean>>({ openai: false, anthropic: false });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<{ text: string; technical?: string; ok?: boolean } | null>(null);
  const refresh = (id: ExternalId) =>
    keys
      .keyStatus(id)
      .then((v) => setConnected((s) => ({ ...s, [id]: v })))
      .catch(() => setConnected((s) => ({ ...s, [id]: false })));
  useEffect(() => {
    void refresh("openai");
    void refresh("anthropic");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
  useEffect(() => {
    setDraft("");
    setEditing(false);
    setNote(null);
  }, [p]);

  const save = async (id: ExternalId) => {
    try {
      await keys.keySet(id, draft);
      setDraft("");
      setEditing(false);
      await refresh(id);
      setNote({ text: "Saved in Windows Credential Manager.", ok: true });
    } catch (e) {
      setNote({ text: String(e instanceof Error ? e.message : e) });
    }
  };
  const remove = async (id: ExternalId) => {
    const ok = await confirmAction({ title: `Remove your ${PROVIDERS[id].name} key?`, message: "It is deleted from Windows Credential Manager. Your Diary and chat memory stay.", confirmLabel: "Remove key", danger: true });
    if (!ok) return;
    await keys.keyRemove(id).catch(() => undefined);
    await refresh(id);
    setNote(null);
  };
  const test = async (id: ExternalId) => {
    setNote({ text: "Testing…" });
    const r = await testConnection(id, keys);
    setNote(r.ok ? { text: "Connected ✓ The key works.", ok: true } : { text: r.message, technical: r.technical });
  };
  const model = ext === "openai" ? c.chat.openaiModel : ext === "anthropic" ? c.chat.anthropicModel : "";
  const setModel = (v: string) => MODEL_ID.test(v) && setChat(ext === "openai" ? { openaiModel: v } : { anthropicModel: v });
  const known = !!ext && PROVIDERS[ext].models.some((m) => m.id === model);

  return (
    <Section title="Chat with" sub="Which brain answers. MewMuze's personality, moods, memory, Diary and voice work the same with each." bare>
      <div className="mm-choices" role="radiogroup" aria-label="Chat with">
        {(["local", "openai", "anthropic"] as const).map((id) => (
          <button key={id} role="radio" aria-checked={p === id} className={`mm-choice${p === id ? " on" : ""}`} onClick={() => setChat({ provider: id })}>
            <span className="mm-choice-title">
              {PROVIDERS[id].name}
              {id !== "local" && connected[id] && <span className="mm-badge ok">Connected ✓</span>}
              {p === id && <Icon name="check" size={16} />}
            </span>
            <span className="mm-choice-text">
              {PROVIDERS[id].blurb}
              {id === "local" && !localInstalled ? " Install Local Chat below." : ""}
            </span>
          </button>
        ))}
      </div>
      <p className="sk-hint">
        {PROVIDERS[p].privacy}
        {ext ? " Changing this never sends an earlier chat: you start a new one." : ""}
      </p>
      {ext && (
        <div className="mm-card">
          <Row
            label={`${PROVIDERS[ext].name} API key`}
            hint={connected[ext] && !editing ? "Stored in Windows Credential Manager — never in settings, the Diary or logs." : `Your own key (${PROVIDERS[ext].keyHint}). ${PROVIDERS[ext].name} bills you for what you use.`}
          >
            {connected[ext] && !editing ? (
              <span className="sk-stepper">
                <button className="mm-btn" onClick={() => void test(ext)}>
                  Test connection
                </button>
                <button className="mm-btn" onClick={() => setEditing(true)}>
                  Change key
                </button>
                <button className="mm-btn danger" onClick={() => void remove(ext)}>
                  Remove key
                </button>
              </span>
            ) : (
              <span className="sk-stepper">
                <input
                  className="sk-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`${PROVIDERS[ext].name} API key`}
                  placeholder={PROVIDERS[ext].keyHint}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button className="mm-btn primary" disabled={draft.trim().length < 20} onClick={() => void save(ext)}>
                  Save key
                </button>
                {editing && (
                  <button className="mm-btn" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                )}
              </span>
            )}
          </Row>
          {note && (
            <p className={`sk-hint${note.ok ? " sk-conn-on" : ""}`} role="status">
              {note.text}
              {note.technical && (
                <details className="cp-tech">
                  <summary>Technical details</summary>
                  {note.technical}
                </details>
              )}
            </p>
          )}
          <Select
            label="Model"
            hint="The recommended one is the most economical that still chats well."
            value={known ? model : "__other"}
            options={[...PROVIDERS[ext].models.map((m) => [m.id, m.label] as const), ["__other", known ? "Other (Advanced)" : `Other: ${model}`] as const]}
            onChange={(v) => v !== "__other" && setModel(v)}
          />
          <Advanced>
            <Row label="Model ID" hint="Any chat model your key can use, exactly as the provider names it.">
              <input key={model} className="sk-input" spellCheck={false} aria-label="Model ID" defaultValue={model} onBlur={(e) => setModel(e.target.value.trim())} />
            </Row>
          </Advanced>
        </div>
      )}
    </Section>
  );
}

/** Settings → Chat → Diary: the user's own record, separate from memory. */
function DiarySettings({ value: c, onChange, api }: PageProps) {
  const setChat = (patch: Partial<CompanionSettings["chat"]>) => onChange({ ...c, chat: { ...c.chat, ...patch } });
  const [count, setCount] = useState<number | null>(null);
  const reload = () => void api?.diary?.count().then(setCount).catch(() => setCount(null));
  useEffect(reload, [api]);
  const ext = c.chat.provider === "local" ? null : PROVIDERS[c.chat.provider].name;
  const clear = async () => {
    const ok = await confirmAction({ title: "Clear the whole Diary?", message: "Every Diary entry is deleted from this computer. Chat memory is not affected. This can't be undone.", confirmLabel: "Clear Diary", danger: true });
    if (ok) await api?.diary?.clear().then(reload);
  };
  return (
    <Section title="Diary" sub="After a meaningful chat, MewMuze writes a short entry in your words and keeps it on this computer. Separate from memory: Forget chat and Clear companion memory never delete it.">
      <Toggle label="Keep a Diary" hint="Written by Local Chat on this computer whenever it is installed." checked={c.chat.diary} onChange={(v) => setChat({ diary: v })} />
      <Toggle
        label={`Let ${ext ?? "OpenAI or Claude"} write Diary entries`}
        hint={`Only when Local Chat isn't installed: the finished conversation is sent once more to ${ext ?? "the provider you chat with"} to write the summary. The entry itself is saved only on this computer.`}
        checked={c.chat.diaryExternal}
        disabled={!c.chat.diary}
        onChange={(v) => setChat({ diaryExternal: v })}
      />
      <Row label="Clear Diary" hint={count === null ? "Every entry, on this computer." : `${count} ${count === 1 ? "entry" : "entries"} on this computer.`}>
        <button className="mm-btn danger" disabled={!api?.diary || count === 0} onClick={() => void clear()}>
          Clear Diary
        </button>
      </Row>
    </Section>
  );
}

export function ChatPage({ value: c, onChange, api }: PageProps) {
  const set: SetC = (patch) => onChange({ ...c, ...patch });
  const setChat = (patch: Partial<CompanionSettings["chat"]>) => set({ chat: { ...c.chat, ...patch } });
  const [items, setItems] = useState<{ id: string; label: string }[]>([]);
  const reload = () => void api?.memory.list().then(setItems);
  useEffect(reload, [api]);
  const modules = useModules(api);
  const chat = MODULES.find((m) => m.id === "chat")!;
  const lite = MODULES.find((m) => m.id === "chat-lite")!;
  const status = useCompanionStatus(api);
  const ramMB = status?.ai?.totalMemoryMB;
  // A 4-6 GB PC gets Lite suggested - and shown first.
  const liteFirst = ramMB !== undefined && ramMB <= LITE_RECOMMENDED_MB;
  const haveStd = usable(modules.get("chat"));
  const haveLite = usable(modules.get("chat-lite"));
  const both = voiceChatAvailable(modules.get("voice"), haveStd ? modules.get("chat") : modules.get("chat-lite"));
  const cards = [
    { spec: chat, note: liteFirst ? "Needs about 1.1 GB of free memory while chatting." : "Best replies. Needs about 1.1 GB of free memory while chatting." },
    // Honest about the trade: in testing Lite answered twice as fast, but often
    // misread the mood and was unreliable in Hindi and Hinglish.
    {
      spec: lite,
      note: `${liteFirst ? `Recommended for this PC (${Math.round((ramMB ?? 0) / 1024)} GB of memory).` : "For PCs with 4–6 GB of memory."} Quicker and lighter, but its replies are basic: it can misread how you feel, and Hindi or Hinglish replies are unreliable.`,
    },
  ];
  if (liteFirst) cards.reverse();
  const clear = async () => {
    const ok = await confirmAction({ title: "Clear companion memory?", message: "Your preferences, what MewMuze learned about how you like to talk, and every pending check-in.", confirmLabel: "Clear", danger: true });
    if (ok) await api?.memory.clear().then(() => setItems([]));
  };
  return (
    <Page title="Chat" sub="Conversations with MewMuze — privately on this computer, or through your own OpenAI or Claude key.">
      <ChatWith value={c} onChange={onChange} localInstalled={haveStd || haveLite} />
      <Section title="Local Chat" sub="Install one. The standard model talks better; Lite fits smaller PCs." bare>
        {cards.map(({ spec, note }) => (
          <div key={spec.id}>
            <ModuleCard spec={spec} status={modules.get(spec.id)} onAct={(a) => void modules.act(spec.id, a)} disabled={!api} />
            <p className="sk-hint">{note}</p>
          </div>
        ))}
        {modules.note && <p className="sk-hint sk-conn-on">{modules.note}</p>}
      </Section>
      {haveStd && haveLite && (
        <Section>
          <Select
            label="Chat model"
            hint="Both are installed. Automatic uses the standard one."
            value={c.chat.model}
            options={[["auto", "Automatic"], ["standard", "Standard"], ["lite", "Lite"]] as const}
            onChange={(v) => setChat({ model: v })}
          />
        </Section>
      )}
      <Section>
        <Row label="Voice chat" hint={c.chat.provider === "local" ? "Speak to MewMuze and read the reply. Needs Local Voice and Local Chat." : `Speak to MewMuze: Local Voice writes it down on this computer, then ${PROVIDERS[c.chat.provider].name} replies.`}>
          {c.chat.provider === "local" ? (
            <span className={`mm-badge${both ? " ok" : ""}`}>{both ? "Available" : "Needs both"}</span>
          ) : (
            <span className={`mm-badge${usable(modules.get("voice")) ? " ok" : ""}`}>{usable(modules.get("voice")) ? "Available" : "Needs Local Voice"}</span>
          )}
        </Row>
      </Section>
      <Section title="Conversation">
        <Select label="Conversation style" hint="Automatic finds the right way to talk for each conversation." value={c.chat.style} options={STYLES} onChange={(v) => setChat({ style: v })} />
        <Toggle label="Show active mode" hint="Shows how MewMuze is helping right now, like 🩺 Health Guide or 💗 Love Guru." checked={c.chat.showActiveMode} onChange={(v) => setChat({ showActiveMode: v })} />
      </Section>
      <DiarySettings value={c} onChange={onChange} api={api} />
      <Section title="Memory" sub="Only small things MewMuze uses to talk to you, stored encrypted on this computer — never the conversation itself. Separate from your Diary.">
        <Toggle label="Remember useful things" hint="Your name, reply language, reply length and how you like to talk." checked={c.chat.rememberUseful} onChange={(v) => setChat({ rememberUseful: v })} />
        <Toggle label="Follow up on things I tell you" hint="Check in later, like after a rough day or an interview." checked={c.chat.followUps} disabled={!c.chat.rememberUseful} onChange={(v) => setChat({ followUps: v })} />
        <Toggle label="Gentle follow-ups" hint="Check in without asking first. Off: MewMuze asks you." checked={c.chat.gentleFollowUps} disabled={!c.chat.rememberUseful || !c.chat.followUps} onChange={(v) => setChat({ gentleFollowUps: v })} />
        <Row label="What MewMuze remembers" stack>
          {items.length === 0 && <span className="sk-hint">Nothing yet.</span>}
          {items.map((i) => (
            <Row key={i.id} label={i.label}>
              <button className="mm-btn" disabled={!api} onClick={() => void api?.memory.forget(i.id).then(reload)}>
                Forget
              </button>
            </Row>
          ))}
        </Row>
        <Row label="Clear companion memory" hint="Everything above, and every pending check-in. Your Diary is not touched.">
          <button className="mm-btn danger" disabled={!api || items.length === 0} onClick={() => void clear()}>
            Clear
          </button>
        </Row>
        <Advanced label="For developers">
          <Toggle label="Show persona routing" hint="Shows the internal routing under the chat header." checked={c.chat.debugRouting} onChange={(v) => setChat({ debugRouting: v })} />
        </Advanced>
      </Section>
    </Page>
  );
}

// ---- Notifications (companion half) -------------------------------------------

export function CompanionNotifications({ value: c, onChange }: { value: CompanionSettings; onChange: (next: CompanionSettings) => void }) {
  const set: SetC = (patch) => onChange({ ...c, ...patch });
  return (
    <Section title="Quiet time">
      <Toggle label="Quiet hours" hint="Only urgent notices get through." checked={c.quietHours.enabled} onChange={(v) => set({ quietHours: { ...c.quietHours, enabled: v } })} />
      {c.quietHours.enabled && (
        <Row label="Quiet from / to">
          <div className="sk-stepper">
            <input type="time" className="sk-input" aria-label="Quiet hours start" value={toHHMM(c.quietHours.start)} onChange={(e) => set({ quietHours: { ...c.quietHours, start: fromHHMM(e.target.value) } })} />
            <span className="sk-sep">–</span>
            <input type="time" className="sk-input" aria-label="Quiet hours end" value={toHHMM(c.quietHours.end)} onChange={(e) => set({ quietHours: { ...c.quietHours, end: fromHHMM(e.target.value) } })} />
          </div>
        </Row>
      )}
      <Toggle label="Important alerts" hint="Urgent notices may break through Focus and quiet hours." checked={c.features.importantAlerts} onChange={(v) => set({ features: { ...c.features, importantAlerts: v } })} />
    </Section>
  );
}

// ---- Privacy & Battery ----------------------------------------------------------

export function PrivacyBatteryPage({ value: c, onChange, api, gmailConnected, calendarConnected }: PageProps & { gmailConnected: boolean; calendarConnected: boolean }) {
  const set: SetC = (patch) => onChange({ ...c, ...patch });
  const setFeature = (k: keyof CompanionFeatures, v: boolean) => set({ features: { ...c.features, [k]: v } });
  const status = useCompanionStatus(api);
  const [done, setDone] = useState("");
  const flash = (msg: string) => {
    setDone(msg);
    setTimeout(() => setDone(""), 3000);
  };
  const p = status?.power;
  const power = !p || !p.known ? "Power source unknown" : p.onBattery ? `On battery${p.percent !== null ? ` · ${p.percent}%` : ""}` : "Plugged in";
  const ai = status?.ai;
  const activity = ai?.voiceBusy ? "Voice transcription is active." : ai?.chatLoaded ? "Chat is ready and using some memory." : "Nothing extra is running.";
  const rows: { what: string; badge: string; kind: "local" | "internet" | "connected" | "module"; detail: string }[] = [
    { what: "Time and time zone", badge: "On this computer", kind: "local", detail: status?.timeZone ?? "From Windows" },
    { what: "Learn my routine", badge: "On this computer", kind: "local", detail: c.features.routineLearning ? "On — averages only (times and busy/not), never content" : "Off" },
    { what: "Weather", badge: "Internet", kind: "internet", detail: `${NET_SERVICES.met.name} · ${c.features.weather ? "on" : "off"}` },
    { what: "City search", badge: "Internet", kind: "internet", detail: `${NET_SERVICES.nominatim.name} · only when you search` },
    { what: "News about my interests", badge: "Internet", kind: "internet", detail: `${NET_SERVICES.gdelt.name} · ${c.features.news ? "on" : "off"}` },
    { what: "My watches", badge: "Internet", kind: "internet", detail: `${NET_SERVICES.frankfurter.name}, GDELT · ${c.features.watchlists ? "on" : "off"}` },
    { what: "Calendar", badge: "Your account", kind: "connected", detail: calendarConnected ? "Your private calendar link, read-only" : "Not connected" },
    { what: "Email", badge: "Your account", kind: "connected", detail: gmailConnected ? "Senders and subjects only" : "Not connected" },
    { what: "Local Voice", badge: "On this computer", kind: "module", detail: `${ai?.voice ?? "Not installed"} · microphone only while you record · audio never uploaded` },
    { what: "Local Chat", badge: "On this computer", kind: "module", detail: `${ai?.chat ?? "Not installed"}${ai?.chatLoaded ? " · open now" : ""} · conversations never uploaded` },
    c.chat.provider === "local"
      ? { what: "Chat with", badge: "On this computer", kind: "local", detail: "MewMuze Local — messages never leave this computer" }
      : { what: `Chat with ${PROVIDERS[c.chat.provider].name}`, badge: "Internet", kind: "connected", detail: `Your own key · ${PROVIDERS[c.chat.provider].privacy}` },
    { what: "Diary", badge: "On this computer", kind: "local", detail: c.chat.diary ? "On — plain files in the app's diary folder, never uploaded" : "Off" },
  ];
  return (
    <Page title="Privacy & Battery" sub="What MewMuze uses, what leaves your computer, and how much power it may spend.">
      <Section title="Power use" bare>
        <div className="mm-choices" role="radiogroup" aria-label="Power use">
          {(["balanced", "saver", "performance"] as PowerMode[]).map((m) => (
            <button key={m} role="radio" aria-checked={c.powerMode === m} className={`mm-choice${c.powerMode === m ? " on" : ""}`} onClick={() => set({ powerMode: m })}>
              <span className="mm-choice-title">
                {MODE_INFO[m].label}
                {c.powerMode === m && <Icon name="check" size={16} />}
              </span>
              <span className="mm-choice-text">{MODE_INFO[m].hint}</span>
            </button>
          ))}
        </div>
        <div className="mm-live" role="status">
          <span className={`mm-live-dot${ai?.voiceBusy || ai?.chatLoaded ? " busy" : ""}`} />
          <span>
            {power}
            {p?.osSaver && " · Windows battery saver is on, so MewMuze saves power too"}
            {" · "}
            {activity}
          </span>
        </div>
      </Section>

      <Section title="What uses what">
        {rows.map((r) => (
          <Row key={r.what} label={r.what} hint={r.detail}>
            <span className={`cmp-badge ${r.kind}`}>{r.badge}</span>
          </Row>
        ))}
        <Row label="About the internet" hint="Only the features marked Internet go online, and only while they are on. No API keys are stored in the app. Everything MewMuze learns stays on this computer." />
      </Section>

      <Section title="Controls">
        <Toggle label="Pause internet features" hint="Stops weather, news, watches and city search at once." checked={c.internetPaused} onChange={(v) => set({ internetPaused: v })} />
        <Toggle
          label="Learn my routine"
          hint="Also learns which hours you are usually busy: with Local Chat on, MewMuze settles down in those hours and is livelier in your free ones. Off stops learning. What was learned stays until you reset it."
          checked={c.features.routineLearning}
          onChange={(v) => setFeature("routineLearning", v)}
        />
        <Row
          label="Reset learned routine"
          hint={status?.routine.daysLearned ? `${status.routine.daysLearned} days learned${status.routine.typicalStart !== null ? ` · usually starts ${toHHMM(status.routine.typicalStart)}` : ""}` : "Nothing learned yet."}
        >
          <button
            className="mm-btn"
            disabled={!api}
            onClick={() => {
              api?.resetRoutine();
              flash("Routine reset.");
            }}
          >
            Reset
          </button>
        </Row>
        <Row label="Delete local history" hint="Recent notices, seen headlines, saved weather and calendar.">
          <button
            className="mm-btn"
            disabled={!api}
            onClick={() => {
              api?.deleteHistory();
              flash("History deleted.");
            }}
          >
            Delete
          </button>
        </Row>
        <Row label="Clear companion data" hint="Everything the companion learned or remembered. Your settings stay.">
          <button
            className="mm-btn danger"
            disabled={!api}
            onClick={() =>
              void confirmAction({ title: "Clear companion data?", message: "Everything the companion has learned and remembered is deleted. Your settings stay.", confirmLabel: "Clear", danger: true }).then((ok) => {
                if (!ok) return;
                api?.clearData();
                flash("Companion data cleared.");
              })
            }
          >
            Clear…
          </button>
        </Row>
        {done && <Row label={done} />}
      </Section>

      <Advanced label="Details for the curious">
        <h3 className="mm-section-title">Background checks</h3>
        {status?.scheduler.jobs.map((j) => (
          <Row key={j.id} label={j.id} hint={`${every(j.everyMs)} · ${j.network ? "internet" : "local"} · last ${ago(j.lastRun)}${j.failures > 0 ? ` · waiting after ${j.failures} failed tries` : ""}`} />
        ))}
        <Row
          label="This session"
          hint={`${status?.net ? `${status.net.requests} internet requests · ${formatBytes(status.net.bytes)} received` : "No internet use yet"}${status?.net?.refusedWhilePaused ? ` · ${status.net.refusedWhilePaused} blocked while paused` : ""}${status ? ` · ${status.scheduler.wakeups} wake-ups` : ""}${ai?.chatLoaded ? ` · chat is using ${ai.chatMemoryMB} MB` : ""}`}
        />
        <h3 className="mm-section-title">Recent notices</h3>
        {status?.history.length ? status.history.slice(0, 8).map((h) => <Row key={`${h.at}-${h.text}`} label={h.text} hint={`${h.kind} · ${ago(h.at)}`} />) : <Row label="None yet" />}
      </Advanced>
    </Page>
  );
}
