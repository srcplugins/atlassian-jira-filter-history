// Readers for resolver responses: the UI renders only values of the expected shape.
import { isRecord, isText, unwrapResponse } from './shared/response.mjs';
import { fields, type Field } from './versions';

export interface OverviewRow {
  filterId: string;
  name: string;
  owner: string;
  at: number;
  actor: string;
}
export interface DeletedRow extends OverviewRow {
  /** When the daily cleanup removes the deleted filter's history. */
  expires: number;
}
/** A version in the history's table: when, by whom and what it changed, without its texts. */
export interface HistoryVersion {
  at: number;
  actor: string;
  restored: boolean;
  recreated: boolean;
  changed: Field[];
}
/** A version's texts, loaded when it is opened. */
export interface VersionText {
  at: number;
  actor: string;
  name: string;
  description: string;
  /** Jira didn't send this version's description (over 10,000 characters). */
  descriptionMissing?: boolean;
  jql: string;
  owner: string;
  restored: boolean;
  recreated: boolean;
}
export interface FilterNow {
  id: string;
  name: string;
  description: string;
  jql: string;
  owner: string;
  isWritable: boolean;
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;
// Jira caps a filter's name at 255 characters; its description and JQL have no documented limit.
const isQuery = (value: Record<string, unknown>) =>
  isText(value.name, 1000) && isText(value.description, 2_000_000) && isText(value.jql, 2_000_000);
const isAccount = (value: unknown) => isText(value, 200);

function invalid(): never {
  throw Error('Invalid response');
}

const isRow = (row: unknown): row is Record<string, unknown> =>
  isRecord(row) &&
  isText(row.filterId, 20) &&
  isText(row.name, 1000) &&
  isAccount(row.owner) &&
  isTime(row.at) &&
  isAccount(row.actor);

export function readOverview(response: unknown) {
  const value = unwrapResponse(response);
  if (
    !isRecord(value) ||
    !Array.isArray(value.filters) ||
    typeof value.partial !== 'boolean' ||
    !Array.isArray(value.deleted) ||
    typeof value.deletedPartial !== 'boolean' ||
    typeof value.admin !== 'boolean'
  )
    invalid();
  for (const row of value.filters) if (!isRow(row)) invalid();
  for (const row of value.deleted) if (!isRow(row) || !isTime(row.expires)) invalid();
  return value as {
    filters: OverviewRow[];
    partial: boolean;
    deleted: DeletedRow[];
    deletedPartial: boolean;
    admin: boolean;
  };
}

export function readHistory(response: unknown) {
  const value = unwrapResponse(response);
  if (
    !isRecord(value) ||
    !isRecord(value.filter) ||
    !isText(value.filter.id, 20) ||
    !isQuery(value.filter) ||
    !isAccount(value.filter.owner) ||
    typeof value.filter.isWritable !== 'boolean' ||
    !Array.isArray(value.versions) ||
    typeof value.more !== 'boolean' ||
    typeof value.current !== 'boolean' ||
    typeof value.admin !== 'boolean' ||
    (value.deleted !== null &&
      (!isRecord(value.deleted) ||
        !isTime(value.deleted.at) ||
        !isAccount(value.deleted.actor) ||
        !isTime(value.deleted.expires) ||
        typeof value.deleted.canRecreate !== 'boolean')) ||
    (value.cleared !== null &&
      (!isRecord(value.cleared) || !isTime(value.cleared.at) || !isAccount(value.cleared.actor)))
  )
    invalid();
  for (const version of value.versions)
    if (
      !isRecord(version) ||
      !isTime(version.at) ||
      !isAccount(version.actor) ||
      typeof version.restored !== 'boolean' ||
      typeof version.recreated !== 'boolean' ||
      !Array.isArray(version.changed) ||
      !version.changed.every((field) => fields.includes(field as Field))
    )
      invalid();
  return value as {
    filter: FilterNow;
    versions: HistoryVersion[];
    more: boolean;
    /** The filter in Jira matches the newest version. */
    current: boolean;
    /**
     * Set when the filter is deleted and the viewer, its owner or an administrator, sees its kept
     * history; only the owner can recreate it.
     */
    deleted: { at: number; actor: string; expires: number; canRecreate: boolean } | null;
    /** When and by whom an administrator last deleted the filter's earlier history. */
    cleared: { at: number; actor: string } | null;
    admin: boolean;
  };
}

const isVersionText = (value: unknown): value is VersionText =>
  isRecord(value) &&
  isTime(value.at) &&
  isAccount(value.actor) &&
  isQuery(value) &&
  isAccount(value.owner) &&
  typeof value.restored === 'boolean' &&
  typeof value.recreated === 'boolean' &&
  (value.descriptionMissing === undefined || value.descriptionMissing === true);

export function readVersion(response: unknown) {
  const value = unwrapResponse(response);
  if (
    !isRecord(value) ||
    !isVersionText(value.version) ||
    (value.previous !== null && !isVersionText(value.previous))
  )
    invalid();
  return value as { version: VersionText; previous: VersionText | null };
}

export function readRestore(response: unknown) {
  const value = unwrapResponse(response);
  if (!isRecord(value) || value.restored !== true) invalid();
  return value as { restored: true };
}

export function readRecreate(response: unknown) {
  const value = unwrapResponse(response);
  if (!isRecord(value) || !isText(value.filterId, 20)) invalid();
  return value as { filterId: string };
}

export function readDeleteHistory(response: unknown) {
  const value = unwrapResponse(response);
  if (!isRecord(value) || value.deleted !== true) invalid();
  return value as { deleted: true };
}
