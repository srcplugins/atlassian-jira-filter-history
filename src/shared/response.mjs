// Shared srcplugins file, synchronized across repositories.
// @ts-check
// Public messages come only from a validated resolver envelope, never a transport exception.
export class PublicResponseError extends Error {}
/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @param {number} max @returns {value is string} */
export const isText = (value, max) => typeof value === 'string' && value.length <= max;
/** @param {unknown} response @returns {unknown} */
export function unwrapResponse(response) {
  if (!isRecord(response)) throw Error('Invalid response');
  if (response.ok === false && isText(response.error, 500) && response.error.trim())
    throw new PublicResponseError(response.error);
  if (response.ok !== true || !('value' in response)) throw Error('Invalid response');
  return response.value;
}
