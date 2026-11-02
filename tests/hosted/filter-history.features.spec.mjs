// Hosted journeys for Filter History on the development installation: Jira's filter events
// recorded as versions, the global page's overview, history, comparison and restore, the issue
// search modal, and visibility for the identity profile's pinned accounts. Every filter is a
// journaled fixture (support/filters.mjs); Jira facts are proved with independent REST reads as the
// filter's owner or the administrator, and what the app shows with the resolver answers the page
// loaded and the page itself. Jira delivers filter events a few seconds after a change, so the app
// is polled with a bounded wait.
import { test, expect } from './support/fixture.mjs';
import { jiraCall, query, sharing } from './support/filters.mjs';
import {
  answer,
  historyWhen,
  openDeletedTab,
  openOverview,
  openSearchAction,
  overviewWhen,
  redirectHistory,
  searchOverview,
  value,
  versionRows,
  viewVersion,
} from './support/app.mjs';

const unavailable = "This filter isn't available to you.";
const stale = 'The filter changed since you opened it. Review it again.';
// The attribute Jira's table puts on a highlighted row.
const highlighted = 'data-ts--dynamic-table--table-row--highlighted';
// Jira's clock and this machine's may differ a little; versions carry Jira's change time.
const skew = 60_000;

/** An administrator's filter shared with the identity space, editable by the member. */
function sharedFilter(filters, tag, { memberEdits = true } = {}) {
  const { ids } = filters;
  return filters.filter('admin', {
    name: `FH-${tag} shared ${filters.short}`,
    jql: filters.jql('a'),
    share: [{ type: 'project', project: { id: ids.projectId } }],
    edit: memberEdits ? [{ type: 'user', user: { accountId: ids.accounts.member } }] : [],
    expectSharing: {
      share: [`project:${ids.projectId}`],
      edit: memberEdits ? [`user:${ids.accounts.member}`] : [],
    },
  });
}
const nameOf = (entry) => entry.expected.variants[0].name;
const withJql = (filters, entry, tag) => ({ ...entry.expected.variants[0], jql: filters.jql(tag) });
/** The filter as the administrator reads it in Jira, with its sharing. */
async function jiraFilter(filters, entry) {
  const filter = await filters.read(entry, 'admin');
  return { query: query(filter), sharing: sharing(filter) };
}
const jqls = (history) => history.versions.map((version) => version.jql);

