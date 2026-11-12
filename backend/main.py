"""FastAPI backend for the dual-engine OCR web app — with MySQL persistence."""

import uuid
import shutil
import logging
import asyncio
from pathlib import Path
from typing import Optional

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

    jobs[job_id] = {
        "job_id":   job_id,
        "filename": file.filename,
        "status":   "queued",
        "engine":   engine,
        "result":   None,
        "error":    None,
    }

    # Persist queued status to DB
    db.save_job_queued(job_id, file.filename, engine)

    background_tasks.add_task(_run_ocr, job_id, str(dest), engine)
    return {"job_id": job_id, "status": "queued"}


@app.get("/api/ocr/status/{job_id}")
async def job_status(job_id: str):
    """Poll OCR job status — checks memory first, then DB."""
    if job_id in jobs:
        return jobs[job_id]
    # Server may have reloaded — fall back to DB
    db_row = db.get_job(job_id)
    if db_row is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "job_id":   job_id,
        "filename": db_row.get("filename", ""),
        "status":   db_row.get("status", "unknown"),
        "engine":   db_row.get("engine_requested", "all"),
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


@app.get("/api/health")
async def health():
    return {
        "status":   "ok",
        "engines":  ["PaddleOCR", "Docling", "DeepSeek-OCR"],
        "database": "connected" if db.is_connected() else "disconnected",
    }


# ---------------------------------------------------------------------------
# DB-backed history & statistics endpoints
# ---------------------------------------------------------------------------

@app.get("/api/db/jobs")
async def list_jobs(
    limit:  int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0,  ge=0),
):
    """Return recent OCR jobs stored in MySQL."""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    rows = db.list_jobs(limit=limit, offset=offset)
    # Convert datetime objects to ISO strings for JSON serialisation
    for row in rows:
        for k, v in row.items():
            if hasattr(v, "isoformat"):
                row[k] = v.isoformat()
    return rows


@app.get("/api/db/jobs/{job_id}")
async def db_job_detail(job_id: str):
    """Return full DB record for a job including engine sub-results and tables."""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    row = db.get_job(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found in database")
    for k, v in row.items():
        if hasattr(v, "isoformat"):
            row[k] = v.isoformat()
    row["engines"] = db.get_job_engines(job_id)
    row["tables"]  = db.get_job_tables(job_id)
    return row


@app.get("/api/db/stats")
async def db_statistics():
    """Return aggregate statistics from the MySQL database."""
    return db.db_stats()


# ---------------------------------------------------------------------------
# Background OCR task
# ---------------------------------------------------------------------------

async def _run_ocr(job_id: str, file_path: str, engine: str):
    jobs[job_id]["status"] = "processing"
    db.save_job_processing(job_id)
    try:
        # Run in thread pool so it doesn't block the event loop
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _sync_ocr, file_path, engine)
        jobs[job_id]["status"] = "done"
        jobs[job_id]["result"] = result
        # Persist result to MySQL
        db.save_job_done(job_id, result)
    except Exception as exc:
        logger.exception("OCR failed for job %s", job_id)
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"]  = str(exc)
        db.save_job_error(job_id, str(exc))


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
