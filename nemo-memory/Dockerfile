FROM python:3.11-slim

# mlx requires macOS — this Dockerfile is intentionally for ARM macOS host
# running Docker (colima or Docker Desktop on Apple Silicon).
# The container shares the Metal GPU with the host via /dev/dri or the
# Apple Silicon accelerator via MPS — mlx-embeddings detects this automatically.

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Model is downloaded on first run and cached in /app/models (mounted as a
# Docker volume so rebuilds don't re-download ~350 MB every time).
ENV TRANSFORMERS_CACHE=/app/models
ENV HF_HOME=/app/models

EXPOSE 8765

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765", "--workers", "1"]
