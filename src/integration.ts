import type { FetchAPI } from '@forge/api';
import type { kvs as forgeKvs, WhereConditions as ForgeWhereConditions } from '@forge/kvs';
import { JiraHttpError, UserError, isDefinitiveRejection, jiraReader } from './shared/jira.mjs';
import { needsConsent } from './shared/resolver.mjs';
import { isRecord } from './shared/response.mjs';
import { isFilterId } from './versions';

export interface JiraDeps {
  api: Pick<FetchAPI, 'asUser'>;
  route: typeof import('@forge/api').route;
}

export interface StoreDeps {
  kvs: Pick<typeof forgeKvs, 'get' | 'set' | 'delete' | 'query' | 'transact' | 'batchDelete'>;
  WhereConditions: Pick<typeof ForgeWhereConditions, 'beginsWith'>;
}

/** A filter as the viewer sees it in Jira now. */
export interface CurrentFilter {
  id: string;
  name: string;
  description: string;
  jql: string;
  owner: string;
  isWritable: boolean;
}

/** The outcome of a write: applied, refused by Jira (nothing changed), or unknown. */
export type WriteOutcome =
  { status: 'applied' } | { status: 'rejected'; message: string } | { status: 'uncertain' };
export type CreateOutcome =
  | { status: 'applied'; id: string }
  | { status: 'rejected'; message: string }
  | { status: 'uncertain' };

type Query = Pick<CurrentFilter, 'name' | 'description' | 'jql'>;

// Jira's filter search returns only filters the viewer can see. The app asks for 100 per page (the
// API takes up to 200 IDs) and follows further pages up to a bound.
const searchPage = 100;
const maxSearchPages = 10;

function currentFilter(value: unknown): CurrentFilter {
  if (
    !isRecord(value) ||
    !isFilterId(String(value.id ?? '')) ||
    typeof value.name !== 'string' ||
    typeof value.jql !== 'string' ||
    (value.description !== undefined && typeof value.description !== 'string')
  )
    throw new UserError('Jira returned unreadable data.');
  return {
    id: String(value.id),
    name: value.name,
    description: value.description ?? '',
    jql: value.jql,
    owner:
      isRecord(value.owner) && typeof value.owner.accountId === 'string'
        ? value.owner.accountId
        : '',
    isWritable: value.isWritable === true,
  };
}

/** Jira's own words for a refused restore (such as invalid JQL), or nothing usable. */
function rejectionMessage(body: unknown) {
  if (!isRecord(body)) return '';
  const messages = [
    ...(Array.isArray(body.errorMessages) ? body.errorMessages : []),
    ...(isRecord(body.errors) ? Object.values(body.errors) : []),
  ].filter((message): message is string => typeof message === 'string' && Boolean(message.trim()));
  return messages.join(' ').slice(0, 500);
}

