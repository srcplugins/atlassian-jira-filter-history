import { expect as playwrightExpect } from '@playwright/test';

// The runners run outside the Playwright test runner, so an assertion without its own timeout
// would fail after Playwright's 5 s default instead of the 30 s the lanes use.
export const expect = playwrightExpect.configure({ timeout: 30000 });
