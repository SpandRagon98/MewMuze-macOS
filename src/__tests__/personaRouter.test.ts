import { describe, expect, it } from "vitest";
// @ts-expect-error no @types/node in the app tsconfig; other tests read files the same way.
import { readFileSync } from "node:fs";
import { ANIMATIONS } from "../animation/animationDefinitions";
import { guardReply, turnNote } from "../companion/chatPrompt";
import { detectLanguage } from "../companion/language";
import { currentInfo, factsNote, type CurrentInfoHost } from "../companion/persona/currentInfo";
import { detectFollowUp, due, makeFollowUp, parseFollowUps, prune } from "../companion/persona/followUps";
import { PERSONAS, TOPICS, TOPIC_PERSONA, allowsSecondary, isPersona, persona, temperatureFor } from "../companion/persona/personas";
import { PersonaState, applyStyle, decide, fromModel, shouldAskModel, signals, type Routing } from "../companion/persona/router";
import { EMPTY_STYLE, MIN_SAMPLES, STYLE_KEYS, learn, parseStyle, traits } from "../companion/persona/style";
import { DEFAULT_COMPANION } from "../companion/profile";

interface Single { cat: string; lang: string; text: string; expect: string[]; secondary?: string; via: "rules" | "model" | "any"; hour?: number; risk?: string; current?: boolean }
const SET = JSON.parse(readFileSync("bench/persona-eval-set.json", "utf8") as string) as {
  single: Single[];
  blends: { text: string; primary: string; secondary: string; mood?: string }[];
  conversations: { name: string; turns: { text: string; primary: string; secondary?: string | null }[] }[];
  groups: { text: string; generalization: boolean }[];
};

const ctx = (hour = 15) => ({ lang: "en" as const, hour, firstMessage: true });
const route = (text: string, hour = 15) => decide(signals(text), ctx(hour));

describe("Persona evaluation set - one message", () => {
  it.each(SET.single.map((c) => [`${c.cat} (${c.lang}): ${c.text}`, c] as const))("%s", (_name, c) => {
    const s = signals(c.text);
    const r = decide(s, ctx(c.hour));
    if (c.via === "model") {
      // The rules must not be confidently wrong: they hand it to the model.
      expect(shouldAskModel(r, s, "mewmuze")).toBe(true);
      return;
    }
    expect(c.expect).toContain(r.primary);
    if (c.via === "rules") expect(shouldAskModel(r, s, "mewmuze")).toBe(false);
    if (c.secondary) expect(r.secondary).toBe(c.secondary);
    if (c.risk) expect(r.risk).toBe(c.risk);
    if (c.current) expect(r.needsCurrentInformation).toBe(true);
    // Language is detected, not assumed.
    expect(detectLanguage(c.text) ?? "en").toBe(c.lang);
  });

  it("covers every category the brief lists", () => {
    const cats = new Set(SET.single.map((c) => c.cat));
    for (const c of ["breakup", "relationship conflict", "general venting", "sadness", "stress", "illness", "medication", "fitness", "money", "investing", "career", "interview", "coding", "technical support", "learning", "creative writing", "decision making", "procrastination", "celebration", "banter", "late-night conversation", "travel", "research"]) {
      expect(cats, c).toContain(c);
    }
    const langs = new Set(SET.single.map((c) => c.lang));
    expect([...langs].sort()).toEqual(["en", "hi", "hinglish"]);
  });
});

describe("Persona blending", () => {
  it.each(SET.blends.map((b) => [b.text, b] as const))("%s", (_t, b) => {
    const r = route(b.text);
    expect([r.primary, r.secondary]).toEqual([b.primary, b.secondary]);
    if (b.mood) expect(r.mood).toBe(b.mood);
  });

  it("never blends more than one secondary, and only an allowed one", () => {
    for (const c of SET.single) {
      const r = route(c.text, c.hour);
      if (r.secondary) expect(allowsSecondary(r.primary, r.secondary), c.text).toBe(true);
    }
  });
});

