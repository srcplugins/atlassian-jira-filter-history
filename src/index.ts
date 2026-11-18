import Resolver from '@forge/resolver';
import api, { route, getAppContext, privacy } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import {
  createCleanupHandler,
  createFilterEventHandler,
  createPrivacyReportHandler,
} from './events';
import { registerResolvers } from './resolvers';
import { createRovoAction } from './rovo';

const sdk = { api, route, kvs, WhereConditions };
const appContext = () => {
  const c = getAppContext();
  return { environmentType: c.environmentType, license: c.license };
};
export const handler = registerResolvers({ Resolver, appContext, ...sdk });
// Without an active license Forge skips recording (`appIsLicensed` in the manifest), so a lapsed
// site's history has a gap.
export const filterEvent = createFilterEventHandler(sdk);
// Housekeeping runs with or without a license, touching app storage only: deleted filters' history
// expires on time, and stored account IDs are reported each week and erased once closed.
export const cleanup = createCleanupHandler(sdk);
export const privacyReport = createPrivacyReportHandler({ ...sdk, privacy });
export const rovoChanges = createRovoAction({ appContext, ...sdk });
