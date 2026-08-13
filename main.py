import asyncio
import datetime
import math
import os
import platform
import random
import re
import shutil
import subprocess

import aiohttp
import discord
from dotenv import load_dotenv

load_dotenv()

API = "https://discord.com/api/v9"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

HOUSE_IDS = [1, 2, 3]      # 1=Bravery, 2=Brilliance, 3=Balance
MAX_QUESTS = 1             # one quest per account per slot (None = unlimited)
MAX_TOKENS = 50            # DISCORD_TOKEN_1 .. DISCORD_TOKEN_50

WEBHOOK_URL = os.environ.get("NITRO_WEBHOOK_URL", "").strip()
NOTIFY_EXISTING_NITRO = os.environ.get("NOTIFY_EXISTING_NITRO", "").strip() == "1"

# ---- Bangladesh time scheduling (UTC+6) ----
BD_TZ = datetime.timezone(datetime.timedelta(hours=6))
FRIDAY_WEEKDAY = 4         # Monday=0 ... Friday=4

# (start_hour, start_minute, duration_minutes)
BD_SCHEDULE = [
    (8,  0,  25),    # 8:00 AM  – ~8:25 AM
    (13, 0,  30),    # 1:00 PM  – 1:30 PM
    (17, 0,  120),   # 5:00 PM  – 7:00 PM
]

# ---- Night mode: clients are CLOSED (disconnected) at night ----
NIGHT_START_HOUR = 23      # 11:00 PM BD -> close Discord
NIGHT_END_HOUR   = 7       # 7:00 AM  BD -> reconnect (before the 8 AM slot)
CLOSE_ON_FRIDAY  = True    # Friday = fully closed ("don't open Discord on Friday")

HUMAN_BIOS = [
    "Just vibing. Coffee in hand, deadlines in mind.",
    "Living my best life, one day at a time.",
    "Probably thinking about food right now.",
    "Introverted but working on it.",
    "Career mode: grinding. Social mode: charging.",
    "Movie nights > going out. Mostly.",
    "Here for good conversation and good memes.",
    "Work hard, nap harder.",
    "Currently between existential crisis and snack break.",
    "Kindness is free. Sprinkle it everywhere.",
    "Music on, world off.",
    "Learning something new every day, even if it's just a meme.",
]


# ---------------- token loading (up to 50) ----------------
def load_tokens() -> list:
    tokens = []
    for i in range(1, MAX_TOKENS + 1):
        v = os.environ.get(f"DISCORD_TOKEN_{i}")
        if v and v.strip():
            tokens.append(v.strip())
    if not tokens and os.environ.get("DISCORD_TOKEN"):
        tokens.append(os.environ["DISCORD_TOKEN"].strip())
    if not tokens and os.path.isfile("tokens.txt"):
        with open("tokens.txt") as f:
            tokens = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    tokens = tokens[:MAX_TOKENS]
    seen, out = set(), []
    for t in tokens:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


# ---------------- BD time helpers ----------------
def bd_now() -> datetime.datetime:
    return datetime.datetime.now(BD_TZ)


def is_friday() -> bool:
    return bd_now().weekday() == FRIDAY_WEEKDAY


def is_night() -> bool:
    """True between NIGHT_START_HOUR (11 PM) and NIGHT_END_HOUR (7 AM) BD."""
    h = bd_now().hour
    return h >= NIGHT_START_HOUR or h < NIGHT_END_HOUR


def current_bd_slot():
    now = bd_now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    sec = (now - today_start).total_seconds()
    for sh, sm, dur in BD_SCHEDULE:
        s_start = sh * 3600 + sm * 60
        s_end = s_start + dur * 60
        if s_start <= sec < s_end:
            return (sh, sm, dur)
    return None


def seconds_until_next_slot() -> float:
    now = bd_now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    sec = (now - today_start).total_seconds()
    if current_bd_slot() is not None:
        return 0.0
    for sh, sm, dur in BD_SCHEDULE:
        s_start = sh * 3600 + sm * 60
        if sec < s_start:
            return s_start - sec
    cand = now + datetime.timedelta(days=1)
    while cand.weekday() == FRIDAY_WEEKDAY:
        cand += datetime.timedelta(days=1)
    nxt = cand.replace(hour=BD_SCHEDULE[0][0], minute=BD_SCHEDULE[0][1],
                       second=0, microsecond=0)
    return (nxt - now).total_seconds()


