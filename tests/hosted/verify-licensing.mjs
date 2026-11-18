// License states on the isolation site's development installation, installed fresh for each state
// with `forge install -e development --license <state>` (no `--license` for `none`). The runtime
// license decides, never one the browser sends: without it, the overview, histories, versions,
// restore and recreate are refused, and Delete history isn't. Read-only: the overview loads, and
// its own call is sent again to the other resolvers with payloads that name no filter, so nothing
// in Jira or app storage changes. Rovo chat isn't available on the isolation site, so the Rovo
// action's refusal is covered by tests/license.test.mjs only.
//   FH_LICENSING_TESTS=1 JIRA_SITE=<isolation site> PLUGIN_TEST_SITE=<isolation site> \
//     node tests/hosted/verify-licensing.mjs inactive|trial|active|none
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import {
  activeEnvironment,
  activeTarget,
  siteFor,
} from '@srcplugins/atlassian-forge-test-framework/core';
import { installation } from '@srcplugins/atlassian-forge-test-framework/jira';
import { expect } from './support/expect.mjs';

// src/license.ts
const refusal =
  'Filter History for Jira has no active subscription on this site. A site administrator can subscribe in Atlassian Administration.';
const states = { inactive: false, trial: true, active: true, none: true };
const [mode] = process.argv.slice(2);
assert.equal(process.env.FH_LICENSING_TESTS, '1', 'Explicit licensing run required');
assert.ok(Object.hasOwn(states, mode), 'Usage: verify-licensing.mjs inactive|trial|active|none');
// Every state needs its own installation, so this runs only where development installations may
// be removed: the isolation site, never the primary.
assert.equal(activeEnvironment(), 'development');
assert.equal(activeTarget().host, siteFor('isolation'));
assert.equal(process.env.JIRA_SITE, siteFor('isolation'));

const licensed = states[mode];
const installed = installation('filter-history');
// The test configuration names the environment; the Forge app ID is the manifest's.
const target = {
  ...installed,
  appId: readFileSync('manifest.yml', 'utf8').match(/app\/([0-9a-f-]{36})/)?.[1],
};
assert.ok(target.appId, 'manifest.yml names the Forge app');
const directory = `${activeTarget().directory}/filter-history-licensing`;
mkdirSync(directory, { recursive: true, mode: 0o700 });
const evidence = { mode, at: new Date().toISOString(), checks: [] };
const check = (name, value) => evidence.checks.push({ name, ...value });
// No filter has this ID (Jira's are far smaller), so a licensed call finds nothing to read,
// change or delete.
const absent = '999999999';

/** The resolver envelope in a GraphQL reply, wherever Forge nests it. */
function envelope(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.ok === 'boolean' && ('value' in value || 'error' in value)) return value;
  for (const child of Object.values(value)) {
    const found = typeof child === 'string' ? parse(child) : envelope(child);
    if (found) return found;
  }
  return null;
}
function parse(text) {
  try {
    return envelope(JSON.parse(text));
  } catch {
    return null;
  }
}
const ours = (input, action) =>
  input?.payload?.call?.functionKey === action &&
  input.payload.context?.environmentId === target.environmentId &&
  String(input.extensionId ?? '').includes(target.appId);

/** Runs `exercise` and returns this installation's first `action` call and its reply envelope. */
async function capture(page, action, exercise) {
  /** @type {{ url: string, headers: Record<string, string>, body: any, result: any } | undefined} */
  let call;
  const reply = page.waitForResponse(
    async (response) => {
      try {
        const body = response.request().postDataJSON();
        if (!ours(body?.variables?.input, action)) return false;
        call = {
          url: response.request().url(),
          headers: response.request().headers(),
          body,
          result: envelope(await response.json()),
        };
        return true;
      } catch {
        return false;
      }
    },
    { timeout: 60_000 },
  );
  await Promise.all([reply, exercise()]);
  assert.ok(call, `No ${action} call`);
  return call;
}

