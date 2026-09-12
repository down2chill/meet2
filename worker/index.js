/**
 * Meet - Cloudflare Worker API
 *
 * Public
 *   POST /api/join                  mint a participant auth token
 *   POST /api/login                 start an admin session
 *   POST /api/logout                end it
 *   GET  /api/session               who am I
 *
 * Admin only (session cookie + X-CSRF header on writes)
 *   GET    /api/meetings            list every live meeting
 *   POST   /api/rooms               create a meeting
 *   POST   /api/meetings/<code>     update title / password
 *   POST   /api/meetings/<code>/host  issue a fresh host link
 *   DELETE /api/meetings/<code>     deactivate on Cloudflare, then drop the record
 *   DELETE /api/orphans/<meetingId> deactivate a meeting Cloudflare has and we do not
 *
 * Cron (see wrangler.jsonc): deactivates meetings still ACTIVE on Cloudflare
 * whose record here has expired -- 30 days after anyone last joined.
 *
 *   GET  /api/debug                 bindings + presets (needs ADMIN_KEY secret)
 *   GET  /og/<code>.<ver>.jpg       live share card (title + schedule), cached
 *   GET  /og/<code>.<ver>.mp4       the same card as a short animated loop
 *   *                               static assets from the ASSETS binding
 *
 * /j/<code> shells get their og:/twitter: tags personalised on the way out,
 * so a pasted invite unfurls with the meeting's own card. See shareCard().
 */

import { ImageResponse } from "workers-og";
import UPNG from "upng-js";
import jpeg from "jpeg-js";
import "./vendor/h264-wasm.js";
import hme from "./vendor/h264.cjs";

// jpeg-js hands its bytes back through Node's Buffer; workerd has none, and
// the only method touched on the encode path is covered by a Uint8Array.
if (typeof globalThis.Buffer === "undefined")
  globalThis.Buffer = { from: (a) => new Uint8Array(a) };

const CF_API = "https://api.cloudflare.com/client/v4/accounts";

/* ---------- CHANGE THESE ---------- */
const HOST_PRESET = "Host";
const GUEST_PRESET = "Guest";
/* --------------------------------- */

// Room codes, host keys and session tokens. No i/l/o, so codes read aloud.
const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LEN = 8;
const HOSTKEY_LEN = 16;
const TOKEN_LEN = 32;
const CODE_RE = new RegExp("^[" + ALPHA + "]{" + CODE_LEN + "}$");
const HOSTKEY_RE = new RegExp("^[" + ALPHA + "]{" + HOSTKEY_LEN + "}$");
const TOKEN_RE = new RegExp("^[" + ALPHA + "]{" + TOKEN_LEN + "}$");

const MAX_TITLE = 100;
const MAX_PASSWORD = 128;
const MAX_NAME = 60;
const MAX_BODY = 4096; // bytes. Nothing legitimate comes close.
// A record lives 30 days past the last time anyone joined the meeting. Joining
// extends it (touchRoom); creating or editing does not.
const ROOM_TTL = 60 * 60 * 24 * 30;
// A join only rewrites the record when the previous extension is at least this
// old, so a busy meeting costs one KV write a day rather than one per join.
const TOUCH_MIN_INTERVAL = 60 * 60 * 24;
// Meeting ids are UUIDs. Anything else in the URL is not ours to forward.
const MEETING_ID_RE = /^[a-f0-9-]{8,64}$/i;
// Cloudflare's meeting list, a page at a time.
const RTK_PAGE = 100;
// The sweep never touches a meeting this young: a record written seconds ago
// can still be missing from KV's list index.
const FRESH_GRACE_MS = 60 * 60 * 1000;
// KV's minimum. Anything longer means a deleted meeting stays joinable, and a
// changed password stays accepted, at an edge that already cached the record.
const KV_CACHE_TTL = 60;
const UPSTREAM_TIMEOUT = 10000;

// Share cards. CARD_REV busts every cached card after a design change; the
// rest of the version hash comes from the record (title / schedule), so an
// edited meeting is a brand-new image URL to crawlers that cached the old one.
const CARD_REV = 4;
// WhatsApp silently drops preview images much over ~300 KB (Telegram and
// Facebook allow megabytes), so the card ships as JPEG at this quality —
// the photo band lands near 200 KB where the same pixels as PNG were 650 KB.
const CARD_JPEG_Q = 82;
// The og:video variant of the card: a short seamless loop of the card pixels
// with scripted effects, H.264-encoded in-worker. Platforms that ignore
// og:video (WhatsApp, iMessage) fall back to the og:image JPEG.
const VID = { w: 640, h: 336, fps: 12, frames: 42, qp: 28 };
const MAX_TZ = 40; // IANA zone names top out around 30 chars
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,40}$/;
// Schedules must be real epoch-ms timestamps this side of 2100.
const validWhen = (v) => (Number.isFinite(v) && v > 0 && v < 4102444800000 ? Math.floor(v) : 0);

const SESSION_TTL = 60 * 60 * 12; // 12 hours
const COOKIE = "meet_sess";
const MAX_USERNAME = 64;
const LIST_LIMIT = 1000;
const LEGACY_LOOKUP_CAP = 100; // pre-metadata rooms we will open to get a title

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Stops another site iframing the meeting to trick a visitor into granting
  // camera access. Change to a CSP frame-ancestors list if you ever embed this.
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy":
    "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

