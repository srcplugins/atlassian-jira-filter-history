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
  /** Only the deleted filter's last owner can open its history. */
  canOpen: boolean;
}
export interface HistoryVersion {
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
  changed: Field[];
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
const isQuery = (value: Record<string, unknown>) =>
  isText(value.name, 1000) && isText(value.description, 100_000) && isText(value.jql, 100_000);
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
  for (const row of value.deleted) if (!isRow(row) || typeof row.canOpen !== 'boolean') invalid();
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
    typeof value.admin !== 'boolean' ||
    (value.deleted !== null &&
      (!isRecord(value.deleted) || !isTime(value.deleted.at) || !isAccount(value.deleted.actor)))
  )
    invalid();
  for (const version of value.versions)
    if (
      !isRecord(version) ||
      !isTime(version.at) ||
      !isAccount(version.actor) ||
      !isQuery(version) ||
      !isAccount(version.owner) ||
      typeof version.restored !== 'boolean' ||
      typeof version.recreated !== 'boolean' ||
      (version.descriptionMissing !== undefined && version.descriptionMissing !== true) ||
      !Array.isArray(version.changed) ||
      !version.changed.every((field) => fields.includes(field as Field))
    )
      invalid();
  return value as {
    filter: FilterNow;
    versions: HistoryVersion[];
    more: boolean;
    /** Set when the filter is deleted and the viewer, its owner, sees its kept history. */
    deleted: { at: number; actor: string } | null;
    admin: boolean;
  };
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