describe("Persona continuity", () => {
  it.each(SET.conversations.map((c) => [c.name, c] as const))("%s", (_n, conv) => {
    const state = new PersonaState();
    let t = 1_000_000;
    for (const turn of conv.turns) {
      const got = state.update(route(turn.text), (t += 60_000));
      expect(got.primary, turn.text).toBe(turn.primary);
      if (turn.secondary !== undefined) expect(got.secondary, turn.text).toBe(turn.secondary);
    }
  });

  it("starts fresh after half an hour of silence", () => {
    const state = new PersonaState();
    state.update(route("My girlfriend broke up with me."), 0);
    expect(state.update(route("ok"), 31 * 60_000).primary).toBe("mewmuze");
  });

  it("a specialist hands back once its topic goes quiet; a listener stays", () => {
    const coach = new PersonaState();
    let t = 1_000_000;
    const lead = coach.update(route("my manager wants my appraisal report by 5"), (t += 60_000)).primary;
    expect(persona(lead).emotional).toBeFalsy();
    coach.update(route("i finished it tho, barely"), (t += 60_000));
    expect(coach.update(route("now i'm just lying on the couch"), (t += 60_000)).primary).not.toBe(lead);

    const listener = new PersonaState();
    const first = listener.update(route("My girlfriend broke up with me."), (t += 60_000)).primary;
    listener.update(route("i don't know"), (t += 60_000));
    listener.update(route("ok"), (t += 60_000));
    expect(listener.update(route("whatever"), (t += 60_000)).primary).toBe(first);
  });
});

describe("Savage Bestie never turns on a whole group", () => {
  it.each(SET.groups.map((g) => [g.text, g] as const))("%s", (_t, g) => {
    const r = route(g.text);
    expect(r.groupGeneralization).toBe(g.generalization);
    if (g.generalization) {
      expect(r.primary).toBe("savage_bestie");
      expect(turnNote({ primary: r.primary, secondary: r.secondary, groupGeneralization: true })).toMatch(/do not agree that the whole group is bad/);
    }
  });

  it("drops a generalising sentence from a reply, keeps the rest - and keeps 'not all'", () => {
    expect(guardReply("Honestly, men are trash. That guy was really rude to you.")).toBe("That guy was really rude to you.");
    expect(guardReply("Women are the worst. Seriously.")).toBe("Seriously.");
    expect(guardReply("Not all men are trash, but he was out of line.")).toBe("Not all men are trash, but he was out of line.");
    expect(guardReply("All men are trash.")).toMatch(/behaviour deserves serious side-eye/);
    // Seen in the live eval: agreeing softly still agrees.
    expect(guardReply("All guys can be the same, but I prefer ones who play with me.")).toMatch(/side-eye/);
  });

  it("carries the rule in the persona itself", () => {
    expect(persona("savage_bestie").rules).toMatch(/Never generalise about men, women or any group/);
  });
});

describe("The model is only asked when the rules are unsure", () => {
  const s = signals("Something happened earlier today and I keep replaying it in my head.");
  const r = decide(s, ctx());

  it("validates the classifier's JSON and rejects anything outside the schema", () => {
    const ok = fromModel('{"topic":"relationship","second":"sad","mood":"sad","intensity":2,"current":false}', s, ctx());
    expect(ok).toMatchObject({ primary: "relationship_coach", secondary: "comfort_companion", source: "model", mood: "sad" });
    for (const bad of ["not json", "[]", '{"topic":"astrology","second":"none","mood":"sad","intensity":1,"current":false}', '{"topic":"sad","second":"none","mood":"sad","intensity":5,"current":false}', '{"topic":"sad","mood":"sad","intensity":1,"current":false}']) {
      expect(fromModel(bad, s, ctx()), bad).toBeNull();
    }
  });

  it("keeps a feeling the user named over the model's guess", () => {
    const furious = signals("How do I ask my manager for a raise? I'm kind of furious they gave it to someone else");
    expect(fromModel('{"topic":"career","second":"none","mood":"happy","intensity":2}', furious, ctx())).toMatchObject({ primary: "career_coach", mood: "angry" });
  });

  it("spends nothing on phatic replies, risk, confident rules or short follow-ups mid-conversation", () => {
    expect(shouldAskModel(route("ok"), signals("ok"), "mewmuze")).toBe(false);
    expect(shouldAskModel(route("I don't want to be alive anymore."), signals("I don't want to be alive anymore."), "mewmuze")).toBe(false);
    expect(shouldAskModel(route("My girlfriend broke up with me."), signals("My girlfriend broke up with me."), "mewmuze")).toBe(false);
    expect(shouldAskModel(route("I don't know what I did."), signals("I don't know what I did."), "breakup_buddy")).toBe(false);
    expect(shouldAskModel(r, s, "mewmuze")).toBe(true);
  });
});

