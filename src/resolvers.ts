import { resolveSafely } from './shared/resolver.mjs';
import { isRecord } from './shared/response.mjs';
import { createJira, createStore, type JiraDeps, type StoreDeps } from './integration';
import { requireLicense, type AppLicense } from './license';
import { createService, UserError } from './service';

// Forge passes { context, payload }; anything else fails the context check.
type ResolverRequest = { context?: unknown; payload?: unknown } | null | undefined;

function requireUser(context: unknown) {
  if (!isRecord(context) || typeof context.accountId !== 'string' || !context.accountId.trim())
    throw new UserError('Sign in to Jira to see filter history.');
  return context.accountId;
}

const payloadField = (payload: unknown, field: string) =>
  isRecord(payload) ? payload[field] : undefined;

export function registerResolvers({
  Resolver,
  appContext,
  ...deps
}: JiraDeps &
  StoreDeps & {
    Resolver: typeof import('@forge/resolver').default;
    /** This invocation's environment and license, from the Forge runtime. */
    appContext(): AppLicense;
  }) {
  const service = createService({ jira: createJira(deps), store: createStore(deps) });
  const resolver = new Resolver();
  const define = (
    name: string,
    operation: (payload: unknown, viewer: string) => Promise<unknown>,
    { needsLicense = true } = {},
  ) =>
    resolver.define(name, (request: ResolverRequest) =>
      resolveSafely(
        () => {
          const viewer = requireUser(request?.context);
          if (needsLicense) requireLicense(appContext());
          return operation(request?.payload, viewer);
        },
        (error) => error instanceof UserError,
      ),
    );
  define('overview', (_, viewer) => service.overview(viewer));
  define('history', (payload, viewer) =>
    service.history(payloadField(payload, 'filterId'), viewer),
  );
  define('restore', (payload) => service.restore(payload));
  define('recreate', (payload, viewer) => service.recreate(payload, viewer));
  // Removing stored history stays available without a license; nothing else does.
  define('deleteHistory', (payload) => service.deleteHistory(payloadField(payload, 'filterId')), {
    needsLicense: false,
  });
  return resolver.getDefinitions();
}
