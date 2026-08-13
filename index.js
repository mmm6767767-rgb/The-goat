// index.js — Discord multi-account self-bot (Node 22+, Railway)
//
// ENV VARS (ONLY these — use exactly these names):
//   DISCORD_TOKEN        = first account token
//   DISCORD_TOKEN_1      = first account token (alternative)
//   DISCORD_TOKEN_2      = second account token
//   ... DISCORD_TOKEN_N  = more accounts
//   WEBHOOK_URL          = optional webhook — ONLY Nitro alerts go here
//   ONLINE_MINUTES       = minutes per online session (default 60, clamp 15–720)
//   ONLINE_HOUR          = hour of the daily window, 0–23 (default 12 = 12:00 server time)
//   NITRO_CHECK_MIN      = nitro poll interval in minutes (default 30, min 5)
//   FIRST_RUN_NOW        = "1" (default) → first session starts immediately at boot,
//                          "0" → wait for the daily window only
//
//   Nitro found  → webhook:  🎁 Nitro trial in `DISCORD_TOKEN_123`
//   Quests      → logs only (pretty progress bars, no webhook)
//
// Behavior per account (EVERY DAY at the same hour):
//   [1] random bio from list (once per online session, 6h cooldown)
//   [2] Hypesquad → Bravery
//   [3] auto-complete ONE quest (video fast, play/stream via heartbeat) — LOGS ONLY
//   [4] presence: gateway CLOSED except the daily 1h window —
//       fixed hour (ONLINE_HOUR), VISIBLE status, stays online the full hour
//   [+] Nitro trial/subscription monitor → webhook embed message

const WS = require("ws");

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

// ---------------- settings ----------------
const MS_MIN = 60000;
const MS_HOUR = 3600000;
const ONLINE_MINUTES = Math.min(720, Math.max(15, Number(process.env.ONLINE_MINUTES) || 60));
const ONLINE_HOUR = Math.min(23, Math.max(0, Number(process.env.ONLINE_HOUR) || 12)); // same hour EVERY day
const NITRO_CHECK_MIN = Math.max(5, Number(process.env.NITRO_CHECK_MIN) || 30);
const FIRST_RUN_NOW = String(process.env.FIRST_RUN_NOW ?? "1") !== "0";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

// ---------------- token discovery: DISCORD_TOKEN, DISCORD_TOKEN_1 .. N ----------------
const TOKENS = Object.keys(process.env)
  .filter((k) => /^DISCORD_TOKEN(?:_\d+)?$/.test(k))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .map((k) => ({ value: process.env[k], key: k }));

if (!TOKENS.length) {
  console.error("Set DISCORD_TOKEN or DISCORD_TOKEN_1..N env vars");
  process.exit(1);
}

// ---------------- helpers ----------------
const BIOS = [
  "i like trains 🚂",
  "just vibing",
  "certified goat 🐐",
  "no bio needed",
  "hello world",
  "powered by The-goat",
];

const PREM_NAMES = { 0: "None", 1: "Nitro Classic", 2: "Nitro", 3: "Server Boost", 4: "Nitro Basic" };
const ACTS = ["The Goat", "goat sounds", "your favorite songs", "the daily window", "quests"];

const C = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const paint = (c, s) => (process.stdout.isTTY ? c + s + C.reset : s);
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bar(frac) {
  const n = Math.max(0, Math.min(1, frac));
  const w = 16;
  const filled = Math.round(n * w);
  return "█".repeat(filled) + "░".repeat(w - filled) + ` ${Math.round(n * 100)}%`;
}

function printBox(title, lines, color = C.cyan) {
  const w = Math.max(title.length, ...lines.map((l) => l.length)) + 4;
  const line = "─".repeat(w);
  console.log(paint(color, `┌${line}┐`));
  console.log(paint(color, `│  ${title.padEnd(w - 2)}│`));
  console.log(paint(color, `├${line}┤`));
  for (const l of lines) console.log(paint(color, `│  ${l.padEnd(w - 2)}│`));
  console.log(paint(color, `└${line}┘`));
}

