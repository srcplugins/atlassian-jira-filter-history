import test from 'node:test';
import assert from 'node:assert/strict';
import { event, filterNow, hold, render, settle } from './screen-harness.mjs';

/** Bugs with two versions: JQL "old" at 1000, then "type = Bug" at 2000. */
const twoVersions = async ({ service, jira }) => {
  jira.visible = { 10001: filterNow() };
  await service.record(event(1000, { jql: 'old' }));
  await service.record(event(2000));
};
/** The same filter, then deleted by its owner. */
const deletedFilter = async ({ service, jira }) => {
  await twoVersions({ service, jira });
  await service.record({
    ...event(3000),
    eventType: 'avi:jira:deleted:filter',
    atlassianId: 'owner',
  });
  jira.visible = {};
};
const disabled = (nodes) => nodes.map((node) => Boolean(node.props.isDisabled));

test('a restore confirmed twice before the screen redraws is sent once; the screen waits for it', async () => {
  const page = await render({ seed: twoVersions });
  await page.click('Bugs');
  await page.click('View', 1);
  await page.click('Restore version');
  const held = hold();
  page.screen.holds.restore = held;
  const confirm = await page.button('Restore version');
  confirm.props.onClick();
  confirm.props.onClick();
  await settle();
  assert.equal(page.calls('restore').length, 1);
  // While it runs, nothing else on the screen can start: its answer stays where it was asked.
  assert.deepEqual(disabled(page.buttons('View')), [true, true]);
  assert.deepEqual(disabled(page.buttons('← All filters')), [true]);
  assert.deepEqual(disabled(page.buttons('Cancel')), [true]);
  held.release();
  await settle(60);
  assert.equal(page.jira.updates.length, 1);
  assert.ok(page.shows('The filter now matches the selected version.'));
  assert.deepEqual(disabled(page.buttons('View')), [false, false]);
});

test('a recreate confirmed twice is sent once, Back waits for it, and focus moves to the new filter', async () => {
  const page = await render({ seed: deletedFilter });
  await page.click('Bugs');
  await page.click('Recreate filter');
  const held = hold();
  page.screen.holds.recreate = held;
  const confirm = await page.button('Recreate filter');
  confirm.props.onClick();
  confirm.props.onClick();
  await settle();
  assert.equal(page.calls('recreate').length, 1);
  assert.deepEqual(disabled(page.buttons('← All filters')), [true]);
  held.release();
  await settle(60);
  assert.equal(page.jira.created.length, 1);
  const open = await page.button('Open in Jira’s search'.replace('’', "'"));
  assert.equal(open.props.autoFocus, true);
  assert.ok(page.shows('is a new private filter in Jira'));
});

test('Delete history sends what was confirmed; a filter deleted meanwhile is refused and kept', async () => {
  const page = await render({ viewer: 'admin', admin: true, seed: twoVersions });
  await page.click('Bugs');
  await page.click('Delete history');
  // Jira deletes the filter after the administrator read "The filter in Jira isn't changed".
  await page.service.record({
    ...event(3000),
    eventType: 'avi:jira:deleted:filter',
    atlassianId: 'owner',
  });
  page.jira.visible = {};
  await page.click('Delete history');
  await settle(40);
  assert.deepEqual(
    page.calls('deleteHistory').map(({ payload }) => payload),
    [{ filterId: '10001', deleted: false }],
  );
  assert.ok(page.shows('was deleted in Jira since you opened it'));
  assert.equal((await page.service.history('10001', 'owner')).versions.length, 2);
});

test("deleting a filter's history moves focus to Back, and a deleted filter's goes back to the list saying so", async () => {
  const visible = await render({ viewer: 'admin', admin: true, seed: twoVersions });
  await visible.click('Bugs');
  await visible.click('Delete history');
  await visible.click('Delete history');
  await settle(40);
  assert.ok(visible.shows('History deleted.'));
  assert.equal((await visible.button('← All filters')).props.autoFocus, true);

  const deleted = await render({ viewer: 'admin', admin: true, seed: deletedFilter });
  await deleted.click('Bugs');
  await deleted.click('Delete history');
  await deleted.click('Delete history');
  await settle(40);
  assert.deepEqual(deleted.calls('deleteHistory').at(-1).payload, {
    filterId: '10001',
    deleted: true,
  });
  assert.ok(deleted.shows('History for “Bugs” deleted.'));
  const [search] = deleted.nodes((node) => node.type === 'Textfield');
  assert.equal(search.props.autoFocus, true);
});

test("Cancel in the deleted filters list gives focus back to that row's Delete history", async () => {
  const page = await render({ viewer: 'admin', admin: true, seed: deletedFilter });
  const row = await page.button('Delete history');
  assert.notEqual(row.props.autoFocus, true);
  await page.click('Delete history');
  await page.click('Cancel');
  assert.equal((await page.button('Delete history')).props.autoFocus, true);
});

test("a second restore before the first is listed waits for both, and only the viewer's own", async () => {
  const page = await render({ seed: twoVersions });
  await page.click('Bugs');
  await page.click('View', 1);
  await page.click('Restore version');
  await page.click('Restore version');
  // Before Jira reports it, the viewer restores the version they replaced.
  await page.click('View', 0);
  await page.click('Restore version');
  await page.click('Restore version');
  assert.equal(page.jira.updates.length, 2);
  const restored = (at, jql, atlassianId = 'owner') =>
    page.service.record(event(at, { jql }, { atlassianId, selfGenerated: true }));
  // Someone else's restore, then the viewer's first: one of the viewer's two is listed.
  await restored(2500, 'other', 'someone else');
  await restored(3000, 'old');
  await settle(30);
  assert.ok(page.shows('Adding the new version to the history'));
  await restored(4000, 'type = Bug');
  await settle(60);
  assert.ok(!page.shows('Adding the new version to the history'));
  assert.ok(page.shows('The filter now matches the selected version.'));
});

test('a history that answers as the recreated filter is reloaded under its new ID', async () => {
  const page = await render({
    extension: { type: 'jira:issueNavigatorAction', filterId: '10001' },
    seed: async (setup) => {
      await deletedFilter(setup);
      // A recreate stopped before the history moved: the next open finishes it.
      setup.storage.failNext('transact', 'version:30003:');
      await setup.service.recreate({ filterId: '10001', at: 2000 }, 'owner').catch(() => undefined);
    },
  });
  await settle(40);
  assert.deepEqual(
    page.calls('history').map(({ payload }) => payload.filterId),
    ['10001', '30003'],
  );
  // Restoring from here acts on the recreated filter, whose history now loads.
  await page.click('View', 1);
  await page.click('Restore version');
  await page.click('Restore version');
  assert.deepEqual(page.calls('restore')[0].payload.filterId, '30003');
  assert.ok(page.shows('The filter now matches the selected version.'));
});
