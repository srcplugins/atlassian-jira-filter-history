import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forgeContract } from './support/forge-contract.mjs';
import { assertResolversCalled } from './support/contracts.mjs';
import { memoryKvs } from './support/kvs.mjs';
const { registerResolvers } = await import('../src/resolvers.ts');
const { createCleanupHandler, createFilterEventHandler } = await import('../src/events.ts');

/** The stored history, without the account registry the personal data report reads. */
// Leaves out the personal data report's registry: account IDs and the filters that hold them.
const stored = (storage) =>
  [...storage.data].filter(([key]) => !key.startsWith('account:') && !key.startsWith('uses:'));
const storedKeys = (storage) => stored(storage).map(([key]) => key);

const context = { accountId: 'viewer' };
const searchPath = (...ids) =>
  `/rest/api/3/filter/search?${ids.map((id) => `id=${id}&`).join('')}expand=description%2Cjql%2Cowner%2CisWritable&maxResults=100`;
// The overview reads only each filter's name and owner.
const listPath = (...ids) =>
  `/rest/api/3/filter/search?${ids.map((id) => `id=${id}&`).join('')}expand=owner&maxResults=100`;
// An administrator's search includes filters shared with no one but their owner.
const overridePath = (...ids) => `${searchPath(...ids)}&overrideSharePermissions=true`;
const adminPath = '/rest/api/3/mypermissions?permissions=ADMINISTER';
const admin = (havePermission) => ({
  expect: { method: 'GET', path: adminPath },
  body: { permissions: { ADMINISTER: { key: 'ADMINISTER', havePermission } } },
});
const read = (path) => ({
  actor: 'asUser',
  path,
  method: 'GET',
  headers: { Accept: 'application/json' },
});
const filter = {
  id: '10001',
  name: 'Bugs',
  description: 'All bugs',
  jql: 'type = Bug',
  owner: { accountId: 'owner', displayName: 'Owner' },
  isWritable: true,
};
// Jira sends the change time as a string of epoch milliseconds (measured on a hosted site).
const event = (at, jql) => ({
  eventType: 'avi:jira:updated:filter',
  atlassianId: 'editor',
  timestamp: String(at),
  filter: { id: '10001', name: 'Bugs', description: 'All bugs', jql, owner: 'owner' },
});

/** Real handlers over the SDK double and in-memory storage, with two recorded versions. */
async function handlers(...responses) {
  const sdk = forgeContract(...responses);
  const storage = memoryKvs();
  const deps = {
    ...sdk,
    kvs: storage.kvs,
    WhereConditions: storage.WhereConditions,
    appContext: () => ({ environmentType: 'DEVELOPMENT' }),
  };
  const record = createFilterEventHandler(deps);
  await record(event(1000, 'type = Bug AND status = Open'));
  await record(event(2000, 'type = Bug'));
  return { sdk, storage, resolvers: registerResolvers(deps) };
}

test('the trigger records events without any Jira request', async () => {
  const { sdk, storage } = await handlers();
  assert.equal(sdk.calls.length, 0);
  assert.deepEqual(
    storage.data.get('filter:10001').entries.map(({ at }) => at),
    [1000, 2000],
  );
});

test('overview and history check the permission, then make one exact asUser filter search', async () => {
  const { sdk, resolvers } = await handlers(
    admin(false),
    { body: { isLast: true, values: [filter] } },
    admin(true),
    { body: { isLast: true, values: [filter] } },
  );
  assert.deepEqual(Object.keys(resolvers), [
    'overview',
    'history',
    'version',
    'restore',
    'recreate',
    'deleteHistory',
  ]);
  const overview = await resolvers.overview({ context });
  assert.deepEqual(overview, {
    ok: true,
    value: {
      filters: [{ filterId: '10001', name: 'Bugs', owner: 'owner', at: 2000, actor: 'editor' }],
      partial: false,
      deleted: [],
      deletedPartial: false,
      admin: false,
    },
  });
  const history = await resolvers.history({ context, payload: { filterId: '10001' } });
  assert.equal(history.ok, true);
  assert.deepEqual(
    history.value.versions.map(({ at, changed }) => [at, changed]),
    [
      [2000, ['jql']],
      [1000, []],
    ],
  );
  assert.equal(history.value.admin, true);
  assert.deepEqual(sdk.calls, [
    read(adminPath),
    read(listPath('10001')),
    read(adminPath),
    read(overridePath('10001')),
  ]);
  sdk.assertDrained();
});

