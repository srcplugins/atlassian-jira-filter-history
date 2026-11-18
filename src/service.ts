import { randomUUID } from 'node:crypto';
import { UserError } from './shared/jira.mjs';
import { isRecord } from './shared/response.mjs';
import type { Jira, Store } from './integration';
import { createLeases, FilterBusy } from './lease';
import {
  accountKey,
  changedFields,
  clearedKey,
  isAccountId,
  deletedKey,
  expiryKey,
  expiryPrefix,
  indexKey,
  isFilterId,
  isTime,
  isVersion,
  newestVersion,
  recentKey,
  recentPrefix,
  trashKey,
  trashPrefix,
  useKey,
  versionKey,
  versionPositions,
  versionPrefix,
  type Account,
  type Cleared,
  type Deleted,
  type Entry,
  type Expiry,
  type Field,
  type Index,
  type Recent,
  type Tombstone,
  type Use,
  type Version,
} from './versions';
export { UserError, FilterBusy };

// The overview reads at most this many of the most recently changed filters and deleted filters;
// a site with more is marked partial.
const overviewLimit = 1000;
// Each filter keeps its newest versions up to this many, plus the entry before them so the oldest
// shown can say what it changed; a new version removes the older ones.
const keptVersions = 100;
// Saves that changed nothing are kept, the newest up to this many, so that an event arriving late
// is compared with the events around it; an older one is removed.
const keptQuiet = 50;
// A deleted filter's tombstone and kept history are removed this long after the delete.
const retention = 90 * 24 * 60 * 60 * 1000;
// Moving or deleting a long history stops after this long from the request, inside Forge's
// 25-second limit, and asks the user to try again; each step is resumable.
const workBudget = 18_000;
// The daily cleanup stops after this long, inside its function's 300-second limit (manifest).
const cleanupBudget = 240_000;
// The cleanup skips an entry it can't remove and stops after this many, as storage is then failing.
const cleanupFailures = 25;
// A recreate claim younger than this may belong to a recreate still running (25 seconds at most).
const claimWait = 30_000;
// How long each caller waits for a filter's lease: an event then asks Forge to deliver it again, a
// screen asks the user to try again, and the cleanup and erasure come back to it next time.
const eventWait = 10_000;
const userWait = 5_000;
const cleanupWait = 1_000;
// Rovo gets the ten newest versions, each text cut to this many characters.
const rovoVersions = 10;
const rovoText = 4000;

const queryFields: Field[] = ['name', 'description', 'jql'];
const unavailable = () => new UserError("This filter isn't available to you.");
const busyRecreating = () =>
  new UserError('This filter is already being recreated. Try again in a minute.');
const notRecorded = () => new UserError('That version is no longer recorded.');

/** Jira sends the change time as a string of epoch milliseconds; a number is accepted too. */
const eventTime = (value: unknown) =>
  typeof value === 'string' && /^[1-9]\d{0,12}$/.test(value) ? Number(value) : value;

/** An account ID from an event; Jira's placeholder `unknown` and anything malformed are no one. */
const accountOf = (value: unknown) => (isAccountId(value) && value !== 'unknown' ? value : '');

type Facts = {
  filter: Record<string, unknown>;
  filterId: string;
  at: number;
  actor: string;
  owner: string;
};

/**
 * What every filter event says: the filter, its ID, time, actor and owner, or nothing when the
 * event is malformed. Jira documents the actor as optional; the time isn't documented, so the
 * event's arrival stands in for it. A null field counts as absent.
 */
function eventFacts(event: Record<string, unknown>, arrived: number): Facts | undefined {
  const filter = event.filter;
  const at =
    event.timestamp === undefined || event.timestamp === null
      ? arrived
      : eventTime(event.timestamp);
  if (
    !isRecord(filter) ||
    !isFilterId(String(filter.id ?? '')) ||
    !isTime(at) ||
    (event.atlassianId !== undefined &&
      event.atlassianId !== null &&
      typeof event.atlassianId !== 'string')
  )
    return undefined;
  const owner = isRecord(filter.owner) ? filter.owner.accountId : filter.owner;
  return {
    filter,
    filterId: String(filter.id),
    at,
    actor: accountOf(event.atlassianId),
    owner: accountOf(owner),
  };
}

/**
 * The version a Jira filter event describes, or nothing when the event is malformed. Jira leaves
 * out a description over 10,000 characters, and JQL over 90,000.
 */
function eventVersion(event: Record<string, unknown>, facts: Facts): Version | undefined {
  const { filter } = facts;
  if (
    typeof filter.name !== 'string' ||
    typeof filter.jql !== 'string' ||
    (filter.description !== undefined &&
      filter.description !== null &&
      typeof filter.description !== 'string')
  )
    return undefined;
  return {
    filterId: facts.filterId,
    at: facts.at,
    actor: facts.actor,
    name: filter.name,
    description: typeof filter.description === 'string' ? filter.description : '',
    ...(filter.description === undefined ? { descriptionMissing: true as const } : {}),
    jql: filter.jql,
    owner: facts.owner,
    restored: event.selfGenerated === true && event.eventType !== 'avi:jira:created:filter',
    recreated: event.selfGenerated === true && event.eventType === 'avi:jira:created:filter',
  };
}

/** The index entry for a stored version. */
const entryOf = (version: Version): Entry => ({
  at: version.at,
  actor: version.actor,
  changed: [],
  ...(version.restored ? { restored: true as const } : {}),
  ...(version.recreated ? { recreated: true as const } : {}),
  ...(version.descriptionMissing ? { noDescription: true as const } : {}),
});

