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
// Without an active license Forge skips recording (`appIsLicensed` in the manifest), so a lapsed site's history has a gap.
export const filterEvent = createFilterEventHandler(sdk);
// Expiry is skipped without an active license too, and resumes with it.
export const cleanup = createCleanupHandler(sdk);
export const rovoChanges = createRovoAction({ appContext, ...sdk });
