"""
nemo-memory — LightRAG-based memory service for Companion / Nemo.

Architecture:
  - LightRAG builds a knowledge graph from ingested text (entities +
    relations + communities). Queries combine graph traversal with vector
    search (hybrid mode) → far better than pure similarity for relational
    memory ("what do I know about X that relates to Y").
  - LLM for entity extraction: Odysseus (local, OpenAI-compat API).
  - Embedding: fastembed + nomic-embed-text-v1.5 (ONNX, no Rust/Metal).
  - Storage: /app/data volume (JSON files + nano-vectordb — no external DB).

Endpoints:
  GET  /health
  POST /v1/embeddings   — OpenAI-compat (for Companion smart routing)
  POST /ingest          — insert text into the knowledge graph
  POST /query/context   — hybrid graph+vector query → markdown block
"""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
import httpx
from fastembed import TextEmbedding
from fastapi import FastAPI
from lightrag import LightRAG, QueryParam
from lightrag.utils import EmbeddingFunc
from pydantic import BaseModel, Field

# ── Config ────────────────────────────────────────────────────────────────

ODYSSEUS_URL   = os.environ.get("ODYSSEUS_URL",   "http://host.docker.internal:8000")
ODYSSEUS_MODEL = os.environ.get("ODYSSEUS_MODEL",  "default")
EMBED_MODEL    = os.environ.get("EMBED_MODEL",     "nomic-ai/nomic-embed-text-v1.5")
EMBED_DIM      = int(os.environ.get("EMBED_DIM",   "768"))
WORKING_DIR    = os.environ.get("LIGHTRAG_DIR",    "/app/data/lightrag")
TOP_K_DEFAULT  = int(os.environ.get("TOP_K",       "5"))
LOG_LEVEL      = os.environ.get("LOG_LEVEL",       "INFO")

logging.basicConfig(level=getattr(logging, LOG_LEVEL, logging.INFO))
log = logging.getLogger("nemo-memory")

# Per-user LightRAG instances (each user has its own knowledge graph)
_rags:   dict[str, LightRAG] = {}
_embed:  Optional[TextEmbedding] = None

# ── LightRAG factory ──────────────────────────────────────────────────────

def _rag_dir(user_id: str) -> str:
    """Separate working dir per user keeps graphs isolated."""
    d = os.path.join(WORKING_DIR, user_id)
    os.makedirs(d, exist_ok=True)
    return d


async def _get_rag(user_id: str) -> LightRAG:
    if user_id not in _rags:
        rag = LightRAG(
            working_dir=_rag_dir(user_id),
            llm_model_func=llm_complete,
            embedding_func=EmbeddingFunc(
                embedding_dim=EMBED_DIM,
                max_token_size=512,
                func=embed_texts,
            ),
        )
        await rag.initialize_storages()
        _rags[user_id] = rag
        log.info("Created LightRAG graph for user %s", user_id[:8])
    return _rags[user_id]


# ── LLM function (Odysseus via OpenAI-compat) ─────────────────────────────

async def llm_complete(
    prompt: str,
    system_prompt: Optional[str] = None,
    history_messages: list = [],
    **kwargs,
) -> str:
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    for h in history_messages:
        messages.append(h)
    messages.append({"role": "user", "content": prompt})

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                f"{ODYSSEUS_URL}/v1/chat/completions",
                json={
                    "model": ODYSSEUS_MODEL,
                    "messages": messages,
                    "max_tokens": 2048,
                    "temperature": 0.1,
                    "enable_thinking": False,
                },
            )
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]
    except Exception as e:
        log.warning("llm_complete failed: %s", e)
        return ""


# ── Embedding function (fastembed) ────────────────────────────────────────

async def embed_texts(texts: list[str]) -> list[list[float]]:
    loop = asyncio.get_event_loop()
    vecs = await loop.run_in_executor(
        None, lambda: [v.tolist() for v in _embed.embed(texts)]
    )
    return vecs


# ── Lifespan ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _embed

    log.info("Loading fastembed model %s …", EMBED_MODEL)
    t0 = time.time()
    _embed = TextEmbedding(model_name=EMBED_MODEL)
    # warm up
    list(_embed.embed(["warmup"]))
    log.info("Embed model ready (%.1fs)", time.time() - t0)

    os.makedirs(WORKING_DIR, exist_ok=True)
    log.info("nemo-memory (LightRAG) ready — odysseus=%s embed=%s",
             ODYSSEUS_URL, EMBED_MODEL)
    yield
    log.info("nemo-memory shutting down")


app = FastAPI(title="nemo-memory", lifespan=lifespan)


# ── Routes ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "mode": "lightrag",
        "embed_model": EMBED_MODEL,
        "odysseus": ODYSSEUS_URL,
        "graphs_loaded": len(_rags),
    }


# ── /v1/embeddings (OpenAI-compat, for smart routing) ────────────────────

class EmbedRequest(BaseModel):
    input: list[str] | str
    model: str = "nemo-embed"


@app.post("/v1/embeddings")
async def embeddings(req: EmbedRequest):
    texts = [req.input] if isinstance(req.input, str) else req.input
    vecs = await embed_texts(texts)
    return {
        "object": "list",
        "data": [{"object": "embedding", "index": i, "embedding": v}
                 for i, v in enumerate(vecs)],
        "model": req.model,
        "usage": {"prompt_tokens": sum(len(t.split()) for t in texts), "total_tokens": 0},
    }


# ── /ingest ───────────────────────────────────────────────────────────────

class IngestRequest(BaseModel):
    user_id: str
    article_id: str   # used as doc id / label, not as a filter key
    text: str
    source: str = "wiki"
    project_id: Optional[str] = None


@app.post("/ingest")
async def ingest(req: IngestRequest):
    if not req.text.strip():
        return {"ingested": False, "reason": "empty text"}
    rag = await _get_rag(req.user_id)
    t0 = time.time()
    await rag.ainsert(req.text)
    log.info("Inserted article=%s user=%s (%.1fs)", req.article_id, req.user_id[:8], time.time()-t0)
    return {"ingested": True, "article_id": req.article_id}


# ── /query/context ────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    user_id: str
    text: str
    top_k: int = Field(default=TOP_K_DEFAULT, ge=1, le=20)
    project_id: Optional[str] = None
    mode: str = "hybrid"  # local | global | hybrid | naive


@app.post("/query/context")
async def query_context(req: QueryRequest):
    rag = await _get_rag(req.user_id)
    t0 = time.time()
    # Try hybrid first (graph + vector), fall back to naive (vector-only)
    # if the LLM (Odysseus) is unavailable / no model loaded.
    for mode in [req.mode, "naive"]:
        try:
            result = await rag.aquery(
                req.text,
                param=QueryParam(mode=mode, top_k=req.top_k),
            )
            elapsed = time.time() - t0
            log.info("Query user=%s mode=%s (%.1fs) result_len=%d",
                     req.user_id[:8], mode, elapsed, len(result or ""))
            if result and result.strip():
                context = f"# Relevant memory\n\n{result.strip()}"
                return {"context": context, "chunks_used": 1}
        except Exception as e:
            log.warning("query_context mode=%s failed: %s — trying fallback", mode, e)
    return {"context": "", "chunks_used": 0}