test('FH-01 each filter change is a version with its actor and time, in edit order', async ({
  page,
  filters,
}) => {
  const { ids } = filters;
  const filter = await sharedFilter(filters, '01');
  const name = nameOf(filter);

  // The create event is the first recorded version.
  let history = await historyWhen(page, name, (h) => expect(h.versions).toHaveLength(1));
  expect(history.filter).toMatchObject({ id: filter.id, name, jql: filters.jql('a') });
  expect(history.versions[0]).toMatchObject({
    jql: filters.jql('a'),
    actor: ids.accounts.admin,
    owner: ids.accounts.admin,
    changed: [],
    restored: false,
  });
  await expect(versionRows(page)).toHaveCount(1);
  await expect(versionRows(page).first().getByText('First recorded')).toBeVisible();
  const overview = await openOverview(page);
  expect(overview.filters.find((row) => row.filterId === filter.id)).toMatchObject({
    name,
    owner: ids.accounts.admin,
    actor: ids.accounts.admin,
  });

  // The administrator edits the JQL in Jira's own issue search and saves the filter there.
  const edited = withJql(filters, filter, 'b');
  filters.allowQuery(filter, edited);
  await page.goto(`${filters.site}/issues/?filter=${filter.id}`, { waitUntil: 'domcontentloaded' });
  const editor = page.getByRole('combobox', { name: 'JQL query', exact: true });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(edited.jql);
  await page.keyboard.press('Enter');
  const before = Date.now();
  await page.getByRole('button', { name: /^Save filter/ }).click();
  await page.getByRole('menuitem', { name: 'Save changes', exact: true }).click();
  await expect(async () =>
    expect((await jiraFilter(filters, filter)).query).toEqual(edited),
  ).toPass({ timeout: 30_000, intervals: [1000, 2000] });
  const after = Date.now();

  history = await historyWhen(page, name, (h) => expect(h.versions).toHaveLength(2));
  expect(history.versions[0]).toMatchObject({
    jql: edited.jql,
    actor: ids.accounts.admin,
    changed: ['jql'],
  });
  expect(history.versions[0].at).toBeGreaterThan(before - skew);
  expect(history.versions[0].at).toBeLessThan(after + skew);

  // Three JQL edits within about a second: three versions, in edit order.
  const quick = ['c', 'd', 'e'].map((tag) => withJql(filters, filter, tag));
  for (const variant of quick) filters.allowQuery(filter, variant);
  const started = Date.now();
  for (const variant of quick) await filters.update(filter, 'admin', variant);
  const elapsed = Date.now() - started;
  test.info().annotations.push({ type: 'three-edits-ms', description: String(elapsed) });
  expect((await jiraFilter(filters, filter)).query).toEqual(quick[2]);

  history = await historyWhen(page, name, (h) => expect(h.versions).toHaveLength(5));
  expect(jqls(history)).toEqual([...['e', 'd', 'c', 'b', 'a'].map((tag) => filters.jql(tag))]);
  for (const version of history.versions) expect(version.actor).toBe(ids.accounts.admin);
  const times = history.versions.map((version) => version.at);
  expect([...times].sort((a, b) => b - a)).toEqual(times);
  expect(new Set(times).size).toBe(5);
  expect(times[0] - times[2]).toBeLessThanOrEqual(elapsed + 1000);

  // The newest version is shown, and its row highlighted, without choosing it: the label it
  // replaced struck through, the new one in bold, and no restore, since the filter matches it.
  await expect(versionRows(page)).toHaveCount(5);
  await expect(versionRows(page).first().getByText('Current', { exact: true })).toBeVisible();
  await expect(versionRows(page).first()).toHaveAttribute(highlighted, 'true');
  await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible();
  await expect(page.getByText(`fh${filters.short}d`, { exact: true })).toBeVisible();
  await expect(page.getByText(`fh${filters.short}e`, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Current version', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore version' })).toHaveCount(0);

  // An older version is compared with the current filter, with the restore below.
  await viewVersion(page, 1);
  await expect(versionRows(page).nth(1)).toHaveAttribute(highlighted, 'true');
  await expect(versionRows(page).first()).not.toHaveAttribute(highlighted, 'true');
  await expect(
    page.getByRole('heading', { name: 'Compare with current filter', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore version' })).toHaveCount(1);
});

test('FH-02 a sharing change and a save without changes add no version', async ({
  page,
  filters,
}) => {
  const { ids } = filters;
  const filter = await sharedFilter(filters, '02');
  const name = nameOf(filter);
  await historyWhen(page, name, (h) => expect(h.versions).toHaveLength(1));

  // Share the filter with the restricted account as well, then save it unchanged.
  const shared = {
    share: [`project:${ids.projectId}`, `user:${ids.accounts.restricted}`].sort(),
    edit: [`user:${ids.accounts.member}`],
  };
  filters.allowSharing(filter, shared);
  await filters.apis.admin(`/filter/${filter.id}/permission`, 'POST', {
    type: 'user',
    accountId: ids.accounts.restricted,
  });
  expect((await jiraFilter(filters, filter)).sharing).toEqual(shared);
  await filters.update(filter, 'admin', filter.expected.variants[0]);
  // Both events carry the same name, description, JQL and owner as the first version. Give them
  // time to arrive before the next change, so they can't arrive after it.
  await page.waitForTimeout(20_000);
  await historyWhen(page, name, (h) => expect(h.versions).toHaveLength(1));

  // A real change afterwards is the second version: nothing was recorded in between.
  const changed = withJql(filters, filter, 'b');
  await filters.update(filter, 'admin', changed);
  const history = await historyWhen(page, name, (h) => expect(h.versions[0].jql).toBe(changed.jql));
  expect(jqls(history)).toEqual([filters.jql('b'), filters.jql('a')]);
  expect((await jiraFilter(filters, filter)).sharing).toEqual(shared);
});

test('FH-03 a member with an edit share is the actor, restores a version, and a stale restore is refused', async ({
  page,
  pages,
  filters,
}) => {
  const { ids } = filters;
  const filter = await sharedFilter(filters, '03');
  const name = nameOf(filter);
  const sharedWith = {
    share: [`project:${ids.projectId}`],
    edit: [`user:${ids.accounts.member}`],
  };
  await historyWhen(page, name, (h) => expect(h.versions).toHaveLength(1));

  // The member edits the administrator's filter through the edit share.
  const memberEdit = withJql(filters, filter, 'b');
  await filters.update(filter, 'member', memberEdit);
  let history = await historyWhen(pages.member, name, (h) => expect(h.versions).toHaveLength(2));
  expect(history.filter.isWritable).toBe(true);
  expect(history.versions[0]).toMatchObject({
    jql: memberEdit.jql,
    actor: ids.accounts.member,
    owner: ids.accounts.admin,
    changed: ['jql'],
  });

  // The member restores the first version from the global page, after confirming.
  await viewVersion(pages.member, 1);
  const restore = pages.member.getByRole('button', { name: 'Restore version', exact: true });
  await restore.click();
  await expect(pages.member.getByText('Restore version?', { exact: true })).toBeVisible();
  await expect(restore).toHaveCount(1);
  const restored = await value(pages.member, 'restore', () => restore.click());
  expect(restored).toEqual({ restored: true });
  await expect(
    pages.member.getByText('The filter now matches the selected version.', { exact: true }),
  ).toBeVisible();
  // Without a reload, the page lists the restore as the newest version once Jira reports it.
  await expect(versionRows(pages.member)).toHaveCount(3, { timeout: 60_000 });
  await expect(versionRows(pages.member).first().getByText('Restored')).toBeVisible();
  await expect(
    pages.member.getByRole('heading', { name: 'Current version', exact: true }),
  ).toBeVisible();
  // Jira: the first version's name, description and JQL, with sharing and edit rights unchanged.
  expect(await jiraFilter(filters, filter)).toEqual({
    query: filter.expected.variants[0],
    sharing: sharedWith,
  });
  history = await historyWhen(pages.member, name, (h) => expect(h.versions).toHaveLength(3));
  expect(history.versions[0]).toMatchObject({
    jql: filters.jql('a'),
    actor: ids.accounts.member,
    restored: true,
    recreated: false,
    changed: ['jql'],
  });
  await expect(versionRows(pages.member).first().getByText('Restored')).toBeVisible();

  // A stale restore: the member previews version b, then the administrator changes the filter.
  await viewVersion(pages.member, 1);
  const adminEdit = withJql(filters, filter, 'c');
  await filters.update(filter, 'admin', adminEdit);
  expect((await jiraFilter(filters, filter)).query).toEqual(adminEdit);
  await restore.click();
  const refused = await answer(pages.member, 'restore', () => restore.click());
  expect(refused).toEqual({ ok: false, error: stale });
  await expect(pages.member.getByText(stale, { exact: true })).toBeVisible();
  expect(await jiraFilter(filters, filter)).toEqual({ query: adminEdit, sharing: sharedWith });
});

test('FH-04 a user who can see but not edit a filter gets no restore, and Jira refuses a direct update', async ({
  page,
  pages,
  filters,
}) => {
  const { ids } = filters;
  const filter = await sharedFilter(filters, '04');
  const name = nameOf(filter);
  const changed = withJql(filters, filter, 'b');
  await historyWhen(page, name, (h) => expect(h.versions).toHaveLength(1));
  await filters.update(filter, 'admin', changed);

  const history = await historyWhen(pages.restricted, name, (h) =>
    expect(h.versions).toHaveLength(2),
  );
  expect(history.filter).toMatchObject({ id: filter.id, isWritable: false });
  await viewVersion(pages.restricted, 1);
  await expect(
    pages.restricted.getByText("You can't edit this filter, so you can't restore it.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(pages.restricted.getByRole('button', { name: 'Restore version' })).toHaveCount(0);

  // Jira itself refuses the restricted account's update and the filter stays as it was.
  const first = filter.expected.variants[0];
  const refused = await jiraCall(filters.requests.restricted, `/filter/${filter.id}`, 'PUT', first);
  expect([400, 401, 403]).toContain(refused.status);
  // Jira's JSON refusal, not the XSRF page that answers before any permission check.
  expect(refused.body?.errorMessages?.length).toBeGreaterThan(0);
  expect(await jiraFilter(filters, filter)).toEqual({
    query: changed,
    sharing: { share: [`project:${ids.projectId}`], edit: [`user:${ids.accounts.member}`] },
  });
});

test("FH-05 a member's private filter and its history are hidden from the administrator and the restricted user", async ({
  page,
  pages,
  filters,
}) => {
  const { ids } = filters;
  const visible = await sharedFilter(filters, '05', { memberEdits: false });
  const hidden = await filters.filter('member', {
    name: `FH-05 private ${filters.short}`,
    jql: filters.jql('p'),
    expectSharing: { share: [], edit: [] },
  });
  const hiddenName = nameOf(hidden);

  // The member sees the private filter's history.
  const own = await historyWhen(pages.member, hiddenName, (h) =>
    expect(h.versions).toHaveLength(1),
  );
  expect(own.versions[0]).toMatchObject({
    jql: filters.jql('p'),
    actor: ids.accounts.member,
    owner: ids.accounts.member,
  });

  for (const [role, viewer] of [
    ['admin', page],
    ['restricted', pages.restricted],
  ]) {
    // Jira hides the filter from them.
    const read = await jiraCall(filters.requests[role], `/filter/${hidden.id}`);
    expect(read.status, role).not.toBe(200);
    // The overview leaves it out, while their own visible filter is listed.
    await historyWhen(viewer, nameOf(visible), (h) => expect(h.versions).toHaveLength(1));
    const overview = await openOverview(viewer);
    expect(
      overview.filters.some((row) => row.filterId === hidden.id),
      role,
    ).toBe(false);
    await searchOverview(viewer, hiddenName);
    await expect(viewer.getByText('No filter matches that name.', { exact: true })).toBeVisible();
    // A direct request for its history is refused with the same answer as for any hidden filter.
    await searchOverview(viewer, nameOf(visible));
    const stop = await redirectHistory(viewer, hidden.id);
    try {
      const result = await answer(viewer, 'history', () =>
        viewer.getByRole('button', { name: nameOf(visible), exact: true }).click(),
      );
      expect(result, role).toEqual({ ok: false, error: unavailable });
      await expect(viewer.getByText(unavailable, { exact: true })).toBeVisible();
    } finally {
      await stop();
    }
  }
});

test("FH-06 Jira's issue search opens the saved filter's history; without one it asks for a saved filter", async ({
  page,
  filters,
}) => {
  const filter = await sharedFilter(filters, '06');
  const name = nameOf(filter);
  await historyWhen(page, name, (h) => expect(h.versions).toHaveLength(1));
  await filters.update(filter, 'admin', withJql(filters, filter, 'b'));
  await historyWhen(page, name, (h) => expect(h.versions).toHaveLength(2));

  const item = await openSearchAction(page, filter.id);
  const history = await value(page, 'history', () => item.click());
  expect(history.filter).toMatchObject({ id: filter.id, name, jql: filters.jql('b') });
  expect(jqls(history)).toEqual([filters.jql('b'), filters.jql('a')]);
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(versionRows(modal)).toHaveCount(2);

  const none = await openSearchAction(page);
  await none.click();
  await expect(
    page
      .getByRole('dialog')
      .getByText("Open a saved filter in Jira's search to see its history.", { exact: true }),
  ).toBeVisible();
});

test("FH-07 a deleted filter's history stays for its owner, who recreates it; an administrator deletes histories", async ({
  page,
  pages,
  filters,
}) => {
  const { ids } = filters;
  const member = pages.member;
  const privateFilter = (tag) =>
    filters.filter('member', {
      name: `FH-07 ${tag} ${filters.short}`,
      jql: filters.jql(tag),
      expectSharing: { share: [], edit: [] },
    });
  const owned = await privateFilter('o');
  const gone = await privateFilter('g');
  const live = await sharedFilter(filters, '07');
  const first = owned.expected.variants[0];
  const second = withJql(filters, owned, 'p');
  await historyWhen(member, nameOf(owned), (h) => expect(h.versions).toHaveLength(1));
  await filters.update(owned, 'member', second);
  await historyWhen(member, nameOf(owned), (h) => expect(h.versions).toHaveLength(2));
  await historyWhen(member, nameOf(gone), (h) => expect(h.versions).toHaveLength(1));
  await historyWhen(page, nameOf(live), (h) => expect(h.versions).toHaveLength(1));

  // The member deletes both private filters in Jira; the journal confirms Jira no longer has them.
  await filters.remove(owned);
  await filters.remove(gone);
  const row = (entry) => (overview) => overview.deleted.find((r) => r.filterId === entry.id);
  let overview = await overviewWhen(member, (o) => {
    expect(row(owned)(o)).toMatchObject({ name: nameOf(owned), owner: ids.accounts.member });
    expect(row(gone)(o)).toBeTruthy();
  });
  expect(row(owned)(overview)).toMatchObject({ actor: ids.accounts.member, canOpen: true });
  expect(overview.filters.some((r) => r.filterId === owned.id)).toBe(false);

  // The administrator sees both listed, without a way into their history; the restricted user
  // sees neither, and a direct request for the history is refused to both.
  overview = await openOverview(page);
  expect(overview.admin).toBe(true);
  expect(row(owned)(overview)).toMatchObject({ canOpen: false, owner: ids.accounts.member });
  const table = await openDeletedTab(page);
  await searchOverview(page, nameOf(owned));
  await expect(table.getByText(nameOf(owned), { exact: true })).toBeVisible();
  await expect(table.getByRole('button', { name: nameOf(owned) })).toHaveCount(0);
  const restricted = await openOverview(pages.restricted);
  expect(restricted.admin).toBe(false);
  expect(row(owned)(restricted)).toBeUndefined();
  for (const viewer of [page, pages.restricted]) {
    await openOverview(viewer);
    await searchOverview(viewer, nameOf(live));
    const stop = await redirectHistory(viewer, owned.id);
    try {
      const result = await answer(viewer, 'history', () =>
        viewer.getByRole('button', { name: nameOf(live), exact: true }).click(),
      );
      expect(result).toEqual({ ok: false, error: unavailable });
    } finally {
      await stop();
    }
  }

  // The administrator deletes the other deleted filter's history from the list.
  await openOverview(page);
  await openDeletedTab(page);
  await searchOverview(page, nameOf(gone));
  // The search filters the rows after a moment, so the row is found by its name.
  await table
    .locator('tbody tr')
    .filter({ hasText: nameOf(gone) })
    .getByRole('button', { name: 'Delete history', exact: true })
    .click();
  await expect(
    page.getByText(`Delete history for “${nameOf(gone)}”?`, { exact: true }),
  ).toBeVisible();
  const purged = await value(page, 'deleteHistory', () =>
    page.getByRole('button', { name: 'Delete history', exact: true }).first().click(),
  );
  expect(purged).toEqual({ deleted: true });
  await expect(
    page.getByText(`History for “${nameOf(gone)}” deleted.`, { exact: true }),
  ).toBeVisible();
  overview = await openOverview(member);
  expect(row(gone)(overview)).toBeUndefined();
  expect(row(owned)(overview)).toBeTruthy();

  // The member opens the deleted filter's history: read-only, marked deleted.
  await openDeletedTab(member);
  await searchOverview(member, nameOf(owned));
  const history = await value(member, 'history', () =>
    member.getByRole('button', { name: nameOf(owned), exact: true }).click(),
  );
  expect(history.deleted).toMatchObject({ actor: ids.accounts.member });
  expect(history.filter).toMatchObject({ id: owned.id, isWritable: false, jql: second.jql });
  expect(jqls(history)).toEqual([second.jql, first.jql]);
  await expect(member.getByText('This filter was deleted', { exact: true })).toBeVisible();
  await expect(member.getByText('Deleted', { exact: true })).toBeVisible();
  await expect(member.getByRole('button', { name: 'Restore version' })).toHaveCount(0);

  // The member recreates it from the first version: a new filter, private to the member.
  await viewVersion(member, 1);
  await expect(
    member.getByRole('heading', { name: 'Recreate the filter from this version', exact: true }),
  ).toBeVisible();
  await member.getByRole('button', { name: 'Recreate filter', exact: true }).click();
  await expect(member.getByText('Recreate this filter?', { exact: true })).toBeVisible();
  const recreated = await filters.recreated(owned, first, async () => {
    const result = await value(member, 'recreate', () =>
      member.getByRole('button', { name: 'Recreate filter', exact: true }).click(),
    );
    return result.filterId;
  });
  expect(recreated.id).not.toBe(owned.id);
  // Private: the owner reads it, the administrator doesn't see it.
  const hidden = await jiraCall(filters.requests.admin, `/filter/${recreated.id}`);
  expect(hidden.status).not.toBe(200);
  const own = await filters.read(recreated);
  expect(query(own)).toEqual(first);
  expect(sharing(own)).toEqual({ share: [], edit: [] });
  await expect(member.getByText('Recreated', { exact: true }).first()).toBeVisible();
  // Without a reload, the page lists the recreate as the newest version once Jira reports it.
  await expect(versionRows(member)).toHaveCount(3, { timeout: 60_000 });
  await expect(versionRows(member).first().getByText('Recreated', { exact: true })).toBeVisible();

  // Its history carries on: Jira's create event from the app's write is marked recreated.
  const moved = await historyWhen(member, nameOf(owned), (h) => {
    expect(h.filter.id).toBe(recreated.id);
    expect(h.versions).toHaveLength(3);
  });
  expect(moved.deleted).toBeNull();
  expect(moved.versions[0]).toMatchObject({
    jql: first.jql,
    actor: ids.accounts.member,
    recreated: true,
    restored: false,
    changed: ['jql'],
  });
  expect(jqls(moved)).toEqual([first.jql, second.jql, first.jql]);
  expect(row(owned)(await openOverview(member))).toBeUndefined();

  // A member gets no Delete history; the administrator deletes a live filter's history, and Jira
  // keeps the filter as it was.
  const shared = await historyWhen(member, nameOf(live), (h) => expect(h.versions).toHaveLength(1));
  expect(shared.admin).toBe(false);
  await expect(member.getByRole('button', { name: 'Delete history' })).toHaveCount(0);
  const before = await jiraFilter(filters, live);
  const adminView = await historyWhen(page, nameOf(live), (h) =>
    expect(h.versions).toHaveLength(1),
  );
  expect(adminView.admin).toBe(true);
  await page.getByRole('button', { name: 'Delete history', exact: true }).click();
  await expect(
    page.getByText(`Delete history for “${nameOf(live)}”?`, { exact: true }),
  ).toBeVisible();
  expect(
    await value(page, 'deleteHistory', () =>
      page.getByRole('button', { name: 'Delete history', exact: true }).click(),
    ),
  ).toEqual({ deleted: true });
  await expect(page.getByText('History deleted.', { exact: true })).toBeVisible();
  await expect(page.getByText('No changes recorded yet', { exact: true })).toBeVisible();
  expect(await jiraFilter(filters, live)).toEqual(before);
  overview = await openOverview(page);
  expect(overview.filters.some((r) => r.filterId === live.id)).toBe(false);
});
