import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeContract } from './support/forge-contract.mjs';
import { memoryKvs } from './support/kvs.mjs';
const { registerResolvers } = await import('../src/resolvers.ts');
const { createFilterEventHandler, createPrivacyReportHandler } = await import('../src/events.ts');
const { createStore } = await import('../src/integration.ts');
const { createPrivacyReport } = await import('../src/privacy.ts');

const adminPath = '/rest/api/3/mypermissions?permissions=ADMINISTER';
const searchPath = (id) =>
  `/rest/api/3/filter/search?id=${id}&expand=description%2Cjql%2Cowner%2CisWritable&maxResults=100&overrideSharePermissions=true`;

// Jira's filter event as measured on a hosted site: the actor, and the owner's account ID.
const event = (filterId, at, { actor = 'editor', owner = 'owner', jql = 'type = Bug' } = {}) => ({
  eventType: 'avi:jira:updated:filter',
  atlassianId: actor,
  timestamp: String(at),
  filter: { id: filterId, name: `Filter ${filterId}`, description: '', jql, owner },
});
const deleted = (filterId, at, actor) => ({
  ...event(filterId, at, { actor }),
  eventType: 'avi:jira:deleted:filter',
});

/** Atlassian's reporting API: answers each reported account with the given status, if any. */
function privacyDouble(statuses = {}) {
  const reports = [];
  return {
    reports,
    privacy: {
      async reportPersonalData(accounts) {
        reports.push(structuredClone(accounts));
        return accounts
          .filter((a) => statuses[a.accountId])
          .map((a) => ({ accountId: a.accountId, status: statuses[a.accountId] }));
      },
    },
  };
}

/** The real handlers over the SDK double and in-memory storage, as index.ts wires them. */
function app({ responses = [], statuses = {}, storage = memoryKvs() } = {}) {
  const sdk = forgeContract(...responses);
  const reporting = privacyDouble(statuses);
  const deps = {
    ...sdk,
    kvs: storage.kvs,
    WhereConditions: storage.WhereConditions,
    appContext: () => ({ environmentType: 'DEVELOPMENT' }),
  };
  return {
    sdk,
    storage,
    reports: reporting.reports,
    record: createFilterEventHandler(deps),
    report: createPrivacyReportHandler({ ...deps, privacy: reporting.privacy }),
    resolvers: registerResolvers(deps),
  };
}

const accounts = (storage) =>
  [...storage.data.keys()].filter((key) => key.startsWith('account:')).sort();
const uses = (storage) => [...storage.data.keys()].filter((key) => key.startsWith('uses:')).sort();
const history = (storage) =>
  [...storage.data].filter(([key]) => !key.startsWith('account:') && !key.startsWith('uses:'));
/** A filter's listed versions: its first event and each that changed something. */
const listed = (storage, filterId) =>
  storage.data
    .get(`filter:${filterId}`)
    .entries.filter((entry, position) => position === 0 || entry.changed.length).length;
const mentions = (storage, accountId) =>
  history(storage).filter(([, value]) => JSON.stringify(value).includes(`"${accountId}"`));

test('each stored account is registered once, with when the app first stored it', async () => {
  const { storage, record } = app();
  const before = Date.now();
  await record(event('10001', 1000));
  const first = storage.data.get('account:editor');
  assert.equal(first.accountId, 'editor');
  assert.ok(Date.parse(first.since) >= before && Date.parse(first.since) <= Date.now());
  await record(event('10001', 2000, { jql: 'type = Task' }));
  assert.deepEqual(storage.data.get('account:editor'), first);
  assert.deepEqual(accounts(storage), ['account:editor', 'account:owner']);
  // Each filter whose records hold an account is marked once.
  await record(event('10002', 1000));
  assert.deepEqual(uses(storage), [
    'uses:editor:10001',
    'uses:editor:10002',
    'uses:owner:10001',
    'uses:owner:10002',
  ]);
});

test('a failed registration stores nothing, so Forge delivers the event again', async () => {
  const { storage, record } = app();
  storage.failNext('set', 'account:');
  const outcome = await record(event('10001', 1000));
  assert.ok(outcome, 'the handler asks Forge to retry');
  assert.deepEqual(history(storage), []);
  await record(event('10001', 1000));
  assert.deepEqual(accounts(storage), ['account:editor', 'account:owner']);
  assert.equal(history(storage).filter(([key]) => key.startsWith('version:')).length, 1);
});

