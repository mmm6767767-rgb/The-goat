// index.js — Discord multi-account self-bot (Node 22+, Railway)
//
// ENV VARS (ONLY these — use exactly these names):
//   DISCORD_TOKEN        = first account token
//   DISCORD_TOKEN_1      = first account token (alternative)
//   DISCORD_TOKEN_2      = second account token
//   ... DISCORD_TOKEN_N  = more accounts
//   WEBHOOK_URL          = optional webhook — ONLY Nitro alerts go here
//
//   Nitro found  → webhook:  🎁 Nitro trial in `DISCORD_TOKEN_123`
//   Quests      → logs only (pretty progress bars, no webhook)
//
// Behavior per account:
//   [1] random bio from list (once per online session)
//   [2] Hypesquad → Bravery
//   [3] auto-complete ONE quest (video fast, play/stream via heartbeat) — LOGS ONLY
//   [4] presence: gateway FULLY CLOSED except ONE random 1h window per week —
//       random day (never Friday), random start 08:00–22:00, VISIBLE status
//   [+] Nitro trial/subscription monitor → webhook embed message

const API = "https://discord.com/api/v9";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9187 Chrome/124.0 Safari/537.36";
const SUPER = Buffer.from(JSON.stringify({ os: "Windows", browser: "Discord Client", device: "", system_locale: "en-US", browser_user_agent: UA, browser_version: "124.0.0.0", os_version: "10", client_build_number: 334402, release_channel: "stable", client_event_source: null })).toString("base64");

const HDRS = {
  "content-type": "application/json",
  "accept-language": "en-US",
  "x-debug-options": "bugReporterEnabled",
  "x-discord-locale": "en-US",
  "x-discord-timezone": "Asia/Saigon",
  "x-super-properties": SUPER,
  origin: "https://discord.com",
  referer: "https://discord.com/channels/@me",
  "user-agent": UA,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));

// ---------------- config (only envs: DISCORD_TOKEN*, WEBHOOK_URL) ----------------
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const TOKENS = Object.keys(process.env)
  .filter((k) => /^DISCORD_TOKEN(?:_\d+)?$/.test(k))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .map((k) => ({ key: k, value: process.env[k] }));
if (!TOKENS.length) { console.error("Set DISCORD_TOKEN or DISCORD_TOKEN_1..N"); process.exit(1); }

// ---------------- online schedule: ONE random 1h window per week ----------------
const ONLINE_MINUTES = 60;          // stay online exactly 1 hour
const EXCLUDED_DAYS = new Set([5]); // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat  → never online Friday
const WINDOW_START_MIN_H = 8;       // window starts randomly between 08:00 and 22:00
const WINDOW_START_MAX_H = 22;      // start max 22:00 so the 1h window ends before midnight
const PRESENCE_MIN = 8;             // presence rotation inside the window
const NITRO_CHECK_MIN = 30;         // nitro check inside the window

// ---------------- aesthetic logger ----------------
const NO_COLOR = !!process.env.NO_COLOR || !process.stdout.isTTY;
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const paint = (code, s) => (NO_COLOR ? s : code + s + C.reset);
const now = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
const TAG_COLORS = [C.cyan, C.green, C.yellow, C.magenta, C.blue, C.red];
const print = (icon, color, tag, msg) =>
  console.log(`${paint(C.gray, now())} ${tag} ${paint(color, icon)} ${msg}`);