test('a filter Jira sends without JQL, or with a null description or owner, still lists and opens', async () => {
  const bare = { id: '10001', name: 'Bugs', owner: null };
  const { sdk, resolvers } = await handlers(
    admin(false),
    { body: { isLast: true, values: [bare] } },
    admin(false),
    { body: { isLast: true, values: [{ ...bare, jql: 'type = Bug', description: null }] } },
  );
  const overview = await resolvers.overview({ context });
  assert.deepEqual(overview.value.filters, [
    { filterId: '10001', name: 'Bugs', owner: '', at: 2000, actor: 'editor' },
  ]);
  const history = await resolvers.history({ context, payload: { filterId: '10001' } });
  assert.deepEqual(history.value.filter, {
    id: '10001',
    name: 'Bugs',
    description: '',
    jql: 'type = Bug',
    owner: '',
    isWritable: false,
  });
  sdk.assertDrained();
});

test('an unreadable permission answer fails the overview, never treated as not an admin', async () => {
  const { sdk, resolvers } = await handlers({ body: {} });
  assert.deepEqual(await resolvers.overview({ context }), {
    ok: false,
    error: 'Jira returned unreadable data.',
  });
  assert.deepEqual(sdk.calls, [read(adminPath)]);
});

const deleted = { ...event(3000, 'type = Bug'), eventType: 'avi:jira:deleted:filter' };
// The owner's filters named like the one recreated, read before the create and to adopt one.
const ownPath =
  '/rest/api/3/filter/search?filterName=Bugs&isSubstringMatch=true&accountId=owner&expand=description%2Cjql%2Cowner%2CisWritable&maxResults=100';
const own = (...values) => ({
  expect: { method: 'GET', path: ownPath },
  body: { isLast: true, values },
});

test('recreate makes one exact POST of a private filter and moves the history to it', async () => {
  const { sdk, storage, resolvers } = await handlers(own({ ...filter, id: '10040' }), {
    status: 201,
    body: { id: 10050, name: 'Bugs' },
  });
  await createFilterEventHandler({
    ...sdk,
    kvs: storage.kvs,
    WhereConditions: storage.WhereConditions,
  })(deleted);
  const result = await resolvers.recreate({
    context: { accountId: 'owner' },
    payload: { filterId: '10001', at: 1000 },
  });
  assert.deepEqual(result, { ok: true, value: { filterId: '10050' } });
  assert.deepEqual(sdk.calls, [
    read(ownPath),
    {
      actor: 'asUser',
      path: '/rest/api/3/filter',
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bugs',
        description: 'All bugs',
        jql: 'type = Bug AND status = Open',
        sharePermissions: [],
        editPermissions: [],
      }),
    },
  ]);
  assert.equal(storedKeys(storage).filter((key) => key.startsWith('version:10050:')).length, 2);
});

test("an identity in the payload never opens, lists or recreates another user's deleted filter", async () => {
  const empty = { body: { isLast: true, values: [] } };
  // The deleted filter has no entry among the recently changed, so the overviews search nothing.
  const { sdk, storage, resolvers } = await handlers(
    admin(false),
    empty,
    admin(false),
    admin(false),
    empty,
    admin(false),
  );
  await createFilterEventHandler({
    ...sdk,
    kvs: storage.kvs,
    WhereConditions: storage.WhereConditions,
  })(deleted);
  const forged = { accountId: 'owner', viewer: 'owner', owner: 'owner', principal: 'owner' };
  const as = (accountId) => ({ accountId });
  const unavailable = { ok: false, error: "This filter isn't available to you." };
  assert.deepEqual(
    await resolvers.history({ context: as('other'), payload: { filterId: '10001', ...forged } }),
    unavailable,
  );
  assert.deepEqual(
    await resolvers.recreate({
      context: as('other'),
      payload: { filterId: '10001', at: 1000, ...forged },
    }),
    unavailable,
  );
  const listed = await resolvers.overview({ context: as('other'), payload: forged });
  assert.deepEqual(listed.value.deleted, []);
  // The owner, by the request's context, gets both.
  const history = await resolvers.history({ context: as('owner'), payload: { filterId: '10001' } });
  assert.equal(history.value.filter.id, '10001');
  assert.equal((await resolvers.overview({ context: as('owner') })).value.deleted.length, 1);
  assert.ok(sdk.calls.every(({ method }) => method === 'GET'));
  sdk.assertDrained();
});