test('the administrator who deletes a history is registered', async () => {
  const filter = {
    id: '10001',
    name: 'Filter 10001',
    jql: 'type = Bug',
    owner: { accountId: 'owner' },
  };
  const { storage, record, resolvers } = app({
    responses: [
      { body: { permissions: { ADMINISTER: { havePermission: true } } } },
      { body: { isLast: true, values: [filter] } },
    ],
  });
  await record(event('10001', 1000));
  const outcome = await resolvers.deleteHistory({
    context: { accountId: 'admin-1' },
    payload: { filterId: '10001', deleted: false },
  });
  assert.deepEqual(outcome, { ok: true, value: { deleted: true } });
  assert.ok(storage.data.has('account:admin-1'));
});

test("each week's report names every stored account; a closed one is erased from every record", async () => {
  const filter = {
    id: '10003',
    name: 'Filter 10003',
    jql: 'type = Bug',
    owner: { accountId: 'owner' },
  };
  const { sdk, storage, record, report, reports, resolvers } = app({
    responses: [
      {
        expect: { method: 'GET', path: adminPath },
        body: { permissions: { ADMINISTER: { havePermission: true } } },
      },
      {
        expect: { method: 'GET', path: searchPath('10003') },
        body: { isLast: true, values: [filter] },
      },
    ],
    statuses: { gone: 'closed', editor: 'updated', stranger: 'closed' },
  });
  // A filter the closed account changed, then someone else did.
  await record(event('10001', 1000, { actor: 'gone' }));
  await record(event('10001', 2000, { jql: 'type = Task' }));
  // A filter the closed account owned and deleted, so its history is kept for them.
  await record(event('10002', 1000, { owner: 'gone' }));
  await record(deleted('10002', 3000, 'gone'));
  // A history the closed account deleted as an administrator.
  await record(event('10003', 1000));
  await resolvers.deleteHistory({
    context: { accountId: 'gone' },
    payload: { filterId: '10003', deleted: false },
  });
  const keys = history(storage).map(([key]) => key);
  assert.deepEqual(
    mentions(storage, 'gone')
      .map(([key]) => key)
      .sort(),
    [
      'cleared:10003',
      'filter:10001',
      'trash:9999999996999:10002',
      'version:10001:9999999998999',
      'version:10002:9999999998999',
    ],
  );
  assert.deepEqual(
    uses(storage).filter((key) => key.startsWith('uses:gone:')),
    ['uses:gone:10001', 'uses:gone:10002', 'uses:gone:10003'],
  );
  const since = Object.fromEntries(
    accounts(storage).map((key) => [storage.data.get(key).accountId, storage.data.get(key).since]),
  );

  await report();
  assert.equal(reports.length, 1);
  assert.deepEqual(
    reports[0].sort((a, b) => a.accountId.localeCompare(b.accountId)),
    ['editor', 'gone', 'owner'].map((accountId) => ({ accountId, updatedAt: since[accountId] })),
  );
  // Nothing names the closed account; every record stays, with the account emptied.
  assert.deepEqual(mentions(storage, 'gone'), []);
  assert.deepEqual(
    history(storage).map(([key]) => key),
    keys,
  );
  const versions = history(storage).filter(([key]) => key.startsWith('version:10001:'));
  assert.deepEqual(versions.map(([, v]) => v.actor).sort(), ['', 'editor']);
  assert.equal(storage.data.get('cleared:10003').actor, '');
  assert.ok(!uses(storage).some((key) => key.startsWith('uses:gone:')));
  // The closed account is forgotten the next week, when nothing names it any more. An updated
  // account needs nothing: the app keeps only its ID. Unreported accounts are ignored.
  assert.equal(typeof storage.data.get('account:gone').erasing, 'number');
  await report();
  assert.deepEqual(accounts(storage), ['account:editor', 'account:owner']);
  assert.equal(sdk.calls.length, 2);
});