def seconds_until_morning() -> float:
    """Seconds until NIGHT_END_HOUR (wake-up time) BD."""
    now = bd_now()
    wake = now.replace(hour=NIGHT_END_HOUR, minute=0, second=0, microsecond=0)
    if now >= wake:
        wake += datetime.timedelta(days=1)
    return (wake - now).total_seconds()


# ---------------- webhook ----------------
async def send_webhook(message: str) -> bool:
    if not WEBHOOK_URL:
        print("[webhook] no NITRO_WEBHOOK_URL set — skipping notification")
        return False
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(WEBHOOK_URL, json={"content": message}) as r:
                ok = r.status in (200, 204)
                print(f"[webhook] HTTP {r.status} -> {message[:120]}")
                return ok
    except Exception as e:
        print(f"[webhook] failed: {e!r}")
        return False


# ---------------- pure quest helpers (stateless) ----------------
def quest_tasks(quest: dict):
    tasks = []
    cfg = quest.get("config", {})
    for t in cfg.get("taskConfigV2", {}).get("tasks") or []:
        tasks.append({
            "type": t.get("type"),
            "target": float(t.get("target") or 0),
            "applications": t.get("applications") or [],
        })
    if not tasks:
        old = cfg.get("taskConfig", {}).get("tasks") or {}
        for ttype, t in old.items():
            if isinstance(t, dict):
                tasks.append({
                    "type": ttype,
                    "target": float(t.get("target") or 0),
                    "applications": t.get("applications") or [],
                })
    if cfg.get("game"):
        g = cfg["game"]
        tasks.append({"type": "PLAY_ON_DESKTOP", "target": 900.0,
                      "applications": [{"id": g.get("application_id"), "name": g.get("name"),
                                        "executable_names": g.get("executable_names") or []}]})
    if cfg.get("video"):
        v = cfg["video"]
        tasks.append({"type": "WATCH_VIDEO", "target": float(v.get("target_seconds") or 900),
                      "applications": [{"video_quest_id": v.get("video_quest_id"), "name": v.get("name")}]})
    return tasks


def quest_name(quest: dict) -> str:
    cfg = quest.get("config", {})
    return (cfg.get("messages", {}).get("questName")
            or cfg.get("messages", {}).get("title")
            or cfg.get("game", {}).get("name")
            or cfg.get("video", {}).get("name")
            or quest.get("id"))


def is_nitro_quest(quest: dict) -> bool:
    """True if the quest rewards a Nitro subscription/trial (any length)."""
    for r in quest.get("config", {}).get("rewards") or []:
        if "NITRO" in str(r.get("asset", {}).get("type", "")).upper():
            return True
        if "NITRO" in str(r.get("type", "")).upper():
            return True
    return False


def nitro_duration_text(quest: dict) -> str:
    """Best-effort: find the trial length inside the quest payload text."""
    blob = ""
    cfg = quest.get("config", {}) or {}
    blob += str(cfg.get("messages", {}))
    blob += str(cfg.get("rewards", {}))
    for r in cfg.get("rewards") or []:
        blob += str(r.get("asset", {}))
    blob = blob.upper()
    for pat, label in [
        (r"3\s*MONTH", "3 months trial"),
        (r"1\s*MONTH", "1 month trial"),
        (r"2\s*WEEK", "2 weeks trial"),
        (r"1\s*WEEK", "1 week trial"),
        (r"30\s*DAYS", "1 month trial"),
        (r"14\s*DAYS", "2 weeks trial"),
        (r"7\s*DAYS", "1 week trial"),
    ]:
        if re.search(pat, blob):
            return label
    return ""


