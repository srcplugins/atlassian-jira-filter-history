// Filter History's surfaces in Jira, driven as a person would, and the app's resolver answers
// observed on the wire. A resolver answer is what the app shows; the journeys still prove every
// Jira fact with their own independent reads.
import { expect } from './expect.mjs';
import { activeTarget } from '@srcplugins/atlassian-forge-test-framework/core';
import { installation } from '@srcplugins/atlassian-forge-test-framework/jira';

const app = 'filter-history';
const target = () => installation(app);

// The Forge invocation request for one resolver function of this installation, or null.
function invocation(request) {
  try {
    const input = request.postDataJSON()?.variables?.input;
    const t = target();
    if (
      typeof input?.payload?.call?.functionKey !== 'string' ||
      input.payload.context?.environmentId !== t.environmentId ||
      !String(input.extensionId ?? '').includes(t.appId)
    )
      return null;
    return input;
  } catch {
    return null;
  }
}

/**
 * Runs `exercise` and returns the envelope (`{ ok, value }` or `{ ok, error }`) of the first
 * `action` resolver answer it causes, successful or not.
 */
export async function answer(page, action, exercise, { timeout = 45_000 } = {}) {
  /** @type {any} The envelope, set by the response predicate. */
  let result;
  const response = page.waitForResponse(
    async (response) => {
      if (invocation(response.request())?.payload.call.functionKey !== action) return false;
      try {
        const body = (await response.json())?.data?.invokeExtension?.response?.body;
        if (typeof body?.ok !== 'boolean') return false;
        result = body;
        return true;
      } catch {
        return false;
      }
    },
    { timeout },
  );
  await Promise.all([response, exercise()]);
  return result;
}

/** As `answer`, for an answer that must succeed; returns its value. */
export async function value(page, action, exercise, options) {
  const result = await answer(page, action, exercise, options);
  if (!result?.ok) throw Error(`Resolver ${action} failed: ${result?.error ?? 'no answer'}`);
  return result.value;
}

/**
 * Sends the page's next `history` request for `filterId` instead of the filter it asked for: the
 * same signed-in call a direct link to that filter's history would make. Returns a function that
 * stops rewriting.
 */
export async function redirectHistory(page, filterId) {
  const handler = async (route) => {
    const request = route.request();
    const input = invocation(request);
    if (input?.payload.call.functionKey !== 'history') return route.fallback();
    const data = request.postDataJSON();
    data.variables.input.payload.call.payload = {
      ...data.variables.input.payload.call.payload,
      filterId,
    };
    await route.continue({ postData: JSON.stringify(data) });
  };
  await page.route('**/gateway/api/graphql/**', handler);
  return () => page.unroute('**/gateway/api/graphql/**', handler);
}

/** Apps → Filter History. Resolves with the overview the app loaded. */
export async function openOverview(page) {
  const t = target();
  return value(page, 'overview', () =>
    page.goto(`${activeTarget().site}/jira/apps/${t.appId}/${t.environmentId}`, {
      waitUntil: 'domcontentloaded',
    }),
  );
}

/**
 * Waits until the overview the app loads passes `check(overview)`, reloading between attempts:
 * Jira delivers filter events a few seconds after the change. Resolves with that overview.
 */
export async function overviewWhen(page, check, { timeout = 120_000 } = {}) {
  /** @type {any} The last observed overview, set inside the retried check. */
  let overview;
  await expect(async () => {
    overview = await openOverview(page);
    check(overview);
  }).toPass({ timeout, intervals: [3000, 5000, 10_000] });
  return overview;
}

/** The overview's Deleted filters tab, opened. */
export async function openDeletedTab(page) {
  await page.getByRole('tab', { name: /^Deleted filters/ }).click();
  return page.getByRole('table', { name: 'Deleted filters, most recently deleted first' });
}

/** The overview's search field, filled with `name`. */
export async function searchOverview(page, name) {
  const field = page.getByRole('textbox', { name: 'Search filters', exact: true });
  await field.fill(name);
  return field;
}

/**
 * Opens one filter's history from the overview, searching by its name. Resolves with the history
 * the app loaded.
 */
async function openFromOverview(page, name) {
  await searchOverview(page, name);
  return value(page, 'history', () =>
    page.getByRole('button', { name, exact: true }).click({ timeout: 10_000 }),
  );
}

/**
 * Waits until the global page shows the filter with `check(history)` passing, reloading the page
 * between attempts: Jira delivers filter events a few seconds after the change.
 */
export async function historyWhen(page, name, check, { timeout = 120_000 } = {}) {
  /** @type {any} The last observed history, set inside the retried check. */
  let history;
  await expect(async () => {
    const overview = await openOverview(page);
    expect(overview.filters.some((row) => row.name === name)).toBe(true);
    history = await openFromOverview(page, name);
    check(history);
  }).toPass({ timeout, intervals: [3000, 5000, 10_000] });
  return history;
}

/** The history table's row for a version, by the version's position (newest first). */
export const versionRows = (page) =>
  page.getByRole('table', { name: 'Versions of this filter, newest first' }).locator('tbody tr');

/**
 * Shows a version's comparison by its position in the history (newest first). The comparison's
 * heading is the version's time, as in the row's first cell.
 */
export async function viewVersion(page, index) {
  const row = versionRows(page).nth(index);
  const time = (await row.locator('td').first().innerText()).trim();
  await row.getByRole('button', { name: 'View', exact: true }).click();
  // Versions saved in the same minute share a time, so more than one heading can match.
  await expect(page.getByRole('heading', { name: time, exact: true }).first()).toBeVisible();
}

/** Jira's issue search with a saved filter (or none), then the app's menu item. */
export async function openSearchAction(page, filterId) {
  const path = filterId ? `/issues/?filter=${filterId}` : '/issues/?jql=';
  await page.goto(`${activeTarget().site}${path}`, { waitUntil: 'domcontentloaded' });
  const item = page.getByRole('menuitem', { name: /^Filter history/ });
  // Jira can paint the Apps button before its menu is ready; opening a menu writes nothing.
  await expect(async () => {
    if (!(await item.isVisible()))
      await page.getByRole('button', { name: 'Apps', exact: true }).last().click();
    await expect(item).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000, intervals: [1000] });
  return item;
}
