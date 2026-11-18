// Recording under real delivery: events arrive late, twice and at once, and every storage call can
// interleave with another invocation's. Expected histories come from a plain in-order reading of
// the events (`expected`), never from the service.
import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryKvs } from './support/kvs.mjs';
const { createService } = await import('../src/service.ts');
const { createStore } = await import('../src/integration.ts');
const { createLeases, FilterBusy } = await import('../src/lease.ts');
const { createFilterEventHandler } = await import('../src/events.ts');
const { recentKey } = await import('../src/versions.ts');

const change = (at, jql, extra = {}) => ({
  eventType: 'avi:jira:updated:filter',
  atlassianId: `actor-${at}`,
  timestamp: String(at),
  filter: { id: '10001', name: 'Bugs', description: '', jql, owner: 'owner' },
  ...extra,
});
const deletion = (at) => ({ ...change(at, 'x'), eventType: 'avi:jira:deleted:filter' });

/** Seeded random numbers, so a failing case can be run again. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

/** The storage double with each call delayed by a random number of turns, so calls interleave. */
function interleaving(storage, next) {
  const { kvs } = storage;
  const wait = async () => {
    for (let turns = Math.floor(next() * 4); turns > 0; turns--) await turn();
  };
  const delayed =
    (call) =>
    async (...args) => {
      await wait();
      return call(...args);
    };
  return {
    ...kvs,
    get: delayed(kvs.get),
    set: delayed(kvs.set),
    delete: delayed(kvs.delete),
    batchDelete: delayed(kvs.batchDelete),
    transact() {
      const transaction = kvs.transact();
      const builder = {
        set: (key, value) => (transaction.set(key, value), builder),
        delete: (key) => (transaction.delete(key), builder),
        execute: delayed(() => transaction.execute()),
      };
      return builder;
    },
    query() {
      const query = kvs.query();
      const builder = {
        where: (...args) => (query.where(...args), builder),
        limit: (...args) => (query.limit(...args), builder),
        cursor: (...args) => (query.cursor(...args), builder),
        getMany: delayed(() => query.getMany()),
      };
      return builder;
    },
  };
}

function setup({ seed } = {}) {
  const storage = memoryKvs();
  const kvs = seed === undefined ? storage.kvs : interleaving(storage, random(seed));
  const clock = { now: 50_000 };
  const jira = {
    admin: true,
    gone: false,
    async isAdmin() {
      return jira.admin;
    },
    async listedFilters(ids) {
      return jira.visibleFilters(ids);
    },
    async visibleFilters(ids) {
      if (jira.gone) return new Map();
      return new Map(
        ids.map((id) => [
          id,
          { id, name: 'Bugs', description: '', jql: '?', owner: 'owner', isWritable: true },
        ]),
      );
    },
  };
  const service = createService({
    jira,
    store: createStore({ kvs, WhereConditions: storage.WhereConditions }),
    now: () => clock.now,
    sleep: turn,
  });
  return { service, storage, clock, jira };
}

/**
 * What a history should list for change events however they arrived: the events in time order,
 * redeliveries once, and each that changed the JQL against the one before it (the first always).
 */
function expected(events) {
  const once = [...new Map(events.map((event) => [Number(event.timestamp), event])).values()];
  once.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  return once
    .filter((event, i) => i === 0 || event.filter.jql !== once[i - 1].filter.jql)
    .map((event) => [Number(event.timestamp), event.filter.jql]);
}

/** What the service lists, and the overview's entries for the filter, with nothing left over. */
async function recorded({ service, storage }) {
  const { versions } = await service.history('10001', 'owner');
  const texts = [];
  for (const { at } of versions)
    texts.push([at, (await service.version({ filterId: '10001', at }, 'owner')).version.jql]);
  const keys = [...storage.data.keys()];
  return {
    versions: texts.reverse(),
    recent: keys.filter((key) => key.startsWith('recent:')),
    leases: keys.filter((key) => key.startsWith('lease:')),
  };
}

