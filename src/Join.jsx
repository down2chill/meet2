import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { useRealtimeKitClient } from "@cloudflare/realtimekit-react";
import {
  COMPANY,
  api,
  meetingCode,
  consumeRejoin,
  probePermission,
} from "./ui.js";
import { Shell, TopBar, Footer, Waiting, LockIcon, ArrowIcon } from "./chrome.jsx";

// The meeting and everything the SDK's UI kit drags in.
const Meeting = lazy(() => import("./Meeting.jsx"));

// The warm-up is one bare getUserMedia, made only so the browser shows its
// permission prompt for camera and microphone together, right away. The
// tracks it returns are stopped the moment they arrive; nothing is kept.
//
// It is deliberately NOT the SDK's own initRTKMedia. That runs setupStreams,
// which asks for both devices and, when that is refused, falls back to
// audio-only and then video-only -- three prompts in a row for someone who
// dismissed the first. A bare request has no fallback: refused means refused.
//
// The meeting is then always initialised with both devices OFF. Nobody's
// camera or microphone comes on until they press the toggle for it, and that
// toggle is what asks the browser again if it did not keep the first answer.
async function warmUpPermissions(log) {
  const [audioState, videoState] = await Promise.all([
    probePermission("audio"),
    probePermission("video"),
  ]);
  // Never ask for a device the browser has already blocked: it only rejects.
  const audio = audioState !== "denied";
  const video = videoState !== "denied";
  if (!audio && !video) {
    log("camera and microphone both blocked, no warm-up");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio, video });
  } catch (e) {
    // No camera on this machine: the microphone alone is still worth asking
    // for, once. Anything else -- refused, dismissed, busy -- ends here.
    if (audio && video && e && (e.name === "NotFoundError" || e.name === "OverconstrainedError")) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e2) {
        log("warm-up refused:", e2 && e2.name);
        return;
      }
    } else {
      log("warm-up refused:", e && e.name);
      return;
    }
  }
  stream.getTracks().forEach((t) => t.stop());
  log("permissions warmed up");
}

// tracing:false stops the SDK shipping OpenTelemetry logs. That endpoint sends
// CORS headers Firefox complains about, once every few seconds, for telemetry
// we never look at. devTools.logs:false keeps its internal logger off the
// console too.
const SDK_MODULES = {
  tracing: false,
  devTools: { logs: false, logLevel: "off" },
};

// Timing and diagnostics only when asked for: add ?debug=1 to the URL.
const DEBUG = new URLSearchParams(location.search).has("debug");
const log = (...a) => {
  if (DEBUG) console.log(...a);
};

const NAME_KEY = "meet:name";
const savedName = () => {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch (e) {
    return "";
  }
};
const rememberName = (n) => {
  try {
    if (n) localStorage.setItem(NAME_KEY, n);
  } catch (e) {
    /* private mode */
  }
};

const postJoin = (payload) => api("/api/join", { method: "POST", body: payload });