test("a refused recreate shows Jira's message; an unconfirmed one is never retried", async () => {
  const payload = { filterId: '10001', at: 1000 };
  const recreate = async (...responses) => {
    const { sdk, storage, resolvers } = await handlers(...responses);
    await createFilterEventHandler({
      ...sdk,
      kvs: storage.kvs,
      WhereConditions: storage.WhereConditions,
    })(deleted);
    return { sdk, result: await resolvers.recreate({ context: { accountId: 'owner' }, payload }) };
  };
  const refused = await recreate(own(), {
    status: 400,
    body: { errors: { filterName: 'A filter with this name already exists.' } },
  });
  assert.deepEqual(refused.result, {
    ok: false,
    error: 'Jira refused to recreate the filter: A filter with this name already exists.',
  });
  for (const failure of [
    { status: 503 },
    { status: 404 },
    { status: 201, body: {} },
    Error('private transport failure'),
  ]) {
    const unsure = await recreate(own(), failure, failure);
    assert.equal(unsure.result.ok, false);
    assert.match(unsure.result.error, /didn't confirm the new filter/);
    assert.equal(
      unsure.sdk.calls.filter(({ method }) => method === 'POST').length,
      1,
      'a write is made once',
    );
  }
});

test('delete history checks the permission, then the filter, and changes nothing in Jira', async () => {
  const { sdk, storage, resolvers } = await handlers(admin(true), {
    body: { isLast: true, values: [filter] },
  });
  assert.deepEqual(
    await resolvers.deleteHistory({ context, payload: { filterId: '10001', deleted: false } }),
    { ok: true, value: { deleted: true } },
  );
  assert.deepEqual(sdk.calls, [read(adminPath), read(overridePath('10001'))]);
  // Only who deleted the history and when stays, from the request's context.
  assert.deepEqual(storedKeys(storage), ['cleared:10001']);
  assert.equal(storage.data.get('cleared:10001').actor, 'viewer');
  const denied = await handlers(admin(false));
  assert.deepEqual(
    await denied.resolvers.deleteHistory({
      context,
      payload: { filterId: '10001', deleted: false },
    }),
    { ok: false, error: "Only Jira administrators can delete a filter's history." },
  );
  assert.equal(
    storedKeys(denied.storage).filter((key) => key.startsWith('version:10001:')).length,
    2,
  );
});

test('restore re-reads the filter, then makes one exact PUT of name, description and JQL', async () => {
  const { sdk, resolvers } = await handlers(
    { body: { isLast: true, values: [filter] } },
    { status: 200, body: {} },
  );
  const result = await resolvers.restore({
    context,
    payload: {
      filterId: '10001',
      at: 1000,
      expected: { name: 'Bugs', description: 'All bugs', jql: 'type = Bug' },
    },
  });
  assert.deepEqual(result, { ok: true, value: { restored: true } });
  assert.deepEqual(sdk.calls[1], {
    actor: 'asUser',
    path: '/rest/api/3/filter/10001',
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Bugs',
      description: 'All bugs',
      jql: 'type = Bug AND status = Open',
    }),
  });
  sdk.assertDrained();
});

