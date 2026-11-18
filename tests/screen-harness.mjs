// Renders the real `src/app.tsx` in Node: UI Kit's reconciler sends its tree over a stubbed Forge
// bridge, and the app's resolver calls go to the real service over in-memory storage. Clicks call
// the handlers found in the tree, so a test can click twice before the tree is redrawn, as the
// host can. Focus and announcements happen in the host: hosted journeys check those.
import './support/typescript-loader.mjs';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { memoryKvs } from './support/kvs.mjs';

const pathOf = (url) => (url ? new URL(url).pathname : '');
registerHooks({
  resolve(specifier, context, nextResolve) {
    // The app imports its typed modules without an extension, as Webpack resolves them.
    if (/^\.{1,2}\/[^.]+$/.test(specifier) && pathOf(context.parentURL).endsWith('.tsx'))
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!pathOf(url).endsWith('.tsx')) return nextLoad(url, context);
    const { outputText } = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
      },
    });
    // Node's default import of the CommonJS @forge/react is its exports object; Webpack's is
    // `exports.default`.
    const source = outputText.replace(
      'ForgeReconciler.render(',
      '(ForgeReconciler.default ?? ForgeReconciler).render(',
    );
    return { format: 'module', source, shortCircuit: true };
  },
});

const { createService, UserError } = await import('../src/service.ts');
const { createStore } = await import('../src/integration.ts');
const { resolveSafely } = await import('../src/shared/resolver.mjs');

// The history follows a restore by reloading every 3 seconds; here every few milliseconds.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (run, ms, ...rest) => realSetTimeout(run, ms === 3000 ? 5 : ms, ...rest);
export const settle = (ms = 20) => new Promise((resolve) => realSetTimeout(resolve, ms));

export const filterNow = (filter = {}) => ({
  id: '10001',
  name: 'Bugs',
  description: '',
  jql: 'type = Bug',
  owner: 'owner',
  isWritable: true,
  ...filter,
});
export const event = (at, filter = {}, extra = {}) => ({
  eventType: 'avi:jira:updated:filter',
  atlassianId: 'editor',
  timestamp: at,
  filter: {
    id: '10001',
    name: 'Bugs',
    description: '',
    jql: 'type = Bug',
    owner: 'owner',
    ...filter,
  },
  ...extra,
});

let rendered = 0;
// One bridge for the process, pointed at the screen rendered last. A new screen starts once the
// previous one has gone quiet (a followed restore may still be reloading), so it sends nothing more.
let current;
let drawn = 0;
globalThis.self = globalThis;
globalThis.__bridge = {
  callBridge: (command, data) => {
    if (command === 'reconcile') drawn = Date.now();
    return current(command, data);
  },
};
async function quiet() {
  while (Date.now() - drawn < 150) await settle(25);
}

/** A held resolver answer: the call waits until `release()`. */
export function hold() {
  let release;
  const wait = new Promise((resolve) => (release = resolve));
  return { wait, release };
}

/**
 * Renders the global page (or `extension`) for `viewer`, after `seed` prepares Jira and storage.
 * `holds[resolverKey]` makes the next such call wait for its release.
 */
export async function render({ viewer = 'owner', admin = false, extension, seed } = {}) {
  const storage = memoryKvs();
  const jira = {
    visible: {},
    admin,
    updates: [],
    created: [],
    create: { status: 'applied', id: '30003' },
    async visibleFilters(ids) {
      return new Map(ids.filter((id) => jira.visible[id]).map((id) => [id, jira.visible[id]]));
    },
    async listedFilters(ids) {
      const found = await jira.visibleFilters(ids);
      return new Map([...found].map(([id, { name, owner }]) => [id, { id, name, owner }]));
    },
    async updateFilter(id, query) {
      jira.updates.push([id, query]);
      jira.visible[id] = { ...jira.visible[id], ...query };
      return { status: 'applied' };
    },
    async createFilter(query) {
      jira.created.push(query);
      if (jira.create.status === 'applied')
        jira.visible[jira.create.id] = {
          ...query,
          id: jira.create.id,
          owner: viewer,
          isWritable: true,
        };
      return jira.create;
    },
    async isAdmin() {
      return jira.admin;
    },
    async ownFilters() {
      return [];
    },
  };
  const service = createService({ jira, store: createStore(storage), sleep: () => settle(1) });
  const resolvers = {
    overview: () => service.overview(viewer),
    history: (payload) => service.history(payload.filterId, viewer),
    version: (payload) => service.version(payload, viewer),
    restore: (payload) => service.restore(payload),
    recreate: (payload) => service.recreate(payload, viewer),
    deleteHistory: (payload) => service.deleteHistory(payload.filterId, payload.deleted, viewer),
  };
  const screen = { tree: undefined, calls: [], holds: {} };
  await quiet();
  current = async (command, data) => {
    if (command === 'reconcile') {
      screen.tree = data.forgeDoc;
      return undefined;
    }
    if (command === 'getContext')
      return {
        locale: 'en-US',
        timezone: 'UTC',
        accountId: viewer,
        extension: extension ?? { type: 'jira:globalPage' },
      };
    if (command === 'navigate') return undefined;
    if (command === 'invoke') {
      const { functionKey, payload } = data;
      screen.calls.push({ functionKey, payload });
      const held = screen.holds[functionKey];
      delete screen.holds[functionKey];
      if (held) await held.wait;
      return resolveSafely(
        () => resolvers[functionKey](payload),
        (error) => error instanceof UserError,
      );
    }
    throw Error(`Unexpected bridge call: ${command}`);
  };
  if (seed) await seed({ service, jira, storage });
  await import(`../src/app.tsx?screen=${++rendered}`);
  await settle(40);

  const nodes = (match, node = screen.tree, found = []) => {
    if (!node) return found;
    if (match(node)) found.push(node);
    for (const child of node.children ?? []) nodes(match, child, found);
    return found;
  };
  // A text's strings run together; elements are separated by a space.
  const text = (node) =>
    node.type === 'String'
      ? node.props.text
      : [
          node.props?.title,
          node.props?.header,
          node.props?.description,
          (node.children ?? [])
            .map((child) => (child.type === 'String' ? text(child) : ` ${text(child)} `))
            .join(''),
        ]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
  const buttons = (label) =>
    nodes((node) => /^(Loading)?Button$/.test(node.type) && text(node) === label);
  /** The `index`th button with this label, waiting for it to appear. */
  const button = async (label, index = 0) => {
    for (let tries = 0; tries < 100 && !buttons(label)[index]; tries++) await settle(10);
    const found = buttons(label)[index];
    if (!found) throw Error(`No button "${label}" [${index}] on: ${text(screen.tree)}`);
    return found;
  };
  const click = async (label, index = 0) => {
    (await button(label, index)).props.onClick();
    await settle();
  };
  const shows = (words) => text(screen.tree).includes(words);
  const calls = (key) => screen.calls.filter(({ functionKey }) => functionKey === key);
  return { screen, jira, service, storage, nodes, buttons, button, click, shows, calls };
}
