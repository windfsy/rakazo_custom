import { Trans, useLingui } from "@lingui/react/macro";
import type { NativeMemoryState } from "@rakazo/contracts";
import { Button, Field, FieldError, FieldLabel, Input, SectionHeading } from "@rakazo/ui-web";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

/**
 * The embedding endpoint memory uses. It lives in Models because it is model
 * configuration: the model, where it is served, its key, and the vector size it
 * returns. Saving probes the endpoint, so a wrong setting fails here rather than
 * at the next recall.
 */
export function MemoryEmbeddingSection() {
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const { t } = useLingui();
  const [state, setState] = useState<NativeMemoryState | null>(null);
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // A server without the built-in provider (or an older one) serves no state, and a
    // harness may stub only part of the router: leave the section empty instead of
    // breaking the Models panel.
    const read = rpc.memory?.nativeState;
    if (!read) return;
    void read
      .call(rpc.memory)
      .then((next) => {
        setState(next);
        setModel(next.settings.embeddingModel ?? "");
        setBaseUrl(next.settings.embeddingBaseUrl ?? "");
        setDimensions(
          next.settings.embeddingDimensions ? String(next.settings.embeddingDimensions) : "",
        );
      })
      .catch(() => undefined);
  }, [rpc]);

  const parsedDimensions = dimensions.trim() ? Number(dimensions.trim()) : undefined;
  const dimensionsValid =
    parsedDimensions === undefined ||
    (Number.isInteger(parsedDimensions) && parsedDimensions >= 1 && parsedDimensions <= 65_535);
  const ready = model.trim().length > 0 && /^https?:\/\//.test(baseUrl.trim()) && dimensionsValid;

  async function save() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const next = await rpc.memory.nativeUpdate({
        embeddingModel: model.trim(),
        embeddingBaseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { embeddingApiKey: apiKey.trim() } : {}),
        ...(parsedDimensions ? { embeddingDimensions: parsedDimensions } : {}),
      });
      // The key is never shown again; the stored hint tells a member which one is set.
      setApiKey("");
      setState(next);
      setNotice(t`Embedding settings saved.`);
    } catch (err) {
      setError(errorText(err, t`Could not save the embedding settings`));
    } finally {
      setBusy(false);
    }
  }

  async function rebuild() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { reembedded } = await rpc.memory.nativeReembed();
      setNotice(t`Rebuilt ${reembedded} memories.`);
      await queryClient.invalidateQueries({
        queryKey: queries.memory.nativeFactList.queryKey({ input: {} }),
      });
    } catch (err) {
      setError(errorText(err, t`Could not rebuild memories`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-8" data-testid="memory-embedding">
      <SectionHeading className="mb-2.5">
        <Trans>Memory embeddings</Trans>
      </SectionHeading>
      <p className="mb-3 text-[13px] text-muted-foreground">
        <Trans>The embedding model memories are stored and recalled with.</Trans>
      </p>

      <div className="space-y-3">
        <Field>
          <FieldLabel htmlFor="memory-embedding-model">
            <Trans>Model</Trans>
          </FieldLabel>
          <Input
            id="memory-embedding-model"
            value={model}
            disabled={busy}
            onChange={(event) => setModel(event.target.value)}
            placeholder="text-embedding-3-small"
            maxLength={200}
            autoComplete="off"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="memory-embedding-base-url">
            <Trans>Base URL</Trans>
          </FieldLabel>
          <Input
            id="memory-embedding-base-url"
            value={baseUrl}
            disabled={busy}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.openai.com/v1"
            maxLength={2000}
            autoComplete="off"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="memory-embedding-api-key">
            <Trans>API key</Trans>
          </FieldLabel>
          <Input
            id="memory-embedding-api-key"
            value={apiKey}
            disabled={busy}
            onChange={(event) => setApiKey(event.target.value)}
            type="password"
            autoComplete="new-password"
            maxLength={4096}
            placeholder={
              state?.settings.embeddingApiKeyHint
                ? t`Stored key ${state.settings.embeddingApiKeyHint}`
                : undefined
            }
          />
          <p className="mt-2 text-[13px] text-muted-foreground">
            {state?.settings.embeddingApiKeyHint ? (
              <Trans>Leave empty to keep the stored key.</Trans>
            ) : (
              <Trans>The key is stored encrypted and never shown again.</Trans>
            )}
          </p>
        </Field>

        <Field data-invalid={dimensionsValid ? undefined : true}>
          <FieldLabel htmlFor="memory-embedding-dimensions">
            <Trans>Dimensions</Trans>
          </FieldLabel>
          <Input
            id="memory-embedding-dimensions"
            value={dimensions}
            disabled={busy}
            onChange={(event) => setDimensions(event.target.value)}
            placeholder={t`From the model`}
            inputMode="numeric"
            aria-invalid={dimensionsValid ? undefined : true}
            autoComplete="off"
          />
          <p className="mt-2 text-[13px] text-muted-foreground">
            {dimensionsValid ? (
              <Trans>
                Leave empty to use the size the model reports. Saving checks it against the
                endpoint.
              </Trans>
            ) : (
              <FieldError>
                <Trans>Use a whole number between 1 and 65535.</Trans>
              </FieldError>
            )}
          </p>
        </Field>
      </div>

      {error ? <FieldError className="mt-3">{error}</FieldError> : null}
      {notice ? (
        <p className="mt-3 text-[13px] text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy || !ready}
          onClick={() => void save()}
        >
          {busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy || !state}
          onClick={() => void rebuild()}
        >
          <Trans>Rebuild memories</Trans>
        </Button>
      </div>
      <p className="mt-2 text-[13px] text-muted-foreground">
        <Trans>
          Rebuild after changing the model or its dimensions: vectors from different models are not
          comparable, so stored memories must be embedded again.
        </Trans>
      </p>
      {state?.status === "degraded" && state.error ? (
        <p className="mt-2 text-[13px] text-destructive">{state.error}</p>
      ) : null}
    </section>
  );
}
