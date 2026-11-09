import type { LyricLine, LyricWord } from "../types";

/*
 * Parsers for every timed lyric format the sources hand back.
 *
 * Kept free of the DOM and of the data source class so they can be checked in Node against
 * real provider payloads: these functions are where "the words are wrong" and "the timing is
 * off" bugs actually live, and a private method on a 7,000-line class is not somewhere a test
 * can reach.
 *
 * Word convention, shared with the lyrics view: `LyricWord.text` is the exact text of that
 * timed piece *including* any whitespace that follows it, so joining a line's words
 * reproduces the line verbatim. A word split into syllables ("e" + "nough") is simply two
 * pieces with no space between them — the view renders them back to back, so the word reads
 * whole while each syllable still lights up on its own beat.
 */

/* ------------------------------------------------------------------------------------------ */
/* Time                                                                                        */
/* ------------------------------------------------------------------------------------------ */

function fractionToSec(fraction: string | undefined): number {
  if (!fraction) return 0;
  return Number(`0.${fraction}`);
}

/**
 * A TTML clock or offset time, in seconds.
 *
 * Apple Music TTML — which is what BetterLyrics serves — writes anything under a minute as a
 * bare `27.395` with no unit. That form used to be rejected, which silently dropped every
 * line in the first minute of every song.
 */
export function parseTtmlTime(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  const clock = trimmed.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/);
  if (clock) {
    const hours = Number(clock[1] ?? 0);
    const minutes = Number(clock[2]);
    const seconds = Number(clock[3]);
    return hours * 3600 + minutes * 60 + seconds + fractionToSec(clock[4]);
  }

  const minuteClock = trimmed.match(/^(\d+):(\d{1,2})(?:[.,](\d+))?$/);
  if (minuteClock) {
    return Number(minuteClock[1]) * 60 + Number(minuteClock[2]) + fractionToSec(minuteClock[3]);
  }

  const offset = trimmed.match(/^(\d+(?:\.\d+)?)(h|m|s|ms)?$/);
  if (offset) {
    const amount = Number(offset[1]);
    if (!Number.isFinite(amount)) return undefined;
    switch (offset[2]) {
      case "h":
        return amount * 3600;
      case "m":
        return amount * 60;
      case "ms":
        return amount / 1000;
      default:
        return amount;
    }
  }

  return undefined;
}

/* ------------------------------------------------------------------------------------------ */
/* Minimal XML                                                                                 */
/* ------------------------------------------------------------------------------------------ */

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
type XmlNode = XmlElement | string;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    switch (lower) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      default:
        return whole;
    }
  });
}

/** Local name without its namespace prefix: `tt:p` and `p` are the same element. */
function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Just enough XML to read TTML. Not validating — a provider that sends something malformed
 * gets whatever structure can be recovered rather than nothing at all.
 */
function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const token =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gi;
  const attribute = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  for (const match of source.matchAll(token)) {
    const top = stack[stack.length - 1];
    if (match[1] !== undefined) {
      top.children.push(match[1]);
    } else if (match[6] !== undefined) {
      top.children.push(decodeEntities(match[6]));
    } else if (match[3] !== undefined) {
      const name = localName(match[3]);
      if (match[2] === "/") {
        // Close back to the matching element; ignore a stray closer with no opener.
        for (let depth = stack.length - 1; depth > 0; depth -= 1) {
          if (stack[depth].name === name) {
            stack.length = depth;
            break;
          }
        }
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const attr of (match[4] ?? "").matchAll(attribute)) {
        attrs[attr[1]] = decodeEntities(attr[2] ?? attr[3] ?? "");
      }
      const element: XmlElement = { name, attrs, children: [] };
      top.children.push(element);
      if (match[5] !== "/") stack.push(element);
    }
  }

  return root;
}

function attr(element: XmlElement, name: string): string | undefined {
  if (element.attrs[name] !== undefined) return element.attrs[name];
  for (const [key, value] of Object.entries(element.attrs)) {
    if (localName(key) === name) return value;
  }
  return undefined;
}

function textContent(node: XmlNode): string {
  if (typeof node === "string") return node;
  if (node.name === "br") return " ";
  return node.children.map(textContent).join("");
}

function findAll(node: XmlElement, name: string, into: XmlElement[] = []): XmlElement[] {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.name === name) into.push(child);
    else findAll(child, name, into);
  }
  return into;
}