test('an erased owner is not a change: a later event still naming them adds no version', async () => {
  const { storage, record, report } = app({ statuses: { gone: 'closed' } });
  await record(event('10001', 1000, { owner: 'gone' }));
  await report();
  assert.deepEqual(mentions(storage, 'gone'), []);
  // Jira still sends the closed account as the owner: the owner is unknown, so nothing changed.
  await record(event('10001', 2000, { owner: 'gone' }));
  assert.equal(listed(storage, '10001'), 1);
  await record(event('10001', 3000, { owner: 'gone', jql: 'type = Task' }));
  assert.equal(listed(storage, '10001'), 2);
});

test('the report reaches every account and erases more records than one storage page', async () => {
  const actors = Array.from({ length: 150 }, (_, i) => `gone-${String(i).padStart(3, '0')}`);
  const statuses = Object.fromEntries(actors.map((actor) => [actor, 'closed']));
  const { storage, record, report, reports } = app({ statuses });
  // One version per filter, so none is removed by the per-filter limit.
  for (const [i, actor] of actors.entries())
    await record(event(String(20000 + i), 1000, { actor }));
  // One account in more filters than a page of markers, and one filter with more versions than a
  // page.
  for (let i = 0; i < 120; i++) await record(event(String(30000 + i), 1000, { actor: 'gone-000' }));
  for (let i = 0; i < 105; i++)
    await record(event('40000', 1000 + i, { actor: 'gone-001', jql: `key = ${i}` }));
  await report();
  assert.equal(reports.flat().length, 151);
  assert.ok(!history(storage).some(([, value]) => JSON.stringify(value).includes('gone-')));
  assert.ok(!uses(storage).some((key) => key.includes('gone-')));
  assert.equal(history(storage).filter(([key]) => key.startsWith('version:')).length, 371);
  // Each closed account is forgotten the next week.
  await report();
  assert.deepEqual(accounts(storage), ['account:owner']);
});

test('erasure that runs out of time continues next week with the filters left', async () => {
  const storage = memoryKvs();
  const { record } = app({ storage });
  for (const id of ['10001', '10002', '10003', '10004'])
    await record(event(id, 1000, { actor: 'gone' }));
  const { privacy, reports } = privacyDouble({ gone: 'closed' });
  // Each filter's erasure takes eight minutes: a run sets its deadline 14 minutes on, so it erases
  // two filters before stopping.
  const clock = { now: 0 };
  const remove = storage.kvs.delete;
  storage.kvs.delete = async (key) => {
    if (key.startsWith('uses:gone:')) clock.now += 480_000;
    return remove(key);
  };
  const report = createPrivacyReport({
    store: createStore({ kvs: storage.kvs, WhereConditions: storage.WhereConditions }),
    privacy,
    now: () => clock.now,
  });
  const named = mentions(storage, 'gone').length;
  await report();
  assert.equal(mentions(storage, 'gone').length, named / 2);
  assert.deepEqual(
    uses(storage).filter((key) => key.startsWith('uses:gone:')),
    ['uses:gone:10003', 'uses:gone:10004'],
  );
  assert.ok(storage.data.has('account:gone'));
  await report();
  assert.equal(reports.length, 2);
  assert.deepEqual(mentions(storage, 'gone'), []);
  await report();
  assert.ok(!storage.data.has('account:gone'));
});

test('a change naming a closed account while it is erased keeps the account, so next week erases it', async () => {
  const storage = memoryKvs();
  const { record, report } = app({ statuses: { gone: 'closed' }, storage });
  await record(event('10001', 1000, { actor: 'gone' }));
  // The event arrives just as erasure removes the filter's marker for the account.
  const remove = storage.kvs.delete;
  let arrived;
  storage.kvs.delete = async (key) => {
    if (key === 'uses:gone:10001' && !arrived)
      arrived = record(event('10001', 2000, { actor: 'gone', jql: 'type = Task' }));
    return remove(key);
  };
  await report();
  assert.equal(await arrived, undefined, 'the event was recorded');
  storage.kvs.delete = remove;
  // Its version names the account, so the account and its marker are kept.
  assert.ok(mentions(storage, 'gone').length > 0);
  assert.ok(storage.data.has('account:gone'));
  assert.deepEqual(
    uses(storage).filter((key) => key.startsWith('uses:gone:')),
    ['uses:gone:10001'],
  );
  await report();
  assert.deepEqual(mentions(storage, 'gone'), []);
  await report();
  assert.ok(!storage.data.has('account:gone'));
});

