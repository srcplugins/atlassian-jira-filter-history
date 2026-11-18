// Atlassian's personal data reporting: the app stores the account IDs of each change's actor and
// each filter's owner, so each week it reports those IDs and erases the ones Atlassian says are
// closed.
import type { PrivacyDeps, Store } from './integration';
import { createLeases, FilterBusy } from './lease';
import {
  accountKey,
  accountPrefix,
  clearedKey,
  deletedKey,
  indexKey,
  newestVersion,
  recentKey,
  usePrefix,
  versionKey,
  versionPrefix,
  withoutAccounts,
} from './versions';
import type { Account, Index, Tombstone, Use } from './versions';

// Erasure stops after this long, inside its function's 900-second limit (manifest); the next
// week's report finds the same accounts closed and continues with the filters left.
const eraseBudget = 840_000;
// The reporting API takes at most 90 accounts per request.
const reportBatch = 90;
// How long erasure waits for a filter that is being changed; it comes back to it next week.
const filterWait = 2000;

export function createPrivacyReport({
  store,
  privacy,
  now = Date.now,
}: { store: Store; now?: () => number } & PrivacyDeps) {
  const leases = createLeases({ store, now });

  /**
   * Empties every `actor` and `owner` naming a closed account in one record. It is written only if
   * the record still exists, read strictly just before, so one another step removed meanwhile
   * isn't brought back.
   */
  async function scrub(key: string, value: unknown, closed: Set<string>) {
    if (value === undefined || !withoutAccounts(value, closed)) return;
    const current = await store.get<unknown>(key);
    const scrubbed = current === undefined ? undefined : withoutAccounts(current, closed);
    if (scrubbed !== undefined) await store.set(key, scrubbed);
  }

  /**
   * Erases closed accounts from one filter's versions, index, recency entry, tombstone, kept
   * deletion and trace, then removes the account's marker for it, holding the filter's lease so a
   * change recorded at the same time can't write them back: a change registers its accounts
   * holding the same lease, so one made after this marks the filter again. Stops with FilterBusy
   * before the lease runs out; the marker stays for next week.
   */
  async function scrubFilter(filterId: string, closed: Set<string>, marker: string) {
    await leases.hold(filterId, filterWait, async (deadline) => {
      const seen = new Set<string>();
      for await (const page of store.pages<unknown>(versionPrefix(filterId)))
        for (const { key, value } of page) {
          leases.inTime(deadline);
          seen.add(key);
          await scrub(key, value, closed);
        }
      const index = await store.get<Index>(indexKey(filterId));
      // A query can miss a version written moments before; a get can't.
      for (const { at } of index?.entries ?? []) {
        const key = versionKey(filterId, at);
        if (seen.has(key)) continue;
        leases.inTime(deadline);
        await scrub(key, await store.get<unknown>(key), closed);
      }
      leases.inTime(deadline);
      await scrub(indexKey(filterId), index, closed);
      const newest = newestVersion(filterId, index);
      if (newest) {
        const recent = recentKey(filterId, newest.at);
        await scrub(recent, await store.get<unknown>(recent), closed);
      }
      const tombstone = await store.get<Tombstone>(deletedKey(filterId));
      await scrub(deletedKey(filterId), tombstone, closed);
      if (tombstone?.trash)
        await scrub(tombstone.trash, await store.get<unknown>(tombstone.trash), closed);
      await scrub(clearedKey(filterId), await store.get<unknown>(clearedKey(filterId)), closed);
      await store.delete(marker);
    });
  }

  /**
   * Erases a closed account from each filter marked as holding it, removing each marker once its
   * filter is done, so a run that stops continues next week where it stopped. A filter being
   * changed, or that fails, keeps its marker for next week. The account is forgotten in two steps
   * a week apart, as a storage query can miss a marker written moments before: this week's report
   * marks it as being erased, and next week's forgets it if it finds no marker. A change that
   * stores the ID meanwhile marks its filter, then writes the account afresh. Returns whether the
   * deadline came first, and how many filters failed.
   */
  async function erase(account: Account, closed: Set<string>, deadline: number) {
    const { accountId } = account;
    let found = false;
    let skipped = false;
    let failed = 0;
    for await (const page of store.pages<Use>(usePrefix(accountId)))
      for (const { key, value } of page) {
        if (now() > deadline) return { stopped: true, failed };
        found = true;
        try {
          await scrubFilter(value.filterId, closed, key);
        } catch (error) {
          skipped = true;
          if (!(error instanceof FilterBusy)) failed++;
        }
      }
    if (skipped) return { stopped: false, failed };
    const current = await store.get<Account>(accountKey(accountId));
    if (!current) return { stopped: false, failed };
    if (!current.erasing || found) {
      await store.set<Account>(accountKey(accountId), { ...current, erasing: now() });
      return { stopped: false, failed };
    }
    await store.delete(accountKey(accountId));
    // A change that wrote the account afresh just before this delete left a marker this finds:
    // the account is put back, so next week's report erases what it stored.
    if ((await store.list<Use>(usePrefix(accountId), 1)).length)
      await store.set<Account>(accountKey(accountId), {
        accountId,
        since: current.since,
      });
    return { stopped: false, failed };
  }

  return async () => {
    const deadline = now() + eraseBudget;
    const accounts = await store.list<Account>(accountPrefix, Infinity);
    if (!accounts.length) return;
    const reported = new Set(accounts.map(({ value }) => value.accountId));
    // One request per 90 accounts, in turn: a refused request leaves its accounts for next week
    // and the others still count.
    const closed = new Set<string>();
    let failed = 0;
    for (let start = 0; start < accounts.length; start += reportBatch) {
      try {
        const updates = await privacy.reportPersonalData(
          accounts
            .slice(start, start + reportBatch)
            .map(({ value }) => ({ accountId: value.accountId, updatedAt: value.since })),
        );
        // `updated` asks for a fresh copy of personal data the app doesn't keep: only the ID.
        for (const update of updates ?? [])
          if (update.status === 'closed' && reported.has(update.accountId))
            closed.add(update.accountId);
      } catch {
        failed++;
      }
    }
    // A filter that fails is left for next week; the other accounts are still erased.
    let unerased = 0;
    for (const { value } of accounts) {
      if (!closed.has(value.accountId)) continue;
      let outcome;
      try {
        outcome = await erase(value, closed, deadline);
      } catch {
        outcome = { stopped: false, failed: 1 };
      }
      unerased += outcome.failed;
      if (outcome.stopped) break;
    }
    // The run fails, so the logs show it, after erasing what the answered requests reported closed.
    // Counts only: never an account ID.
    const problems = [
      ...(failed
        ? [`${failed} of ${Math.ceil(accounts.length / reportBatch)} requests failed`]
        : []),
      ...(unerased
        ? [`${unerased} ${unerased === 1 ? 'filter' : 'filters'} couldn't be erased`]
        : []),
    ];
    if (problems.length)
      throw new Error(
        `Personal data report: ${problems.join(' and ')}; next week's report ${unerased ? 'tries again' : 'sends them again'}.`,
      );
  };
}
