"""Admin endpoint that validates model and embedding configuration for real.

Rakazo's managed deployment calls this before applying a configuration change:
it exercises the same registry / embedding-client code paths the deriver and
API use, so a validation pass means the running workload can actually reach
the provider. Failures come back structured (provider error detail) instead
of as a crash-looping container.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from src.config import EmbeddingModelConfig, ModelConfig, ModelTransport
from src.embedding_client import _EmbeddingClient
from src.llm.registry import get_backend
from src.security import require_auth

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(require_auth(admin=True))],
)


class CamelModel(BaseModel):
    """Accept camelCase on the wire (Rakazo sends JSON from TypeScript)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ModelProbe(CamelModel):
    """A reasoning model to probe via the real backend path."""

    model: str
    transport: ModelTransport
    api_key: str | None = None
    base_url: str | None = None
    provider_params: dict[str, Any] = Field(default_factory=dict)


class EmbeddingProbe(CamelModel):
    """An embedding model to probe via the real embedding client."""

    model: str
    transport: str = "openai"
    api_key: str | None = None
    base_url: str | None = None
    dimensions: int = 1536


class ValidationRequest(CamelModel):
    reasoning: ModelProbe
    embedding: EmbeddingProbe


class ComponentResult(CamelModel):
    ok: bool
    detail: str | None = None


class ValidationResponse(CamelModel):
    reasoning: ComponentResult
    embedding: ComponentResult


def _error_detail(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"[:500]


async def _probe_reasoning(probe: ModelProbe) -> ComponentResult:
    if not probe.api_key:
        return ComponentResult(ok=False, detail="No API key configured")
    try:
        config = ModelConfig(
            model=probe.model,
            transport=probe.transport,
            api_key=probe.api_key,
            base_url=probe.base_url,
            provider_params=probe.provider_params,
        )
        backend = get_backend(config)
        result = await backend.complete(
            model=probe.model,
            messages=[{"role": "user", "content": "Reply OK."}],
            max_tokens=16,
        )
        _ = result.content
        return ComponentResult(ok=True)
    except Exception as exc:
        logger.info("Reasoning model validation failed: %s", exc)
        return ComponentResult(ok=False, detail=_error_detail(exc))


async def _probe_embedding(probe: EmbeddingProbe) -> ComponentResult:
    if not probe.api_key:
        return ComponentResult(ok=False, detail="No API key configured")
    try:
        config = EmbeddingModelConfig(
            model=probe.model,
            transport=probe.transport,
            api_key=probe.api_key,
            base_url=probe.base_url,
        )
        client = _EmbeddingClient(
            config,
            vector_dimensions=probe.dimensions,
            max_input_tokens=8192,
            max_tokens_per_request=8192,
            send_dimensions=True,
        )
        embedding = await client.embed("Honcho connection check")
        if len(embedding) != probe.dimensions:
            return ComponentResult(
                ok=False,
                detail=(
                    f"Embedding dimension mismatch: requested {probe.dimensions}, "
                    f"got {len(embedding)}"
                ),
            )
        return ComponentResult(ok=True)
    except Exception as exc:
        logger.info("Embedding model validation failed: %s", exc)
        return ComponentResult(ok=False, detail=_error_detail(exc))


@router.post("/validate_models")
async def validate_models(request: ValidationRequest) -> ValidationResponse:
    """Probe the reasoning and embedding endpoints with real clients."""
    reasoning, embedding = await asyncio.gather(
        _probe_reasoning(request.reasoning),
        _probe_embedding(request.embedding),
    )
    return ValidationResponse(reasoning=reasoning, embedding=embedding)
