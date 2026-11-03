import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ManagedHonchoStatus, SpaceMemoryConfig } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, Spinner } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { ManagedHonchoMemory } from "./ManagedHonchoMemory";

export function ManagedHonchoSettings({
  status,
  config,
  onChange,
}: {
  status: ManagedHonchoStatus | undefined;
  config: SpaceMemoryConfig | null;
  onChange: () => void;
}) {
  const embeddingId = useId();
  const baseUrlId = useId();
  const keyId = useId();
  const dimensionsId = useId();
  const workersId = useId();
  const [embeddingModel, setEmbeddingModel] = useState("text-embedding-3-small");
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [dimensions, setDimensions] = useState("1536");
  const [workers, setWorkers] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rpc = useSpaceRpc();

  useEffect(() => {
    const settings = status?.settings;
    if (!settings) return;
    setEmbeddingModel(settings.embeddingModel ?? "text-embedding-3-small");
    setEmbeddingBaseUrl(settings.embeddingBaseUrl ?? "");
    setDimensions(settings.embeddingDimensions ?? "1536");
    setWorkers(settings.deriverWorkers ?? "1");
  }, [status?.settings]);

  async function apply(restart = false) {
    setBusy(true);
    setError(null);
    try {
      await rpc.memory.updateManaged({
        embeddingModel,
        embeddingBaseUrl,
        ...(embeddingApiKey ? { embeddingApiKey } : {}),
        embeddingDimensions: Number(dimensions),
        deriverWorkers: Number(workers),
      });
      await rpc.memory.applyManaged({ restart });
      setEmbeddingApiKey("");
      onChange();
    } catch (err) {
      setError(errorText(err, "Could not apply Honcho configuration"));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <Spinner aria-label={t`Loading Honcho status…`} />;
  if (!status.canManage) return null;
  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[14px] font-medium text-foreground">
          <Trans>Built-in service</Trans>
        </h4>
        <span
          className={`text-[13px] ${status.status === "connected" ? "text-success" : "text-warning"}`}
        >
          {status.status === "connected" ? <Trans>Running</Trans> : <Trans>Needs attention</Trans>}
        </span>
      </div>
      {status.error ? <p className="text-[13px] text-destructive">{status.error}</p> : null}
      <div className="grid grid-cols-2 gap-2 text-[13px] text-muted-foreground">
        <span>
          <Trans>API</Trans>
        </span>
        <span>{status.components.api ? <Trans>Running</Trans> : <Trans>Stopped</Trans>}</span>
        <span>
          <Trans>PostgreSQL</Trans>
        </span>
        <span>{status.database ? <Trans>Connected</Trans> : "—"}</span>
        <span>
          <Trans>Redis cache</Trans>
        </span>
        <span>{status.cache ? <Trans>Connected</Trans> : "—"}</span>
      </div>
      <Field>
        <FieldLabel htmlFor={embeddingId}>
          <Trans>Embedding model</Trans>
        </FieldLabel>
        <Input
          id={embeddingId}
          value={embeddingModel}
          disabled={busy}
          onChange={(event) => setEmbeddingModel(event.target.value)}
        />
      </Field>
      <Field>
        <p className="text-[13px] text-muted-foreground">
          <Trans>
            Use an OpenAI-compatible embeddings service; chat providers may not support embeddings.
          </Trans>
        </p>
        <FieldLabel htmlFor={baseUrlId}>
          <Trans>Embedding base URL</Trans>
        </FieldLabel>
        <Input
          id={baseUrlId}
          value={embeddingBaseUrl}
          disabled={busy}
          placeholder="https://api.openai.com/v1"
          onChange={(event) => setEmbeddingBaseUrl(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={keyId}>
          <Trans>Embedding API key</Trans>
        </FieldLabel>
        <Input
          id={keyId}
          value={embeddingApiKey}
          disabled={busy}
          type="password"
          autoComplete="new-password"
          onChange={(event) => setEmbeddingApiKey(event.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor={dimensionsId}>
            <Trans>Dimensions</Trans>
          </FieldLabel>
          <Input
            id={dimensionsId}
            type="number"
            min="1"
            max="2000"
            value={dimensions}
            disabled={busy}
            onChange={(event) => setDimensions(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={workersId}>
            <Trans>Deriver workers</Trans>
          </FieldLabel>
          <Input
            id={workersId}
            type="number"
            min="1"
            max="32"
            value={workers}
            disabled={busy}
            onChange={(event) => setWorkers(event.target.value)}
          />
        </Field>
      </div>
      {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !config}
          onClick={() => void apply()}
        >
          {busy ? <Trans>Applying…</Trans> : <Trans>Apply configuration</Trans>}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !config}
          onClick={() => void apply(true)}
        >
          <Trans>Restart</Trans>
        </Button>
      </div>
      <ManagedHonchoMemory status={status} />
    </div>
  );
}
