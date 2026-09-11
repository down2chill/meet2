/* The meeting itself. Split into its own module so the SDK's UI kit — the
   largest chunk we ship — stays out of every other screen's download, and so
   the brand tokens are built in the same chunk that consumes them. */

import { useEffect, useRef, useState } from "react";
import { RealtimeKitProvider } from "@cloudflare/realtimekit-react";
import {
  RtkMeeting,
  extendConfig,
  registerAddons,
  defaultLanguage,
} from "@cloudflare/realtimekit-react-ui";
import {
  MEETING_TOKENS,
  BACKGROUNDS,
  saveBackground,
  loadBackground,
  backgroundEffectsSupported,
  classifyClick,
  markRejoin,
  meetingCode,
  hideAudioDialog,
  pressAudioDialog,
} from "./ui.js";
import PermissionBlocked from "./Permission.jsx";

// extendConfig merges onto the SDK's default UI config, so we only state the
// handful of things that differ: our palette, our font, our logo. Each call
// deep-clones that default, so every config handed out here is independent.
// Every tile shows the whole video, with bars wherever the shapes do not
// match, and it looks the same to the person sending it and to everyone
// watching. The SDK's default is 'cover', which fills the tile and crops: for
// a phone held upright that keeps a strip down the middle of a tall frame on
// every viewer's screen. 'contain' is one global switch the SDK applies to
// every tile on every client, so there is nothing to detect and nothing to
// keep in step.
const brandedConfig = () =>
  extendConfig({
    designTokens: MEETING_TOKENS,
    config: { videoFit: "contain" },
  });
const baseConfig = brandedConfig();

export default function Meeting({ client, skipSetup }) {
  const addon = useRef(null);
  const [config, setConfig] = useVideoBackground(client, addon);
  const device = useBlockedMedia(client);
  const joined = useJoined(client);

  useCameraSwitchFix(client, addon);
  useAudioUnlock(client);

  return (
    <div className={joined ? "meeting-root" : "meeting-root setup"}>
      <RealtimeKitProvider value={client}>
        <RtkMeeting
          meeting={client}
          config={config}
          // Without this the SDK ignores config.designTokens entirely and the
          // call renders in its default grey: rtk-meeting only writes the
          // --rtk-* custom properties when applyDesignSystem is set.
          applyDesignSystem
          // The setup screen is the entry room: name, camera preview and
          // device pickers, and the natural place for a permission prompt.
          // Skipped only on the reload we asked for to re-trigger a device
          // prompt: false here makes the SDK join as soon as it is ready, so
          // nobody has to press Join twice to get their camera back.
          showSetupScreen={!skipSetup}
          // mode="fill" makes the SDK style its host position:relative instead
          // of the default fixed, so it sizes to this container -- which is why
          // it needs an explicit height. Do not move this into a stylesheet: an
          // outer rule targeting the host also overrides the :host display:flex
          // the meeting UI is built on, and setting display there collapses the
          // entire layout, self-view included.
          mode="fill"
          style={{ height: "100%", width: "100%" }}
        />
      </RealtimeKitProvider>

      {/* Dismissing the panel must not mean the problem disappears. This stays
          until the device actually works, and puts the panel back. */}
      {device.blocked && !device.panelOpen && (
        <button className="device-alert" onClick={device.open}>
          <span className="device-alert-dot" />
          {device.blocked.kind === "audio" ? "Microphone" : "Camera"} unavailable
          <span className="device-alert-cta">Fix</span>
        </button>
      )}

      {device.blocked && device.panelOpen && (
        <PermissionBlocked
          info={device.blocked}
          client={client}
          onDismiss={device.close}
        />
      )}
    </div>
  );
}

/**
 * Lets the first click anywhere start other people's audio, instead of the
 * SDK's "allow audio playback" dialog.
 *
 * A document nobody has touched is not allowed to start audio. That bites on
 * the rejoin path, where the meeting joins with no Join click: the SDK's
 * rtk-participants-audio tests autoplay the moment it mounts, fails, and puts
 * up a dialog whose one button calls play() and closes. Everything it renders
 * sits inside its own open shadow root -- itself nested in rtk-meeting's -- so
 * an outer stylesheet cannot touch it and document.querySelector cannot find
 * it. deepQuery walks the shadow roots; a <style> appended to that root hides
 * the dialog; and the person's first pointerdown or keydown presses its button
 * for them, which is the moment the browser grants activation, so the play()
 * inside that handler is allowed. If the first interaction comes before the
 * dialog ever exists, activation is already sticky when the component mounts
 * and its own play() simply succeeds.
 *
 * The component only mounts once the room is joined, hence the roomJoined
 * hook and the short retry: it appears a render or two after the event.
 *
 * Until that first interaction, others are silent. That is the trade the page
 * makes for joining with no click at all.
 */