// The RealtimeKit UI loads blob workers, wasm and mediastream sources, so a
// CSP has to be tested against a real meeting before it is enforced. Set
// CSP = CSP_POLICY once you have done that, then confirm screenshare and
// background blur still work.
//
// Background blur and virtual backgrounds are the awkward part: the addon
// fetches its TensorFlow Lite runtime and segmentation model at runtime from
// hosts Dyte still owns, not from us and not from Cloudflare. Those two hosts
// are listed below for that reason alone -- drop them and the background
// button stops working the moment this policy is switched on.
const BG_EFFECT_HOSTS =
  "https://assets.dyte.io https://dyte-plugins.s3.ap-south-1.amazonaws.com";
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' " + BG_EFFECT_HOSTS,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: " + BG_EFFECT_HOSTS,
  "font-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "worker-src 'self' blob:",
  "connect-src 'self' https://*.cloudflare.com wss://*.cloudflare.com blob: " +
    BG_EFFECT_HOSTS,
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");
const CSP = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/api/join")
        return method === "POST" ? await joinRoom(request, env, ctx) : notAllowed();

      if (path === "/api/login")
        return method === "POST" ? await login(request, env) : notAllowed();

      if (path === "/api/logout")
        return method === "POST" ? await logout(request, env) : notAllowed();

      if (path === "/api/session")
        return method === "GET" ? await session(request, env) : notAllowed();

      if (path === "/api/rooms")
        return method === "POST" ? await guard(request, env, createRoom, url) : notAllowed();

      if (path === "/api/meetings")
        return method === "GET" ? await guard(request, env, listMeetings, url) : notAllowed();

      if (path.startsWith("/api/meetings/")) {
        const rest = path.slice("/api/meetings/".length).split("/");
        const code = rest[0];
        if (!CODE_RE.test(code)) return json({ error: "Not found" }, 404);

        if (rest[1] === "host" && rest.length === 2 && method === "POST")
          return await guard(request, env, (rq, e, u, who) => rotateHost(e, u, code), url);

        if (rest.length !== 1) return json({ error: "Not found" }, 404);
        if (method === "POST")
          return await guard(request, env, (rq, e, u) => updateMeeting(rq, e, code), url);
        if (method === "DELETE")
          return await guard(request, env, (rq, e) => deleteMeeting(e, code), url);
        return notAllowed();
      }

      if (path.startsWith("/api/orphans/")) {
        const id = path.slice("/api/orphans/".length);
        if (!MEETING_ID_RE.test(id)) return json({ error: "Not found" }, 404);
        return method === "DELETE"
          ? await guard(request, env, (rq, e) => deactivateOrphan(e, id), url)
          : notAllowed();
      }

      if (path === "/api/debug") return await debugInfo(env, url);

      // Never let an unmatched /api/* path fall through to the SPA shell.
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);

      if (path.startsWith("/og/") && (method === "GET" || method === "HEAD"))
        return await shareCard(request, env, ctx, path.slice(4));

      return await serveAsset(request, env);
    } catch (err) {
      // Detail goes to the Worker log, not to the caller.
      console.error("unhandled", path, err && err.stack ? err.stack : err);
      return json({ error: "Something went wrong." }, 500);
    }
  },

  // Daily. Records expire 30 days after the last join; whatever is still
  // ACTIVE on Cloudflare without a record has therefore gone unused for a
  // month (or was removed here while Cloudflare was unreachable) and is
  // switched off.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweepOrphans(env));
  },
};

/* ------------------------------ auth ------------------------------ */

// No cookie means no KV read at all, so the public pages stay cheap.
async function currentAdmin(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token || !TOKEN_RE.test(token)) return null;
  const sess = await env.ROOMS.get("sess:" + token, { type: "json" });
  return sess && sess.username ? sess.username : null;
}

// Every admin route goes through here: session, then CSRF on writes.
async function guard(request, env, handler, url) {
  const who = await currentAdmin(request, env);
  if (!who) return json({ error: "Not signed in" }, 401);

  // A cross-site form post cannot set a custom header, and a cross-site fetch
  // that tries is stopped by the preflight we never answer. Belt and braces
  // alongside SameSite=Strict.
  if (request.method !== "GET" && request.headers.get("X-CSRF") !== "1")
    return json({ error: "Bad request" }, 400);

  return await handler(request, env, url, who);
}

async function login(request, env) {
  if (await limited(env.LOGIN_LIMIT, clientIp(request)))
    return json({ error: "Too many attempts. Try again in a minute." }, 429);

  const body = await readJson(request);
  if (!body) return json({ error: "Bad request" }, 400);

  const expectedUser = str(env.ADMIN_USERNAME, MAX_USERNAME).trim();
  const expectedPass = str(env.ADMIN_PASSWORD, MAX_PASSWORD);

  // With no secrets set there is no admin, so nothing can sign in. Without
  // this check an empty password would match an unset secret.
  if (!expectedUser || !expectedPass) {
    console.error("ADMIN_USERNAME / ADMIN_PASSWORD secrets are not set");
    return json({ error: "Incorrect username or password" }, 401);
  }

  const username = str(body.username, MAX_USERNAME).trim();
  const password = str(body.password, MAX_PASSWORD);

  // Compare digests rather than the raw strings. They are the same length
  // every time, so the comparison cannot leak how long the real password is,
  // and both halves are always evaluated so the timing does not say which one
  // was wrong.
  const userOk = safeEqual(
    await sha256(username.toLowerCase()),
    await sha256(expectedUser.toLowerCase())
  );
  const passOk = safeEqual(await sha256(password), await sha256(expectedPass));

  if (!userOk || !passOk)
    return json({ error: "Incorrect username or password" }, 401);

  const token = rand(TOKEN_LEN);
  // Store the configured spelling, not whatever case they typed.
  await env.ROOMS.put(
    "sess:" + token,
    JSON.stringify({ username: expectedUser, createdAt: Date.now() }),
    { expirationTtl: SESSION_TTL }
  );

  return json(
    { username: expectedUser },
    200,
    { "set-cookie": cookie(token, SESSION_TTL) }
  );
}

async function logout(request, env) {
  const token = readCookie(request, COOKIE);
  if (token && TOKEN_RE.test(token)) await env.ROOMS.delete("sess:" + token);
  return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
}

async function session(request, env) {
  const who = await currentAdmin(request, env);
  return json({ authed: !!who, username: who || null });
}

/* ---------------------------- meetings ---------------------------- */

