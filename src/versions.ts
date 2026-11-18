// What one filter version holds, how it is keyed in app storage, and how two versions differ.

/** One recorded state of a filter's query and owner, from a Jira filter event. */
export interface Version {
  filterId: string;
  /** Change time from the event, in epoch milliseconds. */
  at: number;
  /** Account that made the change. */
  actor: string;
  name: string;
  /** Empty when Jira didn't send it: see `descriptionMissing`. */
  description: string;
  /** Jira leaves out a description over 10,000 characters, so this version's isn't known. */
  descriptionMissing?: true;
  jql: string;
  owner: string;
  /** The app's own restore made this change. */
  restored: boolean;
  /** The app's recreate of a deleted filter created this filter. */
  recreated: boolean;
}

/** A filter's newest version: when and by whom, for the overview's recency index. */
export interface Recent {
  filterId: string;
  at: number;
  actor: string;
}

/** One stored event in a filter's index, oldest first; its content is the version at `at`. */
export interface Entry {
  at: number;
  actor: string;
  /** Fields it changed against the entry before it; empty for a save that changed none. */
  changed: Field[];
  restored?: true;
  recreated?: true;
  /** Jira didn't send the description: the next comparison uses the last one it sent. */
  noDescription?: true;
}

/**
 * Every stored event of a filter, oldest first, read with a strictly consistent get: the versions
 * (the first entry, and each that changed something or is the app's own write) and the saves that
 * changed nothing, kept so an event that arrives late can be compared with its true neighbours.
 */
export interface Index {
  entries: Entry[];
  /** Older history was removed: the first entry only says what the next one changed. */
  trimmed?: true;
}

/** A recorded entry the history lists as a version. */
export const isVersion = (index: Index, position: number) => {
  const entry = index.entries[position];
  if (!entry) return false;
  if (position === 0) return !index.trimmed;
  return entry.changed.length > 0 || Boolean(entry.restored || entry.recreated);
};

/** The positions of an index's versions, oldest first. */
export const versionPositions = (index: Index) =>
  index.entries.map((_, position) => position).filter((position) => isVersion(index, position));

/** An index's newest version, for the overview's recency index. */
export function newestVersion(filterId: string, index: Index | undefined): Recent | undefined {
  const position = index && versionPositions(index).at(-1);
  const entry = position === undefined ? undefined : index?.entries[position];
  return entry && { filterId, at: entry.at, actor: entry.actor };
}

/** Held while one invocation changes a filter's records; another waits or retries. */
export interface Lease {
  token: string;
  /** After this time the holder has stopped (every function ends sooner) and the lease is free. */
  until: number;
}

/** A deleted filter whose history is kept for its last owner. */
export interface Deleted {
  filterId: string;
  /** Delete time from the event, in epoch milliseconds. */
  at: number;
  /** Account that deleted the filter. */
  actor: string;
  name: string;
  owner: string;
  /** The filter its owner recreated it as, until its history has moved there. */
  recreatedAs?: string;
  /**
   * Claimed before the Jira write of a recreate, so only one is made: the claim's token, the
   * version it recreates, when it was claimed and the highest ID among the owner's filters with
   * that name just before (a stalled recreate adopts only a filter made after it). Replaced by
   * `recreatedAs` once Jira confirms.
   */
  recreating?: { token: string; at: number; since: number; above: string };
}

/** An administrator deleted a filter's recorded history: who and when, nothing of the filter. */
export interface Cleared {
  at: number;
  actor: string;
}

/** Marks a deleted filter, pointing to its kept history's record while there is one. */
export interface Tombstone {
  at: number;
  trash?: string;
  /** The filter it was recreated as, once its history moved there. */
  recreatedAs?: string;
  /** An administrator deleted its kept history: nothing is kept for it again. */
  cleared?: true;
  /**
   * A filter deleted before any change was recorded: who deleted it, its owner and name as the
   * delete event gave them, for the kept history a late change starts.
   */
  actor?: string;
  owner?: string;
  name?: string;
}

/** Schedules a deleted filter's tombstone, and any history it still keeps, for removal. */
export interface Expiry {
  filterId: string;
  /** Delete time from the event, in epoch milliseconds. */
  at: number;
}

export type Field = 'name' | 'description' | 'jql' | 'owner';
export const fields: Field[] = ['name', 'description', 'jql', 'owner'];

const filterIdPattern = /^[1-9]\d{0,17}$/;
export const isAccountId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w:-]{1,128}$/.test(value);
export const isFilterId = (value: unknown): value is string =>
  typeof value === 'string' && filterIdPattern.test(value);

// Keys sort ascending, so a version's key holds the time subtracted from a constant: the newest
// version of a filter sorts first.
const latestTime = 9_999_999_999_999;
export const versionPrefix = (filterId: string) => `version:${filterId}:`;
export const versionKey = (filterId: string, at: number) =>
  versionPrefix(filterId) + String(latestTime - at).padStart(13, '0');
