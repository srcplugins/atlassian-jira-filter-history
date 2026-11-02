// The Playwright fixture for Filter History's journeys: `filters` opens a journaled filter run
// (support/filters.mjs) with the identity profile's three pinned sessions and always cleans it up,
// also when an assertion failed. `pages.member` and `pages.restricted` are signed-in pages of
// those accounts; the test's own `page` is the administrator's.
import { test as base, expect } from '@srcplugins/atlassian-forge-test-framework/jira';
import { activeTarget } from '@srcplugins/atlassian-forge-test-framework/core';
import { filterRun, journalDirectory } from './filters.mjs';

const sessionContext = (browser, role) =>
  browser.newContext({
    storageState: `${activeTarget().authDirectory}/${role}.json`,
    viewport: { width: 1440, height: 1100 },
  });

export const test = base.extend({
  sessions: async ({ browser }, use) => {
    const contexts = {};
    try {
      for (const role of ['member', 'restricted'])
        contexts[role] = await sessionContext(browser, role);
      await use(contexts);
    } finally {
      for (const context of Object.values(contexts)) await context.close();
    }
  },
  pages: async ({ sessions }, use) => {
    const pages = {};
    for (const [role, context] of Object.entries(sessions)) {
      pages[role] = await context.newPage();
      pages[role].setDefaultTimeout(15_000);
    }
    await use(pages);
  },
  filters: async ({ jiraRequest, sessions, page }, use, info) => {
    const filters = await filterRun({
      request: jiraRequest,
      contexts: sessions,
      title: info.title,
    });
    const started = Date.now();
    try {
      await use(filters);
    } finally {
      filters.run.state.exerciseMs = Date.now() - started;
      filters.run.state.testStatus = info.status;
      filters.run.persist();
      if (info.status !== info.expectedStatus)
        await page
          .screenshot({
            path: `${journalDirectory()}/${filters.run.state.runId}-failure.png`,
          })
          .catch(() => {});
      await filters.cleanup();
    }
  },
});
export { expect };