async function createRoom(request, env, url) {
  // Creation is behind the login now, so this is only a ceiling on a
  // compromised or shared admin session.
  if (await limited(env.CREATE_LIMIT, clientIp(request)))
    return json({ error: "Too many meetings created. Try again in a minute." }, 429);

  const body = await readJson(request);
  if (!body) return json({ error: "Bad request" }, 400);

  const title = clean(body.title, MAX_TITLE) || "Meeting";
  const password = str(body.password, MAX_PASSWORD);
  // Optional schedule for the share card: epoch ms plus the admin's IANA zone,
  // so the card prints the session's own local time, not the reader's.
  const when = validWhen(body.when);
  const tz = TZ_RE.test(str(body.tz, MAX_TZ)) ? body.tz : "";

  const res = await cfApi(env, "/meetings", "POST", { title });
  const meetingId = res.body && res.body.data && res.body.data.id;
  if (!res.ok || !meetingId) {
    console.error("create meeting failed", res.status, JSON.stringify(res.body));
    return json({ error: "Could not create the meeting." }, 502);
  }

  const code = rand(CODE_LEN);
  const hostKey = rand(HOSTKEY_LEN);
  const now = Date.now();

  // Only hashes are stored, so a KV dump does not hand out host rights or
  // meeting passwords.
  const record = {
    meetingId,
    title,
    createdAt: now,
    exp: Math.floor(now / 1000) + ROOM_TTL,
    hostKeyHash: await sha256(hostKey),
  };
  if (when) {
    record.when = when;
    if (tz) record.tz = tz;
  }
  if (password) {
    record.pwSalt = rand(16);
    record.pwHash = await sha256(record.pwSalt + password);
  }

  await putRoom(env, code, record);

  // The dashboard inserts this row straight into its list. Waiting for a fresh
  // /api/meetings would be a race: KV's list index does not show a brand new
  // key for a few seconds.
  return json({
    code,
    ...links(url, code, hostKey),
    meeting: {
      code,
      meetingId,
      title: record.title,
      when: record.when || null,
      createdAt: record.createdAt,
      lastUsedAt: null,
      hasPassword: !!record.pwHash,
      expiresAt: record.exp,
      guestLink: links(url, code).guestLink,
      // Same shape as a listed row, so the optimistic insert behaves like one.
      status: "active",
    },
  });
}

// One KV list call renders the whole dashboard. The title, creation time and
// password flag ride along as key metadata, so there is no read per row.
async function listMeetings(request, env, url) {
  // Two lists, fetched together: what Cloudflare says is ACTIVE, and what we
  // have records for. Cloudflare decides whether a meeting exists; our record
  // supplies the code, the password flag and the links.
  const [kv, rtk] = await Promise.all([kvRooms(env), rtkActiveMeetings(env)]);

  const byId = new Map(kv.rooms.map((r) => [r.meetingId, r]));
  const active = new Set(rtk.ok ? rtk.meetings.map((m) => m.id) : []);

  const meetings = kv.rooms.map((r) => ({
    code: r.code,
    meetingId: r.meetingId,
    title: r.title,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    hasPassword: r.hasPassword,
    expiresAt: r.expiresAt,
    guestLink: links(url, r.code).guestLink,
    // "inactive" means Cloudflare no longer has it ACTIVE: the record is a
    // leftover and can be removed. "unknown" means we could not ask.
    status: !rtk.ok ? "unknown" : r.meetingId && active.has(r.meetingId) ? "active" : "inactive",
  }));

  // ACTIVE on Cloudflare, no record here. Only claimed when our side of the
  // picture is complete -- a room we could not open might well be one of them.
  const orphans =
    rtk.ok && kv.complete
      ? rtk.meetings
          .filter((m) => !byId.has(m.id))
          .map((m) => ({ meetingId: m.id, title: m.title || "(untitled)", createdAt: m.created_at || null }))
      : [];

  meetings.sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0));
  orphans.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  return json({ meetings, orphans, truncated: !kv.complete, rtkError: !rtk.ok });
}

async function updateMeeting(request, env, code) {
  const body = await readJson(request);
  if (!body) return json({ error: "Bad request" }, 400);

  const room = await env.ROOMS.get("room:" + code, { type: "json" });
  if (!room) return json({ error: "Meeting not found" }, 404);

  if (body.title !== undefined) room.title = clean(body.title, MAX_TITLE) || "Meeting";

  // Absent means leave it alone; null (or anything invalid) clears it.
  if (body.when !== undefined) {
    const when = validWhen(body.when);
    const tz = TZ_RE.test(str(body.tz, MAX_TZ)) ? body.tz : "";
    if (when) {
      room.when = when;
      if (tz) room.tz = tz;
    } else {
      delete room.when;
      delete room.tz;
    }
  }

  // Absent means leave it alone; empty string means remove the password.
  if (body.password !== undefined) {
    const pw = str(body.password, MAX_PASSWORD);
    delete room.password; // drop any pre-hash field while we are here
    if (pw) {
      room.pwSalt = rand(16);
      room.pwHash = await sha256(room.pwSalt + pw);
    } else {
      delete room.pwSalt;
      delete room.pwHash;
    }
  }

  await putRoom(env, code, room);
  // Returned so the dashboard can update its row without re-reading the list.
  return json({
    ok: true,
    title: room.title,
    when: room.when || null,
    hasPassword: !!room.pwHash,
    expiresAt: room.exp,
  });
}

// The host key is only ever stored as a hash, so it cannot be shown again
// later. Issuing a new one is how you hand out host access, and it revokes
// whatever link was in circulation before.
async function rotateHost(env, url, code) {
  const room = await env.ROOMS.get("room:" + code, { type: "json" });
  if (!room) return json({ error: "Meeting not found" }, 404);

  const hostKey = rand(HOSTKEY_LEN);
  room.hostKeyHash = await sha256(hostKey);
  delete room.hostKey; // drop any pre-hash field

  await putRoom(env, code, room);
  return json(links(url, code, hostKey));
}

// There is no way to delete a meeting on Cloudflare's side, only to switch it
// off, so that is what "delete" means: PATCH it INACTIVE, and only once that
// has succeeded drop our record. If Cloudflare cannot be reached the record
// stays, so the row stays, so it can be tried again rather than becoming one
// more meeting quietly left running.
async function deleteMeeting(env, code) {
  const room = await env.ROOMS.get("room:" + code, { type: "json" });
  if (!room) return json({ error: "Meeting not found" }, 404);

  if (room.meetingId) {
    const r = await deactivateMeeting(env, room.meetingId);
    // 404 means Cloudflare has already forgotten it; nothing left to switch off.
    if (!r.ok && r.status !== 404)
      return json({ error: "Cloudflare did not confirm the deactivation. Nothing was removed; try again." }, 502);
  }

  await env.ROOMS.delete("room:" + code);
  return json({ ok: true });
}