/** Whether two events say the same thing: a redelivery. */
const sameEvent = (a: Version, b: Version) =>
  a.actor === b.actor &&
  a.name === b.name &&
  a.description === b.description &&
  Boolean(a.descriptionMissing) === Boolean(b.descriptionMissing) &&
  a.jql === b.jql &&
  a.owner === b.owner &&
  a.restored === b.restored &&
  a.recreated === b.recreated;

const requireFilterId = (value: unknown) => {
  if (!isFilterId(value)) throw new UserError('Choose a saved filter.');
  return value;
};

/** The history's versions, newest first, without their texts. */
const summaries = (index: Index | undefined) =>
  index
    ? versionPositions(index)
        .reverse()
        .map((position) => {
          const { at, actor, changed, restored, recreated } = index.entries[position]!;
          return {
            at,
            actor,
            changed,
            restored: Boolean(restored),
            recreated: Boolean(recreated),
          };
        })
    : [];

/** A stored version's texts, for the screen. */
const textOf = (version: Version) => ({
  at: version.at,
  actor: version.actor,
  name: version.name,
  description: version.description,
  ...(version.descriptionMissing ? { descriptionMissing: true as const } : {}),
  jql: version.jql,
  owner: version.owner,
  restored: version.restored,
  recreated: version.recreated,
});

/** A text cut for Rovo, and whether it was cut. */
const forRovo = (text: string) =>
  text.length > rovoText ? { text: text.slice(0, rovoText), cut: true } : { text, cut: false };

const adminOnly = () => new UserError("Only Jira administrators can delete a filter's history.");

/** A deleted filter's record without its recreate claim. */
const unclaimed = (deleted: Deleted): Deleted => {
  const copy = { ...deleted };
  delete copy.recreating;
  return copy;
};

