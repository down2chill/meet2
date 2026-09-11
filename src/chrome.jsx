/* The bits of page furniture every screen shares: the gradient field, the
   floating logo bar and the footer. Styling lives in theme.css. */

import { COMPANY, SITE } from "./ui.js";

// One fixed layer for the gradient, mounted once per screen. It is painted
// behind everything (z-index: -1) and never repaints on scroll.
export function Background() {
  return <div className="d2c-bg" aria-hidden="true" />;
}

export function Logo() {
  return (
    <a className="logo" href={SITE} aria-label={COMPANY + " home"}>
      <span className="logo-badge">
        <img src="/brand/couch.svg" width="28" height="14" alt="" />
      </span>
      <img
        className="logo-word"
        src="/brand/down2chill_light.svg"
        alt={COMPANY}
        width="130"
        height="14"
      />
    </a>
  );
}

export function TopBar({ children }) {
  return (
    <header className="topbar">
      <Logo />
      <div className="topbar-right">{children}</div>
    </header>
  );
}

export function Footer() {
  return (
    <div className="foot">
      <a href={SITE}>Down2Chill</a>
      <a href={SITE + "/privacy.html"}>Privacy</a>
      <a href={SITE + "/terms.html"}>Terms</a>
    </div>
  );
}

// A full screen with the gradient behind it. `center` vertically centres the
// content, which is what the single-card screens want.
export function Shell({ center, bar, children }) {
  return (
    <>
      <Background />
      {bar}
      <div className={center ? "shell shell-center" : "shell"}>{children}</div>
    </>
  );
}

// The waiting state shared by the lazy chunks and the join handshake.
export function Waiting({ text }) {
  return (
    <Shell center bar={<TopBar />}>
      <div className="card narrow" style={{ textAlign: "center" }}>
        <div className="spinner" />
        <div className="muted">{text}</div>
      </div>
    </Shell>
  );
}

/* ---------- icons ---------- */

export const LockIcon = (props) => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <rect x="4" y="10" width="16" height="11" rx="2.5" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);

export const CheckIcon = (props) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const ArrowIcon = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M5 12h13M13 6l6 6-6 6" />
  </svg>
);