/** Sends a captured call again as `functionKey` with `payload`, from the same page and session. */
async function invoke(page, call, functionKey, payload, context = {}) {
  const body = structuredClone(call.body);
  const input = body.variables.input.payload;
  input.call.functionKey = functionKey;
  input.call.payload = payload;
  Object.assign(input.context, context);
  const headers = Object.fromEntries(
    Object.entries(call.headers).filter(
      ([name]) => !['content-length', 'cookie', 'host'].includes(name.toLowerCase()),
    ),
  );
  const response = await page.request.post(call.url, { headers, data: body });
  return envelope(await response.json());
}

/** The resolver is refused for the license exactly when this state has none. */
function gated(name, result) {
  assert.ok(result, `${name}: no resolver reply`);
  if (licensed) assert.notEqual(result.error, refusal, `${name} was refused while licensed`);
  else assert.deepEqual(result, { ok: false, error: refusal }, `${name} was not refused`);
  check(name, { result: result.ok ? 'ok' : result.error });
}
/** The resolver works with or without a license. */
function kept(name, result) {
  assert.ok(result, `${name}: no resolver reply`);
  assert.notEqual(result.error, refusal, `${name} was refused for the license`);
  check(name, { result: result.ok ? 'ok' : result.error });
}

let browser;
let passed = false;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  // The administrator is one Atlassian account on both owned sites, and its daily-renewed session
  // on the primary site signs it in here too; the isolation site's own is signed in by hand.
  const context = await browser.newContext({
    storageState: `${activeTarget().authDirectory.replace(siteFor('isolation'), siteFor('primary'))}/admin.json`,
    viewport: { width: 1440, height: 1100 },
  });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();

  // Apps → Filter History: the overview loads, or shows the refusal with Try again.
  const overview = await capture(page, 'overview', () =>
    page.goto(`${activeTarget().site}/jira/apps/${target.appId}/${target.environmentId}`, {
      waitUntil: 'domcontentloaded',
    }),
  );
  gated('overview', overview.result);
  if (licensed) {
    await expect(page.getByRole('textbox', { name: 'Search filters', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(refusal, { exact: true })).toHaveCount(0);
  } else {
    await expect(page.getByText(refusal, { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Search filters', exact: true })).toHaveCount(0);
  }
  check('overview page', { refusalShown: !licensed });
  await page.screenshot({ path: `${directory}/${mode}-overview.png`, fullPage: true });

  // The overview's own call, sent again to each resolver. None of these names a filter that exists.
  gated('history', await invoke(page, overview, 'history', { filterId: absent }));
  gated('version', await invoke(page, overview, 'version', { filterId: absent, at: 1 }));
  // A license the browser adds to its request context changes nothing.
  gated(
    'overview (forged license in the request context)',
    await invoke(
      page,
      overview,
      'overview',
      {},
      { license: { active: true, isActive: true }, environmentType: 'DEVELOPMENT' },
    ),
  );
  // The writes are sent only where the license refuses them before anything runs.
  if (!licensed) {
    gated('restore', await invoke(page, overview, 'restore', { filterId: absent }));
    gated('recreate', await invoke(page, overview, 'recreate', { filterId: absent }));
  }
  kept(
    'deleteHistory',
    await invoke(page, overview, 'deleteHistory', { filterId: absent, deleted: true }),
  );
  passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : 'Unknown failure';
  process.exitCode = 1;
} finally {
  await browser?.close();
  evidence.passed = passed;
  writeFileSync(`${directory}/${mode}.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(
    `Licensing ${mode}: ${passed ? 'passed' : 'failed'}, ${evidence.checks.length} checks.${evidence.error ? ` ${evidence.error}` : ''}`,
  );
  for (const c of evidence.checks) console.log(` - ${c.name}: ${c.result ?? JSON.stringify(c)}`);
}