def extract_reward_link(data: dict):
    if not data:
        return None
    reward = data.get("reward") or {}
    for d in (reward, data, data.get("data") or {}):
        if not isinstance(d, dict):
            continue
        for k in ("url", "link", "redemption_url", "redemption_link", "code", "claim_code"):
            v = d.get(k)
            if isinstance(v, str) and v and v.startswith(("http", "https", "discord")):
                return v
            if isinstance(v, str) and v and len(v) > 8:  # bare code fallback
                return v
    return None


def is_doable(quest: dict) -> bool:
    us = quest.get("userStatus") or {}
    if not us.get("enrolledAt"):
        return False
    if us.get("completedAt") or us.get("claimedAt"):
        return False
    exp = quest.get("config", {}).get("expiresAt")
    if exp:
        try:
            if datetime.datetime.fromisoformat(exp.replace("Z", "+00:00")) < datetime.datetime.now(datetime.timezone.utc):
                return False
        except ValueError:
            pass
    return True


def quest_progress_value(quest: dict, task_type: str) -> float:
    us = quest.get("userStatus") or {}
    entry = (us.get("progress") or {}).get(task_type)
    if isinstance(entry, dict):
        return float(entry.get("value") or 0)
    if task_type.startswith("PLAY_ON_DESKTOP") and quest.get("config", {}).get("configVersion") == 1:
        return float(us.get("streamProgressSeconds") or 0)
    return 0.0


def find_executable(names):
    if not names:
        return None
    lowered = {n.lower() for n in names}
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    if platform.system() == "Windows":
        bases = [os.environ.get("ProgramFiles", ""),
                 os.environ.get("ProgramFiles(x86)", ""),
                 os.path.expandvars(r"%LOCALAPPDATA%")]
        for base in bases:
            if not base or not os.path.isdir(base):
                continue
            for root, dirs, files in os.walk(base):
                if root[len(base):].count(os.sep) > 4:
                    dirs[:] = []
                    continue
                for f in files:
                    if f.lower() in lowered:
                        return os.path.join(root, f)
    return None


