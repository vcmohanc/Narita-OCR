# =============================================================================
# Dockerfile — OCR Web App (PaddleOCR + Docling + DeepSeek-OCR)
# Base: Python 3.11-slim (matches venv Python version)
# =============================================================================

# ── Stage 1: dependency builder ──────────────────────────────────────────────
FROM python:3.11-slim AS builder

# System libraries needed to compile/install OCR packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    libgcc-s1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy requirements first for layer caching
COPY requirements.txt .

# Install all Python deps into /install (no venv needed in Docker)
RUN pip install --upgrade pip && \
    pip install --prefix=/install --no-cache-dir -r requirements.txt


# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

LABEL maintainer="ocr-webapp" \
      description="Triple-engine OCR: PaddleOCR + Docling + DeepSeek-OCR" \
      version="2.0.0"

# Runtime-only OS libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    libgcc-s1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=builder /install /usr/local

# Create non-root user for security
RUN useradd -m -u 1000 ocruser

WORKDIR /app

# Copy application source (respects .dockerignore)
COPY --chown=ocruser:ocruser . .

# Create data directories
RUN mkdir -p uploads results && \
    chown -R ocruser:ocruser uploads results

USER ocruser

# Health check: hits /api/health every 30 s
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1

EXPOSE 8080

# Use run.py so .env is loaded and sys.path is configured correctly
CMD ["python", "run.py"]

