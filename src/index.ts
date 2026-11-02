import Resolver from '@forge/resolver';
import api, { route, getAppContext } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { createCleanupHandler, createFilterEventHandler } from './events';
import { registerResolvers } from './resolvers';
import { createRovoAction } from './rovo';

const sdk = { api, route, kvs, WhereConditions };
const appContext = () => {
  const c = getAppContext();
  return { environmentType: c.environmentType, license: c.license };
};
export const handler = registerResolvers({ Resolver, appContext, ...sdk });
// Recording continues without a license, so a lapsed site's history has no gap.
export const filterEvent = createFilterEventHandler(sdk);
// Expiry runs without a license too: it follows the retention period, not the subscription.
export const cleanup = createCleanupHandler(sdk);
export const rovoChanges = createRovoAction({ appContext, ...sdk });
