"""FastAPI backend for the dual-engine OCR web app — with MySQL persistence."""

import uuid
import shutil
import logging
import asyncio
from pathlib import Path
from typing import Optional

from pydantic import BaseModel
from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks, Query
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

app = FastAPI(
    title="Dual-Engine OCR API",
    description="PaddleOCR + Docling + DeepSeek-OCR unified OCR system with MySQL persistence",
    version="2.0.0",
)

# Allow requests from anywhere (artifact iframes on claude.ai, local dev tools, etc.)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static + templates
FRONTEND_DIR = BASE_DIR / "frontend"
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(FRONTEND_DIR / "templates"))

# In-memory job registry {job_id: status_dict}  (always populated, DB is secondary store)
jobs: dict[str, dict] = {}


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


@app.post("/api/ocr/upload")
async def upload_and_ocr(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    engine: str = "all",   # "all" | "paddle" | "docling" | "deepseek" | "both"
):
    """Upload a file and start OCR processing. Returns a job_id for polling."""
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
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

    # Detect client in memory from filename (does NOT persist until user clicks Save)
    matched_client = db.detect_client(filename=file.filename) if db.is_connected() else None

    jobs[job_id] = {
        "job_id":   job_id,
        "filename": file.filename,
        "status":   "queued",
        "engine":   engine,
        "client":   matched_client,
        "saved":    False,
        "result":   None,
        "error":    None,
    }

    background_tasks.add_task(_run_ocr, job_id, str(dest), engine, file.filename)
    return {"job_id": job_id, "status": "queued", "client": matched_client}


@app.get("/api/ocr/status/{job_id}")
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


@app.get("/api/ocr/result/{job_id}")
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
    filename: Optional[str] = None
    engine:   Optional[str] = None
    result:   Optional[dict] = None


@app.post("/api/ocr/save/{job_id}")
async def save_ocr_job(job_id: str, payload: Optional[SaveJobRequest] = None):
    """Persist an extracted OCR result to MySQL when Save is clicked, matching client by filename."""
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
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        logger.exception("Failed to save OCR job %s", job_id)
        raise HTTPException(status_code=500, detail=f"Failed to save to database: {exc}")

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


# ---------------------------------------------------------------------------
# DB-backed history & statistics endpoints
# ---------------------------------------------------------------------------

def _serialize_dates(row: dict) -> dict:
    for k, v in row.items():
        if hasattr(v, "isoformat"):
            row[k] = v.isoformat()
    return row


@app.get("/api/db/clients")
async def list_clients():
    """Return all registered clients from `ocr_clients` with job counts."""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    return [_serialize_dates(r) for r in db.list_clients(with_counts=True)]


@app.post("/api/db/clients")
async def create_client(payload: dict):
    """Create a new client. Body: {name_ja, name_en, code, keywords?}"""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    name_ja  = (payload.get("name_ja") or "").strip()
    name_en  = (payload.get("name_en") or "").strip()
    code     = (payload.get("code")    or "").strip()
    keywords = (payload.get("keywords") or "").strip()
    if not name_ja or not code:
        raise HTTPException(status_code=400, detail="name_ja and code are required")
    try:
        result = db.add_client(name_ja=name_ja, name_en=name_en, code=code, keywords=keywords)
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/api/db/clients/{client_id}")
async def update_client(client_id: int, payload: dict):
    """Update an existing client."""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    name_ja  = (payload.get("name_ja") or "").strip()
    name_en  = (payload.get("name_en") or "").strip()
    code     = (payload.get("code")    or "").strip()
    keywords = (payload.get("keywords") or "").strip()
    if not name_ja or not code:
        raise HTTPException(status_code=400, detail="name_ja and code are required")
    updated = db.update_client(client_id, name_ja=name_ja, name_en=name_en, code=code, keywords=keywords)
    if not updated:
        raise HTTPException(status_code=404, detail="Client not found")
    return {"updated": True, "id": client_id}


@app.delete("/api/db/clients/{client_id}")
async def delete_client(client_id: int):
    """Delete a client (jobs' client_id becomes NULL)."""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    deleted = db.delete_client_by_id(client_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Client not found")
    return {"deleted": True, "id": client_id}


@app.get("/api/db/jobs")
async def list_jobs(
    limit:     int = Query(default=50, ge=1, le=500),
    offset:    int = Query(default=0,  ge=0),
    client_id: Optional[int] = Query(default=None, ge=1),
):
    """Return recent OCR jobs stored in MySQL (optionally filtered by client_id)."""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    rows = db.list_jobs(limit=limit, offset=offset, client_id=client_id)
    return [_serialize_dates(r) for r in rows]


@app.get("/api/db/jobs/{job_id}")
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


@app.post("/api/db/jobs/bulk-delete")
async def bulk_delete_jobs(payload: dict):
    """Permanently delete multiple jobs. Body: {\"job_ids\": [\"...\", ...]}"""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    job_ids = payload.get("job_ids", [])
    if not job_ids or not isinstance(job_ids, list):
        raise HTTPException(status_code=400, detail="job_ids must be a non-empty list")
    deleted = db.delete_jobs_bulk(job_ids)
    for jid in job_ids:
        jobs.pop(jid, None)
    return {"deleted": deleted, "requested": len(job_ids)}


@app.delete("/api/db/jobs/{job_id}")
async def delete_job(job_id: str):
    """Permanently delete a job and its child rows from the database."""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    deleted = db.delete_job(job_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Job not found")
    # Also remove from in-memory registry if present
    jobs.pop(job_id, None)
    return {"deleted": True, "job_id": job_id}


@app.get("/api/db/stats")
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
            loop.run_in_executor(None, _sync_ocr, file_path, engine),
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
    except Exception as exc:
        logger.exception("OCR failed for job %s", job_id)
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"]  = str(exc)


def _sync_ocr(file_path: str, engine: str) -> dict:
    from backend.ocr_engine import (
        process_file, _paddle_ocr_image, _docling_process_file,
        _deepseek_ocr_image, SUPPORTED_EXCEL_EXTS,
    )

    ext = Path(file_path).suffix.lower()

    # Excel always goes through the dedicated parser regardless of engine choice
    if ext in SUPPORTED_EXCEL_EXTS:
        return process_file(file_path, engines=engine)

    if engine == "paddle":
        return _paddle_ocr_image(file_path)
    elif engine == "docling":
        return _docling_process_file(file_path)
    elif engine == "deepseek":
        return _deepseek_ocr_image(file_path, mode="markdown")
    else:
        return process_file(file_path, engines=engine)
