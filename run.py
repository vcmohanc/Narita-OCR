"""Entry point — adds repo root to sys.path and launches uvicorn.

Works in both environments:
  - Local dev:  loads .env from project root (via python-dotenv)
  - Docker:     env vars are injected by docker-compose; .env is not present
"""
import sys
import os
from pathlib import Path

# PaddlePaddle requires protobuf ≤ 3.20.2 but onnxruntime pulls in a newer
# version. Using the pure-Python protobuf parser sidesteps the conflict.
os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")

ROOT = Path(__file__).resolve().parent

# Load .env only when it exists (local dev); Docker uses injected env vars
try:
    from dotenv import load_dotenv
    env_file = ROOT / ".env"
    if env_file.exists():
        load_dotenv(env_file)
except ImportError:
    pass

# Make the project root and any sibling repos importable
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# torch/transformers must be imported before paddleocr anywhere in the process
try:
    import torch          # noqa: F401
    import transformers   # noqa: F401
except ImportError:
    pass

import uvicorn

if __name__ == "__main__":
    # Disable reload in Docker (no source changes expected at runtime)
    in_docker = os.path.exists("/.dockerenv")
    uvicorn.run(
        "backend.main:app",
        host="0.0.0.0",
        port=8080,
        reload=not in_docker,
        log_level="info",
        workers=1,          # OCR models are too large for multi-worker mode
    )