export function createService({
  jira,
  store,
  now = Date.now,
  sleep,
}: {
  jira: Jira;
  store: Store;
  /** The clock for event arrival, recreate claims, leases and work budgets. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const leases = createLeases({ store, now, ...(sleep ? { sleep } : {}) });

  /**
   * Registers each account ID before a filter's records hold it: with when the app first stored
   * it, for the weekly personal data report, and with the filter, for erasing a closed account. A
   * failed registration fails the write, so it is retried. Called holding the filter's lease, which
   * erasure holds while it scrubs the filter and removes its marker. The marker goes first, then
   * the account is written afresh if erasure has begun forgetting it, so the next week's report
   * finds the marker and keeps the account.
   */
  async function register(filterId: string, ...ids: string[]) {
    for (const accountId of new Set(ids.filter(isAccountId))) {
      if (!(await store.get<Use>(useKey(accountId, filterId))))
        await store.set<Use>(useKey(accountId, filterId), { filterId });
      const account = await store.get<Account>(accountKey(accountId));
      if (!account || account.erasing)
        await store.set<Account>(accountKey(accountId), {
          accountId,
          since: account?.since ?? new Date(now()).toISOString(),
        });
    }
  }

  /** The filter as the viewer sees it in Jira; an administrator sees every filter. */
  async function visible(filterId: string, admin: boolean) {
    const filter = (await jira.visibleFilters([filterId], admin)).get(filterId);
    if (!filter) throw unavailable();
    return filter;
  }

  /** A reader of one filter's stored versions by time, each read once per operation. */
  function contents(filterId: string) {
    const cache = new Map<number, Version | undefined>();
    const read = async (at: number) => {
      if (!cache.has(at)) cache.set(at, await store.get<Version>(versionKey(filterId, at)));
      return cache.get(at);
    };
    return Object.assign(read, { put: (version: Version) => cache.set(version.at, version) });
  }
  type Contents = ReturnType<typeof contents>;

  /**
   * The fields an entry changed against the one before it. After a version whose description Jira
   * didn't send, the description is compared with the last one it sent, so a change behind it is
   * still shown, and credited to the first editor whose description Jira sent.
   */
  async function changesAt(entries: Entry[], position: number, read: Contents) {
    const entry = entries[position]!;
    const before = entries[position - 1];
    if (!before) return [];
    const previous = await read(before.at);
    const version = await read(entry.at);
    if (!previous || !version) return entry.changed;
    let compared = previous;
    if (previous.descriptionMissing)
      for (let known = position - 2; known >= 0; known--) {
        if (entries[known]!.noDescription) continue;
        const sent = await read(entries[known]!.at);
        if (sent && !sent.descriptionMissing) {
          compared = { ...previous, description: sent.description };
          delete compared.descriptionMissing;
        }
        break;
      }
    return changedFields(compared, version);
  }

  /**
   * Works out again what entries changed from `from` on: `count` of them, then each that follows
   * an entry without a description, as its comparison reaches back further.
   */
  async function refresh(entries: Entry[], from: number, count: number, read: Contents) {
    for (let position = from; position < entries.length; position++) {
      if (position >= from + count && !entries[position - 1]?.noDescription) break;
      entries[position] = {
        ...entries[position]!,
        changed: await changesAt(entries, position, read),
      };
    }
  }

  /**
   * The index with the event in its place by time, or nothing when it adds nothing: a redelivery,
   * or an event older than the history kept. A different event at the same millisecond replaces
   * the first (the later delivery wins). Its neighbours' changes are worked out again, so a late
   * event turns the save after it into a version when that save undid it.
   */
  async function place(index: Index, version: Version, read: Contents) {
    const entries = [...index.entries];
    let position = entries.findIndex((entry) => entry.at >= version.at);
    if (position < 0) position = entries.length;
    const same = entries[position]?.at === version.at;
    if (same) {
      const stored = await read(version.at);
      if (stored && sameEvent(stored, version)) return undefined;
    } else if (index.trimmed && position === 0) return undefined;
    read.put(version);
    entries.splice(position, same ? 1 : 0, entryOf(version));
    await refresh(entries, position, 2, read);
    return { ...index, entries };
  }

  /**
   * Keeps an index's newest versions and saves that changed nothing; returns it with the times
   * whose stored contents no entry needs any more. What each kept entry changed stays as worked
   * out with the removed saves in place: one may have held the only description sent before it.
   */
  function trimIndex(index: Index) {
    let entries = [...index.entries];
    let trimmed = Boolean(index.trimmed);
    const removed: number[] = [];
    const versions = versionPositions(index);
    if (versions.length > keptVersions) {
      // The entry before the oldest version kept stays, so that version can show what it changed.
      const base = versions[versions.length - keptVersions]! - 1;
      removed.push(...entries.slice(0, base).map(({ at }) => at));
      entries = entries.slice(base);
      trimmed = true;
    }
    const kept = (): Index => ({ entries, ...(trimmed ? { trimmed: true as const } : {}) });
    const quiet = entries
      .map((_, position) => position)
      .filter((position) => position > 0 && !isVersion(kept(), position));
    // Newest last, so removing from the end keeps the earlier positions.
    for (const position of quiet.slice(0, Math.max(0, quiet.length - keptQuiet)).reverse()) {
      removed.push(entries[position]!.at);
      entries.splice(position, 1);
    }
    return { index: kept(), removed };
  }

  /** The writes that move the overview's entry from one index's newest version to another's. */
  function recency(filterId: string, before: Index | undefined, after: Index | undefined) {
    const old = newestVersion(filterId, before);
    const next = newestVersion(filterId, after);
    const sets: { key: string; value: Recent }[] = [];
    const deletes: string[] = [];
    if (old && old.at !== next?.at) deletes.push(recentKey(filterId, old.at));
    if (next && (old?.at !== next.at || old.actor !== next.actor))
      sets.push({ key: recentKey(filterId, next.at), value: next });
    return { sets, deletes };
  }

  /**
   * Removes stored versions no entry points to. Best effort: such a version is never shown, and
   * goes with the filter's history.
   */
  async function removeContents(filterId: string, times: number[]) {
    if (!times.length) return;
    await store.deleteKeys(times.map((at) => versionKey(filterId, at))).catch(() => undefined);
  }

  /** A deleted filter whose history is kept, with the key of its record. */
  async function deletedFilter(filterId: string) {
    const tombstone = await store.get<Tombstone>(deletedKey(filterId));
    if (!tombstone?.trash) return undefined;
    const deleted = await store.get<Deleted>(tombstone.trash);
    return deleted && { key: tombstone.trash, at: tombstone.at, deleted };
  }
  type Kept = NonNullable<Awaited<ReturnType<typeof deletedFilter>>>;

  /**
   * Removes a deleted filter's kept history record and index; the tombstone stays to ignore late
   * events until it expires, with its expiry entry again in case the cleanup already removed both.
   * Its stored versions go after it, or with the tombstone, which names the filter it was
   * recreated as, or says an administrator deleted the history.
   */
  async function forget(
    filterId: string,
    kept: { key: string; at: number },
    extra: string[],
    mark: { recreatedAs: string } | { cleared: true },
  ) {
    const tombstone: Tombstone = { at: kept.at, ...mark };
    await store.setTogether(
      [
        { key: deletedKey(filterId), value: tombstone },
        { key: expiryKey(filterId, kept.at), value: { filterId, at: kept.at } },
      ],
      [kept.key, indexKey(filterId), ...extra],
    );
  }

  /**
   * Writes a deleted filter's record only while its tombstone still points to it: an
   * administrator's Delete history or the cleanup may have removed it since it was read.
   */
  async function keep(filterId: string, key: string, deleted: Deleted) {
    if ((await store.get<Tombstone>(deletedKey(filterId)))?.trash !== key) return false;
    await store.set<Deleted>(key, deleted);
    return true;
  }

  /** Deletes one page of a filter's stored versions; false when none are left. */
  async function deleteVersions(filterId: string) {
    const keys = (await store.list(versionPrefix(filterId), 100)).map(({ key }) => key);
    if (keys.length) await store.deleteKeys(keys);
    return keys.length > 0;
  }

  /** Runs `step` until it reports nothing left, or fails with `unfinished` after the deadline. */
  async function within(
    step: () => Promise<boolean>,
    unfinished: () => UserError,
    deadline = now() + workBudget,
  ) {
    while (await step()) if (now() > deadline) throw unfinished();
  }

  /** When and by whom the filter's earlier history was last deleted, if it was. */
  const cleared = async (filterId: string) =>
    (await store.get<Cleared>(clearedKey(filterId))) ?? null;

  /**
   * The writes that keep a history for a filter deleted before any change was recorded, once a
   * change made before the delete arrives: its record, from what the delete event said, or else
   * from the newest entry's version, and the tombstone pointing to it.
   */
  function keepFor(filterId: string, tombstone: Tombstone, newest: Version | undefined) {
    const key = trashKey(filterId, tombstone.at);
    const deleted: Deleted = {
      filterId,
      at: tombstone.at,
      actor: tombstone.actor ?? '',
      name: tombstone.name ?? newest?.name ?? '',
      owner: tombstone.owner || newest?.owner || '',
    };
    return [
      { key, value: deleted },
      { key: deletedKey(filterId), value: { at: tombstone.at, trash: key } satisfies Tombstone },
    ];
  }

  /**
   * Where a moving history goes: the filter it was recreated as or, when that filter was deleted
   * and recreated in turn, the newest along the way; with the tombstone if that one is deleted. A
   * filter along the way whose own move hasn't finished has it finished first, so histories arrive
   * oldest first and after its record of a deleted history; without `deadline` (called holding the
   * destination's lease) that throws FilterBusy instead, for the next try.
   */
  async function destination(to: string, deadline?: number) {
    for (let hop = 0; hop < 20; hop++) {
      const tombstone = await store.get<Tombstone>(deletedKey(to));
      if (tombstone?.recreatedAs) {
        to = tombstone.recreatedAs;
        continue;
      }
      const pending = tombstone?.trash && (await store.get<Deleted>(tombstone.trash))?.recreatedAs;
      if (!pending) return { to, tombstone };
      if (deadline === undefined) throw new FilterBusy();
      const from = to;
      await leases.hold(from, userWait, async (held) => {
        const still = await deletedFilter(from);
        if (still?.deleted.recreatedAs)
          await moveHistory(from, still, still.deleted.recreatedAs, Math.min(deadline, held));
      });
    }
    throw new FilterBusy();
  }

  /**
   * Writes a deleted filter's versions under the filter it was recreated as and lists them ahead of
   * that filter's own, holding its lease. Done once: entries already there are left as they are.
   * History an administrator deleted since, on the filter or kept for it deleted, isn't brought
   * back. A deleted filter keeps the history for its owner, without an entry in the overview's
   * recency index. Stops with FilterBusy past the deadline, before its last write.
   */
  async function mergeHistory(
    index: Index,
    moved: Version[],
    to: string,
    tombstone: Tombstone | undefined,
    deadline: number,
  ) {
    const since = (await cleared(to))?.at ?? 0;
    if (tombstone?.cleared || index.entries.at(-1)!.at < since) return;
    await register(to, ...moved.flatMap(({ actor, owner }) => [actor, owner]));
    await store.setMany(moved.map((value) => ({ key: versionKey(to, value.at), value })));
    const target = (await store.get<Index>(indexKey(to))) ?? { entries: [] };
    const earlier = new Set(index.entries.map(({ at }) => at));
    if (target.entries.some(({ at }) => earlier.has(at))) return;
    const entries = [...index.entries, ...target.entries].sort((a, b) => a.at - b.at);
    const read = contents(to);
    for (const version of moved) read.put(version);
    await refresh(entries, index.entries.length, 1, read);
    const merged: Index = { entries, ...(index.trimmed ? { trimmed: true as const } : {}) };
    const { index: next, removed } = trimIndex(merged);
    const { sets, deletes } = tombstone ? { sets: [], deletes: [] } : recency(to, target, next);
    const kept =
      tombstone && !tombstone.trash
        ? keepFor(to, tombstone, await read(next.entries.at(-1)!.at))
        : [];
    leases.inTime(deadline);
    await store.setTogether([{ key: indexKey(to), value: next }, ...sets, ...kept], deletes);
    await removeContents(to, removed);
  }

  /**
   * Moves the record of an earlier deleted history to a recreated filter, unless the recreated
   * filter's own history was deleted later. Called holding the recreated filter's lease.
   */
  async function moveCleared(from: string, to: string) {
    const record = await store.get<Cleared>(clearedKey(from));
    if (!record) return;
    const later = await store.get<Cleared>(clearedKey(to));
    if (!later || later.at < record.at) {
      await register(to, record.actor);
      await store.set(clearedKey(to), record);
    }
    await store.delete(clearedKey(from));
  }

  /**
   * Moves a deleted filter's history to the filter it was recreated as, holding the new filter's
   * lease: its stored versions, then its entries ahead of the new filter's own, then its record of
   * a deleted history. Each step can run again; the deleted filter's record goes last.
   */
  async function moveHistory(from: string, kept: Kept, to: string, deadline: number) {
    const index = await store.get<Index>(indexKey(from));
    const { to: target } = await destination(to, deadline);
    const moved: Version[] = [];
    if (index?.entries.length) {
      const listed = new Map(
        (await store.list<Version>(versionPrefix(from), Infinity)).map(({ value }) => [
          value.at,
          value,
        ]),
      );
      for (const { at } of index.entries) {
        // A query can lag a write made moments before; a get can't.
        const version = listed.get(at) ?? (await store.get<Version>(versionKey(from, at)));
        if (version) moved.push({ ...version, filterId: target });
      }
      if (now() > deadline) throw new FilterBusy();
    }
    await leases.hold(target, userWait, async (held) => {
      // Deleted or recreated meanwhile: the next try follows it.
      const { to: still, tombstone } = await destination(target);
      if (still !== target) throw new FilterBusy();
      if (index?.entries.length)
        await mergeHistory(index, moved, target, tombstone, Math.min(deadline, held));
      await moveCleared(from, target);
    });
    await forget(from, kept, [], { recreatedAs: to });
    // The deleted filter's own copies; any left go with its tombstone.
    await within(
      () => deleteVersions(from),
      () => new FilterBusy(),
      deadline,
    ).catch(() => undefined);
  }

  /**
   * Removes everything kept for an expired deleted filter: its versions (finishing a recreate's
   * move instead, so the recreated filter keeps them), index, record, tombstone and the record of a
   * deleted history. Filter IDs are never reused, so whatever an overlapping event or recreate left
   * under this ID goes too.
   */
  async function purge(filterId: string) {
    await leases.hold(filterId, cleanupWait, async (deadline) => {
      const kept = await deletedFilter(filterId);
      const recreatedAs = kept?.deleted.recreatedAs;
      if (kept && recreatedAs)
        await moveHistory(filterId, kept, recreatedAs, Math.min(deadline, now() + workBudget));
      // A long history is removed over several days' runs, each stopping inside its lease.
      await within(
        () => deleteVersions(filterId),
        () => new FilterBusy(),
        deadline,
      );
      const tombstone = await store.get<Tombstone>(deletedKey(filterId));
      // A deleted filter has no entry in the overview's recency index, unless one was left.
      const newest = newestVersion(filterId, await store.get<Index>(indexKey(filterId)));
      await store.setTogether(
        [],
        [
          indexKey(filterId),
          ...(newest ? [recentKey(filterId, newest.at)] : []),
          ...(tombstone?.trash ? [tombstone.trash] : []),
          clearedKey(filterId),
          deletedKey(filterId),
        ],
      );
    });
  }

  /**
   * Creates the filter in Jira at most once per deleted filter, holding its lease: the recreate is
   * claimed in storage first, and a later call that finds an older claim without a result looks
   * for the filter it made instead of creating another: the first of the owner's filters with the
   * claimed version's name and query made after the claim. Returns the new filter's ID.
   */
  async function createOnce(filterId: string, kept: Kept, version: Version, viewer: string) {
    let record = kept.deleted;
    const claim = record.recreating;
    if (claim && now() - claim.since < claimWait) throw busyRecreating();
    const remember = async (newId: string) => {
      let stillKept;
      try {
        stillKept = await keep(filterId, kept.key, { ...unclaimed(record), recreatedAs: newId });
      } catch {
        throw new UserError(
          `The filter was recreated in Jira with ID ${newId}, but its history hasn't moved there yet. Try again in a minute to finish.`,
        );
      }
      if (!stillKept)
        throw new UserError(
          `The filter was recreated in Jira with ID ${newId}, but its history was deleted in the meantime.`,
        );
      kept.deleted = { ...unclaimed(record), recreatedAs: newId };
      return newId;
    };
    /** The filter an earlier recreate made after its claim, if Jira lists it now. */
    const adopt = async () => {
      if (!claim) return undefined;
      const claimed = await store.get<Version>(versionKey(filterId, claim.at));
      return (
        claimed &&
        (await jira.ownFilters(claimed.name, viewer))
          .filter(
            (filter) =>
              BigInt(filter.id) > BigInt(claim.above) &&
              !changedFields(claimed, filter, queryFields).length,
          )
          .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))[0]
      );
    };
    // An earlier recreate stopped without recording its result: adopt the filter it made.
    const made = await adopt();
    if (made) return remember(made.id);
    // Jira's filter IDs only grow: any filter of the owner's with this name made after this one is
    // the recreate's.
    const above = (await jira.ownFilters(version.name, viewer)).reduce(
      (highest, { id }) => (BigInt(id) > BigInt(highest) ? id : highest),
      '0',
    );
    record = {
      ...unclaimed(record),
      recreating: { token: randomUUID(), at: version.at, since: now(), above },
    };
    if (!(await keep(filterId, kept.key, record))) throw unavailable();
    const outcome = await jira.createFilter(version);
    if (outcome.status === 'rejected') {
      // An earlier recreate's filter may have reached Jira since: that one is the recreate.
      const late = await adopt().catch(() => undefined);
      if (late) return remember(late.id);
      // Nothing was created: release the claim (an old claim is checked again anyway).
      record = unclaimed(record);
      await keep(filterId, kept.key, record).catch(() => undefined);
      throw new UserError(`Jira refused to recreate the filter: ${outcome.message}`);
    }
    if (outcome.status === 'uncertain')
      throw new UserError(
        "Jira didn't confirm the new filter. Try again in a minute: the app checks your filters before creating another.",
      );
    return remember(outcome.id);
  }

  /** The filter's index, if the viewer may see its history: visible now, or deleted and theirs. */
  async function readable(filterId: string, viewer: string) {
    const admin = await jira.isAdmin();
    const current = (await jira.visibleFilters([filterId], admin)).get(filterId);
    if (current) return { admin, current, kept: undefined };
    const kept = await deletedFilter(filterId);
    if (!kept || (!admin && kept.deleted.owner !== viewer)) throw unavailable();
    return { admin, current: undefined, kept };
  }

  async function history(filterId: unknown, viewer: string): Promise<unknown> {
    const id = requireFilterId(filterId);
    const { admin, current, kept } = await readable(id, viewer);
    const recreatedAs = kept?.deleted.recreatedAs;
    if (recreatedAs) {
      // A recreate stopped before its history moved: finish it and show the recreated filter.
      await leases
        .hold(id, userWait, async () => {
          const still = await deletedFilter(id);
          if (still?.deleted.recreatedAs)
            await moveHistory(id, still, still.deleted.recreatedAs, now() + workBudget);
        })
        .catch(() => undefined);
      // The filter it was recreated as may have been deleted and recreated in turn.
      let next = recreatedAs;
      for (let hop = 0; hop < 20; hop++) {
        const onward = (await store.get<Tombstone>(deletedKey(next)))?.recreatedAs;
        if (!onward) break;
        next = onward;
      }
      return history(next, viewer);
    }
    const index = await store.get<Index>(indexKey(id));
    const versions = summaries(index);
    const newest = versions[0] && (await store.get<Version>(versionKey(id, versions[0].at)));
    const base = { versions, more: Boolean(index?.trimmed), cleared: await cleared(id), admin };
    if (current)
      return {
        ...base,
        filter: current,
        // The filter in Jira still matches the newest version.
        current: Boolean(newest && !changedFields(newest, current).length),
        deleted: null,
      };
    if (!kept || !newest) throw unavailable();
    return {
      ...base,
      filter: {
        id,
        name: newest.name,
        description: newest.description,
        jql: newest.jql,
        owner: kept.deleted.owner,
        isWritable: false,
      },
      current: false,
      deleted: {
        at: kept.deleted.at,
        actor: kept.deleted.actor,
        expires: kept.deleted.at + retention,
        // Only the last owner recreates: an administrator would make the filter their own.
        canRecreate: kept.deleted.owner === viewer,
      },
    };
  }

  /**
   * A change event, holding the filter's lease: placed among the stored events by its time, and
   * stored as a version when it changed something against the event before it.
   */
  async function recordChange(version: Version) {
    const { filterId } = version;
    // A change made before an administrator deleted the history stays deleted.
    if (version.at < ((await cleared(filterId))?.at ?? 0)) return;
    const tombstone = await store.get<Tombstone>(deletedKey(filterId));
    if (tombstone) {
      // A change made before the delete whose event came after it joins the kept history, or
      // starts one for a filter deleted before any change was recorded; not once an administrator
      // deleted that history, nor while it is moving to a recreated filter.
      if (version.at >= tombstone.at || tombstone.recreatedAs || tombstone.cleared) return;
      if (tombstone.trash) {
        const deleted = await store.get<Deleted>(tombstone.trash);
        if (!deleted || deleted.recreatedAs || deleted.recreating) return;
      }
    }
    const index = (await store.get<Index>(indexKey(filterId))) ?? { entries: [] };
    const read = contents(filterId);
    const placed = await place(index, version, read);
    if (!placed) return;
    const { index: next, removed } = trimIndex(placed);
    const stored = next.entries.some(({ at }) => at === version.at);
    // A deleted filter has no entry in the overview's recency index.
    const { sets, deletes } = tombstone
      ? { sets: [], deletes: [] }
      : recency(filterId, index, next);
    const kept =
      tombstone && !tombstone.trash
        ? keepFor(filterId, tombstone, await read(next.entries.at(-1)!.at))
        : [];
    await store.setTogether(
      [
        ...(stored ? [{ key: versionKey(filterId, version.at), value: version }] : []),
        { key: indexKey(filterId), value: next },
        ...sets,
        ...kept,
      ],
      deletes,
    );
    // Includes a text this event replaced at the same time, when the event itself isn't kept.
    await removeContents(filterId, removed);
  }

  /**
   * A delete event, holding the filter's lease: the history stays for the filter's last owner
   * until it expires, and the tombstone stops a late event from starting a new history (filter IDs
   * are never reused). Only the filter's ID is needed, so a delete Jira sent without the name or
   * JQL still counts.
   */
  async function recordDelete(facts: Facts) {
    const { filterId, at } = facts;
    if (await store.get<Tombstone>(deletedKey(filterId))) return;
    const index = await store.get<Index>(indexKey(filterId));
    const last = index?.entries.at(-1);
    const newest = last && (await store.get<Version>(versionKey(filterId, last.at)));
    const trash = last ? trashKey(filterId, at) : undefined;
    const deleted: Deleted | undefined = trash
      ? {
          filterId,
          at,
          actor: facts.actor,
          name: typeof facts.filter.name === 'string' ? facts.filter.name : (newest?.name ?? ''),
          owner: facts.owner || newest?.owner || '',
        }
      : undefined;
    const { deletes } = recency(filterId, index, undefined);
    // Without a history yet, the tombstone holds what the event says, for the kept history a
    // change arriving late starts. Its accounts are registered with the filter, as each event's.
    const tombstone: Tombstone = trash
      ? { at, trash }
      : {
          at,
          ...(facts.actor ? { actor: facts.actor } : {}),
          ...(facts.owner ? { owner: facts.owner } : {}),
          ...(typeof facts.filter.name === 'string' ? { name: facts.filter.name } : {}),
        };
    await store.setTogether(
      [
        { key: deletedKey(filterId), value: tombstone },
        { key: expiryKey(filterId, at), value: { filterId, at } },
        ...(trash ? [{ key: trash, value: deleted }] : []),
      ],
      [...deletes, ...(index && !trash ? [indexKey(filterId)] : [])],
    );
  }

  return {
    /**
     * Trigger: records a filter event, holding the filter's lease so one event's records are
     * written at a time. Repeats and saves that change nothing add no version.
     */
    async record(event: unknown) {
      if (!isRecord(event)) return;
      const facts = eventFacts(event, now());
      if (!facts) return;
      const deleting = event.eventType === 'avi:jira:deleted:filter';
      const version = deleting ? undefined : eventVersion(event, facts);
      if (!deleting && !version) return;
      await leases.hold(facts.filterId, eventWait, async () => {
        await register(facts.filterId, facts.actor, facts.owner);
        await (version ? recordChange(version) : recordDelete(facts));
      });
    },

    /**
     * Scheduled daily: removes deleted filters older than the retention period, oldest first,
     * stopping inside the time limit; the next run continues. An entry that can't be removed is
     * skipped, so it never holds back the ones after it. Resolves with how many were skipped.
     */
    async expire(): Promise<number> {
      const cutoff = now() - retention;
      const deadline = now() + cleanupBudget;
      const failed = new Set<string>();
      // Removed in the previous round: a query may still return them for a moment.
      let removed = new Set<string>();
      for (;;) {
        const due = (await store.list<Expiry>(expiryPrefix, failed.size + removed.size + 25))
          .filter(({ key, value }) => value.at <= cutoff && !failed.has(key) && !removed.has(key))
          .slice(0, 25);
        if (!due.length) return failed.size;
        removed = new Set();
        for (const { key, value } of due) {
          try {
            await purge(value.filterId);
            await store.delete(key);
            removed.add(key);
          } catch {
            failed.add(key);
            if (failed.size >= cleanupFailures) return failed.size;
          }
          if (now() > deadline) return failed.size;
        }
      }
    },

    /**
     * Up to 1,000 of the most recently changed filters with recorded changes that the viewer can
     * see (an administrator sees all of them), and deleted filters with kept history: an
     * administrator sees all of them, anyone else the ones they owned.
     */
    async overview(viewer: string) {
      const admin = await jira.isAdmin();
      const recent = await store.list<Recent>(recentPrefix, overviewLimit + 1);
      // Newest first; a filter appears once, at its newest entry.
      const rows = new Map<string, Recent>();
      for (const { value } of recent.slice(0, overviewLimit))
        if (!rows.has(value.filterId)) rows.set(value.filterId, value);
      const current = await jira.listedFilters([...rows.keys()], admin);
      const trash = await store.list<Deleted>(trashPrefix, overviewLimit + 1);
      return {
        filters: [...rows.values()]
          .filter(({ filterId }) => current.has(filterId))
          .sort((a, b) => b.at - a.at)
          .map(({ filterId, at, actor }) => ({
            filterId,
            name: current.get(filterId)!.name,
            owner: current.get(filterId)!.owner,
            at,
            actor,
          })),
        partial: recent.length > overviewLimit,
        deleted: trash
          .slice(0, overviewLimit)
          .map(({ value }) => value)
          .filter(({ owner }) => admin || owner === viewer)
          .map(({ filterId, name, owner, at, actor }) => ({
            filterId,
            name,
            owner,
            at,
            actor,
            expires: at + retention,
          })),
        deletedPartial: trash.length > overviewLimit,
        admin,
      };
    },

    /**
     * One filter's versions, newest first and without their texts, with the filter as the viewer
     * sees it now, or as it was deleted when the viewer owned it or is an administrator.
     */
    history,

    /**
     * One version's texts and those of the version before it (or of the entry before the oldest
     * kept), for comparing them; the same people as its history see it.
     */
    async version(payload: unknown, viewer: string) {
      if (!isRecord(payload)) throw new UserError('Choose a version.');
      const id = requireFilterId(payload.filterId);
      if (!isTime(payload.at)) throw new UserError('Choose a version.');
      const { kept } = await readable(id, viewer);
      if (kept?.deleted.recreatedAs) throw unavailable();
      const index = await store.get<Index>(indexKey(id));
      const position = index?.entries.findIndex(({ at }) => at === payload.at) ?? -1;
      if (!index || !isVersion(index, position)) throw notRecorded();
      let before = position - 1;
      while (before > 0 && !isVersion(index, before)) before--;
      const read = contents(id);
      const version = await read(payload.at);
      if (!version) throw notRecorded();
      const previous = before >= 0 ? await read(index.entries[before]!.at) : undefined;
      return { version: textOf(version), previous: previous ? textOf(previous) : null };
    },

    /** Rovo: what changed in the filter's latest versions, each text cut to a bounded length. */
    async changes(filterId: unknown) {
      const id = requireFilterId(filterId);
      const filter = await visible(id, await jira.isAdmin());
      const index = await store.get<Index>(indexKey(filter.id));
      const listed = summaries(index);
      const read = contents(filter.id);
      const deleted = await cleared(filter.id);
      const changes = [];
      for (const { at, actor, changed, restored, recreated } of listed.slice(0, rovoVersions)) {
        const version = await read(at);
        if (!version) continue;
        const description = forRovo(version.description);
        const jql = forRovo(version.jql);
        const name = forRovo(version.name);
        changes.push({
          at: new Date(at).toISOString(),
          actor,
          restored,
          recreated,
          changed,
          after: {
            name: name.text,
            // Null when Jira didn't send the description (over 10,000 characters).
            description: version.descriptionMissing ? null : description.text,
            jql: jql.text,
            owner: version.owner,
          },
          ...(description.cut || jql.cut || name.cut ? { truncated: true } : {}),
        });
      }
      return {
        filter: { id: filter.id, name: forRovo(filter.name).text },
        // Changes before this weren't kept: an administrator deleted them.
        historyDeleted: deleted && { at: new Date(deleted.at).toISOString(), actor: deleted.actor },
        changes,
        olderChanges: listed.length > rovoVersions || Boolean(index?.trimmed),
      };
    },

    /**
     * Writes a version's name, description and JQL back to the filter as the viewer, if the
     * filter still matches what the viewer previewed; a version without its description keeps the
     * filter's. Only a filter Jira lets the viewer edit, read without the administrator override.
     * Never retried.
     */
    async restore(payload: unknown) {
      if (!isRecord(payload)) throw new UserError('Choose a version to restore.');
      const filterId = requireFilterId(payload.filterId);
      const expected = payload.expected;
      if (
        !isTime(payload.at) ||
        !isRecord(expected) ||
        queryFields.some((field) => typeof expected[field] !== 'string')
      )
        throw new UserError('Choose a version to restore.');
      // Visibility first: someone who can't see the filter learns nothing about its versions.
      const current = await visible(filterId, false);
      const index = await store.get<Index>(indexKey(filterId));
      const version = index?.entries.some(({ at }) => at === payload.at)
        ? await store.get<Version>(versionKey(filterId, payload.at))
        : undefined;
      if (!version) throw notRecorded();
      if (!current.isWritable) throw new UserError("You can't edit this filter in Jira.");
      if (changedFields(expected as Pick<Version, Field>, current, queryFields).length)
        throw new UserError('The filter changed since you opened it. Review it again.');
      // Jira didn't send this version's description: restore its name and JQL only.
      const target = version.descriptionMissing
        ? { ...version, description: current.description }
        : version;
      if (!changedFields(target, current, queryFields).length)
        throw new UserError('The filter already matches this version.');
      const outcome = await jira.updateFilter(filterId, target);
      if (outcome.status === 'rejected')
        throw new UserError(`Jira refused the restore: ${outcome.message}`);
      if (outcome.status === 'uncertain')
        throw new UserError(
          "Jira didn't confirm the restore. Refresh to check the filter before trying again.",
        );
      return { restored: true };
    },

    /**
     * Creates a deleted filter again from one of its versions, as a new filter private to its
     * owner, and moves its history there, holding the filter's lease. One filter is created per
     * deleted filter: a second call finishes moving the history to the filter the first created,
     * or, once it has moved, answers its owner with that filter.
     */
    async recreate(payload: unknown, viewer: string) {
      const deadline = now() + workBudget;
      if (!isRecord(payload)) throw new UserError('Choose a version to recreate.');
      const filterId = requireFilterId(payload.filterId);
      const at = payload.at;
      if (!isTime(at)) throw new UserError('Choose a version to recreate.');
      const unfinished = () =>
        new UserError(
          "The filter was recreated in Jira, but its history hasn't moved there yet. Try again to finish.",
        );
      // A recreate that finished, whose answer was lost: its owner is sent to the new filter. This
      // only reads, so it takes no lease.
      const finished = async () => {
        const recreatedAs = (await store.get<Tombstone>(deletedKey(filterId)))?.recreatedAs;
        const created =
          recreatedAs && (await jira.visibleFilters([recreatedAs], false)).get(recreatedAs);
        if (created && created.owner === viewer) return { filterId: created.id };
        throw unavailable();
      };
      // Anyone but the owner is refused before the lease, so their calls write nothing and hold
      // up no one's changes to the filter.
      const before = await deletedFilter(filterId);
      if (!before) return finished();
      if (before.deleted.owner !== viewer) throw unavailable();
      return leases.hold(filterId, userWait, async () => {
        const kept = await deletedFilter(filterId);
        if (!kept) return finished();
        if (kept.deleted.owner !== viewer) throw unavailable();
        let newId = kept.deleted.recreatedAs;
        if (!newId) {
          const index = await store.get<Index>(indexKey(filterId));
          const version = index?.entries.some((entry) => entry.at === at)
            ? await store.get<Version>(versionKey(filterId, at))
            : undefined;
          if (!version) throw notRecorded();
          newId = await createOnce(filterId, kept, version, viewer);
        }
        try {
          // The created event records the new filter's first version.
          await moveHistory(filterId, kept, newId, deadline);
        } catch {
          throw unfinished();
        }
        return { filterId: newId };
      });
    },

    /**
     * Administrators: deletes a filter's recorded history from the app's storage, holding its
     * lease. Jira isn't changed. A filter in Jira keeps who deleted its history and when, written
     * with the removal of its index; a deleted filter's history can be deleted without opening it,
     * and without a trace, as only administrators and its owner could see it. `ofDeleted` is what
     * the administrator confirmed (a deleted filter's history, or a filter in Jira's): the two are
     * worded differently, so a filter deleted or recreated since is refused rather than removed.
     */
    async deleteHistory(filterId: unknown, ofDeleted: unknown, viewer: string) {
      const id = requireFilterId(filterId);
      if (typeof ofDeleted !== 'boolean') throw new UserError('Invalid request.');
      if (!(await jira.isAdmin())) throw adminOnly();
      return leases.hold(id, userWait, async () => {
        const kept = await deletedFilter(id);
        const tombstone = kept ? undefined : await store.get<Tombstone>(deletedKey(id));
        // Deleting a deleted filter's history stopped part way: this finishes it.
        const finishing = ofDeleted && Boolean(tombstone?.cleared);
        // A recreate that hasn't moved the history yet: the filter is in Jira again.
        if (!finishing && (Boolean(kept) !== ofDeleted || kept?.deleted.recreatedAs))
          throw new UserError(
            ofDeleted
              ? "This filter isn't deleted any more, so its history wasn't deleted. Reload the page to see it."
              : "This filter was deleted in Jira since you opened it, so its history wasn't deleted. Reload the page to see it.",
          );
        if (kept) await forget(id, kept, [clearedKey(id)], { cleared: true });
        else if (!tombstone) {
          await visible(id, true);
          await register(id, viewer);
          const index = await store.get<Index>(indexKey(id));
          const { deletes } = recency(id, index, undefined);
          await store.setTogether(
            [{ key: clearedKey(id), value: { at: now(), actor: viewer } }],
            [indexKey(id), ...deletes],
          );
        }
        // The versions go after the index that listed them: any left are never shown, and a retry
        // or the cleanup removes them.
        await within(
          () => deleteVersions(id),
          () => new UserError('Part of this history was deleted. Try again to finish.'),
        );
        return { deleted: true };
      });
    },
  };
}
