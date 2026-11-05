import { Trans, useLingui } from "@lingui/react/macro";
import type { NativeMemoryFact } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

function similarity(distance: number): string {
  return `${Math.max(0, Math.round((1 - distance) * 100))}%`;
}

export function NativeMemorySettings() {
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const { t } = useLingui();
  const [_error, setError] = useState<string | null>(null);
  const [_busy, _setBusy] = useState(false);

  const stateQuery = useQuery(queries.memory.nativeState.queryOptions({ input: {} }));
  const state = stateQuery.data;

  const observersQuery = useQuery(queries.memory.nativeFactObservers.queryOptions({ input: {} }));
  const observers = observersQuery.data?.items ?? [];
  const [observer, setObserver] = useState<string>("");
  const [query, setQuery] = useState("");
  const [searchPair, setSearchPair] = useState<{ observer?: string; query?: string } | null>(null);

  useEffect(() => {
    setObserver((current) =>
      current && observers.includes(current) ? current : (observers[0] ?? ""),
    );
  }, [observers]);

  const factsQuery = useQuery(
    queries.memory.nativeFactList.queryOptions({
      input: {
        ...(searchPair?.observer ? { observer: searchPair.observer } : {}),
        ...(searchPair?.query ? { query: searchPair.query } : {}),
      },
    }),
  );

  async function refreshFacts() {
    await factsQuery.refetch();
  }

  async function deleteFact(factId: string) {
    setError(null);
    try {
      await rpc.memory.nativeFactDelete({ factId });
      await refreshFacts();
    } catch (err) {
      setError(errorText(err, t`Could not delete the memory`));
    }
  }

  return (
    <div className="mt-5 space-y-5 border-t border-border pt-5">
      {state ? (
        <p className="text-[13px] text-muted-foreground">
          {state.status === "connected" ? (
            <Trans>
              Connected{state.settings.embeddingModel ? ` · ${state.settings.embeddingModel}` : ""}
            </Trans>
          ) : state.status === "degraded" ? (
            <Trans>Needs attention: {state.error ?? "the embedding endpoint is unreachable"}</Trans>
          ) : (
            <Trans>Set up the embedding model in Models to start saving memories.</Trans>
          )}
        </p>
      ) : null}

      <section className="space-y-3 border-t border-border pt-5">
        <h4 className="text-heading3 font-medium text-foreground">
          <Trans>Memories</Trans>
        </h4>
        <div className="flex flex-wrap items-end gap-2">
          <Field>
            <FieldLabel htmlFor="native-fact-observer">
              <Trans>Observer</Trans>
            </FieldLabel>
            <select
              id="native-fact-observer"
              value={observer}
              onChange={(event) => setObserver(event.target.value)}
              className="h-9 rounded-lg border border-border bg-background px-3 text-[14px]"
            >
              {observers.length === 0 ? (
                <option value="">{t`No memories yet`}</option>
              ) : (
                observers.map((option) => (
                  <option key={option} value={option}>
                    {option === "shared" ? t`Shared` : option}
                  </option>
                ))
              )}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="native-fact-search">
              <Trans>Search</Trans>
            </FieldLabel>
            <Input
              id="native-fact-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t`Search memories`}
              maxLength={10_000}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={!observer && observers.length > 0}
            onClick={() =>
              setSearchPair({ observer, ...(query.trim() ? { query: query.trim() } : {}) })
            }
          >
            <Trans>Search</Trans>
          </Button>
        </div>

        {factsQuery.isLoading ? (
          <p className="text-[13px] text-muted-foreground">
            <Spinner aria-label={t`Loading memories…`} />
          </p>
        ) : factsQuery.data && factsQuery.data.items.length > 0 ? (
          <ul className="space-y-2">
            {factsQuery.data.items.map((fact: NativeMemoryFact) => (
              <li
                key={fact.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-[14px] text-foreground">{fact.content}</p>
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    {fact.observer === "shared" ? t`Shared` : fact.observer}
                    {fact.distance !== undefined
                      ? ` · ${similarity(fact.distance)}% ${t`match`}`
                      : ""}
                    {` · ${fact.level}`}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Delete memory`}
                  onClick={() => void deleteFact(fact.id)}
                >
                  <Trans>Delete</Trans>
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            <Trans>No memories yet.</Trans>
          </p>
        )}
      </section>
    </div>
  );
}