test('a run that fails part way keeps the account, so next week reports and erases it again', async () => {
  const { storage, record, report, reports } = app({ statuses: { gone: 'closed' } });
  await record(event('10001', 1000, { actor: 'gone' }));
  await record(event('10002', 1000, { actor: 'gone' }));
  storage.failNext('get', 'version:10002:');
  await assert.rejects(report(), /1 filter couldn't be erased/);
  assert.ok(storage.data.has('account:gone'));
  assert.ok(mentions(storage, 'gone').length > 0);
  await report();
  assert.equal(reports.length, 2);
  assert.deepEqual(mentions(storage, 'gone'), []);
  await report();
  assert.ok(!storage.data.has('account:gone'));
});

test('a refused report request still erases what the others reported closed, then fails the run', async () => {
  const actors = Array.from({ length: 100 }, (_, i) => `gone-${String(i).padStart(3, '0')}`);
  const { storage, record } = app();
  for (const [i, actor] of actors.entries())
    await record(event(String(20000 + i), 1000, { actor }));
  const { privacy, reports } = privacyDouble(
    Object.fromEntries(actors.map((actor) => [actor, 'closed'])),
  );
  const answer = privacy.reportPersonalData;
  let requests = 0;
  // Atlassian refuses the first of two requests (90 accounts, then 11).
  privacy.reportPersonalData = async (batch) => {
    if (requests++ === 0) throw Error('private refusal gone-000');
    return answer(batch);
  };
  const report = createPrivacyReport({
    store: createStore({ kvs: storage.kvs, WhereConditions: storage.WhereConditions }),
    privacy,
  });
  await assert.rejects(report(), (error) => {
    // Counts only: no account ID and nothing from the refusal.
    assert.equal(
      error.message,
      "Personal data report: 1 of 2 requests failed; next week's report sends them again.",
    );
    return true;
  });
  // The answered request's ten closed accounts are erased, to be forgotten next week; the refused
  // request's 90 wait.
  const left = accounts(storage)
    .filter((key) => !storage.data.get(key).erasing)
    .map((key) => key.slice('account:'.length));
  assert.deepEqual(
    left.filter((id) => id.startsWith('gone-')),
    actors.slice(0, 90),
  );
  assert.ok(left.includes('owner'));
  assert.equal(reports.length, 1);
  assert.equal(requests, 2);
});

/**
 * Storage whose prefix queries miss what was written while `lagging` is on, as KVS queries can
 * for a moment; gets always see it.
 */
function laggingKvs() {
  const storage = memoryKvs();
  const lag = { on: false, hidden: new Set() };
  const { set, transact, query } = storage.kvs;
  storage.kvs.set = async (key, ...rest) => {
    await set(key, ...rest);
    if (lag.on) lag.hidden.add(key);
  };
  storage.kvs.transact = () => {
    const transaction = transact();
    const keys = [];
    const builder = {
      set: (key, value) => (keys.push(key), transaction.set(key, value), builder),
      delete: (key) => (transaction.delete(key), builder),
      async execute() {
        await transaction.execute();
        if (lag.on) for (const key of keys) lag.hidden.add(key);
      },
    };
    return builder;
  };
  storage.kvs.query = () => {
    const inner = query();
    const builder = {
      where: (...args) => (inner.where(...args), builder),
      limit: (...args) => (inner.limit(...args), builder),
      cursor: (...args) => (inner.cursor(...args), builder),
      async getMany() {
        const page = await inner.getMany();
        return { ...page, results: page.results.filter(({ key }) => !lag.hidden.has(key)) };
      },
    };
    return builder;
  };
  return { storage, lag };
}

/** Every record naming the account is erased later: its account and the filter's marker stay. */
const consistent = (storage, accountId) => {
  if (!mentions(storage, accountId).length) return;
  assert.ok(storage.data.has(`account:${accountId}`), 'a stored ID keeps its account');
  for (const [key] of mentions(storage, accountId)) {
    const filterId = key.split(':').find((part) => /^\d{5}$/.test(part));
    if (filterId) assert.ok(storage.data.has(`uses:${accountId}:${filterId}`), `marker for ${key}`);
  }
};

/** Runs weekly reports until the closed account is gone, checking every record keeps its account. */
async function untilErased(storage, report, accountId, weeks = 4) {
  for (let week = 0; week < weeks && storage.data.has(`account:${accountId}`); week++) {
    await report();
    consistent(storage, accountId);
  }
  assert.deepEqual(mentions(storage, accountId), []);
  assert.ok(!storage.data.has(`account:${accountId}`));
  assert.ok(!uses(storage).some((key) => key.startsWith(`uses:${accountId}:`)));
}

test('a version written just before the report, which a storage query misses, is erased too', async () => {
  const { storage, lag } = laggingKvs();
  const { record, report } = app({ statuses: { gone: 'closed' }, storage });
  await record(event('10001', 1000, { owner: 'gone' }));
  lag.on = true;
  await record(event('10001', 2000, { owner: 'gone', jql: 'type = Task' }));
  lag.on = false;
  await report();
  assert.deepEqual(mentions(storage, 'gone'), []);
});

test("an account is forgotten only once a later week's report finds nothing left that names it", async () => {
  const { storage, lag } = laggingKvs();
  const { record, report } = app({ statuses: { gone: 'closed' }, storage });
  await record(event('10001', 1000, { actor: 'gone' }));
  // As erasure finishes the filter, a change on another filter names the account; a storage query
  // misses its marker for a while.
  const remove = storage.kvs.delete;
  let arrived = false;
  storage.kvs.delete = async (key) => {
    await remove(key);
    if (key === 'uses:gone:10001' && !arrived) {
      arrived = true;
      lag.on = true;
      assert.equal(await record(event('10002', 2000, { actor: 'gone' })), undefined);
      lag.on = false;
    }
  };
  await report();
  consistent(storage, 'gone');
  // A week later the query has caught up.
  lag.hidden.clear();
  await untilErased(storage, report, 'gone');
});

test('a change that stores an account being forgotten writes it afresh, so it is kept', async () => {
  const { storage, lag } = laggingKvs();
  const { record, report } = app({ statuses: { gone: 'closed' }, storage });
  await record(event('10001', 1000, { actor: 'gone' }));
  await report();
  assert.equal(typeof storage.data.get('account:gone')?.erasing, 'number');
  // The next week, after the report finds no marker and before it reads the account, a change on
  // another filter names it; a storage query misses its marker for a while.
  const get = storage.kvs.get;
  let arrived = false;
  storage.kvs.get = async (key) => {
    if (key === 'account:gone' && !arrived) {
      arrived = true;
      lag.on = true;
      assert.equal(await record(event('10002', 2000, { actor: 'gone' })), undefined);
      lag.on = false;
    }
    return get(key);
  };
  await report();
  storage.kvs.get = get;
  consistent(storage, 'gone');
  lag.hidden.clear();
  await untilErased(storage, report, 'gone');
});

test('a filter that keeps failing leaves the other accounts erased, and the run fails with counts only', async () => {
  const storage = memoryKvs();
  const { record, report } = app({ statuses: { 'gone-a': 'closed', 'gone-b': 'closed' }, storage });
  await record(event('10001', 1000, { actor: 'gone-a' }));
  await record(event('10002', 1000, { actor: 'gone-b' }));
  const get = storage.kvs.get;
  storage.kvs.get = async (key) => {
    if (key === 'filter:10001') throw Error('private storage failure gone-a');
    return get(key);
  };
  for (let week = 0; week < 2; week++)
    await assert.rejects(report(), (error) => {
      assert.equal(
        error.message,
        "Personal data report: 1 filter couldn't be erased; next week's report tries again.",
      );
      return true;
    });
  assert.deepEqual(mentions(storage, 'gone-b'), []);
  assert.ok(!storage.data.has('account:gone-b'));
  assert.ok(mentions(storage, 'gone-a').length > 0);
  assert.ok(storage.data.has('account:gone-a'));
  assert.ok(storage.data.has('uses:gone-a:10001'));
});

test("erasure stops a filter before that filter's lease runs out, and continues next week", async () => {
  const storage = memoryKvs();
  const { record } = app({ storage });
  for (let i = 0; i < 10; i++)
    await record(event('10001', 1000 + i, { actor: 'gone', jql: `key = ${i}` }));
  const { privacy } = privacyDouble({ gone: 'closed' });
  const clock = { now: 0 };
  let lease;
  let overran = false;
  // Each record takes ten seconds to write.
  const set = storage.kvs.set;
  storage.kvs.set = async (key, value, options) => {
    if (key === 'lease:10001') lease = value.until;
    else clock.now += 10_000;
    if (lease && clock.now > lease) overran = true;
    return set(key, value, options);
  };
  const remove = storage.kvs.delete;
  storage.kvs.delete = async (key) => {
    if (key === 'lease:10001') lease = undefined;
    return remove(key);
  };
  const report = createPrivacyReport({
    store: createStore({ kvs: storage.kvs, WhereConditions: storage.WhereConditions }),
    privacy,
    now: () => clock.now,
  });
  await report();
  assert.equal(overran, false);
  assert.ok(mentions(storage, 'gone').length > 0);
  assert.ok(storage.data.has('uses:gone:10001'));
  await untilErased(storage, report, 'gone', 6);
  assert.equal(overran, false);
});

test('a change recorded while its filter is being erased is erased by a later report', async () => {
  const storage = memoryKvs();
  const { record, report } = app({ statuses: { gone: 'closed' }, storage });
  await record(event('10001', 1000, { actor: 'gone' }));
  const get = storage.kvs.get;
  let arrived;
  storage.kvs.get = async (key) => {
    if (key === 'filter:10001' && !arrived)
      arrived = record(event('10001', 2000, { actor: 'gone', jql: 'type = Task' }));
    return get(key);
  };
  await report();
  assert.equal(await arrived, undefined);
  storage.kvs.get = get;
  consistent(storage, 'gone');
  await untilErased(storage, report, 'gone');
});

test('a change recorded between erasing a filter and forgetting the account keeps the account', async () => {
  for (const at of ['lease:10001', 'account:gone']) {
    const storage = memoryKvs();
    const { record, report } = app({ statuses: { gone: 'closed' }, storage });
    await record(event('10001', 1000, { actor: 'gone' }));
    const remove = storage.kvs.delete;
    let done = false;
    storage.kvs.delete = async (key) => {
      if (key === at && !done) {
        done = true;
        if (at.startsWith('lease:')) await remove(key);
        assert.equal(
          await record(event('10001', 2000, { actor: 'gone', jql: 'type = Task' })),
          undefined,
        );
      }
      return remove(key);
    };
    await report();
    consistent(storage, 'gone');
    await untilErased(storage, report, 'gone');
  }
});

test('a change on another filter that saw the account just before it was forgotten keeps it', async () => {
  const storage = memoryKvs();
  const { record, report } = app({ statuses: { gone: 'closed' }, storage });
  await record(event('10001', 1000, { actor: 'gone' }));
  const get = storage.kvs.get;
  const remove = storage.kvs.delete;
  let launched;
  let passed;
  const checked = new Promise((resolve) => (passed = resolve));
  let release;
  const reported = new Promise((resolve) => (release = resolve));
  // The change reads the account just before erasure removes it, and writes once erasure is done.
  storage.kvs.get = async (key) => {
    const value = await get(key);
    if (launched && key === 'account:gone') {
      passed();
      await reported;
    }
    return value;
  };
  storage.kvs.delete = async (key) => {
    if (key === 'account:gone' && !launched) {
      launched = record(event('10002', 2000, { actor: 'gone' }));
      await Promise.race([checked, launched]);
    }
    return remove(key);
  };
  for (let week = 0; week < 3; week++) await report();
  release();
  assert.equal(await launched, undefined);
  storage.kvs.get = get;
  storage.kvs.delete = remove;
  consistent(storage, 'gone');
  await untilErased(storage, report, 'gone');
});

test('a closed account that deleted a filter before any change was recorded is erased from its tombstone', async () => {
  const { storage, record, report } = app({ statuses: { gone: 'closed' } });
  await record(deleted('10001', 3000, 'gone'));
  assert.deepEqual(
    mentions(storage, 'gone').map(([key]) => key),
    ['deleted:10001'],
  );
  await untilErased(storage, report, 'gone');
  assert.ok(storage.data.has('deleted:10001'));
});
