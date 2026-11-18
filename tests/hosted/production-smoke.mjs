// Production smoke for Filter History. Publish runs these checks through config/production-smoke.mjs
// right after the production deploy, against the production installation on an owned site, so a
// release that breaks the overview fails within minutes. Read-only: the overview opens and nothing
// is clicked that writes.
import { expect } from './support/expect.mjs';

export const app = 'filter-history';

// src/license.ts: what the overview shows when the site has no subscription.
const refusal =
  'Filter History for Jira has no active subscription on this site. A site administrator can subscribe in Atlassian Administration.';
// Jira's and Forge's messages for an app page that fails to load.
const errorText = /something went wrong|couldn.t load|problem loading|error loading/i;

const overviewUrl = (site, target) => `${site}/jira/apps/${target.appId}/${target.environmentId}`;

/** Opens Apps → Filter History and waits until it shows the overview or the refusal. */
async function openOverview(page, site, target) {
  // UI Kit renders the page into Jira's own document, as the features journeys read it.
  const search = page.getByRole('textbox', { name: 'Search filters', exact: true });
  const refused = page.getByText(refusal, { exact: true });
  // Forge upgrades the installation shortly after the deploy; reload until the page answers.
  await expect(async () => {
    await page.goto(overviewUrl(site, target), { waitUntil: 'domcontentloaded' });
    await expect(search.or(refused)).toBeVisible({ timeout: 60000 });
  }).toPass({ timeout: 300000, intervals: [15000] });
  return { search, refused };
}

// An installation without a subscription refuses the overview, so the smoke checks that refusal
// and reports unlicensed instead of passed.
export async function state({ page, site, target }) {
  const { refused } = await openOverview(page, site, target);
  return (await refused.isVisible())
    ? { outcome: 'unlicensed', reason: 'no active subscription on the owned site' }
    : null;
}

export const checks = [
  {
    title: 'Overview loads from the Apps menu',
    async run({ page, site, target, state: licensing }) {
      const { search, refused } = await openOverview(page, site, target);
      if (licensing?.outcome === 'unlicensed') {
        // The page loaded and the app answered, with exactly the subscription refusal.
        await expect(refused).toBeVisible();
        await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
        return;
      }
      await expect(search).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Filters', exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: /^Deleted filters \(\d+\+?\)$/ })).toBeVisible();
      // Loaded, not failed: no load error to retry, and no error from Jira or Forge.
      await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
      await expect(page.getByText(errorText).filter({ visible: true })).toHaveCount(0);
    },
  },
];