async function deactivateOrphan(env, meetingId) {
  const r = await deactivateMeeting(env, meetingId);
  if (!r.ok && r.status !== 404)
    return json({ error: "Cloudflare did not confirm the deactivation. Try again." }, 502);
  return json({ ok: true });
}

async function joinRoom(request, env, ctx) {
  const body = await readJson(request);
  if (!body) return json({ error: "Bad request" }, 400);

  const code = str(body.code, CODE_LEN + 1);
  if (!CODE_RE.test(code)) return json({ error: "Meeting not found" }, 404);

  if (await limited(env.JOIN_LIMIT, clientIp(request) + ":" + code))
    return json({ error: "Too many attempts. Try again in a minute." }, 429);

  const room = await env.ROOMS.get("room:" + code, {
    type: "json",
    cacheTtl: KV_CACHE_TTL,
  });
  if (!room) return json({ error: "Meeting not found" }, 404);

  // A signed-in admin owns every meeting: host preset, no password, no key.
  const admin = await currentAdmin(request, env);

  if (!admin) {
    const supplied = str(body.password, MAX_PASSWORD);

    // A client warming up asks with no password so it can find out whether to
    // show the field. That is a normal answer, not a failure: replying 403
    // here would put a red error in the console on every load of a protected
    // room.
    if (!supplied && (room.pwHash || room.password))
      return json({ needsPassword: true });

    if (!(await passwordOk(room, supplied)))
      return json({ error: "Incorrect password", needsPassword: true }, 403);
  }

  const hostKey = str(body.hostKey, HOSTKEY_LEN + 1);
  const isHost =
    !!admin || (HOSTKEY_RE.test(hostKey) && (await hostKeyOk(room, hostKey)));
  const preset = isHost ? HOST_PRESET : GUEST_PRESET;

  const res = await cfApi(
    env,
    "/meetings/" + encodeURIComponent(room.meetingId) + "/participants",
    "POST",
    {
      name: clean(body.name, MAX_NAME) || "Guest",
      preset_name: preset,
      custom_participant_id: crypto.randomUUID(),
    }
  );

  const token =
    res.body && res.body.data && (res.body.data.token || res.body.data.auth_token);
  if (!res.ok || !token) {
    console.error("token failed", res.status, JSON.stringify(res.body));
    return json({ error: "Could not join the meeting." }, 502);
  }

  // Someone got in: this meeting is in use, so its 30 days start again. Off
  // the response path; the token is what they are waiting for.
  const touch = touchRoom(env, code, room);
  if (ctx) ctx.waitUntil(touch);
  else await touch;

  return json({ authToken: token, preset, isHost, title: room.title || null });
}

// Gated behind the ADMIN_KEY secret. With no secret set the route does not
// exist, so a stock deploy leaks nothing.
async function debugInfo(env, url) {
  if (!env.ADMIN_KEY || !safeEqual(env.ADMIN_KEY, url.searchParams.get("key") || ""))
    return json({ error: "Not found" }, 404);

  const presets = await cfApi(env, "/presets");
  return json({
    kv: !!env.ROOMS,
    account: !!env.CF_ACCOUNT_ID,
    app: !!env.RTK_APP_ID,
    token: !!env.RTK_API_TOKEN,
    adminUser: !!env.ADMIN_USERNAME,
    adminPassword: !!env.ADMIN_PASSWORD,
    rateLimiters: {
      create: !!env.CREATE_LIMIT,
      join: !!env.JOIN_LIMIT,
      login: !!env.LOGIN_LIMIT,
    },
    presets: ((presets.body && presets.body.data) || []).map((p) => p.name),
    expecting: [HOST_PRESET, GUEST_PRESET],
  });
}

async function serveAsset(request, env) {
  const res = await env.ASSETS.fetch(request);
  if (!res.body) return res; // 204/304 carry no body to re-wrap
  const out = new Response(res.body, res);
  for (const k in SECURITY_HEADERS) out.headers.set(k, SECURITY_HEADERS[k]);
  if (CSP) out.headers.set("Content-Security-Policy", CSP);
  return await personaliseShell(request, env, out);
}

// Crawlers never run the SPA, so /j/<code> share tags are rewritten on the way
// out: the meeting's title and schedule, and an og:image pointing at its live
// card. Unknown or expired codes fall through with the generic shell tags.
async function personaliseShell(request, env, res) {
  const code = new URL(request.url).pathname.match(/^\/j\/([^/]+)$/)?.[1];
  if (!code || !CODE_RE.test(code)) return res;
  if (!(res.headers.get("Content-Type") || "").includes("text/html")) return res;

  const room = await env.ROOMS.get("room:" + code, { type: "json", cacheTtl: KV_CACHE_TTL });
  if (!room) return res;

  const origin = new URL(request.url).origin;
  const title = room.title || "Meeting";
  const ver = await cardVersion(room);
  const img = origin + "/og/" + code + "." + ver + ".jpg";
  const desc =
    (room.when ? formatWhen(room.when, room.tz) + ". " : "") +
    "You have been invited to a Down2Chill video room. Open the link to join.";

  const set = {
    "og:title": title,
    "og:description": desc,
    "og:url": origin + "/j/" + code,
    "og:image": img,
    "og:image:alt": title + " - Down2Chill Meet",
    "twitter:title": title,
    "twitter:description": desc,
    "twitter:image": img,
  };
  const rw = new HTMLRewriter();
  for (const [k, v] of Object.entries(set)) {
    const put = { element: (e) => e.setAttribute("content", v) };
    rw.on(`meta[property="${k}"]`, put);
    rw.on(`meta[name="${k}"]`, put);
  }
  // The shell carries no og:video tags to rewrite, so the animated card is
  // appended here — but only for crawlers known to play it. WhatsApp drops
  // the WHOLE preview when og:video is present (it cannot thumbnail the mp4
  // and gives up rather than fall back), so everyone not on this list gets
  // the image-only tags that work everywhere.
  if (/telegrambot|discordbot/i.test(request.headers.get("User-Agent") || "")) {
    const vid = origin + "/og/" + code + "." + ver + ".mp4";
    rw.on("head", {
      element: (e) =>
        e.append(
          `<meta property="og:video" content="${vid}" />` +
            `<meta property="og:video:secure_url" content="${vid}" />` +
            `<meta property="og:video:type" content="video/mp4" />` +
            `<meta property="og:video:width" content="${VID.w}" />` +
            `<meta property="og:video:height" content="${VID.h}" />`,
          { html: true }
        ),
    });
  }
  return rw.transform(res);
}

