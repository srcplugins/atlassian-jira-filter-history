import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryKvs } from './support/kvs.mjs';
const { createService } = await import('../src/service.ts');
const { createStore } = await import('../src/integration.ts');
const { diffText, indexKey, recentKey, versionKey } = await import('../src/versions.ts');

/** The stored history, without the account registry the personal data report reads. */
// Leaves out the personal data report's registry: account IDs and the filters that hold them.
const stored = (storage) =>
  [...storage.data].filter(([key]) => !key.startsWith('account:') && !key.startsWith('uses:'));
const storedKeys = (storage) => stored(storage).map(([key]) => key);
// A deleted filter's history is removed this long after the delete.
const retention = 90 * 24 * 60 * 60 * 1000;

const event = (at, filter = {}, extra = {}) => ({
  eventType: 'avi:jira:updated:filter',
  atlassianId: 'editor',
  timestamp: at,
  filter: {
    id: '10001',
    name: 'Bugs',
    description: '',
    jql: 'type = Bug',
    owner: 'owner',
    ...filter,
  },
  contextToken: 'private-token',
  ...extra,
});
/** A copy of `value` without `key`, as Jira sends an event that leaves a field out. */
const without = (value, key) => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};
const now = (filter = {}) => ({
  id: '10001',
  name: 'Bugs',
  description: '',
  jql: 'type = Bug',
  owner: 'owner',
  isWritable: true,
  ...filter,
});

/**
 * A service over in-memory storage and a Jira double whose visible filters a test sets, and the
 * filters only an administrator sees.
 */
function setup({
  visible = { 10001: now() },
  update = { status: 'applied' },
  create = { status: 'applied', id: '30003' },
  hidden = {},
  admin = false,
  own = [],
} = {}) {
  const storage = memoryKvs();
  const clock = { now: 1_000_000 };
  const jira = {
    searched: [],
    overrides: [],
    updates: [],
    created: [],
    visible,
    hidden,
    admin,
    own,
    create,
    async visibleFilters(ids, override = false) {
      jira.searched.push(ids);
      jira.overrides.push(override);
      // `hidden` filters are shared with no one but their owner: only an administrator sees them.
      const seen = override ? { ...jira.visible, ...jira.hidden } : jira.visible;
      return new Map(ids.filter((id) => seen[id]).map((id) => [id, seen[id]]));
    },
    async listedFilters(ids, override = false) {
      const found = await jira.visibleFilters(ids, override);
      return new Map([...found].map(([id, { name, owner }]) => [id, { id, name, owner }]));
    },
    async updateFilter(id, query) {
      jira.updates.push([id, query]);
      return update;
    },
    async createFilter(query) {
      jira.created.push(query);
      return jira.create;
    },
    async isAdmin() {
      return jira.admin;
    },
    async ownFilters(name, owner) {
      return jira.own.filter((filter) => filter.name === name && filter.owner === owner);
    },
  };
  const service = createService({
    jira,
    store: createStore(storage),
    now: () => clock.now,
    sleep: pause,
  });
  return {
    service,
    jira,
    storage,
    clock,
    versions: () => listed(storage),
    entries: (filterId = '10001') =>
      storage.data.get(indexKey(filterId)).entries.map(({ at }) => at),
    recent: () => storedKeys(storage).filter((key) => key.startsWith('recent:')),
  };
}

/** A lease poll's wait, short in tests: other invocations run meanwhile. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 1));

/**
 * Every filter's listed versions with their stored contents, by filter and newest first, read
 * from each filter's index (independently of the service's own reading).
 */
function listed(storage) {
  const shown = [];
  for (const [key, index] of storage.data) {
    if (!key.startsWith('filter:')) continue;
    const filterId = key.slice('filter:'.length);
    index.entries.forEach((entry, position) => {
      const version =
        position === 0
          ? !index.trimmed
          : entry.changed.length > 0 || entry.restored || entry.recreated;
      if (version) shown.push(versionKey(filterId, entry.at));
    });
  }
  return shown.sort().map((key) => storage.data.get(key));
}
/** How many version contents a filter has stored, listed or not. */
const contents = (storage, filterId) =>
  storedKeys(storage).filter((key) => key.startsWith(`version:${filterId}:`)).length;

test('version keys sort newest first', () => {
  assert.ok(versionKey('1', 2000) < versionKey('1', 1000));
  assert.equal(versionKey('1', 1000).length, versionKey('1', 1_800_000_000_000).length);
});

test('each change is one version with its actor and time; no secrets are stored', async () => {
  const { service, storage, versions, entries } = setup();
  await service.record(event(1000, {}, { eventType: 'avi:jira:created:filter' }));
  await service.record(event(2000, { jql: 'type = Bug AND status = Open' }));
  await service.record(event(3000, { name: 'Open bugs' }, { selfGenerated: true }));
  assert.deepEqual(
    versions().map(({ at, jql, name, actor, restored }) => [at, name, jql, actor, restored]),
    [
      [3000, 'Open bugs', 'type = Bug', 'editor', true],
      [2000, 'Bugs', 'type = Bug AND status = Open', 'editor', false],
      [1000, 'Bugs', 'type = Bug', 'editor', false],
    ],
  );
  assert.deepEqual(entries(), [1000, 2000, 3000]);
  assert.doesNotMatch(JSON.stringify(stored(storage)), /private-token/);
});

test("the app's own create of a filter is recorded as recreated, not restored", async () => {
  const { service, versions } = setup();
  await service.record(
    event(1000, {}, { eventType: 'avi:jira:created:filter', selfGenerated: true }),
  );
  assert.deepEqual(
    versions().map(({ restored, recreated }) => [restored, recreated]),
    [[false, true]],
  );
});

test('repeats, saves with no change and malformed events add no version', async () => {
  const { service, versions, entries, recent } = setup();
  await service.record(event(1000));
  await service.record(event(1000));
  await service.record(event(2000));
  for (const malformed of [
    null,
    'event',
    {},
    event(3000, { id: 'x' }),
    event(3000, { jql: 7 }),
    event(3000, { name: undefined }),
    { ...event(3000), timestamp: '' },
    { ...event(3000), timestamp: '3e3' },
    { ...event(3000), timestamp: '03000' },
    { ...event(3000), timestamp: 3000.5 },
    { ...event(3000), atlassianId: 7 },
  ])
    await service.record(malformed);
  assert.equal(versions().length, 1);
  // The save that changed nothing is kept to compare late events with, but isn't a version: the
  // overview still shows the change.
  assert.deepEqual(entries(), [1000, 2000]);
  assert.deepEqual(recent(), [recentKey('10001', 1000)]);
});

test("Jira's string timestamp is the version's time", async () => {
  const { service, versions, entries } = setup();
  await service.record(event('1000'));
  await service.record(event('2000', { jql: 'type = Bug AND status = Open' }));
  assert.deepEqual(
    versions().map(({ at }) => at),
    [2000, 1000],
  );
  assert.deepEqual(entries(), [1000, 2000]);
});

test('an owner change is a version; missing descriptions and object owners are normalized', async () => {
  const { service, versions } = setup();
  await service.record(event(1000, { description: null }));
  await service.record(event(2000, { owner: { accountId: 'new-owner' } }));
  assert.deepEqual(
    versions().map(({ owner, description }) => [owner, description]),
    [
      ['new-owner', ''],
      ['owner', ''],
    ],
  );
});

test('an older event arriving late is kept without replacing the latest', async () => {
  const { service, versions, recent } = setup();
  await service.record(event(2000, { jql: 'b' }));
  await service.record(event(1000, { jql: 'a' }));
  assert.deepEqual(
    versions().map(({ jql }) => jql),
    ['b', 'a'],
  );
  assert.deepEqual(recent(), [recentKey('10001', 2000)]);
});

const deleteEvent = (at, filter = {}) =>
  event(at, filter, { eventType: 'avi:jira:deleted:filter', atlassianId: 'deleter' });

test('two events written at once never hide a later real change', async () => {
  const { service, versions, entries } = setup();
  // Both arrive together; the older one may be written last.
  await Promise.all([
    service.record(event(2000, { jql: 'b' })),
    service.record(event(1000, { jql: 'a' })),
  ]);
  await service.record(event(3000, { jql: 'a' }));
  assert.deepEqual(
    versions().map(({ at, jql }) => [at, jql]),
    [
      [3000, 'a'],
      [2000, 'b'],
      [1000, 'a'],
    ],
  );
  assert.deepEqual(entries(), [1000, 2000, 3000]);
});

test('a change whose event arrives after the delete joins the kept history', async () => {
  const { service, versions } = setup({ visible: {} });
  await service.record(event(1000, { jql: 'a' }));
  await service.record(deleteEvent(3000, { jql: 'b' }));
  await service.record(event(2000, { jql: 'b' }));
  await service.record(event(4000, { jql: 'c' }));
  assert.deepEqual(
    versions().map(({ at, jql }) => [at, jql]),
    [
      [2000, 'b'],
      [1000, 'a'],
    ],
  );
  assert.equal((await service.history('10001', 'owner')).filter.jql, 'b');
});

