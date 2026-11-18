import { InvocationError, InvocationErrorCode } from '@forge/events';
import {
  createJira,
  createStore,
  StorageUnavailable,
  type JiraDeps,
  type PrivacyDeps,
  type StoreDeps,
} from './integration';
import { createPrivacyReport } from './privacy';
import { createService, FilterBusy } from './service';
import { isRecord } from './shared/response.mjs';

// Forge retries an event only when the handler returns this, at most four times; a thrown error
// drops the event. Each retry waits longer, up to Forge's 15-minute maximum, with a little jitter
// so events held back together don't all return at once.
const retryAfterSeconds = [30, 120, 480, 900];
const retryJitterSeconds = 30;

const retryCount = (event: unknown) => {
  const context = isRecord(event) ? event.retryContext : undefined;
  const count = isRecord(context) ? context.retryCount : undefined;
  return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 0;
};

/** Trigger for Jira's filter created, updated and deleted events. */
export function createFilterEventHandler(deps: JiraDeps & StoreDeps) {
  const service = createService({ jira: createJira(deps), store: createStore(deps) });
  // The event's context token is a credential: only the fields the version needs are read.
  return async (event: unknown) => {
    try {
      await service.record(event);
    } catch (error) {
      // Recording is idempotent, so Forge may deliver the event again after a storage failure or
      // while another event for the same filter holds it.
      if (!(error instanceof StorageUnavailable) && !(error instanceof FilterBusy)) throw error;
      // Forge delivers it no more: the run fails, so the logs show it, with nothing of the filter.
      if (retryCount(event) >= retryAfterSeconds.length)
        throw new Error(
          `Filter event dropped after Forge's last retry: ${error instanceof FilterBusy ? 'the filter stayed busy' : 'storage was unavailable'}.`,
          // Either error's message is fixed text, with nothing of the filter.
          { cause: error },
        );
      const wait = retryAfterSeconds[Math.min(retryCount(event), retryAfterSeconds.length - 1)]!;
      return new InvocationError({
        retryAfter: Math.min(900, wait + Math.floor(Math.random() * retryJitterSeconds)),
        retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
        retryData: {},
      });
    }
  };
}

/**
 * Daily scheduled trigger: removes deleted filters past the retention period. It touches app
 * storage only; after a storage failure the next day's run continues where this one stopped. A run
 * that skipped a filter or met a storage outage fails once it stops, with a count and nothing of
 * any filter, so the logs show that removal is behind.
 */
export function createCleanupHandler(deps: JiraDeps & StoreDeps) {
  const service = createService({ jira: createJira(deps), store: createStore(deps) });
  return async () => {
    let skipped;
    try {
      skipped = await service.expire();
    } catch (error) {
      if (!(error instanceof StorageUnavailable)) throw error;
      // The message is fixed text, with nothing of a filter.
      throw new Error('Cleanup stopped: storage was unavailable. The next run continues.', {
        cause: error,
      });
    }
    if (skipped)
      throw new Error(
        `Cleanup couldn't remove ${skipped} deleted ${skipped === 1 ? "filter's" : "filters'"} history. The next run tries again.`,
      );
  };
}

/**
 * Weekly scheduled trigger, with or without a license: reports the stored account IDs to Atlassian
 * and erases closed accounts. A storage outage, a report request Atlassian refused or a filter that
 * couldn't be erased fails the run, with no account ID, once the rest is done, so the logs show
 * it. The next week's run reports every stored account again and erases what is left.
 */
export function createPrivacyReportHandler(deps: StoreDeps & PrivacyDeps) {
  return createPrivacyReport({ store: createStore(deps), privacy: deps.privacy });
}