async function readBody(response: { json: () => Promise<unknown> }) {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

// Tests substitute the SDK below this boundary, so these exact requests are verified.
export function createJira({ api, route }: JiraDeps) {
  const read = jiraReader(api);
  /** Sends one write as the viewer; a failure Jira doesn't define as a refusal is uncertain. */
  async function write(
    operation: 'filter-create' | 'filter-update',
    request: () => ReturnType<ReturnType<JiraDeps['api']['asUser']>['requestJira']>,
  ) {
    let response;
    try {
      response = await request();
    } catch (error) {
      // Forge refused before sending, for missing access: it must leave the resolver to prompt.
      if (needsConsent(error)) throw error;
      return { status: 'uncertain' } as const;
    }
    if (response.ok) return { status: 'applied', response } as const;
    if (!isDefinitiveRejection(operation, response.status)) return { status: 'uncertain' } as const;
    return {
      status: 'rejected',
      message:
        rejectionMessage(await readBody(response)) || new JiraHttpError(response.status).message,
    } as const;
  }
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  /**
   * Every filter a search returns, following Jira's pages until it says the last one came. A page
   * that is neither complete nor the last is unreadable, never "no more filters".
   */
  async function search(params: URLSearchParams) {
    const found: CurrentFilter[] = [];
    let startAt = 0;
    for (let page = 1; ; page++) {
      const paged = new URLSearchParams(params);
      if (startAt) paged.set('startAt', String(startAt));
      const body: unknown = await read(route`/rest/api/3/filter/search?${paged}`);
      if (!isRecord(body) || !Array.isArray(body.values) || typeof body.isLast !== 'boolean')
        throw new UserError('Jira returned unreadable data.');
      found.push(...body.values.map(currentFilter));
      if (body.isLast) return found;
      if (!body.values.length || page >= maxSearchPages)
        throw new UserError('Jira returned unreadable data.');
      startAt += body.values.length;
    }
  }
  return {
    /** Whether the viewer has Jira's Administer Jira permission. */
    async isAdmin() {
      const body: unknown = await read(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
      if (!isRecord(body) || !isRecord(body.permissions) || !isRecord(body.permissions.ADMINISTER))
        throw new UserError('Jira returned unreadable data.');
      return body.permissions.ADMINISTER.havePermission === true;
    },
    /** The listed filters the viewer can see, keyed by ID; hidden and deleted ones are absent. */
    async visibleFilters(ids: string[]) {
      const visible = new Map<string, CurrentFilter>();
      for (let start = 0; start < ids.length; start += searchPage) {
        const params = new URLSearchParams();
        for (const id of ids.slice(start, start + searchPage)) params.append('id', id);
        params.set('expand', 'description,jql,owner,isWritable');
        params.set('maxResults', String(searchPage));
        for (const filter of await search(params)) visible.set(filter.id, filter);
      }
      return visible;
    },
    /** The viewer's own filters named exactly `name` (Jira matches names partially). */
    async ownFilters(name: string, owner: string) {
      const params = new URLSearchParams({
        filterName: name,
        isSubstringMatch: 'true',
        accountId: owner,
        expand: 'description,jql,owner,isWritable',
        maxResults: String(searchPage),
      });
      return (await search(params)).filter(
        (filter) => filter.name === name && filter.owner === owner,
      );
    },
    /** Writes name, description and JQL only, so Jira keeps the filter's sharing. Never retried. */
    async updateFilter(id: string, query: Query): Promise<WriteOutcome> {
      const outcome = await write('filter-update', () =>
        api.asUser().requestJira(route`/rest/api/3/filter/${id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            name: query.name,
            description: query.description,
            jql: query.jql,
          }),
        }),
      );
      return outcome.status === 'applied' ? { status: 'applied' } : outcome;
    },
    /** Creates a filter owned by and shared with no one but the viewer. Never retried. */
    async createFilter(query: Query): Promise<CreateOutcome> {
      const outcome = await write('filter-create', () =>
        api.asUser().requestJira(route`/rest/api/3/filter`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: query.name,
            description: query.description,
            jql: query.jql,
            sharePermissions: [],
            editPermissions: [],
          }),
        }),
      );
      if (outcome.status !== 'applied') return outcome;
      // Created, but without a readable ID the app can't tell which filter it is.
      const body = await readBody(outcome.response);
      const id = isRecord(body) ? String(body.id ?? '') : '';
      return isFilterId(id) ? { status: 'applied', id } : { status: 'uncertain' };
    },
  };
}

/** App storage failed; the trigger asks Forge to deliver the event again. */
export class StorageUnavailable extends UserError {
  constructor() {
    super('App storage is unavailable. Try again shortly.');
  }
}

async function stored<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch {
    throw new StorageUnavailable();
  }
}

// KVS returns at most 100 entries per query page; batch deletes and transactions take at most 25
// keys.
const queryPage = 100;
const deleteBatch = 25;

export function createStore({ kvs, WhereConditions }: StoreDeps) {
  /** Up to `limit` values whose keys begin with `prefix`, in key order. */
  async function list<T>(prefix: string, limit: number) {
    const values: { key: string; value: T }[] = [];
    let cursor: string | undefined;
    do {
      let query = kvs
        .query()
        .where('key', WhereConditions.beginsWith(prefix))
        .limit(Math.min(queryPage, limit - values.length));
      if (cursor) query = query.cursor(cursor);
      const page = await stored(() => query.getMany<T>());
      values.push(...page.results);
      cursor = page.nextCursor;
    } while (cursor && values.length < limit);
    return values;
  }
  async function deleteKeys(keys: string[]) {
    for (let start = 0; start < keys.length; start += deleteBatch) {
      const batch = keys.slice(start, start + deleteBatch).map((key) => ({ key }));
      const result = await stored(() => kvs.batchDelete(batch));
      if (result.failedKeys.length) throw new StorageUnavailable();
    }
  }
  return {
    get: <T>(key: string) => stored(() => kvs.get<T>(key)),
    set: <T>(key: string, value: T) => stored(() => kvs.set(key, value)),
    /** All of up to 25 entries or none. */
    async setTogether(entries: { key: string; value: unknown }[]) {
      if (entries.length > deleteBatch) throw Error('A transaction takes at most 25 entries.');
      let transaction = kvs.transact();
      for (const { key, value } of entries) transaction = transaction.set(key, value);
      await stored(() => transaction.execute());
    },
    /** Writes the entries in transactions of up to 25. */
    async setMany<T>(entries: { key: string; value: T }[]) {
      for (let start = 0; start < entries.length; start += deleteBatch) {
        let transaction = kvs.transact();
        for (const { key, value } of entries.slice(start, start + deleteBatch))
          transaction = transaction.set(key, value);
        await stored(() => transaction.execute());
      }
    },
    list,
    deleteKeys,
    delete: (key: string) => stored(() => kvs.delete(key)),
  };
}

export type Jira = ReturnType<typeof createJira>;
export type Store = ReturnType<typeof createStore>;