# ---------------- per-account client ----------------
class Account:
    def __init__(self, token: str, index: int):
        self.token = token
        self.index = index
        self.quests_completed = 0
        self.email = None
        self.notified_quests = set()
        self.has_nitro_alerted = False
        self.client = None
        self._make_client()

    def _make_client(self):
        self.client = discord.Client(self_bot=True)
        self.client.event(self._on_ready)

    def should_be_online(self) -> bool:
        """Online only during daytime non-Friday. Night & Friday = closed."""
        if is_friday() and CLOSE_ON_FRIDAY:
            return False
        if is_night():
            return False
        return True

    async def disconnect(self):
        """Fully close this account's Discord connection."""
        try:
            if self.client is not None and not self.client.is_closed():
                await self.client.close()
                print(f"[acc{self.index}] Discord CLOSED (night/Friday)")
        except Exception as e:
            print(f"[acc{self.index}] close error: {e!r}")

    # ---- REST API (per token, with 429 backoff) ----
    async def api_get(self, path: str) -> dict:
        for _ in range(5):
            async with aiohttp.ClientSession() as s:
                async with s.get(API + path,
                                 headers={"Authorization": self.token, "User-Agent": UA}) as r:
                    if r.status == 429:
                        try:
                            data = await r.json()
                            await asyncio.sleep(float(data.get("retry_after", 5)))
                        except Exception:
                            await asyncio.sleep(5)
                        continue
                    try:
                        return await r.json()
                    except Exception:
                        return {}
        return {}

    async def api_post(self, path: str, payload: dict):
        for _ in range(5):
            async with aiohttp.ClientSession() as s:
                async with s.post(API + path,
                                  headers={"Authorization": self.token,
                                           "Content-Type": "application/json",
                                           "User-Agent": UA},
                                  json=payload) as r:
                    if r.status == 429:
                        try:
                            data = await r.json()
                            await asyncio.sleep(float(data.get("retry_after", 5)))
                        except Exception:
                            await asyncio.sleep(5)
                        continue
                    try:
                        data = await r.json()
                    except Exception:
                        data = {}
                    return r.status, data
        return 429, {}

    # ---- webhook alert for this account ----
    async def notify_nitro(self, quest: dict | None = None, claim_data: dict | None = None):
        qid = quest["id"] if quest else "startup"
        if qid in self.notified_quests:
            return
        self.notified_quests.add(qid)
        email = self.email or getattr(self.client.user, "name", "unknown")
        msg = f"🎁 Account has nitro trial buddy {email}"
        if quest:
            dur = nitro_duration_text(quest)
            if dur:
                msg += f" ({dur})"
        link = extract_reward_link(claim_data)
        if link:
            msg += f"\n🔗 Redemption: {link}"
        await send_webhook(msg)

    # ---- HypeSquad ----
    async def switch_hype_squad(self, house_id: int) -> int:
        status, _ = await self.api_post("/hypesquad/online", {"house_id": house_id})
        return status

    # ---- bio (only if empty) ----
    async def set_bio(self, text: str) -> bool:
        try:
            await self.client.user.edit(bio=text)
            return True
        except discord.HTTPException as e:
            print(f"[acc{self.index}] Bio update failed: {e.status} {e.text}")
            return False

    # ---- video quest ----
    async def complete_video_quest(self, quest: dict, task: dict) -> bool:
        qid, target = quest["id"], float(task.get("target") or 900)
        print(f"[acc{self.index}] WATCH_VIDEO '{quest_name(quest)}' target={target:.0f}s")
        sent, steps = 0.0, max(3, min(8, math.ceil(target / 120)))
        while sent < target:
            sent = min(target, sent + target / steps)
            ts = round(sent + random.uniform(0.05, 0.9), 3)
            status, data = await self.api_post(f"/quests/{qid}/video-progress", {"timestamp": ts})
            print(f"[acc{self.index}] video-progress {ts:.1f}s -> HTTP {status}")
            if status == 429:
                await asyncio.sleep(float(data.get("retry_after", 5)))
                continue
            await asyncio.sleep(random.uniform(5, 8))
        for _ in range(6):
            q = await self.api_get(f"/users/@me/quests/{qid}")
            done = q.get("userStatus", {}).get("completedAt")
            print(f"[acc{self.index}] verify: progress={quest_progress_value(q, 'WATCH_VIDEO'):.1f}s" + (" DONE" if done else ""))
            if done:
                return True
            await asyncio.sleep(15)
        return False

    # ---- game quest ----
    async def complete_game_quest(self, quest: dict, task: dict) -> bool:
        app = (task.get("applications") or [{}])[0]
        g = quest.get("config", {}).get("game", {})
        app_id = app.get("id") or g.get("application_id")
        names = app.get("executable_names") or g.get("executable_names") or []
        gname = app.get("name") or g.get("name") or quest_name(quest)

        exe = find_executable(names)
        if not exe:
            print(f"[acc{self.index}] '{gname}': no executable found ({names or 'none listed'}) — skipping")
            return False

        print(f"[acc{self.index}] launching {exe}")
        flags = subprocess.CREATE_NO_WINDOW if platform.system() == "Windows" else 0
        proc = subprocess.Popen([exe], creationflags=flags)
        try:
            if app_id:
                await self.client.change_presence(activity=discord.Activity(
                    type=discord.ActivityType.playing, name=gname, application_id=app_id))
            qid = quest["id"]
            for _ in range(20):
                await asyncio.sleep(60)
                q = await self.api_get(f"/users/@me/quests/{qid}")
                val = quest_progress_value(q, task["type"])
                done = q.get("userStatus", {}).get("completedAt")
                print(f"[acc{self.index}] play progress: {val:.0f}s" + (" DONE" if done else ""))
                if done:
                    return True
            return False
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            await self.client.change_presence(activity=None)

    # ---- one quest for this account ----
    async def run_quest_once(self):
        if MAX_QUESTS is not None and self.quests_completed >= MAX_QUESTS:
            print(f"[acc{self.index}] cap reached ({MAX_QUESTS} quest(s) this session) — skipping")
            return

        data = await self.api_get("/users/@me/quests")
        quests = data.get("quests") or []
        if not quests:
            print(f"[acc{self.index}] no quests returned (token OK? quests endpoint reachable?)")
            return
        doable = [q for q in quests if is_doable(q)]
        if not doable:
            print(f"[acc{self.index}] no uncompleted quests — accept one in the Quests tab first")
            return
        print(f"[acc{self.index}] {len(doable)} uncompleted quests — completing ONE")

        pick = pick_task = None
        for q in doable:  # video quests first (fully automatable)
            for t in quest_tasks(q):
                if t["type"] in ("WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE"):
                    pick, pick_task = q, t
                    break
            if pick:
                break
        if not pick:  # then desktop play quests (exe must exist locally)
            for q in doable:
                for t in quest_tasks(q):
                    if t["type"] in ("PLAY_ON_DESKTOP", "PLAY_ON_DESKTOP_V2"):
                        pick, pick_task = q, t
                        break
                if pick:
                    break
        if not pick:
            print(f"[acc{self.index}] only stream/activity quests left — need a real VC stream, skipping")
            return

        name = quest_name(pick)
        dur = nitro_duration_text(pick)
        print(f"[acc{self.index}] SELECTED: {name} [{pick_task['type']}] "
              f"(nitro reward: {is_nitro_quest(pick)}{', ' + dur if dur else ''})")
        ok = await (self.complete_video_quest(pick, pick_task)
                    if pick_task["type"].startswith("WATCH_VIDEO")
                    else self.complete_game_quest(pick, pick_task))
        if ok:
            self.quests_completed += 1
            print(f"[acc{self.index}] DONE: '{name}' completed.")

            # claim the reward -> activates Nitro trial / returns redemption link
            st, cdata = await self.api_post(f"/quests/{pick['id']}/claim", {})
            print(f"[acc{self.index}] claim -> HTTP {st} {str(cdata)[:300]}")
            claimed_ok = st in (200, 201, 204)

            if is_nitro_quest(pick):
                # alert even if claim failed (trial may still be auto-granted / manual claim needed)
                await self.notify_nitro(pick, cdata)
                if not claimed_ok:
                    print(f"[acc{self.index}] ⚠️ claim HTTP {st} — trial may need manual claim in-app")
        else:
            print(f"[acc{self.index}] '{name}' failed or timed out.")

    # ---- startup tasks per account (status=online + HypeSquad + bio + email) ----
    async def _on_ready(self):
        print(f"[acc{self.index}] Logged in as {self.client.user} (ID: {self.client.user.id})")

        # explicitly ONLINE — never invisible while connected
        try:
            await self.client.change_presence(status=discord.Status.online)
            print(f"[acc{self.index}] status set to ONLINE")
        except Exception as e:
            print(f"[acc{self.index}] status change failed: {e!r}")

        try:
            me = await self.api_get("/users/@me")
            self.email = me.get("email") or None
        except Exception:
            self.email = None
        print(f"[acc{self.index}] email: {self.email or 'not exposed'}")

        house_id = random.choice(HOUSE_IDS)
        status = await self.switch_hype_squad(house_id)
        print(f"[acc{self.index}] HypeSquad -> house {house_id} | HTTP {status}")

        current = getattr(self.client.user, "bio", None)
        if current:
            print(f"[acc{self.index}] Bio exists -> leaving: {current!r}")
        else:
            bio = random.choice(HUMAN_BIOS)
            ok = await self.set_bio(bio)
            print(f"[acc{self.index}] Bio -> {'set' if ok else 'FAILED'}: {bio}")

        if NOTIFY_EXISTING_NITRO and not self.has_nitro_alerted:
            premium = getattr(self.client.user, "premium_type", 0) or 0
            if premium:
                await self.notify_nitro(None)
                self.has_nitro_alerted = True


