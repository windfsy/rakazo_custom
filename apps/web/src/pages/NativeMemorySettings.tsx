import { Trans, useLingui } from "@lingui/react/macro";
import type { NativeMemoryFact, NativeMemoryState, SpaceMemoryConfig } from "@rakazo/contracts";
import { Button, Field, FieldError, FieldLabel, Input, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

function similarity(distance: number): string {
  return `${Math.max(0, Math.round((1 - distance) * 100))}%`;
}

export function NativeMemorySettings({
  config,
  onNativeConnect,
}: {
  config: SpaceMemoryConfig;
  onNativeConnect: () => void;
}) {
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const { t } = useLingui();
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const stateQuery = useQuery(queries.memory.nativeState.queryOptions({ input: {} }));
  const state = stateQuery.data;

  useEffect(() => {
    if (!state) return;
    setModel((current) => current || state.settings.embeddingModel || "");
    setBaseUrl((current) => current || state.settings.embeddingBaseUrl || "");
  }, [state]);

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

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await rpc.memory.nativeUpdate({
        embeddingModel: model.trim(),
        embeddingBaseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { embeddingApiKey: apiKey.trim() } : {}),
      });
      setApiKey("");
      await stateQuery.refetch();
    } catch (err) {
      setError(errorText(err, t`Could not save the embedding settings`));
    } finally {
      setBusy(false);
    }
  }

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

  const ready = model.trim().length > 0 && /^https?:\/\//.test(baseUrl.trim());

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
            <Trans>Configure the embedding endpoint to finish setting up memory.</Trans>
          )}
        </p>
      ) : null}

      <section className="space-y-4">
        <Field>
          <FieldLabel htmlFor="native-embedding-model">
            <Trans>Embedding model</Trans>
          </FieldLabel>
          <Input
            id="native-embedding-model"
            value={model}
            disabled={busy}
            onChange={(event) => setModel(event.target.value)}
            placeholder="text-embedding-3-small"
            maxLength={200}
            autoComplete="off"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="native-embedding-base-url">
            <Trans>Embedding base URL</Trans>
          </FieldLabel>
          <Input
            id="native-embedding-base-url"
            value={baseUrl}
            disabled={busy}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.openai.com/v1"
            maxLength={2000}
            autoComplete="off"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="native-embedding-api-key">
            <Trans>Embedding API key</Trans>
          </FieldLabel>
          <Input
            id="native-embedding-api-key"
            value={apiKey}
            disabled={busy}
            onChange={(event) => setApiKey(event.target.value)}
            type="password"
            autoComplete="new-password"
            maxLength={4096}
          />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <Button
          type="button"
          variant="outline"
          disabled={busy || !ready}
          onClick={() => void save()}
        >
          {busy ? <Trans>Saving…</Trans> : <Trans>Save embedding settings</Trans>}
        </Button>
      </section>

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