test("a refused restore shows Jira's message; an unconfirmed one is never retried", async () => {
  const payload = {
    filterId: '10001',
    at: 1000,
    expected: { name: 'Bugs', description: 'All bugs', jql: 'type = Bug' },
  };
  const refused = await handlers(
    { body: { isLast: true, values: [filter] } },
    { status: 400, body: { errorMessages: ["Field 'x' does not exist."] } },
  );
  assert.deepEqual(await refused.resolvers.restore({ context, payload }), {
    ok: false,
    error: "Jira refused the restore: Field 'x' does not exist.",
  });
  // A long refusal is cut so the whole message fits the UI's 500 characters.
  const long = await handlers(
    { body: { isLast: true, values: [filter] } },
    { status: 400, body: { errorMessages: ['x'.repeat(2000)] } },
  );
  const cut = await long.resolvers.restore({ context, payload });
  assert.equal(cut.error, `Jira refused the restore: ${'x'.repeat(400)}`);
  for (const failure of [{ status: 503 }, Error('private transport failure')]) {
    const unsure = await handlers({ body: { isLast: true, values: [filter] } }, failure, failure);
    const result = await unsure.resolvers.restore({ context, payload });
    assert.equal(result.ok, false);
    assert.match(result.error, /didn't confirm/);
    assert.equal(unsure.sdk.calls.length, 2, 'a write is made once');
  }
});

test("Forge's missing-access error on a restore leaves the resolver so Forge can prompt", async () => {
  // Shape from @forge/api: NeedsAuthenticationError sets this name (out/api/errors.js).
  const consent = Object.assign(new Error('Authentication Required'), {
    name: 'NEEDS_AUTHENTICATION_ERR',
  });
  const { sdk, resolvers } = await handlers({ body: { isLast: true, values: [filter] } }, consent);
  const payload = {
    filterId: '10001',
    at: 1000,
    expected: { name: 'Bugs', description: 'All bugs', jql: 'type = Bug' },
  };
  await assert.rejects(resolvers.restore({ context, payload }), (error) => error === consent);
  assert.equal(sdk.calls.length, 2, 'the write is not retried');
});

test('requests without a user or with a malformed filter fail before any SDK call', async () => {
  for (const [name, request] of [
    ['overview', null],
    ['overview', {}],
    ['overview', { context: { accountId: ' ' } }],
    ['history', { context, payload: { filterId: '1 OR 1=1' } }],
    ['history', { context, payload: null }],
    ['restore', { context, payload: { filterId: '10001' } }],
    ['recreate', { context, payload: { filterId: '10001' } }],
    ['recreate', { context, payload: { filterId: '10001', at: 1000 } }],
    ['deleteHistory', { context, payload: { filterId: '' } }],
    ['deleteHistory', { payload: { filterId: '10001', deleted: false } }],
    ['deleteHistory', { context, payload: { filterId: '10001' } }],
  ]) {
    const { sdk, resolvers } = await handlers();
    assert.equal((await resolvers[name](request)).ok, false, `${name} ${JSON.stringify(request)}`);
    assert.equal(sdk.calls.length, 0);
  }
});

test('denied and malformed filter searches fail at once; outages are read three times', async () => {
  for (const response of [
    { status: 403 },
    { status: 503 },
    { invalidJson: true },
    Error('PRIVATE'),
    { body: { isLast: true, values: [{ ...filter, jql: 7 }] } },
    { body: {} },
  ]) {
    const outage = response instanceof Error || response.status === 503;
    const { sdk, resolvers } = await handlers(admin(false), response, response, response);
    const result = await resolvers.history({ context, payload: { filterId: '10001' } });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /PRIVATE/);
    assert.equal(sdk.calls.length, 1 + (outage ? 3 : 1));
  }
});

test('the UI calls every registered resolver', async () => {
  const { resolvers } = await handlers();
  assertResolversCalled(Object.keys(resolvers), [
    readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'),
  ]);
});

test('a storage failure asks Forge to deliver the event again; a malformed event does not', async () => {
  const storage = memoryKvs();
  const record = createFilterEventHandler({
    ...forgeContract(),
    kvs: storage.kvs,
    WhereConditions: storage.WhereConditions,
  });
  await record(event(1000, 'type = Bug'));
  storage.failNext('transact', 'deleted:10001');
  const retry = await record(deleted);
  // The first retry comes after 30 seconds and up to 30 more, so retries of a burst spread out.
  const { retryAfter } = retry.retryOptions;
  assert.ok(retryAfter >= 30 && retryAfter < 60, String(retryAfter));
  assert.deepEqual(retry, {
    _retry: true,
    retryOptions: { retryAfter, retryReason: 'FUNCTION_RETRY_REQUEST', retryData: {} },
  });
  assert.ok(!storage.data.has('deleted:10001'));
  assert.ok(!storedKeys(storage).some((key) => key.startsWith('expire:')));
  assert.equal(await record(deleted), undefined);
  assert.ok(storage.data.get('deleted:10001').trash);
  assert.equal(await record({ eventType: 'avi:jira:updated:filter', filter: null }), undefined);
});

