import type { LyricLine, Lyrics } from "../../datasource/types";

/**
 * Whether a set of lines can drive a karaoke highlight.
 *
 * Derived from the lines themselves rather than trusting `timing`: providers disagree about
 * the field (LRCLIB says "synced", a TTML parse may leave gaps), and a single line without a
 * start time is enough to make the highlight jump backwards.
 */
export function isSyncedLyrics(lyrics: Lyrics | null): boolean {
  const lines = lyrics?.lines;
  if (!lines?.length) return false;
  if (lyrics?.timing === "none") return false;
  return lines.every((line) => typeof line.startTimeSec === "number");
}

/**
 * Index of the line that should be lit at `timeSec`, or -1 before the first one starts.
 *
 * A plain forward scan: lyric line counts are in the low hundreds and this runs once per
 * animation frame, so a binary search would buy nothing but an off-by-one to debug at 3am.
 */
/** Assumed length of a line with nothing after it to bound it. */
const FALLBACK_LINE_SEC = 4;

/**
 * How far playback is through line `index`, 0 to 1.
 *
 * Drives the sweep across the active line. The end is taken from whatever the provider
 * actually gave us, in descending order of trust: an explicit end, the next line's start,
 * the track duration for the final line, and only then a flat guess — the last line of a
 * song is routinely the one that has to hold for thirty seconds of outro.
 */
export function getLineProgress(
  lines: LyricLine[],
  index: number,
  timeSec: number,
  trackDurationSec?: number,
): number {
  const line = lines[index];
  const start = line?.startTimeSec;
  if (start === undefined) return 0;

  const isLast = index === lines.length - 1;
  const end = line.endTimeSec
    ?? lines[index + 1]?.startTimeSec
    ?? (isLast ? trackDurationSec : undefined)
    ?? start + FALLBACK_LINE_SEC;

  if (end <= start) return 1;
  return Math.min(1, Math.max(0, (timeSec - start) / (end - start)));
}

export function findActiveLineIndex(lines: LyricLine[], timeSec: number): number {
  let active = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index]?.startTimeSec;
    if (start === undefined || timeSec < start) break;
    active = index;
  }
  return active;
}

/** One rendered piece of a line: a timed word (or syllable), or the whitespace between. */
export interface LineToken {
  text: string;
  /** Index into the line's word timings; -1 for whitespace, which is never lit on its own. */
  wordIndex: number;
  /** Part of a backing vocal, rendered beneath the lead line. */
  background: boolean;
}

/**
 * The line as tokens to render, aligned one-to-one with its word timings.
 *
 * With real word timing the tokens come straight from `line.words`, so the n-th lit span is
 * always the n-th timed word. This used to re-split `line.text` on whitespace and pair the
 * pieces with the timings by position, which put every word after the first mismatch (a
 * syllable split, a hyphen, a word Musixmatch tokenised differently) on someone else's
 * timestamp. Without word timing the text is split on whitespace, as before.
 */
export function lineTokens(line: Pick<LyricLine, "text" | "words">): LineToken[] {
  const words = line.words;
  if (!words || words.length === 0) {
    let counter = -1;
    return line.text
      .split(/(\s+)/)
      .filter((token) => token.length > 0)
      .map((token) => ({
        text: token,
        wordIndex: token.trim() ? (counter += 1) : -1,
        background: false,
      }));
  }

  const tokens: LineToken[] = [];
  words.forEach((word, index) => {
    const background = Boolean(word.background);
    const [, leading = "", core = "", trailing = ""] = word.text.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? [];
    if (leading) tokens.push({ text: leading, wordIndex: -1, background });
    tokens.push({ text: core, wordIndex: index, background });
    if (trailing) tokens.push({ text: trailing, wordIndex: -1, background });
  });
  return tokens;
}
