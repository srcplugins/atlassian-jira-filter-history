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
  const sdk = forgeContract({
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
  });
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
  assert.match(result.value.note, /untrusted data/);
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0].actor, 'asUser');
  assert.match(sdk.calls[0].path, /^\/rest\/api\/3\/filter\/search\?id=10001&/);
});