test('every arrival order of five events, delivered again in reverse, records the same history', async () => {
  const letters = ['a', 'b', 'c'];
  const contents = (length) =>
    length === 0 ? [[]] : contents(length - 1).flatMap((c) => letters.map((l) => [...c, l]));
  function* orders(items) {
    if (items.length <= 1) return yield items;
    for (let i = 0; i < items.length; i++)
      for (const rest of orders([...items.slice(0, i), ...items.slice(i + 1)]))
        yield [items[i], ...rest];
  }
  let checked = 0;
  for (const jqls of contents(5)) {
    if (jqls[0] !== 'a') continue;
    const events = jqls.map((jql, i) => change(1000 * (i + 1), jql));
    const want = expected(events);
    const newest = want.at(-1)[0];
    // Every order of the last four after the first is enough to cover each late arrival.
    for (const order of orders(events.slice(1))) {
      const context = setup();
      for (const event of [events[0], ...order, ...[...order].reverse()])
        await context.service.record(event);
      const got = await recorded(context);
      const label = `${jqls.join('')} arriving ${order.map((e) => e.timestamp).join(' ')}`;
      assert.deepEqual(got.versions, want, label);
      assert.deepEqual(got.recent, [recentKey('10001', newest)], label);
      checked++;
    }
  }
  assert.equal(checked, 81 * 24);
});

test('events delivered at once, in any interleaving of storage calls, record the in-order history', async () => {
  for (let seed = 1; seed <= 150; seed++) {
    const next = random(seed * 7919);
    const context = setup({ seed });
    const first = change(1000, 'a');
    await context.service.record(first);
    // Three to five events from a burst of edits, one delivered twice.
    const times = [2000, 3000, 4000, 5000, 6000].filter(() => next() < 0.8);
    const burst = times.map((at) => change(at, ['a', 'b', 'c'][Math.floor(next() * 3)]));
    if (burst.length) burst.push(burst[Math.floor(next() * burst.length)]);
    await Promise.all(burst.map((event) => context.service.record(event)));
    const want = expected([first, ...burst]);
    const got = await recorded(context);
    const label = `seed ${seed}: ${burst.map((e) => e.timestamp + e.filter.jql).join(' ')}`;
    assert.deepEqual(got.versions, want, label);
    assert.deepEqual(got.recent, [recentKey('10001', want.at(-1)[0])], label);
    assert.deepEqual(got.leases, [], label);
  }
});

test('the same delete delivered twice at once keeps the history for its owner', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const context = setup({ seed });
    await context.service.record(change(1000, 'a'));
    await context.service.record(change(2000, 'b'));
    await Promise.all([
      context.service.record(deletion(3000)),
      context.service.record(deletion(3000)),
    ]);
    context.jira.gone = true;
    context.jira.admin = false;
    const tombstone = context.storage.data.get('deleted:10001');
    assert.ok(tombstone.trash && context.storage.data.has(tombstone.trash), `seed ${seed}`);
    assert.deepEqual(
      (await context.service.overview('owner')).deleted.map(({ filterId }) => filterId),
      ['10001'],
    );
    assert.equal((await context.service.history('10001', 'owner')).versions.length, 2);
  }
});

test('a change delivered with the delete after it joins the kept history in either order', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const context = setup({ seed });
    await context.service.record(change(1000, 'a'));
    await Promise.all([
      context.service.record(change(2000, 'b')),
      context.service.record(deletion(3000)),
    ]);
    context.jira.gone = true;
    const { versions } = await context.service.history('10001', 'owner');
    assert.deepEqual(
      versions.map(({ at }) => at),
      [2000, 1000],
      `seed ${seed}`,
    );
    assert.deepEqual(
      [...context.storage.data.keys()].filter((key) => key.startsWith('recent:')),
      [],
    );
  }
});

test('a late event delivered while an administrator deletes the history never brings it back', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const context = setup({ seed });
    await context.service.record(change(1000, 'a'));
    await context.service.record(change(2000, 'b'));
    await Promise.all([
      context.service.deleteHistory('10001', false, 'admin'),
      context.service.record(change(1500, 'c')),
    ]);
    const history = await context.service.history('10001', 'admin');
    assert.deepEqual(history.versions, [], `seed ${seed}`);
    assert.deepEqual(history.cleared, { at: 50_000, actor: 'admin' });
    assert.ok(
      ![...context.storage.data.keys()].some((key) => /^(version|recent):/.test(key)),
      `seed ${seed}`,
    );
  }
});