/* ---------------------------- share cards ---------------------------- */

// GET /og/<code>.<version>.jpg|.mp4 — the meeting's share card, rendered on
// demand (satori + resvg via workers-og, then JPEG or an H.264 loop) and never
// stored: the edge cache absorbs repeats. The version lives in the path, not a
// query string (some WhatsApp clients choke on queries in og:image), and the
// server recomputes it from the record: stale or made-up versions redirect to
// the canonical URL, so the cache only ever holds one entry per meeting per
// format and probing cannot force re-renders, while a real edit (new title or
// time) is a new URL to crawlers.
async function shareCard(request, env, ctx, rest) {
  const m = rest.match(/^([^.]+?)(?:\.([0-9a-f]{8,16}))?\.(png|jpe?g|mp4)$/);
  if (!m || !CODE_RE.test(m[1])) return json({ error: "Not found" }, 404);
  const code = m[1];
  const ext = m[3] === "mp4" ? "mp4" : "jpg";

  const room = await env.ROOMS.get("room:" + code, { type: "json", cacheTtl: KV_CACHE_TTL });
  // Unknown or expired: hand crawlers the generic brand image instead of a 404.
  if (!room) return Response.redirect(new URL("/brand/social-1200.jpg", request.url), 302);

  const ver = await cardVersion(room);
  const canonical = new URL("/og/" + code + "." + ver + "." + ext, request.url);
  if (m[2] !== ver) return Response.redirect(canonical, 302);

  const key = new Request(canonical);
  let res = await caches.default.match(key);
  if (!res) {
    res = ext === "mp4" ? await renderVideo(env, room) : await renderCard(env, room);
    ctx.waitUntil(caches.default.put(key, res.clone()));
  }
  return request.method === "HEAD" ? new Response(null, res) : res;
}

const cardVersion = async (room) =>
  (await sha256([CARD_REV, room.title || "", room.when || "", room.tz || ""].join("|"))).slice(0, 12);

