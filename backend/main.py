"""FastAPI backend for the dual-engine OCR web app — with MySQL persistence."""

import os
import hmac
import time
import uuid
import shutil
import logging
import asyncio
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")

try:
    from dotenv import load_dotenv
    _env_file = Path(__file__).resolve().parent.parent / ".env"
    if _env_file.exists():
        load_dotenv(_env_file)
except ImportError:
    pass

from pydantic import BaseModel, Field
from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks, Query, Depends
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
import aiofiles

from backend import database as db

# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

BASE_DIR    = Path(__file__).resolve().parent.parent
UPLOAD_DIR  = BASE_DIR / "uploads"
RESULT_DIR  = BASE_DIR / "results"
UPLOAD_DIR.mkdir(exist_ok=True)
RESULT_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp",
    ".pdf",
    ".xlsx", ".xls", ".xlsm",
}
MAX_FILE_SIZE_MB = 50
MAX_QUEUED_JOBS = int(os.getenv("MAX_QUEUED_JOBS", "20"))
OCR_API_KEY = os.getenv("OCR_API_KEY", "").strip()

_default_origins = "http://localhost:8080,http://127.0.0.1:8080"
CORS_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", _default_origins).split(",")
    if o.strip()
]

app = FastAPI(
    title="Dual-Engine OCR API",
    description="PaddleOCR + Docling + DeepSeek-OCR unified OCR system with MySQL persistence",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-API-Key"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: blob:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'",
    )
    return response


# ---------------------------------------------------------------------------
# Security helpers: Auth, Rate Limiting, Magic-Byte Validation, Audit Log
# ---------------------------------------------------------------------------
_rate_buckets: dict[str, deque] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _audit(request: Request, action: str, detail: str = "") -> None:
    logger.info("AUDIT ip=%s action=%s %s", _client_ip(request), action, detail)


def _require_api_key(request: Request) -> None:
    """Enforce X-API-Key / Bearer auth when OCR_API_KEY is configured."""
    if not OCR_API_KEY:
        return
    key = request.headers.get("X-API-Key", "")
    if not key:
        auth = request.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            key = auth[7:].strip()
    if not key or not hmac.compare_digest(key, OCR_API_KEY):
        logger.warning("AUDIT ip=%s action=auth_failed path=%s", _client_ip(request), request.url.path)
        raise HTTPException(status_code=401, detail="Unauthorized")


def _check_rate_limit(request: Request, bucket: str, max_requests: int, window_s: int = 60) -> None:
    now = time.monotonic()
    key = f"{bucket}:{_client_ip(request)}"
    dq = _rate_buckets[key]
    while dq and now - dq[0] > window_s:
        dq.popleft()
    if len(dq) >= max_requests:
        logger.warning("AUDIT ip=%s action=rate_limited bucket=%s", _client_ip(request), bucket)
        raise HTTPException(status_code=429, detail="Too many requests, please try again later")
    dq.append(now)


def _verify_magic_bytes(path: Path, ext: str) -> bool:
    """Verify file header magic bytes match the declared extension."""
    try:
        with open(path, "rb") as fh:
            hdr = fh.read(16)
    except OSError:
        return False
    if ext == ".pdf":
        return hdr.startswith(b"%PDF-")
    if ext == ".png":
        return hdr.startswith(b"\x89PNG\r\n\x1a\n")
    if ext in (".jpg", ".jpeg"):
        return hdr.startswith(b"\xff\xd8\xff")
    if ext == ".webp":
        return len(hdr) >= 12 and hdr[:4] == b"RIFF" and hdr[8:12] == b"WEBP"
    if ext in (".xlsx", ".xlsm"):
        return hdr.startswith((b"PK\x03\x04", b"PK\x05\x06"))
    if ext == ".xls":
        return hdr.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
    return False

# Static + templates
FRONTEND_DIR = BASE_DIR / "frontend"
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(FRONTEND_DIR / "templates"))

# In-memory job registry {job_id: status_dict}  (always populated, DB is secondary store)
jobs: dict[str, dict] = {}
MAX_IN_MEMORY_JOBS = 200
VALID_ENGINES = {"all", "both", "paddle", "docling", "deepseek"}

# Serialize OCR inference to a single worker thread — PaddlePaddle's C++ predictor
# is not thread-safe under concurrent calls and running multiple pipelines risks OOM.
_ocr_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ocr-worker")


def _prune_jobs():
    """Evict oldest finished jobs when the in-memory registry exceeds MAX_IN_MEMORY_JOBS."""
    if len(jobs) <= MAX_IN_MEMORY_JOBS:
        return
    finished = [jid for jid, j in jobs.items() if j.get("status") in ("done", "error")]
    for jid in finished[: len(jobs) - MAX_IN_MEMORY_JOBS]:
        jobs.pop(jid, None)


