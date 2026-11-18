// Hosted Rovo acceptance for Filter History on the development installation:
//   FH_ROVO_TESTS=1 node tests/hosted/verify-rovo.mjs run            (a suite step)
//   FH_ROVO_TESTS=1 node tests/hosted/verify-rovo.mjs cleanup <run>  (guarded recovery)
// The administrator asks the Filter History agent what changed in a shared filter whose two
// versions the app recorded, then about the member's private filter: administrators see every
// filter's history, so both answers carry the filter's JQL. The member then asks about the
// administrator's private filter, which Jira hides from them: the answer must carry nothing of it.
// Jira facts (independent reads) prove the visibility and that nothing changed. Filters are journaled fixtures (support/filters.mjs), always cleaned up.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { activeTarget, siteFor } from '@srcplugins/atlassian-forge-test-framework/core';
import { tokenRequest } from '@srcplugins/atlassian-forge-test-framework/jira';
import { askRovo, openRovoChat } from '@srcplugins/atlassian-forge-test-framework/browser';
import { filterRun, jiraCall, journalDirectory, query } from './support/filters.mjs';
import { historyWhen } from './support/app.mjs';
import { expect } from './support/expect.mjs';

const [mode, recoverId] = process.argv.slice(2);
assert.ok(mode === 'run' || (mode === 'cleanup' && /^[0-9a-f-]{36}$/.test(recoverId ?? '')));
assert.equal(process.env.FH_ROVO_TESTS, '1', 'Explicit FH_ROVO_TESTS=1 required');
assert.equal(activeTarget().host, siteFor('primary'));
assert.equal(process.env.PLUGIN_TEST_ENVIRONMENT ?? 'development', 'development');

const agent = 'Filter History for Jira';
const starter = 'What changed in a saved filter?';
const request = await tokenRequest();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = (role) =>
  browser.newContext({
    storageState: `${activeTarget().authDirectory}/${role}.json`,
    viewport: { width: 1440, height: 1100 },
  });
let filters;
const evidence = (name, data) =>
  writeFileSync(
    `${journalDirectory()}/${filters.run.state.runId}-rovo-${name}.json`,
    JSON.stringify(data, null, 2),
    { mode: 0o600 },
  );
try {
  const contexts = { member: await context('member'), restricted: await context('restricted') };
  if (mode === 'cleanup') {
    filters = await filterRun({ request, contexts, recover: recoverId });
    await filters.cleanup();
    console.log(`Rovo run ${recoverId}: clean.`);
  } else {
    filters = await filterRun({
      request,
      contexts,
      runId: process.env.FORGE_TEST_RUN_ID ?? randomUUID(),
      title: 'FH-08 Rovo',
    });
    try {
      const { ids } = filters;
      const admin = await (await context('admin')).newPage();
      const member = await contexts.member.newPage();
      for (const page of [admin, member]) page.setDefaultTimeout(30_000);

      const shared = await filters.filter('admin', {
        name: `FH-08 shared ${filters.short}`,
        jql: filters.jql('a'),
        share: [{ type: 'project', project: { id: ids.projectId } }],
        expectSharing: { share: [`project:${ids.projectId}`], edit: [] },
      });
      const latest = { ...shared.expected.variants[0], jql: filters.jql('b') };
      await filters.update(shared, 'admin', latest);
      const hidden = await filters.filter('member', {
        name: `FH-08 private ${filters.short}`,
        jql: filters.jql('p'),
        expectSharing: { share: [], edit: [] },
      });
      const secret = await filters.filter('admin', {
        name: `FH-08 admin private ${filters.short}`,
        jql: filters.jql('s'),
        expectSharing: { share: [], edit: [] },
      });
      // Jira hides the administrator's private filter from the member.
      expect((await jiraCall(filters.requests.member, `/filter/${secret.id}`)).status).not.toBe(
        200,
      );
      // The app recorded both: the shared filter's two versions, the private filter's first.
      await historyWhen(admin, shared.expected.variants[0].name, (h) =>
        expect(h.versions).toHaveLength(2),
      );
      await historyWhen(member, hidden.expected.variants[0].name, (h) =>
        expect(h.versions).toHaveLength(1),
      );
      await historyWhen(admin, secret.expected.variants[0].name, (h) =>
        expect(h.versions).toHaveLength(1),
      );

      const latestLabel = `fh${filters.short}b`;
      const privateLabel = `fh${filters.short}p`;
      const secretLabel = `fh${filters.short}s`;
      const asked = (id) =>
        `What changed in saved filter ${id}? Quote the JQL of each change exactly.`;
      // Only the installation under test has this filter's history, so its answer picks the agent
      // when the gallery lists the agent of more than one environment.
      await openRovoChat(admin, {
        url: `${activeTarget().site}/jira/your-work`,
        agent,
        starter,
        inventory: { prompt: asked(shared.id), matches: (text) => text.includes(latestLabel) },
      });
      const answer = await askRovo(admin, asked(shared.id));
      evidence('shared', { filterId: shared.id, expected: latestLabel, answer });
      assert.ok(answer.includes(latestLabel), "The answer lacks the filter's latest JQL");

      // Administrators see every filter's history, the member's private filter included.
      const overridden = await askRovo(admin, asked(hidden.id));
      evidence('admin-private', {
        filterId: hidden.id,
        expected: privateLabel,
        answer: overridden,
      });
      assert.ok(
        overridden.includes(privateLabel),
        "The administrator didn't get the private filter",
      );

      // The member asks about the administrator's private filter, which Jira hides from them.
      await openRovoChat(member, {
        url: `${activeTarget().site}/jira/your-work`,
        agent,
        starter,
        inventory: { prompt: asked(shared.id), matches: (text) => text.includes(latestLabel) },
      });
      const refused = await askRovo(member, asked(secret.id));
      evidence('private', { filterId: secret.id, withheld: secretLabel, answer: refused });
      assert.ok(!refused.includes(secretLabel), "The administrator's private filter leaked");
      assert.match(
        refused,
        /\b(?:not available|isn['’]t available|unavailable|not accessible|no access|can(?:no|['’])t (?:see|access|view)|don['’]t have access)\b/i,
      );

      // Read-only: every filter is as the run left them.
      assert.deepEqual(query(await filters.read(shared)), latest);
      assert.deepEqual(query(await filters.read(hidden)), hidden.expected.variants[0]);
      assert.deepEqual(query(await filters.read(secret)), secret.expected.variants[0]);
      filters.run.check(
        "Rovo answered the shared filter and, for the administrator, the member's private filter; it withheld the administrator's private filter from the member",
      );
      filters.run.state.testStatus = 'passed';
      console.log(
        `Rovo ${filters.run.state.runId}: the agent quoted the shared filter's latest JQL and, for the administrator, the member's private filter; it withheld the administrator's private filter from the member; Jira was unchanged.`,
      );
    } catch (error) {
      filters.run.state.testStatus = 'failed';
      writeFileSync(
        `${journalDirectory()}/${filters.run.state.runId}-rovo-error.txt`,
        error instanceof Error ? (error.stack ?? error.message) : 'Unknown failure',
        { mode: 0o600 },
      );
      console.log('Rovo acceptance failed; inspect private evidence.');
      process.exitCode = 1;
    } finally {
      filters.run.persist();
      await filters.cleanup();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Rovo runner stopped');
  process.exitCode = 1;
} finally {
  await browser.close();
  await request.dispose();
}