/* ------------------------------------------------------------------------------------------ */
/* TTML                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** Roles whose text is a gloss on the lyric, not part of it — never shown as sung words. */
const SKIPPED_ROLES = new Set(["x-translation", "x-roman", "x-romanization"]);

interface Piece {
  text: string;
  start: number;
  end?: number;
}

/** Collects the timed pieces of one vocal layer (lead, or background) of one line. */
class PieceCollector {
  pieces: Piece[] = [];
  /** Text seen before the first timed piece, carried onto it rather than lost. */
  private leading = "";

  addTimed(text: string, start: number, end: number | undefined): void {
    this.pieces.push({ text: this.leading + text, start, end });
    this.leading = "";
  }

  addText(text: string): void {
    const last = this.pieces[this.pieces.length - 1];
    if (last) last.text += text;
    else this.leading += text;
  }

  /** Whitespace collapsed exactly as a browser would render it, ends trimmed. */
  words(background: boolean): LyricWord[] {
    const words = this.pieces
      .map((piece) => ({ ...piece, text: piece.text.replace(/\s+/g, " ") }))
      .filter((piece) => piece.text.length > 0);
    if (words.length === 0) return [];

    words[0].text = words[0].text.trimStart();
    words[words.length - 1].text = words[words.length - 1].text.trimEnd();

    const result: LyricWord[] = [];
    for (const piece of words) {
      if (!piece.text.trim()) {
        // A whitespace-only timed span: keep the space, drop the empty highlight.
        const previous = result[result.length - 1];
        if (previous) previous.text += piece.text;
        continue;
      }
      result.push({
        text: piece.text,
        startTimeSec: piece.start,
        endTimeSec: piece.end,
        ...(background ? { background: true } : {}),
      });
    }
    return result;
  }
}

function collectPieces(
  node: XmlElement,
  lead: PieceCollector,
  backing: PieceCollector,
  isBackground: boolean,
): void {
  const target = isBackground ? backing : lead;
  for (const child of node.children) {
    if (typeof child === "string") {
      target.addText(child);
      continue;
    }
    if (child.name === "br") {
      target.addText(" ");
      continue;
    }
    const role = attr(child, "role");
    if (role && SKIPPED_ROLES.has(role)) continue;
    const childIsBackground = isBackground || role === "x-bg";

    const begin = parseTtmlTime(attr(child, "begin"));
    const hasTimedDescendant = findAll(child, "span").some(
      (span) => attr(span, "begin") !== undefined,
    );

    if (begin !== undefined && !hasTimedDescendant) {
      (childIsBackground ? backing : lead).addTimed(
        textContent(child),
        begin,
        parseTtmlTime(attr(child, "end")),
      );
    } else {
      if (childIsBackground !== isBackground) {
        // Separate the layers so background text never runs into the end of a lead word.
        backing.addText(" ");
      }
      collectPieces(child, lead, backing, childIsBackground);
    }
  }
}

export interface ParsedTtml {
  lines: LyricLine[];
  /** `itunes:timing` — "Word", "Line" or "None" when the document says. */
  timing?: string;
  /** Length of the recording the sheet was timed against, from `<body dur>`. */
  durationSec?: number;
}

/**
 * Apple-style TTML into lines, keeping the word- and syllable-level timing it carries.
 *
 * Background vocals (`ttm:role="x-bg"`) are kept as their own timed words flagged
 * `background`, rather than flattened into the lead line's text where they used to land
 * mid-sentence and make the words read wrong.
 */
