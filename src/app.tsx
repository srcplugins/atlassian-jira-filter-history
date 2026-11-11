import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  EmptyState,
  Heading,
  Inline,
  Label,
  LoadingButton,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
  User,
  useProductContext,
  xcss,
} from '@forge/react';
import { invoke, router } from '@forge/bridge';
import { PublicResponseError, isRecord } from './shared/response.mjs';
import {
  readDeleteHistory,
  readHistory,
  readOverview,
  readRecreate,
  readRestore,
  type DeletedRow,
  type FilterNow,
  type HistoryVersion,
  type OverviewRow,
} from './client';
import { diffText, fields, type Field, type Part } from './versions';

const fieldLabels: Record<Field, string> = {
  name: 'Name',
  description: 'Description',
  jql: 'JQL',
  owner: 'Owner',
};
const queryFields: Field[] = ['name', 'description', 'jql'];

// Dates follow the viewer's Jira language and time zone, set once the product context loads.
let dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
function setJiraDates(locale: unknown, timeZone: unknown) {
  try {
    const language = typeof locale === 'string' && locale ? locale.replace('_', '-') : undefined;
    const zone = typeof timeZone === 'string' && timeZone ? { timeZone } : {};
    dateFormat = new Intl.DateTimeFormat(language, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...zone,
    });
    dayFormat = new Intl.DateTimeFormat(language, { dateStyle: 'medium', ...zone });
  } catch {
    // An unknown language or zone keeps the browser's.
  }
}
const when = (at: number) => dateFormat.format(new Date(at));
// The cleanup runs daily, so its dates have no time.
const day = (at: number) => dayFormat.format(new Date(at));

const failure = (error: unknown) =>
  error instanceof PublicResponseError ? error.message : 'Connection failed. Try again.';

/** "Description, owner": the fields a comparison leaves out because they didn't change. */
const fieldList = (list: Field[]) => {
  const text = list.map((field) => fieldLabels[field].toLowerCase()).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// The two comparison columns sit side by side and wrap under each other when the space is narrow.
const column = xcss({
  flexGrow: '1',
  width: '22rem',
  maxWidth: '100%',
  minWidth: '0',
  padding: 'space.200',
  borderColor: 'color.border',
  borderWidth: 'border.width',
  borderStyle: 'solid',
  borderRadius: 'radius.medium',
});
const restoreColumn = xcss({
  flexGrow: '1',
  width: '22rem',
  maxWidth: '100%',
  minWidth: '0',
  padding: 'space.200',
  borderRadius: 'radius.medium',
  backgroundColor: 'elevation.surface.sunken',
});
// A tab panel sizes to its content, so its tables would end at their last column.
const tabPanel = xcss({ width: '100%', paddingBlockStart: 'space.200' });
const pill = xcss({
  paddingInline: 'space.100',
  paddingBlock: 'space.025',
  borderColor: 'color.border',
  borderWidth: 'border.width',
  borderStyle: 'solid',
  borderRadius: 'radius.full',
  backgroundColor: 'elevation.surface',
});

/** Loads a resolver value on mount and when `reload` is called. */
function useLoad<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ value?: T; error?: string; loading: boolean }>({
    loading: true,
  });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let current = true;
    setState((previous) => ({ ...previous, loading: true }));
    load().then(
      (value) => current && setState({ value, loading: false }),
      // The last loaded value stays on screen under the error.
      (error: unknown) =>
        current && setState((previous) => ({ ...previous, error: failure(error), loading: false })),
    );
    return () => {
      current = false;
    };
    // `load` is rebuilt each render; `key` and `round` say when to load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads only on key or round
  }, [key, round]);
  return { ...state, reload: () => setRound((value) => value + 1) };
}

/** "Removed: a · Added: b": the changed words in plain text, for readers who can't see styles. */
function changeSummary(parts: Part[]) {
  const words = (change: Part['change']) =>
    parts
      .filter((part) => part.change === change && part.text.trim())
      .map((part) => part.text.trim())
      .join(' … ');
  const removed = words('removed');
  const added = words('added');
  return [removed && `Removed: ${removed}`, added && `Added: ${added}`].filter(Boolean).join(' · ');
}

/**
 * Inline comparison: removed words struck through, added words in bold, then the same change in
 * words, since strike-through and colour aren't read out.
 */