// "Thursday, September 17 · 3:00 PM EDT", in the zone it was scheduled from.
// The year only appears once it is not this year.
function formatWhen(when, tz) {
  const fmt = (opt) => {
    try {
      return new Intl.DateTimeFormat("en-US", { ...opt, timeZone: tz || "UTC" }).format(when);
    } catch {
      return new Intl.DateTimeFormat("en-US", { ...opt, timeZone: "UTC" }).format(when);
    }
  };
  const day = { weekday: "long", month: "long", day: "numeric" };
  if (fmt({ year: "numeric" }) !== String(new Date().getFullYear())) day.year = "numeric";
  return fmt(day) + " · " + fmt({ hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

// Fonts and the brand photo come off the ASSETS binding once per isolate. The
// SPA fallback answers missing paths with index.html, so an HTML content type
// here means a file is gone from public/ — fail loudly, not with a blank card.
let cardAssets = null;
async function loadCardAssets(env) {
  const grab = async (p) => {
    const r = await env.ASSETS.fetch("https://assets.local" + p);
    if (!r.ok || (r.headers.get("Content-Type") || "").includes("text/html"))
      throw new Error("share-card asset missing: " + p);
    return await r.arrayBuffer();
  };
  const [mont, mono, photo] = await Promise.all([
    grab("/brand/fonts/og/montserrat-800.ttf"),
    grab("/brand/fonts/og/dm-mono-500.ttf"),
    grab("/brand/social-1200.jpg"),
  ]);
  return {
    fonts: [
      { name: "Montserrat", data: mont, weight: 800, style: "normal" },
      { name: "DM Mono", data: mono, weight: 500, style: "normal" },
    ],
    photo: "data:image/jpeg;base64," + b64(photo),
  };
}

// The card fonts are subset to Latin + common punctuation; anything outside
// that set would render as a hole, so it is dropped from the card text.
const cardText = (s) =>
  s.replace(/[^\x20-\x7E -ſ–—‘’“”•…·€™]/g, "").trim();

// The 1200x630 card as raw RGBA — the JPEG and the video both start here.
async function cardPixels(env, room) {
  if (!cardAssets) cardAssets = loadCardAssets(env).catch((e) => ((cardAssets = null), Promise.reject(e)));
  const assets = await cardAssets;

  const title = cardText(room.title || "Meeting") || "Meeting";
  const size = title.length <= 24 ? 78 : title.length <= 48 ? 62 : title.length <= 76 ? 52 : 44;
  const when = room.when ? formatWhen(room.when, room.tz) : "";

  const html = `
  <div style="display:flex;flex-direction:column;width:1200px;height:630px;position:relative;font-family:Montserrat;background:linear-gradient(145deg,#06142e 0%,#0c2450 38%,#123b79 68%,#0e4d87 100%)">
    <div style="display:flex;position:absolute;top:-320px;left:280px;width:760px;height:640px;background:radial-gradient(circle,rgba(80,64,198,0.55) 0%,rgba(80,64,198,0) 65%)"></div>
    <div style="display:flex;flex-direction:column;justify-content:center;flex-grow:1;padding:0 64px">
      <div style="display:flex;font-family:'DM Mono';font-size:21px;font-weight:500;letter-spacing:3px;color:#dffcff">DOWN2CHILL MEET - YOU'RE INVITED</div>
      <div style="display:flex;margin-top:26px;font-size:${size}px;font-weight:800;line-height:1.05;letter-spacing:${-Math.round(size / 28)}px;color:#ffffff">${esc(title)}</div>
      ${when ? `
      <div style="display:flex;align-items:center;margin-top:30px">
        <div style="display:flex;width:7px;height:38px;border-radius:4px;background:#dffcff"></div>
        <div style="display:flex;margin-left:20px;font-family:'DM Mono';font-size:28px;font-weight:500;color:rgba(255,255,255,0.94)">${esc(when)}</div>
      </div>` : ""}
    </div>
    <div style="display:flex;position:relative;width:1200px;height:230px;overflow:hidden;border-top:1px solid rgba(255,255,255,0.16)">
      <img src="${assets.photo}" width="1200" height="630" style="position:absolute;top:-235px;left:0;width:1200px;height:630px" />
      <div style="display:flex;position:absolute;top:0;left:0;width:1200px;height:110px;background:linear-gradient(180deg,rgba(10,29,62,0.9) 0%,rgba(10,29,62,0) 100%)"></div>
      <div style="display:flex;position:absolute;right:36px;bottom:26px;padding:10px 22px;border:1px solid rgba(255,255,255,0.18);border-radius:999px;background:rgba(6,20,46,0.72);font-family:'DM Mono';font-size:19px;font-weight:500;color:rgba(255,255,255,0.9)">meet.down2chill.com</div>
    </div>
  </div>`;

  const img = new ImageResponse(html, { width: 1200, height: 630, fonts: assets.fonts });
  // resvg only speaks PNG; hand back its pixels for the JPEG or video encoder.
  const png = UPNG.decode(await img.arrayBuffer());
  return { rgba: new Uint8Array(UPNG.toRGBA8(png)[0]), w: png.width, h: png.height };
}

// A day for crawlers; immutable is honest because edits change the URL. The
// buffered bodies also give crawlers a Content-Length.
const CARD_HEADERS = {
  "Cache-Control": "public, max-age=86400, immutable",
  "X-Robots-Tag": "noindex",
};

async function renderCard(env, room) {
  const { rgba, w, h } = await cardPixels(env, room);
  const out = jpeg.encode({ data: rgba, width: w, height: h }, CARD_JPEG_Q).data;
  return new Response(out, { headers: { "Content-Type": "image/jpeg", ...CARD_HEADERS } });
}

// The video card: VID.frames of the card pixels with three scripted effects —
// a seamless slow zoom, one diagonal light sweep per loop, and hovering bokeh
// lights — encoded as baseline H.264. Costs a couple of CPU-seconds once per
// meeting per edge, then lives in the cache exactly like the JPEG.
async function renderVideo(env, room) {
  const { rgba: src, w: sw, h: sh } = await cardPixels(env, room);
  const enc = await hme.createH264MP4Encoder();
  enc.width = VID.w;
  enc.height = VID.h;
  enc.frameRate = VID.fps;
  enc.quantizationParameter = VID.qp;
  enc.speed = 8;
  enc.groupOfPictures = 24;
  enc.initialize();

  const frame = new Uint8Array(VID.w * VID.h * 4);
  for (let i = 0; i < VID.frames; i++) {
    composeFrame(frame, src, sw, sh, i / VID.frames);
    enc.addFrameRgba(frame);
  }
  enc.finalize();
  const mp4 = faststart(enc.FS.readFile(enc.outputFilename));
  enc.delete();
  return new Response(mp4, { headers: { "Content-Type": "video/mp4", ...CARD_HEADERS } });
}

// minih264 writes the moov index after mdat; preview thumbnailers (Telegram's
// included) and seeking need it up front. Move it behind ftyp and shift the
// chunk-offset tables to match.
function faststart(mp4) {
  const dv = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
  const boxes = [];
  for (let o = 0; o + 8 <= mp4.length; ) {
    const size = dv.getUint32(o);
    if (size < 8 || o + size > mp4.length) return mp4; // malformed; leave it
    boxes.push({ o, size, t: String.fromCharCode(mp4[o + 4], mp4[o + 5], mp4[o + 6], mp4[o + 7]) });
    o += size;
  }
  const ftyp = boxes[0];
  const moov = boxes.find((b) => b.t === "moov");
  const mdat = boxes.find((b) => b.t === "mdat");
  if (!ftyp || ftyp.t !== "ftyp" || !moov || !mdat || moov.o < mdat.o) return mp4;

  const out = new Uint8Array(mp4.length);
  out.set(mp4.subarray(0, ftyp.size), 0);
  out.set(mp4.subarray(moov.o, moov.o + moov.size), ftyp.size);
  let w = ftyp.size + moov.size;
  for (const b of boxes) {
    if (b === ftyp || b === moov) continue;
    out.set(mp4.subarray(b.o, b.o + b.size), w);
    w += b.size;
  }
  // Chunk offsets are absolute positions inside mdat, which moved right by
  // exactly moov.size — moov sat behind it and now sits in front.
  patchChunkOffsets(out, ftyp.size, moov.size, moov.size);
  return out;
}

function patchChunkOffsets(buf, at, size, delta) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
  const walk = (o, end) => {
    while (o + 8 <= end) {
      const s = dv.getUint32(o);
      if (s < 8) return;
      const t = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
      if (containers.has(t)) walk(o + 8, o + s);
      else if (t === "stco")
        for (let n = dv.getUint32(o + 12), i = 0; i < n; i++)
          dv.setUint32(o + 16 + i * 4, dv.getUint32(o + 16 + i * 4) + delta);
      else if (t === "co64")
        for (let n = dv.getUint32(o + 12), i = 0; i < n; i++)
          dv.setBigUint64(o + 16 + i * 8, dv.getBigUint64(o + 16 + i * 8) + BigInt(delta));
      o += s;
    }
  };
  walk(at + 8, at + size);
}

// Every effect below is periodic in t ∈ [0,1), so the clip loops seamlessly.
function composeFrame(dst, src, sw, sh, t) {
  const W = VID.w, H = VID.h;
  const wave = (1 - Math.cos(2 * Math.PI * t)) / 2; // 0 → 1 → 0
  const s = 1 + 0.05 * wave;
  const cx = sw * (0.5 + 0.012 * Math.sin(2 * Math.PI * t));
  const winW = sw / s, winH = sh / s;
  const x0 = cx - winW / 2, y0 = (sh - winH) / 2;
  const stepX = winW / W, stepY = winH / H;

  // Base layer: bilinear sample of the zoom window (column map precomputed).
  const ix = new Int32Array(W), fx = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const v = Math.min(Math.max(x0 + (x + 0.5) * stepX - 0.5, 0), sw - 1.001);
    ix[x] = v | 0;
    fx[x] = v - ix[x];
  }
  for (let y = 0; y < H; y++) {
    const v = Math.min(Math.max(y0 + (y + 0.5) * stepY - 0.5, 0), sh - 1.001);
    const iy = v | 0, fy = v - iy;
    const r0 = iy * sw, r1 = r0 + sw;
    for (let x = 0; x < W; x++) {
      const a = (r0 + ix[x]) * 4, b = (r1 + ix[x]) * 4, gx = fx[x];
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[a + c] + (src[a + 4 + c] - src[a + c]) * gx;
        const bot = src[b + c] + (src[b + 4 + c] - src[b + c]) * gx;
        dst[o + c] = top + (bot - top) * fy;
      }
      dst[o + 3] = 255;
    }
  }
  sheen(dst, t);
  bokeh(dst, t);
}

