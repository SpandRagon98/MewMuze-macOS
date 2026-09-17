// @ts-expect-error no @types/node in the app tsconfig; other guards read files this way too.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CONFIDENT, decide, signals } from "../companion/persona/router";
import type { Lang } from "../companion/phrases";
import { ChatController } from "../companion/chatController";
import { careLine, replyEmoji } from "../companion/chatPrompt";
import { buildTurn, feelingNote, keyWords, rewriteMessages, topPFor } from "../companion/contextBuilder";
import { EMPTY_MEMORY } from "../companion/memory";
import { PERSONAS, PERSONA_EMOJI, persona } from "../companion/persona/personas";
import { glossaryNote } from "../companion/persona/glossary";
import { FEW_SHOT, GUIDES, guideNote, shapeOf } from "../companion/persona/promptLibrary";
import { DEFAULT_COMPANION } from "../companion/profile";
import { review } from "../companion/replyCheck";

describe("persona labels", () => {
  it("every persona has an emoji and a plain name", () => {
    for (const p of PERSONAS) expect(PERSONA_EMOJI[p.id], p.id).toBeTruthy();
    expect(`${PERSONA_EMOJI.health_guide} ${persona("health_guide").name}`).toBe("🩺 Health Guide");
    expect(`${PERSONA_EMOJI.eli5_teacher} ${persona("eli5_teacher").name}`).toBe("🧸 Explain It Simply");
    expect(`${PERSONA_EMOJI.savage_bestie} ${persona("savage_bestie").name}`).toBe("😼 Savage Bestie");
  });
});

describe("reply emoji", () => {
  const pick = (o: Partial<Parameters<typeof replyEmoji>[0]>) =>
    replyEmoji({ primary: "mewmuze", mood: "neutral", risk: "none", personality: "cozy", raw: "", ...o });

  it("fits the moment, and a heavy feeling outranks the subject", () => {
    expect(pick({ primary: "savage_bestie", mood: "frustrated" })).toBe("😼");
    expect(pick({ primary: "celebration_buddy", mood: "excited" })).toBe("🎉");
    expect(pick({ primary: "comfort_companion", mood: "sad" })).toBe("🫂");
    expect(pick({ primary: "career_coach" })).toBe("💼");
    expect(pick({ primary: "career_coach", mood: "sad" })).toBe("🫂");
    expect(pick({ mood: "playful" })).toBe("😹");
  });

  it("keeps the model's own emoji when it fits, and does not repeat the last reply's", () => {
    expect(pick({ primary: "celebration_buddy", raw: "Congrats!! 🥳🥳 🤖" })).toBe("🥳");
    expect(pick({ primary: "celebration_buddy", raw: "Congrats! 🤖" })).toBe("🎉");
    expect(pick({ primary: "celebration_buddy", previous: "So proud of you 🎉" })).toBe("🥳");
  });

  it("stays out of danger, health, code and the calm voices", () => {
    expect(pick({ primary: "comfort_companion", mood: "sad", risk: "high" })).toBe("");
    for (const primary of ["health_guide", "medication_guide", "developer_buddy", "tech_support", "grounding_listener", "researcher"]) expect(pick({ primary }), primary).toBe("");
    expect(pick({ personality: "professional", primary: "celebration_buddy" })).toBe("");
    expect(pick({ personality: "minimal" })).toBe("");
  });

  it("the turn note names the feeling first", () => {
    expect(feelingNote({ mood: "angry", intensity: 0.67 })).toBe("They sound very angry: take their side first; do not tell them to calm down.");
    expect(feelingNote({ mood: "neutral", intensity: 0 })).toBe("");
  });
});