// fancy box
const BOX_W = 60;
function boxLine(content = "", align = "left") {
  const visible = String(content).replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, BOX_W - 2 - visible.length);
  const left = align === "center" ? Math.floor(pad / 2) : 0;
  const right = pad - left;
  return paint(C.cyan, "║") + " " + " ".repeat(left) + content + " ".repeat(right) + " " + paint(C.cyan, "║");
}
function printBox(title, rows, titleColor = C.cyan) {
  console.log(paint(C.cyan, "╔" + "═".repeat(BOX_W - 2) + "╗"));
  console.log(boxLine(paint(C.bold + titleColor, title), "center"));
  console.log(boxLine("", "center"));
  for (const r of rows) console.log(boxLine(r));
  console.log(paint(C.cyan, "╚" + "═".repeat(BOX_W - 2) + "╝"));
}
// thin divider
const rule = (tag) => console.log(`${paint(C.gray, now())} ${tag} ${paint(C.gray, "─".repeat(38))}`);
// progress bar  ▓▓▓░░░ 62%
function bar(pct, width = 14) {
  pct = Math.max(0, Math.min(1, pct));
  const filled = Math.round(pct * width);
  const f = paint(C.green, "▓".repeat(filled));
  const e = paint(C.gray, "░".repeat(width - filled));
  return f + e + paint(C.dim, ` ${Math.round(pct * 100)}%`);
}
// big countdown → "3d 04h 12m"
const fmtDur = (ms) => {
  if (ms < 0) ms = 0;
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (d) return `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
};
const fmtDT = (d) => d.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

// ---------------- constants ----------------
const PREM_NAMES = { 1: "Nitro Classic", 2: "Nitro", 3: "Nitro Basic" };
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MS_HOUR = 3600000;

let WS = globalThis.WebSocket;
if (!WS) { try { WS = require("ws"); } catch { console.error("Node 22+ required, or run: npm i ws"); process.exit(1); } }

// pick the next allowed day (within 1..7 days) and a random start hour — never Friday
function computeNextWindow(from = new Date()) {
  const candidates = [];
  for (let off = 1; off <= 7; off++) {
    const day = (from.getDay() + off) % 7;
    if (!EXCLUDED_DAYS.has(day)) candidates.push(off);
  }
  const off = candidates[randInt(0, candidates.length - 1)];
  const start = new Date(from.getTime());
  start.setDate(start.getDate() + off);
  start.setHours(randInt(WINDOW_START_MIN_H, WINDOW_START_MAX_H), randInt(0, 59), randInt(0, 59), 0);
  return { start, end: new Date(start.getTime() + ONLINE_MINUTES * 60000) };
}

function questProgress(us, event) {
  const p = (us && us.progress) || {};
  const hit = p[event];
  if (typeof hit === "number") return hit;
  if (hit && typeof hit.value === "number") return hit.value;
  for (const v of Object.values(p)) {
    if (v && typeof v === "object" && typeof v.value === "number") return v.value;
  }
  return 0;
}

// ---------------- BIOS ----------------
const BIOS = [
  "late nights and loud music", "somewhere between awake and asleep", "living in my own world", "music is my escape",
  "just another midnight soul", "quiet mind loud thoughts", "lost in my playlist", "probably overthinking",
  "awake at the wrong hours", "somewhere far away", "midnight feels like home", "just passing through",
  "lost in my thoughts", "headphones on world off", "made for late nights", "permanently daydreaming",
  "silence feels different at night", "currently somewhere else", "no thoughts just music", "night owl",
  "living between playlists", "just enjoying the silence", "calm outside chaos inside", "probably listening to music",
  "another night another playlist", "sleep can wait", "somewhere in my head", "nothing but vibes",
  "quietly existing", "always up late", "lost but vibing", "music before conversations",
  "late night thinker", "too many thoughts", "somewhere between dreams and reality", "just doing my thing",
  "not always online", "mentally somewhere else", "private little world", "still figuring things out",
  "just here for the vibes", "no explanation needed", "living in lowercase", "quiet by nature",
  "simple life complicated mind", "less talking more listening", "probably asleep", "probably not",
  "one more song", "midnight thoughts", "rainy days and music", "coffee and late nights",
  "chasing peaceful moments", "collecting memories", "taking life slowly", "somewhere under the same sky",
  "just another daydreamer", "always thinking", "lost in the moment", "enjoying the little things",
  "my playlist knows everything", "headphones are enough", "night time personality", "awake for no reason",
  "sleeping is tomorrow's problem", "just another person online", "here but somewhere else", "currently unavailable",
  "no context", "dont ask", "keeping things simple", "nothing serious",
  "just existing", "doing side quests", "life without instructions", "figuring it out as I go",
  "taking the long way", "somewhere worth finding", "chasing sunsets", "looking at the stars",
  "wandering without a plan", "always somewhere else", "born to wander", "lost in beautiful thoughts",
  "dreaming while awake", "thoughts never sleep", "my mind never shuts up", "quiet person loud playlist",
  "music makes everything better", "songs say what I cant", "one song on repeat", "playlist over conversation",
  "living through melodies", "music and midnight", "late night music hits different", "soundtracking my life",
  "another song another memory", "forever listening", "somewhere between songs", "music keeps me company",
  "night skies and headphones", "silence with a soundtrack", "just let the music play", "probably making another playlist",
  "emotionally attached to music", "my headphones know too much", "lost between songs", "music is my comfort",
  "always looking for new songs", "playlist on repeat", "music before sleep", "late night listener",
  "headphones all day", "music makes life cinematic", "just one more song", "thinking about nothing",
  "thinking about everything", "overthinking again", "my brain has too many tabs", "thoughts everywhere",
  "mentally somewhere else", "lost inside my head", "too many thoughts not enough words", "always thinking",
  "thinking in circles", "my mind is elsewhere", "probably overthinking this bio", "brain on airplane mode",
  "mentally offline", "currently buffering", "still loading", "personality under construction",
  "no idea what im doing", "just winging it", "somehow functioning", "running on vibes",
  "barely awake", "low battery human", "motivation not found", "brain.exe stopped working",
  "reality feels optional", "life needs a restart", "still figuring it out", "no updates available",
  "system still loading", "mentally on another planet", "imagination never sleeps", "dreaming with my eyes open",
  "somewhere in a dream", "living in a daydream", "dreams feel better", "always daydreaming",
  "reality can wait", "lost in another world", "somewhere beyond reality", "my imagination is loud",
  "dreaming of somewhere else", "just a little distracted", "head in the clouds", "floating through life",
  "lost in the clouds", "always chasing a feeling", "looking for something unknown", "somewhere beyond the horizon",
  "just following the moment", "taking everything slowly", "peaceful over perfect", "choosing quiet",
  "silence over small talk", "keeping my peace", "protecting my energy", "enjoying my own company",
  "comfortable in silence", "quiet but present", "not much to say", "words arent always necessary",
  "some things stay unsaid", "silence says enough", "private by nature", "keeping things private",
  "you dont know the whole story", "not everything needs explaining", "just observing", "watching from the background",
  "somewhere in the background", "background character energy", "quietly watching everything", "more observer than participant",
  "keeping my distance", "hard to read", "probably misunderstood", "not everyone gets me",
  "no need to understand", "simple but complicated", "more than meets the eye", "nothing is ever that simple",
  "somewhere between everything", "just another chapter", "still writing my story", "unfinished thoughts",
  "unfinished story", "figuring out the plot", "life is still loading", "chapter unknown",
  "no spoilers", "more to come", "still becoming", "growing quietly",
  "learning as I go", "taking my time", "not rushing anything", "one day at a time",
  "slowly getting there", "somewhere along the way", "enjoying the journey", "life goes on",
  "keep moving forward", "better days ahead", "making memories", "collecting moments",
  "living in the moment", "today is enough", "tomorrow can wait", "letting life happen",
  "going with the flow", "seeing where life goes", "no fixed destination", "taking the scenic route",
  "wherever life takes me", "just keep going", "making it work", "doing my best",
  "trying my best", "learning to breathe", "taking things slowly", "finding my way",
  "still finding myself", "becoming someone new", "changing quietly", "growing through everything",
  "making peace with things", "choosing happiness", "finding little joys", "appreciating small moments",
  "enjoying simple things", "peace is the goal", "quiet days are good days", "slow mornings late nights",
  "rainy days feel different", "cloudy weather enthusiast", "sunset person", "night person",
  "morning person sometimes", "coffee and quiet", "tea and thoughts", "rain and music",
  "clouds and daydreams", "sunsets and silence", "stars and late nights", "moonlight and music",
  "cold nights warm lights", "windows and rainy days", "cozy nights", "peaceful evenings",
  "quiet mornings", "late night conversations", "long walks and music", "empty roads and headphones",
  "city lights at night", "watching the world go by", "staying up for the view", "night drives in my thoughts",
  "somewhere under city lights", "watching the sunset alone", "looking at the moon again", "the night feels peaceful",
  "nighttime is different", "darkness feels calm", "the world is quieter at night", "midnight is my favorite hour",
  "late nights feel like freedom", "night is where I think", "after midnight everything changes", "awake when the world sleeps",
  "sleeping through the day", "living after midnight", "midnight thoughts are different", "another sleepless night",
  "probably awake at 3am", "sleep schedule is nonexistent", "my timezone is midnight", "permanently on night mode",
  "daylight feels overrated", "night owl forever", "active after midnight", "awake for no reason",
  "sleep later think now", "another late night", "see you after midnight", "until the next sunrise",
  "waiting for the morning", "watching the stars instead of sleeping", "tired but still awake", "sleepy but not sleeping",
  "too awake to sleep", "one more hour", "one more episode", "one more song",
  "one more game", "just five more minutes", "procrastinating again", "doing everything except sleeping",
  "avoiding responsibilities", "professionally lazy", "currently doing nothing", "busy doing nothing",
  "probably procrastinating", "someday ill be productive", "motivation is temporary", "productivity loading",
  "working on it", "maybe tomorrow", "ill do it later", "later sounds better",
  "currently unavailable for responsibilities", "doing side quests instead", "main quest postponed", "life is a side quest",
  "no plans just vibes", "making it up as I go", "chaos but quietly", "peaceful chaos",
  "controlled chaos", "organized enough", "barely organized", "random by nature",
  "no particular reason", "just because", "why not", "dont know either",
  "ask someone else", "no comment", "moving on", "next question",
  "nothing to report", "everything is fine probably", "probably fine", "somehow okay",
  "doing alright", "still alive and vibing", "just chilling", "keeping it chill",
  "lowkey chilling", "taking it easy", "nothing complicated", "keeping things simple",
  "simple things are enough", "no drama please", "peace over drama", "staying out of trouble",
  "minding my own business", "doing my own thing", "living quietly", "staying in my lane",
  "not here for drama", "good vibes only", "keeping the peace", "protecting my peace",
  "choosing peace", "quiet life", "simple life", "slow life",
  "private life", "peaceful mind", "quiet soul", "curious mind",
  "wandering mind", "restless mind", "creative mind", "midnight mind",
  "dreamy mind", "complicated mind", "simple heart", "quiet heart",
  "soft heart", "tired soul", "wandering soul", "midnight soul",
  "restless soul", "old soul", "curious soul", "just a human",
  "another human online", "person behind the screen", "somewhere behind the screen", "just another username",
  "another account on the internet", "internet resident", "online sometimes", "rarely online",
  "always online somehow", "online but not available", "active but absent", "seen but silent",
  "read but thinking", "typing then deleting", "message later", "notifications ignored",
  "phone on silent", "do not disturb", "probably missed your message", "social battery low",
  "social battery loading", "introvert mode", "quiet mode", "offline mentally",
  "physically online mentally elsewhere", "here but not here", "present but distracted", "somewhere else mentally",
  "currently disconnected", "signal lost", "connection unstable", "loading...",
  "still loading", "status unknown", "currently unknown", "no status available",
  "unavailable", "maybe later", "not right now", "check back later",
  "come back tomorrow", "probably sleeping", "probably listening to music", "probably outside",
  "probably thinking", "probably doing nothing", "probably somewhere else", "probably not reading this",
  "if youre reading this hi", "thanks for stopping by", "welcome to my little corner", "this is my corner of the internet",
  "nothing interesting here", "you found me"
];

const ACTS = ["late nights and loud music", "midnight feels like home", "one more song",
  "rainy days and music", "night skies and headphones", "lost between songs", "permanently daydreaming",
  "somewhere under the same sky", "probably overthinking", "headphones on world off"];

// ---------------- one Account = one token, own gateway session ----------------
class Account {
  constructor(token, envKey, idx) {
    this.token = token;
    this.envKey = envKey;               // e.g. "DISCORD_TOKEN_123"
    this.idx = idx;
    this.plainTag = `A${String(idx).padStart(3, "0")}`;
    this.tag = paint(TAG_COLORS[idx % TAG_COLORS.length], `[${this.plainTag}]`);
    this.ws = null;
    this.seq = null;
    this.hbTimer = null;
    this.alive = true;
    this.closing = false;
    this.username = null;
    this.notified = new Set();
    this.bioCooldownUntil = 0;
    this.reconnectDelay = 5000;
    this._sessionEnd = null;
    this.hypesquadDone = false;
    this.questDone = false;
    this.win = null;
  }

  info(m)  { print("ℹ️ ", C.cyan,    this.tag, m); }
  ok(m)    { print("✅ ", C.green,   this.tag, m); }
  warn(m)  { print("⚠️ ", C.yellow,  this.tag, m); }
  err(m)   { print("❌ ", C.red,     this.tag, m); }
  net(m)   { print("⚡ ", C.magenta, this.tag, m); }
  gift(m)  { print("🎁 ", C.magenta, this.tag, m); }
  rule()   { rule(this.tag); }

  // ----- REST with 429 auto-retry -----
  async api(method, path, body, retries = 1) {
    const res = await fetch(API + path, {
      method,
      headers: { ...HDRS, authorization: this.token },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && retries > 0) {
      const ra = await res.json().catch(() => ({}));
      const wait = (ra.retry_after || 5) * 1000;
      this.warn(`rate limited — waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait + 500);
      return this.api(method, path, body, retries - 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  async webhook(content) {
    if (!WEBHOOK_URL) return;
    try {
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: String(content).slice(0, 1900) }),
      });
    } catch {}
  }

  // ----- gateway -----
  send(op, d) {
    if (this.ws && this.ws.readyState === WS.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }
  setHeartbeat(ms) { clearInterval(this.hbTimer); this.hbTimer = setInterval(() => this.send(1, this.seq), ms); }
  clearHeartbeat() { clearInterval(this.hbTimer); this.hbTimer = null; }
  setStatus(status) {
    this.send(3, { since: status === "idle" ? Date.now() : null, afk: status === "idle", status, activities: [] });
  }
  rotatePresence() {
    const r = Math.random();
    const status = r < 0.6 ? "online" : r < 0.85 ? "dnd" : "idle"; // visible only — never invisible/offline
    const d = { since: status === "idle" ? Date.now() : null, afk: status === "idle", status, activities: [] };
    if (Math.random() < 0.6) d.activities = [{ name: ACTS[Math.floor(Math.random() * ACTS.length)], type: 2 }];
    this.send(3, d);
  }

  connectOnce(gwUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WS(gwUrl + "?v=10&encoding=json");
      this.ws = ws;
      let opened = false;
      ws.onopen = () => this.send(2, {
        token: this.token,
        intents: 0,
        properties: { os: "Windows", browser: "Discord Client", device: "" },
        presence: { status: "online", since: null, activities: [], afk: false },
      });
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.s) this.seq = m.s;
        if (m.op === 10) {
          this.setHeartbeat(m.d.heartbeat_interval);
          if (!opened) { opened = true; resolve(); }
        } else if (m.op === 0 && m.t === "READY") {
          this.username = m.d.user.username;
          this.ok(`logged in as @${this.username}`);
        } else if (m.op === 9) {
          this.warn("session invalidated — reconnecting");
          ws.close();
        }
      };
      ws.onerror = () => { if (!opened) reject(new Error("ws error")); };
      ws.onclose = (ev) => {
        this.clearHeartbeat();
        this.ws = null;
        if (this.closing) return;
        if (opened) {
          this.net(`gateway closed (${ev.code}) — reconnecting...`);
          if (this._sessionEnd) { const r = this._sessionEnd; this._sessionEnd = null; r(); }
        } else {
          reject(new Error("ws closed (" + ev.code + ")"));
        }
      };
    });
  }

  // intentionally close the Discord connection ("close Discord")
  disconnect() {
    this.closing = true;
    this.clearHeartbeat();
    if (this.ws) { try { this.ws.close(1000, "done"); } catch {} this.ws = null; }
    if (this._sessionEnd) { const r = this._sessionEnd; this._sessionEnd = null; r(); }
  }

  async sleepUntil(ts) {
    while (this.alive) {
      const wait = ts - Date.now();
      if (wait <= 0) return;
      await sleep(Math.min(60000, wait));
    }
  }

  // ----- main loop: sleep → 1h online window → close gateway → repeat -----
  async run() {
    while (this.alive) {
      if (!this.win || this.win.end <= Date.now()) this.win = computeNextWindow();
      if (Date.now() < this.win.start) {
        const wait = this.win.start - Date.now();
        printBox("📅 NEXT ONLINE WINDOW", [
          `account .......... ${this.envKey}`,
          `day .............. ${paint(C.bold, DAY_NAMES[this.win.start.getDay()])}`,
          `starts ........... ${fmtDT(this.win.start)}`,
          `ends ............. ${fmtDT(this.win.end)}  ${paint(C.dim, `(${ONLINE_MINUTES} min)`)}`,
          `in ................ ${paint(C.yellow, fmtDur(wait))}`,
        ], C.blue);
        await this.sleepUntil(this.win.start);
        if (!this.alive) return;
      }
      await this.onlineSession(this.win);
      if (!this.alive) return;
      this.ok("window over — closing Discord connection");
      this.disconnect();
      this.win = null;
    }
  }

  async onlineSession(win) {
    this.closing = false;
    const gw = (await this.api("GET", "/gateway").catch(() => null))?.url || "wss://gateway.discord.gg";

    // connect (retry until window ends)
    while (this.alive && Date.now() < win.end) {
      try {
        await this.connectOnce(gw);
        break;
      } catch (e) {
        if (!this.alive || Date.now() >= win.end) return;
        if (/4004|token/i.test(e.message)) { this.err("token rejected — account disabled"); this.alive = false; return; }
        this.net(`connect failed — retry in ${this.reconnectDelay / 1000}s`);
        await sleep(this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
      }
    }
    if (!this.alive || Date.now() >= win.end || !this.ws) return;
    this.reconnectDelay = 5000;
    this.net("gateway session up — visible online");
    this.setStatus("online");
    this.rule();
    printBox("🟢 ONLINE — SESSION ACTIVE", [
      `env ............... ${this.envKey}`,
      `online until ...... ${fmtDT(win.end)}`,
      `time left ......... ${paint(C.green, fmtDur(win.end - Date.now()))}`,
    ], C.green);

    // background auto-reconnect until window end
    const guard = (async () => {
      while (this.alive && Date.now() < win.end) {
        await new Promise((r) => { this._sessionEnd = r; });
        if (!this.alive || Date.now() >= win.end) break;
        this.net("gateway dropped — reconnecting");
        while (this.alive && Date.now() < win.end) {
          try {
            await this.connectOnce(gw);
            this.reconnectDelay = 5000;
            this.setStatus("online");
            this.net("reconnected");
            break;
          } catch (e2) {
            if (!this.alive || Date.now() >= win.end) return;
            if (/4004|token/i.test(e2.message)) { this.err("token rejected — account disabled"); this.alive = false; return; }
            await sleep(this.reconnectDelay);
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
          }
        }
      }
    })();

    // one-shot session tasks: bio → hypesquad → quest → nitro
    await Promise.allSettled([this.applyBio(), this.hypesquad(), this.completeQuest(), this.checkNitro()]);
    try { this.rotatePresence(); } catch {}

    const presenceTimer = setInterval(() => { try { this.rotatePresence(); } catch {} }, PRESENCE_MIN * 60000);
    const nitroTimer = setInterval(() => this.checkNitro().catch(() => {}), NITRO_CHECK_MIN * 60000);

    // stay online exactly 1h
    while (this.alive && Date.now() < win.end) await sleep(Math.min(30000, win.end - Date.now()));

    clearInterval(presenceTimer);
    clearInterval(nitroTimer);
  }

  // ----- [1] random bio -----
  async applyBio() {
    if (this.bioCooldownUntil > Date.now()) return;
    const bio = BIOS[randInt(0, BIOS.length - 1)];
    try {
      await this.api("PATCH", "/users/@me/settings", { bio });
      this.bioCooldownUntil = Date.now() + 6 * MS_HOUR;
      this.ok(`bio → "${bio}"`);
    } catch (e) { this.warn(`bio update failed: ${e.message.slice(0, 80)}`); }
  }

  // ----- [2] Hypesquad → Bravery -----
  async hypesquad() {
    if (this.hypesquadDone) return;
    this.hypesquadDone = true;
    try {
      await this.api("POST", "/hypesquad/online", { house_id: 1 }); // 1 = Bravery
      this.ok("Hypesquad → Bravery");
    } catch (e) { this.warn(`hypesquad: ${e.message.slice(0, 80)}`); }
  }

  // ----- [3] auto-complete ONE quest — LOGS ONLY (no webhook) -----
  async completeQuest() {
    if (this.questDone) return;
    this.questDone = true; // only ONE quest attempt per process
    this.rule();
    printBox("🎮 QUEST", [
      `account .......... ${this.envKey}`,
      `status ........... ${paint(C.yellow, "looking for active quest…")}`,
    ], C.magenta);
    let list;
    try { list = await this.api("GET", "/quests"); } catch (e) { this.warn(`quests fetch failed: ${e.message.slice(0, 80)}`); return; }
    const quests = (list?.quests || []).filter((q) => {
      const cfg = q.config || {};
      const tasks = Object.values(cfg.tasks || {});
      const us = q.userStatus || {};
      return tasks.length && us.status !== "COMPLETED" && !us.claimed;
    });
    if (!quests.length) { this.warn("no active quests — skipping"); return; }
    const q = quests[0];
    const cfg = q.config || {};
    const name = cfg.messages?.[0]?.name || cfg.messages?.[0]?.header || q.id;
    this.ok(`quest found: ${name}`);
    const tasks = Object.values(cfg.tasks || {});
    const task = tasks[0];
    const event = task?.event_name || "";
    const need = task?.task_progress?.target_value || 900;

    // make sure the quest is accepted
    await this.api("POST", `/quests/${q.id}/accept`, {}).catch(() => {});
    await this.api("POST", `/quests/${q.id}/enroll`, {}).catch(() => {});

    try {
      if (event === "WATCH_VIDEO") {
        await this.videoQuest(q.id, need);
      } else {
        await this.heartbeatQuest(q.id, need, event);
      }
      await this.api("POST", `/quests/${q.id}/claim`, {});
      this.gift(`quest reward claimed: ${name}`);
    } catch (e) {
      this.warn(`quest failed: ${e.message.slice(0, 120)}`);
    }
  }

  async videoQuest(id, need) {
    let t = 0;
    while (t < need) {
      t = Math.min(need, t + randInt(60, 180));
      await this.api("POST", `/quests/${id}/video-progress`, { timestamp: Math.floor(t) });
      this.ok(`video quest  ${bar(t / need)}  ${Math.floor(t)}/${need}s`);
      if (t < need) await sleep(8000);
    }
  }

  async heartbeatQuest(id, need, event) {
    const key = `call:${id}:1`; // stream key for heartbeats without an associated stream
    for (;;) {
      let res;
      try {
        res = await this.api("POST", `/quests/${id}/heartbeat`, { stream_key: key, terminal: false });
      } catch (e) {
        this.warn(`heartbeat error: ${e.message.slice(0, 80)} — retrying`);
        await sleep(30000);
        continue;
      }
      const prog = questProgress(res?.userStatus, event);
      this.ok(`quest  ${bar(prog / need)}  ${prog}/${need}s`);
      if (prog >= need) {
        await this.api("POST", `/quests/${id}/heartbeat`, { stream_key: key, terminal: true }).catch(() => {});
        return;
      }
      await sleep(60000);
    }
  }

  // ----- [+] Nitro trial/subscription monitor → WEBHOOK ONLY -----
  async checkNitro() {
    let subs;
    try { subs = (await this.api("GET", "/users/@me/billing/subscriptions")) || []; } catch { return; }
    for (const s of subs) {
      if (s.status !== "active" || this.notified.has(s.id)) continue;
      this.notified.add(s.id);
      const name = PREM_NAMES[s.premium_type] || "Nitro";
      const until = s.current_period_end ? new Date(s.current_period_end).toLocaleString("en-GB") : "?";
      this.gift(`${name} active on ${this.envKey} — renews ${until}`);
      await this.webhook(`🎁 **Nitro trial in \`${this.envKey}\`**\n${name} — renews ${until}`);
    }
  }
}

// ---------------- main ----------------
const accounts = TOKENS.map(({ value, key }, i) => new Account(value, key, i));
printBox("DISCORD MULTI-ACCOUNT SELF-BOT", [
  `accounts ............ ${TOKENS.length}`,
  `online window ....... ${ONLINE_MINUTES} min — ONE random day/hour per week`,
  `never online ........ Friday`,
  `presence ............ visible (online/dnd/idle), never invisible`,
  `outside window ...... gateway fully closed`,
  `quest progress ...... logs only`,
  `nitro alerts ........ webhook ${WEBHOOK_URL ? "enabled" : "disabled"}`,
], C.cyan);
for (const a of accounts) a.run().catch((e) => a.err("fatal: " + e.message));

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(paint(C.yellow, "\n⏹ shutting down — closing all Discord connections"));
  for (const a of accounts) { a.alive = false; a.disconnect(); }
  setTimeout(() => process.exit(0), 1200);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