test('events without an actor or a time are recorded; a dropped description is marked', async () => {
  const { service, clock, versions } = setup();
  await service.record(without(event(1000, { jql: 'a' }), 'atlassianId'));
  await service.record(without(event(undefined, { jql: 'b' }), 'timestamp'));
  await service.record({
    ...event(9_000_000),
    filter: without({ ...event(0).filter, jql: 'c' }, 'description'),
  });
  assert.deepEqual(
    versions().map(({ at, actor, jql, description, descriptionMissing }) => [
      at,
      actor,
      jql,
      description,
      descriptionMissing,
    ]),
    [
      [9_000_000, 'editor', 'c', '', true],
      [clock.now, 'editor', 'b', '', undefined],
      [1000, '', 'a', '', undefined],
    ],
  );
  // A deleted filter's event without an actor still keeps its history.
  await service.record(without(deleteEvent(9_500_000), 'atlassianId'));
  assert.equal((await service.overview('owner')).deleted[0].actor, '');
});

test("a version whose description Jira didn't send restores and recreates without it", async () => {
  const { service, jira } = setup({ visible: { 10001: now({ description: 'kept', jql: 'c' }) } });
  await service.record(event(1000, { jql: 'a' }));
  await service.record({
    ...event(2000),
    filter: without({ ...event(0).filter, name: 'Old bugs', jql: 'b' }, 'description'),
  });
  const { versions } = await service.history('10001', 'owner');
  assert.deepEqual(versions[0].changed, ['name', 'jql'], 'an unknown description is no change');
  assert.equal((await service.changes('10001')).changes[0].after.description, null);
  await service.restore({
    filterId: '10001',
    at: 2000,
    expected: { name: 'Bugs', description: 'kept', jql: 'c' },
  });
  assert.deepEqual(jira.updates, [
    ['10001', { ...jira.updates[0][1], name: 'Old bugs', description: 'kept', jql: 'b' }],
  ]);
  // Only the description differs from the filter now: there's nothing to restore.
  jira.visible = { 10001: now({ name: 'Old bugs', description: 'kept', jql: 'b' }) };
  await assert.rejects(
    service.restore({
      filterId: '10001',
      at: 2000,
      expected: { name: 'Old bugs', description: 'kept', jql: 'b' },
    }),
    /already matches/,
  );
  await service.record(deleteEvent(3000));
  await service.recreate({ filterId: '10001', at: 2000 }, 'owner');
  assert.equal(jira.created.length, 1);
  assert.equal(jira.created[0].description, '');
  assert.equal(jira.created[0].jql, 'b');
});

test('a deleted filter keeps its history for its last owner, and later events start none', async () => {
  const { service, storage } = setup();
  for (let at = 1; at <= 60; at++) await service.record(event(at * 1000, { jql: `n = ${at}` }));
  await service.record(event(1000, { id: '20002' }));
  await service.record(deleteEvent(61_000));
  await service.record(deleteEvent(61_500));
  await service.record(event(62_000, { jql: 'late' }));
  const keys = storedKeys(storage).filter((key) => key.includes('10001'));
  assert.equal(keys.filter((key) => key.startsWith('version:')).length, 60);
  // The index stays with the kept history; the late event isn't in it.
  assert.equal(storage.data.get('filter:10001').entries.length, 60);
  assert.ok(!keys.some((key) => key.startsWith('recent:')));
  const trash = keys.find((key) => key.startsWith('trash:'));
  assert.deepEqual(storage.data.get('deleted:10001'), { at: 61_000, trash });
  assert.deepEqual(storage.data.get(trash), {
    filterId: '10001',
    at: 61_000,
    actor: 'deleter',
    name: 'Bugs',
    owner: 'owner',
  });
  assert.ok(storage.data.has('filter:20002'));
});

test('deleting a filter with no recorded history keeps only the tombstone and its expiry', async () => {
  const { service, storage } = setup();
  await service.record(deleteEvent(1000));
  await service.record(event(2000));
  // The tombstone holds what the delete said, for a change made before it whose event comes late.
  assert.deepEqual(stored(storage), [
    ['deleted:10001', { at: 1000, actor: 'deleter', owner: 'owner', name: 'Bugs' }],
    ['expire:0000000001000:10001', { filterId: '10001', at: 1000 }],
  ]);
});

test('the overview lists only filters the viewer can see, most recently changed first', async () => {
  const { service, jira } = setup({
    visible: { 10001: now(), 10003: now({ id: '10003', name: 'Stories', owner: 'other' }) },
  });
  await service.record(event(1000));
  await service.record(event(3000, { id: '10003', name: 'Old name' }));
  await service.record(event(2000, { id: '10002', name: 'Private' }));
  const overview = await service.overview('viewer');
  assert.deepEqual(overview, {
    filters: [
      { filterId: '10003', name: 'Stories', owner: 'other', at: 3000, actor: 'editor' },
      { filterId: '10001', name: 'Bugs', owner: 'owner', at: 1000, actor: 'editor' },
    ],
    partial: false,
    deleted: [],
    deletedPartial: false,
    admin: false,
  });
  assert.deepEqual(jira.searched, [['10003', '10002', '10001']]);
  assert.doesNotMatch(JSON.stringify(overview), /Private/);
});

test('an overview past 1,000 filters reads the first 1,000 in ten searches and says so', async () => {
  const { service, jira } = setup({ visible: {} });
  for (let index = 0; index <= 1000; index++)
    await service.record(event(1000, { id: String(20000 + index) }));
  const overview = await service.overview('viewer');
  assert.equal(overview.partial, true);
  assert.equal(jira.searched.length, 1);
  assert.equal(jira.searched[0].length, 1000);
});

/** Two deleted filters: 10001 owned by `owner`, then 10002 owned by `other`. */
const deletedSetup = async (options) => {
  const context = setup({ visible: {}, ...options });
  await context.service.record(event(1000, { jql: 'old' }));
  await context.service.record(event(2000));
  await context.service.record(event(1500, { id: '10002', name: 'Theirs', owner: 'other' }));
  await context.service.record(deleteEvent(3000));
  await context.service.record(deleteEvent(4000, { id: '10002', name: 'Theirs', owner: 'other' }));
  return context;
};

test('a late event never joins a history that is moving to a recreated filter', async () => {
  for (const state of [
    { recreatedAs: '30003' },
    { recreating: { token: 'running', at: 2000, since: 1_000_000 } },
  ]) {
    const { service, storage, versions } = await deletedSetup();
    const trash = storage.data.get('deleted:10001').trash;
    storage.data.set(trash, { ...storage.data.get(trash), ...state });
    await service.record(event(2500, { jql: 'late' }));
    assert.deepEqual(
      versions()
        .filter(({ filterId }) => filterId === '10001')
        .map(({ jql }) => jql),
      ['type = Bug', 'old'],
      Object.keys(state)[0],
    );
  }
});

test('a late event that repeats the newest version adds none after the delete', async () => {
  const { service, versions } = await deletedSetup();
  await service.record(event(2500));
  assert.equal(versions().filter(({ filterId }) => filterId === '10001').length, 2);
});

test("a delete event without the owner keeps the history for the newest version's owner", async () => {
  const { service } = setup({ visible: {} });
  await service.record(event(1000));
  await service.record(deleteEvent(2000, { owner: undefined }));
  assert.deepEqual(
    (await service.overview('owner')).deleted.map(({ owner }) => owner),
    ['owner'],
  );
});

test('deleted filters are listed to their owner, and all of them to an administrator', async () => {
  const { service, jira } = await deletedSetup();
  const row = (filterId, name, owner, at) => ({
    filterId,
    name,
    owner,
    at,
    actor: 'deleter',
    expires: at + retention,
  });
  assert.deepEqual((await service.overview('owner')).deleted, [
    row('10001', 'Bugs', 'owner', 3000),
  ]);
  assert.deepEqual((await service.overview('someone')).deleted, []);
  jira.admin = true;
  const admin = await service.overview('admin');
  assert.equal(admin.admin, true);
  assert.deepEqual(admin.deleted, [
    row('10002', 'Theirs', 'other', 4000),
    row('10001', 'Bugs', 'owner', 3000),
  ]);
  assert.deepEqual(admin.filters, []);
});

