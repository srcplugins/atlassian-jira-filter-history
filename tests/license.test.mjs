import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeContract } from './support/forge-contract.mjs';
import { memoryKvs } from './support/kvs.mjs';
const { registerResolvers } = await import('../src/resolvers.ts');
const { createRovoAction } = await import('../src/rovo.ts');
const { createFilterEventHandler } = await import('../src/events.ts');
const { licensed } = await import('../src/license.ts');

const refusal =
  'Filter History for Jira has no active subscription on this site. A site administrator can subscribe in Atlassian Administration.';
// License states as the Forge runtime reports them (`forge install --license <state>` in
// development), and whether each one may use the app.
const states = [
  ['production, active', { environmentType: 'PRODUCTION', license: { active: true } }, true],
  [
    'production, trial',
    { environmentType: 'PRODUCTION', license: { active: true, isEvaluation: true } },
    true,
  ],
  ['production, inactive', { environmentType: 'PRODUCTION', license: { active: false } }, false],
  ['production, no license', { environmentType: 'PRODUCTION' }, false],
  ['production, null license', { environmentType: 'PRODUCTION', license: null }, false],
  ['production, empty license', { environmentType: 'PRODUCTION', license: {} }, false],
  [
    'production, deprecated isActive',
    { environmentType: 'PRODUCTION', license: { isActive: true } },
    true,
  ],
  [
    'production, active wins over isActive',
    { environmentType: 'PRODUCTION', license: { active: false, isActive: true } },
    false,
  ],
  [
    'production, string active',
    { environmentType: 'PRODUCTION', license: { active: 'true' } },
    false,
  ],
  ['unknown environment, no license', {}, false],
  ['development, no license', { environmentType: 'DEVELOPMENT' }, true],
  ['staging, no license', { environmentType: 'STAGING' }, true],
  [
    'development, --license inactive',
    { environmentType: 'DEVELOPMENT', license: { active: false } },
    false,
  ],
];

test('the license decides as Forge reports it; without one only development and staging pass', () => {
  for (const [state, app, allowed] of states) assert.equal(licensed(app), allowed, state);
});

/**
 * Real handlers over the SDK double, with every storage access counted. Jira refuses each request
 * (403 is never retried), so a request that gets past the license check stops at once.
 */
function handlers(app) {
  const sdk = forgeContract(...Array.from({ length: 3 }, () => ({ status: 403 })));
  const storage = memoryKvs();
  const accesses = [];
  const kvs = new Proxy(storage.kvs, {
    get: (target, name) => {
      const value = target[name];
      return typeof value === 'function'
        ? (...args) => {
            accesses.push(name);
            return value.apply(target, args);
          }
        : value;
    },
  });
  const deps = {
    ...sdk,
    kvs,
    WhereConditions: storage.WhereConditions,
    appContext: () => structuredClone(app),
  };
  return { sdk, storage, accesses, deps };
}

// Each resolver request, and whether it needs a license. Removing stored history stays available.
const requests = [
  ['overview', {}, true],
  ['history', { filterId: '10001' }, true],
  [
    'restore',
    { filterId: '10001', at: 1000, expected: { name: 'Bugs', description: '', jql: 'type = Bug' } },
    true,
  ],
  ['recreate', { filterId: '10001', at: 1000 }, true],
  ['deleteHistory', { filterId: '10001' }, false],
];

test('every resolver request is listed, so a new resolver needs a license decision', () => {
  assert.deepEqual(
    requests.map(([name]) => name).sort(),
    Object.keys(registerResolvers(handlers(states[0][1]).deps)).sort(),
  );
});

test('without a license, history, restore and recreate are refused before any Jira or storage access', async () => {
  for (const [state, app, allowed] of states)
    for (const [name, payload, needsLicense] of requests) {
      const { sdk, accesses, deps } = handlers(app);
      const result = await registerResolvers(deps)[name]({
        context: { accountId: 'viewer' },
        payload,
      });
      const label = `${name} (${state})`;
      if (needsLicense && !allowed) {
        assert.deepEqual(result, { ok: false, error: refusal }, label);
        assert.equal(sdk.calls.length + accesses.length, 0, `${label} reached Jira or storage`);
      } else {
        // Past the license check, the request reaches Jira or storage (the double refuses every
        // Jira request, so it may then fail for another reason).
        assert.notEqual(result.error, refusal, label);
        assert.ok(sdk.calls.length + accesses.length > 0, `${label} stopped before any access`);
      }
    }
});

test('a license in the request context or payload never stands in for the runtime license', async () => {
  const { sdk, accesses, deps } = handlers({ environmentType: 'PRODUCTION' });
  const forged = { accountId: 'viewer', license: { active: true }, environmentType: 'DEVELOPMENT' };
  const { history } = registerResolvers(deps);
  assert.deepEqual(
    await history({ context: forged, payload: { filterId: '10001', license: { active: true } } }),
    { ok: false, error: refusal },
  );
  const rovo = await createRovoAction(deps)(
    { filterId: '10001', license: { active: true } },
    { principal: { accountId: 'viewer' }, license: { active: true } },
  );
  assert.deepEqual(rovo, { ok: false, error: refusal });
  assert.equal(sdk.calls.length + accesses.length, 0);
});

test('the Rovo action refuses an unlicensed read before the visibility check', async () => {
  for (const [state, app, allowed] of states) {
    const { sdk, accesses, deps } = handlers(app);
    const result = await createRovoAction(deps)(
      { filterId: '10001' },
      { principal: { accountId: 'viewer' } },
    );
    if (allowed) assert.notEqual(result.error, refusal, state);
    else {
      assert.deepEqual(result, { ok: false, error: refusal }, state);
      assert.equal(sdk.calls.length + accesses.length, 0, state);
    }
  }
});

test("the event handler never checks the license itself: Forge's manifest filter decides if it runs", async () => {
  const { storage, deps } = handlers({ environmentType: 'PRODUCTION', license: { active: false } });
  await createFilterEventHandler(deps)({
    eventType: 'avi:jira:created:filter',
    atlassianId: 'editor',
    timestamp: '1000',
    filter: { id: '10001', name: 'Bugs', description: '', jql: 'type = Bug', owner: 'owner' },
  });
  assert.equal(storage.data.get('filter:10001').jql, 'type = Bug');
});