# ---------------- per-account runner (respects night/Friday close) ----------------
async def account_runner(acc: Account):
    while True:
        if not acc.should_be_online():
            await asyncio.sleep(60)   # stay closed during night / Friday
            continue
        try:
            acc._make_client()        # fresh client each session
            await acc.client.start(acc.token)  # blocks until closed/disconnected
            print(f"[acc{acc.index}] client stopped — reconnecting in 30s")
        except Exception as e:
            print(f"[acc{acc.index}] connection error: {e!r} — retrying in 30s")
        await asyncio.sleep(30)


# ---------------- shared BD scheduler (all accounts) ----------------
async def scheduled_quest_loop(accounts):
    while True:
        now = bd_now()

        # Friday: fully closed, no quests
        if is_friday():
            if CLOSE_ON_FRIDAY:
                print(f"[scheduler] Friday (BD {now.strftime('%A %H:%M')}) — closing all Discord clients")
                for a in accounts:
                    await a.disconnect()
            wait = seconds_until_next_slot()
            print(f"[scheduler] Friday — sleeping {wait/3600:.1f}h until next non-Friday slot")
            await asyncio.sleep(wait)
            continue

        # Night: fully closed, reconnect in the morning
        if is_night():
            print(f"[scheduler] Night mode (BD {now.strftime('%H:%M')}) — closing all Discord clients")
            for a in accounts:
                await a.disconnect()
            wait = seconds_until_morning()
            print(f"[scheduler] Night — sleeping {wait/3600:.1f}h until {NIGHT_END_HOUR}:00 AM")
            await asyncio.sleep(wait)
            continue

        slot = current_bd_slot()
        if slot is not None:
            sh, sm, dur = slot
            print(f"[scheduler] Slot {sh:02d}:{sm:02d} ({dur}min window) — running quests on "
                  f"{len(accounts)} account(s)")
            tasks = []
            for a in accounts:
                tasks.append(asyncio.create_task(a.run_quest_once()))
                await asyncio.sleep(random.uniform(2, 6))  # stagger to soften rate limits
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for a, res in zip(accounts, results):
                if isinstance(res, Exception):
                    print(f"[acc{a.index}] quest error: {res!r}")

            now_in = bd_now()
            today_start = now_in.replace(hour=0, minute=0, second=0, microsecond=0)
            sec = (now_in - today_start).total_seconds()
            slot_end = (sh * 3600 + sm * 60) + dur * 60
            remain = max(60.0, slot_end - sec)
            print(f"[scheduler] Slot ends in {remain/60:.1f}min — sleeping")
            await asyncio.sleep(remain)
        else:
            wait = seconds_until_next_slot()
            print(f"[scheduler] No active slot (BD {bd_now().strftime('%H:%M')}) — "
                  f"next slot in {wait/60:.1f}min")
            slept = 0.0
            while slept < wait:
                await asyncio.sleep(min(60, wait - slept))
                slept += 60
                if current_bd_slot() is not None:
                    print("[scheduler] Slot just became active")
                    break


