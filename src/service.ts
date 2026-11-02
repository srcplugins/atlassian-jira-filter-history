import { randomUUID } from 'node:crypto';
import { UserError } from './shared/jira.mjs';
import { isRecord } from './shared/response.mjs';
import type { CurrentFilter, Jira, Store } from './integration';
import {
  changedFields,
  deletedKey,
  expiryKey,
  expiryPrefix,
  isFilterId,
  isTime,
  latestKey,
  latestPrefix,
  trashKey,
  trashPrefix,
  versionKey,
  versionPrefix,
  type Deleted,
  type Expiry,
  type Field,
  type Tombstone,
  type Version,
} from './versions';
export { UserError };

// The overview reads at most this many filters' latest versions and deleted filters; a site with
// more is marked partial.
const overviewLimit = 1000;
// Each filter keeps its newest versions up to this many, plus the one before them so the oldest
// shown can say what it changed; a new version removes the older ones.
const keptVersions = 100;
// A deleted filter's tombstone and kept history are removed this long after the delete.
const retention = 90 * 24 * 60 * 60 * 1000;
// Moving or deleting a long history stops after this long, inside Forge's 25-second limit, and
// asks the user to try again; each step is resumable.
const workBudget = 18_000;
// A recreate claim younger than this may belong to a recreate still running (25 seconds at most).
const claimWait = 30_000;

const queryFields: Field[] = ['name', 'description', 'jql'];
const unavailable = () => new UserError("This filter isn't available to you.");
const busyRecreating = () =>
  new UserError('This filter is already being recreated. Try again in a minute.');
const descriptionNotRecorded = (action: string) =>
  new UserError(
    `Jira didn't send this version's description (over 10,000 characters), so it can't be ${action}.`,
  );

/** Jira sends the change time as a string of epoch milliseconds; a number is accepted too. */
const eventTime = (value: unknown) =>
  typeof value === 'string' && /^[1-9]\d{0,12}$/.test(value) ? Number(value) : value;

/**
 * The version a Jira filter event describes, or nothing when the event is malformed. Jira
 * documents the actor as optional and leaves out a description over 10,000 characters; the time
 * isn't documented, so the event's arrival stands in for it.
 */
function eventVersion(event: Record<string, unknown>, arrived: number): Version | undefined {
  const filter = event.filter;
  const at = event.timestamp === undefined ? arrived : eventTime(event.timestamp);
  if (!isRecord(filter) || !isFilterId(String(filter.id ?? ''))) return undefined;
  const owner = isRecord(filter.owner) ? filter.owner.accountId : filter.owner;
  if (
    typeof filter.name !== 'string' ||
    typeof filter.jql !== 'string' ||
    (filter.description !== undefined &&
      filter.description !== null &&
      typeof filter.description !== 'string') ||
    !isTime(at) ||
    (event.atlassianId !== undefined && typeof event.atlassianId !== 'string')
  )
    return undefined;
  return {
    filterId: String(filter.id),
    at,
    actor: event.atlassianId ?? '',
    name: filter.name,
    description: typeof filter.description === 'string' ? filter.description : '',
    ...(filter.description === undefined ? { descriptionMissing: true as const } : {}),
    jql: filter.jql,
    owner: typeof owner === 'string' ? owner : '',
    restored: event.selfGenerated === true && event.eventType !== 'avi:jira:created:filter',
    recreated: event.selfGenerated === true && event.eventType === 'avi:jira:created:filter',
  };
}

const requireFilterId = (value: unknown) => {
  if (!isFilterId(value)) throw new UserError('Choose a saved filter.');
  return value;
};