export function parseTtml(ttml: string): ParsedTtml {
  const root = parseXml(ttml);
  const tt = findAll(root, "tt")[0];
  const body = findAll(root, "body")[0];
  const timing = tt ? attr(tt, "timing") : undefined;
  const durationSec = body ? parseTtmlTime(attr(body, "dur")) : undefined;

  const lines: LyricLine[] = [];
  for (const paragraph of findAll(body ?? root, "p")) {
    const lead = new PieceCollector();
    const backing = new PieceCollector();
    collectPieces(paragraph, lead, backing, false);

    const leadWords = lead.words(false);
    const backingWords = backing.words(true);
    const words = [...leadWords, ...backingWords];

    let startTimeSec = parseTtmlTime(attr(paragraph, "begin") ?? attr(paragraph, "start"));
    let endTimeSec = parseTtmlTime(attr(paragraph, "end"));

    if (words.length > 0) {
      const firstWordStart = Math.min(...words.map((word) => word.startTimeSec));
      const lastWordEnd = Math.max(
        ...words.map((word) => word.endTimeSec ?? word.startTimeSec),
      );
      startTimeSec = startTimeSec === undefined ? firstWordStart : Math.min(startTimeSec, firstWordStart);
      endTimeSec = endTimeSec === undefined ? lastWordEnd : Math.max(endTimeSec, lastWordEnd);
    }
    if (startTimeSec === undefined) continue;

    const leadText = leadWords.map((word) => word.text).join("").trim();
    const backingText = backingWords.map((word) => word.text).join("").trim();
    const text =
      words.length > 0
        ? [leadText, backingText].filter(Boolean).join(" ")
        : textContent(paragraph).replace(/\s+/g, " ").trim();
    if (!text) continue;

    lines.push({
      text,
      startTimeSec,
      endTimeSec,
      ...(words.length > 0 ? { words } : {}),
    });
  }

  lines.sort((left, right) => (left.startTimeSec ?? 0) - (right.startTimeSec ?? 0));
  for (let index = 0; index < lines.length; index += 1) {
    lines[index].endTimeSec ??= lines[index + 1]?.startTimeSec;
  }

  return { lines, timing, durationSec };
}

/* ------------------------------------------------------------------------------------------ */
/* Musixmatch Rich Sync                                                                        */
/* ------------------------------------------------------------------------------------------ */

export interface MusixmatchRichsyncLine {
  ts: number;
  te: number;
  l?: Array<{ c: string; o: number }>;
  x?: string;
}

/**
 * Rich Sync into lines with word timing.
 *
 * Rich Sync lists spaces as their own zero-width entries. They used to be thrown away, and
 * the view then re-split the line's `x` text on whitespace and matched the pieces to timings
 * by position — so any line where Musixmatch tokenised differently from a plain space split
 * (a hyphen, an apostrophe, punctuation on its own) had every following word lit at the
 * wrong moment. Spaces now stay attached to the word before them, and the words *are* the
 * line, so there is nothing left to line up.
 */
export function parseMusixmatchRichsync(rawBody: string): LyricLine[] {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const lines: LyricLine[] = [];
  for (const line of raw as MusixmatchRichsyncLine[]) {
    if (typeof line?.ts !== "number") continue;
    const lineEnd = typeof line.te === "number" && line.te > line.ts ? line.te : undefined;

    const words: LyricWord[] = [];
    let leading = "";
    for (const entry of line.l ?? []) {
      if (typeof entry?.c !== "string") continue;
      if (!entry.c.trim()) {
        const previous = words[words.length - 1];
        if (previous) previous.text += entry.c;
        else leading += entry.c;
        continue;
      }
      words.push({
        text: leading + entry.c,
        startTimeSec: line.ts + (Number.isFinite(entry.o) ? entry.o : 0),
      });
      leading = "";
    }

    if (words.length > 0) {
      words[0].text = words[0].text.trimStart();
      words[words.length - 1].text = words[words.length - 1].text.trimEnd();
      for (let index = 0; index < words.length; index += 1) {
        const nextStart = words[index + 1]?.startTimeSec;
        words[index].endTimeSec = nextStart ?? lineEnd;
      }
    }

    const text = words.length > 0
      ? words.map((word) => word.text).join("").replace(/\s+/g, " ").trim()
      : (line.x ?? "").replace(/\s+/g, " ").trim();

    if (!text) {
      lines.push({ text: "", startTimeSec: line.ts, endTimeSec: lineEnd });
      continue;
    }
    lines.push({
      text,
      startTimeSec: line.ts,
      endTimeSec: lineEnd,
      ...(words.length > 0 ? { words } : {}),
    });
  }

  lines.sort((left, right) => (left.startTimeSec ?? 0) - (right.startTimeSec ?? 0));
  return dropRedundantBlanks(lines);
}

/* ------------------------------------------------------------------------------------------ */
/* LRC                                                                                         */
/* ------------------------------------------------------------------------------------------ */

const LINE_STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_STAMP = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

function stampToSec(minutes: string, seconds: string, fraction: string | undefined): number {
  return Number(minutes) * 60 + Number(seconds) + fractionToSec(fraction);
}

