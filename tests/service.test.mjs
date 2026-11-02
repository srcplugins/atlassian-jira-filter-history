import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryKvs } from './support/kvs.mjs';
const { createService } = await import('../src/service.ts');
const { createStore } = await import('../src/integration.ts');
const { diffText, versionKey } = await import('../src/versions.ts');

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

/** A service over in-memory storage and a Jira double whose visible filters a test sets. */
function setup({
  visible = { 10001: now() },
  update = { status: 'applied' },
  create = { status: 'applied', id: '30003' },
  admin = false,
  own = [],
} = {}) {
  const storage = memoryKvs();
  const clock = { now: 1_000_000 };
  const jira = {
    searched: [],
    updates: [],
    created: [],
    visible,
    admin,
    own,
    create,
    async visibleFilters(ids) {
      jira.searched.push(ids);
      return new Map(ids.filter((id) => jira.visible[id]).map((id) => [id, jira.visible[id]]));
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
  const service = createService({ jira, store: createStore(storage), now: () => clock.now });
  const versions = () =>
    [...storage.data.keys()]
      .filter((key) => key.startsWith('version:'))
      .sort()
      .map((key) => storage.data.get(key));
  return { service, jira, storage, versions, clock };
}

test('version keys sort newest first', () => {
  assert.ok(versionKey('1', 2000) < versionKey('1', 1000));
  assert.equal(versionKey('1', 1000).length, versionKey('1', 1_800_000_000_000).length);
});

test('each change is one version with its actor and time; no secrets are stored', async () => {
  const { service, storage, versions } = setup();
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
  assert.equal(storage.data.get('filter:10001').at, 3000);
  assert.doesNotMatch(JSON.stringify([...storage.data]), /private-token/);
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
  const { service, storage, versions } = setup();
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
  assert.equal(storage.data.get('filter:10001').at, 1000);
});

test("Jira's string timestamp is the version's time", async () => {
  const { service, storage, versions } = setup();
  await service.record(event('1000'));
  await service.record(event('2000', { jql: 'type = Bug AND status = Open' }));
  assert.deepEqual(
    versions().map(({ at }) => at),
    [2000, 1000],
  );
  assert.equal(storage.data.get('filter:10001').at, 2000);
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
  const { service, storage, versions } = setup();
  await service.record(event(2000, { jql: 'b' }));
  await service.record(event(1000, { jql: 'a' }));
  assert.deepEqual(
    versions().map(({ jql }) => jql),
    ['b', 'a'],
  );
  assert.equal(storage.data.get('filter:10001').jql, 'b');
});

const deleteEvent = (at, filter = {}) =>
  event(at, filter, { eventType: 'avi:jira:deleted:filter', atlassianId: 'deleter' });

test('two events written at once never hide a later real change', async () => {
  const { service, storage, versions } = setup();
  // Both read the history before either writes; the older one's latest record lands last.
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
  assert.equal(storage.data.get('filter:10001').at, 3000);
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

test("a version whose description Jira didn't send is never restored or recreated", async () => {
  const { service, jira } = setup();
  await service.record(event(1000, { jql: 'a' }));
  await service.record({
    ...event(2000),
    filter: without({ ...event(0).filter, jql: 'b' }, 'description'),
  });
  const { versions } = await service.history('10001', 'owner');
  assert.deepEqual(versions[0].changed, ['jql'], 'an unknown description is no change');
  await assert.rejects(
    service.restore({ filterId: '10001', at: 2000, expected }),
    /didn't send this version's description/,
  );
  await service.record(deleteEvent(3000));
  await assert.rejects(
    service.recreate({ filterId: '10001', at: 2000 }, 'owner'),
    /can't be recreated/,
  );
  assert.equal(jira.updates.length + jira.created.length, 0);
  assert.equal((await service.changes('10001')).changes[0].after.description, null);
});

test('a deleted filter keeps its history for its last owner, and later events start none', async () => {
  const { service, storage } = setup();
  for (let at = 1; at <= 60; at++) await service.record(event(at * 1000, { jql: `n = ${at}` }));
  await service.record(event(1000, { id: '20002' }));
  await service.record(deleteEvent(61_000));
  await service.record(deleteEvent(61_500));
  await service.record(event(62_000, { jql: 'late' }));
  const keys = [...storage.data.keys()].filter((key) => key.includes('10001'));
  assert.equal(keys.filter((key) => key.startsWith('version:')).length, 60);
  assert.ok(!keys.includes('filter:10001'));
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
  assert.deepEqual(
    [...storage.data],
    [
      ['deleted:10001', { at: 1000 }],
      ['expire:0000000001000:10001', { filterId: '10001', at: 1000 }],
    ],
  );
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
  assert.deepEqual(jira.searched, [['10001', '10002', '10003']]);
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

test('deleted filters are listed to their owner, and all of them to an administrator', async () => {
  const { service, jira } = await deletedSetup();
  const row = (filterId, name, owner, at, canOpen) => ({
    filterId,
    name,
    owner,
    at,
    actor: 'deleter',
    canOpen,
  });
  assert.deepEqual((await service.overview('owner')).deleted, [
    row('10001', 'Bugs', 'owner', 3000, true),
  ]);
  assert.deepEqual((await service.overview('someone')).deleted, []);
  jira.admin = true;
  const admin = await service.overview('admin');
  assert.equal(admin.admin, true);
  assert.deepEqual(admin.deleted, [
    row('10002', 'Theirs', 'other', 4000, false),
    row('10001', 'Bugs', 'owner', 3000, false),
  ]);
  assert.deepEqual(admin.filters, []);
});

test("a deleted filter's history opens read-only for its owner and for no one else", async () => {
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
  assert.deepEqual(history.deleted, { at: 3000, actor: 'deleter' });
  assert.equal(history.admin, false);
  assert.deepEqual(
    history.versions.map(({ at, changed }) => [at, changed]),
    [
      [2000, ['jql']],
      [1000, []],
    ],
  );
  jira.admin = true;
  await assert.rejects(service.history('10001', 'admin'), /isn't available to you/);
  await assert.rejects(service.history('10002', 'owner'), /isn't available to you/);
  await assert.rejects(service.changes('10001'), /isn't available to you/);
});

test('recreating creates a private filter from the version and moves the history to it', async () => {
  const { service, jira, storage } = await deletedSetup();
  assert.deepEqual(await service.recreate({ filterId: '10001', at: 1000 }, 'owner'), {
    filterId: '30003',
  });
  assert.equal(jira.created.length, 1);
  assert.equal(jira.created[0].jql, 'old');
  assert.deepEqual(
    [...storage.data.keys()].filter((key) => key.includes('10001')),
    ['deleted:10001', 'expire:0000000003000:10001'],
  );
  assert.deepEqual(storage.data.get('deleted:10001'), { at: 3000 });
  assert.equal((await service.overview('owner')).deleted.length, 0);
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
    versions.map(({ filterId, at, recreated, changed }) => [filterId, at, recreated, changed]),
    [
      ['30003', 5000, true, ['jql']],
      ['30003', 2000, false, ['jql']],
      ['30003', 1000, false, []],
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
    assert.ok(!JSON.stringify([...storage.data]).includes('recreatedAs'));
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
  assert.equal(
    [...storage.data.keys()].filter((key) => key.startsWith('version:30003:')).length,
    2,
  );
  assert.deepEqual(storage.data.get('deleted:10001'), { at: 3000 });
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
});

test('two recreates at once make one Jira write; the other is told to wait', async () => {
  const { service, jira, storage } = await deletedSetup();
  const results = await Promise.allSettled([
    service.recreate({ filterId: '10001', at: 2000 }, 'owner'),
    service.recreate({ filterId: '10001', at: 1000 }, 'owner'),
  ]);
  assert.equal(jira.created.length, 1);
  assert.deepEqual(results.map(({ status }) => status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find(({ status }) => status === 'rejected').reason.message, /already being/);
  assert.equal(
    [...storage.data.keys()].filter((key) => key.startsWith('version:30003:')).length,
    2,
  );
});

test('a recreate that moved the history but not its deleted entry is finished by opening it', async () => {
  const { service, jira, storage } = await deletedSetup();
  const trash = storage.data.get('deleted:10001').trash;
  storage.failNext('delete', trash);
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
  assert.ok([...storage.data.keys()].some((key) => key.startsWith('version:10001:')));
  await service.recreate({ filterId: '10001', at: 150_000 }, 'owner');
  assert.equal(
    [...storage.data.keys()].filter((key) => key.startsWith('version:30003:')).length,
    101,
  );
  assert.equal(jira.created.length, 1);
});

test("administrators delete a deleted or visible filter's history; Jira isn't changed", async () => {
  const { service, jira, storage } = await deletedSetup({
    visible: { 10003: now({ id: '10003' }) },
  });
  await service.record(event(1000, { id: '10003' }));
  await assert.rejects(service.deleteHistory('10002'), /Only Jira administrators/);
  jira.admin = true;
  assert.deepEqual(await service.deleteHistory('10002'), { deleted: true });
  assert.deepEqual(await service.deleteHistory('10003'), { deleted: true });
  await assert.rejects(service.deleteHistory('10004'), /isn't available/);
  await assert.rejects(service.deleteHistory('x'), /Choose a saved filter/);
  assert.deepEqual(
    [...storage.data.keys()].filter((key) => /1000[23]/.test(key)),
    ['deleted:10002', 'expire:0000000004000:10002'],
  );
  assert.deepEqual(storage.data.get('deleted:10002'), { at: 4000 });
  assert.equal((await service.overview('admin')).deleted.length, 1);
  assert.equal(jira.updates.length + jira.created.length, 0);
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
    isAdmin: async () => true,
  };
  const service = createService({ jira, store: createStore(storage) });
  await assert.rejects(service.history('10001', 'owner'), /App storage is unavailable/);
  await assert.rejects(service.overview('owner'), /App storage is unavailable/);
  await assert.rejects(service.deleteHistory('10001'), /App storage is unavailable/);
});

const day = 24 * 60 * 60 * 1000;

test('each filter keeps its newest 100 versions, plus one to compare the oldest shown with', async () => {
  const { service, versions } = setup();
  for (let at = 1; at <= 130; at++) await service.record(event(at * 1000, { jql: `n = ${at}` }));
  assert.equal(versions().length, 101);
  assert.equal(versions().at(-1).at, 30_000);
  const history = await service.history('10001', 'viewer');
  assert.equal(history.versions.length, 100);
  assert.equal(history.more, true);
  assert.deepEqual(history.versions.at(-1).changed, ['jql']);
});

test('a failed trim never fails recording; the next version removes the extra ones', async () => {
  const { service, storage, versions } = setup();
  for (let at = 1; at <= 101; at++) await service.record(event(at * 1000, { jql: `n = ${at}` }));
  storage.failNext('batchDelete', 'version:10001:');
  await service.record(event(102_000, { jql: 'n = 102' }));
  assert.equal(versions().length, 102);
  await service.record(event(103_000, { jql: 'n = 103' }));
  assert.equal(versions().length, 101);
});

test('a deleted filter and its history are removed 90 days after the delete, oldest first', async () => {
  const { service, storage, clock, jira } = await deletedSetup({
    visible: { 10003: now({ id: '10003' }) },
  });
  await service.record(event(1000, { id: '10003' }));
  await service.record(deleteEvent(5000, { id: '10004' }));
  const keys = () => [...storage.data.keys()];
  clock.now = 3000 + 90 * day - 1;
  await service.expire();
  assert.ok(keys().some((key) => key.includes('10001')));
  clock.now = 3000 + 90 * day;
  await service.expire();
  assert.ok(!keys().some((key) => key.includes('10001')));
  assert.equal(keys().filter((key) => key.includes('10002')).length, 4);
  clock.now = 5000 + 90 * day;
  await service.expire();
  assert.deepEqual(keys().sort(), ['filter:10003', versionKey('10003', 1000)].sort());
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
  const keys = [...storage.data.keys()];
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
    clock.now += 1000;
    return remove(...args);
  };
  await service.expire();
  const left = () => [...storage.data.keys()].filter((key) => key.startsWith('expire:')).length;
  assert.ok(left() > 0 && left() < 30);
  storage.kvs.delete = remove;
  await service.expire();
  assert.equal(storage.data.size, 0);
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