// One soft diagonal highlight sweeping across per loop, off-screen at t=0 and
// t=1 so the loop point is invisible.
function sheen(dst, t) {
  const W = VID.w, H = VID.h;
  const bh = 0.13;
  const pos = -0.25 + 1.5 * t;
  const inv = 1 / (W + 0.55 * H);
  for (let y = 0; y < H; y++) {
    let d = 0.55 * y * inv - pos;
    for (let x = 0; x < W; x++, d += inv) {
      if (d < -bh || d > bh) continue;
      const k = 1 - (d * d) / (bh * bh);
      const add = 70 * k * k;
      const o = (y * W + x) * 4;
      dst[o] = Math.min(255, dst[o] + add);
      dst[o + 1] = Math.min(255, dst[o + 1] + add);
      dst[o + 2] = Math.min(255, dst[o + 2] + add);
    }
  }
}

// Soft glow disc, built once; quartic falloff so there is no hard rim.
const SPRITE_R = 26;
const SPRITE = (() => {
  const d = SPRITE_R * 2, s = new Uint8Array(d * d);
  for (let y = 0; y < d; y++)
    for (let x = 0; x < d; x++) {
      const q = 1 - ((x - SPRITE_R) ** 2 + (y - SPRITE_R) ** 2) / (SPRITE_R * SPRITE_R);
      if (q > 0) s[y * d + x] = 255 * q * q;
    }
  return s;
})();

// Accent-tinted lights hovering over the photo band, drifting on small
// circles and pulsing — string-light bokeh to match the brand photo.
const DOTS = [
  { x: 0.14, y: 0.72, ph: 0.1, k: 0.9 },
  { x: 0.38, y: 0.86, ph: 0.55, k: 0.6 },
  { x: 0.63, y: 0.68, ph: 0.3, k: 0.75 },
  { x: 0.87, y: 0.8, ph: 0.8, k: 0.5 },
];
function bokeh(dst, t) {
  const W = VID.w, H = VID.h, d = SPRITE_R * 2;
  for (const dot of DOTS) {
    const ang = 2 * Math.PI * (t + dot.ph);
    const cxp = (dot.x * W + 10 * Math.cos(ang)) | 0;
    const cyp = (dot.y * H + 6 * Math.sin(ang)) | 0;
    const g = dot.k * (0.35 + 0.3 * Math.sin(ang));
    if (g <= 0) continue;
    for (let sy = 0; sy < d; sy++) {
      const py = cyp - SPRITE_R + sy;
      if (py < 0 || py >= H) continue;
      for (let sx = 0; sx < d; sx++) {
        const a = SPRITE[sy * d + sx] * g;
        if (!a) continue;
        const px = cxp - SPRITE_R + sx;
        if (px < 0 || px >= W) continue;
        const o = (py * W + px) * 4;
        dst[o] = Math.min(255, dst[o] + a * 0.85);
        dst[o + 1] = Math.min(255, dst[o + 1] + a * 0.99);
        dst[o + 2] = Math.min(255, dst[o + 2] + a);
      }
    }
  }
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};

/* ---------------------------- helpers ---------------------------- */

// Writing a room always refreshes the listing metadata and keeps whatever is
// left of the original 30 days, so editing a meeting does not extend its life.
function putRoom(env, code, record) {
  const now = Math.floor(Date.now() / 1000);
  const remaining = record.exp ? record.exp - now : ROOM_TTL;
  const ttl = Math.max(60, Math.min(remaining, ROOM_TTL));
  record.exp = now + ttl; // keep the record honest about its own expiry

  return env.ROOMS.put("room:" + code, JSON.stringify(record), {
    expirationTtl: ttl,
    metadata: {
      t: record.title || "Meeting",
      c: record.createdAt || null,
      p: record.pwHash || record.password ? 1 : 0,
      m: record.meetingId || null,
      l: record.lastUsedAt || null,
      w: record.when || null,
    },
  });
}

// The one write that extends a record's life. Rate-limited to once a day per
// room so a popular meeting does not turn every join into a KV write.
async function touchRoom(env, code, room) {
  const now = Math.floor(Date.now() / 1000);
  if (room.lastUsedAt && now - room.lastUsedAt < TOUCH_MIN_INTERVAL) return;
  room.lastUsedAt = now;
  room.exp = now + ROOM_TTL;
  try {
    await env.ROOMS.put("room:" + code, JSON.stringify(room), {
      expirationTtl: ROOM_TTL,
      metadata: {
        t: room.title || "Meeting",
        c: room.createdAt || null,
        p: room.pwHash || room.password ? 1 : 0,
        m: room.meetingId || null,
        l: room.lastUsedAt,
        w: room.when || null,
      },
    });
  } catch (err) {
    console.error("touch failed", code, err);
  }
}

/* --------------------- Cloudflare-side meeting state --------------------- */