describe("Persona catalog", () => {
  it("defines every persona from the brief, as data", () => {
    expect(PERSONAS).toHaveLength(37);
    for (const p of PERSONAS) {
      expect(p.behavior.length, p.id).toBeGreaterThan(20);
      expect(p.temperature[0], p.id).toBeGreaterThanOrEqual(0.1);
      expect(p.temperature[1], p.id).toBeLessThanOrEqual(1);
      expect(p.temperature[0], p.id).toBeLessThanOrEqual(p.temperature[1]);
      if (p.secondaries !== "any") for (const s of p.secondaries) expect(isPersona(s), `${p.id} -> ${s}`).toBe(true);
      // The cat's reaction uses animations that exist - no missing art.
      for (const a of [p.cat.once, p.cat.hold]) if (a) expect(ANIMATIONS[a], `${p.id}: ${a}`).toBeTruthy();
    }
    for (const t of TOPICS) expect(isPersona(TOPIC_PERSONA[t]), t).toBe(true);
  });

  it("keeps health and medication careful whatever else is in the mix", () => {
    expect(temperatureFor("health_guide", null)).toBeLessThanOrEqual(0.35);
    expect(temperatureFor("comfort_companion", "health_guide")).toBeLessThanOrEqual(0.35);
    expect(temperatureFor("chaos_cat", null)).toBeGreaterThanOrEqual(0.8);
    expect(persona("health_guide").rules).toMatch(/never claim to be one, never diagnose/);
    expect(persona("medication_guide").rules).toMatch(/Never act as a prescriber/);
    expect(persona("investment_researcher").rules).toMatch(/Never promise or predict returns/);
    expect(persona("grounding_listener").rules).toMatch(/not a therapist/);
  });
});

describe("Manual conversation style", () => {
  const vent = route("Ugh, my landlord ignored my messages again. So annoying.");
  it("keeps the reply inside the chosen family", () => {
    expect(applyStyle("mewmuze", vent.primary, vent.secondary, vent).primary).toBe("mewmuze");
    expect(applyStyle("playful", "tutor", null, route("Teach me how photosynthesis works.")).primary).toBe("chaos_cat");
    expect(applyStyle("listener", "career_coach", null, route("I feel really down today, nothing is going right.")).primary).toBe("comfort_companion");
  });
  it("never overrides the safety personas", () => {
    const sick = route("I have a fever and a sore throat since yesterday.");
    expect(applyStyle("playful", sick.primary, sick.secondary, sick).primary).toBe("health_guide");
    const crisis = route("I don't want to be alive anymore.");
    expect(applyStyle("direct", crisis.primary, crisis.secondary, crisis).primary).toBe("grounding_listener");
  });
});

describe("Adaptive communication style", () => {
  it("learns conservatively: nothing applies before enough messages", () => {
    let p = EMPTY_STYLE;
    for (let i = 0; i < MIN_SAMPLES - 1; i++) p = learn(p, "lol ok yaar", "hinglish");
    expect(traits(p)).toEqual({});
    for (let i = 0; i < 12; i++) p = learn(p, "lol ok yaar", "hinglish");
    expect(traits(p)).toMatchObject({ length: "short", tone: "casual", humour: true, language: "hinglish" });
  });

  it("acts on explicit asks at once", () => {
    expect(traits(learn(EMPTY_STYLE, "Just tell me, no fluff.", "en")).directness).toBe("direct");
    expect(traits(learn(EMPTY_STYLE, "Please stop asking me so many questions", "en")).fewQuestions).toBe(true);
  });

  it("can only ever store the listed averages - nowhere to put identity or content", () => {
    const stored = parseStyle(JSON.stringify({ ...learn(EMPTY_STYLE, "I'm a Hindu vegetarian from Pune", "en"), religion: "hindu", note: "secret" }));
    expect(Object.keys(stored).sort()).toEqual([...STYLE_KEYS].sort());
    expect(JSON.stringify(stored)).not.toMatch(/hindu|pune|secret/i);
  });
});