function useAudioUnlock(client) {
  useEffect(() => {
    const timers = [];
    const hide = () => {
      // The element arrives a beat after roomJoined; keep looking briefly.
      let tries = 0;
      const tick = () => {
        if (hideAudioDialog() || ++tries > 20) return;
        timers.push(setTimeout(tick, 250));
      };
      tick();
    };
    if (client.self.roomJoined) hide();
    client.self.addListener("roomJoined", hide);

    const unlock = () => {
      pressAudioDialog();
    };
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
    return () => {
      client.self.removeListener("roomJoined", hide);
      timers.forEach(clearTimeout);
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    };
  }, [client]);
}

/**
 * Switching camera leaves the preview black until something else forces a
 * re-render — toggling Mirror is the usual accidental cure.
 *
 * The SDK's tiles (rtk-participant-setup, and the in-call tile) cache the last
 * `videoUpdate` payload and only re-attach the <video> element's srcObject when
 * a new one arrives. Changing device tears the old track down and builds a new
 * one, and the events fired around that swap can leave the cached payload
 * describing the torn-down state — a stopped track, or videoEnabled:false,
 * which also drops the tile's `visible` class. Nothing corrects it afterwards,
 * so it stays black until a re-render re-reads the live values.
 *
 * So we re-emit `videoUpdate` ourselves, built from the SDK's own live getters.
 * It stops and starts nothing and republishes nothing — it says only what is
 * already true, just says it again once the swap has settled. Fired twice
 * because the SDK's own track-change handler is async and can land after the
 * first one.
 *
 * Note the emit rather than self.setVideoEnabled(true), which looks like the
 * tidier call and is in the public types: Self overrides `videoEnabled` with a
 * getter and no setter, so the setter it inherits from Participant would throw
 * on assignment. The SDK only ever calls it on remote participants.
 */
function useCameraSwitchFix(client, addonRef) {
  useEffect(() => {
    const timers = [];
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));

    const resync = () => {
      const self = client.self;
      if (!self.videoEnabled || !self.videoTrack) return;
      self.emit("videoUpdate", {
        videoEnabled: self.videoEnabled,
        videoTrack: self.videoTrack,
      });
    };

    // A background effect builds its pipeline around the track it was handed.
    // The new camera is a different track, so the effect has to be re-applied
    // or it renders from a source that no longer produces frames.
    const reapplyBackground = () => {
      const a = addonRef.current;
      if (!a) return;
      const mode = a.currentBackgroundMode;
      if (!mode || mode === "none") return;
      const p =
        mode === "blur"
          ? a.applyBlurBackground()
          : a.applyVirtualBackground(a.currentBackgroundURL);
      Promise.resolve(p).catch(() => {});
    };

    const onDevice = ({ device }) => {
      if (!device || device.kind !== "videoinput") return;
      at(0, resync);
      at(500, resync);
      at(600, reapplyBackground);
    };

    client.self.addListener("deviceUpdate", onDevice);
    return () => {
      client.self.removeListener("deviceUpdate", onDevice);
      timers.forEach(clearTimeout);
    };
  }, [client, addonRef]);
}

// The SDK reports device trouble through these two events. The distinction
// that matters most is CANCELED vs DENIED: a dismissed prompt leaves the
// permission at "ask", so requesting again really does bring the prompt back,
// while a blocked one does not and no amount of asking (or reloading) will.
//
// Only states a person can actually act on are listed. COULD_NOT_START in
// particular is deliberately absent: a device that is merely busy resolves
// itself, the SDK already says so in its own UI, and putting a panel over the
// meeting for it turns one unlucky moment into something that keeps coming
// back. Anything not named here is left to the SDK.
const MEDIA_STATE = {
  DENIED: "browser",
  SYSTEM_DENIED: "system",
};

// A permission failure only earns a dialog if it happened because the person
// just pressed the camera or microphone toggle and was refused. Anything else
// -- the page's own warm-up, escaping out of the browser's prompt, a retry deep
// in the SDK -- gets the quiet alert instead. Without this the meeting collects
// dialogs nobody asked for.
const USER_ACTION_MS = 3000;

