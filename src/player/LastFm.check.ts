/**
 * Self-check for the Last.fm listen tracking: when a play starts over, and when a duration that
 * arrives late still gives the track a scrobble threshold. Runs via `npm run check`.
 */
export {};

import { LastFmService } from "./LastFm";
import type { Track } from "../datasource/types";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

type Tracked = { scrobbled: boolean; listenedSec: number; payload: { duration?: number } } | null;
const tracked = (): Tracked => (LastFmService as unknown as { tracked: Tracked }).tracked;
const markScrobbled = () => {
  const state = tracked();
  if (state) state.scrobbled = true;
};

const track = { id: "t1", source: "youtube", title: "Song", artist: "Artist" } as Track;
const update = (currentTime: number, duration = 200) => LastFmService.updatePlayback({
  track, status: "playing", currentTime, duration, enabled: true,
});

// Repeat-one: the track comes round again from the start, so it is a new listen.
update(150);
markScrobbled();
update(199);
check(tracked()?.scrobbled === true, "still the same listen near the end");
update(0.5);
check(tracked()?.scrobbled === false, "a restart from the top is a new listen");

// A small seek backwards near the start is not a restart.
update(10);
markScrobbled();
update(2);
check(tracked()?.scrobbled === true, "a seek back early in the track is the same listen");

// A duration that is unknown at first is picked up once the stream reports it.
const other = { id: "t2", source: "youtube", title: "Other", artist: "Artist" } as Track;
LastFmService.updatePlayback({ track: other, status: "loading", currentTime: 0, duration: 0, enabled: true });
check(tracked()?.payload.duration === undefined, "no duration while loading");
LastFmService.updatePlayback({ track: other, status: "playing", currentTime: 1, duration: 180, enabled: true });
check(tracked()?.payload.duration === 180, "late duration is adopted");

console.log("LastFm: ok");
