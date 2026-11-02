# Vendored Honcho

This directory contains the Honcho source that Rakazo builds into its managed
memory service. It is a vendored snapshot of the upstream repository, not a
submodule — Honcho is an internal Rakazo feature here, so we modify it in place
instead of patching around it at build time.

- Upstream: <https://github.com/plastic-labs/honcho>
- Pinned commit: `6f91136b4e8d4b41de75f05d0cea822a1520b3a4` (version 3.5.0)
- License: AGPL-3.0 (kept in `LICENSE`, travels with the image)

Only the directories the image needs are vendored (`src/`, `migrations/`,
`scripts/`, `docker/`, `alembic.ini`, `pyproject.toml`, `uv.lock`, `tests/`).
Examples, SDKs, docs and plugins stay upstream. To refresh: copy the wanted
commit's tree over this directory, then re-apply the local modifications below.

## Local modifications

Each modification is marked with a `# Rakazo:` comment at its site.

1. **`src/llm/registry.py`** — `_DEFAULT_HEADERS_BY_BASE_URL` carries an
   `https://opencode.ai/inference/go` entry (`x-opencode-session` from
   `OPENCODE_SESSION_ID`, default `rakazo-honcho`; `x-opencode-client:
   rakazo`). Opencode Go rejects requests without these headers.
2. **`src/config.py` / `src/security.py` — static admin bearer.**
   `AUTH_STATIC_ADMIN_TOKEN` authenticates a request as admin via
   constant-time comparison, before JWT verification. A deployment that owns
   the process (Rakazo) presents one credential instead of minting JWTs.
   `JWT_SECRET` or `STATIC_ADMIN_TOKEN` satisfies the USE_AUTH validator.
3. **`src/config.py` — `LLM_UNIFIED_MODEL_CONFIG`.** One
   `ConfiguredModelSettings` that AppSettings fills into every reasoning
   feature (DERIVER/SUMMARY/DREAM deduction+induction/DIALECTIC levels) not
   explicitly configured. Per-feature env overrides still win.
4. **`src/routers/validate_models.py`** (new) — `POST /admin/validate_models`
   probes the reasoning and embedding endpoints through the real backend and
   embedding-client code paths and returns structured results, so a bad
   configuration surfaces as a diagnostic instead of a crash-looping
   container.
5. **`src/config.py` / `src/deriver/queue_manager.py` / `src/main.py` —
   `DERIVER_EMBEDDED`.** When set, the API process runs the deriver queue
   loop as an asyncio task in its lifespan instead of needing a separate
   `python -m src.deriver` process: one container serves both roles. The
   embedded loop skips the standalone process's signal handlers, startup
   jitter, and Sentry re-initialization; shutdown drains in-flight work and
   releases its queue-session rows before the API tears the cache and
   engine down.

## Build

`pnpm honcho:build` runs `docker build` on this directory. The build is
self-contained: source comes from this tree, never the network. Only the
dependency sync (`uv sync`) needs network access; on restricted networks pass
the standard build args through `HONCHO_BUILD_ARGS`, for example:

```sh
HONCHO_BUILD_ARGS="--build-arg BASE_IMAGE=<python mirror> \
  --build-arg HTTPS_PROXY=<proxy>" pnpm honcho:build
```

Those values stay on the command line and are not part of the committed
Dockerfile.