// Every ACTIVE meeting Cloudflare has for this app, a page at a time.
async function rtkActiveMeetings(env) {
  const meetings = [];
  const maxPages = Math.ceil(LIST_LIMIT / RTK_PAGE);
  for (let page = 1; page <= maxPages; page++) {
    const r = await cfApi(env, "/meetings?status=ACTIVE&per_page=" + RTK_PAGE + "&page_no=" + page);
    const data = r.ok && r.body && Array.isArray(r.body.data) ? r.body.data : null;
    if (!data) {
      console.error("meeting list failed", r.status, JSON.stringify(r.body));
      return { ok: false, meetings };
    }
    for (const m of data) if (m && m.id && (m.status || "ACTIVE") === "ACTIVE") meetings.push(m);
    const total = r.body.paging && r.body.paging.total_count;
    if (data.length < RTK_PAGE || (total && meetings.length >= total)) break;
  }
  return { ok: true, meetings };
}

async function deactivateMeeting(env, meetingId) {
  const r = await cfApi(env, "/meetings/" + encodeURIComponent(meetingId), "PATCH", { status: "INACTIVE" });
  if (!r.ok) console.error("deactivate failed", meetingId, r.status, JSON.stringify(r.body));
  return r;
}

// Our records, from the list index alone wherever possible. Rooms written
// before meetingId went into the metadata are opened to read it, up to a cap;
// `complete` is false if any could not be, or if there were more than we list.
async function kvRooms(env) {
  const listed = await env.ROOMS.list({ prefix: "room:", limit: LIST_LIMIT });
  const rooms = [];
  const legacy = [];

  for (const k of listed.keys) {
    const code = k.name.slice(5);
    if (!CODE_RE.test(code)) continue;
    const m = k.metadata;
    if (m && m.t !== undefined && m.m !== undefined) {
      rooms.push({
        code,
        meetingId: m.m,
        title: m.t,
        when: m.w || null,
        createdAt: m.c || null,
        lastUsedAt: m.l || null,
        hasPassword: !!m.p,
        expiresAt: k.expiration || null,
      });
    } else {
      legacy.push({ code, name: k.name, expiresAt: k.expiration || null });
    }
  }

  const head = legacy.slice(0, LEGACY_LOOKUP_CAP);
  const rows = await Promise.all(
    head.map((l) => env.ROOMS.get(l.name, { type: "json", cacheTtl: KV_CACHE_TTL }))
  );
  head.forEach((l, i) => {
    const r = rows[i];
    if (!r) return; // listed but already gone: the index lags a delete
    rooms.push({
      code: l.code,
      meetingId: r.meetingId || null,
      title: r.title || "(untitled)",
      when: r.when || null,
      createdAt: r.createdAt || null,
      lastUsedAt: r.lastUsedAt || null,
      hasPassword: !!(r.pwHash || r.password),
      expiresAt: l.expiresAt,
    });
  });

  return { rooms, complete: listed.list_complete && legacy.length <= LEGACY_LOOKUP_CAP };
}

// The cron. Deactivates whatever is ACTIVE on Cloudflare and has no record
// here. Refuses to act unless our side is complete: with rooms it could not
// read, "no record" would not mean anything.
async function sweepOrphans(env) {
  const [kv, rtk] = await Promise.all([kvRooms(env), rtkActiveMeetings(env)]);
  if (!rtk.ok || !kv.complete) {
    console.error("sweep skipped", { rtkOk: rtk.ok, kvComplete: kv.complete });
    return;
  }
  const ours = new Set(kv.rooms.map((r) => r.meetingId).filter(Boolean));
  const now = Date.now();
  let off = 0;
  for (const m of rtk.meetings) {
    if (ours.has(m.id)) continue;
    const age = now - (Date.parse(m.created_at || 0) || 0);
    if (age < FRESH_GRACE_MS) continue;
    const r = await deactivateMeeting(env, m.id);
    if (r.ok || r.status === 404) off++;
  }
  console.log("sweep", { active: rtk.meetings.length, ours: ours.size, deactivated: off });
}

function links(url, code, hostKey) {
  const base = url.origin + "/j/" + code;
  const out = { guestLink: base };
  // The host key lives in the fragment: browsers never put it in a request,
  // a Referer header, or a server log.
  if (hostKey) out.hostLink = base + "#host=" + hostKey;
  return out;
}

const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "unknown";

const cookie = (token, maxAge) =>
  COOKIE +
  "=" +
  token +
  "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=" +
  maxAge;

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

// Rate limit bindings are optional: without them the Worker still runs, it
// just loses the abuse ceiling.
async function limited(binding, key) {
  if (!binding) return false;
  try {
    const { success } = await binding.limit({ key });
    return !success;
  } catch (err) {
    console.error("rate limit check failed", err);
    return false;
  }
}

async function readJson(request) {
  const len = request.headers.get("content-length");
  if (len && Number(len) > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch (err) {
    return null;
  }
}

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

// Display strings reach the meeting UI and the Cloudflare API. Strip control
// characters so they cannot smuggle line breaks into either.
const clean = (v, max) =>
  [...str(v, max)]
    .filter((c) => {
      const n = c.charCodeAt(0);
      return n > 31 && n !== 127; // drop C0 controls and DEL
    })
    .join("")
    .trim();

async function cfApi(env, path, method = "GET", body) {
  const headers = { Authorization: "Bearer " + env.RTK_API_TOKEN };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(
    CF_API + "/" + env.CF_ACCOUNT_ID + "/realtime/kit/" + env.RTK_APP_ID + path,
    {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    }
  );

  let parsed = null;
  try {
    parsed = await res.json();
  } catch (err) {
    /* upstream returned no JSON */
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function passwordOk(room, password) {
  if (room.pwHash)
    return safeEqual(room.pwHash, await sha256((room.pwSalt || "") + password));
  if (room.password) return safeEqual(room.password, password); // pre-hash records
  return true;
}

async function hostKeyOk(room, hostKey) {
  if (room.hostKeyHash) return safeEqual(room.hostKeyHash, await sha256(hostKey));
  if (room.hostKey) return safeEqual(room.hostKey, hostKey); // pre-hash records
  return false;
}

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return hex(new Uint8Array(d));
}

const hex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(a), enc.encode(b));
}

const rand = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => ALPHA[b % ALPHA.length])
    .join("");

const notAllowed = () => json({ error: "Method not allowed" }, 405);

const json = (o, status = 200, extra) =>
  new Response(JSON.stringify(o), {
    status,
    headers: {
      "content-type": "application/json",
      // Auth tokens must never sit in a shared cache.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(extra || {}),
    },
  });
