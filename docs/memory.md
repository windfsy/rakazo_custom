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

- **Rakazo memory**: built into this deployment; no external service.
- **Supermemory**: its cloud service, or your own instance.
- **Serenity**: choose **Recall and write**, or **Recall only** to keep it read-only.
- **Honcho**: Honcho Cloud, or an existing self-hosted instance.

Once connected, **Default scope** decides what bots share in the provider:

- **Isolated**: each bot recalls only what it saved. This is the default.
- **Shared**: bots in the space recall from one pool.

Each bot's settings also gain a **Memory scope** under **Advanced**, so one bot can differ from the
default.

## Built-in memory

Rakazo memory keeps facts in this deployment's own database. Each fact's text is encrypted at
rest, indexed for exact-word search without decrypting, and stored with an embedding for semantic
recall. A bot's run recalls by two paths — nearest embeddings and the blind index — merges both
rankings, and asks the Space's main model to reorder the shortlist. If that reorder fails, the
merged order is used, so recall never blocks a run.

Only facts are remembered; conversation history and compaction summaries stay in Rakazo's own
thread storage. The personal Space owner configures one **embedding endpoint** for the deployment
under **Settings → Memory → Rakazo memory**: an OpenAI-compatible base URL, model, and API key.
Facts are written by the bot's `save_memory` tool, from conversation ingestion, and by repeating
and contradicting themselves being folded together in the background.

Extraction, consolidation and dreaming write free-form facts, so their quality is judged by
meaning: `pnpm test:evals:memory` calibrates a versioned rubric against reviewed examples
(`packages/testkit/src/evals/memory.ts`) before it grades a run. It needs a judge model
connection and is never part of the default test run; deterministic pipeline behaviour is
covered by the package's own Postgres tests.

## Open work

Separate from memory, each bot keeps a short list of **Open work**: things it has started and not
finished. It is in the bot's settings. You can add items for it, or mark them complete.

## Memory across spaces

Memory never crosses [spaces](./spaces.md). A bot in one space can't read notes from another.
