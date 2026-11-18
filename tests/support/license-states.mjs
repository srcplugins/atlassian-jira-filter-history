// Shared srcplugins file, synchronized across repositories.
// License states as the Forge runtime reports them in the app context (`forge install --license
// <state>` in development), and whether each may use a paid app. A paid plugin's tests drive its
// entry points through every state, so an entry point that skips the check, or refuses a licensed
// site, fails.

/** @type {Array<[state: string, app: { environmentType?: string, license?: unknown }, allowed: boolean]>} */
export const licenseStates = [
  ['production, active', { environmentType: 'PRODUCTION', license: { active: true } }, true],
  [
    'production, trial',
    { environmentType: 'PRODUCTION', license: { active: true, isEvaluation: true } },
    true,
  ],
  ['production, inactive', { environmentType: 'PRODUCTION', license: { active: false } }, false],
  ['production, no license', { environmentType: 'PRODUCTION' }, false],
  ['production, null license', { environmentType: 'PRODUCTION', license: null }, false],
  ['production, empty license', { environmentType: 'PRODUCTION', license: {} }, false],
  [
    'production, isActive only',
    { environmentType: 'PRODUCTION', license: { isActive: true } },
    true,
  ],
  [
    'production, active wins over isActive',
    { environmentType: 'PRODUCTION', license: { active: false, isActive: true } },
    false,
  ],
  [
    'production, string active',
    { environmentType: 'PRODUCTION', license: { active: 'true' } },
    false,
  ],
  ['unknown environment, no license', {}, false],
  ['development, no license', { environmentType: 'DEVELOPMENT' }, true],
  ['staging, no license', { environmentType: 'STAGING' }, true],
  [
    'development, --license active',
    { environmentType: 'DEVELOPMENT', license: { active: true } },
    true,
  ],
  [
    'development, --license trial',
    { environmentType: 'DEVELOPMENT', license: { active: true, isEvaluation: true } },
    true,
  ],
  [
    'development, --license inactive',
    { environmentType: 'DEVELOPMENT', license: { active: false } },
    false,
  ],
];