// A filter's index, kept after the filter is deleted for as long as its history is.
export const indexKey = (filterId: string) => `filter:${filterId}`;
// Filters by their newest stored version, most recent first, so the overview reads the most
// recently changed ones.
export const recentPrefix = 'recent:';
export const recentKey = (filterId: string, at: number) =>
  recentPrefix + String(latestTime - at).padStart(13, '0') + ':' + filterId;
export const deletedKey = (filterId: string) => `deleted:${filterId}`;
export const leaseKey = (filterId: string) => `lease:${filterId}`;
export const clearedKey = (filterId: string) => `cleared:${filterId}`;
// Deleted filters with kept history, most recently deleted first.
export const trashPrefix = 'trash:';
export const trashKey = (filterId: string, at: number) =>
  trashPrefix + String(latestTime - at).padStart(13, '0') + ':' + filterId;
// Deleted filters in delete order, oldest first, so the daily cleanup reads only expired ones.
export const expiryPrefix = 'expire:';
export const expiryKey = (filterId: string, at: number) =>
  expiryPrefix + String(at).padStart(13, '0') + ':' + filterId;

// Every account ID the app stores, with when it first stored it, for the weekly personal data report.
export const accountPrefix = 'account:';
export const accountKey = (accountId: string) => accountPrefix + accountId;
/** A stored account ID, reported to Atlassian each week until it reports the account closed. */
export interface Account {
  accountId: string;
  since: string;
  /**
   * When a weekly report erased the closed account's records. The next week's report forgets the
   * account if it finds nothing marked again; a change that stores the ID meanwhile writes the
   * account afresh, without this.
   */
  erasing?: number;
}
/**
 * Marks a filter whose records may hold an account ID, in their `actor` and `owner` fields, so a
 * closed account's erasure reads only those filters' records. A marker can outlive the records.
 */
export const usePrefix = (accountId: string) => `uses:${accountId}:`;
export const useKey = (accountId: string, filterId: string) => usePrefix(accountId) + filterId;
export interface Use {
  filterId: string;
}

/** `value` with every `actor` and `owner` naming a closed account emptied, or nothing if none do. */
export function withoutAccounts<T>(value: T, closed: Set<string>): T | undefined {
  let changed = false;
  const scrub = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(scrub);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item).map(([key, field]) => {
        if (
          (key === 'actor' || key === 'owner') &&
          typeof field === 'string' &&
          closed.has(field)
        ) {
          changed = true;
          return [key, ''];
        }
        return [key, scrub(field)];
      }),
    );
  };
  const scrubbed = scrub(value) as T;
  return changed ? scrubbed : undefined;
}

export const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= latestTime;

type Compared = Pick<Version, Field> & { descriptionMissing?: boolean };

/**
 * Fields whose values differ between two versions (or a version and the current filter). A
 * description Jira didn't send, or an owner the app doesn't know (not sent, or erased for a closed
 * account), is never counted as a change.
 */
export const changedFields = (before: Compared, after: Compared, compared: Field[] = fields) =>
  compared.filter(
    (field) =>
      before[field] !== after[field] &&
      !(field === 'description' && (before.descriptionMissing || after.descriptionMissing)) &&
      !(field === 'owner' && (!before.owner || !after.owner)),
  );

export type Part = { text: string; change: 'same' | 'removed' | 'added' };

// Above this many changed tokens on either side (after the unchanged ends) the comparison shows the
// changed part as replaced; the table below grows with the product of both lengths.
const maxTokens = 2000;

/** Word-level difference of two texts: unchanged, removed and added runs in reading order. */
export function diffText(before: string, after: string): Part[] {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  // Unchanged words at either end are kept as they are, so a long text with a small change still
  // compares word by word.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const same = (words: string[]): Part[] =>
    words.length ? [{ text: words.join(''), change: 'same' }] : [];
  const middle = diffWords(a.slice(head, a.length - tail), b.slice(head, b.length - tail));
  return merge([...same(a.slice(0, head)), ...middle, ...same(a.slice(a.length - tail))]);
}

function diffWords(a: string[], b: string[]): Part[] {
  if (a.length > maxTokens || b.length > maxTokens)
    return [
      { text: a.join(''), change: 'removed' },
      { text: b.join(''), change: 'added' },
    ];
  // Longest common subsequence lengths, filled from the end: `at(i, j)` for a[i..] and b[j..].
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const parts: Part[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && left === right) {
      parts.push({ text: left, change: 'same' });
      i++;
      j++;
    } else if (left !== undefined && (right === undefined || at(i + 1, j) >= at(i, j + 1))) {
      // Removed words come before the words that replace them.
      parts.push({ text: left, change: 'removed' });
      i++;
    } else {
      parts.push({ text: right ?? '', change: 'added' });
      j++;
    }
  }
  return parts;
}

function merge(parts: Part[]) {
  const out: Part[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    const last = out.at(-1);
    if (last?.change === part.change) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}
