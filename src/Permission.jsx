/* What to show when the camera or microphone did not start.

   The whole design turns on one fact that is easy to wish away: once a browser
   has been told to block a device, THE PAGE CANNOT BRING THE PROMPT BACK.
   getUserMedia rejects immediately without prompting; permissions.revoke() was
   removed from browsers years ago; clearing localStorage, cookies or the whole
   origin's storage does not touch permissions, because they live in the browser
   profile and not in site storage; and reloading simply re-runs the same
   rejection. There is no button, here or anywhere, that undoes it. Only the
   person can, in their browser's own settings.

   So this panel does not offer a reload for that case. Offering one implies it
   might work, and watching it not work is worse than being told plainly.

   The recoverable case is different: a prompt that was closed or swiped away
   leaves the permission at "prompt", and asking again really does bring it
   back. Telling the two apart matters, so we ask the browser directly via
   permissions.query rather than trusting whichever event the SDK fired. */

import { useEffect, useState } from "react";
import { meetingCode, reloadForDevices, probePermission } from "./ui.js";

const KIND = {
  video: { label: "Camera", lower: "camera" },
  audio: { label: "Microphone", lower: "microphone" },
};

// Rough, and deliberately so: this only picks which sentence to show, and the
// fallback sentence is true everywhere.
function whereToLook(lower) {
  const ua = navigator.userAgent;
  const android = /Android/i.test(ua);

  if (/Firefox|FxiOS/i.test(ua))
    return android
      ? "Tap the padlock to the left of the address bar, open this site's permissions, clear the blocked " +
          lower +
          " entry, then reload."
      : "Click the padlock to the left of the address bar. The blocked " +
          lower +
          " is listed there with an x beside it — clear it, then reload.";

  if (/Edg\//i.test(ua))
    return (
      "Click the padlock at the left of the address bar, open Permissions for this site, and switch the " +
      lower +
      " to Allow."
    );

  if (/Chrome|CriOS/i.test(ua))
    return android
      ? "Tap the padlock to the left of the address bar, choose Permissions, and switch the " +
          lower +
          " to Allow."
      : "Click the padlock at the left of the address bar and switch the " +
          lower +
          " to Allow. If it is not listed there, open Site settings from the same menu.";

  if (/Safari/i.test(ua))
    return "Open Safari > Settings for This Website, and set the " + lower + " to Allow.";

  return "Open your browser's site settings for this page and switch the " + lower + " to Allow.";
}

function systemHint() {
  const ua = navigator.userAgent;
  if (/Mac OS X/i.test(ua))
    return "Open System Settings > Privacy & Security and give your browser access, then come back and press Try again.";
  if (/Windows/i.test(ua))
    return "Open Settings > Privacy & security and give your browser access, then come back and press Try again.";
  return "Give your browser access in your device's privacy settings, then come back and press Try again.";
}

export default function PermissionBlocked({ info, client, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // null until the browser answers: "granted" / "prompt" / "denied", or stays
  // null on browsers that will not say.
  const [real, setReal] = useState(null);

  const k = KIND[info.kind] || KIND.video;

  useEffect(() => {
    let live = true;
    probePermission(info.kind).then((state) => {
      if (live) setReal(state);
    });
    return () => {
      live = false;
    };
  }, [info.kind]);

  // The browser's own answer wins wherever we can get it; the SDK's reading is
  // only the fallback for browsers that will not say.
  const hardBlocked =
    real === "denied" || (real === null && info.state === "browser");
  const system = info.state === "system";
  const canPrompt =
    real === "prompt" || (real === null && info.state === "dismissed");

  async function enable() {
    if (info.kind === "audio") await client.self.enableAudio();
    else await client.self.enableVideo();
  }

  async function retry() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      // Works the moment the setting is changed, and never interrupts the
      // call: enableVideo/enableAudio acquire and publish on the running
      // meeting without touching the connection.
      await enable();
      onDismiss();
      return;
    } catch (e) {
      /* fall through */
    } finally {
      setBusy(false);
    }

    // Only worth reloading where a prompt is genuinely still available. When a
    // device is blocked, a reload lands in exactly the same place.
    if (canPrompt) reloadForDevices(meetingCode());
    else setFailed(true);
  }

  let title;
  let body;
  if (system) {
    title = "Your device is blocking the " + k.lower;
    body = systemHint();
  } else if (hardBlocked) {
    title = k.label + " is blocked for this site";
    body =
      "This one is not ours to fix. Once a browser has been told to block a device it stops asking, and no button on this page can bring the prompt back — not a reload, and not clearing site data. " +
      whereToLook(k.lower) +
      " Then press Try again.";
  } else if (canPrompt) {
    title = "The " + k.lower + " prompt was closed";
    body =
      "Nothing is blocked — your browser is still willing to ask. Press the button below and the prompt comes straight back.";
  } else {
    title = "The " + k.lower + " did not start";
    body =
      "Another app or browser tab may have hold of it. Close whatever else is using it, then try again.";
  }

  return (
    <div
      className="perm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={k.label + " unavailable"}
    >
      <div className="card narrow perm-card">
        <div className="eyebrow" style={{ marginBottom: 8 }}>
          {k.label}
        </div>
        <div className="card-title" style={{ fontSize: 20, marginBottom: 10 }}>
          {title}
        </div>

        <p className="muted" style={{ marginBottom: 14 }}>
          {body}
        </p>

        <div className="stack">
          <button className="btn" onClick={retry} disabled={busy}>
            {busy ? "Asking..." : canPrompt ? "Ask again" : "Try again"}
          </button>
          <button className="btn btn-ghost" onClick={onDismiss} disabled={busy}>
            Not now
          </button>
        </div>

        <div className="err" style={{ marginTop: 14 }}>
          {failed
            ? hardBlocked
              ? "Still blocked. The setting has to be changed in the browser first — nothing here can do it."
              : "Still no luck."
            : ""}
        </div>

        <div className="hint" style={{ marginTop: 6 }}>
          {hardBlocked
            ? "Changing it does not interrupt the call, and if a reload is needed you land straight back in the meeting."
            : "You stay in the meeting either way — this only turns on your own " +
              k.lower +
              "."}
        </div>
      </div>
    </div>
  );
}