test("a deleted filter's history opens read-only for its owner and administrators; only the owner recreates", async () => {
  const { service, jira } = await deletedSetup();
  const history = await service.history('10001', 'owner');
  assert.deepEqual(history.filter, {
    id: '10001',
    name: 'Bugs',
    description: '',
    jql: 'type = Bug',
    owner: 'owner',
    isWritable: false,
  });
  assert.deepEqual(history.deleted, {
    at: 3000,
    actor: 'deleter',
    expires: 3000 + retention,
    canRecreate: true,
  });
  assert.equal(history.admin, false);
  assert.deepEqual(
    history.versions.map(({ at, changed }) => [at, changed]),
    [
      [2000, ['jql']],
      [1000, []],
    ],
  );
  await assert.rejects(service.history('10002', 'owner'), /isn't available to you/);
  await assert.rejects(service.history('10001', 'someone'), /isn't available to you/);
  jira.admin = true;
  const asAdmin = await service.history('10002', 'admin');
  assert.equal(asAdmin.admin, true);
  assert.equal(asAdmin.deleted.canRecreate, false);
  assert.deepEqual(
    asAdmin.versions.map(({ at }) => at),
    [1500],
  );
  await assert.rejects(
    service.recreate({ filterId: '10002', at: 1500 }, 'admin'),
    /isn't available to you/,
  );
  // Rovo reads only filters in Jira.
  await assert.rejects(service.changes('10001'), /isn't available to you/);
  assert.equal(jira.created.length, 0);
});

test('recreating creates a private filter from the version and moves the history to it', async () => {
  const { service, jira, storage } = await deletedSetup();
  assert.deepEqual(await service.recreate({ filterId: '10001', at: 1000 }, 'owner'), {
    filterId: '30003',
  });
  assert.equal(jira.created.length, 1);
  assert.equal(jira.created[0].jql, 'old');
  assert.deepEqual(
    storedKeys(storage).filter((key) => key.includes('10001')),
    ['deleted:10001', 'expire:0000000003000:10001'],
  );
  assert.deepEqual(storage.data.get('deleted:10001'), { at: 3000, recreatedAs: '30003' });
  assert.equal((await service.overview('owner')).deleted.length, 0);
  // Each account the moved versions hold is marked on the new filter, for erasing it.
  const held = stored(storage)
    .filter(([key]) => key.startsWith('version:30003:'))
    .flatMap(([, version]) => [version.actor, version.owner])
    .filter(Boolean);
  assert.ok(held.length);
  for (const accountId of held) assert.ok(storage.data.has(`uses:${accountId}:30003`), accountId);
  // Jira's created event, from the app's own write, records the new filter's first version.
  jira.visible = { 30003: now({ id: '30003', jql: 'old' }) };
  await service.record(
    event(
      5000,
      { id: '30003', jql: 'old' },
      { eventType: 'avi:jira:created:filter', selfGenerated: true, atlassianId: 'owner' },
    ),
  );
  const { versions } = await service.history('30003', 'owner');
  assert.deepEqual(
    versions.map(({ at, recreated, changed }) => [at, recreated, changed]),
    [
      [5000, true, ['jql']],
      [2000, false, ['jql']],
      [1000, false, []],
    ],
  );
});

test('recreating is refused for others, unknown versions and malformed requests, without a write', async () => {
  const cases = [
    [{ filterId: '10001', at: 1000 }, 'someone', /isn't available/],
    [{ filterId: '10002', at: 1500 }, 'owner', /isn't available/],
    [{ filterId: '10001', at: 1700 }, 'owner', /no longer recorded/],
    [{ filterId: '10001', at: '1000' }, 'owner', /Choose a version/],
    [{ filterId: 'x', at: 1000 }, 'owner', /Choose a saved filter/],
    [null, 'owner', /Choose a version/],
  ];
  for (const [payload, viewer, error] of cases) {
    const { service, jira } = await deletedSetup({ admin: true });
    await assert.rejects(service.recreate(payload, viewer), error);
    assert.equal(jira.created.length, 0);
  }
  const live = setup();
  await live.service.record(event(1000));
  await assert.rejects(
    live.service.recreate({ filterId: '10001', at: 1000 }, 'owner'),
    /isn't available/,
  );
  assert.equal(live.jira.created.length, 0);
});

test("someone else's recreate writes nothing, not even the filter's lease, and reads as a missing filter", async () => {
  const writes = (storage, from) =>
    storage.calls.slice(from).filter((name) => !['get', 'query'].includes(name));
  const deleted = await deletedSetup();
  let from = deleted.storage.calls.length;
  await assert.rejects(
    deleted.service.recreate({ filterId: '10001', at: 2000 }, 'someone'),
    /isn't available/,
  );
  assert.deepEqual(writes(deleted.storage, from), []);
  const live = setup();
  await live.service.record(event(1000));
  for (const filterId of ['10001', '99999']) {
    from = live.storage.calls.length;
    await assert.rejects(
      live.service.recreate({ filterId, at: 1000 }, 'someone'),
      /isn't available/,
    );
    assert.deepEqual(writes(live.storage, from), [], filterId);
  }
});

test("recreating reports Jira's refusal and an unconfirmed create once, and keeps the history", async () => {
  for (const [create, error] of [
    [
      { status: 'rejected', message: 'Name in use.' },
      /Jira refused to recreate the filter: Name in use\./,
    ],
    [{ status: 'uncertain' }, /didn't confirm the new filter/],
  ]) {
    const { service, jira, storage } = await deletedSetup({ create });
    await assert.rejects(service.recreate({ filterId: '10001', at: 2000 }, 'owner'), error);
    assert.equal(jira.created.length, 1);
    assert.equal((await service.history('10001', 'owner')).versions.length, 2);
    assert.ok(!JSON.stringify(stored(storage)).includes('recreatedAs'));
  }
});

test('a recreate whose result failed to save adopts the filter it made, never creating another', async () => {
  const { service, jira, storage, clock } = await deletedSetup();
  const trash = storage.data.get('deleted:10001').trash;
  // Jira creates the filter, then storing its ID fails once.
  const create = jira.createFilter;
  jira.createFilter = async (query) => {
    storage.failNext('set', trash);
    return create(query);
  };
  await assert.rejects(
    service.recreate({ filterId: '10001', at: 2000 }, 'owner'),
    /The filter was recreated in Jira with ID 30003, but its history hasn't moved there yet/,
  );
  assert.equal(jira.created.length, 1);
  // At once, the claim may still be a running recreate's.
  await assert.rejects(
    service.recreate({ filterId: '10001', at: 2000 }, 'owner'),
    /already being recreated/,
  );
  clock.now += 31_000;
  jira.own = [now({ id: '30003' }), now({ id: '30002', jql: 'other' })];
  assert.deepEqual(await service.recreate({ filterId: '10001', at: 2000 }, 'owner'), {
    filterId: '30003',
  });
  assert.equal(jira.created.length, 1, 'no second Jira write');
  assert.equal(storedKeys(storage).filter((key) => key.startsWith('version:30003:')).length, 2);
  assert.deepEqual(storage.data.get('deleted:10001'), { at: 3000, recreatedAs: '30003' });
});

test('an old claim with no filter in Jira is taken over; a refused create releases the claim', async () => {
  const { service, jira, storage, clock } = await deletedSetup({
    create: { status: 'uncertain' },
  });
  await assert.rejects(
    service.recreate({ filterId: '10001', at: 2000 }, 'owner'),
    /didn't confirm the new filter/,
  );
  const trash = storage.data.get('deleted:10001').trash;
  assert.ok(storage.data.get(trash).recreating);
  clock.now += 31_000;
  jira.create = { status: 'rejected', message: 'Name in use.' };
  // Nothing was found under the owner's filters, so the create runs again, and Jira refuses it.
  await assert.rejects(service.recreate({ filterId: '10001', at: 2000 }, 'owner'));
  assert.equal(jira.created.length, 2);
  // The refusal released the claim: a new try runs at once instead of waiting for it.
  assert.equal(storage.data.get(trash).recreating, undefined);
  jira.create = { status: 'applied', id: '30003' };
  await service.recreate({ filterId: '10001', at: 2000 }, 'owner');
  assert.equal(jira.created.length, 3);
});

test('a stalled recreate never takes over a matching filter the owner already had', async () => {
  const { service, jira, clock } = await deletedSetup({ create: { status: 'uncertain' } });
  // The owner made a filter by hand with the same name and query before recreating.
  jira.own = [now({ id: '30001' })];
  await assert.rejects(
    service.recreate({ filterId: '10001', at: 2000 }, 'owner'),
    /didn't confirm the new filter/,
  );
  clock.now += 31_000;
  jira.create = { status: 'applied', id: '30005' };
  assert.deepEqual(await service.recreate({ filterId: '10001', at: 2000 }, 'owner'), {
    filterId: '30005',
  });
  assert.equal(jira.created.length, 2, 'nothing new was found, so the create runs again');
});

test('a stalled recreate adopts the first matching filter made after its claim', async () => {
  const { service, jira, clock } = await deletedSetup({ create: { status: 'uncertain' } });
  jira.own = [now({ id: '9' })];
  await assert.rejects(service.recreate({ filterId: '10001', at: 2000 }, 'owner'));
  clock.now += 31_000;
  // The unconfirmed create made 99, then the owner copied it by hand as 100; IDs compare as
  // numbers, not text.
  jira.own = [now({ id: '9' }), now({ id: '100' }), now({ id: '99' }), now({ id: '8' })];
  assert.deepEqual(await service.recreate({ filterId: '10001', at: 2000 }, 'owner'), {
    filterId: '99',
  });
  assert.equal(jira.created.length, 1);
});

test('a claim that waited 29 seconds is still treated as running', async () => {
  const { service, jira, clock } = await deletedSetup({ create: { status: 'uncertain' } });
  await assert.rejects(service.recreate({ filterId: '10001', at: 2000 }, 'owner'));
  clock.now += 29_000;
  await assert.rejects(
    service.recreate({ filterId: '10001', at: 2000 }, 'owner'),
    /already being recreated/,
  );
  assert.equal(jira.created.length, 1);
});

test('two recreates at once make one Jira write', async () => {
  const { service, jira, storage } = await deletedSetup();
  const results = await Promise.allSettled([
    service.recreate({ filterId: '10001', at: 2000 }, 'owner'),
    service.recreate({ filterId: '10001', at: 1000 }, 'owner'),
  ]);
  assert.equal(jira.created.length, 1);
  // The second waits for the first, then finds the filter recreated and its history gone.
  assert.deepEqual(results.map(({ status }) => status).sort(), ['fulfilled', 'rejected']);
  assert.match(
    results.find(({ status }) => status === 'rejected').reason.message,
    /isn't available/,
  );
  assert.equal(storedKeys(storage).filter((key) => key.startsWith('version:30003:')).length, 2);
});

test('a recreate tried again after its answer was lost sends its owner, and only them, to the new filter', async () => {
  const { service, jira } = await deletedSetup();
  assert.deepEqual(await service.recreate({ filterId: '10001', at: 2000 }, 'owner'), {
    filterId: '30003',
  });
  // Jira now shows the owner their new private filter; another account doesn't see it.
  jira.visible = { 30003: now({ id: '30003', owner: 'owner' }) };
  assert.deepEqual(await service.recreate({ filterId: '10001', at: 2000 }, 'owner'), {
    filterId: '30003',
  });
  await assert.rejects(
    service.recreate({ filterId: '10001', at: 2000 }, 'someone else'),
    /isn't available/,
  );
  jira.visible = {};
  await assert.rejects(
    service.recreate({ filterId: '10001', at: 2000 }, 'owner'),
    /isn't available/,
  );
  assert.equal(jira.created.length, 1);
});

test('a recreate that moved the history but not its deleted entry is finished by opening it', async () => {
  const { service, jira, storage } = await deletedSetup();
  const trash = storage.data.get('deleted:10001').trash;
  storage.failNext('transact', trash);
  await assert.rejects(
    service.recreate({ filterId: '10001', at: 2000 }, 'owner'),
    /hasn't moved there yet. Try again to finish/,
  );
  assert.equal((await service.overview('owner')).deleted.length, 1);
  jira.visible = { 30003: now({ id: '30003' }) };
  const history = await service.history('10001', 'owner');
  assert.equal(history.filter.id, '30003');
  assert.equal(history.versions.length, 2);
  assert.equal((await service.overview('owner')).deleted.length, 0);
  assert.equal(jira.created.length, 1);
});

test('moving a history on slow storage stops inside the time limit and finishes on the next try', async () => {
  const { service, jira, storage, clock } = setup({ visible: {} });
  for (let at = 1; at <= 150; at++) await service.record(event(at * 1000, { jql: `n = ${at}` }));
  await service.record(deleteEvent(300_000));
  const tick = storage.kvs.query;
  storage.kvs.query = (...args) => {
    clock.now += 20_000;
    return tick(...args);
  };
  await assert.rejects(
    service.recreate({ filterId: '10001', at: 150_000 }, 'owner'),
    /Try again to finish/,
  );
  storage.kvs.query = tick;
  assert.ok(storedKeys(storage).some((key) => key.startsWith('version:10001:')));
  await service.recreate({ filterId: '10001', at: 150_000 }, 'owner');
  assert.equal(storedKeys(storage).filter((key) => key.startsWith('version:30003:')).length, 101);
  assert.equal(jira.created.length, 1);
});

test("administrators delete a deleted or visible filter's history; Jira isn't changed", async () => {
  const { service, jira, storage } = await deletedSetup({
    visible: { 10003: now({ id: '10003' }) },
  });
  await service.record(event(1000, { id: '10003' }));
  await assert.rejects(service.deleteHistory('10002', true, 'admin'), /Only Jira administrators/);
  jira.admin = true;
  // What the administrator confirmed must still hold: a filter in Jira, or a deleted one.
  await assert.rejects(service.deleteHistory('10002', false, 'admin'), /was deleted in Jira/);
  await assert.rejects(service.deleteHistory('10003', true, 'admin'), /isn't deleted any more/);
  await assert.rejects(service.deleteHistory('10002', undefined, 'admin'), /Invalid request/);
  assert.equal(storage.data.has('deleted:10002') && storage.data.has(indexKey('10003')), true);
  assert.deepEqual(await service.deleteHistory('10002', true, 'admin'), { deleted: true });
  assert.deepEqual(await service.deleteHistory('10003', false, 'admin'), { deleted: true });
  await assert.rejects(service.deleteHistory('10004', false, 'admin'), /isn't available/);
  await assert.rejects(service.deleteHistory('x', false, 'admin'), /Choose a saved filter/);
  // A deleted filter's history goes without a trace: nobody can see that filter any more.
  assert.deepEqual(
    storedKeys(storage)
      .filter((key) => /1000[23]/.test(key))
      .sort(),
    ['cleared:10003', 'deleted:10002', 'expire:0000000004000:10002'],
  );
  // Its tombstone says so, without who: nothing is kept for that filter again.
  assert.deepEqual(storage.data.get('deleted:10002'), { at: 4000, cleared: true });
  assert.equal((await service.overview('admin')).deleted.length, 1);
  assert.equal(jira.updates.length + jira.created.length, 0);
});

test("deleting a visible filter's history records who deleted it and when, and nothing else", async () => {
  const { service, jira, storage, clock } = setup({ admin: true });
  await service.record(event(1000, { jql: 'old' }));
  await service.record(event(2000));
  assert.equal((await service.history('10001', 'viewer')).cleared, null);
  clock.now = 5000;
  // The record is written first, so a delete that stops part way still leaves it.
  storage.failNext('batchDelete', 'version:10001:');
  await assert.rejects(service.deleteHistory('10001', false, 'admin'));
  assert.deepEqual(storage.data.get('cleared:10001'), { at: 5000, actor: 'admin' });
  clock.now = 6000;
  assert.deepEqual(await service.deleteHistory('10001', false, 'admin'), { deleted: true });
  assert.deepEqual(stored(storage), [['cleared:10001', { at: 6000, actor: 'admin' }]]);
  const history = await service.history('10001', 'viewer');
  assert.deepEqual([history.versions, history.cleared], [[], { at: 6000, actor: 'admin' }]);
  await service.record(event(7000, { jql: 'new' }));
  assert.deepEqual((await service.history('10001', 'viewer')).cleared, {
    at: 6000,
    actor: 'admin',
  });
  assert.deepEqual((await service.changes('10001')).historyDeleted, {
    at: new Date(6000).toISOString(),
    actor: 'admin',
  });
  jira.visible = {};
  await assert.rejects(service.history('10001', 'viewer'), /isn't available to you/);
  await assert.rejects(service.changes('10001'), /isn't available to you/);
});

test('the record of a deleted history moves with a recreate and expires with the filter', async () => {
  for (const finish of ['recreate', 'expire']) {
    const { service, jira, storage, clock } = setup({ admin: true });
    await service.record(event(1000, { jql: 'old' }));
    clock.now = 1500;
    await service.deleteHistory('10001', false, 'admin');
    await service.record(event(2000));
    await service.record(deleteEvent(3000));
    jira.visible = {};
    const cleared = { at: 1500, actor: 'admin' };
    assert.deepEqual((await service.history('10001', 'owner')).cleared, cleared);
    if (finish === 'expire') storage.failNext('transact', 'version:30003:');
    await service.recreate({ filterId: '10001', at: 2000 }, 'owner').catch(() => undefined);
    if (finish === 'expire') {
      clock.now = 3000 + 90 * 24 * 60 * 60 * 1000;
      await service.expire();
    }
    assert.ok(!storage.data.has('cleared:10001'), finish);
    assert.deepEqual(storage.data.get('cleared:30003'), cleared, finish);
  }
  // A filter deleted for good loses it with the rest of its data.
  const { service, jira, storage, clock } = setup({ admin: true });
  await service.record(event(1000));
  await service.deleteHistory('10001', false, 'admin');
  await service.record(event(2000, { jql: 'new' }));
  await service.record(deleteEvent(3000));
  jira.visible = {};
  clock.now = 3000 + 90 * 24 * 60 * 60 * 1000;
  await service.expire();
  assert.deepEqual(stored(storage), []);
});

test('a change made before a history was deleted never comes back in a late event', async () => {
  const { service, jira, clock, versions } = setup({ admin: true });
  await service.record(event(1000, { jql: 'old' }));
  clock.now = 5000;
  await service.deleteHistory('10001', false, 'admin');
  await service.record(event(4000, { jql: 'retried' }));
  assert.deepEqual(versions(), []);
  await service.record(event(6000, { jql: 'new' }));
  await service.record(event(4500, { jql: 'late' }));
  assert.deepEqual(
    versions().map(({ jql }) => jql),
    ['new'],
  );
  // Nor once the filter is deleted, when a late change would otherwise join the kept history.
  await service.record(deleteEvent(7000, { jql: 'new' }));
  jira.visible = {};
  await service.record(event(4800, { jql: 'later' }));
  assert.deepEqual(
    versions().map(({ jql }) => jql),
    ['new'],
  );
});

test('opening a deleted filter that finishes a stopped recreate moves the record too', async () => {
  const { service, jira, storage, clock } = setup({ admin: true });
  await service.record(event(1000, { jql: 'old' }));
  clock.now = 1500;
  await service.deleteHistory('10001', false, 'admin');
  await service.record(event(2000));
  await service.record(deleteEvent(3000));
  jira.visible = {};
  storage.failNext('set', 'cleared:30003');
  await assert.rejects(service.recreate({ filterId: '10001', at: 2000 }, 'owner'));
  jira.visible = { 30003: now({ id: '30003' }) };
  const history = await service.history('10001', 'owner');
  assert.equal(history.filter.id, '30003');
  assert.deepEqual(history.cleared, { at: 1500, actor: 'admin' });
  assert.ok(!storage.data.has('cleared:10001'));
});

test('a moved record never replaces a later one on the recreated filter', async () => {
  const { service, jira, storage, clock } = setup({ admin: true });
  await service.record(event(1000, { jql: 'old' }));
  clock.now = 1500;
  await service.deleteHistory('10001', false, 'admin');
  await service.record(event(2000));
  await service.record(deleteEvent(3000));
  jira.visible = {};
  storage.failNext('transact', 'version:30003:');
  await assert.rejects(service.recreate({ filterId: '10001', at: 2000 }, 'owner'));
  // An administrator deletes the recreated filter's history before the move finishes.
  jira.visible = { 30003: now({ id: '30003' }) };
  clock.now = 4000;
  await service.deleteHistory('30003', false, 'other admin');
  clock.now = 3000 + retention;
  await service.expire();
  assert.deepEqual(storage.data.get('cleared:30003'), { at: 4000, actor: 'other admin' });
  assert.ok(!storage.data.has('cleared:10001'));
});

test("a deleted filter's history isn't deleted while its recreate is unfinished; the move then completes", async () => {
  const { service, jira, storage } = setup({ admin: true });
  await service.record(event(1000, { jql: 'old' }));
  await service.record(event(2000));
  await service.record(deleteEvent(3000));
  jira.visible = {};
  storage.failNext('transact', 'version:30003:');
  await assert.rejects(service.recreate({ filterId: '10001', at: 2000 }, 'owner'));
  // The administrator confirmed deleting a deleted filter's history; it is in Jira again.
  await assert.rejects(service.deleteHistory('10001', true, 'admin'), /isn't deleted any more/);
  jira.visible = { 30003: now({ id: '30003' }) };
  const history = await service.history('10001', 'owner');
  assert.equal(history.filter.id, '30003');
  // Both recorded changes; the delete is no version.
  assert.deepEqual(
    history.versions.map(({ at }) => at),
    [2000, 1000],
  );
});

test("a hidden filter shows no history; its versions aren't read", async () => {
  const { service, storage } = setup({ visible: {} });
  await service.record(event(1000));
  const reads = storage.calls.length;
  await assert.rejects(service.history('10001', 'owner'), /isn't available to you/);
  await assert.rejects(service.changes('10001'), /isn't available to you/);
  assert.ok(!storage.calls.slice(reads).includes('query'));
  await assert.rejects(service.history('../1', 'owner'), /Choose a saved filter/);
});

test('history lists versions newest first with what each changed', async () => {
  const { service } = setup();
  await service.record(event(1000));
  await service.record(event(2000, { jql: 'type = Story', description: 'All stories' }));
  const { filter, versions, more, deleted } = await service.history('10001', 'viewer');
  assert.equal(filter.name, 'Bugs');
  assert.equal(more, false);
  assert.equal(deleted, null);
  assert.deepEqual(
    versions.map(({ at, changed }) => [at, changed]),
    [
      [2000, ['description', 'jql']],
      [1000, []],
    ],
  );
});

test('Rovo changes return the latest ten and say when older ones exist', async () => {
  const { service } = setup();
  for (let at = 1; at <= 12; at++) await service.record(event(at * 1000, { jql: `n = ${at}` }));
  const result = await service.changes('10001');
  assert.equal(result.changes.length, 10);
  assert.equal(result.olderChanges, true);
  assert.deepEqual(result.changes[0].changed, ['jql']);
  assert.equal(result.changes[0].at, new Date(12_000).toISOString());
  assert.equal(result.changes[0].after.jql, 'n = 12');
});

const restoreSetup = async (options) => {
  const context = setup(options);
  await context.service.record(event(1000, { jql: 'old' }));
  await context.service.record(event(2000));
  return context;
};
const expected = { name: 'Bugs', description: '', jql: 'type = Bug' };

test('restore writes the version as the viewer when the filter is as previewed', async () => {
  const { service, jira } = await restoreSetup();
  assert.deepEqual(await service.restore({ filterId: '10001', at: 1000, expected }), {
    restored: true,
  });
  assert.equal(jira.updates.length, 1);
  assert.equal(jira.updates[0][0], '10001');
  assert.equal(jira.updates[0][1].jql, 'old');
});

test('restore refuses stale, read-only, matching, unknown and malformed requests without writing', async () => {
  const cases = [
    [{ filterId: '10001', at: 1000, expected: { ...expected, jql: 'other' } }, /changed since/],
    [{ filterId: '10001', at: 2000, expected }, /already matches/],
    [{ filterId: '10001', at: 1500, expected }, /no longer recorded/],
    [{ filterId: '10001', at: '1000', expected }, /Choose a version/],
    [{ filterId: '10001', at: 1000 }, /Choose a version/],
    [{ filterId: '10001', at: 1000, expected: { name: 'Bugs' } }, /Choose a version/],
    [{ filterId: 'x', at: 1000, expected }, /Choose a saved filter/],
    [null, /Choose a version/],
  ];
  for (const [payload, error] of cases) {
    const { service, jira } = await restoreSetup();
    await assert.rejects(service.restore(payload), error);
    assert.equal(jira.updates.length, 0);
  }
  const readOnly = await restoreSetup({ visible: { 10001: now({ isWritable: false }) } });
  await assert.rejects(
    readOnly.service.restore({ filterId: '10001', at: 1000, expected }),
    /can't edit/,
  );
  const hidden = await restoreSetup({ visible: {} });
  const reads = hidden.storage.calls.length;
  for (const at of [1000, 1500])
    await assert.rejects(
      hidden.service.restore({ filterId: '10001', at, expected }),
      /isn't available/,
    );
  assert.equal(hidden.storage.calls.length, reads, 'nothing read before the visibility check');
  assert.equal(readOnly.jira.updates.length + hidden.jira.updates.length, 0);
});

test("restore reports Jira's refusal and an unconfirmed write, once each", async () => {
  const rejected = await restoreSetup({
    update: { status: 'rejected', message: 'Field x does not exist.' },
  });
  await assert.rejects(
    rejected.service.restore({ filterId: '10001', at: 1000, expected }),
    /Jira refused the restore: Field x does not exist\./,
  );
  const uncertain = await restoreSetup({ update: { status: 'uncertain' } });
  await assert.rejects(
    uncertain.service.restore({ filterId: '10001', at: 1000, expected }),
    /didn't confirm/,
  );
  assert.equal(rejected.jira.updates.length + uncertain.jira.updates.length, 2);
});

test('storage outages fail with a public message', async () => {
  const storage = memoryKvs({ failing: true });
  const jira = {
    visibleFilters: async () => new Map([['10001', now()]]),
    listedFilters: async () => new Map([['10001', now()]]),
    isAdmin: async () => true,
  };
  const service = createService({ jira, store: createStore(storage) });
  await assert.rejects(service.history('10001', 'owner'), /App storage is unavailable/);
  await assert.rejects(service.overview('owner'), /App storage is unavailable/);
  await assert.rejects(
    service.deleteHistory('10001', false, 'admin'),
    /App storage is unavailable/,
  );
});

const day = 24 * 60 * 60 * 1000;

test('each filter keeps its newest 100 versions, plus one to compare the oldest shown with', async () => {
  const { service, storage, versions, entries } = setup();
  for (let at = 1; at <= 130; at++) await service.record(event(at * 1000, { jql: `n = ${at}` }));
  assert.equal(versions().length, 100);
  assert.equal(versions().at(-1).at, 31_000);
  assert.equal(entries()[0], 30_000);
  assert.equal(contents(storage, '10001'), 101);
  const history = await service.history('10001', 'viewer');
  assert.equal(history.versions.length, 100);
  assert.equal(history.more, true);
  assert.deepEqual(history.versions.at(-1).changed, ['jql']);
});

test('a failed trim never fails recording; the content left is never shown and goes with the history', async () => {
  const { service, storage, versions, clock, jira } = setup();
  for (let at = 1; at <= 101; at++) await service.record(event(at * 1000, { jql: `n = ${at}` }));
  storage.failNext('batchDelete', 'version:10001:');
  await service.record(event(102_000, { jql: 'n = 102' }));
  assert.equal(versions().length, 100);
  assert.equal(contents(storage, '10001'), 102);
  await service.record(event(103_000, { jql: 'n = 103' }));
  assert.equal((await service.history('10001', 'viewer')).versions.length, 100);
  assert.equal(contents(storage, '10001'), 102);
  await service.record(deleteEvent(104_000));
  jira.visible = {};
  clock.now = 104_000 + retention;
  await service.expire();
  assert.equal(contents(storage, '10001'), 0);
});

test('a late event and a moved history keep a filter at 101 versions', async () => {
  const hundredAndOne = async () => {
    const context = setup({ visible: {} });
    for (let at = 2; at <= 102; at++)
      await context.service.record(event(at * 1000, { jql: `n = ${at}` }));
    await context.service.record(deleteEvent(200_000));
    return context;
  };
  const count = contents;
  const late = await hundredAndOne();
  await late.service.record(event(1000, { jql: 'late' }));
  assert.equal(count(late.storage, '10001'), 101, 'late event');
  for (const finish of ['recreate', 'expire']) {
    const { service, jira, storage, clock } = await hundredAndOne();
    const create = jira.createFilter;
    jira.createFilter = async (query) => {
      // Jira's created event arrives before the history has moved.
      await service.record(
        event(
          201_000,
          { id: '30003', jql: 'new' },
          { eventType: 'avi:jira:created:filter', selfGenerated: true },
        ),
      );
      if (finish === 'expire') storage.failNext('transact', 'version:30003:');
      return create(query);
    };
    await service.recreate({ filterId: '10001', at: 102_000 }, 'owner').catch(() => undefined);
    if (finish === 'expire') {
      clock.now = 200_000 + 90 * day;
      await service.expire();
    }
    assert.equal(count(storage, '30003'), 101, finish);
  }
});

test('a deleted filter and its history are removed 90 days after the delete, oldest first', async () => {
  const { service, storage, clock, jira } = await deletedSetup({
    visible: { 10003: now({ id: '10003' }) },
  });
  await service.record(event(1000, { id: '10003' }));
  await service.record(deleteEvent(5000, { id: '10004' }));
  const keys = () => storedKeys(storage);
  clock.now = 3000 + 90 * day - 1;
  await service.expire();
  assert.ok(keys().some((key) => key.includes('10001')));
  clock.now = 3000 + 90 * day;
  await service.expire();
  assert.ok(!keys().some((key) => key.includes('10001')));
  assert.equal(keys().filter((key) => key.includes('10002')).length, 5);
  clock.now = 5000 + 90 * day;
  await service.expire();
  assert.deepEqual(
    keys().sort(),
    ['filter:10003', recentKey('10003', 1000), versionKey('10003', 1000)].sort(),
  );
  jira.admin = true;
  assert.equal((await service.overview('admin')).deleted.length, 0);
  assert.equal(jira.updates.length + jira.created.length, 0);
});

test('a recreate still moving its history when the deleted filter expires keeps the history', async () => {
  const { service, storage, clock } = await deletedSetup();
  storage.failNext('transact', 'version:30003:');
  await assert.rejects(
    service.recreate({ filterId: '10001', at: 2000 }, 'owner'),
    /hasn't moved there yet/,
  );
  clock.now = 3000 + 90 * day;
  await service.expire();
  const keys = storedKeys(storage);
  assert.equal(keys.filter((key) => key.startsWith('version:30003:')).length, 2);
  assert.ok(!keys.some((key) => key.includes('10001')));
});

test('expiry stops inside the time limit and continues on the next run', async () => {
  const { service, storage, clock } = setup();
  for (let id = 10010; id < 10040; id++) {
    await service.record(event(1000, { id: String(id) }));
    await service.record(deleteEvent(2000, { id: String(id) }));
  }
  clock.now = 2000 + 90 * day;
  const remove = storage.kvs.delete;
  storage.kvs.delete = (...args) => {
    clock.now += 20_000;
    return remove(...args);
  };
  await service.expire();
  const left = () => storedKeys(storage).filter((key) => key.startsWith('expire:')).length;
  assert.ok(left() > 0 && left() < 30);
  storage.kvs.delete = remove;
  await service.expire();
  assert.equal(stored(storage).length, 0);
});

test('the word comparison keeps unchanged words and puts removed before added', () => {
  assert.deepEqual(diffText('type = Bug AND status = Open', 'type = Story AND status = Open'), [
    { text: 'type = ', change: 'same' },
    { text: 'Bug', change: 'removed' },
    { text: 'Story', change: 'added' },
    { text: ' AND status = Open', change: 'same' },
  ]);
  assert.deepEqual(diffText('', 'a b'), [{ text: 'a b', change: 'added' }]);
  assert.deepEqual(diffText('a', 'a'), [{ text: 'a', change: 'same' }]);
  const long = Array.from({ length: 2500 }, (_, i) => `w${i}`).join(' ');
  assert.deepEqual(
    diffText(long, 'x').map(({ change }) => change),
    ['removed', 'added'],
  );
});

test('a long text with a small change still compares word by word', () => {
  const words = Array.from({ length: 3000 }, (_, i) => `w${i}`);
  const changed = words.with(1500, 'x').join(' ');
  assert.deepEqual(
    diffText(words.join(' '), changed).map(({ text, change }) => (change === 'same' ? '…' : text)),
    ['…', 'w1500', 'x', '…'],
  );
});

test('an administrator sees every filter with history, read-only unless Jira lets them edit it', async () => {
  const { service, jira } = setup({
    hidden: { 10002: now({ id: '10002', name: 'Private', owner: 'other', isWritable: false }) },
  });
  await service.record(event(1000));
  await service.record(event(2000, { id: '10002', name: 'Private', owner: 'other' }));
  assert.deepEqual(
    (await service.overview('viewer')).filters.map(({ filterId }) => filterId),
    ['10001'],
  );
  await assert.rejects(service.history('10002', 'viewer'), /isn't available to you/);
  jira.admin = true;
  const overview = await service.overview('admin');
  assert.deepEqual(
    overview.filters.map(({ filterId, name }) => [filterId, name]),
    [
      ['10002', 'Private'],
      ['10001', 'Bugs'],
    ],
  );
  const history = await service.history('10002', 'admin');
  assert.equal(history.filter.isWritable, false);
  assert.equal(history.versions.length, 1);
  assert.equal((await service.changes('10002')).filter.name, 'Private');
  assert.deepEqual(jira.overrides, [false, false, true, true, true]);
  // Restore reads the filter as the viewer sees it without the override: hidden stays hidden.
  await assert.rejects(
    service.restore({
      filterId: '10002',
      at: 2000,
      expected: { name: 'Private', description: '', jql: 'type = Bug' },
    }),
    /isn't available to you/,
  );
  assert.equal(jira.updates.length, 0);
});

test("the app's restore of the newest version and a recreate as deleted are recorded", async () => {
  const { service, versions } = setup();
  await service.record(event(1000, { jql: 'a' }));
  // A change the app didn't record (not installed or unlicensed), then a restore back to `a`.
  await service.record(event(2000, { jql: 'a' }, { selfGenerated: true }));
  assert.deepEqual(
    versions().map(({ at, restored }) => [at, restored]),
    [
      [2000, true],
      [1000, false],
    ],
  );
  const deleted = await deletedSetup();
  await deleted.service.recreate({ filterId: '10001', at: 2000 }, 'owner');
  await deleted.service.record(
    event(5000, { id: '30003' }, { eventType: 'avi:jira:created:filter', selfGenerated: true }),
  );
  assert.deepEqual(
    deleted
      .versions()
      .filter(({ filterId }) => filterId === '30003')
      .map(({ at, recreated }) => [at, recreated]),
    [
      [5000, true],
      [2000, false],
      [1000, false],
    ],
  );
});

test('a late event is placed by its time: a revert it overtook is kept, repeats are not', async () => {
  // The revert to `a` came first, as a save that changed nothing; the edit to `b` arrives late.
  const revert = setup();
  await revert.service.record(event(1000, { jql: 'a' }));
  await revert.service.record(event(3000, { jql: 'a' }));
  await revert.service.record(event(2000, { jql: 'b' }));
  assert.deepEqual(
    revert.versions().map(({ at, jql }) => [at, jql]),
    [
      [3000, 'a'],
      [2000, 'b'],
      [1000, 'a'],
    ],
  );
  assert.deepEqual(revert.recent(), [recentKey('10001', 3000)]);
  // The change to `b` happened at 2000: the later event that repeats it is no longer a version.
  const repeat = setup();
  await repeat.service.record(event(1000, { jql: 'a' }));
  await repeat.service.record(event(3000, { jql: 'b' }));
  await repeat.service.record(event(2000, { jql: 'b' }));
  assert.deepEqual(
    repeat.versions().map(({ at, jql }) => [at, jql]),
    [
      [2000, 'b'],
      [1000, 'a'],
    ],
  );
  assert.deepEqual(repeat.recent(), [recentKey('10001', 2000)]);
  // A late save that changed nothing against the version before it adds none.
  const same = setup();
  await same.service.record(event(1000, { jql: 'a' }));
  await same.service.record(event(3000, { jql: 'b' }));
  await same.service.record(event(2000, { jql: 'a' }));
  assert.equal(same.versions().length, 2);
});

test('a save that changed nothing, handled with an earlier change at once, is still a revert', async () => {
  const { service, versions, recent } = setup();
  await service.record(event(1000, { jql: 'a' }));
  await Promise.all([
    service.record(event(3000, { jql: 'a' })),
    service.record(event(2000, { jql: 'b' })),
  ]);
  assert.deepEqual(
    versions().map(({ at, jql }) => [at, jql]),
    [
      [3000, 'a'],
      [2000, 'b'],
      [1000, 'a'],
    ],
  );
  assert.deepEqual(recent(), [recentKey('10001', 3000)]);
});

test('the overview reads the 1,000 most recently changed filters, however old the filter', async () => {
  const { service, jira } = setup({ visible: {} });
  for (let index = 0; index <= 1000; index++)
    await service.record(event(1000 + index, { id: String(20000 + index) }));
  // The oldest filter changes last.
  await service.record(event(5000, { id: '20000', jql: 'changed' }));
  await service.overview('viewer');
  const searched = jira.searched[0];
  assert.equal(searched.length, 1000);
  assert.equal(searched[0], '20000');
  assert.ok(!searched.includes('20001'));
});

test('a recreate whose history an administrator deleted meanwhile says so', async () => {
  const { service, jira, storage } = await deletedSetup();
  jira.createFilter = async (query) => {
    jira.created.push(query);
    // An administrator's Delete history lands while Jira creates the filter.
    storage.data.delete(storage.data.get('deleted:10001').trash);
    storage.data.set('deleted:10001', { at: 3000 });
    return { status: 'applied', id: '30003' };
  };
  await assert.rejects(
    service.recreate({ filterId: '10001', at: 2000 }, 'owner'),
    /recreated in Jira with ID 30003, but its history was deleted in the meantime/,
  );
  // The record isn't written back.
  assert.ok(!storedKeys(storage).some((key) => key.startsWith('trash:') && key.endsWith(':10001')));
});

test('an expired entry that fails to be removed never holds back the ones after it', async () => {
  const { service, storage, clock } = await deletedSetup();
  clock.now = 4000 + retention;
  storage.failNext('get', 'deleted:10001');
  await service.expire();
  const keys = () => storedKeys(storage);
  assert.ok(!keys().some((key) => key.includes('10002')));
  assert.ok(keys().some((key) => key.includes('10001')));
  await service.expire();
  assert.equal(stored(storage).length, 0);
});

test('a delete event without the name or query still keeps the history', async () => {
  const { service } = setup({ visible: {} });
  await service.record(event(1000, { name: 'Bugs' }));
  await service.record(deleteEvent(2000, { name: undefined, jql: undefined }));
  assert.deepEqual(
    (await service.overview('owner')).deleted.map(({ name }) => name),
    ['Bugs'],
  );
});

/** The versions stored for a filter, by time. */
const storedTimes = (storage, filterId) =>
  [...storage.data]
    .filter(([key]) => key.startsWith(`version:${filterId}:`))
    .map(([, value]) => value.at)
    .sort();

test("history an administrator deleted on a recreated filter stays deleted when the recreate's move finishes", async () => {
  for (const finish of ['history', 'recreate', 'cleanup']) {
    const { service, jira, storage, clock } = setup({ admin: true });
    await service.record(event(1000, { jql: 'old' }));
    await service.record(event(2000));
    await service.record(deleteEvent(3000));
    jira.visible = {};
    // The history is written under the recreated filter; the deleted filter is never forgotten.
    storage.failNext('transact', 'trash:');
    await assert.rejects(service.recreate({ filterId: '10001', at: 2000 }, 'owner'));
    assert.deepEqual(storedTimes(storage, '30003'), [1000, 2000]);
    jira.visible = { 30003: now({ id: '30003' }) };
    await service.deleteHistory('30003', false, 'admin');
    if (finish === 'history') await service.history('10001', 'owner');
    if (finish === 'recreate') await service.recreate({ filterId: '10001', at: 2000 }, 'owner');
    if (finish === 'cleanup') {
      clock.now = 3000 + retention;
      await service.expire();
    }
    assert.deepEqual(storedTimes(storage, '30003'), [], finish);
    assert.ok(!storage.data.has(indexKey('30003')), finish);
    // The deleted filter's own history is gone too.
    assert.deepEqual(storedTimes(storage, '10001'), [], finish);
    assert.ok(!storage.data.has(indexKey('10001')), finish);
  }
});

/** A deleted filter recreated as 30003 by its owner, whose history hasn't moved there yet. */
const unfinishedMove = async () => {
  const context = setup({ admin: true, visible: {} });
  const { service, storage } = context;
  await service.record(event(1000, { jql: 'old' }));
  await service.record(event(2000));
  await service.record(deleteEvent(3000));
  storage.failNext('transact', 'version:30003:');
  await assert.rejects(service.recreate({ filterId: '10001', at: 2000 }, 'owner'));
  assert.equal(storage.data.get('trash:9999999996999:10001')?.recreatedAs, '30003');
  return context;
};
const created = (at, filter) =>
  event(at, filter, {
    eventType: 'avi:jira:created:filter',
    selfGenerated: true,
    atlassianId: 'owner',
  });
const recentFor = (storage, filterId) =>
  [...storage.data.keys()].filter(
    (key) => key.startsWith('recent:') && key.endsWith(`:${filterId}`),
  );

test('a move into a recreated filter that was deleted since keeps the history with it, for its owner', async () => {
  for (const before of ['nothing recorded', 'its created event']) {
    const { service, storage } = await unfinishedMove();
    if (before === 'its created event') await service.record(created(4000, { id: '30003' }));
    await service.record(deleteEvent(5000, { id: '30003' }));
    // Opening the deleted filter finishes its move.
    await service.history('10001', 'owner').catch(() => undefined);
    const history = await service.history('30003', 'owner');
    assert.deepEqual(
      history.versions.map(({ at }) => at),
      before === 'its created event' ? [4000, 2000, 1000] : [2000, 1000],
      before,
    );
    assert.equal(history.deleted.canRecreate, true, before);
    // A deleted filter has no entry in the overview's recency index.
    assert.deepEqual(recentFor(storage, '30003'), [], before);
    assert.deepEqual((await service.overview('owner')).filters, [], before);
  }
});

test('a move into a recreated filter that was recreated again ends in the newest filter', async () => {
  for (const moved of [true, false]) {
    const { service, storage, jira } = await unfinishedMove();
    await service.record(created(4000, { id: '30003' }));
    await service.record(deleteEvent(5000, { id: '30003' }));
    jira.create = { status: 'applied', id: '40004' };
    if (!moved) storage.failNext('transact', 'version:40004:');
    await service.recreate({ filterId: '30003', at: 4000 }, 'owner').catch(() => undefined);
    jira.visible = { 40004: now({ id: '40004' }) };
    const history = await service.history('10001', 'owner');
    assert.equal(history.filter.id, '40004');
    assert.deepEqual(
      history.versions.map(({ at }) => at),
      [4000, 2000, 1000],
      `moved ${moved}`,
    );
    assert.deepEqual(storedTimes(storage, '30003'), [], `moved ${moved}`);
    assert.deepEqual(recentFor(storage, '30003'), [], `moved ${moved}`);
  }
});

test('a move through a recreated filter whose own move is unfinished keeps the history deleted there deleted', async () => {
  const { service, storage, jira, clock } = await unfinishedMove();
  // 30003, the recreate of 10001 still waiting for its history, has its history deleted.
  jira.visible = { 30003: now({ id: '30003' }) };
  await service.record(created(4000, { id: '30003' }));
  clock.now = 1_000_000;
  await service.deleteHistory('30003', false, 'admin');
  // It changes after that, then is deleted and recreated as 40004, that move waiting too.
  await service.record(event(1_100_000, { id: '30003', jql: 'later' }));
  await service.record(deleteEvent(1_200_000, { id: '30003' }));
  jira.visible = {};
  clock.now = 1_300_000;
  jira.create = { status: 'applied', id: '40004' };
  storage.failNext('transact', 'version:40004:');
  await assert.rejects(service.recreate({ filterId: '30003', at: 1_100_000 }, 'owner'));
  jira.visible = { 40004: now({ id: '40004' }) };
  const history = await service.history('10001', 'owner');
  assert.equal(history.filter.id, '40004');
  // Only the change after the deletion is left, still a change.
  assert.deepEqual(
    history.versions.map(({ at }) => at),
    [1_100_000],
  );
  assert.deepEqual(storedTimes(storage, '40004'), [1_100_000]);
  assert.equal(storage.data.get('cleared:40004')?.at, 1_000_000);
});

test('a move through a recreated filter whose own move stopped after merging still arrives', async () => {
  const { service, storage, jira } = await unfinishedMove();
  await service.record(created(4000, { id: '30003' }));
  await service.record(deleteEvent(5000, { id: '30003' }));
  jira.create = { status: 'applied', id: '40004' };
  // 30003's history reaches 40004, but 30003 isn't forgotten.
  storage.failNext('transact', 'deleted:30003');
  await assert.rejects(service.recreate({ filterId: '30003', at: 4000 }, 'owner'));
  assert.deepEqual(
    storage.data.get(indexKey('40004'))?.entries.map(({ at }) => at),
    [4000],
  );
  assert.ok(storage.data.get('deleted:30003')?.trash);
  jira.visible = { 40004: now({ id: '40004' }) };
  const history = await service.history('10001', 'owner');
  assert.equal(history.filter.id, '40004');
  assert.deepEqual(
    history.versions.map(({ at }) => at),
    [4000, 2000, 1000],
  );
  assert.deepEqual(storedTimes(storage, '30003'), []);
  assert.ok(!storage.data.has(indexKey('30003')));
});

test('a change whose event comes after its deleted filter was recreated and its history moved is ignored', async () => {
  const { service, storage } = setup({ admin: true, visible: {} });
  await service.record(event(1000, { jql: 'old' }));
  await service.record(event(2000));
  await service.record(deleteEvent(3000));
  await service.recreate({ filterId: '10001', at: 2000 }, 'owner');
  assert.equal(storage.data.get('deleted:10001')?.recreatedAs, '30003');
  await service.record(event(1500, { jql: 'late' }));
  assert.ok(![...storage.data.keys()].some((key) => key.startsWith('trash:')));
  assert.ok(!storage.data.has(indexKey('10001')));
  assert.deepEqual(storedTimes(storage, '10001'), []);
});

test('a move into a recreated filter whose kept history an administrator deleted since is dropped too', async () => {
  const { service, storage } = await unfinishedMove();
  await service.record(created(4000, { id: '30003' }));
  await service.record(deleteEvent(5000, { id: '30003' }));
  await service.deleteHistory('30003', true, 'admin');
  await assert.rejects(service.history('10001', 'owner'), /isn't available/);
  assert.deepEqual(storedTimes(storage, '30003'), []);
  assert.ok(!storage.data.has(indexKey('30003')));
  assert.deepEqual(recentFor(storage, '30003'), []);
  assert.equal(storage.data.get('deleted:10001')?.recreatedAs, '30003');
});

test("the cleanup removes a deleted filter's entry in the overview's recency index, if one was left", async () => {
  const { service, storage, clock } = setup({ visible: {} });
  await service.record(event(1000));
  await service.record(deleteEvent(3000));
  storage.data.set(recentKey('10001', 1000), { filterId: '10001', at: 1000, actor: 'editor' });
  clock.now = 3000 + retention;
  await service.expire();
  assert.deepEqual(storedKeys(storage), []);
});

test("the cleanup stops a filter's removal before its lease runs out, and finishes it the next day", async () => {
  const { service, storage, clock } = setup({ visible: {} });
  await service.record(event(1000));
  await service.record(deleteEvent(3000));
  // Whatever overlapping writes left under the filter's ID goes too: a thousand versions.
  for (let i = 0; i < 1000; i++)
    storage.data.set(versionKey('10001', 2000 + i), { filterId: '10001', at: 2000 + i });
  clock.now = 3000 + retention;
  // Each batch of 25 takes three seconds to remove.
  const batchDelete = storage.kvs.batchDelete;
  storage.kvs.batchDelete = async (items) => {
    clock.now += 3000;
    return batchDelete(items);
  };
  const leases = [];
  const set = storage.kvs.set;
  storage.kvs.set = async (key, value, options) => {
    if (key.startsWith('lease:')) leases.push(value.until);
    return set(key, value, options);
  };
  await service.expire();
  // It stopped holding its lease, with time to spare.
  assert.equal(leases.length, 1);
  assert.ok(clock.now < leases[0]);
  assert.ok(storedKeys(storage).some((key) => key.startsWith('version:')));
  assert.ok(storedKeys(storage).some((key) => key.startsWith('expire:')));
  clock.now += 24 * 3600_000;
  storage.kvs.batchDelete = batchDelete;
  await service.expire();
  assert.deepEqual(storedKeys(storage), []);
});

test("the recreated filter's created event arriving during the move is kept with the moved history", async () => {
  const { service, jira, storage } = await deletedSetup();
  const get = storage.kvs.get;
  let arrived;
  storage.kvs.get = async (key) => {
    const value = await get(key);
    if (key === 'filter:30003' && !arrived) {
      arrived = service.record(created(5000, { id: '30003', jql: 'old' }));
      // The event is written now unless the move holds the new filter's lease.
      await Promise.race([arrived, new Promise((resolve) => setTimeout(resolve, 20))]);
    }
    return value;
  };
  await service.recreate({ filterId: '10001', at: 1000 }, 'owner');
  await arrived;
  storage.kvs.get = get;
  jira.visible = { 30003: now({ id: '30003', jql: 'old' }) };
  const history = await service.history('30003', 'owner');
  assert.deepEqual(
    history.versions.map(({ at }) => at),
    [5000, 2000, 1000],
  );
});

test('a deleted filter whose delete event names no owner is kept for its last owner, not its first', async () => {
  const { service } = setup({ visible: {} });
  await service.record(event(1000, { owner: 'first' }));
  await service.record(event(2000, { owner: 'second', jql: 'x' }));
  const gone = deleteEvent(3000);
  delete gone.filter.owner;
  await service.record(gone);
  assert.equal((await service.history('10001', 'second')).deleted.canRecreate, true);
  await assert.rejects(service.history('10001', 'first'), /isn't available/);
});

test('a moved record of a deleted history registers its administrator with the recreated filter', async () => {
  const { service, jira, storage } = setup({ admin: true });
  await service.record(event(1000));
  await service.deleteHistory('10001', false, 'admin');
  await service.record(event(2_000_000, { jql: 'x' }));
  await service.record(deleteEvent(3_000_000));
  jira.visible = {};
  await service.recreate({ filterId: '10001', at: 2_000_000 }, 'owner');
  assert.equal(storage.data.get('cleared:30003')?.actor, 'admin');
  assert.ok(storage.data.has('uses:admin:30003'));
});

test('Delete history stops inside its budget and says so', async () => {
  const { service, storage, clock } = setup({ admin: true });
  await service.record(event(1000));
  await service.record(event(2000, { jql: 'x' }));
  const batchDelete = storage.kvs.batchDelete;
  storage.kvs.batchDelete = async (items) => {
    clock.now += 20_000;
    return batchDelete(items);
  };
  await assert.rejects(service.deleteHistory('10001', false, 'admin'), /Try again to finish/);
});

test('a version stays listed when the quiet save holding the only description sent before it is removed', async () => {
  const { service, versions } = setup();
  // Jira leaves out a description over 10,000 characters.
  const first = event(1000);
  await service.record({ ...first, filter: without(first.filter, 'description') });
  await service.record(event(2000, { description: 'a' }));
  await service.record(event(3000, { description: 'b' }));
  for (let i = 0; i < 51; i++) await service.record(event(4000 + i, { description: 'b' }));
  assert.deepEqual(
    versions().map(({ at }) => at),
    [3000, 1000],
  );
  assert.equal(
    (await service.version({ filterId: '10001', at: 3000 }, 'owner')).version.description,
    'b',
  );
});

test('a change whose event comes after its filter was deleted is kept for the filter’s owner', async () => {
  const { service, storage } = setup({ visible: {}, admin: true });
  await service.record(deleteEvent(3000));
  // The changes name the owner they had then; the history is kept for the last one.
  await service.record(event(1000, { jql: 'a', owner: 'earlier' }));
  await service.record(event(2000, { jql: 'b', owner: 'earlier' }));
  const [kept] = [...storage.data].filter(([key]) => key.startsWith('trash:'));
  assert.equal(kept?.[1].owner, 'owner');
  const history = await service.history('10001', 'owner');
  assert.deepEqual(
    history.versions.map(({ at }) => at),
    [2000, 1000],
  );
  assert.deepEqual(history.deleted, {
    at: 3000,
    actor: 'deleter',
    expires: 3000 + retention,
    canRecreate: true,
  });
  assert.equal(history.filter.name, 'Bugs');
  assert.deepEqual(recentFor(storage, '10001'), []);
  // An administrator deletes it: a change arriving later still isn't kept.
  await service.deleteHistory('10001', true, 'admin');
  await service.record(event(2500, { jql: 'c' }));
  assert.deepEqual(storedKeys(storage).sort(), ['deleted:10001', 'expire:0000000003000:10001']);
});

test('Delete history of a deleted filter that stopped part way can be run again to finish', async () => {
  const { service, storage } = setup({ visible: {}, admin: true });
  await service.record(event(1000));
  await service.record(event(2000, { jql: 'x' }));
  await service.record(deleteEvent(3000));
  storage.failNext('batchDelete', 'version:10001:');
  await assert.rejects(service.deleteHistory('10001', true, 'admin'));
  assert.equal(contents(storage, '10001'), 1);
  assert.deepEqual(await service.deleteHistory('10001', true, 'admin'), { deleted: true });
  assert.equal(contents(storage, '10001'), 0);
});

test('an event replacing one at the same millisecond that is then removed leaves no text behind', async () => {
  const { service, storage, versions } = setup();
  await service.record(event(1000, { jql: 'a' }));
  await service.record(event(2000, { jql: 'b' }));
  await service.record(event(2500, { jql: 'a' }));
  for (let i = 0; i < 50; i++) await service.record(event(3000 + i, { jql: 'a' }));
  // A later delivery for 2000 says the JQL was still `a`: it and the save after it changed
  // nothing, the oldest of 52 such saves, so both are removed at once.
  await service.record(event(2000, { jql: 'a' }));
  assert.deepEqual(
    versions().map(({ at, jql }) => [at, jql]),
    [[1000, 'a']],
  );
  assert.ok(!storage.data.has(versionKey('10001', 2000)));
  assert.equal(contents(storage, '10001'), 51);
});

test('the newest 50 saves that changed nothing are kept, and the 51st removes the oldest', async () => {
  const { service, entries } = setup();
  await service.record(event(1000));
  for (let i = 0; i < 50; i++) await service.record(event(2000 + i));
  assert.equal(entries().length, 51);
  assert.equal(entries()[1], 2000);
  await service.record(event(3000));
  assert.equal(entries().length, 51);
  assert.equal(entries()[1], 2001);
});
