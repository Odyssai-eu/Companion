"""
nemo-memory — LightRAG knowledge graph memory service for Companion/Nemo.

Native macOS service (no Docker) — uses mlx-embeddings with
Qwen3-Embedding-0.6B-4bit-DWQ on Apple Silicon Metal.

Architecture:
  - LightRAG builds a knowledge graph from ingested text (entities +
    relations). Queries combine graph + vector (hybrid) or pure vector
    (naive, default for injection — no LLM call needed at query time).
  - LLM for entity extraction at ingest: Odysseus local API.
  - Embedding: mlx-embeddings + Qwen3-Embedding-0.6B-4bit-DWQ (Metal).
  - Storage: LIGHTRAG_DIR (JSON files + nano-vectordb, no external DB).

Endpoints:
  GET  /health
  POST /v1/embeddings   — OpenAI-compat (for Companion smart routing)
  POST /ingest          — insert text into the knowledge graph
  POST /query/context   — vector or hybrid query → markdown block
"""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from mlx_embeddings import load as mlx_load
from fastapi import FastAPI
from lightrag import LightRAG, QueryParam
from lightrag.utils import EmbeddingFunc
from pydantic import BaseModel, Field

# ── Config ────────────────────────────────────────────────────────────────

ODYSSEUS_URL   = os.environ.get("ODYSSEUS_URL",   "http://localhost:8000")
ODYSSEUS_MODEL = os.environ.get("ODYSSEUS_MODEL",  "default")
EMBED_MODEL    = os.environ.get("EMBED_MODEL",
                     "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ")
EMBED_DIM      = int(os.environ.get("EMBED_DIM",   "1024"))
WORKING_DIR    = os.environ.get("LIGHTRAG_DIR",
                     os.path.expanduser("~/nemo-memory-data/lightrag"))
TOP_K_DEFAULT  = int(os.environ.get("TOP_K",       "5"))
LOG_LEVEL      = os.environ.get("LOG_LEVEL",       "INFO")

logging.basicConfig(level=getattr(logging, LOG_LEVEL, logging.INFO))
log = logging.getLogger("nemo-memory")

_mlx_model = None   # (model, tokenizer) tuple from mlx_load
_rags: dict[str, LightRAG] = {}

# ── LightRAG per-user factory ─────────────────────────────────────────────

async def _get_rag(user_id: str) -> LightRAG:
    if user_id not in _rags:
        d = os.path.join(WORKING_DIR, user_id)
        os.makedirs(d, exist_ok=True)
        rag = LightRAG(
            working_dir=d,
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


# ── LLM (Odysseus, for entity extraction at ingest only) ──────────────────

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
                json={"model": ODYSSEUS_MODEL, "messages": messages,
                      "max_tokens": 2048, "temperature": 0.1,
                      "enable_thinking": False},
            )
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]
    except Exception as e:
        log.warning("llm_complete failed: %s", e)
        return ""


# ── Embedding (mlx-embeddings + Qwen3 on Apple Silicon Metal) ────────────

async def embed_texts(texts: list[str]) -> list[list[float]]:
    loop = asyncio.get_event_loop()
    def _run():
        import mlx.core as mx
        import numpy as np
        model, tokenizer = _mlx_model
        inputs = tokenizer(
            texts, return_tensors="mlx", padding=True,
            truncation=True, max_length=512,
        )
        out = model(**inputs)
        hidden = out.last_hidden_state          # (n, seq_len, dim)
        vecs = hidden.mean(axis=1)              # (n, dim)
        mx.eval(vecs)
        # Return numpy array for LightRAG (nano-vectordb requires ndarray).
        # Callers that need JSON-serializable lists must call .tolist() themselves.
        result = np.array(vecs.tolist(), dtype=np.float32)
        return result
    return await loop.run_in_executor(None, _run)


# ── Lifespan ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _mlx_model, EMBED_DIM

    log.info("Loading mlx embedding model %s …", EMBED_MODEL)
    t0 = time.time()
    # mlx_load returns (model, tokenizer) tuple
    _mlx_model = mlx_load(EMBED_MODEL)
    # Detect actual output dimension
    test = await embed_texts(["warmup"])
    EMBED_DIM = len(test[0])
    log.info("MLX embed model ready (%.1fs) dim=%d", time.time() - t0, EMBED_DIM)

    os.makedirs(WORKING_DIR, exist_ok=True)
    log.info("nemo-memory (LightRAG + mlx) ready — odysseus=%s embed=%s dim=%d",
             ODYSSEUS_URL, EMBED_MODEL, EMBED_DIM)
    yield
    log.info("nemo-memory shutting down")


app = FastAPI(title="nemo-memory", lifespan=lifespan)


# ── Routes ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "mode": "lightrag-mlx",
            "embed_model": EMBED_MODEL, "embed_dim": EMBED_DIM,
            "odysseus": ODYSSEUS_URL, "graphs_loaded": len(_rags)}


# ── /v1/embeddings (OpenAI-compat) ───────────────────────────────────────

class EmbedRequest(BaseModel):
    input: list[str] | str
    model: str = "nemo-embed"


MAX_CHARS = 2048  # ~512 tokens — hard cap to avoid OOM on long chunks

@app.post("/embeddings")
@app.post("/v1/embeddings")
async def embeddings(req: EmbedRequest):
    raw = [req.input] if isinstance(req.input, str) else req.input
    # Truncate oversized inputs so the model never OOMs on long chunks
    texts = [t[:MAX_CHARS] if len(t) > MAX_CHARS else t for t in raw]
    vecs = await embed_texts(texts)
    # Convert to Python lists for JSON serialization (vecs is np.ndarray)
    vecs_list = vecs.tolist() if hasattr(vecs, "tolist") else vecs
    return {
        "object": "list",
        "data": [{"object": "embedding", "index": i, "embedding": v}
                 for i, v in enumerate(vecs_list)],
        "model": req.model,
        "usage": {"prompt_tokens": sum(len(t.split()) for t in texts), "total_tokens": 0},
    }


# ── /ingest ───────────────────────────────────────────────────────────────

class IngestRequest(BaseModel):
    user_id: str
    article_id: str
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
    log.info("Inserted article=%s user=%s (%.1fs)",
             req.article_id, req.user_id[:8], time.time() - t0)
    return {"ingested": True, "article_id": req.article_id}


# ── /query/context ────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    user_id: str
    text: str
    top_k: int = Field(default=TOP_K_DEFAULT, ge=1, le=20)
    project_id: Optional[str] = None
    # naive = pure vector, no LLM call — right default for memory injection.
    # Nemo (the chat model) reasons over the context himself; we just need
    # relevant chunks, not a pre-synthesised answer.
    mode: str = "naive"


@app.post("/query/context")
async def query_context(req: QueryRequest):
    rag = await _get_rag(req.user_id)
    t0 = time.time()
    modes = [req.mode] if req.mode == "naive" else [req.mode, "naive"]
    for mode in modes:
        try:
            result = await rag.aquery(
                req.text,
                param=QueryParam(mode=mode, top_k=req.top_k),
            )
            elapsed = time.time() - t0
            log.info("Query user=%s mode=%s (%.1fs) len=%d",
                     req.user_id[:8], mode, elapsed, len(result or ""))
            if result and result.strip() and "[no-context]" not in result:
                return {"context": f"# Relevant memory\n\n{result.strip()}",
                        "chunks_used": 1}
        except Exception as e:
            log.warning("query mode=%s failed: %s", mode, e)
    return {"context": "", "chunks_used": 0}