test('a history of 101 versions of 90,000-character JQL stays small; texts load one version at a time', async () => {
  const context = setup();
  const jql = (i) => `${'x'.repeat(89_990)} ${i}`;
  for (let i = 1; i <= 101; i++) await context.service.record(change(i * 1000, jql(i)));
  const history = await context.service.history('10001', 'owner');
  assert.equal(history.versions.length, 100);
  assert.equal(history.more, true);
  // Forge refuses a resolver response over 5 MB; this one carries no texts.
  assert.ok(JSON.stringify(history).length < 20_000, String(JSON.stringify(history).length));
  const opened = await context.service.version({ filterId: '10001', at: 2000 }, 'owner');
  // The oldest listed version compares with the entry kept before it.
  assert.deepEqual([opened.version.jql, opened.previous.jql], [jql(2), jql(1)]);
  assert.ok(JSON.stringify(opened).length < 200_000);
  const rovo = await context.service.changes('10001');
  assert.equal(rovo.changes.length, 10);
  assert.ok(rovo.changes.every((entry) => entry.after.jql.length === 4000 && entry.truncated));
  assert.ok(JSON.stringify(rovo).length < 50_000);
});

test("Jira's placeholder account `unknown` is stored and registered as no one", async () => {
  const context = setup();
  await context.service.record({
    ...change(1000, 'a', { atlassianId: 'unknown' }),
    filter: { ...change(1000, 'a').filter, owner: 'unknown' },
  });
  const opened = await context.service.version({ filterId: '10001', at: 1000 }, 'owner');
  assert.deepEqual([opened.version.actor, opened.version.owner], ['', '']);
  assert.ok(![...context.storage.data.keys()].some((key) => key.includes('unknown')));
});

test('an opened version that is no longer recorded, or not a version, is refused', async () => {
  const context = setup();
  await context.service.record(change(1000, 'a'));
  await context.service.record(change(2000, 'a'));
  for (const at of [2000, 1500])
    await assert.rejects(
      context.service.version({ filterId: '10001', at }, 'owner'),
      /no longer recorded/,
    );
  for (const payload of [null, { filterId: '10001' }, { filterId: 'x', at: 1000 }])
    await assert.rejects(context.service.version(payload, 'owner'), /Choose/);
  context.jira.gone = true;
  await assert.rejects(
    context.service.version({ filterId: '10001', at: 1000 }, 'owner'),
    /isn't available/,
  );
});

/**
 * Leases over the storage double (its calls interleaved when seeded), with a clock that moves only
 * when a caller waits.
 */
function leases({ seed } = {}) {
  const storage = memoryKvs();
  const kvs = seed === undefined ? storage.kvs : interleaving(storage, random(seed));
  const store = createStore({ kvs, WhereConditions: storage.WhereConditions });
  const clock = { now: 1_000_000 };
  const sleep = async (ms) => {
    clock.now += ms;
    await turn();
  };
  return { storage, clock, ...createLeases({ store, now: () => clock.now, sleep }) };
}

test('a lease held by a running invocation makes another wait, then give up', async () => {
  const { storage, clock, hold } = leases();
  storage.data.set('lease:10001', { token: 'running', until: clock.now + 60_000 });
  let ran = false;
  await assert.rejects(
    hold('10001', 5000, async () => {
      ran = true;
    }),
    (error) => error instanceof FilterBusy,
  );
  assert.equal(ran, false);
  assert.ok(clock.now >= 1_005_000 - 400);
  // The other invocation's lease is untouched.
  assert.equal(storage.data.get('lease:10001').token, 'running');
});

test('a lease whose holder stopped is taken over once its time has passed, and released after', async () => {
  const { storage, clock, hold } = leases();
  storage.data.set('lease:10001', { token: 'stopped', until: clock.now - 1 });
  assert.equal(await hold('10001', 1000, async () => 'done'), 'done');
  assert.ok(!storage.data.has('lease:10001'));
});

test('two invocations taking over a stopped lease at once never run together', async () => {
  for (let round = 0; round < 20; round++) {
    const { storage, clock, hold } = leases();
    storage.data.set('lease:10001', { token: 'stopped', until: clock.now - 1 });
    let running = 0;
    let most = 0;
    const work = async () => {
      running++;
      most = Math.max(most, running);
      for (let i = round % 4; i >= 0; i--) await turn();
      running--;
    };
    await Promise.all([hold('10001', 60_000, work), hold('10001', 60_000, work)]);
    assert.equal(most, 1, `round ${round}`);
    assert.ok(!storage.data.has('lease:10001'));
  }
});

test('three invocations taking over a stopped lease, in any interleaving of storage calls, never run together', async () => {
  for (let seed = 0; seed < 200; seed++) {
    const { storage, clock, hold } = leases({ seed });
    storage.data.set('lease:10001', { token: 'stopped', until: clock.now - 1 });
    let running = 0;
    let most = 0;
    const work = async () => {
      running++;
      most = Math.max(most, running);
      for (let i = 0; i < 6; i++) await turn();
      running--;
    };
    await Promise.all([1, 2, 3].map(() => hold('10001', 60_000, work)));
    assert.equal(most, 1, `seed ${seed}`);
    assert.ok(!storage.data.has('lease:10001'), `seed ${seed}`);
  }
});

