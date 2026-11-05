import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

/** The built-in provider: enabling it needs no endpoint or credentials. */
export function NativeSettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  async function connect() {
    const draft: MemoryProviderConnectionDraft = {
      settings: {},
      credentials: {},
    };
    await onConnect(draft);
  }

  return (
    <>
      <p className="mt-3 text-[13px] text-muted-foreground">
        <Trans>
          Facts live in this deployment's database, encrypted, and recall uses the embedding
          endpoint below.
        </Trans>
      </p>
      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
