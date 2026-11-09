import type { Track } from "../datasource/types";

export class Queue {
  private items: Track[] = [];
  /** Pre-shuffle order of the automatic tail, so shuffle mode can be undone. */
  private originalUpcoming: Track[] | null = null;
  /** Full pre-shuffle state, captured when the whole queue was shuffled rather than just the tail. */
  private fullOriginalOrder: {
    items: Track[];
    index: number;
    manualQueueLength: number;
  } | null = null;
  private index = -1;
  private manualQueueLength = 0;

  get current(): Track | null {
    return this.index >= 0 && this.index < this.items.length
      ? this.items[this.index]
      : null;
  }

  get all(): readonly Track[] {
    return this.items;
  }

  get currentIndex(): number {
    return this.index;
  }

  get queuedManually(): number {
    return this.manualQueueLength;
  }

  /** True while an un-shuffle snapshot exists — the tail order differs from the source order. */
  get canRestoreOriginalOrder(): boolean {
    return this.originalUpcoming !== null || this.fullOriginalOrder !== null;
  }

  set(tracks: Track[], startIndex = 0, manualQueueLength = 0) {
    this.items = tracks;
    this.originalUpcoming = null;
    this.fullOriginalOrder = null;
    this.index = tracks.length === 0
      ? -1
      : Math.min(Math.max(startIndex, 0), tracks.length - 1);
    this.manualQueueLength = Math.min(
      Math.max(manualQueueLength, 0),
      Math.max(0, tracks.length - this.index - 1),
    );
  }

  add(track: Track): void {
    if (this.index < 0) {
      this.items = [track];
      this.index = 0;
      return;
    }

    this.items.splice(this.index + 1 + this.manualQueueLength, 0, track);
    this.manualQueueLength += 1;
  }

  /** Bulk "add to queue", used when a whole album or playlist is queued at once. */
  addMany(tracks: Track[]): void {
    for (const track of tracks) this.add(track);
  }

  /**
   * Replaces everything after `index` with a freshly generated list.
   *
   * Anything hand-picked that sat past `index` is gone, so the manual run shrinks to whatever
   * part of it survives before the cut — otherwise the generated tracks would be miscounted
   * as manually queued and skip-back would treat them as such.
   */
  replaceAfter(index: number, tracks: Track[]): void {
    if (index < this.index || index >= this.items.length) return;
    this.items = [...this.items.slice(0, index + 1), ...tracks];
    this.manualQueueLength = Math.min(
      this.manualQueueLength,
      Math.max(0, index - this.index),
    );
    this.originalUpcoming = null;
    this.fullOriginalOrder = null;
  }

  playNext(track: Track): void {
    if (this.index < 0) {
      this.items = [track];
      this.index = 0;
      return;
    }

    this.items.splice(this.index + 1, 0, track);
    this.manualQueueLength += 1;
  }

  get remainingAutomatic(): number {
    const automaticStart = this.index + 1 + this.manualQueueLength;
    return Math.max(0, this.items.length - automaticStart);
  }

  appendAutomaticTracks(tracks: Track[]): void {
    if (tracks.length === 0) return;
    if (this.index < 0) {
      this.items = tracks;
      this.index = 0;
      return;
    }
    const manualQueueEnd = this.index + 1 + this.manualQueueLength;
    this.items = [...this.items.slice(0, manualQueueEnd), ...tracks];
  }

  replaceAutomaticUpcoming(tracks: Track[]): void {
    if (this.index < 0) {
      this.set(tracks);
      return;
    }

    const manualQueueEnd = this.index + 1 + this.manualQueueLength;
    this.items = [...this.items.slice(0, manualQueueEnd), ...tracks];
  }

  next(wrap = true): Track | null {
    if (this.items.length === 0) return null;
    if (this.index + 1 >= this.items.length) {
      if (!wrap) return null;
      this.index = 0;
      return this.current;
    }
    this.index += 1;
    if (this.manualQueueLength > 0) this.manualQueueLength -= 1;
    return this.current;
  }

