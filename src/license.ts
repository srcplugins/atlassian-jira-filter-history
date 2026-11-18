import { licensed } from './shared/license.mjs';
import { UserError } from './service';

/** The invocation's app context as Forge reports it on the server; never anything a client sent. */
export interface AppLicense {
  environmentType?: unknown;
  license?: unknown;
}

const unlicensedMessage =
  'Filter History for Jira has no active subscription on this site. A site administrator can subscribe in Atlassian Administration.';

export function requireLicense(app: AppLicense) {
  if (!licensed(app)) throw new UserError(unlicensedMessage);
}
