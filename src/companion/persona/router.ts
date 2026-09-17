//! The Persona Router: which persona answers this message, and how the cat
//! reacts. Text only - by the time a message gets here nobody knows (or
//! cares) whether it was typed or spoken.
//!
//!   signals(text)         cheap, deterministic: topics, mood, intent, risk
//!   decide(signals)       -> Routing; confident cases never touch the model
//!   CLASSIFY_* + fromModel  the loaded Qwen, only when the rules are unsure
//!   PersonaState          continuity: no personality whiplash
//!
//! The Routing object is internal. The user never sees it (except in the
//! developer-only debug line, off by default).

import { detectLanguage } from "../language";
import { MOODS, type MoodName } from "../mood";
import type { Lang } from "../phrases";
import { DEFAULT_PERSONA, TOPICS, TOPIC_PERSONA, allowsSecondary, persona, type StyleBucket, type Topic } from "./personas";

export type Intent = "vent" | "question" | "request" | "share_good" | "chat";
export type Risk = "none" | "medium" | "high";
export type CurrentKind = "weather" | "time" | "news" | "price" | "other";

export interface Signals {
  topics: Partial<Record<Topic, number>>;
  risk: Risk;
  mood: MoodName;
  intensity: number;
  intent: Intent;
  /** Venting about what a specific person did (Savage Bestie territory). */
  someoneBehavior: boolean;
  /** "Men are all terrible": acknowledge the hurt, never agree. */
  groupGeneralization: boolean;
  mockInterview: boolean;
  eli5: boolean;
  hype: boolean;
  current: CurrentKind | null;
  /** "ok", "hmm", "thanks": says nothing about topic. */
  phatic: boolean;
  greeting: boolean;
  sleepless: boolean;
  /** A short question put to MewMuze itself. */
  aboutCat: boolean;
  words: number;
}

export interface Routing {
  language: Lang;
  domain: Topic;
  intent: Intent;
  mood: MoodName;
  intensity: number;
  primary: string;
  secondary: string | null;
  confidence: number;
  risk: Risk;
  needsCurrentInformation: boolean;
  currentKind: CurrentKind | null;
  groupGeneralization: boolean;
  /** Where the decision came from - for the eval suite and the debug line. */
  source: "rules" | "model" | "continuity" | "default";
}

type Lexicon = readonly (readonly [RegExp, number])[];

