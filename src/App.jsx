import { useState, useEffect, lazy, Suspense } from "react";
import { COMPANY, CODE_RE, extractCode, api } from "./ui.js";
import {
  Shell,
  TopBar,
  Footer,
  Waiting,
  ArrowIcon,
} from "./chrome.jsx";

// Neither of these is needed to render the landing page, and the meeting SDK
// is by far the biggest thing we ship. Keeping both out of the entry chunk
// means /  and /new load a fraction of what they used to.
const Join = lazy(() => import("./Join.jsx"));
const Admin = lazy(() => import("./Admin.jsx"));

export default function App() {
  const path = location.pathname;

  if (path.startsWith("/j/"))
    return (
      <Suspense fallback={<Waiting text="Opening the room..." />}>
        <Join />
      </Suspense>
    );

  if (path === "/admin")
    return (
      <Suspense fallback={<Waiting text="Loading..." />}>
        <Admin />
      </Suspense>
    );

  return <Landing />;
}

function Landing() {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [authed, setAuthed] = useState(null); // null = still checking
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    // Costs nothing when there is no session cookie: the Worker answers
    // without touching KV.
    api("/api/session").then(
      (r) => setAuthed(!!r.body.authed),
      () => setAuthed(false)
    );
  }, []);

  function go(e) {
    if (e) e.preventDefault();
    const c = extractCode(code);
    if (!c) return setErr("Enter your meeting code.");
    if (!CODE_RE.test(c))
      return setErr(
        c.length === 8
          ? "That code has characters we do not use. Check for i, l, o, 0 or 1."
          : "Meeting codes are 8 characters."
      );
    location.href = "/j/" + c;
  }

  const bar = (
    <TopBar>
      {authed === true && (
        <a className="btn btn-link" href="/admin">
          Dashboard <ArrowIcon />
        </a>
      )}
      {authed === false && !showLogin && (
        <button className="btn btn-link" onClick={() => setShowLogin(true)}>
          Log in
        </button>
      )}
    </TopBar>
  );

  return (
    <Shell center bar={bar}>
      <div className="narrow">
        {showLogin ? (
          <LoginCard onCancel={() => setShowLogin(false)} />
        ) : (
          <>
            <div className="hero">
              <div className="hero-badge">
                <span className="dot" />
                <span className="eyebrow">{COMPANY} Meet</span>
              </div>
              <h1 className="hero-title display">
                Join the <span className="accent">room.</span>
              </h1>
              <p className="hero-sub">
                Put in the eight-character code from your invite and you are in.
              </p>
            </div>

            <div className="card card-brand">
              <form onSubmit={go} className="stack">
                <label className="field-label" htmlFor="code">
                  Meeting code
                </label>
                <input
                  id="code"
                  className="field field-code"
                  placeholder="abcd2345"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck="false"
                  maxLength={64}
                  autoFocus
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    if (err) setErr("");
                  }}
                />
                <button className="btn" type="submit">
                  Join meeting <ArrowIcon />
                </button>
              </form>

              <div className="err" style={{ marginTop: 14 }}>
                {err}
              </div>

              <div className="hint" style={{ marginTop: 6 }}>
                Got the whole invite link? Paste that instead.
              </div>
            </div>
          </>
        )}

        <Footer />
      </div>
    </Shell>
  );
}

function LoginCard({ onCancel }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api("/api/login", {
        method: "POST",
        body: { username, password },
      });
      if (!r.ok) {
        setErr(r.body.error || "Could not sign in.");
        setBusy(false);
        return;
      }
      location.href = "/admin";
    } catch (e2) {
      setErr("Network error. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="eyebrow" style={{ marginBottom: 6 }}>
        Host access
      </div>
      <div className="card-title" style={{ fontSize: 22, marginBottom: 18 }}>
        Sign in
      </div>

      <form onSubmit={submit} className="stack">
        <input
          className="field"
          placeholder="Username"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="field"
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
        <button className="btn btn-ghost" type="button" onClick={onCancel}>
          Back
        </button>
      </form>

      <div className="err" style={{ marginTop: 14 }}>
        {err}
      </div>
    </div>
  );
}
