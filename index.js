// index.js — multi-account railway deploy (Node 22+)
const API = "https://discord.com/api/v9";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9187 Chrome/124.0 Safari/537.36";
const SUPER = Buffer.from(JSON.stringify({os:"Windows",browser:"Discord Client",device:"",system_locale:"en-US",browser_user_agent:UA,browser_version:"124.0.0.0",os_version:"10",client_build_number:334402,release_channel:"stable",client_event_source:null})).toString("base64");

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

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

// -------- webhook + nitro monitor settings --------
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";          // optional: if empty, no notifications
const NITRO_CHECK_MIN = Math.max(5, Number(process.env.NITRO_CHECK_MIN) || 30);

// -------- token discovery: DISCORD_TOKEN, DISCORD_TOKEN_1 .. DISCORD_TOKEN_N --------
const TOKENS = Object.keys(process.env)
  .filter(k => /^DISCORD_TOKEN(?:_\d+)?$/.test(k))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .map(k => process.env[k]);
if (!TOKENS.length) { console.error("Set DISCORD_TOKEN or DISCORD_TOKEN_1..N env vars"); process.exit(1); }
console.log(`[+] Loaded ${TOKENS.length} token(s)` + (WEBHOOK_URL ? ", webhook enabled" : ", NO WEBHOOK (set WEBHOOK_URL)"));

// ---------------- BIOS (your full list) ----------------
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

// ---------------- WebSocket ----------------
let WS = globalThis.WebSocket;
if (!WS) { try { WS = require("ws"); } catch { console.error("Node 22+ required, or run: npm i ws"); process.exit(1); } }

const PREM_NAMES = { 1: "Nitro Classic", 2: "Nitro", 3: "Nitro Basic" };
const INTERVALS = { 1: "day(s)", 2: "week(s)", 3: "month(s)", 4: "year(s)" };

// ---------------- one Account = one token, own gateway session ----------------
class Account {
  constructor(token, idx) {
    this.token = token;
    this.label = `[A${String(idx).padStart(3, "0")}]`;
    this.ws = null;
    this.seq = null;
    this.hbTimer = null;
    this.alive = true;
    this.username = null;
    this.notified = new Set();      // dedupe: one webhook per offer/subscription
  }
  log(msg) { console.log(`${new Date().toISOString()} ${this.label} ${msg}`); }

  async api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { ...HDRS, authorization: this.token },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  send(op, d) { if (this.ws && this.ws.readyState === WS.OPEN) this.ws.send(JSON.stringify({ op, d })); }

  setPresence(status) {
    const d = { since: status === "idle" ? Date.now() : null, afk: status === "idle", status, activities: [] };
    if (Math.random() < 0.6) d.activities = [{ name: ACTS[Math.floor(Math.random() * ACTS.length)], type: 2 }];
    this.send(3, d);
  }

