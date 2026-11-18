// Shared srcplugins file, synchronized across repositories.
// @ts-check
// Every srcplugins app is paid via Atlassian. Each entry point of a paid app calls `licensed`
// with the app context Forge reports on the server (`getAppContext()`), never anything a client
// sent, and refuses with the plugin's own message when it answers false.

/**
 * A license object decides, and a trial is an active license. Forge gives development and staging
 * installations no license object unless they were installed with `--license`, so those keep
 * working; in production a missing license counts as unlicensed.
 * @param {{ environmentType?: unknown, license?: unknown }} app
 */
export function licensed({ environmentType, license }) {
  if (license && typeof license === 'object') {
    // Forge still sends `isActive`, the deprecated name of `active`, on some installations.
    const { active, isActive } = /** @type {{ active?: unknown, isActive?: unknown }} */ (license);
    return (typeof active === 'boolean' ? active : isActive) === true;
  }
  return environmentType === 'DEVELOPMENT' || environmentType === 'STAGING';
}
