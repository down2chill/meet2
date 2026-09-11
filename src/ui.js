/* Shared brand, the meeting theme and the one fetch wrapper every page uses.
   Everything visual lives in theme.css; this file only names the pieces. */

/* ---------- CHANGE THESE ---------- */
export const COMPANY = "Down2Chill";
export const SITE = "https://down2chill.com";
/* --------------------------------- */

// The palette the whole app is drawn from: the marketing site's pale-cyan
// accent over its deep-navy gradient.
export const ACCENT = "#dffcff";

// Design tokens for the RealtimeKit meeting UI, so the call itself looks like
// the rest of the site rather than the SDK default grey. The SDK writes these
// out as --rtk-* custom properties on <html> when the meeting mounts.
//
// theme:"dark" is applied first and then overridden by colors, so anything we
// leave out still lands on a sensible dark value.
export const MEETING_TOKENS = {
  theme: "dark",
  fontFamily: "Montserrat, ui-sans-serif, system-ui, sans-serif",
  borderRadius: "extra-rounded",
  borderWidth: "thin",
  spacingBase: 4,
  logo: "/brand/down2chill_light.svg",
  colors: {
    // Deepest first: 1000 is the app background, 600 the raised surfaces.
    background: {
      1000: "#050f24",
      900: "#0a1a38",
      800: "#0f2447",
      700: "#183157",
      600: "#22406b",
    },
    "video-bg": "#081428",
    text: "#ffffff",
    "text-on-brand": "#ffffff",
    brand: {
      300: "#b3a7ff",
      400: "#8f80f7",
      500: "#6c5ce7",
      600: "#5646c9",
      700: "#3f33a3",
    },
    danger: "#ff5c86",
    success: "#3fd8b1",
    warning: "#ffd66e",
  },
};

// The meeting code out of /j/<code>. Both the join flow and the device panel
// need it, and neither should be parsing the URL itself.
export function meetingCode() {
  const parts = location.pathname.split("/");
  return parts[parts.indexOf("j") + 1] || "";
}

// Reloading is the one thing that reliably brings a device prompt back: it
// re-runs the whole media warm-up from scratch. The cost is landing on the
// setup screen again, which this flag removes -- the reloaded page drops
// straight back into the meeting.
//
// sessionStorage, and read exactly once: a link opened fresh, or reloaded by
// hand later, must still get the setup screen. Only the reload we ourselves
// asked for skips it.
const REJOIN_KEY = "meet:rejoin";
const REJOIN_TTL = 60000;

export function markRejoin(code) {
  try {
    sessionStorage.setItem(REJOIN_KEY, JSON.stringify({ code, at: Date.now() }));
  } catch (e) {
    /* private mode: they get the setup screen, which is only a click */
  }
}

export function consumeRejoin(code) {
  try {
    const v = JSON.parse(sessionStorage.getItem(REJOIN_KEY) || "null");
    sessionStorage.removeItem(REJOIN_KEY);
    return !!v && v.code === code && Date.now() - v.at < REJOIN_TTL;
  } catch (e) {
    return false;
  }
}

export function reloadForDevices(code) {
  markRejoin(code);
  location.reload();
}

// Ask the browser directly what the permission actually is, rather than
// inferring it from whichever event the SDK happened to fire.
//
// Returns "granted" | "prompt" | "denied", or null where the browser will not
// say -- Firefox does not support camera/microphone in permissions.query and
// throws, so that path has to fall back to the SDK's own reading.
//
// "denied" is the one that matters: it is the end of the road for the page.
// getUserMedia will reject without ever showing a prompt, and there is no API
// that undoes it. permissions.revoke() was removed from browsers years ago,
// clearing site storage does not touch permissions, and reloading re-runs the
// same rejection. Only the person can change it, in browser settings.
export async function probePermission(kind) {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return null;
    const name = kind === "audio" ? "microphone" : "camera";
    const status = await navigator.permissions.query({ name });
    return status && status.state ? status.state : null;
  } catch (e) {
    return null;
  }
}

// What a click inside the meeting UI was aimed at, read off its composed path
// so it sees through the SDK's shadow roots. Two things are worth knowing:
//
// - a press on the SDK's own permissions dialog's Reload button. That is a
//   plain location.reload() we get no say in, and it should land back in the
//   meeting rather than on the setup screen.
// - a press on the camera or microphone toggle. A permission failure right
//   after one of those is the person asking for the device and being refused,
//   which is the only time a dialog about it is warranted.
//
// `reloadLabel` is the SDK's own text for that button; the dialog has a
// Continue button beside it that must not count.
export function classifyClick(path, reloadLabel) {
  let inPermissions = false;
  let reload = false;
  let toggle = null;
  for (const el of path) {
    const tag = el && el.tagName;
    if (!tag) continue;
    if (tag === "RTK-PERMISSIONS-MESSAGE") inPermissions = true;
    else if (tag === "RTK-BUTTON" && (el.textContent || "").trim() === reloadLabel) reload = true;
    else if (tag === "RTK-CAMERA-TOGGLE") toggle = "video";
    else if (tag === "RTK-MIC-TOGGLE") toggle = "audio";
  }
  return { reload: inPermissions && reload, toggle };
}