function Difference({ before, after }: { before: string; after: string }) {
  if (before === after) return <Text>{after || '(empty)'}</Text>;
  if (!before && !after) return <Text>(empty)</Text>;
  const parts = diffText(before, after);
  return (
    <Stack space="space.050">
      <Text>
        {parts.map((part, index) =>
          part.change === 'same' ? (
            part.text
          ) : part.change === 'removed' ? (
            <Text key={index} as="strike" color="color.text.danger">
              {part.text}
            </Text>
          ) : (
            <Text key={index} as="strong" color="color.text.success">
              {part.text}
            </Text>
          ),
        )}
      </Text>
      <Text size="small" color="color.text.subtle">
        {changeSummary(parts)}
      </Text>
    </Stack>
  );
}

/** A side of a comparison: a version, or the filter now. */
type Compared = Pick<HistoryVersion, Field> & { descriptionMissing?: boolean };
const notRecorded = "(not recorded: Jira doesn't send descriptions over 10,000 characters)";

function FieldChange({
  field,
  before,
  after,
}: {
  field: Field;
  before: Compared;
  after: Compared;
}) {
  const missing =
    field === 'description' && (before.descriptionMissing || after.descriptionMissing);
  return (
    <Stack space="space.050">
      <Text weight="semibold">{fieldLabels[field]}</Text>
      {missing ? (
        <Text color="color.text.subtle">
          {before === after
            ? notRecorded
            : `${before.descriptionMissing ? notRecorded : before.description || '(empty)'} → ${
                after.descriptionMissing ? notRecorded : after.description || '(empty)'
              }`}
        </Text>
      ) : field === 'owner' ? (
        <Inline space="space.100" alignBlock="center">
          {before.owner ? <User accountId={before.owner} /> : <Text>(none)</Text>}
          <Text>→</Text>
          {after.owner ? <User accountId={after.owner} /> : <Text>(none)</Text>}
        </Inline>
      ) : (
        <Difference before={before[field]} after={after[field]} />
      )}
    </Stack>
  );
}

/** One side of a comparison: a version's author and time, or a plain label. */
function Side({ version, label }: { version?: HistoryVersion; label?: string }) {
  return (
    <Box xcss={pill}>
      <Inline space="space.050" alignBlock="center">
        {version && <User accountId={version.actor} hideDisplayName />}
        <Text size="small">{version ? when(version.at) : label}</Text>
      </Inline>
    </Box>
  );
}

/** "<before> → <after>": names the two sides a comparison shows. */
function Between({ from, to }: { from: React.ReactNode; to: React.ReactNode }) {
  return (
    <Inline space="space.075" alignBlock="center" shouldWrap>
      {from}
      <Text size="small" color="color.text.subtle">
        →
      </Text>
      {to}
    </Inline>
  );
}

function Unchanged({ list }: { list: Field[] }) {
  return list.length ? (
    <Text size="small" color="color.text.subtlest">
      Unchanged: {fieldList(list)}
    </Text>
  ) : null;
}

/** Left column: what this version changed, compared with the version before it. */
function WhatChanged({
  version,
  previous,
  capped,
  cleared,
}: {
  version: HistoryVersion;
  previous: HistoryVersion | undefined;
  capped: boolean;
  /** An administrator deleted the history before the versions shown. */
  cleared: boolean;
}) {
  if (!previous && !capped)
    return (
      <Stack space="space.150">
        <Heading as="h4">First recorded version</Heading>
        <Text size="small" color="color.text.subtle">
          {cleared
            ? 'The app recorded this filter again from here, after an administrator deleted its earlier history.'
            : "The app started recording this filter here. Changes made before the app was installed aren't available."}
        </Text>
        {queryFields.map((field) => (
          <FieldChange key={field} field={field} before={version} after={version} />
        ))}
      </Stack>
    );
  if (!previous)
    return (
      <Stack space="space.150">
        <Heading as="h4">What changed</Heading>
        <Text size="small" color="color.text.subtle">
          The version before this one is older than the versions shown, so the comparison isn&apos;t
          available.
        </Text>
        {version.changed.length > 0 && <Text>Changed: {fieldList(version.changed)}</Text>}
      </Stack>
    );
  return (
    <Stack space="space.150">
      <Heading as="h4">What changed</Heading>
      <Between from={<Side version={previous} />} to={<Side version={version} />} />
      {version.changed.map((field) => (
        <FieldChange key={field} field={field} before={previous} after={version} />
      ))}
      <Unchanged list={fields.filter((field) => !version.changed.includes(field))} />
    </Stack>
  );
}