# ---------------------------------------------------------------------------
# Startup: initialise MySQL
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def on_startup():
    loop = asyncio.get_event_loop()
    connected = await loop.run_in_executor(None, db.init_db)
    if connected:
        logger.info("MySQL persistence enabled (ocrdatabasedb)")
        stale = await loop.run_in_executor(None, db.cleanup_stale_jobs, 5)
        if stale:
            logger.info("Marked %d orphaned job(s) as error", stale)
    else:
        logger.warning("MySQL unavailable — in-memory mode only")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/")
async def index():
    return FileResponse(str(FRONTEND_DIR / "templates" / "index.html"))


@app.post("/api/ocr/upload", dependencies=[Depends(_require_api_key)])
async def upload_and_ocr(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    engine: str = "all",   # "all" | "paddle" | "docling" | "deepseek" | "both"
):
    """Upload a file and start OCR processing. Returns a job_id for polling."""
    _check_rate_limit(request, "upload", max_requests=20, window_s=60)

    active_jobs = sum(1 for j in jobs.values() if j.get("status") in ("queued", "processing"))
    if active_jobs >= MAX_QUEUED_JOBS:
        raise HTTPException(status_code=503, detail="OCR queue is full, please retry shortly")

    safe_name = Path(file.filename or "upload").name
    ext = Path(safe_name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        _audit(request, "upload_rejected", f"reason=bad_ext ext={ext}")
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )
    if engine not in VALID_ENGINES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported engine '{engine}'. Allowed: {', '.join(sorted(VALID_ENGINES))}",
        )

    job_id = str(uuid.uuid4())
    dest = UPLOAD_DIR / f"{job_id}{ext}"

    # Stream upload to disk
    async with aiofiles.open(dest, "wb") as f:
        total = 0
        while chunk := await file.read(1024 * 256):
            total += len(chunk)
            if total > MAX_FILE_SIZE_MB * 1024 * 1024:
                dest.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="File too large (max 50 MB)")
            await f.write(chunk)

    if total == 0 or not _verify_magic_bytes(dest, ext):
        dest.unlink(missing_ok=True)
        _audit(request, "upload_rejected", f"reason=magic_mismatch ext={ext}")
        raise HTTPException(status_code=400, detail="File content does not match declared file type")

    # Detect client in memory from filename (does NOT persist until user clicks Save)
    matched_client = db.detect_client(filename=safe_name) if db.is_connected() else None

    _prune_jobs()
    jobs[job_id] = {
        "job_id":   job_id,
        "filename": safe_name,
        "status":   "queued",
        "engine":   engine,
        "client":   matched_client,
        "saved":    False,
        "result":   None,
        "error":    None,
    }

    _audit(request, "upload_accepted", f"job_id={job_id} engine={engine} bytes={total}")
    background_tasks.add_task(_run_ocr, job_id, str(dest), engine, safe_name)
    return {"job_id": job_id, "status": "queued", "client": matched_client}


@app.get("/api/ocr/status/{job_id}", dependencies=[Depends(_require_api_key)])
async def job_status(job_id: str):
    """Poll OCR job status — checks memory first, then DB."""
    if job_id in jobs:
        return jobs[job_id]
    # Server may have reloaded — fall back to DB
    db_row = db.get_job(job_id)
    if db_row is None:
        raise HTTPException(status_code=404, detail="Job not found")
    client_info = (
        {
            "id":      db_row["client_id"],
            "code":    db_row["client_code"],
            "name_ja": db_row["client_name_ja"],
            "name_en": db_row["client_name_en"],
        }
        if db_row.get("client_id")
        else None
    )
    return {
        "job_id":   job_id,
        "filename": db_row.get("filename", ""),
        "status":   db_row.get("status", "unknown"),
        "engine":   db_row.get("engine_requested", "all"),
        "client":   client_info,
        "result":   None,
        "error":    db_row.get("error_message"),
    }


