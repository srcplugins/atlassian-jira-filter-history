// One writer per filter: every change to a filter's records (an event, a delete, a recreate, Delete
// history, the cleanup, an erasure) runs while holding the filter's lease, a storage key written
// only if absent. App storage has no compare-and-set, so a lease that outlives its holder (a
// function that stopped mid-way) is taken over once its time has passed.
import { randomUUID } from 'node:crypto';
import { UserError } from './shared/jira.mjs';
import { StorageUnavailable, type Store } from './integration';
import { leaseKey, type Lease } from './versions';

// Every function that writes a filter's records stops within 25 seconds, and work holding a lease
// is told to stop well inside this (the cleanup and erasure check as they go).
const leaseLife = 60_000;
// Work holding a lease stops this long before the lease runs out, leaving time for its last write
// and the release.
const workMargin = 15_000;
// Between tries for a lease another invocation holds.
const pollEvery = 200;
// A takeover's claimant can stop too, and its claim is then taken over in turn: at most this deep.
const claimHops = 8;

/** Another invocation is changing this filter's records. */
export class FilterBusy extends UserError {
  constructor() {
    super('This filter is being updated. Try again in a moment.');
  }
}

export function createLeases({
  store,
  now,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  store: Store;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  /**
   * Claims the right to remove one stopped lease: of all the invocations that find it stopped, only
   * the one whose claim is written first, for as long as a lease lasts. A claim whose claimant
   * stopped is taken over the same way, by a claim on it. Returns the claim keys written or found,
   * or nothing when another invocation has the claim.
   */
  async function claim(key: string, stopped: string, token: string) {
    const walked: string[] = [];
    let claimKey = `takeover:${key}:${stopped}`;
    for (let hop = 0; hop < claimHops; hop++) {
      walked.push(claimKey);
      if (await store.create<Lease>(claimKey, { token, until: now() + leaseLife })) return walked;
      // Refused: claimed by another, or the write landed and only its answer was lost.
      const held = await store.get<Lease>(claimKey);
      if (held?.token === token) return walked;
      if (!held || !(held.until < now())) return undefined;
      claimKey = `${claimKey}:${held.token}`;
    }
    return undefined;
  }

  /**
   * Takes the filter's lease, waiting up to `wait` milliseconds. Returns when the lease runs out,
   * or nothing when another holds it. A storage failure is tried again with the same token, so a
   * lease or claim this invocation wrote still counts; it is thrown only when the time is up.
   */
  async function take(key: string, token: string, wait: number) {
    const deadline = now() + wait;
    for (;;) {
      let failure: unknown;
      try {
        const lease: Lease = { token, until: now() + leaseLife };
        if (await store.create(key, lease)) return lease.until;
        // Refused: held by another, or the write landed and only its answer was lost.
        const held = await store.get<Lease>(key);
        if (held?.token === token) return held.until;
        const walked = held && held.until < now() && (await claim(key, held.token, token));
        if (walked) {
          // Its holder has stopped, and this invocation alone may remove it; the next turn takes
          // the lease as any other does, so no lease is ever written over another.
          if ((await store.get<Lease>(key))?.token === held.token) await store.delete(key);
          // The claims are spent: the lease they name is gone for good, as tokens are never reused.
          await store.deleteKeys(walked.reverse()).catch(() => undefined);
          continue;
        }
      } catch (error) {
        if (!(error instanceof StorageUnavailable)) throw error;
        failure = error;
      }
      if (now() + pollEvery > deadline) {
        if (failure) throw failure;
        return undefined;
      }
      await sleep(pollEvery + Math.floor(Math.random() * pollEvery));
    }
  }

  /**
   * Runs `work` holding the filter's lease; throws FilterBusy if it isn't free within `wait`.
   * `work` gets the time by which it must stop, well before the lease runs out: work that can run
   * long checks it as it goes and stops with FilterBusy, to be continued later.
   */
  async function hold<T>(
    filterId: string,
    wait: number,
    work: (deadline: number) => Promise<T>,
  ): Promise<T> {
    const key = leaseKey(filterId);
    const token = randomUUID();
    const until = await take(key, token, wait);
    if (until === undefined) throw new FilterBusy();
    try {
      return await work(until - workMargin);
    } finally {
      // Released only while still this invocation's; a failed release is taken over once it has
      // run out.
      try {
        if ((await store.get<Lease>(key))?.token === token) await store.delete(key);
      } catch {
        // Taken over.
      }
    }
  }

  /** Stops work holding a lease once its deadline has passed. */
  function inTime(deadline: number) {
    if (now() > deadline) throw new FilterBusy();
  }

  return { hold, inTime };
}