test("a lease taken over from a slow holder isn't released by it", async () => {
  const { storage, clock, hold } = leases();
  await hold('10001', 1000, async () => {
    // This holder runs past its lease, and another invocation takes the filter over.
    clock.now += 61_000;
    storage.data.set('lease:10001', { token: 'next', until: clock.now + 60_000 });
  });
  assert.equal(storage.data.get('lease:10001').token, 'next');
});

test('a storage failure part way through a takeover leaves the filter free for the next try', async () => {
  // The read before removing the stopped lease, its removal, and the claim's own read.
  for (const [call, nth] of [
    ['get', 2],
    ['delete', 1],
    ['get', 3],
  ]) {
    const { storage, clock, hold } = leases();
    storage.data.set('lease:10001', { token: 'stopped', until: clock.now - 1 });
    const kvs = { ...storage.kvs };
    let seen = 0;
    for (const name of ['get', 'delete'])
      storage.kvs[name] = async (key, ...rest) => {
        if (name === call && (key.startsWith('lease:') || key.startsWith('takeover:')))
          if (++seen === nth) throw Error('private storage failure');
        return kvs[name](key, ...rest);
      };
    await hold('10001', 1000, async () => 'done').catch(() => undefined);
    Object.assign(storage.kvs, kvs);
    // At worst its own lease is left, failed to release, and taken over once it has run out.
    assert.equal(await hold('10001', 70_000, async () => 'done'), 'done', `${call} ${nth}`);
    assert.deepEqual([...storage.data.keys()], [], `${call} ${nth}`);
  }
});

test('a takeover whose claimant stopped is taken over in turn once its claim has run out', async () => {
  const { storage, clock, hold } = leases();
  storage.data.set('lease:10001', { token: 'stopped', until: clock.now - 1 });
  storage.data.set('takeover:lease:10001:stopped', { token: 'claimant', until: clock.now + 5000 });
  // The claimant may still be finishing: wait for its claim to run out, then take over.
  assert.equal(await hold('10001', 10_000, async () => 'done'), 'done');
  assert.ok(clock.now >= 1_005_000);
  // Nothing of the takeover is left behind.
  assert.deepEqual([...storage.data.keys()], []);
});

test("a lease doesn't depend on storage removing expired keys", async () => {
  const { storage, clock, hold } = leases();
  // KVS may keep an expired key for up to 48 hours: hidden from reads but still refusing a write
  // that requires the key to be free.
  const expires = new Map();
  const { get, set } = storage.kvs;
  storage.kvs.get = async (key) =>
    (expires.get(key) ?? Infinity) <= clock.now ? undefined : get(key);
  storage.kvs.set = async (key, value, options) => {
    await set(key, value, options);
    if (options?.ttl) expires.set(key, clock.now + options.ttl.value * 1000);
  };
  // A holder stops without releasing its lease; nothing touches the filter for two hours.
  storage.kvs.delete = async () => {
    throw Error('private storage failure');
  };
  await hold('10001', 1000, async () => undefined);
  storage.kvs.delete = storage.data.delete.bind(storage.data);
  clock.now += 2 * 3600_000;
  assert.equal(await hold('10001', 1000, async () => 'done'), 'done');
});

test('work holding a lease is told when to stop: well before the lease runs out', async () => {
  const { clock, hold } = leases();
  const started = clock.now;
  const told = await hold('10001', 1000, async (deadline) => deadline);
  assert.equal(told, started + 45_000);
});

test('a second stopped lease on the same filter is taken over too', async () => {
  const { storage, clock, hold } = leases();
  for (const stopped of ['first', 'second']) {
    storage.data.set('lease:10001', { token: stopped, until: clock.now - 1 });
    assert.equal(await hold('10001', 1000, async () => 'done'), 'done', stopped);
  }
});

test('a lease or takeover claim whose write landed but whose answer was lost still counts', async () => {
  for (const lost of ['lease:', 'takeover:']) {
    const { storage, clock, hold } = leases();
    if (lost === 'takeover:')
      storage.data.set('lease:10001', { token: 'stopped', until: clock.now - 1 });
    const set = storage.kvs.set;
    let once = false;
    storage.kvs.set = async (key, value, options) => {
      const result = await set(key, value, options);
      if (key.startsWith(lost) && !once) {
        once = true;
        throw Error('answer lost');
      }
      return result;
    };
    assert.equal(await hold('10001', 1000, async () => 'done'), 'done', lost);
  }
});