test('the daily cleanup touches only app storage and continues after a storage failure', async () => {
  const sdk = forgeContract();
  const storage = memoryKvs();
  const deps = { ...sdk, kvs: storage.kvs, WhereConditions: storage.WhereConditions };
  const record = createFilterEventHandler(deps);
  await record(event(1000, 'type = Bug'));
  await record(deleted);
  const cleanup = createCleanupHandler(deps);
  // A filter it couldn't remove fails the run with a count, and nothing of the filter.
  storage.failNext('get', 'deleted:10001');
  await assert.rejects(cleanup(), (error) => {
    assert.equal(
      error.message,
      "Cleanup couldn't remove 1 deleted filter's history. The next run tries again.",
    );
    return true;
  });
  assert.ok(storage.data.has('deleted:10001'));
  // So does a storage outage, after which the next run continues.
  storage.failNext('query', 'expire:');
  await assert.rejects(cleanup(), /^Error: Cleanup stopped: storage was unavailable\./);
  assert.ok(storage.data.has('deleted:10001'));
  assert.equal(await cleanup(), undefined);
  assert.equal(stored(storage).length, 0);
  assert.equal(sdk.calls.length, 0);
});

test("the filter search follows Jira's pages and never reads a short page as hidden filters", async () => {
  const second = { ...filter, id: '10002', name: 'Second' };
  const paged = await handlers(
    admin(false),
    { body: { isLast: false, values: [filter] } },
    { body: { isLast: true, values: [second] } },
  );
  await paged.resolvers.history({ context, payload: { filterId: '10001' } }).catch(() => {});
  assert.deepEqual(paged.sdk.calls.map(({ path }) => path).slice(1, 3), [
    searchPath('10001'),
    `${searchPath('10001')}&startAt=1`,
  ]);
  for (const page of [{ isLast: false, values: [] }, { values: [filter] }]) {
    const { resolvers } = await handlers(admin(false), { body: page });
    assert.deepEqual(await resolvers.history({ context, payload: { filterId: '10001' } }), {
      ok: false,
      error: 'Jira returned unreadable data.',
    });
  }
});

test('the overview checks the permission, then searches 100 filters per request, newest first', async () => {
  for (const [count, searches] of [
    [0, 0],
    [1, 1],
    [101, 2],
  ]) {
    const storage = memoryKvs();
    const ids = Array.from({ length: count }, (_, index) => String(20001 + index));
    const pages = [];
    for (let start = 0; start < ids.length; start += 100)
      pages.push({ body: { isLast: true, values: [] } });
    const sdk = forgeContract(admin(false), ...pages);
    const deps = {
      ...sdk,
      kvs: storage.kvs,
      WhereConditions: storage.WhereConditions,
      appContext: () => ({ environmentType: 'DEVELOPMENT' }),
    };
    const record = createFilterEventHandler(deps);
    // Each filter changed after the one before it, so the newest comes first.
    for (const [index, id] of ids.entries())
      await record({ ...event(1000 + index, 'x'), filter: { ...event(0, 'x').filter, id } });
    const newest = ids.toReversed();
    const overview = await registerResolvers(deps).overview({ context });
    assert.equal(overview.ok, true);
    assert.deepEqual(
      sdk.calls.map(({ path }) => path),
      [
        adminPath,
        ...Array.from({ length: searches }, (_, page) =>
          listPath(...newest.slice(page * 100, page * 100 + 100)),
        ),
      ],
      `${count} filters`,
    );
    sdk.assertDrained();
  }
});

test("a stalled recreate looks for the owner's filter by exact name before creating another", async () => {
  const { sdk, storage, resolvers } = await handlers(
    own(
      { ...filter, id: '10060', name: 'Bugs copy' },
      { ...filter, id: '10050', jql: 'type = Bug AND status = Open' },
      { ...filter, id: '10030', jql: 'type = Bug AND status = Open' },
    ),
  );
  await createFilterEventHandler({
    ...sdk,
    kvs: storage.kvs,
    WhereConditions: storage.WhereConditions,
  })(deleted);
  const trash = storage.data.get('deleted:10001').trash;
  storage.data.set(trash, {
    ...storage.data.get(trash),
    recreating: { token: 'earlier', at: 1000, since: 1, above: '10040' },
  });
  assert.deepEqual(
    await resolvers.recreate({
      context: { accountId: 'owner' },
      payload: { filterId: '10001', at: 1000 },
    }),
    { ok: true, value: { filterId: '10050' } },
  );
  assert.equal(sdk.calls.length, 1, 'no POST');
  sdk.assertDrained();
});
