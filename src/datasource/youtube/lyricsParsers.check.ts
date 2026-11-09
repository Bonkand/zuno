/**
 * Self-check for the lyric format parsers. Run with `npm run check`.
 *
 * The TTML fixtures are trimmed from real BetterLyrics (Apple Music) responses, keeping the
 * exact shape: unit-less sub-minute times, syllables split across spans with no space between
 * them, and a nested `x-bg` backing vocal.
 */
export {};

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(
    actual === expected,
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const { parseLrc, parseMusixmatchRichsync, parseTtml, parseTtmlTime } = await import(
  "./lyricsParsers"
);

/* ---- TTML times ---- */

equal(parseTtmlTime("27.395"), 27.395, "a bare sub-minute time is seconds (Apple's format)");
equal(parseTtmlTime("2:41.019"), 161.019, "m:ss.fff");
equal(parseTtmlTime("1:02:03.5"), 3723.5, "h:mm:ss.f");
equal(parseTtmlTime("00:00:12.340"), 12.34, "hh:mm:ss.fff");
equal(parseTtmlTime("12.5s"), 12.5, "seconds with a unit");
equal(parseTtmlTime("1500ms"), 1.5, "milliseconds");
equal(parseTtmlTime("nonsense"), undefined, "garbage is undefined, not zero");
equal(parseTtmlTime(null), undefined, "and so is nothing");

/* ---- TTML ---- */

const TTML = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="en"><head><metadata><ttm:agent type="person" xml:id="v1"/></metadata></head><body dur="3:21.570"><div begin="27.395" end="48.621"><p begin="27.395" end="28.960" itunes:key="L1" ttm:agent="v1"><span begin="27.395" end="27.549">I</span> <span begin="27.549" end="27.740">been</span> <span begin="27.740" end="28.077">tryna</span> <span begin="28.077" end="28.960">call</span></p><p begin="30.189" end="32.529" itunes:key="L2"><span begin="31.498" end="31.839">long</span> <span begin="31.839" end="31.996">e</span><span begin="31.996" end="32.529">nough</span></p></div><div><p begin="1:25.011" end="1:28.468" itunes:key="L7"><span begin="1:25.011" end="1:25.444">I&apos;m</span> <span begin="1:25.444" end="1:27.194">poor</span> <span begin="1:27.194" end="1:28.444">boy</span> <span ttm:role="x-bg"><span begin="1:25.102" end="1:27.599">(Ooh,</span> <span begin="1:27.599" end="1:28.468">poor)</span></span></p></div></body></tt>`;

const parsed = parseTtml(TTML);
equal(parsed.lines.length, 3, "every line survives, including the ones in the first minute");
equal(parsed.timing, "Word", "the declared timing is read");
equal(parsed.durationSec, 201.57, "the sheet's recording length is read from <body dur>");

const [first, syllables, backed] = parsed.lines;
equal(first.text, "I been tryna call", "line text");
equal(first.startTimeSec, 27.395, "line start");
equal(first.endTimeSec, 28.96, "line end");
equal(first.words?.length, 4, "one timed piece per span");
equal(first.words?.map((word) => word.text).join(""), first.text, "the words joined are the line");
equal(first.words?.[1].startTimeSec, 27.549, "word start");
equal(first.words?.[1].endTimeSec, 27.74, "word end is the provider's, not guessed");

equal(syllables.text, "long enough", "syllables join into one word with no space");
equal(
  syllables.words?.map((word) => word.text).join("|"),
  "long |e|nough",
  "but stay separately timed",
);

equal(backed.text, "I'm poor boy (Ooh, poor)", "entities decoded, backing vocal after the lead");
equal(
  backed.words?.filter((word) => !word.background).map((word) => word.text).join(""),
  "I'm poor boy",
  "the lead words carry no backing text",
);
equal(
  backed.words?.filter((word) => word.background).map((word) => word.text).join(""),
  "(Ooh, poor)",
  "the backing vocal keeps its own words",
);
equal(
  backed.words?.find((word) => word.background)?.startTimeSec,
  85.102,
  "and its own timing",
);

const lineTimed = parseTtml(
  `<tt itunes:timing="Line"><body><div><p begin="10.5" end="12">Hello &amp; goodbye</p><p begin="12.000">Next</p></div></body></tt>`,
);
equal(lineTimed.lines.length, 2, "line-timed TTML still parses");
equal(lineTimed.lines[0].text, "Hello & goodbye", "plain paragraph text");
equal(lineTimed.lines[0].words, undefined, "with no word timing invented");
equal(lineTimed.lines[1].endTimeSec, undefined, "an open-ended last line stays open");

const translated = parseTtml(
  `<tt><body><p begin="1" end="2"><span begin="1" end="2">Hola</span><span ttm:role="x-translation">Hello</span></p></body></tt>`,
);
equal(translated.lines[0].text, "Hola", "an inline translation is not sung text");

/* ---- Musixmatch Rich Sync ---- */

const richsync = JSON.stringify([
  {
    ts: 10,
    te: 13,
    l: [
      { c: "Rock", o: 0 },
      { c: "-", o: 0.3 },
      { c: "a", o: 0.4 },
      { c: " ", o: 0.6 },
      { c: "bye", o: 0.7 },
      { c: " ", o: 1.0 },
      { c: "baby", o: 1.2 },
    ],
    x: "Rock-a bye baby",
  },
  { ts: 14, te: 14, l: [], x: "" },
  { ts: 20, te: 22, x: "No word data" },
]);
const mxm = parseMusixmatchRichsync(richsync);
equal(mxm.length, 3, "Rich Sync lines, the instrumental break kept");
equal(mxm[0].text, "Rock-a bye baby", "text comes from the timed pieces");
equal(mxm[0].words?.length, 5, "every non-space entry is a timed piece, punctuation included");
equal(
  mxm[0].words?.map((word) => word.text).join("|"),
  "Rock|-|a |bye |baby",
  "spaces stay attached to the word before them",
);
equal(mxm[0].words?.[2].startTimeSec, 10.4, "offsets are relative to the line start");
equal(mxm[0].words?.[2].endTimeSec, 10.7, "a word runs until the next one starts");
equal(mxm[0].words?.[4].endTimeSec, 13, "the last word runs to the line end");
equal(mxm[1].text, "", "a blank Rich Sync line is an instrumental break");
equal(mxm[2].text, "No word data", "a line with no pieces falls back to its text");
equal(mxm[2].words, undefined, "without inventing word timing");
equal(parseMusixmatchRichsync("not json").length, 0, "a broken body is empty, not a crash");

/* ---- LRC ---- */

const lrc = parseLrc(
  [
    "[ar:Someone]",
    "[00:01.5]First",
    "[00:05.00]",
    "[00:06.12][01:00.00]Chorus line",
    "[00:07.00]",
    "[00:08.00]",
    "[00:09.00]Last",
    "[00:12.00]",
  ].join("\n"),
);
equal(
  lrc.map((line) => line.text).join("|"),
  "First||Chorus line||Last||Chorus line",
  "blank breaks kept once each, repeated stamps expanded",
);
equal(lrc[0].startTimeSec, 1.5, "a one-digit fraction is tenths, not milliseconds");
equal(lrc[0].endTimeSec, 5, "a line ends where the instrumental break starts");
equal(lrc[2].endTimeSec, 7, "the second of two blanks in a row adds nothing");
equal(lrc[4].endTimeSec, 12, "and so does every line before a break");
equal(lrc[6].startTimeSec, 60, "the repeat lands at its own stamp");

const trailing = parseLrc("[00:01.00]Only\n[00:03.00]");
equal(trailing.length, 1, "a trailing blank is not a row");
equal(trailing[0].endTimeSec, 3, "but it still ends the last line");

const enhanced = parseLrc("[00:10.00]<00:10.00>Hello <00:10.50>world<00:11.20>");
equal(enhanced[0].text, "Hello world", "word stamps never reach the screen");
equal(enhanced[0].words?.length, 2, "they become word timing");
equal(enhanced[0].words?.[1].startTimeSec, 10.5, "word start");
equal(enhanced[0].words?.[1].endTimeSec, 11.2, "the closing stamp ends the last word");

const offset = parseLrc("[offset:+500]\n[00:10.00]Early");
equal(offset[0].startTimeSec, 9.5, "a positive [offset:] shows the line sooner");

console.log("lyricsParsers self-check passed");