function useBlockedMedia(client) {
  const [blocked, setBlocked] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const lastToggle = useRef({ kind: null, at: 0 });

  // One capture-phase click listener reads the composed path, so it sees into
  // the SDK's shadow roots. It notices two things: a press on a device toggle
  // (which arms the dialog for that device), and a press on the SDK's own
  // permissions-dialog Reload button, which must come back into the meeting
  // rather than onto the setup screen. A generic gesture would not do here --
  // pressing Escape to dismiss the browser's prompt is a keydown too, and that
  // is exactly the moment the SDK reports the refusal.
  useEffect(() => {
    const onClick = (e) => {
      const c = classifyClick(e.composedPath(), defaultLanguage["cta.reload"]);
      if (c.toggle) lastToggle.current = { kind: c.toggle, at: Date.now() };
      if (c.reload) markRejoin(meetingCode());
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    const onPermission = ({ message, kind }) => {
      if (kind === "screenshare") return; // its own flow, never silently denied
      if (message === "ACCEPTED") {
        setBlocked((b) => (b && b.kind === kind ? null : b));
        setPanelOpen(false);
        return;
      }
      const state = MEDIA_STATE[message];
      if (!state) return;
      setBlocked({ state, kind });
      // Only ever off the back of pressing this device's own toggle.
      const t = lastToggle.current;
      if (t.kind === kind && Date.now() - t.at < USER_ACTION_MS) setPanelOpen(true);
    };

    client.self.addListener("mediaPermissionUpdate", onPermission);
    client.self.addListener("mediaPermissionError", onPermission);
    return () => {
      client.self.removeListener("mediaPermissionUpdate", onPermission);
      client.self.removeListener("mediaPermissionError", onPermission);
    };
  }, [client]);

  return {
    blocked,
    panelOpen,
    open: () => setPanelOpen(true),
    close: () => setPanelOpen(false),
  };
}


/**
 * Adds the blur / virtual background control to the control bar, for everyone
 * in the room — the addon is not preset-aware, so hosts and guests get the same
 * button. Returns the UI config to render with: the plain branded one until the
 * addon is ready, then the one with the control in it.
 */
function useVideoBackground(client, addonRef) {
  const [config, setConfig] = useState(baseConfig);

  useEffect(() => {
    // Segmentation needs WebGL, and the SDK does not support it on iOS at all.
    // Better to show no button than one that cannot work.
    if (!backgroundEffectsSupported()) return;

    let addon = null;
    let stopRestore = null;
    let cancelled = false;

    (async () => {
      // Another ~110 kB of segmentation glue, fetched after the meeting is
      // already on screen so it never sits on the join path.
      const { default: VideoBGAddon } = await import(
        "@cloudflare/realtimekit-ui-addons/video-background"
      );

      addon = await VideoBGAddon.init({
        meeting: client,
        modes: ["blur", "virtual"],
        images: BACKGROUNDS,
        blurStrength: 30,
        buttonLabel: "Background",
        // Fires on every change, including "none", which is how the choice
        // gets remembered for next time.
        onVideoBackgroundUpdate: saveBackground,
      });

      if (cancelled) {
        addon.unregister();
        return;
      }

      addonRef.current = addon;

      // Two things about this line.
      //
      // The third argument is required: without it registerAddons builds on
      // the SDK's default config and every design token above is thrown away.
      //
      // It has to be a *fresh* config rather than baseConfig, because
      // RtkUiBuilder.build() returns the very object it was handed. The addon
      // edits the config in place, so passing baseConfig would both scribble
      // on our module-level copy and hand setConfig the reference it is
      // already holding -- which React skips, leaving the button invisible.
      // extendConfig deep-clones the SDK default every call, so this is a
      // tree of its own.
      setConfig(registerAddons([addon], client, brandedConfig()));
      stopRestore = restoreSaved(client, addon);
    })().catch((e) => {
      // A failed addon must never take the meeting down with it: the call
      // simply runs without the background control.
      console.error("Background effects unavailable:", e);
    });

    return () => {
      cancelled = true;
      addonRef.current = null;
      if (stopRestore) stopRestore();
      if (addon) addon.unregister();
    };
  }, [client, addonRef]);

  return [config, setConfig];
}

// Before the Join button is pressed we are on the SDK's setup screen, which
// needs different treatment on a short landscape viewport. See theme.css.
function useJoined(client) {
  const [joined, setJoined] = useState(() => !!client.self.roomJoined);

  useEffect(() => {
    const on = () => setJoined(true);
    const off = () => setJoined(false);
    client.self.addListener("roomJoined", on);
    client.self.addListener("roomLeft", off);
    return () => {
      client.self.removeListener("roomJoined", on);
      client.self.removeListener("roomLeft", off);
    };
  }, [client]);

  return joined;
}

/**
 * Re-applies the background this device last chose. The middleware attaches to
 * a live camera track, so when the camera is still off — the setup screen, or a
 * join that started without devices — it waits for the camera to come on.
 * Returns a cleanup function, or null when there was nothing to wait for.
 */
function restoreSaved(client, addon) {
  const saved = loadBackground();
  if (!saved) return null;

  const apply = () => {
    const p =
      saved.mode === "blur"
        ? addon.applyBlurBackground()
        : addon.applyVirtualBackground(saved.url);
    // Applying reports failure in its result rather than throwing, but a
    // rejected promise here still must not reach the console as unhandled.
    Promise.resolve(p).catch(() => {});
  };

  if (client.self.videoEnabled) {
    apply();
    return null;
  }

  const onVideo = ({ videoEnabled }) => {
    if (!videoEnabled) return;
    client.self.removeListener("videoUpdate", onVideo);
    apply();
  };
  client.self.addListener("videoUpdate", onVideo);
  return () => client.self.removeListener("videoUpdate", onVideo);
}