  prev(wrap = true): Track | null {
    if (this.items.length === 0) return null;
    if (this.index - 1 < 0) {
      if (!wrap) return null;
      this.index = this.items.length - 1;
      return this.current;
    }
    this.index -= 1;
    this.manualQueueLength = 0;
    return this.current;
  }

  removeAt(index: number): void {
    if (index < 0 || index >= this.items.length) return;

    const manualQueueStart = this.index + 1;
    const manualQueueEnd = this.index + 1 + this.manualQueueLength;
    const removedFromManual = index >= manualQueueStart && index < manualQueueEnd;

    this.items.splice(index, 1);

    if (removedFromManual) {
      this.manualQueueLength = Math.max(0, this.manualQueueLength - 1);
    }

    if (this.items.length === 0) {
      this.index = -1;
      this.manualQueueLength = 0;
    } else if (index <= this.index) {
      this.index = Math.max(0, this.index - 1);
    }
  }

  /**
   * Drops everything after the current track, manual and automatic alike.
   *
   * The current track keeps playing — clearing what is *next* should never stop what is
   * *now*. The remembered pre-shuffle order goes with it, since it describes tracks that no
   * longer exist.
   */
  clearUpcoming(): void {
    if (this.index < 0) {
      this.items = [];
    } else {
      this.items = this.items.slice(0, this.index + 1);
    }
    this.manualQueueLength = 0;
    this.originalUpcoming = null;
    this.fullOriginalOrder = null;
  }

  select(index: number): Track | null {
    if (index < 0 || index >= this.items.length) return null;

    const manualQueueStart = this.index + 1;
    const manualQueueEnd = manualQueueStart + this.manualQueueLength;
    this.index = index;
    this.manualQueueLength = index >= manualQueueStart && index < manualQueueEnd
      ? Math.max(0, manualQueueEnd - index - 1)
      : 0;
    return this.current;
  }

  move(sourceIndex: number, targetIndex: number, insertAfter: boolean): void {
    const manualQueueStart = this.index + 1;
    const manualQueueEnd = manualQueueStart + this.manualQueueLength;
    const sourceIsManual = sourceIndex >= manualQueueStart && sourceIndex < manualQueueEnd;
    const targetIsManual = targetIndex >= manualQueueStart && targetIndex < manualQueueEnd;
    if (
      sourceIndex <= this.index
      || targetIndex <= this.index
      || sourceIndex >= this.items.length
      || targetIndex >= this.items.length
      || sourceIndex === targetIndex
      || sourceIsManual !== targetIsManual
    ) return;

    const [track] = this.items.splice(sourceIndex, 1);
    const adjustedTargetIndex = targetIndex > sourceIndex
      ? targetIndex - 1
      : targetIndex;
    const insertIndex = adjustedTargetIndex + (insertAfter ? 1 : 0);
    this.items.splice(insertIndex, 0, track);
  }

  shuffleRemaining(manualCount: number): void {
    const manualQueueEnd = this.index + 1 + manualCount;
    const upcoming = this.items.slice(manualQueueEnd);
    if (upcoming.length <= 1) return;

    if (this.originalUpcoming === null) {
      this.originalUpcoming = [...upcoming];
    }

    for (let i = upcoming.length - 1; i > 0; i -= 1) {
      const swapIndex = Math.floor(Math.random() * (i + 1));
      [upcoming[i], upcoming[swapIndex]] = [upcoming[swapIndex], upcoming[i]];
    }

    this.items = [...this.items.slice(0, manualQueueEnd), ...upcoming];
  }

