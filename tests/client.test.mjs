import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEnvelopeReader } from './support/contracts.mjs';
const { readDeleteHistory, readHistory, readOverview, readRecreate, readRestore } =
  await import('../src/client.ts');

const query = { name: 'Bugs', description: '', jql: 'type = Bug', owner: 'owner' };
const flags = { restored: false, recreated: false };

test('overview reader accepts only well-formed rows', () => {
  const row = { filterId: '10001', name: 'Bugs', owner: 'owner', at: 1000, actor: 'editor' };
  const valid = {
    filters: [row],
    partial: false,
    deleted: [{ ...row, canOpen: true }],
    deletedPartial: false,
    admin: false,
  };
  assertEnvelopeReader(readOverview, valid, { filters: [{ ...row, name: 7 }] });
  assert.throws(() => readOverview({ ok: true, value: { ...valid, deleted: [row] } }));
  assert.throws(() => readOverview({ ok: true, value: { ...valid, admin: 'yes' } }));
});

test('history reader accepts only well-formed versions', () => {
  const valid = {
    filter: { id: '10001', ...query, isWritable: true },
    versions: [{ at: 1000, actor: 'editor', ...query, ...flags, changed: ['jql'] }],
    more: false,
    deleted: null,
    admin: false,
  };
  assertEnvelopeReader(readHistory, valid, {
    versions: [{ at: 1000, actor: 'editor', ...query, ...flags, changed: ['sharing'] }],
  });
  for (const change of [
    { more: 'no' },
    { admin: 1 },
    { deleted: { at: 2000 } },
    { versions: [{ ...valid.versions[0], recreated: 'no' }] },
    { versions: [{ ...valid.versions[0], descriptionMissing: false }] },
  ])
    assert.throws(() => readHistory({ ok: true, value: { ...valid, ...change } }));
  readHistory({ ok: true, value: { ...valid, deleted: { at: 2000, actor: 'owner' } } });
  readHistory({
    ok: true,
    value: { ...valid, versions: [{ ...valid.versions[0], descriptionMissing: true }] },
  });
});

test('recreate and delete history readers accept only a confirmed result', () => {
  assertEnvelopeReader(readRecreate, { filterId: '10050' }, { filterId: 10050 });
  assertEnvelopeReader(readDeleteHistory, { deleted: true }, { deleted: false });
});

test('restore reader accepts only a confirmed restore', () => {
  assertEnvelopeReader(readRestore, { restored: true }, { restored: false });
});
