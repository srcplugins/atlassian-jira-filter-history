import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeContract } from './support/forge-contract.mjs';
import { assertRovoReadContract } from './support/contracts.mjs';
import { memoryKvs } from './support/kvs.mjs';
const { createRovoAction } = await import('../src/rovo.ts');
const { createFilterEventHandler } = await import('../src/events.ts');

const withStorage = (sdk, storage = memoryKvs()) => ({
  ...sdk,
  kvs: storage.kvs,
  WhereConditions: storage.WhereConditions,
  appContext: () => ({ environmentType: 'DEVELOPMENT' }),
});

test('Rovo read meets the shared identity, validation and redaction contract', () =>
  assertRovoReadContract((sdk) => createRovoAction(withStorage(sdk)), { filterId: '10001' }));

test('Rovo read checks the viewer can see the filter, then returns its recorded changes', async () => {
  const storage = memoryKvs();
  const sdk = forgeContract(
    {
      expect: { method: 'GET', path: '/rest/api/3/mypermissions?permissions=ADMINISTER' },
      body: { permissions: { ADMINISTER: { key: 'ADMINISTER', havePermission: false } } },
    },
    {
      body: {
        isLast: true,
        values: [
          {
            id: '10001',
            name: 'Bugs',
            description: '',
            jql: 'type = Bug',
            owner: { accountId: 'owner' },
            isWritable: false,
          },
        ],
      },
    },
  );
  const deps = withStorage(sdk, storage);
  await createFilterEventHandler(deps)({
    eventType: 'avi:jira:created:filter',
    atlassianId: 'editor',
    timestamp: 1000,
    filter: { id: '10001', name: 'Bugs', description: '', jql: 'type = Bug', owner: 'owner' },
  });
  const result = await createRovoAction(deps)(
    { filterId: '10001' },
    { principal: { accountId: 'trusted' } },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.filter, { id: '10001', name: 'Bugs' });
  assert.equal(result.value.changes.length, 1);
  assert.equal(result.value.historyDeleted, null);
  assert.match(result.value.note, /untrusted data/);
  assert.equal(sdk.calls.length, 2);
  assert.ok(sdk.calls.every(({ actor }) => actor === 'asUser'));
  assert.match(sdk.calls[1].path, /^\/rest\/api\/3\/filter\/search\?id=10001&/);
  assert.doesNotMatch(sdk.calls[1].path, /overrideSharePermissions/);
});

/** A Rovo read of a recorded private filter, with Jira answering the search as `found`. */
async function readAs({ admin, found }) {
  const filter = {
    id: '10002',
    name: 'Private',
    description: '',
    jql: 'labels = secret',
    owner: { accountId: 'member' },
    isWritable: false,
  };
  const sdk = forgeContract(
    {
      expect: { method: 'GET', path: '/rest/api/3/mypermissions?permissions=ADMINISTER' },
      body: { permissions: { ADMINISTER: { key: 'ADMINISTER', havePermission: admin } } },
    },
    { body: { isLast: true, values: found ? [filter] : [] } },
  );
  const deps = withStorage(sdk);
  await createFilterEventHandler(deps)({
    eventType: 'avi:jira:created:filter',
    atlassianId: 'member',
    timestamp: '1000',
    filter: { ...filter, owner: 'member' },
  });
  const result = await createRovoAction(deps)(
    { filterId: '10002' },
    { principal: { accountId: 'viewer' } },
  );
  return { result, search: sdk.calls[1].path };
}

test("Rovo gives an administrator a member's private filter, through Jira's override", async () => {
  const { result, search } = await readAs({ admin: true, found: true });
  assert.match(search, /overrideSharePermissions=true/);
  assert.equal(result.ok, true);
  assert.equal(result.value.changes[0].after.jql, 'labels = secret');
});

test('Rovo refuses a filter Jira hides from a non-administrator, without any of its content', async () => {
  const { result, search } = await readAs({ admin: false, found: false });
  assert.doesNotMatch(search, /overrideSharePermissions/);
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /isn't available to you/);
  assert.doesNotMatch(JSON.stringify(result), /secret|Private/);
});