  /**
   * Shuffles the entire queue from the current track: what is playing moves to the front,
   * hand-picked entries stay right after it, and everything else — played history included —
   * goes into one shuffled pool after it. This makes every playlist track upcoming exactly once,
   * including when the current song was near the end.
   */
  shuffleAll(manualCount: number): void {
    if (this.index < 0) return;
    const current = this.items[this.index];
    const manual = this.items.slice(this.index + 1, this.index + 1 + manualCount);
    const pool = [
      ...this.items.slice(0, this.index),
      ...this.items.slice(this.index + 1 + manualCount),
    ];
    if (pool.length === 0) return;

    if (this.fullOriginalOrder === null && this.originalUpcoming === null) {
      this.fullOriginalOrder = {
        items: [...this.items],
        index: this.index,
        manualQueueLength: this.manualQueueLength,
      };
    }

    for (let i = pool.length - 1; i > 0; i -= 1) {
      const swapIndex = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[swapIndex]] = [pool[swapIndex], pool[i]];
    }

    this.items = [current, ...manual, ...pool];
    this.index = 0;
  }

  /** Starts a new repeat-all lap with every queue entry in a fresh random order. */
  shuffleForLoop(): void {
    if (this.items.length <= 1) {
      this.index = this.items.length === 0 ? -1 : 0;
      return;
    }

    for (let index = this.items.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [this.items[index], this.items[swapIndex]] = [this.items[swapIndex], this.items[index]];
    }
    this.index = 0;
    this.manualQueueLength = 0;
  }

  /**
   * Undoes a shuffle around what is playing *now*, not around where the shuffle started.
   *
   * The snapshot is taken when shuffle turns on, but by the time it turns off the listener may
   * have moved several tracks along, queued or removed songs. Rebuilding from the snapshot's
   * cursor used to jump back to the old start track (so the next skip replayed songs) and
   * dropped anything queued since. Instead, the source order is kept for tracks that still
   * exist, the cursor follows the current track, and hand-queued entries stay right after it.
   */
  restoreOriginalOrder(manualCount: number): void {
    const snapshot = this.fullOriginalOrder;
    const upcomingSnapshot = this.originalUpcoming;
    this.fullOriginalOrder = null;
    this.originalUpcoming = null;

    if (snapshot) {
      const current = this.current;
      if (!current) return;
      const manualEnd = this.index + 1 + manualCount;
      const manual = this.items.slice(this.index + 1, manualEnd);
      // Everything still in the queue apart from the current track and the manual run.
      const remaining = takeCounts([
        ...this.items.slice(0, this.index),
        ...this.items.slice(manualEnd),
      ]);
      let currentPos = snapshot.items.indexOf(current);
      if (currentPos < 0) currentPos = snapshot.items.findIndex((t) => t.id === current.id);
      if (currentPos < 0) return;

      const before = takeFrom(snapshot.items.slice(0, currentPos), remaining);
      const after = takeFrom(snapshot.items.slice(currentPos + 1), remaining);
      // Tracks added after the shuffle that the snapshot never saw keep their place at the end.
      const extra = this.items.slice(manualEnd).filter((t) => takeOne(remaining, t));
      this.items = [...before, current, ...manual, ...after, ...extra];
      this.index = before.length;
      this.manualQueueLength = manual.length;
      return;
    }

    if (!upcomingSnapshot) return;
    const manualQueueEnd = this.index + 1 + manualCount;
    // Only what is still upcoming comes back: tracks already played from the shuffled tail
    // must not be put back in front of the listener.
    const liveTail = this.items.slice(manualQueueEnd);
    const remaining = takeCounts(liveTail);
    const restored = takeFrom(upcomingSnapshot, remaining);
    const extra = liveTail.filter((t) => takeOne(remaining, t));
    this.items = [...this.items.slice(0, manualQueueEnd), ...restored, ...extra];
  }
}

function takeCounts(tracks: readonly Track[]): Map<Track, number> {
  const counts = new Map<Track, number>();
  for (const track of tracks) counts.set(track, (counts.get(track) ?? 0) + 1);
  return counts;
}

function takeOne(counts: Map<Track, number>, track: Track): boolean {
  const count = counts.get(track) ?? 0;
  if (count <= 0) return false;
  counts.set(track, count - 1);
  return true;
}

function takeFrom(tracks: readonly Track[], counts: Map<Track, number>): Track[] {
  return tracks.filter((track) => takeOne(counts, track));
}