export default function Join() {
  const [, initMeeting] = useRealtimeKitClient();
  const [client, setClient] = useState(null);
  const [needsPw, setNeedsPw] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);

  const [slow, setSlow] = useState(false);

  const started = useRef(false);
  const clientRef = useRef(null);

  const code = meetingCode();

  // Read once, on the first render. If this load is the reload we asked for to
  // re-trigger a device prompt, the setup screen is skipped and the SDK joins
  // the moment it is ready.
  const skipSetup = useRef(null);
  if (skipSetup.current === null) skipSetup.current = consumeRejoin(code);
  // Newer host links carry the key in the fragment, which browsers never put
  // in a request or a Referer header. Older ?host= links still work.
  const hostKey =
    new URLSearchParams(location.hash.slice(1)).get("host") ||
    new URLSearchParams(location.search).get("host") ||
    "";

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in dev
    started.current = true;
    const t0 = performance.now();

    // The meeting UI is the largest chunk on the page. Start it immediately.
    const ui = import("./Meeting.jsx");

    // Fired now so the permission prompt appears while the token request is in
    // flight. Nothing ever blocks on this promise; it resolves to a media
    // handler we can hand the SDK, or to null.
    // Fired now so the one permission prompt appears while the token request
    // is in flight. Nothing waits on it.
    warmUpPermissions(log);

    // Cold DNS + TLS to the meeting edge can take a while, Safari especially.
    // After this long, say so, so a slow join does not read as a broken one.
    const slowTimer = setTimeout(() => setSlow(true), 6000);

    start("", ui, t0);
    return () => clearTimeout(slowTimer);
  }, []);

  async function start(password, uiPromise, t0) {
    setBusy(true);
    setErr("");

    if (!code) {
      setErr("No meeting code in the URL.");
      setBusy(false);
      return;
    }

    try {
      const d = await postJoin({ code, hostKey, name: savedName(), password });

      if (d.body.needsPassword) {
        setNeedsPw(true);
        if (password) setErr(d.body.error || "Incorrect password");
        setBusy(false);
        return;
      }
      if (d.status === 404) {
        setErr("That meeting link is not valid.");
        setBusy(false);
        return;
      }
      if (!d.body.authToken) {
        setErr(d.body.error || "Could not join this meeting.");
        setBusy(false);
        return;
      }

      // The password was right. Drop the gate now rather than when the whole
      // connect finishes: minting the token is the fast part, opening the
      // meeting socket is not, and on a cold connection that left the button
      // sitting on "Checking..." for long enough to look broken.
      setNeedsPw(false);

      const c = await connect(d.body.authToken, password);
      if (!c) return;

      if (uiPromise) await uiPromise;
      clientRef.current = c;

      // Whatever name they settle on in the setup screen is worth keeping, so
      // the next meeting starts with it filled in.
      try {
        c.self.on("roomJoined", () => rememberName(c.self.name));
      } catch (e) {
        /* older SDK without the event */
      }

      setClient(c);
      log("ready in", Math.round(performance.now() - (t0 || 0)), "ms");
    } catch (e) {
      setErr("Error: " + (e && e.message ? e.message : e));
      console.error(e);
      setBusy(false);
    }
  }

  async function connect(token, password) {
    // Both devices off, always. The SDK's init then touches no hardware and
    // shows no prompt of its own; the toggles do that, on demand.
    const opts = {
      authToken: token,
      defaults: { audio: false, video: false },
      modules: SDK_MODULES,
    };

    let c = await initMeeting(opts).catch((e) => {
      log("init failed:", e && e.message);
      return null;
    });

    // A token can go stale while someone sits on a permission prompt, and a
    // stale one fails at init. Mint a fresh one and try once more before
    // showing an error.
    if (!c) {
      log("retrying with a fresh token");
      const again = await postJoin({ code, hostKey, name: savedName(), password });
      if (again.body.authToken)
        c = await initMeeting({ ...opts, authToken: again.body.authToken }).catch(
          () => null
        );
    }

    if (!c) {
      setErr("Could not connect to the meeting. Reload to try again.");
      setBusy(false);
      return null;
    }

    return c;
  }

  if (client)
    return (
      <Suspense fallback={<Waiting text="Opening the room..." />}>
        <Meeting client={client} skipSetup={skipSetup.current} />
      </Suspense>
    );

  if (needsPw)
    return (
      <Shell center bar={<TopBar />}>
        <div className="narrow">
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              <LockIcon style={{ verticalAlign: "-1px", marginRight: 6 }} />
              Locked room
            </div>
            <div className="card-title" style={{ fontSize: 22, marginBottom: 6 }}>
              This meeting has a password
            </div>
            <p className="muted" style={{ marginBottom: 18 }}>
              Ask the host for it if you do not have one.
            </p>

            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) start(pw);
              }}
            >
              <label className="field-label" htmlFor="pw">
                Meeting password
              </label>
              <input
                id="pw"
                className="field"
                type="password"
                placeholder="Meeting password"
                autoComplete="off"
                autoFocus
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Checking..." : "Continue"}
                {busy ? null : <ArrowIcon />}
              </button>
            </form>

            <div className="err" style={{ marginTop: 14 }}>
              {err}
            </div>
          </div>
          <Footer />
        </div>
      </Shell>
    );

  // Connecting, or connecting went wrong. Same card either way.
  return (
    <Shell center bar={<TopBar />}>
      <div className="narrow">
        <div className="card" style={{ textAlign: "center" }}>
          {err ? (
            <>
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                {COMPANY} Meet
              </div>
              <div className="card-title" style={{ fontSize: 20, marginBottom: 10 }}>
                We could not open that room
              </div>
              <div className="err">{err}</div>
              <a className="btn btn-ghost" href="/" style={{ marginTop: 20 }}>
                Try another code
              </a>
            </>
          ) : (
            <>
              <div className="spinner" />
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                {COMPANY} Meet
              </div>
              <div className="muted">
                {skipSetup.current
                  ? "Taking you straight back into the room..."
                  : "Connecting you to the room..."}
              </div>
              {slow && (
                <div className="hint" style={{ marginTop: 10 }}>
                  Still going. The first connection from a browser is the slow
                  one; the next will be quicker.
                </div>
              )}
            </>
          )}
        </div>
        <Footer />
      </div>
    </Shell>
  );
}