function fmtDur(ms) {
  const h = Math.floor(ms / MS_HOUR);
  const m = Math.round((ms % MS_HOUR) / MS_MIN);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

// progress from a quest heartbeat response (userStatus)
function questProgress(us = {}, event) {
  if (!us || typeof us !== "object") return 0;
  if (Array.isArray(us.streams) && us.streams.length) {
    let t = 0;
    for (const st of us.streams) t += Number(st?.seconds || st?.duration || 0);
    return t;
  }
  const v = us.progress ?? us.total_progress ?? us.progress_seconds ?? us.video_progress ?? 0;
  return Number(v) || 0;
}

// ---------------- account ----------------
class Account {
  constructor(token, envKey, idx) {
    this.token = token;
    this.envKey = envKey;
    this.idx = idx;
    this.label = envKey;
    this.alive = true;
    this.ws = null;
    this.hbTimer = null;
    this.seq = null;
    this.username = null;
    this.notified = new Set();       // nitro subscription ids already announced
    this.bioCooldownUntil = 0;
    this.questDone = false;          // only ONE quest attempt per process
    this.hypesquadDone = false;
    this.sessionUntil = 0;
  }

  ts() { return new Date().toLocaleTimeString("en-GB"); }
  ok(m) { console.log(paint(C.green, `[${this.ts()}] [${this.label}] ✔ ${m}`)); }
  info(m) { console.log(paint(C.cyan, `[${this.ts()}] [${this.label}] · ${m}`)); }
  warn(m) { console.log(paint(C.yellow, `[${this.ts()}] [${this.label}] ⚠ ${m}`)); }
  err(m) { console.log(paint(C.red, `[${this.ts()}] [${this.label}] ✖ ${m}`)); }
  gift(m) { console.log(paint(C.magenta, `[${this.ts()}] [${this.label}] 🎁 ${m}`)); }
  rule() { console.log(paint(C.gray, "─".repeat(60))); }

  async api(method, path, body) {
    let res;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(API + path, {
        method,
        headers: { ...HDRS, authorization: this.token },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status !== 429) break;
      let wait = 1000;
      try { const j = await res.json(); wait = (j.retry_after || 1) * 1000 + randInt(250, 750); } catch {}
      this.warn(`rate limited — retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
    if (res.status === 204) return null;
    try { return await res.json(); } catch { return null; }
  }

  async webhook(msg) {
    if (!WEBHOOK_URL) return;
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: msg }),
      });
      if (!res.ok) this.warn(`webhook HTTP ${res.status}`);
    } catch (e) { this.warn(`webhook failed: ${e.message.slice(0, 80)}`); }
  }

  // ----- gateway -----
  send(op, d) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op, d }));
  }

  connectGateway() {
    return new Promise((resolve, reject) => {
      const ws = new WS("wss://gateway.discord.gg/?v=10&encoding=json");
      this.ws = ws;
      ws.onopen = () => this.send(2, {
        token: this.token,
        intents: 0,
        properties: { os: "Windows", browser: "Discord Client", device: "" },
        presence: { status: "online", since: null, activities: [], afk: false },
      });
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.s) this.seq = m.s;
        if (m.op === 10) {
          clearInterval(this.hbTimer);
          this.hbTimer = setInterval(() => this.send(1, this.seq), m.d.heartbeat_interval);
          resolve();
        } else if (m.op === 0 && m.t === "READY") {
          this.username = m.d.user?.username || null;
          this.label = `${this.envKey} (@${this.username})`;
          this.ok(`logged in as @${this.username}`);
        }
      };
      ws.onerror = () => reject(new Error("gateway ws error"));
      ws.onclose = () => {
        clearInterval(this.hbTimer);
        this.hbTimer = null;
        this.ws = null;
        reject(new Error("gateway closed"));
      };
    });
  }

  setPresence(status) {
    const d = { since: status === "idle" ? Date.now() : null, afk: status === "idle", status, activities: [] };
    if (Math.random() < 0.6) d.activities = [{ name: ACTS[randInt(0, ACTS.length - 1)], type: randInt(1, 3) }];
    this.send(3, d);
  }

  disconnect() {
    try { clearInterval(this.hbTimer); if (this.ws) this.ws.close(); } catch {}
    this.ws = null;
    this.hbTimer = null;
  }

  // ----- [*] DAILY window: SAME hour every day, stays online ONLINE_MINUTES -----
  computeDailyWindow() {
    const start = new Date();
    start.setHours(ONLINE_HOUR, 0, 0, 0);          // fixed hour every day
    if (start.getTime() <= Date.now()) start.setDate(start.getDate() + 1); // already passed → tomorrow
    return { start: start.getTime(), end: start.getTime() + ONLINE_MINUTES * MS_MIN };
  }

  // ----- main loop: FIXED — never exits, fires EVERY day -----
  async run() {
    this.info(`armed — daily window at ${String(ONLINE_HOUR).padStart(2, "0")}:00 for ${ONLINE_MINUTES} min every day${FIRST_RUN_NOW ? " — first session starts NOW" : ""}`);
    let first = FIRST_RUN_NOW;
    while (this.alive) {
      const win = first
        ? { start: Date.now(), end: Date.now() + ONLINE_MINUTES * MS_MIN }
        : this.computeDailyWindow();
      first = false;

      const wait = win.start - Date.now();
      if (wait > 5000) {
        this.info(`next online window: ${new Date(win.start).toLocaleString("en-GB")} (in ${fmtDur(wait)}) — gateway closed, sleeping`);
        while (this.alive && Date.now() < win.start) await sleep(Math.min(5 * MS_MIN, win.start - Date.now()));
      }
      if (!this.alive) break;

      try {
        await this.onlineSession(win);
      } catch (e) {
        this.err(`session failed: ${e.message.slice(0, 100)}`);
        this.disconnect();
        await sleep(5 * MS_MIN);
      }
    }
  }

  async onlineSession(win) {
    const end = Math.min(win.end, Date.now() + ONLINE_MINUTES * MS_MIN);
    this.sessionUntil = end;
    this.info(`online window ${new Date(win.start).toLocaleString("en-GB")} → ${new Date(win.end).toLocaleTimeString("en-GB")}`);
    await this.connectGateway();
    this.setPresence("online");

    // [1] [2] [3] — fire and forget (each guards its own errors)
    this.applyBio().catch(() => {});
    this.hypesquad().catch(() => {});
    this.completeQuest().catch(() => {});

    const presenceTimer = setInterval(() => this.setPresence(["online", "dnd", "idle"][randInt(0, 2)]), 15 * MS_MIN);
    const nitroTimer = setInterval(() => this.checkNitro().catch(() => {}), NITRO_CHECK_MIN * MS_MIN);
    this.checkNitro().catch(() => {});

    // stay online until the window ends (1h by default)
    while (this.alive && Date.now() < end) await sleep(Math.min(30000, end - Date.now()));

    clearInterval(presenceTimer);
    clearInterval(nitroTimer);
    this.sessionUntil = 0;
    this.disconnect();
    this.info("window over — gateway closed, back tomorrow same time");
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
    while (t < need && Date.now() < (this.sessionUntil || Infinity)) {
      t = Math.min(need, t + randInt(60, 180));
      await this.api("POST", `/quests/${id}/video-progress`, { timestamp: Math.floor(t) });
      this.ok(`video quest  ${bar(t / need)}  ${Math.floor(t)}/${need}s`);
      if (t < need) await sleep(8000);
    }
  }

  async heartbeatQuest(id, need, event) {
    const key = `call:${id}:1`; // stream key for heartbeats without an associated stream
    for (;;) {
      if (Date.now() > (this.sessionUntil || Infinity)) {
        this.warn("window over — quest aborted");
        return;
      }
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
  `online window ....... ${ONLINE_MINUTES} min — EVERY DAY at ${String(ONLINE_HOUR).padStart(2, "0")}:00`,
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
