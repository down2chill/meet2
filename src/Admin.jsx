import { useState, useEffect, useCallback } from "react";
import { COMPANY, api, when, whenAt, toLocalInput, localTz, expiresIn } from "./ui.js";
import {
  Shell,
  TopBar,
  Footer,
  Waiting,
  LockIcon,
  CheckIcon,
  ArrowIcon,
} from "./chrome.jsx";

export default function Admin() {
  const [authed, setAuthed] = useState(null);
  const [username, setUsername] = useState("");
  const [meetings, setMeetings] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [orphans, setOrphans] = useState([]);
  const [rtkError, setRtkError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    const r = await api("/api/meetings");
    setBusy(false);
    if (r.status === 401) return setAuthed(false);
    if (!r.ok) return setErr(r.body.error || "Could not load meetings.");
    setErr("");
    setMeetings(r.body.meetings || []);
    setOrphans(r.body.orphans || []);
    setRtkError(!!r.body.rtkError);
    setTruncated(!!r.body.truncated);
  }, []);

  useEffect(() => {
    (async () => {
      const s = await api("/api/session");
      if (!s.body.authed) return setAuthed(false);
      setAuthed(true);
      setUsername(s.body.username || "");
      load();
    })();
  }, [load]);

  // KV's list index trails writes by a few seconds, so re-fetching after every
  // change is a race: a just-deleted meeting still lists, and a just-created
  // one does not. We already know the outcome of each write, so apply it to
  // the list directly. Fewer requests and no flicker.
  const addMeeting = (m) =>
    setMeetings((l) => [m, ...(l || []).filter((x) => x.code !== m.code)]);
  const dropMeeting = (code) =>
    setMeetings((l) => (l || []).filter((x) => x.code !== code));
  const dropOrphan = (id) => setOrphans((l) => l.filter((x) => x.meetingId !== id));
  const patchMeeting = (code, patch) =>
    setMeetings((l) =>
      (l || []).map((x) => (x.code === code ? { ...x, ...patch } : x))
    );

  if (authed === null) return <Waiting text="Checking your session..." />;

  if (authed === false)
    return (
      <Shell center bar={<TopBar />}>
        <div className="narrow">
          <div className="card" style={{ textAlign: "center" }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              {COMPANY} Meet
            </div>
            <div className="card-title" style={{ fontSize: 20, marginBottom: 10 }}>
              Your session has ended
            </div>
            <p className="muted" style={{ marginBottom: 20 }}>
              Sessions last 12 hours. Sign in again to pick up where you left off.
            </p>
            <a className="btn" href="/">
              Go to sign in <ArrowIcon />
            </a>
          </div>
          <Footer />
        </div>
      </Shell>
    );

  const bar = (
    <TopBar>
      <span className="topbar-who">{username}</span>
      <button className="btn btn-link" onClick={load} disabled={busy}>
        {busy ? "Refreshing..." : "Refresh"}
      </button>
      <button
        className="btn btn-link"
        onClick={async () => {
          await api("/api/logout", { method: "POST" });
          location.href = "/";
        }}
      >
        Sign out
      </button>
    </TopBar>
  );

  return (
    <Shell bar={bar}>
      <div className="wrap">
        <div className="eyebrow">{COMPANY} Meet</div>
        <h1 className="hero-title display" style={{ fontSize: "clamp(2.2rem, 7vw, 3.2rem)", marginTop: 12 }}>
          Meeting <span className="accent">rooms.</span>
        </h1>

        <div style={{ marginTop: 28 }}>
          <Create onCreated={addMeeting} />
        </div>

        <div className="err err-left" style={{ marginTop: 14 }}>
          {err}
        </div>

        {rtkError && (
          <div className="hint" style={{ marginTop: 6, textAlign: "left" }}>
            Cloudflare could not be reached, so this is this app's own records only.
            Whether each meeting is still live there is unknown until it can be.
          </div>
        )}

        <h2 className="section-title">
          Meetings{meetings ? " · " + meetings.length : ""}
        </h2>

        {meetings === null && <div className="empty">Loading...</div>}
        {meetings && meetings.length === 0 && (
          <div className="card empty">No meetings yet. Create one above.</div>
        )}

        <div className="stack">
          {meetings &&
            meetings.map((m) => (
              <Meeting
                key={m.code}
                m={m}
                onDeleted={() => dropMeeting(m.code)}
                onUpdated={(patch) => patchMeeting(m.code, patch)}
              />
            ))}
        </div>

        {truncated && (
          <div className="hint" style={{ marginTop: 16 }}>
            Showing the first 1000 meetings.
          </div>
        )}

        {orphans.length > 0 && (
          <>
            <h2 className="section-title">
              On Cloudflare, not in this app · {orphans.length}
            </h2>
            <div className="hint" style={{ marginBottom: 12, textAlign: "left" }}>
              Still live on Cloudflare's side with no record here, so nobody can join
              them through a link. They cost nothing while idle; the nightly sweep will
              switch them off, or do it now.
            </div>
            <div className="stack">
              {orphans.map((o) => (
                <Orphan key={o.meetingId} o={o} onDone={() => dropOrphan(o.meetingId)} />
              ))}
            </div>
          </>
        )}

        <Footer />
      </div>
    </Shell>
  );
}

