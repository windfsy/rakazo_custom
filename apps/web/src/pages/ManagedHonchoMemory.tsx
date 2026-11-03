import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ManagedHonchoConclusion, ManagedHonchoStatus } from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption, Textarea } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

const NO_CONCLUSIONS: ManagedHonchoConclusion[] = [];

/** Cosine distance (0 identical, smaller is closer) as a 0-100 similarity percentage. */
function similarity(distance: number): string {
  return Math.max(0, Math.round((1 - distance) * 100)).toString();
}

/** Browse and curate the conclusions the built-in Honcho service holds for this Space. */
export function ManagedHonchoMemory({ status }: { status: ManagedHonchoStatus }) {
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const client = useQueryClient();
  const searchId = useId();
  const [observerId, setObserverId] = useState("");
  const [observedId, setObservedId] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const peersQuery = useQuery(queries.memory.managedMemoryPeers.queryOptions({ input: {} }));
  const peers = peersQuery.data?.items ?? [];

  useEffect(() => {
    if (peers.length === 0) return;
    setObserverId((current) => (current && peers.includes(current) ? current : (peers[0] ?? "")));
    setObservedId((current) => (current && peers.includes(current) ? current : (peers[0] ?? "")));
  }, [peers]);

  const [searchPair, setSearchPair] = useState<{ observerId: string; observedId: string } | null>(
    null,
  );
  const listQuery = useQuery(
    queries.memory.managedMemoryList.queryOptions({
      input: searchPair ?? {},
      ...(searchPair ? {} : { enabled: false }),
    }),
  );
  const conclusions: ManagedHonchoConclusion[] = searchPair
    ? (listQuery.data?.items ?? NO_CONCLUSIONS)
    : NO_CONCLUSIONS;
  const searched = searchPair !== null;

  function search() {
    if (!observerId || !observedId) return;
    setError(null);
    setSearchPair({ observerId, observedId });
  }

  async function refreshList() {
    if (!searchPair) return;
    await client.refetchQueries({
      queryKey: queries.memory.managedMemoryList.queryKey({ input: searchPair }),
    });
  }

  async function remove(conclusionId: string) {
    if (!window.confirm(t`Delete this memory? This cannot be undone.`)) return;
    setError(null);
    setBusy(true);
    try {
      await rpc.memory.managedMemoryDelete({ conclusionId });
      await refreshList();
    } catch (err) {
      setError(errorText(err, "Could not delete memory"));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!draft.trim() || !observerId || !observedId) return;
    setError(null);
    setBusy(true);
    try {
      await rpc.memory.managedMemoryCreate({
        content: draft.trim(),
        observerId,
        observedId,
      });
      setDraft("");
      setAdding(false);
      await refreshList();
    } catch (err) {
      setError(errorText(err, "Could not save memory"));
    } finally {
      setBusy(false);
    }
  }

  if (!status.enabled) return null;
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      <h4 className="text-[14px] font-medium text-foreground">
        <Trans>Memory</Trans>
      </h4>
      {peers.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          <Trans>No memory has been saved yet.</Trans>
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <NativeSelect
              aria-label={t`Observer`}
              value={observerId}
              disabled={busy}
              onChange={(event) => setObserverId(event.target.value)}
            >
              {peers.map((peer) => (
                <NativeSelectOption key={peer} value={peer}>
                  {peer}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={t`Observed`}
              value={observedId}
              disabled={busy}
              onChange={(event) => setObservedId(event.target.value)}
            >
              {peers.map((peer) => (
                <NativeSelectOption key={peer} value={peer}>
                  {peer}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex gap-2">
            <Input
              id={searchId}
              value={query}
              disabled={busy}
              placeholder={t`Search memory by meaning`}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") search();
              }}
            />
            <Button type="button" variant="outline" disabled={busy} onClick={search}>
              <Search aria-hidden="true" />
              <Trans>Search</Trans>
            </Button>
          </div>
          <p className="text-[13px] text-muted-foreground">
            <Trans>
              What bots remember about <span className="tabular-nums">{observedId}</span> as seen by{" "}
              <span className="tabular-nums">{observerId}</span>.
            </Trans>
          </p>
          {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
          {searched ? (
            <ul className="space-y-2">
              {conclusions.map((conclusion) => (
                <li
                  key={conclusion.id}
                  className="flex items-start justify-between gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] break-words text-foreground">{conclusion.content}</p>
                    <p className="text-[13px] text-muted-foreground">
                      {typeof conclusion.distance === "number"
                        ? t`${similarity(conclusion.distance)}% match · ${conclusion.level ?? ""}`.trim()
                        : conclusion.level}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={t`Delete this memory`}
                    disabled={busy}
                    onClick={() => void remove(conclusion.id)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              ))}
              {conclusions.length === 0 ? (
                <li className="text-[13px] text-muted-foreground">
                  <Trans>Nothing recorded for this pair yet.</Trans>
                </li>
              ) : null}
            </ul>
          ) : null}
          {adding ? (
            <div className="space-y-2">
              <Textarea
                value={draft}
                disabled={busy}
                placeholder={t`Write what should be remembered`}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={busy || !draft.trim()}
                  onClick={() => void create()}
                >
                  <Trans>Save</Trans>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setAdding(false);
                    setDraft("");
                  }}
                >
                  <Trans>Cancel</Trans>
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="outline" disabled={busy} onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" />
              <Trans>Add memory</Trans>
            </Button>
          )}
        </>
      )}
    </div>
  );
}
