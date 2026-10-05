# syntax=docker/dockerfile:1
# Build context: repository root.  docker build -f infra/docker/rag.Dockerfile .
# One image serves both `rag-api` (uvicorn) and `rag-worker` (python -m ffr_rag.worker).

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH

# ocrmypdf needs tesseract (+ Vietnamese data), ghostscript and qpdf; unpaper is optional cleanup.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       tesseract-ocr tesseract-ocr-vie tesseract-ocr-eng ghostscript qpdf unpaper \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv

WORKDIR /app
COPY apps/rag/pyproject.toml apps/rag/uv.lock apps/rag/.python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY apps/rag/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

RUN useradd --create-home app && mkdir -p /data && chown app:app /data
USER app
EXPOSE 8000
CMD ["uvicorn", "ffr_rag.api:app", "--host", "0.0.0.0", "--port", "8000"]