// Weights: 3 = unmistakable on its own, 2 = clear, 1 = a hint.
const LEX: Record<Topic, Lexicon> = {
  chat: [],
  vent: [
    [/\b(so annoying|annoyed|fed up|sick of|tired of (this|it|him|her|them|my)|can'?t stand|i hate (it|this|when|how|that)|frustrat\w*|pissed( off)?|irritat\w*|ugh+|argh+|rant|need to vent|let me vent)\b/i, 3],
    [/\b(pareshaan|pareshan|dimag kharab|bakwaas|bakwas|pagal kar|chidh|irritate)\b/i, 3],
    // "manager ne phir sab badal diya", "boss again changed everything"
    [/\b(boss|manager|teacher|landlord|coworker|colleague|client|roommate|neighbou?r|saas|sasur)\b.{0,40}\b(again|always|never|keeps|yelled|blamed|changed|ignored|moved|dumped|piled|left for|phir|fir|firse|phirse|hamesha|kabhi nahi)\b/i, 3],
    [/\b(ne)\s+(fir|phir|firse|phirse)\b/i, 2],
    // "40 minutes on hold just to get disconnected": the ordeal IS the vent.
    [/\b((spent|wasted|waited) \d+ (minutes|hours|mins)|on hold (for|with)|just to (get|be) (disconnected|told|rejected|ignored))\b/i, 3],
    [/\b(upar se|attitude (bhi|dikha\w*)|natak kar\w*|drama kar\w*)\b/i, 3],
    [/(परेशान|दिमाग खराब|चिढ़)/, 3],
  ],
  sad: [
    [/\b(sad|feel(ing)? (so |really |very |pretty |kinda |a bit )?(down|low|awful|terrible|horrible|empty|miserable|bad about)|depressed|crying|cried|heartbroken|miserable|disappointed|rough day|bad day|terrible day|worst day|hate my life|feel awful)\b/i, 3],
    [/\b(dukhi|udaas|udas|rona aa|ro raha|ro rahi|bura lag|mann nahi|man nahi|dil nahi lag|low feel|mood off|accha nahi lag|acha nahi lag)\b/i, 3],
    [/\b(upset|hurt|let down|feel like a failure|not good enough)\b/i, 2],
    // Disappointment and loss without a feeling word.
    [/\b(didn'?t get (in|into|selected|the (job|role|spot|place|offer))|got rejected|(i )?failed (my|the)|nobody remembered|no one remembered|i miss (her|him|them|my)|miss (her|him|them) (so much|a lot)|moved (away|to another))\b/i, 3],
    [/\b(dog|cat|puppy|kitten|pet)\b.{0,60}\b(old|sick|dying|passed away|put down|vet said|not much time)\b/i, 3],
    [/(दुखी|उदास|रोना|बुरा लग|दिन (बहुत )?खराब|उल्टा हो गया)/, 3],
  ],
  distress: [
    [/\b(overwhelm\w*|panic attack|panicking|can'?t cope|falling apart|breaking down|too much to handle|spiral\w*|traumati[sz]\w*|trauma|shaking|anxiety attack|can'?t stop crying|can'?t think straight|feels like too much|everything is too much)\b/i, 3],
    [/\b(ghabrahat|ghabra (raha|rahi|gaya|gayi)|sambhal nahi)\b/i, 3],
    [/(घबराहट|घबरा)/, 3],
  ],
  romance: [
    [/\b(crush|dating|tinder|bumble|hinge|first date|a date|been on .{0,12}dates|asked (her|him) out|ask (her|him) out|propos(e|al)|flirt\w*|text (her|him) first|(she|he) likes me|do (they|she|he) like me|in love|love life|romantic|situationship|eye contact|say hi to (him|her)|anniversary|surprise (for )?my (wife|husband|partner|girlfriend|boyfriend))\b/i, 3],
    [/\b(pyaar|pyar|ishq|mohabbat|pasand (hai|karti|karta|aa gayi|aa gaya)|setting)\b/i, 3],
    [/\b(girlfriend|boyfriend|gf|bf|partner)\b/i, 1],
    [/(प्यार|इश्क|क्रश)/, 3],
  ],
  breakup: [
    [/\b(broke up|break ?up|breakup|dumped|ex[- ]?(boyfriend|girlfriend|bf|gf)|my ex\b|rejected me|(she|he) left me(?! on read)|left me for|ghosted me|moving on from)\b/i, 3],
    [/\b(chhod (diya|di|gayi|gaya)|dil toot|brekup|breakup ho)\b/i, 3],
    [/(ब्रेकअप|छोड़ दिया|दिल टूट)/, 3],
  ],
  relationship: [
    [/\b(divorc\w*|separat(ed|ion)|marriage (problems|counsel\w*)|trust issues|we keep fighting|keep arguing|couples?)\b/i, 3],
    [/\b(fight\w*|fought|argu(e|ed|ing|ment)|disagree\w*|communicat\w*)\b.{0,50}\b(wife|husband|partner|spouse|boyfriend|girlfriend|mom|mother|dad|father|parents|sister|brother|friend|roommate|in-?laws)\b/i, 3],
    [/\b(wife|husband|partner|spouse|boyfriend|girlfriend|mom|mother|dad|father|parents|sister|brother|in-?laws)\b.{0,50}\b(fight\w*|fought|argu\w+|won'?t listen|doesn'?t listen|never listens|angry at me|upset with me|ignores me)\b/i, 3],
    [/\b(mom|mother|dad|father|parents|family|in-?laws|aunt|uncle)\b.{0,40}\b(keeps? (commenting|critici[sz]ing|nagging|taunting)|comments? on my|always (critici[sz]e|comment))/i, 3],
    [/\b(tell|talk to|confront) my (friend|partner|mom|dad|sister|brother|wife|husband)\b.{0,40}\b(hurt|upset|bothered)\b|\bwithout starting a fight\b/i, 3],
    [/\b(jhagda|jhagada|ladai|ladaai|naraz|naaraz)\b/i, 3],
    [/(झगड़ा|लड़ाई|नाराज़)/, 3],
  ],
  health: [
    [/\b(symptoms?|fever|headache|migraine|cough\w*|sore throat|stomach ?(ache|pain|bug)|nause\w*|vomit\w*|diarrh\w*|rash|dizz\w*|blood pressure|infection|allerg\w*|sprain\w*|surgery|not feeling well|feeling sick|i'?m sick|i am sick|feel sick|chest pain|can'?t breathe|trouble breathing|diabet\w*|thyroid|period cramps?|back pain|throat|sneez\w*|runny nose|blocked nose|stuffy nose)\b/i, 3],
    [/\b(doctor|hospital|clinic|pain in my|hurts when|injur\w*|flu|cold)\b/i, 2],
    [/\b(bimaar|beemar|bukhar|bukhaar|tabiyat|tabiyet|sar dard|sir dard|pet dard|khansi|zukam|jukam)\b/i, 3],
    [/(बुखार|तबीयत|बीमार|सिर दर्द|खांसी|जुकाम|डॉक्टर)/, 3],
  ],
  medicine: [
    [/\b(medicine|medication|tablets?|pills?|dosage|dose|paracetamol|acetaminophen|ibuprofen|aspirin|antibiotics?|crocin|dolo|combiflam|cetirizine|antihistamines?|side effects?|interacts? with|can i take|prescri\w*)\b/i, 3],
    [/\b(dawai|dawaai|dawa|goli)\b/i, 3],
    [/(दवाई|दवा|गोली)/, 3],
  ],
  fitness: [
    [/\b(workout|exercis\w*|gym|cardio|push-?ups?|squats?|plank|lose weight|weight loss|build muscle|abs|stretching|yoga|steps a day|running (plan|faster)|marathon|stamina)\b/i, 3],
    [/\b(kasrat|vyayam)\b/i, 3],
  ],
  food: [
    [/\b(diet|nutrition|protein|calories|carbs|meal ?prep|healthy (food|eating|snacks?|breakfast)|what should i eat|vegetarian|vegan|breakfast ideas|dinner ideas|lunch ideas)\b/i, 3],
    [/\b(khana|khaana|nashta)\b/i, 1],
    [/\b(kya (khau|khaun|khaau|khaaun|khayein|khana chahiye)|dinner mein|breakfast mein|lunch mein|diet (plan|chart))\b/i, 3],
  ],
  money: [
    [/\b(budget\w*|save money|savings?|expenses?|spending|loan|emi|debt|credit card|bills|afford|joint (accounts?|investments?|finances|assets|property)|our (investments|finances|savings)|investments|salary)\b/i, 3],
    [/\b(rent|money)\b/i, 1],
    [/\b(paisa|paise|kharcha|bachat|udhaar|udhar|karz|karza)\b/i, 3],
  ],
  investing: [
    [/\b(stocks?|shares|mutual funds?|sip|index funds?|etf|portfolio|crypto\w*|bitcoin|nifty|sensex|fixed deposit|dividends?|equity|bonds?|should i invest|investing|invest in)\b/i, 3],
  ],
  career: [
    [/\b(career|resume|cv|promotion|appraisal|salary negotiation|negotiat\w*|switch (jobs?|careers?)|quit my job|linkedin|recruiter|job offer|job hunt\w*|new job|my job|at work|office politics|layoffs?|laid off|fired)\b/i, 3],
    [/\b(manager|boss|office|colleague|coworker|workplace|naukri)\b/i, 1],
    [/\b(kaam|office)\b/i, 1],
    [/\b(job switch|naukri (badal\w*|chhod\w*)|growth nahi|appraisal|hike nahi)\b/i, 3],
  ],
  interview: [[/\b(interview\w*|hr round|technical round|tell me about yourself)\b/i, 3]],
  learning: [
    [/\b(teach me|help me understand|learn\w*|study(ing)?|exam|homework|concept|revision|syllabus|chapter)\b/i, 2],
    [/\b(explain|what is|what are|how does|how do .{1,30} work|why does|why is|why do)\b/i, 1],
    [/\b(difference between|how .{1,20} works)\b/i, 2],
    [/\b(maths?|physics|chemistry|biology|history|geography|economics|algebra|calculus|grammar)\b/i, 2],
    [/\b(samjhao|samjha do|kya hota hai|kaise kaam)\b/i, 2],
  ],
  code: [
    [/\b(code|coding|bug|stack ?trace|exception|compile\w*|javascript|typescript|python|java|c\+\+|rust|react|sql|regex|git|npm|null pointer|segfault|syntax error|function|variable|api|css|html|div|flexbox)\b/i, 3],
    [/(=>|\bdef |\bfunction\s*\(|;\s*$|```)/m, 3],
  ],
  tech: [
    [/\b(wi-?fi|internet (is )?(not|isn'?t|slow|down)|won'?t (turn on|boot|start|connect|charge)|not working|keeps crashing|crash\w*|blue screen|bsod|printer|bluetooth|drivers?|update failed|slow (pc|computer|laptop)|laptop (is|won'?t)|phone (is|won'?t)|reset my|install\w*)\b/i, 3],
    [/\b(chal nahi raha|kaam nahi kar raha|band ho gaya|hang ho)\b/i, 2],
  ],
  creative: [
    [/\b(brainstorm\w*|ideas? for|story|poem|lyrics|song|name ideas|come up with|imagine|plot|creative|write me a|shayari|kavita|kahani|character ideas|(need |a |good )name for (my|a|our))\b/i, 3],
  ],
  writing: [
    [/\b(proofread|edit (this|my)|rewrite|rephrase|improve (this|my) (text|email|writing|essay|paragraph|message|bio)|make (this|it) sound|cover letter|fix (my|the|this) grammar|correct (the|this) (grammar|sentence))\b/i, 4],
  ],
  decision: [
    [/\b(pros and cons|which (one|is better|should)|decide|decision|torn between|choose between|or should i|what would you (do|choose))\b/i, 3],
    [/\bshould i\b.{1,60}\bor\b/i, 3],
    // A bare "should I" is often just a how-to ("what should I pack"): a hint.
    [/\bshould i\b(?!.{1,60}\bor\b)/i, 1],
    [/\b(kya karu|kya karun|kya karoon|kaunsa|konsa|kaun sa)\b/i, 3],
  ],
  procrastination: [
    [/\b(procrastinat\w*|can'?t (start|focus|get started|get myself to)|putting (it|this) off|putting off|keep delaying|no motivation|feeling lazy|so lazy|avoiding (my|the) (work|task|assignment)|keep (scrolling|delaying)|instead of (studying|working|doing (it|my)))\b/i, 3],
    [/\b(kal se|aalas|alas|mann nahi kar raha)\b/i, 2],
  ],
  productivity: [
    [/\b(plan my (day|week)|to-?do|prioriti[sz]\w*|schedul\w*|time management|focus (tips|better)|deadlines?|organi[sz]e my|daily routine|pomodoro|too many tasks)\b/i, 3],
    // Outranks "at work": staying focused AT work is still a focus question.
    [/\b(stop getting distracted|distracted by|distractions?|notifications)\b/i, 4],
  ],
  stress: [
    // First-person and strong: the feeling IS the message (Calm Companion leads).
    [/\b(i'?m|i am|feeling|feel|so|really) (so |really |very |super |totally )?(stressed( out)?|anxious|overwhelmed|burnt out|burned out|overstimulated|freaking out)\b/i, 3],
    [/\b(nothing is (packed|done|ready)|haven'?t (even )?started|so much to do|head is spinning)\b/i, 2],
    [/\b(stress\w*|anxious|anxiety|nervous|worried|worry(ing)?|tension|pressure|overthinking|burn(ed|t)? out|burnout|restless|overstimulated|too loud|too much noise)\b/i, 2],
    [/\b(chinta|tension ho|ghabra)\b/i, 2],
    [/(चिंता|तनाव)/, 2],
  ],
  lonely: [
    [/\b(lonely|so alone|no one to talk|nobody to talk|keep me company|talk to me|just chat|miss (having|talking)|no friends)\b/i, 3],
    [/\b(bored)\b/i, 1],
    [/\b(akela|akeli|bore ho)\b/i, 3],
    [/(अकेला|अकेली)/, 3],
  ],
  good_news: [
    [/\b(got (the|a|my) (job|offer|promotion)|got promoted|i passed|we won|i won|got accepted|got in|good news|guess what|engaged|nailed it|crushed it|i did it|finally did it|got selected|finally (finished|passed|got)|(finished|completed|ran) my first|we adopted|adopted a|got a (puppy|kitten|dog|cat))\b/i, 3],
    [/(मिल गया|मिल गई|प्रमोशन|पास हो गया|पास हो गई)/, 3],
    [/\b(so happy|so excited|can'?t wait|yay+|woo+hoo)\b/i, 2],
    [/\b(khush|mil gayi|mil gaya|ho gaya select|select ho gaya|pass ho gaya|pass ho gayi)\b/i, 3],
  ],
  banter: [
    [/\b(joke|funny|roast me|entertain me|make me laugh|tell me something funny|bored lol)\b/i, 3],
    [/\b(lol|lmao|haha+|hehe+|rofl)\b/i, 1],
    [/\b(mazaak|mazak|hasao)\b/i, 3],
  ],
  critique: [[/\b(roast (my|this)|be (brutally )?honest|critique|criticize|tear (it|this) apart|what'?s wrong with (my|this)|feedback on|review my)\b/i, 3]],
  debate: [[/\b(devil'?s advocate|argue (against|the other side)|challenge (me|my)|poke holes|counter ?argument|convince me otherwise|change my mind)\b/i, 3]],
  research: [
    [/\b(research|compare|statistics|data on|sources?|who (invented|discovered|founded)|when did|history of|facts about|latest news|what'?s the latest)\b/i, 2],
    [/\b(how many|who is|who was)\b/i, 1],
  ],
  travel: [
    [/\b(travel\w*|trip|flight|visa|itinerary|pack(ing)? list|hotel|time ?zone|jet ?lag|what time is it in|visiting|vacation|holiday plans?)\b/i, 3],
    [/\b(ghumne|safar|yatra)\b/i, 3],
  ],
  language: [
    [/\b(how do (you|i) say|translate|meaning of|correct my (english|hindi|grammar|sentence)|practi[cs]e (english|hindi|spanish|french|german|japanese)|is this sentence correct|learn (spanish|french|english|hindi|japanese|german))\b/i, 3],
  ],
};

const RISK_HIGH: readonly RegExp[] = [
  /\b(kill myself|end my life|end it all|suicid\w*|want to die|wanna die|don'?t want to (live|be alive|exist)|hurt(ing)? myself|self[- ]harm|cut myself|no reason to live|better off dead)\b/i,
  /\b(marna chahta|marna chahti|mar jaana chahta|mar jana chahti|jeena nahi chahta|jeena nahi chahti|khudkushi|suicide kar|khud ko (hurt|nuksaan|nuksan|maar|khatam)|apne aap ko (hurt|nuksaan|nuksan|maar|khatam))\b/i,
  /(आत्महत्या|मरना चाहता|मरना चाहती|जीना नहीं)/,
];
const RISK_MEDIUM = /\b(chest pain|can'?t breathe|trouble breathing|unconscious|overdos\w*|heart attack|stroke|seizure|heavy bleeding|fainted)\b/i;

const MOOD_LEX: readonly (readonly [MoodName, RegExp])[] = [
  ["angry", /\b(furious|so angry|pissed|livid|rage|gussa|gusse)\b|गुस्सा/i],
  ["frustrated", /\b(annoyed|frustrat\w*|fed up|irritat\w*|sick of|ugh+|pareshaan|pareshan|dimag kharab)\b|परेशान/i],
  ["sad", /\b(sad|down|low|awful|miserable|heartbroken|crying|cried|lonely|disappointed|upset|hurt|broke up|dumped|dukhi|udaas|udas)\b|दुखी|उदास/i],
  ["stressed", /\b(stress\w*|anxious|nervous|worried|worry|terrified|scared|afraid|overwhelm\w*|panic\w*|tension|chinta|ghabra\w*)\b|चिंता|घबरा/i],
  ["tired", /\b(tired|exhausted|sleepy|drained|worn out|thak gaya|thak gayi|thaka|neend)\b|थक/i],
  ["excited", /\b(excited|can'?t wait|omg|so happy|yay+|woo+hoo|got the job|got promoted|nailed it)\b|!!/i],
  ["happy", /\b(happy|glad|great day|good day|feeling good|khush|mazaa aa)\b|खुश/i],
  ["playful", /\b(lol|lmao|haha+|hehe+|joke|roast)\b/i],
];
const INTENSIFIER = /\b(so|very|really|extremely|super|totally|bahut|bohot|bhot|itna|kitna)\b|!{2,}/i;
// Topics that make a message a vent. Not "stress": "I'm worried about our
// joint investments" is a question about money with worry in it - the worry
// is the mood (and maybe the secondary), not the lead.
const EMOTION_TOPICS: readonly Topic[] = ["vent", "sad", "distress", "breakup", "lonely"];

const CURRENT: readonly (readonly [CurrentKind, RegExp])[] = [
  ["weather", /\b(weather|temperature outside|rain(ing)? (today|tomorrow)|forecast|mausam|barish)\b|मौसम/i],
  ["time", /\b(what time is it|time (is it )?in [a-z]+|today'?s date|what'?s the date|what day is it)\b/i],
  ["news", /\b(news|headlines?|what'?s happening|latest on|khabar)\b/i],
  ["price", /\b(price of|stock price|share price|exchange rate|dollar rate|rupee rate|bitcoin (price|rate)|gold (price|rate)|how much is .{1,20} (today|now))\b/i],
  ["other", /\b(right now|currently|latest|this week'?s|live score|who won|score of)\b/i],
];

const PHATIC = /^(ok(ay)?|k|kk|hmm+|hm+|oh|ah|yes|yeah|yep|no|nope|nah|sure|thanks?( you)?|ty|thx|cool|nice|great|lol|haha+|acha|accha|achha|theek hai|thik hai|haan|han|nahi|hmm ok|okay then|right)[.!?\s]*$/i;
const ABOUT_CAT = /\b(you|your|yourself|u|ur|tum|tumhara|tumhe|aap)\b/i;
const GREETING = /^(hi|hey|hello|hii+|yo|good (morning|afternoon|evening|night)|gm|namaste|hola|sup)\b/i;
const MOCK = /\b(mock|practi[cs]e|prepare|prep|questions (they|might|could)|ask me (interview )?questions)\b/i;
const ELI5 = /\b(eli5|like i'?m (5|five|a kid|a child|a baby|ten|10)|in simple (words|terms)|simply explain|explain (it )?simply|aasaan bhasha|simple mein)\b/i;
const SLEEPLESS = /\b(can'?t sleep|cannot sleep|insomnia|still awake|up so late|awake at \d|neend nahi)\b|नींद नहीं/i;
const HYPE = /\b(hype me|wish me luck|pump me up|cheer me on|motivate me|i can do (this|it)|need (some )?encouragement)\b/i;
const SOMEONE = /\b(he|she|they|my (boss|manager|ex|friend|roommate|coworker|colleague|bf|gf|boyfriend|girlfriend|sister|brother|husband|wife|partner|mom|dad))\b.{0,40}\b(ignored|ghosted|lied|cheated|blamed|took credit|left me on read|didn'?t (reply|text|call)|flaked|cancel+ed|stood me up|keeps? interrupting|talks? over me|borrowed|ate my|broke my|took my|forgot (our|my))\b|\b(left me on read|ghost(ed|ing) me|cheated on me|stood me up)\b|\bmy ex\b.{0,30}\b(texted|messaged|dm'?d|called|slid into)\b|\bu up\b/i;
/** Hostility at a whole sex/gender/group - the one thing Savage Bestie may never echo. */
export const GROUP = /\b(all )?(men|women|guys|girls|boys|ladies|males|females|husbands|wives|boyfriends|girlfriends|ladke|ladkiyan|ladkiyaan)\b(?: are| r| can be| can all be| are just| r just|,)? (all |the |just )?(trash|terrible|the worst|useless|pigs|dogs|idiots|stupid|evil|liars|cheaters|same|garbage|awful|toxic|bekaar|bekar)\b/i;
const QUESTION = /\?\s*$|^(what|why|how|when|where|who|which|can|could|should|would|is|are|do|does|did|will|kya|kaise|kyun|kyu|kab|kahan|kaun)\b/i;
const REQUEST = /^(please |pls |plz )?(help|explain|write|make|give|tell|fix|plan|teach|suggest|recommend|list|create|show|translate|rewrite|check|review|compare|summari[sz]e|batao|bata do|samjhao)\b/i;

function hits(text: string, lex: Lexicon): number {
  let s = 0;
  for (const [re, w] of lex) if (re.test(text)) s += w;
  return s;
}

/** Everything cheap that can be read from the text itself. */
export function signals(text: string): Signals {
  const t = text.trim();
  const words = (t.match(/[\p{L}\p{N}']+/gu) ?? []).length;
  const topics: Partial<Record<Topic, number>> = {};
  for (const topic of TOPICS) {
    const s = hits(t, LEX[topic]);
    if (s > 0) topics[topic] = s;
  }
  const risk: Risk = RISK_HIGH.some((re) => re.test(t)) ? "high" : RISK_MEDIUM.test(t) ? "medium" : "none";
  if (risk === "high") topics.distress = Math.max(topics.distress ?? 0, 5);
  if (risk === "medium") topics.health = Math.max(topics.health ?? 0, 5);

  let mood: MoodName = MOOD_LEX.find(([, re]) => re.test(t))?.[0] ?? "neutral";
  // No feeling word, but the topic carries one: "my manager changed
  // everything AGAIN" is frustration even without the word.
  if (mood === "neutral") {
    const implied: [Topic, MoodName][] = [["vent", "frustrated"], ["breakup", "sad"], ["sad", "sad"], ["distress", "stressed"], ["stress", "stressed"], ["lonely", "sad"], ["good_news", "excited"], ["banter", "playful"]];
    mood = implied.find(([topic]) => (topics[topic] ?? 0) >= 2)?.[1] ?? "neutral";
  }
  const intensity = mood === "neutral" ? 0 : Math.min(1, (INTENSIFIER.test(t) ? 0.67 : 0.34) + (/!/.test(t) || /[A-Z]{4,}/.test(t) ? 0.33 : 0));

  const groupGeneralization = GROUP.test(t);
  if (groupGeneralization) topics.vent = Math.max(topics.vent ?? 0, 3);
  const someoneBehavior = SOMEONE.test(t);
  // What someone DID is a vent even without a vent word ("cancelled on me again").
  if (someoneBehavior) topics.vent = Math.max(topics.vent ?? 0, 3);
  const eli5 = ELI5.test(t);
  if (eli5) topics.learning = Math.max(topics.learning ?? 0, 3);
  const hype = HYPE.test(t);
  if (hype) topics.good_news = Math.max(topics.good_news ?? 0, 3);
  const current = CURRENT.find(([, re]) => re.test(t))?.[0] ?? null;

  const emotional = EMOTION_TOPICS.some((x) => (topics[x] ?? 0) >= 2) || (topics.stress ?? 0) >= 3 || groupGeneralization;
  const intent: Intent =
    (topics.good_news ?? 0) >= 2
      ? "share_good"
      : QUESTION.test(t)
        ? "question"
        : REQUEST.test(t)
          ? "request"
          : emotional
            ? "vent"
            : "chat";

  return {
    topics, risk, mood, intensity, intent, someoneBehavior, groupGeneralization,
    mockInterview: MOCK.test(t), eli5, hype, current,
    phatic: PHATIC.test(t), greeting: GREETING.test(t), sleepless: SLEEPLESS.test(t), aboutCat: words <= 14 && QUESTION.test(t) && ABOUT_CAT.test(t), words,
  };
}

/** A topic's persona, refined by the flags a table cannot express. */
export function personaForTopic(topic: Topic, s: Pick<Signals, "someoneBehavior" | "mockInterview" | "eli5" | "hype" | "mood" | "groupGeneralization">): string {
  if (topic === "vent" && (s.someoneBehavior || s.groupGeneralization) && s.mood !== "sad") return "savage_bestie";
  // "My ex texted 'u up?' after ghosting me lol": laughing at it, not grieving it.
  if (topic === "breakup" && s.someoneBehavior && s.mood === "playful") return "savage_bestie";
  if (topic === "interview" && s.mockInterview) return "interview_trainer";
  if (topic === "learning" && s.eli5) return "eli5_teacher";
  if (topic === "good_news" && s.hype) return "hype_cat";
  return TOPIC_PERSONA[topic];
}

/** Rules confident enough that the model is not asked. */
export const CONFIDENT = 0.6;

function confidenceFor(score: number): number {
  return score >= 5 ? 0.92 : score >= 3 ? 0.82 : score >= 2 ? 0.66 : score >= 1 ? 0.45 : 0;
}

/** The no-topic persona: the time of day decides. */
export function defaultPersona(hour: number, s: Pick<Signals, "greeting">, firstMessage: boolean): string {
  if (hour >= 23 || hour < 5) return "night_owl";
  if (hour >= 5 && hour < 10 && (s.greeting || firstMessage)) return "morning_companion";
  return DEFAULT_PERSONA;
}

export interface RouteContext {
  lang: Lang;
  hour: number;
  firstMessage: boolean;
}

/** The deterministic decision. `source: "default"` means the rules found no topic. */
export function decide(s: Signals, ctx: RouteContext): Routing {
  const base = {
    language: ctx.lang,
    intent: s.intent,
    mood: s.mood,
    intensity: s.intensity,
    risk: s.risk,
    needsCurrentInformation: s.current !== null,
    currentKind: s.current,
    groupGeneralization: s.groupGeneralization,
  };
  if (s.risk === "high") {
    return { ...base, domain: "distress", primary: "grounding_listener", secondary: null, confidence: 0.95, mood: s.mood === "neutral" ? "sad" : s.mood, source: "rules" };
  }
  const ranked = (Object.entries(s.topics) as [Topic, number][])
    .map(([topic, score]) => ({ topic, score, id: personaForTopic(topic, s) }))
    .sort((a, b) => b.score - a.score || persona(b.id).rank - persona(a.id).rank);
  // One persona per id: two topics can map to the same persona.
  const seen = new Set<string>();
  const cands = ranked.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  if (cands.length === 0) {
    // Awake in the small hours with nothing specific on their mind: that IS Night Owl.
    if (s.sleepless) return { ...base, domain: "chat", primary: "night_owl", secondary: null, confidence: 0.7, source: "rules" };
    // A live-data question with nothing else in it: the rules know what it is.
    // (In the live eval the model filed "what's the weather this evening" under
    // tech support, after 5.6 s.)
    if (s.current) {
      const travel = s.current === "weather" || s.current === "time";
      return { ...base, domain: travel ? "travel" : "research", primary: travel ? "travel_companion" : "researcher", secondary: null, confidence: 0.7, source: "rules" };
    }
    // A question about MewMuze itself ("what do you do all day?") is just chat.
    if (s.aboutCat) return { ...base, domain: "chat", primary: defaultPersona(ctx.hour, s, ctx.firstMessage), secondary: null, confidence: 0.7, source: "rules" };
    return { ...base, domain: "chat", primary: defaultPersona(ctx.hour, s, ctx.firstMessage), secondary: null, confidence: 0, source: "default" };
  }

  // Who leads: a safety topic always; the feeling when they are venting; the
  // subject when they ask; otherwise the strongest signal, ties to rank.
  const strong = cands.filter((c) => c.score >= 2);
  const safety = strong.find((c) => persona(c.id).safety);
  const feeling = s.intent === "vent" ? strong.find((c) => persona(c.id).emotional || c.id === "savage_bestie") : undefined;
  const lead = safety ?? feeling ?? cands[0];

  // At most one secondary: the next clear topic the lead allows, else the
  // feeling behind a practical question ("surgery... I'm terrified").
  // Behind a vent even a hint names what it is about ("my MANAGER changed
  // everything again" is work): the listener leads, the subject colours it.
  const pool = persona(lead.id).emotional || lead.id === "savage_bestie" ? cands : strong;
  let secondary: string | null = pool.find((c) => c.id !== lead.id && allowsSecondary(lead.id, c.id))?.id ?? null;
  if (!secondary && s.intensity > 0.3 && !persona(lead.id).emotional) {
    const byMood: Partial<Record<MoodName, string>> = { sad: "comfort_companion", stressed: "comfort_companion", frustrated: "rant_buddy", angry: "rant_buddy" };
    const m = byMood[s.mood];
    if (m && allowsSecondary(lead.id, m)) secondary = m;
  }
  return { ...base, domain: lead.topic, primary: lead.id, secondary, confidence: confidenceFor(lead.score), source: "rules" };
}

// ---- the model, only when the rules are unsure ---------------------------------------

/** Handed to llama-server as a grammar: the model cannot answer outside it. */
export const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string", enum: [...TOPICS] },
    second: { type: "string", enum: [...TOPICS, "none"] },
    mood: { type: "string", enum: [...MOODS] },
    intensity: { type: "integer", enum: [0, 1, 2, 3] },
  },
  required: ["topic", "second", "mood", "intensity"],
  additionalProperties: false,
} as const;

/**
 * Asked as the next turn of the SAME conversation, so the model's prompt cache
 * (system prompt + history + this message) is reused and only this short note
 * is new work.
 */
export const CLASSIFY_NOTE =
  "(Internal note for the desktop cat, not part of the chat.) Classify the user's last message. " +
  `topic = what it is mainly about, one of: ${TOPICS.join(", ")}. second = another topic that clearly also applies, or none. ` +
  "mood = the user's feeling; intensity 0 none, 1 mild, 2 clear, 3 very strong. " +
  "Answer only with the JSON. /no_think";

export function shouldAskModel(r: Routing, s: Signals, activePersona: string): boolean {
  if (r.risk !== "none" || r.confidence >= CONFIDENT || s.phatic) return false;
  // "Good morning!" is small talk, not a puzzle for the model.
  if (s.greeting && Object.keys(s.topics).length === 0) return false;
  // A short follow-up inside an established conversation ("I don't know what
  // I did") is continuity, not a new topic: no inference spent on it.
  if (activePersona !== DEFAULT_PERSONA && s.words < 12) return false;
  return s.words >= 5;
}

/** Validate the model's JSON into a Routing; anything malformed is rejected (null). */
export function fromModel(raw: string, s: Signals, ctx: RouteContext): Routing | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const topic = TOPICS.find((x) => x === o.topic);
  const second = o.second === "none" ? null : TOPICS.find((x) => x === o.second) ?? undefined;
  const mood = MOODS.find((m) => m === o.mood);
  const level = o.intensity;
  if (!topic || second === undefined || !mood || typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 3) return null;
  // The model supplies what the rules could not see; the flags the rules DID
  // see (someone's behaviour, a mock interview) still refine the persona.
  // A feeling the user NAMED ("I'm furious") beats the model's guess: live,
  // the 1.7B classifier once filed "kind of furious" as happy.
  const named = s.mood !== "neutral";
  const merged: Signals = { ...s, mood: named ? s.mood : mood, intensity: named ? s.intensity : level / 3, topics: { ...s.topics } };
  merged.topics[topic] = Math.max(merged.topics[topic] ?? 0, 3);
  if (second && second !== topic) merged.topics[second] = Math.max(merged.topics[second] ?? 0, 2);
  if (topic === "chat" && !second) {
    return { ...decide({ ...merged, topics: {}, current: null, aboutCat: false }, ctx), source: "model", confidence: 0.7 };
  }
  const r = decide(merged, ctx);
  return { ...r, source: "model", confidence: 0.7 };
}

// ---- continuity ------------------------------------------------------------------------

/** After this long without a message the conversation starts fresh. */
const IDLE_RESET_MS = 30 * 60_000;
/** Turns a secondary persona survives without being mentioned again. */
const SECONDARY_TURNS = 3;
const SWITCH = 0.75;
/** Messages in a row with no topic before a specialist hands the chat back to MewMuze. */
const DRIFT_TURNS = 2;

export interface PersonaSnapshot {
  primary: string;
  secondary: string | null;
  confidence: number;
  since: number;
  domain: Topic;
  recentIntents: Intent[];
}

const RESTING = new Set(["mewmuze", "night_owl", "morning_companion", "company_mode"]);

/**
 * Keeps the persona steady across a conversation. A new topic first joins as
 * the secondary; only if the next message stays on it (or it is urgent) does
 * it take the lead - so "I have an interview tomorrow too" in the middle of a
 * breakup adds Career Coach instead of dropping Breakup Buddy.
 */
export class PersonaState {
  private s: PersonaSnapshot = { primary: DEFAULT_PERSONA, secondary: null, confidence: 0, since: 0, domain: "chat", recentIntents: [] };
  private pending: { id: string; count: number } | null = null;
  private secondaryAge = 0;
  private lastAt: number | null = null;
  private drift = 0;

  snapshot(): PersonaSnapshot {
    return this.s;
  }

  reset(): void {
    this.s = { primary: DEFAULT_PERSONA, secondary: null, confidence: 0, since: 0, domain: "chat", recentIntents: [] };
    this.pending = null;
    this.secondaryAge = 0;
    this.drift = 0;
  }

  /** Fold one message's routing in and return who answers it. */
  update(r: Routing, now: number, bucket: StyleBucket | "auto" = "auto"): PersonaSnapshot {
    if (this.lastAt !== null && now - this.lastAt > IDLE_RESET_MS) this.reset();
    this.lastAt = now;
    const cur = this.s;
    const intents = [...cur.recentIntents, r.intent].slice(-5);
    let primary = cur.primary;
    let secondary = cur.secondary;
    let confidence = cur.confidence;
    let domain = cur.domain;
    let since = cur.since;

    const take = () => {
      if (primary !== r.primary) since = now;
      primary = r.primary;
      confidence = r.confidence;
      domain = r.domain;
      this.pending = null;
      // Keep the previous lead as the secondary when it still fits (a breakup
      // that turned into a job question still has feelings in it).
      const prev = cur.primary;
      secondary = r.secondary ?? (!RESTING.has(prev) && allowsSecondary(primary, prev) ? prev : null);
      this.secondaryAge = 0;
    };

    if (r.source === "default" || r.source === "continuity") {
      // Nothing new was said about the topic: stay. From rest, the time of
      // day may still pick Night Owl / Morning Companion.
      if (RESTING.has(primary)) primary = r.primary;
    } else if (r.primary === primary) {
      confidence = Math.max(confidence * 0.9, r.confidence);
      this.pending = null;
      if (r.secondary && allowsSecondary(primary, r.secondary)) {
        secondary = r.secondary;
        this.secondaryAge = 0;
      }
    } else if (r.risk === "high" || RESTING.has(primary) || (persona(r.primary).safety && r.confidence >= CONFIDENT)) {
      take();
    } else if (r.confidence >= SWITCH) {
      const again = this.pending?.id === r.primary;
      const blends = allowsSecondary(primary, r.primary);
      // Switch now when the new topic cannot sit alongside the current one and
      // the signal is unmistakable ("tell me a joke" after a health question):
      // that is the user changing the subject. Crisis support is never left
      // on one message.
      const clearChange = !blends && r.confidence >= 0.8 && primary !== "grounding_listener";
      if (clearChange || (again && this.pending!.count >= 1)) {
        take(); // the conversation has moved on
      } else {
        this.pending = { id: r.primary, count: again ? this.pending!.count + 1 : 1 };
        if (blends) {
          secondary = r.primary;
          this.secondaryAge = 0;
        }
      }
    } else if (r.confidence >= CONFIDENT && allowsSecondary(primary, r.primary)) {
      secondary = r.primary;
      this.secondaryAge = 0;
    }

    // A specialist whose topic has gone quiet (Career Coach answering "ordering
    // pizza", Fitness Coach answering "can't sleep") hands the chat to whoever
    // the latest message is about after a couple of messages; a listener stays
    // with the feelings however the topic wanders.
    this.drift = r.primary === cur.primary || primary !== cur.primary ? 0 : this.drift + 1;
    if (this.drift >= DRIFT_TURNS && !RESTING.has(primary) && !persona(primary).emotional) {
      take();
      secondary = r.secondary;
      this.drift = 0;
    }

    if (secondary && secondary === cur.secondary && secondary !== r.primary && secondary !== r.secondary) {
      if (++this.secondaryAge >= SECONDARY_TURNS) secondary = null;
    }
    if (secondary === primary) secondary = null;

    ({ primary, secondary } = applyStyle(bucket, primary, secondary, r));
    this.s = { primary, secondary, confidence, since, domain, recentIntents: intents };
    return this.s;
  }
}

/** Each manual style's stand-in when the routed persona is outside it. */
const STYLE_DEFAULT: Record<StyleBucket, (r: Routing) => string> = {
  mewmuze: () => "mewmuze",
  listener: (r) => (r.mood === "sad" ? "comfort_companion" : r.mood === "stressed" ? "calm_companion" : "rant_buddy"),
  coach: () => "decision_coach",
  playful: (r) => (r.intent === "vent" ? "savage_bestie" : "chaos_cat"),
  direct: () => "critic",
};

/**
 * A manual Conversation style keeps MewMuze inside that family - except the
 * safety personas (crisis, health, medication), whose rules always apply.
 */
export function applyStyle(bucket: StyleBucket | "auto", primary: string, secondary: string | null, r: Routing): { primary: string; secondary: string | null } {
  if (bucket === "auto") return { primary, secondary };
  const ok = (id: string) => persona(id).bucket === bucket || !!persona(id).safety;
  const p = ok(primary) ? primary : STYLE_DEFAULT[bucket](r);
  const s = secondary && ok(secondary) && allowsSecondary(p, secondary) ? secondary : null;
  return { primary: p, secondary: s };
}

/** The persona's language for the router's own language field. */
export function routeLanguage(text: string, fallback: Lang): Lang {
  return detectLanguage(text) ?? fallback;
}
