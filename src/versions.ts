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
   * version it recreates and when it was claimed. Replaced by `recreatedAs` once Jira confirms.
   */
  recreating?: { token: string; at: number; since: number };
}

/** Marks a deleted filter, pointing to its kept history's record while there is one. */
export interface Tombstone {
  at: number;
  trash?: string;
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
export const isFilterId = (value: unknown): value is string =>
  typeof value === 'string' && filterIdPattern.test(value);

// Keys sort ascending, so a version's key holds the time subtracted from a constant: the newest
// version of a filter sorts first.
const latestTime = 9_999_999_999_999;
export const versionPrefix = (filterId: string) => `version:${filterId}:`;
export const versionKey = (filterId: string, at: number) =>
  versionPrefix(filterId) + String(latestTime - at).padStart(13, '0');
export const latestKey = (filterId: string) => `filter:${filterId}`;
export const latestPrefix = 'filter:';
export const deletedKey = (filterId: string) => `deleted:${filterId}`;
// Deleted filters with kept history, most recently deleted first.
export const trashPrefix = 'trash:';
export const trashKey = (filterId: string, at: number) =>
  trashPrefix + String(latestTime - at).padStart(13, '0') + ':' + filterId;
// Deleted filters in delete order, oldest first, so the daily cleanup reads only expired ones.
export const expiryPrefix = 'expire:';
export const expiryKey = (filterId: string, at: number) =>
  expiryPrefix + String(at).padStart(13, '0') + ':' + filterId;

export const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= latestTime;

type Compared = Pick<Version, Field> & { descriptionMissing?: true };

/**
 * Fields whose values differ between two versions (or a version and the current filter). A
 * description Jira didn't send is never counted as a change.
 */
export const changedFields = (before: Compared, after: Compared, compared: Field[] = fields) =>
  compared.filter(
    (field) =>
      before[field] !== after[field] &&
      !(field === 'description' && (before.descriptionMissing || after.descriptionMissing)),
  );

export type Part = { text: string; change: 'same' | 'removed' | 'added' };

// Above this many tokens on either side the comparison shows the whole text as replaced; JQL and
// descriptions are far shorter, and the table below grows with the product of both lengths.
const maxTokens = 2000;

/** Word-level difference of two texts: unchanged, removed and added runs in reading order. */
export function diffText(before: string, after: string): Part[] {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  if (a.length > maxTokens || b.length > maxTokens)
    return merge([
      { text: before, change: 'removed' },
      { text: after, change: 'added' },
    ]);
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
  return merge(parts);
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