// querySelector that descends into every open shadow root. The SDK's UI is
// nested shadow roots several deep (rtk-meeting > ... > rtk-participants-audio),
// none of which document.querySelector can see into.
export function deepQuery(selector, root) {
  root = root || document;
  const hit = root.querySelector(selector);
  if (hit) return hit;
  const all = root.querySelectorAll("*");
  for (const el of all) {
    if (el.shadowRoot) {
      const found = deepQuery(selector, el.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

// The SDK's "allow audio playback" dialog lives inside rtk-participants-audio's
// open shadow root, with its one button as a light child of the rtk-dialog it
// renders. Outer stylesheets cannot reach in there, but a <style> appended to
// the root can. Stencil patches only the nodes it rendered itself, so a foreign
// style node survives its re-renders.
const AUDIO_HIDE_ID = "meet-hide-audio-dialog";

export function hideAudioDialog() {
  const host = deepQuery("rtk-participants-audio");
  const root = host && host.shadowRoot;
  if (!root) return false;
  if (!root.getElementById(AUDIO_HIDE_ID)) {
    const style = document.createElement("style");
    style.id = AUDIO_HIDE_ID;
    style.textContent = "rtk-dialog{display:none !important}";
    root.appendChild(style);
  }
  return true;
}

// Presses that dialog's button, whose handler is the play() call the browser
// will only honour from inside a user gesture. Returns whether there was one.
export function pressAudioDialog() {
  const host = deepQuery("rtk-participants-audio");
  const root = host && host.shadowRoot;
  const btn = root && root.querySelector("rtk-dialog rtk-button");
  if (!btn) return false;
  btn.click();
  return true;
}

// The virtual backgrounds offered in the meeting, alongside blur. They are
// ours, in public/brand/backgrounds, rendered from the same gradient the rest
// of the app uses. Drop more files in that folder and list them here.
export const BACKGROUNDS = [
  "/brand/backgrounds/aurora.jpg",
  "/brand/backgrounds/dusk.jpg",
  "/brand/backgrounds/violet.jpg",
  "/brand/backgrounds/midnight.jpg",
];

// Whichever background someone picks is remembered on this device, so they do
// not have to set it again every meeting. "none" is worth storing too: it is
// how we know they deliberately turned an effect off.
const BG_KEY = "meet:bg";

export function saveBackground({ backgroundMode, backgroundURL }) {
  try {
    localStorage.setItem(
      BG_KEY,
      JSON.stringify({ mode: backgroundMode || "none", url: backgroundURL || "" })
    );
  } catch (e) {
    /* private mode */
  }
}

export function loadBackground() {
  try {
    const v = JSON.parse(localStorage.getItem(BG_KEY) || "null");
    if (!v || v.mode === "none") return null;
    if (v.mode === "blur") return v;
    // A virtual background whose file we no longer ship would fail to apply.
    return v.mode === "virtual" && BACKGROUNDS.indexOf(v.url) !== -1 ? v : null;
  } catch (e) {
    return null;
  }
}

// A pre-filter, not the gate. The addon runs the SDK's own isSupported() inside
// register() and adds no button when it fails, so a stale copy of the rule here
// can never produce a button that does not work -- at worst it downloads 85 kB
// for nothing, or skips the download on a browser that would have coped.
//
// The SDK's rule: the segmentation pipeline needs a WebGL context, and iOS is
// ruled out entirely along with Safari before 17. Reimplemented rather than
// imported because importing the transformer package for one static method
// would ship a second 130 kB copy of code the addon already bundles.
export function backgroundEffectsSupported() {
  try {
    const ua = navigator.userAgent;
    const iOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS
    if (iOS) return false;
    if (/^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua)) {
      const v = parseInt((ua.match(/version\/(\d+)/i) || [])[1] || "0", 10);
      if (v < 17) return false;
    }
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch (e) {
    return false;
  }
}

// Same alphabet the Worker generates codes from: no i, l or o, so a code can
// be read down a phone line without ambiguity.
export const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
export const CODE_RE = new RegExp("^[" + ALPHA + "]{8}$");

// Accepts a bare code or a pasted invite link.
export function extractCode(raw) {
  const s = String(raw || "").trim();
  const inLink = s.match(/\/j\/([a-z0-9]{8})/i);
  return (inLink ? inLink[1] : s).toLowerCase().replace(/[\s-]/g, "");
}

export async function api(path, opts) {
  const { method = "GET", body } = opts || {};
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  // The Worker requires this on every write. A cross-site form post cannot
  // set it, which is what makes CSRF a non-issue here.
  if (method !== "GET") headers["X-CSRF"] = "1";

  const r = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });

  let data = null;
  try {
    data = await r.json();
  } catch (e) {
    /* non-JSON error page */
  }
  return { status: r.status, ok: r.ok, body: data || {} };
}

export function when(ts) {
  if (!ts) return "unknown";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// A scheduled session needs the time of day, not just the date.
export function whenAt(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// <input type="datetime-local"> speaks "YYYY-MM-DDTHH:mm" in local time.
export function toLocalInput(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

// The zone rides along with a schedule so the share card can print the
// session's own local time wherever it is rendered.
export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// A record lives 30 days past the last join, so this reads as an idle clock:
// it resets every time someone gets in.
export function expiresIn(unixSeconds) {
  if (!unixSeconds) return "";
  const days = Math.round((unixSeconds * 1000 - Date.now()) / 86400000);
  if (days <= 0) return "switches off today if unused";
  return "switches off in " + days + (days === 1 ? " day" : " days") + " if unused";
}
