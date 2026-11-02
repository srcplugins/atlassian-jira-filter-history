import { InvocationError, InvocationErrorCode } from '@forge/events';
import {
  createJira,
  createStore,
  StorageUnavailable,
  type JiraDeps,
  type StoreDeps,
} from './integration';
import { createService } from './service';

// Forge retries an event only when the handler returns this; a thrown error drops the event.
const retryAfterSeconds = 30;

/** Trigger for Jira's filter created, updated and deleted events. */
export function createFilterEventHandler(deps: JiraDeps & StoreDeps) {
  const service = createService({ jira: createJira(deps), store: createStore(deps) });
  // The event's context token is a credential: only the fields the version needs are read.
  return async (event: unknown) => {
    try {
      await service.record(event);
    } catch (error) {
      // Recording is idempotent, so Forge may deliver the event again after a storage failure.
      if (!(error instanceof StorageUnavailable)) throw error;
      return new InvocationError({
        retryAfter: retryAfterSeconds,
        retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
        retryData: {},
      });
    }
  };
}

/**
 * Daily scheduled trigger: removes deleted filters past the retention period. It touches app
 * storage only; after a storage failure the next day's run continues where this one stopped.
 */
export function createCleanupHandler(deps: JiraDeps & StoreDeps) {
  const service = createService({ jira: createJira(deps), store: createStore(deps) });
  return async () => {
    try {
      await service.expire();
    } catch (error) {
      if (!(error instanceof StorageUnavailable)) throw error;
    }
  };
}
