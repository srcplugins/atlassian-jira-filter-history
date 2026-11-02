// Hosted acceptance for Filter History (`npx forge-test suite <name> [--only a,b]`): delivery to
// the Forge development environment, then the journeys and runners in a fixed order. A failed
// delivery step stops it; a failed journey or runner is cleaned up and the suite moves on, unless
// that cleanup refuses. Journeys and runners journal their saved filters themselves
// (tests/hosted/support/filters.mjs), so their cleanup recovers those journals.

/** The guarded Forge CLI wrapper (only development without the owner's opt-in). */
export const forge = ['node', 'config/forge.mjs'];

const step = (name, command, env = {}, more = {}) => ({ name, command, env, ...more });
const prerequisite = (name, command) => step(name, command, {}, { prerequisite: true });
const forgeTest = (...args) => ['npx', 'forge-test', ...args];

const doctor = prerequisite('Jira credentials', forgeTest('doctor'));
const deploy = prerequisite('Deploy to development', [
  ...forge,
  'deploy',
  '-e',
  'development',
  '--non-interactive',
]);
const install = prerequisite('Install or upgrade on the primary site', forgeTest('install'));
// After a failed lane, every unresolved filter journal is recovered.
const journeys = step(
  'Feature journeys with the pinned identity sessions',
  forgeTest('lane', 'features'),
  {},
  { cleanup: ['node', 'tests/hosted/recover-filters.mjs', 'settle'] },
);
const rovo = step(
  'Rovo runner',
  ['node', 'tests/hosted/verify-rovo.mjs', 'run'],
  { FH_ROVO_TESTS: '1' },
  { cleanup: ['node', 'tests/hosted/verify-rovo.mjs', 'cleanup'] },
);

export const suites = {
  features: [doctor, deploy, install, journeys],
  full: [doctor, deploy, install, journeys, rovo],
  // Publish deploys its tagged build to development itself, then runs this.
  release: [doctor, install, journeys, rovo],
};