  connectGateway(url) {
    return new Promise((resolve, reject) => {
      const ws = new WS(url + "?v=10&encoding=json");
      this.ws = ws;
      ws.onopen = () => this.send(2, {
        token: this.token, intents: 0,
        properties: { os: "Windows", browser: "Discord Client", device: "" },
        presence: { status: "online", since: null, activities: [], afk: false },
      });
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.s) this.seq = m.s;
        if (m.op === 10) {
          clearInterval(this.hbTimer);
          this.hbTimer = setInterval(() => this.send(1, this.seq), m.d.heartbeat_interval);
          resolve();
        } else if (m.op === 0 && m.t === "READY") {
          this.username = m.d.user.username;
          this.log(`logged in as @${this.username}`);
        }
      };
      ws.onerror = () => reject(new Error("ws error"));
      ws.onclose = () => { clearInterval(this.hbTimer); this.ws = null; reject(new Error("ws closed")); };
    });
  }

  closeGateway() {
    try { clearInterval(this.hbTimer); if (this.ws) this.ws.close(); } catch {}
    this.ws = null;
  }

  // ---------- webhook ----------
  async sendWebhook(title, color, fields) {
    if (!WEBHOOK_URL) return;
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title, color,
            fields: fields.map(f => ({ name: String(f.name), value: String(f.value), inline: !!f.inline })),
            timestamp: new Date().toISOString(),
          }],
        }),
      });
      if (!res.ok) this.log(`[!] Webhook HTTP ${res.status}`);
      else this.log("[+] Webhook sent: " + title);
    } catch (e) { this.log("[!] Webhook failed: " + e.message); }
  }

  // ---------- NITRO TRIAL DETECTOR ----------
  async checkNitro() {
    // 1) Trial offer endpoint — appears when Discord grants an offer to the account
    try {
      const offer = await this.api("GET", "/users/@me/billing/user-offer");
      const t = offer?.user_trial_offer;
      if (t && t.id && !this.notified.has("trial_" + t.id)) {
        this.notified.add("trial_" + t.id);
        const len = `${t.interval_count || 1} ${INTERVALS[t.interval] || "interval(s)"}`;
        await this.sendWebhook("🎉 NITRO TRIAL DETECTED", 0x5865F2, [
          { name: "Account", value: this.label, inline: true },
          { name: "User", value: this.username ? "@" + this.username : "unknown", inline: true },
          { name: "Trial", value: len, inline: true },
          { name: "SKU ID", value: t.sku_id || "?", inline: true },
          { name: "Expires", value: t.expires_at ? new Date(t.expires_at).toISOString() : "not acknowledged yet", inline: false },
        ]);
        this.log("[🎉] NITRO TRIAL on account!");
      }
    } catch (e) { /* 404 / no offer = normal */ }

    // 2) Active premium subscription — confirms trial actually active
    try {
      const subs = await this.api("GET", "/users/@me/billing/subscriptions");
      for (const s of subs || []) {
        const key = "sub_" + s.id;
        if (this.notified.has(key)) continue;
        const name = PREM_NAMES[s.type];
        if (name && (s.status === "active" || s.status === "trialing")) {
          this.notified.add(key);
          await this.sendWebhook("🎉 NITRO ACTIVE", 0x57F287, [
            { name: "Account", value: this.label, inline: true },
            { name: "User", value: this.username ? "@" + this.username : "unknown", inline: true },
            { name: "Plan", value: name, inline: true },
            { name: "Status", value: s.status, inline: true },
            { name: "Renewal", value: s.current_period_end ? new Date(s.current_period_end).toISOString() : "?", inline: false },
          ]);
          this.log(`[🎉] ${name} active on account!`);
        }
      }
    } catch (e) { /* no subscriptions = normal */ }
  }

  async nitroMonitor() {
    await this.checkNitro();                       // check once right away
    while (this.alive) {
      await sleep(NITRO_CHECK_MIN * 60000 + rand(0, 60000));   // poll every ~30 min + jitter
      try { await this.checkNitro(); } catch (e) { this.log("[!] Nitro check failed: " + e.message); }
    }
  }

  async setup() {
    try {
      await this.api("POST", "/hypesquad/online", { house_id: 1 });
      this.log("[+] Hypesquad: Bravery");
    } catch (e) { this.log("[!] Hypesquad failed: " + e.message); }

    try {
      const bio = BIOS[Math.floor(Math.random() * BIOS.length)];
      await this.api("PATCH", "/users/@me", { bio });
      this.log(`[+] Bio set: "${bio}"`);
    } catch (e) { this.log("[!] Bio failed: " + e.message); }

    // ONE quest — automatic, skipped if none
    try {
      const data = await this.api("GET", "/quests/@me");
      const quests = (data.quests || []).filter(q => {
        const us = q.user_status || {};
        if (us.completed_at) return false;
        if (q.config?.expires_at && new Date(q.config.expires_at) <= new Date()) return false;
        if (us.status && !["ELIGIBLE", "STARTED", "ENROLLED"].includes(us.status)) return false;
        return true;
      });
      if (quests.length) {
        const q = quests[0];
        this.log(`[*] Quest: ${q.config?.messages?.quest_name || q.id}`);
        try { await this.api("POST", `/quests/${q.id}/enroll`); this.log("[+] Enrolled"); } catch {}
        const tasks = q.config?.task_config_v2?.tasks || {};
        const entries = Object.entries(tasks);
        if (entries.length) {
          const [, t] = entries[0];
          if (t.type === "WATCH" && t.seconds_needed) {
            const res = await this.api("POST", `/quests/${q.id}/video-progress`, { timestamp: t.seconds_needed });
            this.log(res?.completed_at != null ? "[+] Quest completed (video)" : "[i] Video progress pushed");
          } else if (t.type === "PLAY" && q.config?.application?.id) {
            const start = Date.now();
            while (Date.now() - start < 90 * 60 * 1000) {
              const res = await this.api("POST", `/quests/${q.id}/heartbeat`, { application_id: q.config.application.id, terminal: false });
              const progress = Object.values(res?.progress || {})[0]?.value ?? 0;
              if (res?.completed_at != null) {
                await this.api("POST", `/quests/${q.id}/heartbeat`, { application_id: q.config.application.id, terminal: true });
                this.log("[+] Quest completed (play)");
                break;
              }
              await sleep(20000);
            }
          }
        }
      } else this.log("[!] No eligible quests.");
    } catch (e) { this.log("[!] Quest step failed: " + e.message); }
  }

  async presenceLoop(gwUrl) {
    const POOL = ["online", "online", "online", "online", "idle", "dnd"];
    while (this.alive) {
      try { await this.connectGateway(gwUrl); }
      catch (e) { this.log("[!] Gateway down, retry in 10-30s: " + e.message); await sleep(rand(10000, 30000)); continue; }

      const st = POOL[Math.floor(Math.random() * POOL.length)];
      const onMin = rand(15, 120);
      this.setPresence(st);
      this.log(`status=${st} for ${Math.round(onMin)} min`);
      await sleep(onMin * 60000);

      this.closeGateway();
      const offMin = rand(10, 50);
      this.log(`offline for ${Math.round(offMin)} min (real disconnect)`);
      await sleep(offMin * 60000);
    }
  }

  async start(gwUrl) {
    await this.setup();               // hypesquad + bio + 1 quest
    this.nitroMonitor().catch(e => this.log("[!] Nitro monitor died: " + e.message));  // parallel: checks every 30 min
    this.log("starting presence cycle");
    await this.presenceLoop(gwUrl);   // runs forever
  }
}

// ---------------- main ----------------
const accounts = [];
const run = async () => {
  const { url } = await fetch(API + "/gateway", { headers: HDRS }).then(r => r.json());

  for (let i = 0; i < TOKENS.length; i++) {
    const acc = new Account(TOKENS[i], i + 1);
    accounts.push(acc);
    acc.start(url).catch(e => acc.log("[!] Account error: " + e.message));
    await sleep(rand(2000, 5000));    // stagger startups so 100 tokens don't hit the gateway at once
  }
  console.log(`[+] All ${TOKENS.length} accounts started.`);
};

process.on("SIGTERM", () => { accounts.forEach(a => a.closeGateway()); process.exit(0); });
process.on("SIGINT",  () => { accounts.forEach(a => a.closeGateway()); process.exit(0); });

run().catch(e => { console.error(e.message); process.exit(1); });