describe("prompt library", () => {
  it("every shape has a brief and an example, and every persona maps to one", () => {
    for (const g of Object.values(GUIDES)) {
      expect(g.brief.length).toBeGreaterThan(20);
      expect(g.example.reply.length).toBeGreaterThan(20);
    }
    for (const p of PERSONAS) expect(GUIDES[shapeOf(p.id)]).toBeDefined();
  });

  it("sends briefs only by default; examples only when switched on, and never for code or editing", () => {
    expect(FEW_SHOT.enabled).toBe(false);
    expect(guideNote("rant_buddy")).toBe(GUIDES.vent.brief);
    FEW_SHOT.enabled = true;
    try {
      expect(guideNote("rant_buddy")).toContain("never reuse its words");
      expect(guideNote("developer_buddy")).toBe("");
      expect(guideNote("editor")).toBe("");
    } finally {
      FEW_SHOT.enabled = false;
    }
  });
});

describe("reply check", () => {
  const ctx = { lang: "en" as const, venting: false, maxSentences: 5 };

  it("drops tips while someone vents, but keeps the reaction", () => {
    const r = review("Your manager did WHAT? Leaving for vacation right after is wild. Try making a list of priorities.", { ...ctx, venting: true });
    expect(r.text).toBe("Your manager did WHAT? Leaving for vacation right after is wild.");
    expect(r.issues).toContain("advice while venting");
  });

  it("keeps tips when they asked a question", () => {
    expect(review("Try the 50/30/20 rule. It is simple to start.", ctx).text).toBe("Try the 50/30/20 rule. It is simple to start.");
  });

  it("keeps only the first question", () => {
    const r = review("That's huge! How long did you train? What's next? Tell me everything.", ctx);
    expect(r.text).toBe("That's huge! How long did you train? Tell me everything.");
  });

  it("drops a template opener when something specific follows - and never leaves nothing", () => {
    expect(review("I'm so sorry to hear that. Losing a spot you worked that hard for really stings.", ctx).text).toBe("Losing a spot you worked that hard for really stings.");
    expect(review("I'm so sorry to hear that.", ctx).text).toBe("I'm so sorry to hear that.");
    expect(review("That's really tough. Two years, ended by a text - that is cold.", ctx).text).toBe("Two years, ended by a text - that is cold.");
    expect(review("That sounds exhausting. Changing it all again is a lot.", ctx).text).toBe("Changing it all again is a lot.");
  });

  it("does not say the same sentence twice in a row, and never sends nothing but a repeat", () => {
    const previous = "It's so easy to get tired. You don't have to handle everything alone.";
    expect(review("You don't have to handle everything alone. A long day in the office wears anyone out.", { ...ctx, previous }).text).toBe("A long day in the office wears anyone out.");
    expect(review("You don't have to handle everything alone.", { ...ctx, previous }).rewrite).toMatch(/something new/);
  });

  it("does not recycle any earlier reply, even reworded a little", () => {
    const earlier = ["You deserve some rest and a snack.", "Pizza sounds great."];
    const r = review("Lying on the couch is the right call. You deserve some peace and a snack.", { ...ctx, earlier });
    expect(r.text).toBe("Lying on the couch is the right call.");
    expect(review("You deserve some rest and a snack.", { ...ctx, earlier }).rewrite).toMatch(/something new/);
  });

  it("drops a verbal tic once it has shown up twice", () => {
    const earlier = ["Home at last. You deserve some peace.", "Stretch a bit - you deserve some rest after that."];
    expect(review("Pepperoni it is. Either way, you deserve some comfort.", { ...ctx, earlier }).text).toBe("Pepperoni it is.");
    // Once is not a tic.
    const once = "Pepperoni it is. You deserve some pepperoni pizza tonight.";
    expect(review(once, { ...ctx, earlier: earlier.slice(0, 1) }).text).toBe(once);
  });

  it("does not ask a question every single turn", () => {
    const previous = "Three chords already! What song are you working on?";
    expect(review("Wonderwall is a great first song. How does it feel to play?", { ...ctx, previous }).text).toBe("Wonderwall is a great first song.");
    // A reply that is only a question is left alone: trimming would leave nothing.
    expect(review("Which one?", { ...ctx, previous }).text).toBe("Which one?");
  });

  it("drops the model narrating its hidden note", () => {
    const r = review("(Note: MewMuze is silently acknowledging their feelings.) That label should have been enough.", ctx);
    expect(r.text).toBe("That label should have been enough.");
  });

  it("asks for the one rewrite when a reply to a vent is nothing but tips", () => {
    const r = review("Remember to take it slow and focus on what's important. Let's prioritize your tasks.", { ...ctx, venting: true });
    expect(r.rewrite).toMatch(/not asking for advice/);
    expect(review("Remember to take it slow.", ctx).rewrite).toBeNull();
  });

  it("drops 'maybe talk to someone' and 'take a break' while they vent", () => {
    expect(review("It's so easy to get tired when things keep changing. Maybe talk to someone you trust or take a break.", { ...ctx, venting: true }).text).toBe(
      "It's so easy to get tired when things keep changing.",
    );
  });

  it("never lets the model narrate the hidden note", () => {
    const r = review("Okay, let's break down what the user is asking for now. Tomorrow, walk in, say hi, and act like nothing happened.", ctx);
    expect(r.text).toBe("Tomorrow, walk in, say hi, and act like nothing happened.");
    expect(review("The note mentions that MewMuze should respond as a playful cat.", ctx).rewrite).toMatch(/never mention notes/);
  });

  it("cuts a reply far longer than its persona's length", () => {
    expect(review("One. Two. Three. Four. Five.", { ...ctx, maxSentences: 3 }).text).toBe("One. Two. Three.");
  });

  it("asks for one rewrite when the language is wrong, not otherwise", () => {
    expect(review("That sounds like a really long day at the office for you.", { ...ctx, lang: "hinglish" }).rewrite).toMatch(/Hinglish/);
    expect(review("Arre yaar, aaj ka din sach mein bahut lamba tha.", { ...ctx, lang: "hinglish" }).rewrite).toBeNull();
    expect(review("You can say: mujhe der ho rahi hai, main aa raha hoon.", { ...ctx, anyLanguage: true }).rewrite).toBeNull();
    expect(review("…", ctx).rewrite).toMatch(/Answer/);
  });
});

