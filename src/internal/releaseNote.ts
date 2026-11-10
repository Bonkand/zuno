import { getVersion } from "@tauri-apps/api/app";
import { getAppSetting, setAppSetting } from "./appSettings";

/**
 * The note shown once, after an update installs.
 *
 * Edit `RELEASE_NOTE_BODY` for each release and nothing else: the note is tied to the
 * installed version, not to a hand-maintained "should I show this" flag, so shipping a new
 * version is all it takes to show the new text exactly once per machine.
 *
 * The shape is fixed, and every release follows it:
 *
 *   **Topic** — one line, in plain language, about what changed for the listener.
 *   ...one line per topic, four or so at most...
 *
 *   Report anything broken on GitHub, or come say hello at /r/ZunoMusic.
 *
 *   Thanks :)
 *
 * No opening paragraph. This dialog interrupts a launch nobody asked to have interrupted, so
 * it earns its place by being read in a glance — a lead-in is the first thing skipped, and it
 * pushes the lines that matter below where the eye lands.
 */
const SEEN_VERSION_KEY = "release-note-seen-version";

export const RELEASE_NOTE_BODY = `**Media controls** — playing, pausing and skipping from the Windows media flyout or a taskbar widget while Zuno is in the tray now shows up correctly when you reopen it.
**Lyrics** — fewer wrong words and better timing, and word-by-word synced lyrics are preferred when available.
**Playback** — "stop after this track" works with crossfade, the sleep timer restores your volume, and the playhead no longer drifts.
**Queue** — restoring after shuffle keeps the right order, no more duplicate "next" tracks, and Last.fm no longer double-scrobbles repeats.

Report anything broken on GitHub, or come say hello at /r/ZunoMusic.

Thanks :)`;

export type ReleaseNoteSegment =
  | { kind: "text"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "link"; value: string; url: string };

/* Subreddits, bare URLs, and `**emphasis**`. Kept narrow on purpose: `/r/name` is unambiguous
   and `**` is not something anyone types by accident, where anything cleverer would start
   marking up ordinary prose. Still not markdown — three shapes, no escaping question. */
const SEGMENT_PATTERN = /(\*\*[^*\n]+\*\*|https?:\/\/[^\s)]+|\/r\/[A-Za-z0-9_]+)/g;

/**
 * Splits the note into text, emphasis and links.
 *
 * The body stays a plain string so writing the next release's note is mostly just typing —
 * mention a subreddit or paste a URL and it becomes a link, wrap a phrase in `**` and it stands
 * out. Three conventions, no markdown renderer and no escaping question.
 */
export function parseReleaseNote(body: string): ReleaseNoteSegment[] {
  const segments: ReleaseNoteSegment[] = [];
  let lastIndex = 0;

  // `matchAll` rather than a stateful `exec` loop: the regex is module-level, and a shared
  // `lastIndex` across calls is the classic way this silently skips matches on a second run.
  for (const match of body.matchAll(SEGMENT_PATTERN)) {
    const value = match[0];
    const start = match.index ?? 0;

    if (start > lastIndex) {
      segments.push({ kind: "text", value: body.slice(lastIndex, start) });
    }
    if (value.startsWith("**")) {
      segments.push({ kind: "strong", value: value.slice(2, -2) });
    } else {
      segments.push({
        kind: "link",
        value,
        url: value.startsWith("/r/") ? `https://www.reddit.com${value}` : value,
      });
    }
    lastIndex = start + value.length;
  }

  if (lastIndex < body.length) {
    segments.push({ kind: "text", value: body.slice(lastIndex) });
  }
  return segments;
}

/**
 * Whether this launch is the first one after an update.
 *
 * A fresh install is deliberately not an update — greeting a first-time user with "here is
 * what changed" is noise about software they have never run. But "no version recorded" does
 * not mean "fresh install": on the very release that introduces this feature, *nobody* has a
 * recorded version, because nothing was ever writing one. 1.2.0 shipped exactly that bug and
 * showed the note to no one.
 *
 * So a missing version falls back to `hasPriorUse` — whether this profile shows any trace of
 * the app having been run before. That distinguishes the two cases the stored version alone
 * cannot.
 *
 * Any difference counts, not just an increase: a downgrade or a sideways build is still a
 * version whose notes were never read, and comparing version strings numerically is a parser
 * nobody needs here.
 */
export function shouldShowReleaseNote(
  installedVersion: string,
  lastSeenVersion: string | null,
  hasPriorUse = false,
): boolean {
  if (!installedVersion) return false;
  if (lastSeenVersion === null) return hasPriorUse;
  return lastSeenVersion !== installedVersion;
}

/**
 * Traces of the app having actually been *used* before this launch.
 *
 * Every key here is written by using the app — playing something, restoring a session,
 * downloading, making a local playlist. Settings keys deliberately are not: boot hydration
 * writes those before this ever runs, so on a genuinely fresh install they would already be
 * present and every new user would be shown release notes for software they just installed.
 *
 * All predate the release-note feature. A key introduced alongside it would be present in
 * both cases and settle nothing.
 */
const PRIOR_USE_KEYS = [
  "zuno.play-history.v1",
  "yt-music-dock.app-session.v1",
  "zuno.offline-manifest.v1",
  "ytc-local-playlists-v1",
  "yt-music-dock:recent-playlists",
];

export function hasPriorUse(): boolean {
  try {
    return PRIOR_USE_KEYS.some((key) => localStorage.getItem(key) !== null);
  } catch {
    return false;
  }
}

/*
 * Sampled once, when this module is first evaluated — before React mounts.
 *
 * resolveReleaseNoteVersion awaits two IPC round trips before it gets to ask, and by then the
 * running app has usually already written the session snapshot that is one of the keys above.
 * Asking at that point made every fresh install look like an update, so a brand-new user got
 * an "Updated" dialog stacked on top of the onboarding tour.
 */
const PRIOR_USE_AT_BOOT = hasPriorUse();

function readSeenVersion(): string | null {
  try {
    return localStorage.getItem(SEEN_VERSION_KEY);
  } catch {
    return null;
  }
}

function writeSeenVersion(version: string): void {
  try {
    localStorage.setItem(SEEN_VERSION_KEY, version);
  } catch {
    // The durable copy below is what survives a cleared profile anyway.
  }
  void setAppSetting(SEEN_VERSION_KEY, version);
}

/**
 * The version to show a note for, or null.
 *
 * Records silently in every case that is not an update, so this only ever answers "yes" once
 * per new version.
 */
export async function resolveReleaseNoteVersion(): Promise<string | null> {
  let installedVersion: string;
  try {
    installedVersion = await getVersion();
  } catch {
    // Not running under Tauri, or the call failed: no version, no note.
    return null;
  }

  // The durable copy wins: local storage is cleared far more often than app settings, and a
  // cleared profile must not replay an old note as though it were new.
  const durable = await getAppSetting<string>(SEEN_VERSION_KEY).catch(() => null);
  const lastSeenVersion = typeof durable === "string" ? durable : readSeenVersion();

  if (shouldShowReleaseNote(installedVersion, lastSeenVersion, PRIOR_USE_AT_BOOT)) {
    return installedVersion;
  }

  if (lastSeenVersion !== installedVersion) writeSeenVersion(installedVersion);
  return null;
}

/** Called once the user has actually seen it, so an unclean exit shows it again. */
export function markReleaseNoteSeen(version: string): void {
  writeSeenVersion(version);
}