@app.get("/api/ocr/result/{job_id}", dependencies=[Depends(_require_api_key)])
async def job_result(job_id: str):
    """Retrieve the full OCR result — checks memory first, then DB."""
    # In-memory (normal path)
    if job_id in jobs:
        job = jobs[job_id]
        if job["status"] != "done":
            raise HTTPException(status_code=202, detail="Job not finished yet")
        return job["result"]
    # Fall back to DB (after server reload)
    db_row = db.get_job(job_id)
    if db_row is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if db_row.get("status") != "done":
        raise HTTPException(status_code=202, detail="Job not finished yet")
    result = db.get_job_result(job_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Result not available")
    return result


class SaveJobRequest(BaseModel):
    filename: Optional[str] = Field(default=None, max_length=512)
    engine:   Optional[str] = Field(default=None, max_length=64)
    result:   Optional[dict] = None


class ClientPayload(BaseModel):
    name_ja:  str = Field(..., min_length=1, max_length=128)
    name_en:  str = Field(default="", max_length=128)
    code:     str = Field(..., min_length=1, max_length=64)
    keywords: str = Field(default="", max_length=1000)


class BulkDeleteRequest(BaseModel):
    job_ids: list[str] = Field(..., min_length=1, max_length=200)


@app.post("/api/ocr/save/{job_id}", dependencies=[Depends(_require_api_key)])
async def save_ocr_job(request: Request, job_id: str, payload: Optional[SaveJobRequest] = None):
    """Persist an extracted OCR result to MySQL when Save is clicked, matching client by filename."""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")

    job = jobs.get(job_id)
    if job is not None:
        if job.get("status") != "done":
            raise HTTPException(status_code=409, detail="OCR extraction is not finished yet")
        result = job.get("result") or (payload.result if payload else None)
        filename = (payload.filename if payload and payload.filename else None) or job.get("filename") or ""
        engine = (payload.engine if payload and payload.engine else None) or job.get("engine") or "all"
    else:
        if payload is None or not payload.result:
            raise HTTPException(status_code=404, detail="Extracted job not found in memory")
        result = payload.result
        filename = payload.filename or result.get("filename") or "unknown"
        engine = payload.engine or result.get("primary_engine") or result.get("engine") or "all"

    if not result:
        raise HTTPException(status_code=400, detail="No extracted OCR result available to save")

    try:
        saved_info = db.save_extracted_job(
            job_id=job_id,
            filename=filename,
            engine=engine,
            result=result,
        )
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database service unavailable")
    except Exception:
        logger.exception("Failed to save OCR job %s", job_id)
        raise HTTPException(status_code=500, detail="Failed to save OCR job")

    if job is not None:
        job["saved"] = True
        if saved_info.get("client"):
            job["client"] = saved_info["client"]

    return {
        "status":   "saved",
        "job_id":   saved_info["job_id"],
        "filename": saved_info["filename"],
        "client":   saved_info["client"],
    }


@app.get("/api/health")
async def health():
    from backend.ocr_engine import _check_gpu
    return {
        "status":        "ok",
        "engines":       ["PaddleOCR", "Docling", "DeepSeek-OCR"],
        "database":      "connected" if db.is_connected() else "disconnected",
        "gpu_available": _check_gpu(),
    }


@app.post("/api/db/reconnect", dependencies=[Depends(_require_api_key)])
async def db_reconnect(request: Request):
    """Re-attempt database connection (useful when DB was down at startup)."""
    _check_rate_limit(request, "db_write", max_requests=20, window_s=60)
    loop = asyncio.get_event_loop()
    connected = await loop.run_in_executor(None, db.init_db)
    _audit(request, "db_reconnect", f"connected={connected}")
    return {
        "connected": connected,
        "database":  "connected" if connected else "disconnected",
    }


# ---------------------------------------------------------------------------
# DB-backed history & statistics endpoints
# ---------------------------------------------------------------------------

def _serialize_dates(row: dict) -> dict:
    for k, v in row.items():
        if hasattr(v, "isoformat"):
            row[k] = v.isoformat()
    return row


@app.get("/api/db/clients", dependencies=[Depends(_require_api_key)])
async def list_clients():
    """Return all registered clients from `ocr_clients` with job counts."""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    return [_serialize_dates(r) for r in db.list_clients(with_counts=True)]


@app.post("/api/db/clients", dependencies=[Depends(_require_api_key)])
async def create_client(request: Request, payload: ClientPayload):
    """Create a new client. Body: {name_ja, name_en, code, keywords?}"""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    name_ja  = payload.name_ja.strip()
    name_en  = payload.name_en.strip()
    code     = payload.code.strip()
    keywords = payload.keywords.strip()
    if not name_ja or not code:
        raise HTTPException(status_code=400, detail="name_ja and code are required")
    try:
        result = db.add_client(name_ja=name_ja, name_en=name_en, code=code, keywords=keywords)
        _audit(request, "client_create", f"code={code}")
        return result
    except Exception:
        logger.exception("Failed to create client code=%s", code)
        raise HTTPException(status_code=500, detail="Failed to create client")


@app.put("/api/db/clients/{client_id}", dependencies=[Depends(_require_api_key)])
async def update_client(request: Request, client_id: int, payload: ClientPayload):
    """Update an existing client."""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    name_ja  = payload.name_ja.strip()
    name_en  = payload.name_en.strip()
    code     = payload.code.strip()
    keywords = payload.keywords.strip()
    if not name_ja or not code:
        raise HTTPException(status_code=400, detail="name_ja and code are required")
    updated = db.update_client(client_id, name_ja=name_ja, name_en=name_en, code=code, keywords=keywords)
    if not updated:
        raise HTTPException(status_code=404, detail="Client not found")
    _audit(request, "client_update", f"client_id={client_id}")
    return {"updated": True, "id": client_id}


@app.delete("/api/db/clients/{client_id}", dependencies=[Depends(_require_api_key)])
async def delete_client(request: Request, client_id: int):
    """Delete a client (jobs' client_id becomes NULL)."""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    deleted = db.delete_client_by_id(client_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Client not found")
    _audit(request, "client_delete", f"client_id={client_id}")
    return {"deleted": True, "id": client_id}


@app.get("/api/db/jobs", dependencies=[Depends(_require_api_key)])
async def list_jobs(
    limit:     int = Query(default=50, ge=1, le=1000),
    offset:    int = Query(default=0,  ge=0),
    client_id: Optional[int] = Query(default=None, ge=1),
):
    """Return recent OCR jobs stored in MySQL (optionally filtered by client_id)."""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    rows = db.list_jobs(limit=limit, offset=offset, client_id=client_id)
    return [_serialize_dates(r) for r in rows]


@app.get("/api/db/jobs/{job_id}", dependencies=[Depends(_require_api_key)])
async def db_job_detail(job_id: str):
    """Return full DB record for a job including engine sub-results and tables."""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    row = db.get_job(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found in database")
    _serialize_dates(row)
    row["engines"] = db.get_job_engines(job_id)
    row["tables"]  = db.get_job_tables(job_id)
    return row


@app.delete("/api/db/jobs")
async def delete_jobs_bulk(job_ids: list[str] = None, body: dict = None):
    """Bulk delete jobs by a list of job_ids passed as JSON body."""
    from fastapi import Body
    raise HTTPException(status_code=405, detail="Use POST /api/db/jobs/bulk-delete")


@app.post("/api/db/jobs/bulk-delete", dependencies=[Depends(_require_api_key)])
async def bulk_delete_jobs(request: Request, payload: BulkDeleteRequest):
    """Permanently delete multiple jobs. Body: {\"job_ids\": [\"...\", ...]}"""
    _check_rate_limit(request, "db_write", max_requests=30, window_s=60)
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    job_ids = payload.job_ids
    deleted = db.delete_jobs_bulk(job_ids)
    for jid in job_ids:
        jobs.pop(jid, None)
    _audit(request, "jobs_bulk_delete", f"requested={len(job_ids)} deleted={deleted}")
    return {"deleted": deleted, "requested": len(job_ids)}


@app.delete("/api/db/jobs/{job_id}", dependencies=[Depends(_require_api_key)])
async def delete_job(request: Request, job_id: str):
    """Permanently delete a job and its child rows from the database."""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    deleted = db.delete_job(job_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Job not found")
    # Also remove from in-memory registry if present
    jobs.pop(job_id, None)
    _audit(request, "job_delete", f"job_id={job_id}")
    return {"deleted": True, "job_id": job_id}


@app.get("/api/db/stats", dependencies=[Depends(_require_api_key)])
async def db_statistics():
    """Return aggregate statistics from the MySQL database."""
    return db.db_stats()


# ---------------------------------------------------------------------------
# Background OCR task
# ---------------------------------------------------------------------------

OCR_TIMEOUT_S = 300  # 5 minutes


async def _run_ocr(job_id: str, file_path: str, engine: str, filename: str = ""):
    jobs[job_id]["status"] = "processing"
    try:
        loop = asyncio.get_event_loop()
        result = await asyncio.wait_for(
            loop.run_in_executor(_ocr_executor, _sync_ocr, file_path, engine),
            timeout=OCR_TIMEOUT_S,
        )
        if isinstance(result, dict):
            result["job_id"] = job_id
            if filename:
                result["filename"] = filename
            matched_client = db.detect_client_for_result(result, filename=filename) if db.is_connected() else None
            if matched_client:
                result["client"] = matched_client
                jobs[job_id]["client"] = matched_client
        jobs[job_id]["result"] = result
        jobs[job_id]["status"] = "done"
    except asyncio.TimeoutError:
        logger.error("OCR timed out after %ds for job %s", OCR_TIMEOUT_S, job_id)
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"]  = f"Processing timed out ({OCR_TIMEOUT_S}s)"
    except Exception:
        logger.exception("OCR failed for job %s", job_id)
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"]  = "OCR processing failed"


def _sync_ocr(file_path: str, engine: str) -> dict:
    from backend.ocr_engine import process_file
    return process_file(file_path, engines=engine)
