// Guarded recovery of journaled filter fixtures after a hard stop (support/filters.mjs):
//   node tests/hosted/recover-filters.mjs cleanup <run-id>   recovers that run
//   node tests/hosted/recover-filters.mjs settle [step-id]   recovers every unresolved filter run
// A suite runs `settle` after a failed step whose journeys journal filters; the step's run ID it
// appends is not a filter run's and is ignored. Recovery rechecks each filter's owner, marker,
// query and sharing before deleting it, and confirms each deletion. A refusal leaves the journal as
// cleanup-required and exits non-zero.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { activeTarget, siteFor } from '@srcplugins/atlassian-forge-test-framework/core';
import { tokenRequest } from '@srcplugins/atlassian-forge-test-framework/jira';
import { filterRun, unresolvedFilterRuns } from './support/filters.mjs';

const [mode, runId] = process.argv.slice(2);
assert.ok(
  (mode === 'cleanup' && /^[0-9a-f-]{36}$/.test(runId ?? '')) || mode === 'settle',
  'Usage: recover-filters.mjs cleanup <run-id> | settle',
);
assert.equal(activeTarget().host, siteFor('primary'));
const runs = mode === 'cleanup' ? [runId] : unresolvedFilterRuns();
if (!runs.length) console.log('No unresolved filter runs.');
else {
  const request = await tokenRequest();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const contexts = {};
    for (const role of ['member', 'restricted'])
      contexts[role] = await browser.newContext({
        storageState: `${activeTarget().authDirectory}/${role}.json`,
      });
    for (const id of runs) {
      try {
        const filters = await filterRun({ request, contexts, recover: id });
        await filters.cleanup();
        console.log(`Filter run ${id}: clean.`);
      } catch {
        console.error(`Filter run ${id}: cleanup refused; inspect its private journal.`);
        process.exitCode = 1;
      }
    }
  } finally {
    await browser.close();
    await request.dispose();
  }
}
