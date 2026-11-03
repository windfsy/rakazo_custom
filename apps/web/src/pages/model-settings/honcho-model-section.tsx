import { Trans } from "@lingui/react/macro";
import type { ManagedHonchoStatus } from "@rakazo/contracts";
import { Button, Field, FieldLabel, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

/**
 * Which connection the built-in Honcho service reasons with. It either follows
 * the personal Space's main model or pins one connection; applying restarts
 * the service so the container env picks the choice up.
 */
export function HonchoModelSection() {
  const rpc = useSpaceRpc();
  const [status, setStatus] = useState<ManagedHonchoStatus | null>(null);
  const [modelMode, setModelMode] = useState<"main" | "fixed">("main");
  const [credentialId, setCredentialId] = useState("");
  const [credentials, setCredentials] = useState<
    Awaited<ReturnType<typeof rpc.models.credentials>>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void rpc.memory
      ?.managedStatus()
      .then((next) => {
        setStatus(next);
        setModelMode(next.settings?.modelMode === "fixed" ? "fixed" : "main");
        setCredentialId(next.settings?.credentialId ?? "");
      })
      .catch(() => undefined);
    void rpc.models
      .credentials()
      .then(setCredentials)
      .catch(() => undefined);
  }, [rpc]);

  if (!status?.enabled || !status.canManage) return null;

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await rpc.memory.updateManaged({
        modelMode,
        ...(modelMode === "fixed" && credentialId ? { credentialId } : {}),
      });
      await rpc.memory.applyManaged({ restart: false });
      const next = await rpc.memory.managedStatus();
      setStatus(next);
    } catch (err) {
      setError(errorText(err, "Could not apply the memory model"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-[14px] font-medium text-foreground">
        <Trans>Built-in memory model</Trans>
      </h3>
      <p className="text-[13px] text-muted-foreground">
        <Trans>Model the built-in memory service reasons with.</Trans>
      </p>
      <Field>
        <FieldLabel>
          <Trans>Reasoning model</Trans>
        </FieldLabel>
        <NativeSelect
          value={modelMode}
          disabled={busy}
          onChange={(event) => setModelMode(event.target.value as "main" | "fixed")}
        >
          <NativeSelectOption value="main">
            <Trans>Follow main model</Trans>
          </NativeSelectOption>
          <NativeSelectOption value="fixed">
            <Trans>Fixed connection</Trans>
          </NativeSelectOption>
        </NativeSelect>
      </Field>
      {modelMode === "fixed" ? (
        <Field>
          <FieldLabel>
            <Trans>Model connection</Trans>
          </FieldLabel>
          <NativeSelect
            value={credentialId}
            disabled={busy}
            onChange={(event) => setCredentialId(event.target.value)}
          >
            <NativeSelectOption value="">
              <Trans>Choose a connection</Trans>
            </NativeSelectOption>
            {credentials.map((credential) => (
              <NativeSelectOption key={credential.id} value={credential.id}>
                {credential.label}
                {credential.modelId ? ` · ${credential.modelId}` : ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      {error ? (
        <p className="text-[13px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="button" variant="secondary" disabled={busy} onClick={() => void apply()}>
        {busy ? <Trans>Applying…</Trans> : <Trans>Apply configuration</Trans>}
      </Button>
    </div>
  );
}
