# Memory

Bots remember what matters between conversations, and you can read, download or delete anything they
keep.

## What a bot remembers

Each bot writes notes as it works: your preferences, facts about the job, what it tried. Its notes are
indexed in a file called `MEMORY.md`.

You can also just tell it: "remember that invoices go to the finance folder".

To see what a bot remembers, click its name at the top of the chat and open **Memory**. Each note can
be downloaded or deleted.

## Shared memory

Some things every bot should know, such as your name, your company, or how you like reports
written. Those go in **Shared memory**: every bot in the [space](./spaces.md) reads these notes and
keeps them up to date.

Find it in **Settings → Memory**.

## Memory providers

Optionally, connect a memory service so bots can also recall facts by meaning, not just by reading
their notes. In **Settings → Memory**, choose **Connect memory provider**:

- **Supermemory**: its cloud service, or your own instance.
- **Serenity**: choose **Recall and write**, or **Recall only** to keep it read-only.
- **Honcho**: the built-in service, Honcho Cloud, or an existing self-hosted instance.

## Built-in Honcho

With `HONCHO_MANAGED=true`, the personal Space owner can enable Honcho from **Settings → Memory**. New Spaces created by that owner select it automatically. Existing provider connections are never replaced.

The supervisor runs Honcho and its Alembic migrations in a single container: the API serves traffic and its process runs the Deriver's queue loop (`DERIVER_EMBEDDED`, a Rakazo-side addition). Honcho has a separate database in the shared PostgreSQL instance, with pgvector enabled, and uses Redis database 1 for caching. Its work queue is in PostgreSQL. The API binds to loopback by default and nothing else is exposed. `HONCHO_ADMIN_TOKEN` must be a separate random value of at least 32 characters; it is Honcho's static admin bearer (Rakazo-side addition). Rakazo sends it as the deployment credential; users never receive it.

Reasoning follows the personal Space's main model, or a fixed Rakazo model connection; it is applied through Honcho's `LLM_UNIFIED_MODEL_CONFIG` (a Rakazo-side addition) instead of per-feature fan-out. Configure embeddings independently: the model, OpenAI-compatible base URL, API key and dimensions (pgvector's HNSW limit is 2000). A chat connection does not necessarily provide embeddings; for example, Opencode Go does not expose an `/embeddings` endpoint. The running Honcho validates both endpoints through its real client code paths (`/admin/validate_models`, a Rakazo-side addition) before the service is marked ready. OAuth connections are not silently reused.

Only the personal Space owner can change the shared service's model, embeddings, Deriver concurrency or restart it. Other Spaces retain isolated workspaces and can choose the existing isolated/shared memory scope without seeing service credentials. Service failures leave `MEMORY.md` and chat available; the background coordinator retries pending changes using a PostgreSQL lease.

Once connected, **Default scope** decides what bots share in the provider:

- **Isolated**: each bot recalls only what it saved. This is the default.
- **Shared**: bots in the space recall from one pool.

Each bot's settings also gain a **Memory scope** under **Advanced**, so one bot can differ from the
default.

## Open work

Separate from memory, each bot keeps a short list of **Open work**: things it has started and not
finished. It is in the bot's settings. You can add items for it, or mark them complete.

## Memory across spaces

Memory never crosses [spaces](./spaces.md). A bot in one space can't read notes from another.