/** Right column: what restoring this version would change in the filter now. */
function IfRestored({
  filter,
  version,
  newest,
  onRestored,
}: {
  filter: FilterNow;
  version: HistoryVersion;
  newest: boolean;
  onRestored: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // After Cancel, focus goes back to the button that opened the confirmation.
  const [cancelled, setCancelled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const differences = queryFields.filter(
    (field) =>
      filter[field] !== version[field] && !(field === 'description' && version.descriptionMissing),
  );
  async function restore() {
    setBusy(true);
    setError(undefined);
    try {
      readRestore(
        await invoke<unknown>('restore', {
          filterId: filter.id,
          at: version.at,
          expected: { name: filter.name, description: filter.description, jql: filter.jql },
        }),
      );
      setConfirming(false);
      onRestored();
    } catch (failed) {
      setError(failure(failed));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }
  if (newest && !differences.length && !error)
    return (
      <Stack space="space.150">
        <Heading as="h4">Current version</Heading>
        <Text size="small" color="color.text.subtle">
          Select an earlier version to compare it with the current filter.
        </Text>
      </Stack>
    );
  return (
    <Stack space="space.150">
      <Heading as="h4">Compare with current filter</Heading>
      <Between from={<Side label="Current filter" />} to={<Side label="Selected version" />} />
      {differences.length ? (
        <>
          {differences.map((field) => (
            <FieldChange key={field} field={field} before={filter} after={version} />
          ))}
          <Unchanged list={queryFields.filter((field) => !differences.includes(field))} />
        </>
      ) : (
        <Text>No differences between the current filter and this version.</Text>
      )}
      <Text size="small" color="color.text.subtlest">
        Restoring a version preserves the filter&apos;s owner and permissions.
      </Text>
      {error && (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      )}
      {differences.length > 0 && !filter.isWritable && (
        <Text color="color.text.subtle">
          You can&apos;t edit this filter, so you can&apos;t restore it.
        </Text>
      )}
      {differences.length > 0 && filter.isWritable && !confirming && (
        <Box>
          <Button autoFocus={cancelled} onClick={() => setConfirming(true)}>
            Restore version
          </Button>
        </Box>
      )}
      {confirming && (
        <SectionMessage appearance="warning" title="Restore version?">
          <Stack space="space.100">
            <Text>
              {version.descriptionMissing
                ? "The filter's name and JQL change as shown above. Its description stays as it is."
                : "The filter's name, description and JQL change as shown above."}
            </Text>
            <Inline space="space.100">
              <LoadingButton
                appearance="warning"
                autoFocus
                isLoading={busy}
                onClick={() => void restore()}
              >
                Restore version
              </LoadingButton>
              <Button
                appearance="subtle"
                isDisabled={busy}
                onClick={() => {
                  setConfirming(false);
                  setCancelled(true);
                }}
              >
                Cancel
              </Button>
            </Inline>
          </Stack>
        </SectionMessage>
      )}
    </Stack>
  );
}

/** Right column of a deleted filter: recreates it, as a new private filter, from this version. */
function Recreate({
  filterId,
  version,
  newest,
  onRecreated,
}: {
  filterId: string;
  version: HistoryVersion;
  newest: boolean;
  onRecreated: (filterId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function recreate() {
    setBusy(true);
    setError(undefined);
    try {
      const { filterId: recreated } = readRecreate(
        await invoke<unknown>('recreate', { filterId, at: version.at }),
      );
      onRecreated(recreated);
    } catch (failed) {
      setError(failure(failed));
      setConfirming(false);
      setBusy(false);
    }
  }
  return (
    <Stack space="space.150">
      <Heading as="h4">
        {newest ? 'Recreate the filter as it was deleted' : 'Recreate the filter from this version'}
      </Heading>
      <Text size="small" color="color.text.subtle">
        A new filter in Jira, owned by you, with:
      </Text>
      {queryFields.map((field) => (
        <FieldChange key={field} field={field} before={version} after={version} />
      ))}
      {error && (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      )}
      {version.descriptionMissing && (
        <Text size="small" color="color.text.subtle">
          The new filter has no description.
        </Text>
      )}
      {confirming ? (
        <SectionMessage appearance="warning" title="Recreate this filter?">
          <Stack space="space.100">
            <Text>
              The new filter has a new ID and is private to you. Share it in Jira if others need it.
            </Text>
            <Text>
              Boards, dashboards and subscriptions that used the deleted filter don&apos;t switch to
              the new one.
            </Text>
            <Text>The history continues under the new filter.</Text>
            <Inline space="space.100">
              <LoadingButton
                appearance="primary"
                autoFocus
                isLoading={busy}
                onClick={() => void recreate()}
              >
                Recreate filter
              </LoadingButton>
              <Button
                appearance="subtle"
                isDisabled={busy}
                onClick={() => {
                  setConfirming(false);
                  setCancelled(true);
                }}
              >
                Cancel
              </Button>
            </Inline>
          </Stack>
        </SectionMessage>
      ) : (
        <Box>
          <Button appearance="primary" autoFocus={cancelled} onClick={() => setConfirming(true)}>
            Recreate filter
          </Button>
        </Box>
      )}
    </Stack>
  );
}

/** Asks before an administrator deletes a filter's history, then deletes it. */
function DeleteHistory({
  filterId,
  title,
  text,
  onCancel,
  onDeleted,
}: {
  filterId: string;
  title: string;
  text: string;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function remove() {
    setBusy(true);
    setError(undefined);
    try {
      readDeleteHistory(await invoke<unknown>('deleteHistory', { filterId }));
      onDeleted();
    } catch (failed) {
      setError(failure(failed));
      setBusy(false);
    }
  }
  return (
    <SectionMessage appearance="error" title={title}>
      <Stack space="space.100">
        <Text>{text}</Text>
        {error && <Text color="color.text.danger">{error}</Text>}
        <Inline space="space.100">
          <LoadingButton
            appearance="danger"
            autoFocus
            isLoading={busy}
            onClick={() => void remove()}
          >
            Delete history
          </LoadingButton>
          <Button appearance="subtle" isDisabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </Inline>
      </Stack>
    </SectionMessage>
  );
}

function VersionDetail({
  filter,
  version,
  previous,
  capped,
  newest,
  deleted,
  cleared,
  onRestored,
  onRecreated,
}: {
  filter: FilterNow;
  version: HistoryVersion;
  previous: HistoryVersion | undefined;
  capped: boolean;
  newest: boolean;
  deleted: boolean;
  cleared: boolean;
  onRestored: () => void;
  /** Absent in Jira's search modal: a deleted filter is recreated from the app's page. */
  onRecreated: ((filterId: string) => void) | undefined;
}) {
  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Heading as="h3">{when(version.at)}</Heading>
        <User accountId={version.actor} />
        {newest && !deleted && <Lozenge appearance="success">Current</Lozenge>}
        {version.restored && <Lozenge appearance="information">Restored</Lozenge>}
        {version.recreated && <Lozenge appearance="information">Recreated</Lozenge>}
      </Inline>
      <Inline space="space.200" shouldWrap>
        <Box xcss={column}>
          <WhatChanged version={version} previous={previous} capped={capped} cleared={cleared} />
        </Box>
        <Box xcss={restoreColumn}>
          {deleted && !onRecreated ? (
            <Text color="color.text.subtle">
              To recreate this filter, open Filter History from Jira&apos;s Apps menu.
            </Text>
          ) : deleted && onRecreated ? (
            <Recreate
              filterId={filter.id}
              version={version}
              newest={newest}
              onRecreated={onRecreated}
            />
          ) : (
            <IfRestored filter={filter} version={version} newest={newest} onRestored={onRestored} />
          )}
        </Box>
      </Inline>
    </Stack>
  );
}

// After a restore or recreate, Jira reports the change a few seconds later and only then is it a
// version: the history reloads every few seconds until the new version is there, for up to a
// minute.
const followEvery = 3000;
const followTries = 20;

/** What the history waits for or reports after the viewer's restore or recreate. */
type Follow = {
  action: 'restore' | 'recreate';
  /** The newest version's time before the change; the change is the first version after it. */
  after: number;
  tries: number;
  state: 'waiting' | 'listed' | 'late';
};

function FollowMessage({ follow, name }: { follow: Follow; name: string }) {
  const restore = follow.action === 'restore';
  const title = restore ? 'Restored' : 'Recreated';
  const done = restore
    ? 'The filter now matches the selected version.'
    : `“${name}” is a new private filter in Jira. Its history continues here.`;
  return (
    <SectionMessage appearance="success" title={title}>
      <Stack space="space.100">
        <Text>{done}</Text>
        {follow.state === 'waiting' && (
          <Inline space="space.100" alignBlock="center">
            <Spinner size="small" label="Adding the new version" />
            <Text color="color.text.subtle">Adding the new version to the history…</Text>
          </Inline>
        )}
        {follow.state === 'late' && (
          <Text color="color.text.subtle">
            Jira hasn&apos;t reported the change yet, so the history doesn&apos;t list it. Refresh
            the page in a minute.
          </Text>
        )}
      </Stack>
    </SectionMessage>
  );
}

/** A failed load, with a way to load again; any earlier answer stays on screen below it. */
function LoadError({ message, onRetry }: { message: string | undefined; onRetry: () => void }) {
  return (
    <SectionMessage appearance="error">
      <Stack space="space.100">
        <Text>{message ?? 'Connection failed. Try again.'}</Text>
        <Box>
          <Button onClick={onRetry}>Try again</Button>
        </Box>
      </Stack>
    </SectionMessage>
  );
}

function FilterHistory({
  filterId,
  recreatedAfter,
  onBack,
  onRecreated,
}: {
  filterId: string;
  /** Set when the filter was just recreated: the deleted filter's newest version's time. */
  recreatedAfter?: number;
  onBack?: () => void;
  onRecreated?: (filterId: string, after: number) => void;
}) {
  const history = useLoad(
    async () => readHistory(await invoke<unknown>('history', { filterId })),
    filterId,
  );
  // The version on view, by its time; none chosen yet means the newest.
  const [selected, setSelected] = useState<number>();
  const [deleting, setDeleting] = useState(false);
  const [deleteCancelled, setDeleteCancelled] = useState(false);
  const [follow, setFollow] = useState<Follow | undefined>(
    recreatedAfter === undefined
      ? undefined
      : { action: 'recreate', after: recreatedAfter, tries: 0, state: 'waiting' },
  );
  useEffect(() => {
    if (follow?.state !== 'waiting' || history.loading || !history.value) return;
    // The viewer's own change, not someone else's edit that arrived first. A failed reload keeps
    // the last answer and counts as one try.
    const own = history.value.versions.find(
      (version) =>
        version.at > follow.after &&
        (follow.action === 'restore' ? version.restored : version.recreated),
    );
    if (own) {
      setSelected(own.at);
      setFollow({ ...follow, state: 'listed' });
      return;
    }
    if (follow.tries >= followTries) {
      setFollow({ ...follow, state: 'late' });
      return;
    }
    const timer = setTimeout(() => {
      setFollow({ ...follow, tries: follow.tries + 1 });
      history.reload();
    }, followEvery);
    return () => clearTimeout(timer);
    // `history.reload` is rebuilt each render; the loaded value and `follow` say when to look.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads only on a new answer
  }, [follow, history.loading, history.value]);
  const back = onBack && (
    <Box>
      <Button appearance="subtle" onClick={onBack}>
        ← All filters
      </Button>
    </Box>
  );
  if (history.loading && !history.value) return <Spinner label="Loading filter history" />;
  if (!history.value)
    return (
      <Stack space="space.200">
        {back}
        <LoadError message={history.error} onRetry={history.reload} />
      </Stack>
    );
  const { filter, versions, more, deleted, cleared, admin } = history.value;
  const chosen = versions.findIndex((version) => version.at === selected);
  const index = chosen >= 0 ? chosen : 0;
  const rows = versions.map((version, row) => ({
    key: String(version.at),
    // Per row, since the table's highlighted index counts from the page shown.
    isHighlighted: row === index,
    cells: [
      { key: 'when', content: when(version.at) },
      { key: 'actor', content: <User accountId={version.actor} /> },
      {
        key: 'changed',
        content: (
          <Inline space="space.050" shouldWrap>
            {row === 0 && !deleted && <Lozenge appearance="success">Current</Lozenge>}
            {version.restored && <Lozenge appearance="information">Restored</Lozenge>}
            {version.recreated && <Lozenge appearance="information">Recreated</Lozenge>}
            {version.changed.length || row < versions.length - 1 || more ? (
              version.changed.map((field) => <Lozenge key={field}>{fieldLabels[field]}</Lozenge>)
            ) : (
              <Lozenge appearance="new">First recorded</Lozenge>
            )}
          </Inline>
        ),
      },
      {
        key: 'view',
        content: (
          <Button
            appearance={row === index ? 'primary' : 'default'}
            isSelected={row === index}
            onClick={() => setSelected(version.at)}
          >
            View
          </Button>
        ),
      },
    ],
  }));
  const count = `${versions.length} recorded ${versions.length === 1 ? 'version' : 'versions'}`;
  return (
    <Stack space="space.200">
      {back}
      {history.error && <LoadError message={history.error} onRetry={history.reload} />}
      <Inline spread="space-between" alignBlock="start" shouldWrap space="space.100">
        <Stack space="space.050">
          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Heading as="h2">{filter.name}</Heading>
            {deleted && <Lozenge appearance="removed">Deleted</Lozenge>}
          </Inline>
          <Inline space="space.200" alignBlock="center" shouldWrap>
            <Inline space="space.100" alignBlock="center">
              <Text color="color.text.subtle">Owner</Text>
              {filter.owner ? <User accountId={filter.owner} /> : <Text>(none)</Text>}
            </Inline>
            {versions.length > 0 && (
              <Text color="color.text.subtle">
                {more ? `The latest ${versions.length} versions. Older ones aren't kept.` : count}
              </Text>
            )}
          </Inline>
        </Stack>
        {admin && onBack && versions.length > 0 && !deleting && (
          <Button appearance="subtle" autoFocus={deleteCancelled} onClick={() => setDeleting(true)}>
            Delete history
          </Button>
        )}
      </Inline>
      {deleted && (
        <SectionMessage appearance="information" title="This filter was deleted">
          <Stack space="space.100">
            <Inline space="space.050" alignBlock="center" shouldWrap>
              <Text>Deleted on {when(deleted.at)} by</Text>
              <User accountId={deleted.actor} />
            </Inline>
            <Text>
              Only you, as its owner, can view this history and recreate the filter from any
              version. The history is removed from {day(deleted.expires)}.
            </Text>
          </Stack>
        </SectionMessage>
      )}
      {follow?.action === 'recreate' && (
        <Stack space="space.100">
          <FollowMessage follow={follow} name={filter.name} />
          <Box>
            <Button onClick={() => void router.navigate(`/issues/?filter=${filter.id}`)}>
              Open in Jira&apos;s search
            </Button>
          </Box>
        </Stack>
      )}
      {deleting && (
        <DeleteHistory
          filterId={filter.id}
          title={`Delete history for “${filter.name}”?`}
          text={`This permanently deletes ${more ? 'all recorded versions' : `all ${count}`} of this filter for all users. The filter in Jira isn't changed, and its next change starts a new history. The history will show that you deleted it, and when. This can't be undone.`}
          onCancel={() => {
            setDeleting(false);
            setDeleteCancelled(true);
          }}
          onDeleted={() => {
            setDeleting(false);
            history.reload();
          }}
        />
      )}
      {cleared && (
        <SectionMessage appearance="information" title="Earlier history deleted">
          <Inline space="space.050" alignBlock="center" shouldWrap>
            <Text>Deleted on {when(cleared.at)} by</Text>
            <User accountId={cleared.actor} />
          </Inline>
        </SectionMessage>
      )}
      {versions.length ? (
        <DynamicTable
          label="Versions of this filter, newest first"
          head={{
            cells: [
              { key: 'when', content: 'Changed' },
              { key: 'actor', content: 'Changed by' },
              { key: 'changed', content: 'What changed' },
              { key: 'view', content: 'Actions' },
            ],
          }}
          rows={rows}
          rowsPerPage={20}
          isLoading={history.loading && follow?.state !== 'waiting'}
        />
      ) : (
        <EmptyState
          header="No changes recorded yet"
          description="Changes to this filter appear here from now on. Changes made before the app was installed aren't available."
        />
      )}
      {follow?.action === 'restore' && <FollowMessage follow={follow} name={filter.name} />}
      {versions[index] && (
        <VersionDetail
          key={versions[index].at}
          filter={filter}
          version={versions[index]}
          previous={versions[index + 1]}
          capped={more}
          newest={index === 0}
          deleted={deleted !== null}
          cleared={cleared !== null}
          onRestored={() => {
            setFollow({
              action: 'restore',
              after: versions[0]?.at ?? 0,
              tries: 0,
              state: 'waiting',
            });
            history.reload();
          }}
          onRecreated={onRecreated && ((id: string) => onRecreated(id, versions[0]?.at ?? 0))}
        />
      )}
    </Stack>
  );
}

function FilterList({
  filters,
  partial,
  term,
  onOpen,
}: {
  filters: OverviewRow[];
  partial: boolean;
  term: string;
  onOpen: (filterId: string) => void;
}) {
  if (!filters.length)
    return (
      <EmptyState
        header="No filter changes recorded yet"
        description="When someone creates or edits a saved filter you can see, its history appears here. Changes made before the app was installed aren't available."
      />
    );
  const shown = filters.filter((row) => row.name.toLowerCase().includes(term));
  return (
    <Stack space="space.200">
      <Text>Saved filters you can see with changes recorded since the app was installed.</Text>
      {partial && (
        <SectionMessage appearance="warning">
          <Text>This site has more filters with history than the page lists at once.</Text>
        </SectionMessage>
      )}
      <DynamicTable
        label="Filters with recorded changes, most recently changed first"
        head={{
          cells: [
            { key: 'name', content: 'Filter' },
            { key: 'owner', content: 'Owner' },
            { key: 'at', content: 'Last changed' },
            { key: 'actor', content: 'Changed by' },
          ],
        }}
        rows={shown.map((row) => ({
          key: row.filterId,
          cells: [
            {
              key: 'name',
              content: (
                <Button appearance="subtle" onClick={() => onOpen(row.filterId)}>
                  {row.name}
                </Button>
              ),
            },
            { key: 'owner', content: row.owner ? <User accountId={row.owner} /> : '' },
            { key: 'at', content: when(row.at) },
            { key: 'actor', content: <User accountId={row.actor} /> },
          ],
        }))}
        rowsPerPage={25}
        emptyView={<Text>No filter matches that name.</Text>}
      />
    </Stack>
  );
}

function DeletedList({
  deleted,
  partial,
  admin,
  term,
  onOpen,
  onDeleted,
}: {
  deleted: DeletedRow[];
  partial: boolean;
  admin: boolean;
  term: string;
  onOpen: (filterId: string) => void;
  onDeleted: () => void;
}) {
  const [asking, setAsking] = useState<DeletedRow>();
  const [done, setDone] = useState<string>();
  const shown = deleted.filter((row) => row.name.toLowerCase().includes(term));
  return (
    <Stack space="space.200">
      <Text>
        {admin
          ? "Only a deleted filter's owner can view its history. Jira admins can permanently delete it."
          : 'Deleted filters you owned. Only you can view their history and recreate them.'}
      </Text>
      {partial && (
        <SectionMessage appearance="warning">
          <Text>This site has more deleted filters than the page lists at once.</Text>
        </SectionMessage>
      )}
      {done && (
        <SectionMessage appearance="success">
          <Text>History for “{done}” deleted.</Text>
        </SectionMessage>
      )}
      {asking && (
        <DeleteHistory
          key={asking.filterId}
          filterId={asking.filterId}
          title={`Delete history for “${asking.name}”?`}
          text="This permanently deletes all recorded versions of this filter for all users. This can't be undone."
          onCancel={() => setAsking(undefined)}
          onDeleted={() => {
            setDone(asking.name);
            setAsking(undefined);
            onDeleted();
          }}
        />
      )}
      <DynamicTable
        label="Deleted filters, most recently deleted first"
        head={{
          cells: [
            { key: 'name', content: 'Filter' },
            { key: 'owner', content: 'Owner' },
            { key: 'at', content: 'Deleted' },
            { key: 'actor', content: 'Deleted by' },
            { key: 'expires', content: 'History removed from' },
            ...(admin ? [{ key: 'delete', content: 'Actions' }] : []),
          ],
        }}
        rows={shown.map((row) => ({
          key: row.filterId,
          cells: [
            {
              key: 'name',
              content: row.canOpen ? (
                <Button appearance="subtle" onClick={() => onOpen(row.filterId)}>
                  {row.name}
                </Button>
              ) : (
                // Indented like a button's label so the names line up.
                <Box paddingInline="space.150">{row.name}</Box>
              ),
            },
            { key: 'owner', content: row.owner ? <User accountId={row.owner} /> : '' },
            { key: 'at', content: when(row.at) },
            { key: 'actor', content: <User accountId={row.actor} /> },
            { key: 'expires', content: day(row.expires) },
            ...(admin
              ? [
                  {
                    key: 'delete',
                    content: (
                      <Button
                        appearance="subtle"
                        onClick={() => {
                          setDone(undefined);
                          setAsking(row);
                        }}
                      >
                        Delete history
                      </Button>
                    ),
                  },
                ]
              : []),
          ],
        }))}
        rowsPerPage={25}
        emptyView={
          <Text>
            {deleted.length ? 'No deleted filter matches that name.' : 'No deleted filters.'}
          </Text>
        }
      />
    </Stack>
  );
}

function Overview({
  tab,
  onTab,
  onOpen,
}: {
  tab: number;
  onTab: (tab: number) => void;
  onOpen: (filterId: string) => void;
}) {
  const overview = useLoad(async () => readOverview(await invoke<unknown>('overview')), 'overview');
  const [search, setSearch] = useState('');
  if (overview.loading && !overview.value) return <Spinner label="Loading filters" />;
  if (!overview.value) return <LoadError message={overview.error} onRetry={overview.reload} />;
  const { filters, partial, deleted, deletedPartial, admin } = overview.value;
  const term = search.trim().toLowerCase();
  return (
    <Stack space="space.200">
      {overview.error && <LoadError message={overview.error} onRetry={overview.reload} />}
      <Stack space="space.050">
        <Label labelFor="filter-search">Search filters</Label>
        <Textfield
          id="filter-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </Stack>
      <Tabs id="filter-history-tabs" selected={tab} onChange={onTab}>
        <TabList>
          <Tab>Filters</Tab>
          <Tab>{`Deleted filters (${deleted.length})`}</Tab>
        </TabList>
        <TabPanel>
          <Box xcss={tabPanel}>
            <FilterList filters={filters} partial={partial} term={term} onOpen={onOpen} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={tabPanel}>
            <DeletedList
              deleted={deleted}
              partial={deletedPartial}
              admin={admin}
              term={term}
              onOpen={onOpen}
              onDeleted={overview.reload}
            />
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
}

function GlobalPage() {
  const [open, setOpen] = useState<{ filterId: string; recreatedAfter?: number }>();
  // The overview's tab, kept while a filter's history is open.
  const [tab, setTab] = useState(0);
  return open ? (
    <FilterHistory
      key={open.filterId}
      filterId={open.filterId}
      {...(open.recreatedAfter === undefined ? {} : { recreatedAfter: open.recreatedAfter })}
      onBack={() => setOpen(undefined)}
      onRecreated={(filterId, recreatedAfter) => setOpen({ filterId, recreatedAfter })}
    />
  ) : (
    <Overview tab={tab} onTab={setTab} onOpen={(filterId) => setOpen({ filterId })} />
  );
}

function App() {
  const context = useProductContext();
  if (!context) return <Spinner label="Loading" />;
  setJiraDates(context.locale, context.timezone);
  const extension: unknown = context.extension;
  if (isRecord(extension) && extension.type === 'jira:issueNavigatorAction') {
    const filterId = typeof extension.filterId === 'string' ? extension.filterId : '';
    return /^[1-9]\d*$/.test(filterId) ? (
      <FilterHistory filterId={filterId} />
    ) : (
      <SectionMessage appearance="information">
        <Text>Open a saved filter in Jira's search to see its history.</Text>
      </SectionMessage>
    );
  }
  return <GlobalPage />;
}
ForgeReconciler.render(<App />);
