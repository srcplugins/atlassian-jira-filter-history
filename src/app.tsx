import React, { useEffect, useRef, useState } from 'react';
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
import { createLatch } from './shared/latch.mjs';
import { PublicResponseError, isRecord } from './shared/response.mjs';
import {
  readDeleteHistory,
  readHistory,
  readOverview,
  readRecreate,
  readRestore,
  readVersion,
  type DeletedRow,
  type FilterNow,
  type HistoryVersion,
  type OverviewRow,
  type VersionText,
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
// Change times show seconds, so quick edits in a row can be told apart.
let dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
let dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
function setJiraDates(locale: unknown, timeZone: unknown) {
  try {
    const language = typeof locale === 'string' && locale ? locale.replace('_', '-') : undefined;
    const zone = typeof timeZone === 'string' && timeZone ? { timeZone } : {};
    dateFormat = new Intl.DateTimeFormat(language, {
      dateStyle: 'medium',
      timeStyle: 'medium',
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

/** "Description, JQL": the fields a comparison leaves out because they didn't change. */
const fieldList = (list: Field[]) => {
  const text = list
    .map((field) => (field === 'jql' ? fieldLabels[field] : fieldLabels[field].toLowerCase()))
    .join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// Why a history can start late or miss changes: shown wherever it begins.
const gapNote =
  "The app records changes only while it's installed with an active subscription, so earlier changes aren't available.";

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

/**
 * One write at a time on a screen. The latch drops a second click the host delivers before it
 * redraws; `busy` disables the screen's other actions until the write answers, so its outcome
 * stays on screen.
 */
function useWrites() {
  const latch = useRef(createLatch()).current;
  const [busy, setBusy] = useState(false);
  const perform = (action: () => Promise<void>) =>
    void latch.run(async () => {
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    });
  return { busy, perform };
}
type Writes = ReturnType<typeof useWrites>;

// Each side of the worded summary is cut to this many characters.
const summaryLength = 300;
const cut = (text: string) =>
  text.length > summaryLength ? `${text.slice(0, summaryLength).trimEnd()}…` : text;

/** "Removed: a · Added: b": the changed words in plain text, for readers who can't see styles. */
function changeSummary(parts: Part[]) {
  const words = (change: Part['change']) =>
    cut(
      parts
        .filter((part) => part.change === change && part.text.trim())
        .map((part) => part.text.trim())
        .join(' … '),
    );
  const removed = words('removed');
  const added = words('added');
  return (
    [removed && `Removed: ${removed}`, added && `Added: ${added}`].filter(Boolean).join(' · ') ||
    'Only spacing changed.'
  );
}

/** A recorded account; one Jira didn't send, or erased for a closed account, is unknown. */
function Person({ accountId, hideDisplayName }: { accountId: string; hideDisplayName?: boolean }) {
  return accountId ? (
    <User accountId={accountId} {...(hideDisplayName && { hideDisplayName })} />
  ) : (
    <Text>Unknown</Text>
  );
}

/**
 * Inline comparison: removed words struck through, added words in bold, then the same change in
 * words, since strike-through and colour aren't read out.
 */
function Difference({ before, after }: { before: string; after: string }) {
  if (before === after) return <Text>{after || '(empty)'}</Text>;
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
type Compared = Pick<VersionText, Field> & { descriptionMissing?: boolean };
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
          <Person accountId={before.owner} />
          <Text>→</Text>
          <Person accountId={after.owner} />
        </Inline>
      ) : (
        <Difference before={before[field]} after={after[field]} />
      )}
    </Stack>
  );
}

/** One side of a comparison: a version's author and time, or a plain label. */
function Side({ version, label }: { version?: VersionText; label?: string }) {
  return (
    <Box xcss={pill}>
      <Inline space="space.050" alignBlock="center">
        {version && <Person accountId={version.actor} hideDisplayName />}
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
  changed,
  previous,
  capped,
  cleared,
}: {
  version: VersionText;
  /** The fields this version changed, as the history lists them. */
  changed: Field[];
  previous: VersionText | undefined;
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
            : `The app started recording this filter here. ${gapNote}`}
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
        {changed.length > 0 && <Text>Changed: {fieldList(changed)}</Text>}
      </Stack>
    );
  // A description Jira didn't send on either side is shown as not recorded, never as unchanged.
  const shown = fields.filter(
    (field) =>
      changed.includes(field) ||
      (field === 'description' && (version.descriptionMissing || previous.descriptionMissing)),
  );
  return (
    <Stack space="space.150">
      <Heading as="h4">What changed</Heading>
      <Between from={<Side version={previous} />} to={<Side version={version} />} />
      {shown.map((field) => (
        <FieldChange key={field} field={field} before={previous} after={version} />
      ))}
      <Unchanged list={fields.filter((field) => !shown.includes(field))} />
    </Stack>
  );
}

/** Right column: what restoring this version would change in the filter now. */
function IfRestored({
  filter,
  version,
  newest,
  writes,
  onRestored,
  onFailed,
}: {
  filter: FilterNow;
  version: VersionText;
  newest: boolean;
  writes: Writes;
  onRestored: () => void;
  /** Reloads the filter, so the comparison and a retry use what Jira has now. */
  onFailed: () => void;
}) {
  // The filter as the viewer confirmed it: background reloads don't change what is restored over.
  const [confirming, setConfirming] = useState<Pick<FilterNow, 'name' | 'description' | 'jql'>>();
  // After Cancel or a failure, focus goes back to the button that opened the confirmation.
  const [refocus, setRefocus] = useState(false);
  const [error, setError] = useState<string>();
  const differences = queryFields.filter(
    (field) =>
      filter[field] !== version[field] && !(field === 'description' && version.descriptionMissing),
  );
  const restore = (expected: Pick<FilterNow, 'name' | 'description' | 'jql'>) =>
    writes.perform(async () => {
      setError(undefined);
      try {
        readRestore(
          await invoke<unknown>('restore', { filterId: filter.id, at: version.at, expected }),
        );
        setConfirming(undefined);
        onRestored();
      } catch (failed) {
        setError(failure(failed));
        setConfirming(undefined);
        setRefocus(true);
        onFailed();
      }
    });
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
          <Unchanged
            list={queryFields.filter(
              (field) =>
                !differences.includes(field) &&
                !(field === 'description' && version.descriptionMissing),
            )}
          />
        </>
      ) : (
        <Text>No differences between the current filter and this version.</Text>
      )}
      {version.descriptionMissing && (
        <Text size="small" color="color.text.subtle">
          This version&apos;s description wasn&apos;t recorded (Jira doesn&apos;t send descriptions
          over 10,000 characters), so restoring keeps the filter&apos;s current description.
        </Text>
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
          <Button
            autoFocus={refocus}
            onClick={() =>
              setConfirming({ name: filter.name, description: filter.description, jql: filter.jql })
            }
          >
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
                isLoading={writes.busy}
                onClick={() => restore(confirming)}
              >
                Restore version
              </LoadingButton>
              <Button
                appearance="subtle"
                isDisabled={writes.busy}
                onClick={() => {
                  setConfirming(undefined);
                  setRefocus(true);
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
  writes,
  onRecreated,
}: {
  filterId: string;
  version: VersionText;
  newest: boolean;
  writes: Writes;
  onRecreated: (filterId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // After Cancel or a failure, focus goes back to the button that opened the confirmation.
  const [refocus, setRefocus] = useState(false);
  const [error, setError] = useState<string>();
  const recreate = () =>
    writes.perform(async () => {
      setError(undefined);
      try {
        const { filterId: recreated } = readRecreate(
          await invoke<unknown>('recreate', { filterId, at: version.at }),
        );
        onRecreated(recreated);
      } catch (failed) {
        setError(failure(failed));
        setConfirming(false);
        setRefocus(true);
      }
    });
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
                isLoading={writes.busy}
                onClick={recreate}
              >
                Recreate filter
              </LoadingButton>
              <Button
                appearance="subtle"
                isDisabled={writes.busy}
                onClick={() => {
                  setConfirming(false);
                  setRefocus(true);
                }}
              >
                Cancel
              </Button>
            </Inline>
          </Stack>
        </SectionMessage>
      ) : (
        <Box>
          <Button appearance="primary" autoFocus={refocus} onClick={() => setConfirming(true)}>
            Recreate filter
          </Button>
        </Box>
      )}
    </Stack>
  );
}

/**
 * Asks before an administrator deletes a filter's history, then deletes it. `deleted` says which
 * history the text describes, a deleted filter's or one in Jira's, and the app refuses the other.
 */
function DeleteHistory({
  filterId,
  deleted,
  title,
  text,
  writes,
  onCancel,
  onDeleted,
}: {
  filterId: string;
  deleted: boolean;
  title: string;
  text: string;
  writes: Writes;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string>();
  const remove = () =>
    writes.perform(async () => {
      setError(undefined);
      try {
        readDeleteHistory(await invoke<unknown>('deleteHistory', { filterId, deleted }));
        onDeleted();
      } catch (failed) {
        setError(failure(failed));
      }
    });
  return (
    <SectionMessage appearance="error" title={title}>
      <Stack space="space.100">
        <Text>{text}</Text>
        {error && <Text color="color.text.danger">{error}</Text>}
        <Inline space="space.100">
          <LoadingButton appearance="danger" autoFocus isLoading={writes.busy} onClick={remove}>
            Delete history
          </LoadingButton>
          <Button appearance="subtle" isDisabled={writes.busy} onClick={onCancel}>
            Cancel
          </Button>
        </Inline>
      </Stack>
    </SectionMessage>
  );
}

function VersionDetail({
  filter,
  summary,
  version,
  previous,
  capped,
  newest,
  current,
  deleted,
  cleared,
  writes,
  onRestored,
  onFailed,
  onRecreated,
}: {
  filter: FilterNow;
  summary: HistoryVersion;
  version: VersionText;
  previous: VersionText | undefined;
  capped: boolean;
  newest: boolean;
  /** The filter in Jira matches this version. */
  current: boolean;
  deleted: { canRecreate: boolean } | null;
  cleared: boolean;
  writes: Writes;
  onRestored: () => void;
  onFailed: () => void;
  /** Absent in Jira's search modal: a deleted filter is recreated from the app's page. */
  onRecreated: ((filterId: string) => void) | undefined;
}) {
  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Heading as="h3">{when(version.at)}</Heading>
        <Person accountId={version.actor} />
        {current && <Lozenge appearance="success">Current</Lozenge>}
        {version.restored && <Lozenge appearance="information">Restored</Lozenge>}
        {version.recreated && <Lozenge appearance="information">Recreated</Lozenge>}
      </Inline>
      <Inline space="space.200" shouldWrap>
        <Box xcss={column}>
          <WhatChanged
            version={version}
            changed={summary.changed}
            previous={previous}
            capped={capped}
            cleared={cleared}
          />
        </Box>
        <Box xcss={restoreColumn}>
          {deleted && !deleted.canRecreate ? (
            <Text color="color.text.subtle">Only the filter&apos;s owner can recreate it.</Text>
          ) : deleted && !onRecreated ? (
            <Text color="color.text.subtle">
              To recreate this filter, open Filter History from Jira&apos;s Apps menu.
            </Text>
          ) : deleted && onRecreated ? (
            <Recreate
              filterId={filter.id}
              version={version}
              newest={newest}
              writes={writes}
              onRecreated={onRecreated}
            />
          ) : (
            <IfRestored
              filter={filter}
              version={version}
              newest={newest}
              writes={writes}
              onRestored={onRestored}
              onFailed={onFailed}
            />
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
  /** The newest version's time before the first change followed. */
  after: number;
  /** How many of the viewer's own changes since `after` the history should list. */
  count: number;
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

/** Loads an opened version's texts and the version's before it, then shows them. */
function VersionPanel(
  props: Omit<React.ComponentProps<typeof VersionDetail>, 'version' | 'previous'>,
) {
  const { filter, summary } = props;
  const texts = useLoad(
    async () =>
      readVersion(await invoke<unknown>('version', { filterId: filter.id, at: summary.at })),
    `${filter.id}:${summary.at}`,
  );
  if (texts.loading && !texts.value) return <Spinner label="Loading version" />;
  if (!texts.value) return <LoadError message={texts.error} onRetry={texts.reload} />;
  return (
    <VersionDetail
      {...props}
      version={texts.value.version}
      previous={texts.value.previous ?? undefined}
    />
  );
}

function FilterHistory({
  filterId: opened,
  recreatedAfter,
  onBack,
  onRecreated,
  onHistoryDeleted,
}: {
  filterId: string;
  /** Set when the filter was just recreated: the deleted filter's newest version's time. */
  recreatedAfter?: number;
  onBack?: () => void;
  onRecreated?: (filterId: string, after: number) => void;
  /** A deleted filter's history was deleted from its own screen: back to the list, saying so. */
  onHistoryDeleted?: (name: string) => void;
}) {
  const viewer = useProductContext()?.accountId;
  // A deleted filter that was recreated answers as the new filter: later loads ask for that one.
  const [filterId, setFilterId] = useState(opened);
  const history = useLoad(
    async () => readHistory(await invoke<unknown>('history', { filterId })),
    filterId,
  );
  const answeredAs = history.value?.filter.id;
  useEffect(() => {
    if (answeredAs && answeredAs !== filterId) setFilterId(answeredAs);
  }, [answeredAs, filterId]);
  const writes = useWrites();
  // The version on view, by its time; none chosen yet means the newest.
  const [selected, setSelected] = useState<number>();
  // The viewer chose a version while a change was being followed: the follow doesn't move it.
  const [chosen, setChosen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteCancelled, setDeleteCancelled] = useState(false);
  // Kept apart from the reload, so a failed reload doesn't hide that the delete succeeded.
  const [historyDeleted, setHistoryDeleted] = useState(false);
  const [follow, setFollow] = useState<Follow | undefined>(
    recreatedAfter === undefined
      ? undefined
      : { action: 'recreate', after: recreatedAfter, count: 1, tries: 0, state: 'waiting' },
  );
  // After Delete history on a filter in Jira, focus goes to the Back button.
  const [backFocus, setBackFocus] = useState(false);
  useEffect(() => {
    if (follow?.state !== 'waiting' || history.loading || !history.value) return;
    // The viewer's own changes, not someone else's edits that arrived first; all of them, when the
    // viewer restored again before the first was listed. A failed reload keeps the last answer and
    // counts as one try.
    const own = history.value.versions.filter(
      (version) =>
        version.at > follow.after &&
        (follow.action === 'restore' ? version.restored : version.recreated) &&
        (!viewer || version.actor === viewer),
    );
    if (own.length >= follow.count) {
      if (!chosen) setSelected(own[0]!.at);
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
      {/* Keyed so it mounts again, and takes focus, after a history is deleted. */}
      <Button
        key={backFocus ? 'focus' : 'idle'}
        appearance="subtle"
        autoFocus={backFocus}
        isDisabled={writes.busy}
        onClick={onBack}
      >
        ← All filters
      </Button>
    </Box>
  );
  if (history.loading && !history.value) return <Spinner label="Loading filter history" />;
  if (!history.value)
    return (
      <Stack space="space.200">
        {back}
        {recreatedAfter !== undefined && (
          <SectionMessage appearance="success" title="Recreated">
            <Text>The filter is recreated in Jira, but its history didn&apos;t load.</Text>
          </SectionMessage>
        )}
        <LoadError message={history.error} onRetry={history.reload} />
      </Stack>
    );
  const { filter, versions, more, deleted, cleared, admin } = history.value;
  const found = versions.findIndex((version) => version.at === selected);
  const index = found >= 0 ? found : 0;
  // "Current" only when the filter in Jira still matches the newest version: a change the app
  // didn't record (such as one made without a subscription) means no version is current.
  const current = !deleted && history.value.current;
  const rows = versions.map((version, row) => ({
    key: String(version.at),
    // Per row, since the table's highlighted index counts from the page shown.
    isHighlighted: row === index,
    cells: [
      { key: 'when', content: when(version.at) },
      { key: 'actor', content: <Person accountId={version.actor} /> },
      {
        key: 'changed',
        content: (
          <Inline space="space.050" shouldWrap>
            {row === 0 && current && <Lozenge appearance="success">Current</Lozenge>}
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
            isDisabled={writes.busy}
            // The viewer's restored version, once listed, mounts as a new row and takes focus.
            autoFocus={row === index && follow?.action === 'restore' && follow.state === 'listed'}
            onClick={() => {
              setSelected(version.at);
              if (follow?.state === 'waiting') setChosen(true);
              // A finished restore's message has served its turn once another version is viewed.
              else if (follow?.action === 'restore') setFollow(undefined);
            }}
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
              <Person accountId={filter.owner} />
            </Inline>
            {versions.length > 0 && (
              <Text color="color.text.subtle">
                {more ? `The latest ${versions.length} versions. Older ones aren't kept.` : count}
              </Text>
            )}
          </Inline>
        </Stack>
        {admin && onBack && versions.length > 0 && !deleting && (
          <Button
            appearance="subtle"
            autoFocus={deleteCancelled}
            isDisabled={writes.busy}
            onClick={() => setDeleting(true)}
          >
            Delete history
          </Button>
        )}
      </Inline>
      {deleted && (
        <SectionMessage appearance="information" title="This filter was deleted">
          <Stack space="space.100">
            <Inline space="space.050" alignBlock="center" shouldWrap>
              <Text>Deleted on {when(deleted.at)} by</Text>
              <Person accountId={deleted.actor} />
            </Inline>
            <Text>
              {deleted.canRecreate
                ? 'As its owner, you can recreate the filter from any version. Jira administrators can view this history too.'
                : 'Only its owner can recreate the filter. Jira administrators and the owner can view this history.'}{' '}
              The history is removed from {day(deleted.expires)}.
            </Text>
          </Stack>
        </SectionMessage>
      )}
      {follow?.action === 'recreate' && (
        <Stack space="space.100">
          <FollowMessage follow={follow} name={filter.name} />
          <Box>
            {/* The recreated filter's screen opens here, so focus starts on its next step. */}
            <Button autoFocus onClick={() => void router.navigate(`/issues/?filter=${filter.id}`)}>
              Open in Jira&apos;s search
            </Button>
          </Box>
        </Stack>
      )}
      {deleting && (
        <DeleteHistory
          filterId={filter.id}
          deleted={Boolean(deleted)}
          writes={writes}
          title={`Delete history for “${filter.name}”?`}
          text={
            deleted
              ? `This permanently deletes ${more ? 'all recorded versions' : `all ${count}`} of this deleted filter for all users, and its owner can no longer recreate it. This can't be undone.`
              : `This permanently deletes ${more ? 'all recorded versions' : `all ${count}`} of this filter for all users. The filter in Jira isn't changed, and its next change starts a new history. The history will show that you deleted it, and when. This can't be undone.`
          }
          onCancel={() => {
            setDeleting(false);
            setDeleteCancelled(true);
          }}
          onDeleted={() => {
            setDeleting(false);
            // A deleted filter's history is gone entirely: back to the list, which says so.
            if (deleted && onHistoryDeleted) onHistoryDeleted(filter.name);
            else {
              setHistoryDeleted(true);
              setBackFocus(true);
              history.reload();
            }
          }}
        />
      )}
      {historyDeleted && (
        <SectionMessage appearance="success">
          <Text>History deleted.</Text>
        </SectionMessage>
      )}
      {cleared && (
        <SectionMessage appearance="information" title="Earlier history deleted">
          <Inline space="space.050" alignBlock="center" shouldWrap>
            <Text>Deleted on {when(cleared.at)} by</Text>
            <Person accountId={cleared.actor} />
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
          description={`Changes to this filter appear here from now on. ${gapNote}`}
        />
      )}
      {follow?.action === 'restore' && <FollowMessage follow={follow} name={filter.name} />}
      {versions[index] && (
        <VersionPanel
          key={versions[index].at}
          filter={filter}
          summary={versions[index]}
          capped={more}
          newest={index === 0}
          current={index === 0 && current}
          deleted={deleted}
          cleared={cleared !== null}
          writes={writes}
          onFailed={history.reload}
          onRestored={() => {
            setChosen(false);
            // A restore made while an earlier one is still awaited waits for both.
            setFollow((previous) =>
              previous?.action === 'restore' && previous.state === 'waiting'
                ? { ...previous, count: previous.count + 1, tries: 0 }
                : {
                    action: 'restore',
                    after: versions[0]?.at ?? 0,
                    count: 1,
                    tries: 0,
                    state: 'waiting',
                  },
            );
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
  admin,
  term,
  onOpen,
}: {
  filters: OverviewRow[];
  partial: boolean;
  admin: boolean;
  term: string;
  onOpen: (filterId: string) => void;
}) {
  // The page looks at the 1,000 most recently changed filters with history; on a site with more,
  // an older one opens from Jira's search.
  if (!filters.length)
    return partial ? (
      <EmptyState
        header="No recently changed filters you can see"
        description="The page looks at the 1,000 most recently changed filters with history, and you can't see any of them. Open an older filter's history from Jira's search."
      />
    ) : (
      <EmptyState
        header="No filter changes recorded yet"
        description={`When someone creates or edits a saved filter you can see, its history appears here. ${gapNote}`}
      />
    );
  const more = partial && (
    <SectionMessage appearance="warning">
      <Text>
        This site has more filters with history than the page looks at once: it lists the ones you
        can see among the 1,000 most recently changed. Open an older filter&apos;s history from
        Jira&apos;s search.
      </Text>
    </SectionMessage>
  );
  const shown = filters.filter((row) => row.name.toLowerCase().includes(term));
  return (
    <Stack space="space.200">
      <Text>
        {admin
          ? 'Saved filters with changes recorded by the app. As a Jira administrator, you see every filter, including private ones.'
          : 'Saved filters you can see with changes recorded by the app.'}
      </Text>
      {more}
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
            { key: 'owner', content: <Person accountId={row.owner} /> },
            { key: 'at', content: when(row.at) },
            { key: 'actor', content: <Person accountId={row.actor} /> },
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
  done: deletedFrom,
  onOpen,
  onDeleted,
}: {
  deleted: DeletedRow[];
  partial: boolean;
  admin: boolean;
  term: string;
  /** The name of a filter whose history was just deleted from its own screen. */
  done: string | undefined;
  onOpen: (filterId: string) => void;
  onDeleted: () => void;
}) {
  const writes = useWrites();
  const [asking, setAsking] = useState<DeletedRow>();
  // After Cancel, focus goes back to that row's Delete history button, which is keyed by the round
  // so it mounts again (and takes focus) each time.
  const [returnTo, setReturnTo] = useState<{ filterId: string; round: number }>();
  const [done, setDone] = useState(deletedFrom);
  const shown = deleted.filter((row) => row.name.toLowerCase().includes(term));
  return (
    <Stack space="space.200">
      <Text>
        {admin
          ? "Every deleted filter with kept history. Only a filter's owner can recreate it; Jira administrators can permanently delete its history."
          : 'Deleted filters you owned. You can view their history and recreate them.'}
      </Text>
      {partial && (
        <SectionMessage appearance="warning">
          <Text>
            This site has more deleted filters than the page looks at once: it lists
            {admin ? ' ' : ' the ones you owned among '}the 1,000 most recently deleted.
          </Text>
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
          deleted
          writes={writes}
          title={`Delete history for “${asking.name}”?`}
          text="This permanently deletes all recorded versions of this filter for all users. This can't be undone."
          onCancel={() => {
            setReturnTo({ filterId: asking.filterId, round: (returnTo?.round ?? 0) + 1 });
            setAsking(undefined);
          }}
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
              content: (
                <Button
                  appearance="subtle"
                  isDisabled={writes.busy}
                  onClick={() => onOpen(row.filterId)}
                >
                  {row.name}
                </Button>
              ),
            },
            { key: 'owner', content: <Person accountId={row.owner} /> },
            { key: 'at', content: when(row.at) },
            { key: 'actor', content: <Person accountId={row.actor} /> },
            { key: 'expires', content: day(row.expires) },
            ...(admin
              ? [
                  {
                    key: 'delete',
                    content: (
                      <Button
                        key={returnTo?.filterId === row.filterId ? returnTo.round : 0}
                        appearance="subtle"
                        autoFocus={returnTo?.filterId === row.filterId}
                        isDisabled={writes.busy}
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
            {deleted.length
              ? 'No deleted filter matches that name.'
              : partial
                ? 'None of the 1,000 most recently deleted filters was yours.'
                : 'No deleted filters.'}
          </Text>
        }
      />
    </Stack>
  );
}

function Overview({
  tab,
  notice,
  onTab,
  onOpen,
}: {
  tab: number;
  /** The name of a deleted filter whose history was just deleted from its own screen. */
  notice: string | undefined;
  onTab: (tab: number) => void;
  onOpen: (filterId: string) => void;
}) {
  const overview = useLoad(async () => readOverview(await invoke<unknown>('overview')), 'overview');
  const [search, setSearch] = useState('');
  // After a history is deleted, its row is gone: focus goes to the search field, which is keyed by
  // the round so it mounts again (and takes focus) each time.
  const [focusRound, setFocusRound] = useState(notice === undefined ? 0 : 1);
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
          key={focusRound}
          id="filter-search"
          autoFocus={focusRound > 0}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </Stack>
      <Tabs id="filter-history-tabs" selected={tab} onChange={onTab}>
        <TabList>
          <Tab>Filters</Tab>
          <Tab>{`Deleted filters (${deleted.length}${deletedPartial ? '+' : ''})`}</Tab>
        </TabList>
        <TabPanel>
          <Box xcss={tabPanel}>
            <FilterList
              filters={filters}
              partial={partial}
              admin={admin}
              term={term}
              onOpen={onOpen}
            />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={tabPanel}>
            <DeletedList
              deleted={deleted}
              partial={deletedPartial}
              admin={admin}
              term={term}
              done={notice}
              onOpen={onOpen}
              onDeleted={() => {
                setFocusRound((round) => round + 1);
                overview.reload();
              }}
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
  const [notice, setNotice] = useState<string>();
  return open ? (
    <FilterHistory
      key={open.filterId}
      filterId={open.filterId}
      {...(open.recreatedAfter === undefined ? {} : { recreatedAfter: open.recreatedAfter })}
      onBack={() => setOpen(undefined)}
      onRecreated={(filterId, recreatedAfter) => setOpen({ filterId, recreatedAfter })}
      onHistoryDeleted={(name) => {
        setNotice(name);
        setOpen(undefined);
      }}
    />
  ) : (
    <Overview
      tab={tab}
      notice={notice}
      onTab={setTab}
      onOpen={(filterId) => {
        setNotice(undefined);
        setOpen({ filterId });
      }}
    />
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