/**
 * Blank lines are instrumental breaks and keep their slot, so the line before one stops
 * sweeping when the singing does instead of crawling across the whole solo. Two in a row, or
 * one before anything has been sung, only add noise.
 */
function dropRedundantBlanks(lines: LyricLine[]): LyricLine[] {
  const kept: LyricLine[] = [];
  for (const line of lines) {
    const isBlank = !line.text.trim();
    if (isBlank) {
      const previous = kept[kept.length - 1];
      if (!previous || !previous.text.trim()) continue;
    }
    kept.push(line);
  }
  while (kept.length > 0 && !kept[kept.length - 1].text.trim()) {
    // A trailing blank still tells us when the last line stops — keep that, lose the row.
    const blank = kept.pop()!;
    const last = kept[kept.length - 1];
    if (last && last.endTimeSec === undefined) last.endTimeSec = blank.startTimeSec;
  }
  return kept;
}

/**
 * LRC, including the `[offset:]` tag and enhanced `<mm:ss.xx>` word stamps.
 *
 * Word stamps used to be left in the text, so a sheet carrying them displayed
 * `<00:12.34>Hello` on screen. They are now read as word timing.
 */
export function parseLrc(lrc: string): LyricLine[] {
  let offsetSec = 0;
  const offsetTag = lrc.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/im);
  if (offsetTag) offsetSec = Number(offsetTag[1]) / 1000;

  const lines: LyricLine[] = [];
  for (const rawLine of lrc.split(/\r?\n/)) {
    const stamps = [...rawLine.matchAll(LINE_STAMP)];
    if (stamps.length === 0) continue;
    const body = rawLine.replace(LINE_STAMP, "");

    const wordStamps = [...body.matchAll(WORD_STAMP)];
    const plain = body.replace(WORD_STAMP, "").replace(/\s+/g, " ").trim();

    let words: LyricWord[] | undefined;
    if (wordStamps.length > 0 && plain) {
      words = [];
      for (let index = 0; index < wordStamps.length; index += 1) {
        const stamp = wordStamps[index];
        const from = (stamp.index ?? 0) + stamp[0].length;
        const to = wordStamps[index + 1]?.index ?? body.length;
        const text = body.slice(from, to).replace(/\s+/g, " ");
        const start = stampToSec(stamp[1], stamp[2], stamp[3]) - offsetSec;
        if (!text.trim()) {
          const previous = words[words.length - 1];
          if (previous && text) previous.text += text;
          continue;
        }
        const next = wordStamps[index + 1];
        words.push({
          text,
          startTimeSec: start,
          endTimeSec: next ? stampToSec(next[1], next[2], next[3]) - offsetSec : undefined,
        });
      }
      const leadingText = body.slice(0, wordStamps[0].index ?? 0).replace(/\s+/g, " ");
      if (words.length > 0 && leadingText.trim()) words[0].text = leadingText + words[0].text;
      if (words.length > 0) {
        words[0].text = words[0].text.trimStart();
        words[words.length - 1].text = words[words.length - 1].text.trimEnd();
      } else {
        words = undefined;
      }
    }

    for (const stamp of stamps) {
      const start = stampToSec(stamp[1], stamp[2], stamp[3]) - offsetSec;
      // A repeated line ([00:10][01:30]chorus) only carries word stamps for its first sung time.
      const shift = words ? start - words[0].startTimeSec : 0;
      const lineWords = words && stamp === stamps[0]
        ? words
        : words?.map((word) => ({
            ...word,
            startTimeSec: word.startTimeSec + shift,
            endTimeSec: word.endTimeSec === undefined ? undefined : word.endTimeSec + shift,
          }));
      lines.push({
        text: plain,
        startTimeSec: Math.max(0, start),
        ...(lineWords ? { words: lineWords } : {}),
      });
    }
  }

  lines.sort((left, right) => (left.startTimeSec ?? 0) - (right.startTimeSec ?? 0));
  const ended = lines.map((line, index) => {
    const nextStart = lines[index + 1]?.startTimeSec;
    const lastWordEnd = line.words?.[line.words.length - 1]?.endTimeSec;
    return { ...line, endTimeSec: lastWordEnd ?? nextStart };
  });
  return dropRedundantBlanks(ended);
}