function Create({ onCreated }) {
  const [title, setTitle] = useState("");
  const [at, setAt] = useState("");
  const [pw, setPw] = useState("");
  const [links, setLinks] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const body = { title, password: pw };
      if (at) {
        body.when = new Date(at).getTime();
        body.tz = localTz();
      }
      const r = await api("/api/rooms", { method: "POST", body });
      if (!r.ok) {
        setErr(r.body.error || "Could not create the meeting.");
        return;
      }
      setLinks(r.body);
      setTitle("");
      setAt("");
      setPw("");
      if (r.body.meeting) onCreated(r.body.meeting);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-brand">
      <div className="eyebrow" style={{ marginBottom: 14 }}>
        New meeting
      </div>

      <form onSubmit={submit} className="stack">
        <input
          className="field"
          placeholder="Meeting title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="field-label">
          Session date &amp; time (optional) - shown on the link&apos;s share card
        </label>
        <input
          className="field"
          type="datetime-local"
          value={at}
          onChange={(e) => setAt(e.target.value)}
        />
        <input
          className="field"
          type="password"
          placeholder="Password (optional)"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Creating..." : "Create meeting"}
        </button>
      </form>

      <div className="err" style={{ marginTop: 14 }}>
        {err}
      </div>

      {links && (
        <div className="divider">
          <Copyable caption="Invite link" value={links.guestLink} />
          <Copyable caption="Host link — keep this one" value={links.hostLink} />
        </div>
      )}
    </div>
  );
}

function Meeting({ m, onDeleted, onUpdated }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [hostLink, setHostLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // "inactive" is Cloudflare's word: the meeting is switched off there, so
  // the links are dead and only the leftover record is ours to remove.
  const live = m.status !== "inactive";

  const act = async (path, opts) => {
    setBusy(true);
    setErr("");
    const r = await api(path, opts);
    setBusy(false);
    if (!r.ok) {
      setErr(r.body.error || "That did not work.");
      return null;
    }
    return r.body;
  };

  return (
    <div className="card card-row">
      <div className="card-title">{m.title}</div>

      <div className="meta">
        <span className="code-chip">{m.code}</span>
        {m.status === "inactive" && <span className="lock">inactive on Cloudflare</span>}
        {m.status === "unknown" && <span className="lock">status unknown</span>}
        {m.when && (
          <>
            <span>scheduled {whenAt(m.when)}</span>
            <span className="meta-sep">/</span>
          </>
        )}
        <span>created {when(m.createdAt)}</span>
        <span className="meta-sep">/</span>
        <span>{m.lastUsedAt ? "last joined " + when(m.lastUsedAt * 1000) : "never joined"}</span>
        {m.expiresAt && m.status !== "inactive" && (
          <>
            <span className="meta-sep">/</span>
            <span>{expiresIn(m.expiresAt)}</span>
          </>
        )}
        {m.hasPassword && (
          <span className="lock">
            <LockIcon />
            password
          </span>
        )}
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        {live && (
          <>
            <a className="btn btn-sm" href={"/j/" + m.code}>
              Join as host
            </a>
            <CopyButton value={m.guestLink} labelText="Copy invite" />
            <button
              className="btn btn-sm"
              onClick={() => setEditing(!editing)}
              disabled={busy}
            >
              {editing ? "Close" : "Edit"}
            </button>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                const b = await act("/api/meetings/" + m.code + "/host", {
                  method: "POST",
                });
                if (b) setHostLink(b.hostLink);
              }}
            >
              New host link
            </button>
          </>
        )}
        {confirming ? (
          <>
            <button
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={async () => {
                const b = await act("/api/meetings/" + m.code, { method: "DELETE" });
                if (b) onDeleted();
              }}
            >
              {live ? "Really deactivate" : "Really remove"}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Keep
            </button>
          </>
        ) : (
          <button
            className="btn btn-sm btn-danger"
            onClick={() => setConfirming(true)}
            disabled={busy}
          >
            {live ? "Deactivate" : "Remove record"}
          </button>
        )}
      </div>

      <div className="err err-left" style={{ marginTop: 10 }}>
        {err}
      </div>

      {hostLink && (
        <div className="divider">
          <Copyable
            caption="New host link — the previous one no longer works"
            value={hostLink}
          />
        </div>
      )}

      {editing && (
        <Edit
          m={m}
          onSaved={(patch) => {
            setEditing(false);
            onUpdated(patch);
          }}
        />
      )}
    </div>
  );
}