describe("Current information stays separate from the persona", () => {
  const host = (over: Partial<typeof DEFAULT_COMPANION> = {}): CurrentInfoHost => ({
    settings: () => ({ ...DEFAULT_COMPANION, ...over }),
    now: () => Date.UTC(2026, 8, 11, 10, 0),
    tz: () => "Asia/Kolkata",
    cachedWeather: () => null,
    fetchWeather: async () => null,
    headlines: async () => [{ url: "u", title: "Chandrayaan lands safely", domain: "example.org", seen: 1 }],
    rate: async () => 83.21,
  });

  it("answers the clock offline, including other cities", async () => {
    expect(await currentInfo("time", "What time is it in Tokyo right now?", host())).toMatch(/^In Tokyo it is 7:00 pm on Friday,? 11 September.$/);
  });

  it("respects Internet paused and Weather off, and tells the model not to guess", async () => {
    expect(await currentInfo("weather", "weather today?", host({ internetPaused: true }))).toMatch(/paused/);
    expect(await currentInfo("weather", "weather today?", host())).toMatch(/Weather is switched off|No location/);
    expect(factsNote(null)).toMatch(/instead of guessing/);
  });

  it("uses the companion's own sources for rates and news", async () => {
    expect(await currentInfo("price", "What's the dollar rate in rupees?", host())).toBe("1 USD = 83.21 INR (Frankfurter, latest reference rate).");
    expect(await currentInfo("news", "Any news about Chandrayaan?", host())).toMatch(/Chandrayaan lands safely/);
    expect(await currentInfo("price", "What's the price of gold?", host())).toBeNull();
  });
});

describe("Follow-up records", () => {
  const now = new Date(2026, 8, 11, 15, 0).getTime();
  it("detects the kinds worth a check-in, in three languages", () => {
    expect(detectFollowUp("I'm sick today.")).toBe("unwell");
    expect(detectFollowUp("Aaj tabiyat kharab hai")).toBe("unwell");
    expect(detectFollowUp("मेरी तबीयत ठीक नहीं है")).toBe("unwell");
    expect(detectFollowUp("I have my interview tomorrow")).toBe("interview");
    expect(detectFollowUp("Big presentation on Monday")).toBe("presentation");
    expect(detectFollowUp("What a rough day")).toBe("rough_day");
    expect(detectFollowUp("What should I cook tonight?")).toBeNull();
  });

  it("is due the next day, expires two days later, and is never asked more than twice", () => {
    const f = makeFollowUp("unwell", now, "c1");
    expect(due([f], now)).toBeNull();
    expect(due([f], now + 86_400_000)).toEqual(f);
    expect(prune([f], f.expiresAt + 1)).toEqual([]);
    expect(prune([{ ...f, asked: 2 }], now + 86_400_000)).toEqual([]);
  });

  it("parses only well-formed records, and stores no words", () => {
    const f = makeFollowUp("unwell", now, "c1", "I have a fever of 102 and my throat hurts");
    expect(JSON.stringify(f)).not.toMatch(/fever|throat/);
    expect(parseFollowUps(JSON.stringify([f, { kind: "diagnosis", id: "x" }]))).toEqual([f]);
  });
});

/** The eval numbers for the report: printed, not asserted beyond the cases above. */
describe("evaluation summary", () => {
  it("reports how much the rules decide on their own", () => {
    const rows = SET.single.map((c) => {
      const s = signals(c.text);
      const r: Routing = decide(s, ctx(c.hour));
      return { c, r, model: shouldAskModel(r, s, "mewmuze") };
    });
    const byRules = rows.filter((x) => !x.model);
    const correct = byRules.filter((x) => x.c.expect.includes(x.r.primary)).length;
    console.log(`[persona-eval] ${SET.single.length} messages: ${byRules.length} decided by rules (${correct} as expected), ${rows.length - byRules.length} left to the model`);
    expect(correct).toBe(byRules.length);
  });
});