test('a storage failure while checking whose lease it is is tried again with the same token', async () => {
  const { storage, clock, hold } = leases();
  const set = storage.kvs.set;
  let once = false;
  storage.kvs.set = async (key, value, options) => {
    const result = await set(key, value, options);
    if (key === 'lease:10001' && !once) {
      once = true;
      throw Error('answer lost');
    }
    return result;
  };
  // The lease landed but its answer was lost, and the read that would show it is this one's fails.
  storage.failNext('get', 'lease:');
  const started = clock.now;
  assert.equal(await hold('10001', 1000, async () => 'done'), 'done');
  assert.ok(clock.now - started < 1000);
  assert.ok(!storage.data.has('lease:10001'));
});

test("a slow holder's lease released and taken afresh during a takeover is left alone", async () => {
  const { storage, clock, hold } = leases();
  storage.data.set('lease:10001', { token: 'slow', until: clock.now - 1 });
  const set = storage.kvs.set;
  storage.kvs.set = async (key, value, options) => {
    const result = await set(key, value, options);
    // Once the takeover is claimed, the slow holder finishes and another invocation takes the lease.
    if (key.startsWith('takeover:'))
      storage.data.set('lease:10001', { token: 'fresh', until: clock.now + 60_000 });
    return result;
  };
  let ran = false;
  await assert.rejects(
    hold('10001', 1000, async () => {
      ran = true;
    }),
    (error) => error instanceof FilterBusy,
  );
  assert.equal(ran, false);
  assert.equal(storage.data.get('lease:10001')?.token, 'fresh');
});

test('an event for a filter another invocation holds asks Forge to deliver it again', async (t) => {
  // The handler waits ten seconds of the real clock for the lease: the clock is mocked here.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const storage = memoryKvs();
  const record = createFilterEventHandler({
    kvs: storage.kvs,
    WhereConditions: storage.WhereConditions,
  });
  storage.data.set('lease:10001', { token: 'running', until: 1_000_000 + 60_000 });
  let outcome;
  const handled = record({ ...change(1000, 'a'), retryContext: { retryCount: 3 } }).then(
    (result) => (outcome = result),
  );
  for (let waited = 0; !outcome && waited < 20_000; waited += 100) {
    await turn();
    t.mock.timers.tick(100);
  }
  await handled;
  // The fourth delivery waits the longest Forge allows.
  assert.deepEqual(outcome, {
    _retry: true,
    retryOptions: { retryAfter: 900, retryReason: 'FUNCTION_RETRY_REQUEST', retryData: {} },
  });
  assert.ok(![...storage.data.keys()].some((key) => key.startsWith('version:')));
});

test("an event Forge won't deliver again fails, with nothing of the filter, so the logs show it", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const storage = memoryKvs();
  const record = createFilterEventHandler({
    kvs: storage.kvs,
    WhereConditions: storage.WhereConditions,
  });
  storage.data.set('lease:10001', { token: 'running', until: 1_000_000 + 60_000 });
  let outcome;
  const handled = record({ ...change(1000, 'a'), retryContext: { retryCount: 4 } }).then(
    (result) => (outcome = { result }),
    (error) => (outcome = { error }),
  );
  for (let waited = 0; !outcome && waited < 20_000; waited += 100) {
    await turn();
    t.mock.timers.tick(100);
  }
  await handled;
  assert.equal(
    outcome.error?.message,
    "Filter event dropped after Forge's last retry: the filter stayed busy.",
  );
  // A storage outage says so instead.
  const failing = memoryKvs({ failing: true });
  const dropped = createFilterEventHandler({
    kvs: failing.kvs,
    WhereConditions: failing.WhereConditions,
  });
  outcome = undefined;
  const failed = dropped({ ...change(1000, 'a'), retryContext: { retryCount: 4 } }).then(
    (result) => (outcome = { result }),
    (error) => (outcome = { error }),
  );
  for (let waited = 0; !outcome && waited < 20_000; waited += 100) {
    await turn();
    t.mock.timers.tick(100);
  }
  await failed;
  assert.equal(
    outcome.error?.message,
    "Filter event dropped after Forge's last retry: storage was unavailable.",
  );
});
