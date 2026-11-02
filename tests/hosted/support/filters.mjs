// Journaled saved-filter fixtures for Filter History's hosted journeys and runners. Saved filters
// are site objects that the framework's `owned` fixture doesn't know, so this module journals them
// with the framework's FixtureRun: intent before every create, a failed create reconciled by its
// marker, never repeated, and cleanup that rechecks each filter's owner, marker, query and sharing
// before deleting it and confirms the deletion with an independent read.
//
// Every filter belongs to one of the identity profile's pinned accounts (admin: the API account,
// member, restricted) and is written and read as that account: the API token for admin, the saved
// browser session for the others. Its JQL names the identity space, which all three can browse.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  FixtureRun,
  activeTarget,
  markers,
  safeRequest,
} from '@srcplugins/atlassian-forge-test-framework/core';
import { client, identityFixture, site } from '@srcplugins/atlassian-forge-test-framework/jira';

const roles = ['admin', 'member', 'restricted'];
// The identity fixture names the API account "owner"; its saved session is "admin".
const actorKey = (role) => (role === 'admin' ? 'owner' : role);

/** Where filter journals live: one JSON file per run, beside the framework's own run journals. */
export const journalDirectory = () => `${activeTarget().directory}/filter-history-runs`;
const lockFile = () => `${journalDirectory()}/filters.lock`;
const journalPath = (runId) => `${journalDirectory()}/${runId}.json`;

/** The identity space's key and the pinned account IDs, by role. */
function identity() {
  const fixture = identityFixture();
  return {
    projectKey: fixture.project.key,
    projectId: fixture.project.id,
    accounts: Object.fromEntries(roles.map((role) => [role, fixture.actors[actorKey(role)]])),
  };
}

/**
 * One request to Jira REST v3 on the site under test that keeps the status: `{ status, body }`.
 * Used where the status itself is the fact (a refused write, a hidden or deleted filter). Never
 * retried; failures carry no response details.
 */
export async function jiraCall(request, path, method = 'GET', data) {
  if (!path.startsWith('/') || path.includes('://') || path.includes('..'))
    throw Error('Invalid Jira path');
  const response = await safeRequest(
    () =>
      request.fetch(`${site()}/rest/api/3${path}`, {
        method,
        ...(data === undefined ? {} : { data }),
        timeout: 30000,
        maxRedirects: 0,
      }),
    `${method} fetch`,
  );
  const text = await safeRequest(() => response.text(), `${method} body read`);
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status(), body };
}

/**
 * A saved session's request context that sends the site as its Origin, as Jira's own pages do.
 * Without it Jira refuses a session's POST with "XSRF check failed" (403) before checking anything
 * else, which would hide the permission answer a journey asserts.
 */
const sameOrigin = (request) => ({
  fetch: (url, options = {}) =>
    request.fetch(url, { ...options, headers: { ...options.headers, Origin: site() } }),
});

/** A filter's sharing as sorted, comparable strings: `{ share: [...], edit: [...] }`. */
export function sharing(filter) {
  const one = (permission) => {
    switch (permission?.type) {
      case 'project':
        return `project:${permission.project?.id}`;
      case 'user':
        return `user:${permission.user?.accountId}`;
      case 'group':
        return `group:${permission.group?.groupId ?? permission.group?.name}`;
      case 'projectRole':
        return `projectRole:${permission.project?.id}:${permission.role?.id}`;
      default:
        return String(permission?.type);
    }
  };
  return {
    share: (filter.sharePermissions ?? []).map(one).sort(),
    edit: (filter.editPermissions ?? []).map(one).sort(),
  };
}

const sameSharing = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameQuery = (a, b) => a.name === b.name && a.description === b.description && a.jql === b.jql;
/** The name, description and JQL of a filter or version. */
export const query = ({ name, description, jql }) => ({
  name,
  description: description ?? '',
  jql,
});

/**
 * Opens a journaled filter run, or recovers one (`recover: runId`). `contexts` maps the member and
 * restricted roles to browser contexts holding their saved sessions; `request` is the API account.
 * @param {{ request: any, contexts: any, runId?: string, recover?: string, title?: string }} options
 */
