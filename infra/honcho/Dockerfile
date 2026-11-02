# Vendored Honcho source (see README.md for the pinned upstream commit and
# the local modifications Rakazo carries on top of it). The build is
# self-contained: everything comes from this directory, never the network.
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.5
ARG BASE_IMAGE=python:3.13-slim-bookworm

FROM ${UV_IMAGE} AS uv

FROM ${BASE_IMAGE} AS builder
COPY --from=uv /uv /bin/uv

WORKDIR /app

# Enable bytecode compilation
ENV UV_COMPILE_BYTECODE=1

# Copy from the cache instead of linking since it's a mounted volume
ENV UV_LINK_MODE=copy

# Python optimizations
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Copy only requirements to cache them in docker layer
COPY uv.lock pyproject.toml /app/

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-group dev

FROM ${BASE_IMAGE} AS runtime

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Create the runtime user before copying dependencies with their final owner.
# A recursive chown in a later layer would copy the whole virtualenv and
# nearly double the image size.
RUN useradd --uid 10001 --create-home honcho && chown honcho:honcho /app

COPY --from=builder --chown=honcho:honcho /app/.venv /app/.venv

# Place executables in the environment at the front of the path
ENV PATH="/app/.venv/bin:$PATH" \
    HOME=/home/honcho

COPY --chown=honcho:honcho src/ /app/src/
COPY --chown=honcho:honcho migrations/ /app/migrations/
COPY --chown=honcho:honcho scripts/ /app/scripts/
COPY --chown=honcho:honcho docker/ /app/docker/
COPY --chown=honcho:honcho alembic.ini /app/alembic.ini
# src/_version.py reads the service version from here at runtime, so this
# is a runtime input as well as a build input.
COPY --chown=honcho:honcho pyproject.toml /app/pyproject.toml
# AGPL-3.0: the license travels with the binary.
COPY --chown=honcho:honcho LICENSE /app/LICENSE

# Switch to non-root user
USER honcho

EXPOSE 8000

CMD ["fastapi", "run", "--host", "0.0.0.0", "src/main.py"]