/** A stored version with the fields it changed against the version before it. */
const withChanges = (version: Version, previous: Version | undefined) => ({
  ...version,
  recreated: version.recreated === true,
  changed: previous ? changedFields(previous, version) : [],
});

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
}: {
  jira: Jira;
  store: Store;
  /** The clock for event arrival, recreate claims and work budgets. */
  now?: () => number;
}) {
  async function visible(filterId: string) {
    const filter = (await jira.visibleFilters([filterId])).get(filterId);
    if (!filter) throw unavailable();
    return filter;
  }

  async function versionsOf(filterId: string, limit: number) {
    // One more than shown, so the oldest shown version can say what it changed.
    const entries = await store.list<Version>(versionPrefix(filterId), limit + 1);
    const versions = entries.map(({ value }) => value);
    return {
      versions: versions
        .slice(0, limit)
        .map((version, index) => withChanges(version, versions[index + 1])),
      more: versions.length > limit,
    };
  }

  /** The newest stored version: the order of record, whichever event was written last. */
  const newestVersion = async (filterId: string) =>
    (await store.list<Version>(versionPrefix(filterId), 1))[0]?.value;

  /** A deleted filter whose history is kept, with the key of its record. */
  async function deletedFilter(filterId: string) {
    const tombstone = await store.get<Tombstone>(deletedKey(filterId));
    if (!tombstone?.trash) return undefined;
    const deleted = await store.get<Deleted>(tombstone.trash);
    return deleted && { key: tombstone.trash, at: tombstone.at, deleted };
  }

  /**
   * Removes a deleted filter's kept history; the tombstone stays to ignore late events until it
   * expires.
   */
  async function forget(filterId: string, kept: { key: string; at: number }) {
    await store.delete(kept.key);
    await store.set<Tombstone>(deletedKey(filterId), { at: kept.at });
  }

  /**
   * Removes a filter's versions beyond the kept ones. Best effort: a failure leaves them for the
   * next new version to remove, and never makes Jira deliver the event again.
   */
  async function trim(filterId: string) {
    try {
      const entries = await store.list<Version>(versionPrefix(filterId), keptVersions + 26);
      const extra = entries.slice(keptVersions + 1).map(({ key }) => key);
      if (extra.length) await store.deleteKeys(extra);
    } catch {
      // Left for the next version.
    }
  }

  /** Moves one page of a filter's versions to another filter; false when none are left. */
  async function moveVersions(from: string, to: string) {
    const page = await store.list<Version>(versionPrefix(from), 100);
    if (!page.length) return false;
    await store.setMany(
      page.map(({ value }) => ({
        key: versionKey(to, value.at),
        value: { ...value, filterId: to },
      })),
    );
    await store.deleteKeys(page.map(({ key }) => key));
    return true;
  }

  /** Deletes one page of a filter's versions; false when none are left. */
  async function deleteVersions(filterId: string) {
    const keys = (await store.list(versionPrefix(filterId), 100)).map(({ key }) => key);
    if (keys.length) await store.deleteKeys(keys);
    return keys.length > 0;
  }

  /**
   * Removes an expired deleted filter: its kept history (finishing a recreate's move instead, so
   * the recreated filter keeps it), its record and its tombstone.
   */
  async function purge(filterId: string) {
    const tombstone = await store.get<Tombstone>(deletedKey(filterId));
    if (tombstone?.trash) {
      const recreatedAs = (await store.get<Deleted>(tombstone.trash))?.recreatedAs;
      if (recreatedAs) {
        while (await moveVersions(filterId, recreatedAs));
        await trim(recreatedAs);
      } else while (await deleteVersions(filterId));
      await store.delete(tombstone.trash);
    }
    await store.delete(deletedKey(filterId));
  }

  /** Runs `step` until it reports nothing left, or fails with `unfinished` after the budget. */
  async function within(step: () => Promise<boolean>, unfinished: () => UserError) {
    const deadline = now() + workBudget;
    while (await step()) if (now() > deadline) throw unfinished();
  }

  /**
   * Creates the filter in Jira at most once per deleted filter: the recreate is claimed in storage
   * first, and a later call that finds an older claim without a result looks for the filter it
   * made instead of creating another. Returns the new filter's ID.
   */
  async function createOnce(
    filterId: string,
    kept: { key: string; deleted: Deleted },
    version: Version,
    viewer: string,
  ) {
    const claim = kept.deleted.recreating;
    if (claim && now() - claim.since < claimWait) throw busyRecreating();
    const remember = async (newId: string) => {
      try {
        await store.set<Deleted>(kept.key, { ...unclaimed(kept.deleted), recreatedAs: newId });
      } catch {
        throw new UserError(
          `The filter was recreated in Jira with ID ${newId}, but its history hasn't moved there yet. Try again in a minute to finish.`,
        );
      }
      return newId;
    };
    if (claim) {
      // An earlier recreate stopped without recording its result: adopt the filter it made.
      const claimed = await store.get<Version>(versionKey(filterId, claim.at));
      const made =
        claimed &&
        (await jira.ownFilters(claimed.name, viewer))
          .filter((filter) => !changedFields(claimed, filter, queryFields).length)
          .sort((a, b) => Number(b.id) - Number(a.id))[0];
      if (made) return remember(made.id);
    }
    const token = randomUUID();
    await store.set<Deleted>(kept.key, {
      ...unclaimed(kept.deleted),
      recreating: { token, at: version.at, since: now() },
    });
    if ((await store.get<Deleted>(kept.key))?.recreating?.token !== token) throw busyRecreating();
    const outcome = await jira.createFilter(version);
    if (outcome.status === 'rejected') {
      // Nothing was created: release the claim (an old claim is checked again anyway).
      await store.set<Deleted>(kept.key, unclaimed(kept.deleted)).catch(() => undefined);
      throw new UserError(`Jira refused to recreate the filter: ${outcome.message}`);
    }
    if (outcome.status === 'uncertain')
      throw new UserError(
        "Jira didn't confirm the new filter. Try again in a minute: the app checks your filters before creating another.",
      );
    return remember(outcome.id);
  }

  async function history(filterId: unknown, viewer: string): Promise<unknown> {
    const id = requireFilterId(filterId);
    const current = (await jira.visibleFilters([id])).get(id);
    if (current)
      return {
        filter: current,
        ...(await versionsOf(id, keptVersions)),
        deleted: null,
        admin: await jira.isAdmin(),
      };
    const kept = await deletedFilter(id);
    if (!kept || kept.deleted.owner !== viewer) throw unavailable();
    const { versions, more } = await versionsOf(id, keptVersions);
    const newest = versions[0];
    if (!newest) {
      // A recreate moved every version and stopped before clearing the deleted entry: finish it
      // and show the recreated filter.
      const recreatedAs = kept.deleted.recreatedAs;
      if (!recreatedAs) throw unavailable();
      await forget(id, kept).catch(() => undefined);
      return history(recreatedAs, viewer);
    }
    return {
      filter: {
        id,
        name: newest.name,
        description: newest.description,
        jql: newest.jql,
        owner: kept.deleted.owner,
        isWritable: false,
      },
      versions,
      more,
      deleted: { at: kept.deleted.at, actor: kept.deleted.actor },
      admin: false,
    };
  }

  return {
    /** Trigger: records a filter event. Repeats and saves that change nothing add no version. */
    async record(event: unknown) {
      if (!isRecord(event)) return;
      const version = eventVersion(event, now());
      if (!version) return;
      const { filterId } = version;
      const tombstone = await store.get<Tombstone>(deletedKey(filterId));
      if (event.eventType === 'avi:jira:deleted:filter') {
        // The history stays for the filter's last owner until it expires. The tombstone stops a
        // late event from starting a new history; filter IDs are never reused.
        if (!tombstone) {
          const newest = await newestVersion(filterId);
          const trash = newest && trashKey(filterId, version.at);
          const deleted: Deleted | undefined = newest && {
            filterId,
            at: version.at,
            actor: version.actor,
            name: version.name,
            owner: version.owner || newest.owner,
          };
          await store.setTogether([
            { key: deletedKey(filterId), value: { at: version.at, ...(trash && { trash }) } },
            { key: expiryKey(filterId, version.at), value: { filterId, at: version.at } },
            ...(trash ? [{ key: trash, value: deleted }] : []),
          ]);
        }
        await store.delete(latestKey(filterId));
        return;
      }
      const newest = await newestVersion(filterId);
      const isNew = !newest || version.at < newest.at || changedFields(newest, version).length > 0;
      if (tombstone) {
        // A change made before the delete whose event came after it joins the kept history,
        // unless that history is moving to a recreated filter.
        if (!isNew || !tombstone.trash || version.at >= tombstone.at) return;
        const deleted = await store.get<Deleted>(tombstone.trash);
        if (deleted && !deleted.recreatedAs && !deleted.recreating) {
          await store.set(versionKey(filterId, version.at), version);
          await trim(filterId);
        }
        return;
      }
      if (!isNew) return;
      // An older event arriving late is kept at its own time; the latest stays the newer one.
      if (newest && version.at < newest.at)
        await store.set(versionKey(filterId, version.at), version);
      else
        await store.setTogether([
          { key: versionKey(filterId, version.at), value: version },
          { key: latestKey(filterId), value: version },
        ]);
      await trim(filterId);
    },

    /**
     * Scheduled daily: removes deleted filters older than the retention period, oldest first,
     * stopping inside the time limit; the next run continues.
     */
    async expire() {
      const cutoff = now() - retention;
      const deadline = now() + workBudget;
      for (;;) {
        const due = (await store.list<Expiry>(expiryPrefix, 25)).filter(
          ({ value }) => value.at <= cutoff,
        );
        if (!due.length) return;
        for (const { key, value } of due) {
          await purge(value.filterId);
          await store.delete(key);
          if (now() > deadline) return;
        }
      }
    },

    /**
     * Filters with recorded changes that the viewer can see, most recently changed first, and
     * deleted filters with kept history: an administrator sees all of them, anyone else the ones
     * they owned. Only a deleted filter's owner can open its history.
     */
    async overview(viewer: string) {
      const latest = await store.list<Version>(latestPrefix, overviewLimit + 1);
      const partial = latest.length > overviewLimit;
      const versions = latest.slice(0, overviewLimit).map(({ value }) => value);
      const current = await jira.visibleFilters(versions.map(({ filterId }) => filterId));
      const trash = await store.list<Deleted>(trashPrefix, overviewLimit + 1);
      const admin = await jira.isAdmin();
      return {
        filters: versions
          .filter(({ filterId }) => current.has(filterId))
          .sort((a, b) => b.at - a.at)
          .map(({ filterId, at, actor }) => ({
            filterId,
            name: current.get(filterId)!.name,
            owner: current.get(filterId)!.owner,
            at,
            actor,
          })),
        partial,
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
            canOpen: owner === viewer,
          })),
        deletedPartial: trash.length > overviewLimit,
        admin,
      };
    },

    /**
     * One filter's versions, newest first, with the filter as the viewer sees it now, or as it was
     * deleted when the viewer owned it.
     */
    history,

    /** Rovo: what changed in the filter's latest versions. */
    async changes(filterId: unknown) {
      const filter = await visible(requireFilterId(filterId));
      const { versions, more } = await versionsOf(filter.id, 10);
      return {
        filter: { id: filter.id, name: filter.name },
        changes: versions.map(
          ({
            at,
            actor,
            changed,
            name,
            description,
            descriptionMissing,
            jql,
            owner,
            restored,
          }) => ({
            at: new Date(at).toISOString(),
            actor,
            restored,
            changed,
            // Null when Jira didn't send the description (over 10,000 characters).
            after: { name, description: descriptionMissing ? null : description, jql, owner },
          }),
        ),
        olderChanges: more,
      };
    },

    /**
     * Writes a version's name, description and JQL back to the filter as the viewer, if the
     * filter still matches what the viewer previewed. Never retried.
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
      const current = await visible(filterId);
      const version = await store.get<Version>(versionKey(filterId, payload.at));
      if (!version) throw new UserError('That version is no longer recorded.');
      if (version.descriptionMissing) throw descriptionNotRecorded('restored');
      if (!current.isWritable) throw new UserError("You can't edit this filter in Jira.");
      if (changedFields(expected as Pick<CurrentFilter, Field>, current, queryFields).length)
        throw new UserError('The filter changed since you opened it. Review it again.');
      if (!changedFields(version, current, queryFields).length)
        throw new UserError('The filter already matches this version.');
      const outcome = await jira.updateFilter(filterId, version);
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
     * owner, and moves its history there. One filter is created per deleted filter: a second call
     * finishes moving the history to the filter the first one created.
     */
    async recreate(payload: unknown, viewer: string) {
      if (!isRecord(payload)) throw new UserError('Choose a version to recreate.');
      const filterId = requireFilterId(payload.filterId);
      if (!isTime(payload.at)) throw new UserError('Choose a version to recreate.');
      const kept = await deletedFilter(filterId);
      if (!kept || kept.deleted.owner !== viewer) throw unavailable();
      let newId = kept.deleted.recreatedAs;
      if (!newId) {
        const version = await store.get<Version>(versionKey(filterId, payload.at));
        if (!version) throw new UserError('That version is no longer recorded.');
        if (version.descriptionMissing) throw descriptionNotRecorded('recreated');
        newId = await createOnce(filterId, kept, version, viewer);
      }
      const target = newId;
      const unfinished = () =>
        new UserError(
          "The filter was recreated in Jira, but its history hasn't moved there yet. Try again to finish.",
        );
      try {
        // The created event records the new filter's first version; its latest key is left to it.
        await within(() => moveVersions(filterId, target), unfinished);
        await forget(filterId, kept);
        await trim(target);
      } catch {
        throw unfinished();
      }
      return { filterId: target };
    },

    /**
     * Administrators: deletes a filter's recorded history from the app's storage. Jira isn't
     * changed. A deleted filter's history can be deleted without opening it.
     */
    async deleteHistory(filterId: unknown) {
      const id = requireFilterId(filterId);
      if (!(await jira.isAdmin())) throw adminOnly();
      const kept = await deletedFilter(id);
      if (!kept) await visible(id);
      await within(
        () => deleteVersions(id),
        () => new UserError('Part of this history was deleted. Try again to finish.'),
      );
      await store.delete(latestKey(id));
      if (kept) await forget(id, kept);
      return { deleted: true };
    },
  };
}