function Edit({ m, onSaved }) {
  const [title, setTitle] = useState(m.title);
  const [at, setAt] = useState(toLocalInput(m.when));
  const [pw, setPw] = useState("");
  const [changePw, setChangePw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    // Only send password when the admin actually chose to change it, so an
    // untouched form never clears an existing one.
    const body = { title, when: at ? new Date(at).getTime() : null };
    if (at) body.tz = localTz();
    if (changePw) body.password = pw;
    const r = await api("/api/meetings/" + m.code, { method: "POST", body });
    setBusy(false);
    if (!r.ok) {
      setErr(r.body.error || "Could not save.");
      return;
    }
    onSaved({
      title: r.body.title,
      when: r.body.when || null,
      hasPassword: !!r.body.hasPassword,
      expiresAt: r.body.expiresAt || m.expiresAt,
    });
  }

  return (
    <form onSubmit={save} className="stack divider">
      <label className="field-label">Title</label>
      <input
        className="field"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      <label className="field-label">
        Session date &amp; time - blank removes it from the share card
      </label>
      <input
        className="field"
        type="datetime-local"
        value={at}
        onChange={(e) => setAt(e.target.value)}
      />

      {!changePw ? (
        <button className="btn btn-ghost" type="button" onClick={() => setChangePw(true)}>
          {m.hasPassword ? "Change or remove password" : "Add a password"}
        </button>
      ) : (
        <>
          <label className="field-label">
            New password — leave empty to remove it
          </label>
          <input
            className="field"
            type="password"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </>
      )}

      <button className="btn" type="submit" disabled={busy}>
        {busy ? "Saving..." : "Save"}
      </button>
      <div className="err">{err}</div>
    </form>
  );
}

function Orphan({ o, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="card card-row">
      <div className="card-title">{o.title}</div>
      <div className="meta">
        <span className="code-chip">{o.meetingId.slice(0, 8)}</span>
        <span>created {when(Date.parse(o.createdAt))}</span>
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <button
          className="btn btn-sm btn-danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr("");
            const r = await api("/api/orphans/" + o.meetingId, { method: "DELETE" });
            setBusy(false);
            if (!r.ok) return setErr(r.body.error || "That did not work.");
            onDone();
          }}
        >
          {busy ? "Deactivating..." : "Deactivate"}
        </button>
      </div>
      <div className="err err-left" style={{ marginTop: 10 }}>
        {err}
      </div>
    </div>
  );
}

function CopyButton({ value, labelText }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn btn-sm"
      onClick={async () => {
        const ok = await copy(value);
        setDone(ok);
        if (ok) setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? (
        <>
          <CheckIcon /> Copied
        </>
      ) : (
        labelText
      )}
    </button>
  );
}

function Copyable({ caption, value }) {
  return (
    <div className="copyable">
      <div className="field-label">{caption}</div>
      <div className="copy-field">
        <input className="field" readOnly value={value} />
        <CopyButton value={value} labelText="Copy" />
      </div>
    </div>
  );
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false; // insecure context or permission refused
  }
}
