"""
nemo-memory — embedding + RAG service for Companion.

Two responsibilities in one process:
  1. Embedding  POST /v1/embeddings  (OpenAI-compatible)
  2. RAG        POST /ingest / POST /query / POST /query/context

Stack: fastembed (ONNX, no Rust/Metal required) + Qdrant client.
Default model: BAAI/bge-m3 (multilingual, 1024-dim, same as obsidian-context
collection) — downloaded once on first start, cached in /app/models volume.
"""

import os
import time
import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastembed import TextEmbedding
from fastapi import FastAPI
from pydantic import BaseModel, Field
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    VectorParams,
    PointStruct,
    Filter,
    FieldCondition,
    MatchValue,
)

# ── Config ────────────────────────────────────────────────────────────────

MODEL_NAME = os.environ.get("EMBED_MODEL_ID", "BAAI/bge-m3")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://192.168.86.44:6333")
QDRANT_COLLECTION = os.environ.get("QDRANT_COLLECTION", "nemo")
EMBED_DIM = int(os.environ.get("EMBED_DIM", "1024"))
TOP_K_DEFAULT = int(os.environ.get("TOP_K_DEFAULT", "5"))
CHUNK_SIZE = int(os.environ.get("CHUNK_SIZE", "512"))
CHUNK_OVERLAP = int(os.environ.get("CHUNK_OVERLAP", "64"))
CACHE_DIR = os.environ.get("HF_HOME", "/app/models")
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")

logging.basicConfig(level=getattr(logging, LOG_LEVEL, logging.INFO))
log = logging.getLogger("nemo-memory")

# ── Global state ──────────────────────────────────────────────────────────

_model: Optional[TextEmbedding] = None
_qdrant: Optional[QdrantClient] = None

# ── Lifespan ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model, _qdrant, EMBED_DIM

    log.info("Loading fastembed model %s …", MODEL_NAME)
    t0 = time.time()
    _model = TextEmbedding(model_name=MODEL_NAME, cache_dir=CACHE_DIR)
    # Warm up + detect actual dim
    test = list(_model.embed(["warmup"]))
    EMBED_DIM = len(test[0])
    log.info("Model ready in %.1fs — dim=%d", time.time() - t0, EMBED_DIM)

    log.info("Connecting to Qdrant at %s …", QDRANT_URL)
    _qdrant = QdrantClient(url=QDRANT_URL, timeout=10)
    _ensure_collection()
    log.info("nemo-memory ready — collection=%s dim=%d", QDRANT_COLLECTION, EMBED_DIM)

    yield

    log.info("nemo-memory shutting down")


app = FastAPI(title="nemo-memory", lifespan=lifespan)

# ── Helpers ───────────────────────────────────────────────────────────────

def _ensure_collection():
    existing = {c.name for c in _qdrant.get_collections().collections}
    if QDRANT_COLLECTION not in existing:
        _qdrant.create_collection(
            collection_name=QDRANT_COLLECTION,
            vectors_config=VectorParams(size=EMBED_DIM, distance=Distance.COSINE),
        )
        log.info("Created Qdrant collection '%s' dim=%d", QDRANT_COLLECTION, EMBED_DIM)


def _embed(texts: list[str]) -> list[list[float]]:
    return [v.tolist() for v in _model.embed(texts)]


def _chunk(text: str) -> list[str]:
    chunks, start = [], 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        chunks.append(text[start:end])
        if end == len(text):
            break
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks


# ── Routes ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "dim": EMBED_DIM,
            "collection": QDRANT_COLLECTION, "qdrant": QDRANT_URL}


# ── /v1/embeddings (OpenAI-compatible) ───────────────────────────────────

class EmbedRequest(BaseModel):
    input: list[str] | str
    model: str = "nemo-embed"


@app.post("/v1/embeddings")
def embeddings(req: EmbedRequest):
    texts = [req.input] if isinstance(req.input, str) else req.input
    vecs = _embed(texts)
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
    article_id: str
    text: str
    source: str = "wiki"
    project_id: Optional[str] = None


@app.post("/ingest")
def ingest(req: IngestRequest):
    _qdrant.delete(
        collection_name=QDRANT_COLLECTION,
        points_selector=Filter(must=[
            FieldCondition(key="user_id", match=MatchValue(value=req.user_id)),
            FieldCondition(key="article_id", match=MatchValue(value=req.article_id)),
        ]),
    )
    chunks = _chunk(req.text)
    if not chunks:
        return {"ingested": 0}

    vecs = _embed(chunks)
    points = [
        PointStruct(
            id=abs(hash(f"{req.user_id}:{req.article_id}:{i}")) % (2**63),
            vector=v,
            payload={"user_id": req.user_id, "article_id": req.article_id,
                     "chunk_index": i, "text": chunk, "source": req.source,
                     "project_id": req.project_id},
        )
        for i, (chunk, v) in enumerate(zip(chunks, vecs))
    ]
    _qdrant.upsert(collection_name=QDRANT_COLLECTION, points=points)
    log.info("Ingested %d chunks article=%s user=%s", len(points), req.article_id, req.user_id)
    return {"ingested": len(points), "article_id": req.article_id}


# ── /query ────────────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    user_id: str
    text: str
    top_k: int = Field(default=TOP_K_DEFAULT, ge=1, le=20)
    project_id: Optional[str] = None
    score_threshold: float = 0.3


@app.post("/query")
def query(req: QueryRequest):
    vec = _embed([req.text])[0]
    must = [FieldCondition(key="user_id", match=MatchValue(value=req.user_id))]
    if req.project_id:
        must.append(FieldCondition(key="project_id", match=MatchValue(value=req.project_id)))

    response = _qdrant.query_points(
        collection_name=QDRANT_COLLECTION,
        query=vec,
        query_filter=Filter(must=must),
        limit=req.top_k,
        score_threshold=req.score_threshold,
        with_payload=True,
    )
    results = response.points
    return {
        "chunks": [{"text": r.payload["text"], "score": r.score,
                    "source": r.payload.get("source", ""),
                    "article_id": r.payload.get("article_id", "")}
                   for r in results],
        "total": len(results),
    }


@app.post("/query/context")
def query_context(req: QueryRequest):
    """Ready-to-inject markdown block for Companion system prompt."""
    chunks = query(req)["chunks"]
    if not chunks:
        return {"context": "", "chunks_used": 0}
    lines = ["# Relevant memory\n"]
    for c in chunks:
        lines.append(c["text"].strip())
        lines.append("")
    return {"context": "\n".join(lines), "chunks_used": len(chunks)}