describe("context builder", () => {
  const base = {
    system: "SYSTEM",
    history: [{ role: "user" as const, content: "My manager moved my deadline up." }],
    who: { primary: "rant_buddy", secondary: null },
    groupGeneralization: false,
    venting: true,
    lang: "en" as const,
    learned: {},
  };

  it("keeps the system prompt as given and puts the note on the latest message only", () => {
    const t = buildTurn({ ...base, history: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hey! What's up?" }, ...base.history] });
    expect(t.messages[0]).toEqual({ role: "system", content: "SYSTEM" });
    expect(t.messages[1].content).toBe("hi");
    const last = t.messages[t.messages.length - 1].content;
    expect(last.startsWith("My manager moved my deadline up.")).toBe(true);
    expect(last).toContain("No advice, no tips");
    // What MewMuze just did: it asked a question and opened with "Hey What's".
    expect(last).toContain("You asked a question last time");
    expect(last).toContain('Don\'t start with "Hey What\'s" again.');
  });

  it("keeps the note short: every word is read before the first word of the reply", () => {
    const t = buildTurn({ ...base, history: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hey! What's up?" }, ...base.history] });
    const note = t.messages[t.messages.length - 1].content.replace(base.history[0].content, "");
    // The brief replaced the persona's own line - one or the other, not both.
    expect(note).not.toContain(persona("rant_buddy").behavior);
    expect(note.split(/\s+/).length).toBeLessThan(110);
    // Practical personas keep their own, more specific line.
    const money = buildTurn({ ...base, venting: false, who: { primary: "money_coach", secondary: null } });
    expect(money.messages.slice(-1)[0].content).toContain(persona("money_coach").behavior);
  });

  it("says the language last and keeps each language in its script", () => {
    const t = buildTurn({ ...base, lang: "hinglish" });
    expect(t.messages[t.messages.length - 1].content).toMatch(/Hinglish[^()]*\)$/);
    expect(t.options.script).toBe("latin");
    expect(buildTurn({ ...base, lang: "hi" }).options.script).toBe("devanagari");
    expect(buildTurn({ ...base, history: [{ role: "user", content: "How do I say 'thank you' in Hindi?" }] }).options.script).toBeUndefined();
  });

  it("names the words that make the message specific, not filler or Hinglish function words", () => {
    expect(keyWords("I keep checking my ex's Instagram and I hate myself for it.")).toEqual(["instagram", "checking", "keep"]);
    expect(keyWords("Yaar mera boss har meeting mein mujhe hi blame karta hai")).toEqual(["meeting", "blame", "boss"]);
    expect(buildTurn(base).messages.slice(-1)[0].content).toContain('Your reply must mention what they said ("deadline", "manager", "moved")');
    expect(keyWords("ok")).toEqual([]);
  });

  it("samples carefully for safety topics and loosely for play", () => {
    expect(topPFor("health_guide", null)).toBe(0.7);
    expect(topPFor("career_coach", "medication_guide")).toBe(0.7);
    expect(topPFor("chaos_cat", null)).toBe(0.9);
    expect(topPFor("career_coach", null)).toBe(0.8);
    expect(buildTurn({ ...base, who: { primary: "health_guide", secondary: null } }).temperature).toBeLessThan(0.4);
  });

  it("the rewrite is the same conversation plus the draft and one instruction", () => {
    const t = buildTurn(base);
    const m = rewriteMessages(t, "Draft.", "Say the same thing in English.");
    expect(m.slice(0, t.messages.length)).toEqual(t.messages);
    expect(m[m.length - 2]).toEqual({ role: "assistant", content: "Draft." });
    expect(m[m.length - 1].content).toContain("Say the same thing in English.");
  });
});

describe("care line", () => {
  it("adds when to see a doctor to a health answer that never said, and nothing otherwise", () => {
    expect(careLine("health_guide", "Rest, drink water and try a warm bath.", "en")).toMatch(/see a doctor/);
    expect(careLine("health_guide", "Rest well; see a doctor if it lasts.", "en")).toBe("");
    expect(careLine("medication_guide", "Cetirizine treats allergies.", "hinglish")).toMatch(/pharmacist/);
    expect(careLine("career_coach", "Update your CV.", "en")).toBe("");
  });
});

describe("glossary", () => {
  it("defines terms small models invent, and only when the message names them", () => {
    expect(glossaryNote("What is a SIP and is it good for beginners?")).toContain("Systematic Investment Plan");
    expect(glossaryNote("Can I take ibuprofen and paracetamol together?")).toMatch(/NSAID.*liver|liver.*NSAID/);
    // Acronyms are case-sensitive: a sip of water is not an investment plan.
    expect(glossaryNote("I took a sip of water")).toBe("");
    expect(glossaryNote("Tell me a joke")).toBe("");
  });
});

describe("chat-quality scenarios, rules only", () => {
  it("every scenario the rules are sure about lands on an acceptable persona", () => {
    const set = JSON.parse(readFileSync("tests/chat-quality/scenarios.json", "utf8") as string) as {
      single: { id: string; lang: Lang; text: string; expect: string[] }[];
    };
    const wrong: string[] = [];
    let sure = 0;
    for (const sc of set.single) {
      const r = decide(signals(sc.text), { lang: sc.lang, hour: 15, firstMessage: true });
      if (r.confidence < CONFIDENT) continue; // the model decides these in the app
      sure++;
      if (!sc.expect.includes(r.primary)) wrong.push(`${sc.id} -> ${r.primary}`);
    }
    expect(wrong).toEqual([]);
    expect(sure).toBeGreaterThanOrEqual(100);
  });
});

describe("ChatController quality path", () => {
  const stats = (text: string) => ({ text, firstTokenMs: 1, totalMs: 2, tokens: 3, tokensPerSecond: 4, promptTokens: 5, promptMs: 6, finishReason: "stop", cancelled: false });
  function harness(replies: string[]) {
    const calls: { opts?: unknown }[] = [];
    const ai = {
      openChat: vi.fn(async () => undefined),
      closeChat: vi.fn(),
      warm: vi.fn(),
      cancelReply: vi.fn(async () => undefined),
      json: vi.fn(async () => '{"topic":"chat","second":"none","mood":"neutral","intensity":0}'),
      reply: vi.fn(async (_id: string, _m: unknown, onToken: (t: string) => void, _max?: number, _temp?: number, opts?: unknown) => {
        calls.push({ opts });
        const text = replies[Math.min(calls.length - 1, replies.length - 1)];
        onToken(text);
        return stats(text);
      }),
    };
    const personaSeen: (string | null)[] = [];
    const c = new ChatController(
      ai,
      {
        settings: () => ({ ...DEFAULT_COMPANION, chat: { ...DEFAULT_COMPANION.chat, rememberUseful: false } }),
        userName: () => "Sandy",
        osLanguage: () => "en-IN",
        loadMemory: async () => EMPTY_MEMORY,
        saveMemory: async () => undefined,
        onMood: () => undefined,
        now: () => new Date(2026, 8, 12, 15, 0).getTime(),
      },
      (s) => personaSeen.push(s.status === "thinking" ? (s.persona?.primary ?? null) : null),
    );
    return { c, ai, calls, personaSeen };
  }

  it("shows who is answering before the reply arrives", async () => {
    const h = harness(["A headache since yesterday is most often tension or too little sleep. See a doctor if it is sudden and severe."]);
    await h.c.open();
    await h.c.send("I have a bad headache since yesterday");
    expect(h.personaSeen).toContain("health_guide");
  });

  it("rewrites once when the language is wrong, and uses the rewrite only if it passes", async () => {
    const h = harness(["That is so unfair, your boss blaming you in every meeting.", "Yaar ye toh bilkul unfair hai, har meeting mein tumhe hi blame karna."]);
    await h.c.open();
    await h.c.send("Yaar mera boss har meeting mein mujhe hi blame karta hai");
    expect(h.ai.reply).toHaveBeenCalledTimes(2);
    expect(h.c.state().lines.slice(-1)[0]?.text).toMatch(/^Yaar ye toh bilkul unfair hai/);
    expect(h.c.state().route).toMatchObject({ rewritten: true, language: "hinglish" });
    expect(h.calls[0].opts).toMatchObject({ script: "latin" });
  });

  it("treats 'call me Sandy, keep it short' as an instruction to acknowledge, not more venting", async () => {
    const h = harness(["Changing everything again is a lot.", "Got it, Sandy - short it is."]);
    await h.c.open();
    await h.c.send("My manager changed everything again.");
    await h.c.send("Call me Sandy and keep it short please.");
    const sent = (h.ai.reply.mock.calls[1] as unknown as [string, { content: string }[]])[1];
    const note = sent[sent.length - 1].content;
    expect(note).toContain("acknowledge it in a few words");
    expect(note).not.toContain("Listen only");
  });

  it("never rewrites twice: a failed rewrite leaves the first draft", async () => {
    const h = harness(["That is so unfair, your boss blaming you in every meeting.", "Still English here, sorry about that friend."]);
    await h.c.open();
    await h.c.send("Yaar mera boss har meeting mein mujhe hi blame karta hai");
    expect(h.ai.reply).toHaveBeenCalledTimes(2);
    expect(h.c.state().lines.slice(-1)[0]?.text).toMatch(/^That is so unfair, your boss blaming you in every meeting\. \p{Extended_Pictographic}/u);
  });
});