export async function filterRun({ request, contexts, runId, recover, title }) {
  const ids = identity();
  const requests = {
    admin: request,
    member: sameOrigin(contexts.member.request),
    restricted: sameOrigin(contexts.restricted.request),
  };
  const apis = Object.fromEntries(roles.map((role) => [role, client(requests[role])]));
  // Each session must be its pinned account before anything is written as it.
  for (const role of roles)
    if ((await apis[role]('/myself'))?.accountId !== ids.accounts[role])
      throw Error(`The ${role} session is not its pinned identity account.`);

  const directory = journalDirectory();
  mkdirSync(directory, { recursive: true });
  const id = recover ?? runId ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw Error('Invalid run ID');
  // One filter run at a time on this site; a dead holder is cleared only by its own recovery.
  if (existsSync(lockFile())) {
    const holder = JSON.parse(readFileSync(lockFile(), 'utf8'));
    if (!recover || holder.runId !== recover)
      throw Error('Filter fixtures are locked by another run');
    let alive = true;
    try {
      process.kill(holder.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') alive = false;
      else throw Error('Cannot verify the filter lock owner', { cause: error });
    }
    if (alive) throw Error('The filter run is still running');
    unlinkSync(lockFile());
  }
  writeFileSync(lockFile(), JSON.stringify({ runId: id, pid: process.pid }), {
    flag: 'wx',
    mode: 0o600,
  });
  const save = (state) => {
    const path = journalPath(state.runId);
    writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  let run;
  let read;
  let verify;
  // The app's own create of the filter a journey is about to record (see `recreated`).
  let appCreate;
  try {
    for (const name of readdirSync(directory).filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))) {
      const state = JSON.parse(readFileSync(`${directory}/${name}`, 'utf8'));
      if (state.status !== 'clean' && state.runId !== recover)
        throw Error(`Unresolved filter run ${state.runId}; recover it first`);
    }
    const entryFor = (filterId) =>
      run.state.resources.find((entry) => entry.kind === 'filter' && entry.id === filterId);

    // A filter as its owner reads it, with its sharing; null once Jira has no such filter. Jira
    // answers a deleted filter with 400 or 404, so either is confirmed through the administrator's
    // search across every filter's sharing before it counts as absent.
    read = async (filterId, role = entryFor(filterId)?.expected.owner) => {
      if (!roles.includes(role)) throw Error('Unknown filter owner');
      const { status, body } = await jiraCall(
        requests[role],
        `/filter/${filterId}?expand=sharePermissions,editPermissions`,
      );
      if (status === 200) return body;
      if (status !== 400 && status !== 404) throw Error(`Filter read failed (HTTP ${status})`);
      const found = await apis.admin(
        `/filter/search?id=${filterId}&overrideSharePermissions=true&maxResults=1`,
      );
      if (!Array.isArray(found?.values)) throw Error('Invalid filter search');
      if (found.values.length) throw Error('The filter exists but its owner cannot read it');
      return null;
    };
    // Filters whose name is one the run intended and whose description carries its marker.
    const find = async (expected) => {
      const matches = new Map();
      for (const { name } of expected.variants) {
        const found = await apis.admin(
          `/filter/search?filterName=${encodeURIComponent(name)}&expand=description,owner&overrideSharePermissions=true&maxResults=100`,
        );
        if (!Array.isArray(found?.values) || found.isLast === false)
          throw Error('Invalid or incomplete filter search');
        for (const filter of found.values)
          if (String(filter.description ?? '').includes(expected.marker))
            matches.set(String(filter.id), filter);
      }
      return [...matches.values()];
    };
    verify = async (entry, current) => {
      const filter = current ?? (await read(entry.id));
      const { expected } = entry;
      if (!filter || String(filter.id) !== entry.id) throw Error('Filter identity mismatch');
      if (filter.owner?.accountId !== run.state.accounts[expected.owner])
        throw Error('Filter owner changed');
      if (!String(filter.description ?? '').includes(expected.marker))
        throw Error('Filter marker missing');
      if (!expected.variants.some((variant) => sameQuery(query(filter), variant)))
        throw Error('Filter query differs from every recorded intent');
      if (!expected.sharing.some((allowed) => sameSharing(sharing(filter), allowed)))
        throw Error('Filter sharing differs from every recorded intent');
      if (filter.subscriptions?.items?.length) throw Error('Filter acquired subscriptions');
      return filter;
    };
    const adapters = {
      filter: {
        create: (expected) => {
          if (expected.via === 'app') {
            const create = appCreate;
            appCreate = undefined;
            if (!create) throw Error('No app create to record');
            return create();
          }
          return apis[expected.owner]('/filter', 'POST', {
            ...expected.variants[0],
            sharePermissions: expected.create.share,
            editPermissions: expected.create.edit,
          });
        },
        read,
        find,
        absent: async (expected) => (await find(expected)).length === 0,
        verify,
        remove: async (entry) => {
          await verify(entry);
          await apis[entry.expected.owner](`/filter/${entry.id}`, 'DELETE');
        },
      },
    };
    if (recover) {
      const state = JSON.parse(readFileSync(journalPath(recover), 'utf8'));
      if (
        state.schemaVersion !== 1 ||
        state.runId !== recover ||
        state.app !== 'filter-history' ||
        state.site !== site() ||
        state.projectId !== ids.projectId ||
        roles.some((role) => state.accounts?.[role] !== ids.accounts[role]) ||
        !Array.isArray(state.resources) ||
        state.resources.some(
          (entry) =>
            entry.kind !== 'filter' ||
            (entry.id !== null && !/^[1-9]\d*$/.test(entry.id)) ||
            !roles.includes(entry.expected?.owner) ||
            !String(entry.expected?.marker ?? '').startsWith(
              markers.acceptance('filter', recover),
            ) ||
            !entry.expected.variants?.every((v) => v.description.includes(entry.expected.marker)),
        )
      )
        throw Error('Filter run ownership mismatch');
      run = new FixtureRun({ state, save, adapters });
    } else {
      run = FixtureRun.create({
        app: 'filter-history',
        site: site(),
        projectId: ids.projectId,
        save,
        adapters,
        runId: id,
      });
      run.state.accounts = ids.accounts;
      run.state.test = title;
      run.persist();
    }
  } catch (error) {
    unlinkSync(lockFile());
    throw error;
  }

  const short = id.replaceAll('-', '').slice(0, 8);
  return {
    run,
    ids,
    site: site(),
    apis,
    requests,
    short,
    /** A JQL that names the identity space and a label unique to this run and `tag`. */
    jql: (tag) => `project = ${ids.projectKey} AND labels = fh${short}${tag}`,
    /**
     * Creates a filter owned by `role` with a run-marked description. `share` and `edit` are Jira
     * share permission bodies; `sharing` is how Jira will report them (see `sharing`).
     */
    async filter(role, { name, jql, share = [], edit = [], expectSharing }) {
      const index = run.state.resources.length;
      const marker = `${markers.acceptance('filter', run.state.runId)}/${index}`;
      return run.create('filter', {
        owner: role,
        marker,
        create: { share, edit },
        variants: [{ name, description: `${marker}. Synthetic saved filter.`, jql }],
        sharing: [expectSharing],
      });
    },
    /**
     * Records the filter the app creates when its owner recreates the deleted `entry` from
     * `variant`, then runs `exercise`, which makes the app create it and resolves with its ID. The
     * new filter keeps the deleted one's marker and must be private to the owner.
     */
    async recreated(entry, variant, exercise) {
      if (entry.status !== 'removed') throw Error('Only a deleted filter can be recreated');
      if (!entry.expected.variants.some((v) => sameQuery(v, variant)))
        throw Error("A recreated filter holds one of the deleted filter's queries");
      appCreate = async () => ({ id: await exercise() });
      return run.create('filter', {
        owner: entry.expected.owner,
        marker: entry.expected.marker,
        via: 'app',
        create: { share: [], edit: [] },
        variants: [variant],
        sharing: [{ share: [], edit: [] }],
      });
    },
    /** Records a query the filter may hold, before the write that sets it. */
    allowQuery(entry, variant) {
      if (!variant.description.includes(entry.expected.marker))
        throw Error('A filter description must keep its run marker');
      if (!entry.expected.variants.some((v) => sameQuery(v, variant)))
        entry.expected.variants.push(variant);
      run.persist();
    },
    /** Records sharing the filter may hold, before the write that sets it. */
    allowSharing(entry, expected) {
      if (!entry.expected.sharing.some((s) => sameSharing(s, expected)))
        entry.expected.sharing.push(expected);
      run.persist();
    },
    /** Writes a recorded query as `role` (Jira's own update, as that account). */
    async update(entry, role, variant) {
      this.allowQuery(entry, variant);
      await apis[role](`/filter/${entry.id}`, 'PUT', variant);
    },
    read: (entry, role) => read(entry.id, role ?? entry.expected.owner),
    /** Deletes a filter of this run as its owner and confirms the deletion independently. */
    async remove(entry) {
      await verify(entry);
      entry.status = 'deleting';
      run.persist();
      await apis[entry.expected.owner](`/filter/${entry.id}`, 'DELETE');
      if ((await read(entry.id)) !== null) throw Error('Deletion not independently confirmed');
      entry.status = 'removed';
      run.persist();
    },
    async cleanup() {
      try {
        await run.cleanup({ ...(recover ? { absentAfterMs: 300_000 } : {}) });
      } finally {
        if (run.state.status === 'clean') unlinkSync(lockFile());
      }
    },
  };
}

/** The run IDs of filter journals that aren't clean. */
export function unresolvedFilterRuns() {
  const directory = journalDirectory();
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(`${directory}/${name}`, 'utf8')))
    .filter((state) => state.status !== 'clean')
    .map((state) => state.runId);
}