# ---------------- Railway health server (keeps the service alive) ----------------
async def health_server():
    port = int(os.environ.get("PORT", "8000"))

    async def handler(request):
        return aiohttp.web.Response(text="ok")

    app = aiohttp.web.Application()
    app.router.add_get("/", handler)
    app.router.add_get("/health", handler)
    runner = aiohttp.web.AppRunner(app)
    await runner.setup()
    site = aiohttp.web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    print(f"[server] Railway health endpoint listening on :{port}")


async def main():
    tokens = load_tokens()
    if not tokens:
        print("No tokens found. Set DISCORD_TOKEN_1..DISCORD_TOKEN_50 in Railway env "
              "(or add tokens.txt, one per line).")
        return

    print(f"Loaded {len(tokens)} account(s)")
    accounts = [Account(t, i + 1) for i, t in enumerate(tokens)]
    print(f"Bangladesh time now: {bd_now().strftime('%A %Y-%m-%d %H:%M:%S')}")
    print(f"Schedule: {BD_SCHEDULE}")
    print(f"Night close: {NIGHT_START_HOUR}:00 PM-{NIGHT_END_HOUR}:00 AM BD (clients CLOSED)")
    print(f"Friday: {'fully closed' if CLOSE_ON_FRIDAY else 'online but no quests'}")
    print(f"Webhook: {'configured' if WEBHOOK_URL else 'NOT SET (NITRO_WEBHOOK_URL)'}")

    asyncio.create_task(health_server())
    asyncio.create_task(scheduled_quest_loop(accounts))
    await asyncio.gather(*(account_runner(a) for a in accounts))


if __name__ == "__main__":
    asyncio.run(main())
