"""FastAPI backend for the dual-engine OCR web app — with MySQL persistence."""

import os
import json
import hmac
import time
import unicodedata
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
from fastapi import FastAPI, File, Form, UploadFile, HTTPException, BackgroundTasks, Query, Depends, Path as FPath
from fastapi.responses import JSONResponse, FileResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
import aiofiles
import zipfile

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
REQUIRE_AUTH = os.getenv("REQUIRE_AUTH", "false").strip().lower() in ("true", "1", "yes")
ENVIRONMENT  = os.getenv("ENVIRONMENT", "development").strip().lower()
OCR_API_KEY  = os.getenv("OCR_API_KEY", "").strip()

_raw_proxies = os.getenv("TRUSTED_PROXIES", "").strip()
TRUSTED_PROXIES = {p.strip() for p in _raw_proxies.split(",") if p.strip()}

JOB_ID_REGEX = r"^[a-zA-Z0-9_\-]+$"

_default_origins = "http://localhost:8080,http://127.0.0.1:8080"
_raw_origins = os.getenv("CORS_ORIGINS", _default_origins).strip()
if _raw_origins == "*":
    CORS_ORIGINS = ["*"]
else:
    CORS_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()]

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
    response.headers.setdefault("X-XSS-Protection", "1; mode=block")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if request.url.scheme == "https" or request.headers.get("X-Forwarded-Proto") == "https":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
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
_last_rate_cleanup: float = 0.0


def _cleanup_rate_buckets(now: float) -> None:
    """Evict expired rate-limit bucket entries to prevent memory growth over time."""
    global _last_rate_cleanup
    if now - _last_rate_cleanup < 60.0 and len(_rate_buckets) < 1000:
        return
    _last_rate_cleanup = now
    stale_keys = [k for k, dq in _rate_buckets.items() if not dq or now - dq[-1] > 300]
    for k in stale_keys:
        _rate_buckets.pop(k, None)
    if len(_rate_buckets) > 5000:
        excess = len(_rate_buckets) - 5000
        for k in list(_rate_buckets.keys())[:excess]:
            _rate_buckets.pop(k, None)


def _client_ip(request: Request) -> str:
    """Resolve client IP, honoring X-Forwarded-For only when behind a trusted proxy."""
    remote_host = request.client.host if request.client else "unknown"
    if remote_host in TRUSTED_PROXIES or "all" in TRUSTED_PROXIES:
        xff = request.headers.get("X-Forwarded-For")
        if xff:
            return xff.split(",")[0].strip()
        x_real_ip = request.headers.get("X-Real-IP")
        if x_real_ip:
            return x_real_ip.strip()
    return remote_host


def _audit(request: Request, action: str, detail: str = "") -> None:
    logger.info("AUDIT ip=%s action=%s %s", _client_ip(request), action, detail)


SESSION_COOKIE_NAME = "ocr_session"
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", "43200"))


def _is_https_request(request: Request) -> bool:
    """Detect whether the client connected via HTTPS (directly or behind Caddy/Nginx)."""
    if request.url.scheme == "https":
        return True
    xfp = request.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower()
    return xfp == "https"


def _get_authenticated_user(request: Request) -> Optional[dict]:
    """
    Resolve the authenticated user from:
      1. Server-side HttpOnly session cookie (`ocr_session`) verified against `ocr_sessions`, OR
      2. Configured `OCR_API_KEY` via `X-API-Key` / `Authorization: Bearer` header.
    Returns None if unauthenticated. Never fails open.
    """
    raw_token = request.cookies.get(SESSION_COOKIE_NAME, "").strip()
    if raw_token:
        user = db.get_session_user(raw_token)
        if user:
            return user

    active_api_key = db.get_setting("ocr_api_key", OCR_API_KEY).strip()
    if active_api_key:
        key = request.headers.get("X-API-Key", "")
        if not key:
            auth = request.headers.get("Authorization", "")
            if auth.lower().startswith("bearer "):
                key = auth[7:].strip()
        if key and hmac.compare_digest(key, active_api_key):
            return {"id": 0, "username": "api-key", "display_name": "API Key", "role": "admin"}

    return None


def _require_api_key(request: Request) -> dict:
    """Strictly require an authenticated session (or configured API key) on all protected routes."""
    user = _get_authenticated_user(request)
    if not user:
        logger.warning("AUDIT ip=%s action=auth_required path=%s", _client_ip(request), request.url.path)
        raise HTTPException(status_code=401, detail="Authentication required")
    request.state.user = user
    return user


def _require_admin(request: Request) -> dict:
    """Strictly require an authenticated admin user."""
    user = _require_api_key(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


def _check_rate_limit(request: Request, bucket: str, max_requests: int, window_s: int = 60) -> None:
    now = time.monotonic()
    _cleanup_rate_buckets(now)
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
        if not hdr.startswith((b"PK\x03\x04", b"PK\x05\x06")):
            return False
        try:
            with zipfile.ZipFile(path, "r") as zf:
                names = zf.namelist()
                return "[Content_Types].xml" in names or any(n.startswith("xl/") for n in names)
        except Exception:
            return False
    if ext == ".xls":
        return hdr.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
    return False

# Static + templates (static assets are served through an auth-gated route below)
FRONTEND_DIR = BASE_DIR / "frontend"
STATIC_DIR   = (FRONTEND_DIR / "static").resolve()
templates    = Jinja2Templates(directory=str(FRONTEND_DIR / "templates"))
_PUBLIC_STATIC_FILES = {"login.css", "login.js"}

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
        logger.info("MySQL persistence enabled (ocrdatabasedb) — session authentication active")
        stale = await loop.run_in_executor(None, db.cleanup_stale_jobs, 5)
        if stale:
            logger.info("Marked %d orphaned job(s) as error", stale)
    else:
        logger.warning("MySQL unavailable — authentication and persistence require DB connection")


# ---------------------------------------------------------------------------
# Auth & UI Entry Routes
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=256)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=256)
    new_password:     str = Field(..., min_length=8, max_length=256)


class CreateUserRequest(BaseModel):
    username:     str = Field(..., min_length=3, max_length=64)
    password:     str = Field(..., min_length=8, max_length=256)
    display_name: str = Field(default="", max_length=128)
    role:         str = Field(default="user", max_length=16)


@app.get("/login")
async def login_page(request: Request):
    if _get_authenticated_user(request):
        return RedirectResponse(url="/", status_code=302, headers={"Cache-Control": "no-store"})
    return FileResponse(str(FRONTEND_DIR / "templates" / "login.html"), headers={"Cache-Control": "no-store"})


@app.get("/")
async def index(request: Request):
    if not _get_authenticated_user(request):
        return RedirectResponse(url="/login", status_code=302, headers={"Cache-Control": "no-store"})
    return FileResponse(str(FRONTEND_DIR / "templates" / "index.html"), headers={"Cache-Control": "no-store"})


@app.get("/static/{file_path:path}")
async def serve_static(request: Request, file_path: str):
    """Serve static assets; only login.css and login.js are accessible before login."""
    clean_rel = file_path.lstrip("/")
    if clean_rel not in _PUBLIC_STATIC_FILES:
        _require_api_key(request)
    target = (STATIC_DIR / clean_rel).resolve()
    if not target.is_relative_to(STATIC_DIR) or not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(str(target))


@app.post("/api/auth/login")
async def auth_login(request: Request, payload: LoginRequest):
    """Authenticate user credentials, enforce lockout/rate-limit, and set HttpOnly session cookie."""
    login_rpm = db.get_setting_int("login_rate_limit_per_min", 20, min_val=1, max_val=600)
    _check_rate_limit(request, "login", max_requests=login_rpm, window_s=60)

    user, status = db.authenticate_user(payload.username, payload.password)
    if status == "unavailable":
        raise HTTPException(status_code=503, detail="Database unavailable — cannot verify credentials")
    if status == "locked":
        _audit(request, "login_locked", f"username={payload.username}")
        lockout_mins = db.get_setting_int("login_lockout_minutes", 15, min_val=1, max_val=1440)
        raise HTTPException(status_code=429, detail=f"ログイン試行回数が上限を超えました。{lockout_mins}分後に再試行してください。")
    if status == "inactive":
        _audit(request, "login_inactive", f"username={payload.username}")
        raise HTTPException(status_code=403, detail="このアカウントは無効化されています。")
    if status != "ok" or not user:
        _audit(request, "login_failed", f"username={payload.username}")
        raise HTTPException(status_code=401, detail="ユーザー名またはパスワードが正しくありません。")

    # Session fixation defense: revoke any prior token before issuing a new one
    old_token = request.cookies.get(SESSION_COOKIE_NAME, "").strip()
    if old_token:
        db.delete_session(old_token)

    ttl_seconds = db.get_setting_int("session_ttl_seconds", SESSION_TTL_SECONDS, min_val=300, max_val=2592000)
    raw_token = db.create_session(
        user_id=user["id"],
        ip_address=_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
        ttl_seconds=ttl_seconds,
    )
    _audit(request, "login_success", f"username={user['username']} role={user['role']}")

    resp = JSONResponse({"status": "ok", "user": user})
    resp.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=raw_token,
        max_age=ttl_seconds,
        httponly=True,
        samesite="lax",
        secure=_is_https_request(request),
        path="/",
    )
    return resp


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    """Revoke active server-side session and clear cookie."""
    raw_token = request.cookies.get(SESSION_COOKIE_NAME, "").strip()
    if raw_token:
        db.delete_session(raw_token)
    _audit(request, "logout")
    resp = JSONResponse({"status": "ok"})
    resp.delete_cookie(key=SESSION_COOKIE_NAME, path="/", samesite="lax")
    return resp


@app.get("/api/auth/me")
async def auth_me(user: dict = Depends(_require_api_key)):
    return {"user": user}


@app.post("/api/auth/change-password")
async def auth_change_password(
    request: Request,
    payload: ChangePasswordRequest,
    user: dict = Depends(_require_api_key),
):
    if not user.get("id"):
        raise HTTPException(status_code=400, detail="API-key users cannot change password here")
    cur_token = request.cookies.get(SESSION_COOKIE_NAME, "").strip()
    ok, msg = db.change_user_password(
        user_id=user["id"],
        current_password=payload.current_password,
        new_password=payload.new_password,
        current_token=cur_token,
    )
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    _audit(request, "password_changed", f"username={user['username']}")
    return {"status": "ok", "message": msg}


@app.get("/api/auth/users")
async def auth_list_users(admin: dict = Depends(_require_admin)):
    users = db.list_users()
    for u in users:
        for k in ("last_login_at", "created_at"):
            if u.get(k) is not None:
                u[k] = str(u[k])
    return users


@app.post("/api/auth/users", status_code=201)
async def auth_create_user(request: Request, payload: CreateUserRequest, admin: dict = Depends(_require_admin)):
    try:
        created = db.create_user(
            username=payload.username,
            password=payload.password,
            display_name=payload.display_name,
            role=payload.role,
        )
        _audit(request, "user_created", f"by={admin['username']} target={created['username']}")
        return created
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as exc:
        if "Duplicate entry" in str(exc):
            raise HTTPException(status_code=409, detail="このユーザー名は既に登録されています")
        raise HTTPException(status_code=500, detail="ユーザー作成に失敗しました")


@app.delete("/api/auth/users/{user_id}")
async def auth_delete_user(request: Request, user_id: int, admin: dict = Depends(_require_admin)):
    if user_id == admin.get("id"):
        raise HTTPException(status_code=400, detail="自分自身のアカウントは削除できません")
    if not db.delete_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")
    _audit(request, "user_deleted", f"by={admin['username']} target_id={user_id}")
    return {"deleted": True, "id": user_id}


class SettingsUpdateRequest(BaseModel):
    settings: dict


@app.get("/api/settings")
async def get_system_settings(admin: dict = Depends(_require_admin)):
    """Return all dynamic runtime settings stored in MySQL (secrets masked)."""
    return {"settings": db.get_all_settings(mask_secrets=True)}


@app.put("/api/settings")
async def update_system_settings(
    request: Request,
    payload: SettingsUpdateRequest,
    admin: dict = Depends(_require_admin),
):
    """Update dynamic runtime settings in MySQL."""
    try:
        updated = db.update_settings(payload.settings, updated_by=admin.get("username", "admin"))
        _audit(request, "settings_updated", f"by={admin['username']} keys={','.join(sorted(payload.settings.keys()))}")
        return {"status": "ok", "settings": updated}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as exc:
        logger.error("Failed to update settings: %s", exc)
        raise HTTPException(status_code=500, detail="設定の保存に失敗しました")


@app.post("/api/ocr/upload", dependencies=[Depends(_require_api_key)])
async def upload_and_ocr(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    engine: str = "all",   # "all" | "paddle" | "docling" | "deepseek" | "both"
    client_id: Optional[int] = Query(default=None),
    form_client_id: Optional[str] = Form(default=None, alias="client_id"),
):
    """Upload a file and start OCR processing. Returns a job_id for polling."""
    _check_rate_limit(request, "upload", max_requests=20, window_s=60)

    max_queued = db.get_setting_int("max_queued_jobs", MAX_QUEUED_JOBS, min_val=1, max_val=200)
    active_jobs = sum(1 for j in jobs.values() if j.get("status") in ("queued", "processing"))
    if active_jobs >= max_queued:
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

    selected_client_id: Optional[int] = client_id
    if selected_client_id is None and form_client_id is not None and str(form_client_id).strip():
        try:
            parsed_cid = int(str(form_client_id).strip())
            if parsed_cid > 0:
                selected_client_id = parsed_cid
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid client_id")

    job_id = str(uuid.uuid4())
    dest = UPLOAD_DIR / f"{job_id}{ext}"

    max_file_mb = db.get_setting_int("max_file_size_mb", MAX_FILE_SIZE_MB, min_val=1, max_val=500)
    # Stream upload to disk
    async with aiofiles.open(dest, "wb") as f:
        total = 0
        while chunk := await file.read(1024 * 256):
            total += len(chunk)
            if total > max_file_mb * 1024 * 1024:
                dest.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"File too large (max {max_file_mb} MB)")
            await f.write(chunk)

    if total == 0 or not _verify_magic_bytes(dest, ext):
        dest.unlink(missing_ok=True)
        _audit(request, "upload_rejected", f"reason=magic_mismatch ext={ext}")
        raise HTTPException(status_code=400, detail="File content does not match declared file type")

    # Resolve explicit client selection or detect client in memory from filename
    matched_client = None
    if db.is_connected():
        if selected_client_id is not None and selected_client_id > 0:
            matched_client = db._client_public_dict(db.get_client_by_id(selected_client_id))
            if not matched_client:
                dest.unlink(missing_ok=True)
                raise HTTPException(status_code=404, detail=f"Client ID {selected_client_id} not found")
        else:
            matched_client = db.detect_client(filename=safe_name)

    _prune_jobs()
    jobs[job_id] = {
        "job_id":    job_id,
        "filename":  safe_name,
        "status":    "queued",
        "engine":    engine,
        "client_id": selected_client_id,
        "client":    matched_client,
        "saved":     False,
        "result":    None,
        "error":     None,
    }

    _audit(request, "upload_accepted", f"job_id={job_id} engine={engine} client_id={selected_client_id} bytes={total}")
    background_tasks.add_task(_run_ocr, job_id, str(dest), engine, safe_name, selected_client_id)
    return {"job_id": job_id, "status": "queued", "client": matched_client}


@app.get("/api/ocr/status/{job_id}", dependencies=[Depends(_require_api_key)])
async def job_status(job_id: str = FPath(..., pattern=JOB_ID_REGEX, max_length=64)):
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
async def job_result(job_id: str = FPath(..., pattern=JOB_ID_REGEX, max_length=64)):
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


class UpdateResultRequest(BaseModel):
    result: dict


@app.put("/api/ocr/result/{job_id}", dependencies=[Depends(_require_api_key)])
async def update_job_result(
    request: Request,
    payload: UpdateResultRequest,
    job_id: str = FPath(..., pattern=JOB_ID_REGEX, max_length=64),
):
    """Persist manually edited OCR spreadsheet/result data."""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    in_memory = job_id in jobs
    if in_memory:
        jobs[job_id]["result"] = payload.result
        if isinstance(payload.result, dict) and "client" in payload.result:
            jobs[job_id]["client"] = payload.result.get("client")

    updated_db = False
    if db.is_connected():
        updated_db = db.update_job_result(job_id, payload.result)

    if not in_memory and not updated_db:
        raise HTTPException(status_code=404, detail="Job not found")

    _audit(request, "result_update", f"job_id={job_id} db={updated_db}")
    return {"status": "updated", "job_id": job_id}


class SaveJobRequest(BaseModel):
    filename:  Optional[str] = Field(default=None, max_length=512)
    engine:    Optional[str] = Field(default=None, max_length=64)
    client_id: Optional[int] = Field(default=None, ge=1)
    result:    Optional[dict] = None


class ClientPayload(BaseModel):
    name_ja:         str = Field(..., min_length=1, max_length=128)
    name_en:         str = Field(default="", max_length=128)
    code:            str = Field(..., min_length=1, max_length=64)
    keywords:        str = Field(default="", max_length=1000)
    header_row:      Optional[int] = Field(default=1, ge=1, le=100)
    heading_columns: Optional[str] = Field(default="", max_length=2000)


class ClientHeadingPayload(BaseModel):
    header_row:      int = Field(default=1, ge=1, le=100)
    heading_columns: str = Field(default="", max_length=2000)


class ProductPayload(BaseModel):
    product_code: str = Field(..., min_length=1, max_length=64)
    name_ja:      str = Field(..., min_length=1, max_length=255)
    name_en:      str = Field(default="", max_length=255)
    spec:         str = Field(default="", max_length=128)
    unit_price:   Optional[float] = None
    client_id:    Optional[int] = None


class BulkDeleteRequest(BaseModel):
    job_ids: list[str] = Field(..., min_length=1, max_length=200)


class TodayOrderRow(BaseModel):
    type: str = Field(default="data", max_length=20)
    cells: list[str] = Field(default_factory=list, max_length=20)


class TodayOrderPayload(BaseModel):
    rows: list[TodayOrderRow] = Field(..., min_length=1, max_length=500)


TODAY_ORDER_JSON = RESULT_DIR / "today_order_sheet.json"
TODAY_ORDER_XLSX = FRONTEND_DIR / "static" / "chiba_auto_order.xlsx"
TODAY_HAIBUKIYA_JSON = RESULT_DIR / "today_order_haibukiya.json"
TODAY_HAIBUKIYA_XLSX = FRONTEND_DIR / "static" / "haibukiya_order.xlsx"
TODAY_PROPS_JSON = RESULT_DIR / "today_order_props_japan.json"
TODAY_PROPS_XLSX = FRONTEND_DIR / "static" / "props_japan_order.xlsx"
TODAY_TSUKIJI_JSON = RESULT_DIR / "today_order_tsukiji.json"
TODAY_TSUKIJI_XLSX = FRONTEND_DIR / "static" / "tsukiji_chiba_order.xlsx"
TODAY_NATIONAL_AZABU_JSON = RESULT_DIR / "today_order_national_azabu.json"
TODAY_NATIONAL_AZABU_XLSX = FRONTEND_DIR / "static" / "national_azabu_order.xlsx"
TODAY_FUSUI_JSON = RESULT_DIR / "today_order_fusui.json"
TODAY_FUSUI_XLSX = FRONTEND_DIR / "static" / "fusui_order.xlsx"
TODAY_NANOHANA_JSON = RESULT_DIR / "today_order_nanohana.json"
TODAY_NANOHANA_XLSX = FRONTEND_DIR / "static" / "nanohana_order.xlsx"
TODAY_GREENWORLD_JSON = RESULT_DIR / "today_order_greenworld.json"
TODAY_GREENWORLD_XLSX = FRONTEND_DIR / "static" / "greenworld_order.xlsx"
TODAY_ROSEN_JSON = RESULT_DIR / "today_order_rosen.json"
TODAY_ROSEN_XLSX = FRONTEND_DIR / "static" / "rosen_order.xlsx"
TODAY_WORLDDELICA_JSON = RESULT_DIR / "today_order_worlddelica.json"
TODAY_WORLDDELICA_XLSX = FRONTEND_DIR / "static" / "worlddelica_order.xlsx"
_TODAY_ORDER_COLS = 8
_TODAY_HAIBUKIYA_COLS = 20
_TODAY_PROPS_COLS = 10
_TODAY_TSUKIJI_COLS = 11
_TODAY_NATIONAL_AZABU_COLS = 13
_TODAY_FUSUI_COLS = 6
_TODAY_NANOHANA_COLS = 6
_TODAY_GREENWORLD_COLS = 7
_TODAY_ROSEN_COLS = 13
_TODAY_VALID_UNITS = (
    "cs", "p", "kg", "g", "束", "袋", "箱", "本", "個",
    "玉", "パック", "ケース", "枚", "セット", "ネット", "把", "丁", "尾", "杯",
)


def _get_today_format_cfg(fmt: str) -> tuple[str, int, Path, Path]:
    key = (fmt or "chiba").strip().lower()
    if key in ("haibukiya", "灰吹屋"):
        return "haibukiya", _TODAY_HAIBUKIYA_COLS, TODAY_HAIBUKIYA_JSON, TODAY_HAIBUKIYA_XLSX
    if key in ("props_japan", "props", "プロップスジャパン", "プロップス"):
        return "props_japan", _TODAY_PROPS_COLS, TODAY_PROPS_JSON, TODAY_PROPS_XLSX
    if key in ("tsukiji", "tsukiji_chiba", "築地", "築地産直ファーム", "築地産直ファーム（千葉分）"):
        return "tsukiji", _TODAY_TSUKIJI_COLS, TODAY_TSUKIJI_JSON, TODAY_TSUKIJI_XLSX
    if key in ("national_azabu", "ナショナル麻布", "national azabu"):
        return "national_azabu", _TODAY_NATIONAL_AZABU_COLS, TODAY_NATIONAL_AZABU_JSON, TODAY_NATIONAL_AZABU_XLSX
    if key in ("fusui", "fusui_project", "風水プロジェクト", "ゆうき市場"):
        return "fusui", _TODAY_FUSUI_COLS, TODAY_FUSUI_JSON, TODAY_FUSUI_XLSX
    if key in ("nanohana", "nanohana_coop", "なのはな", "なのはな生協", "なのはな生活協同組合"):
        return "nanohana", _TODAY_NANOHANA_COLS, TODAY_NANOHANA_JSON, TODAY_NANOHANA_XLSX
    if key in ("greenworld", "グリーンワールド", "グリーンワールド株式会社"):
        return "greenworld", _TODAY_GREENWORLD_COLS, TODAY_GREENWORLD_JSON, TODAY_GREENWORLD_XLSX
    if key in ("rosen", "相鉄ローゼン", "株式会社相鉄ローゼン"):
        return "rosen", _TODAY_ROSEN_COLS, TODAY_ROSEN_JSON, TODAY_ROSEN_XLSX
    if key == "chiba":
        return "chiba", _TODAY_ORDER_COLS, TODAY_ORDER_JSON, TODAY_ORDER_XLSX
    raise HTTPException(status_code=400, detail=f"Unsupported today-order format '{fmt}'")


def _validate_today_unit(raw_unit: str) -> tuple[bool, str, str]:
    raw_str = str(raw_unit or "")
    val = unicodedata.normalize("NFKC", raw_str).strip()
    if not val:
        return False, "", "単位を入力・選択してください"
    if any(ch.isdigit() for ch in raw_str) or any(ch.isdigit() for ch in val):
        return False, val, "単位には数値を入力できません"
    lower = val.lower()
    for unit in _TODAY_VALID_UNITS:
        if unit.lower() == lower:
            return True, unit, ""
    return True, val, ""


def _default_today_order_rows(fmt: str = "chiba") -> list[dict]:
    if fmt == "haibukiya":
        rows = [
            {"type": "title",    "cells": ["発注書　株式会社灰吹屋 御中（全列フォーマット）"] + [""] * (_TODAY_HAIBUKIYA_COLS - 1)},
            {"type": "meta",     "cells": ["販売部 部長 石川様　／　宮前平店 店長 佐藤様　／　発注先：㈱ベジコープ（FAX 03-6808-0900）"] + [""] * (_TODAY_HAIBUKIYA_COLS - 1)},
            {"type": "meta",     "cells": ["見積期間：2026年10月19日（月）〜10月24日（土）販売分　／　価格は店着価格（税別）　／　作成：2026年10月19日 佐藤・栗山"] + [""] * (_TODAY_HAIBUKIYA_COLS - 1)},
            {"type": "spacer",   "cells": [""] * _TODAY_HAIBUKIYA_COLS},
            {"type": "header",   "cells": [
                "品目", "産地", "栽培区分", "規格・入数", "単価/p", "単価/cs", "JANコード",
                "10/19\n月", "変更",
                "10/20\n火", "変更",
                "10/21\n水", "変更",
                "10/22\n木", "変更",
                "10/23\n金", "変更",
                "10/24\n土", "変更",
                "備考・産地状況",
            ]},
            {"type": "category", "cells": ["葉物類"] + [""] * (_TODAY_HAIBUKIYA_COLS - 1)},
            {"type": "item",     "cells": ["水菜", "千葉", "特別栽培", "150g/5p", "165", "825", "4514811010524", "1", "", "", "", "", "", "6", "1", "", "", "", "", "生育不良により欠品の可能性あり"]},
            {"type": "item",     "cells": ["ベビーリーフ", "千葉", "特別栽培", "40g/5p", "165", "825", "4514811010470", "1", "", "", "", "", "", "1", "6", "", "", "", "", "生育不良により欠品の可能性あり"]},
            {"type": "category", "cells": ["葉菜類"] + [""] * (_TODAY_HAIBUKIYA_COLS - 1)},
            {"type": "item",     "cells": ["サニーレタス", "群馬・長野", "特別栽培", "L/5玉", "190", "950", "4514811010036", "5", "", "", "", "", "", "5", "", "", "", "", "", ""]},
            {"type": "category", "cells": ["根菜類"] + [""] * (_TODAY_HAIBUKIYA_COLS - 1)},
            {"type": "item",     "cells": ["人参", "青森・北海道・山梨", "特別栽培", "400g/5p", "225", "1,125", "4514811010111", "1", "", "", "", "", "", "", "", "", "", "", "", ""]},
            {"type": "item",     "cells": ["じゃが芋", "青森・岩手・北海道", "特別栽培", "約500g/5p", "275", "1,375", "4514811010128", "", "", "", "", "", "", "1", "", "", "", "", "", ""]},
            {"type": "item",     "cells": ["玉ねぎ", "北海道", "特別栽培", "500g/5p", "280", "1,400", "4514811050339", "", "", "", "", "", "", "1", "", "", "", "", "", ""]},
            {"type": "item",     "cells": ["生姜", "熊本・千葉", "特別栽培", "50g/5p", "145", "725", "4514811013730", "1", "", "", "", "", "", "", "", "", "", "", "", ""]},
            {"type": "item",     "cells": ["にんにく", "長野", "特別栽培", "1〜2コ/5p", "198", "990", "4514811011187", "1", "", "", "", "", "", "", "", "", "", "", "", "群馬県産終了"]},
            {"type": "category", "cells": ["果物類"] + [""] * (_TODAY_HAIBUKIYA_COLS - 1)},
            {"type": "item",     "cells": ["レモン", "香川", "特別栽培", "2コ/5p", "245", "1,225", "4514811010678", "1", "", "", "", "", "", "", "", "", "", "", "", ""]},
            {"type": "category", "cells": ["イタリア・レストラン野菜"] + [""] * (_TODAY_HAIBUKIYA_COLS - 1)},
            {"type": "item",     "cells": ["カリーノケール", "群馬・長野", "特別栽培", "100g/5p", "155", "775", "4514811014966", "3", "", "", "", "", "", "3", "", "", "", "", "", "生育不良により欠品の可能性あり"]},
            {"type": "spacer",   "cells": [""] * _TODAY_HAIBUKIYA_COLS},
            {"type": "note",     "cells": ["※ 原本の「数量」欄および「変更」欄の数値を全列に反映。"] + [""] * (_TODAY_HAIBUKIYA_COLS - 1)},
            {"type": "note",     "cells": ["※ 10/21（水）は納品なし（グレー）。店舗直納のため、1回あたりの発注合計は8,000円以上でお願いします。"] + [""] * (_TODAY_HAIBUKIYA_COLS - 1)},
            {"type": "note",     "cells": ["※ 発注数の入っている品目のみ表示（発注なし・休止の品目は省略）。"] + [""] * (_TODAY_HAIBUKIYA_COLS - 1)},
        ]
        for _ in range(4):
            rows.append({"type": "data", "cells": [""] * _TODAY_HAIBUKIYA_COLS})
        return rows

    if fmt == "tsukiji":
        rows = [
            {"type": "title",  "cells": ["発注書　築地産直ファーム（千葉分）"] + [""] * (_TODAY_TSUKIJI_COLS - 1)},
            {"type": "meta",   "cells": ["宛先：千葉および群馬（榛東集配センター）御中"] + [""] * (_TODAY_TSUKIJI_COLS - 1)},
            {"type": "meta",   "cells": ["納品期間：2026年10月26日（月）〜10月31日（土）"] + [""] * (_TODAY_TSUKIJI_COLS - 1)},
            {"type": "spacer", "cells": [""] * _TODAY_TSUKIJI_COLS},
            {"type": "header", "cells": ["区分", "産地", "品目", "単位", "10/26\n月", "10/27\n火", "10/28\n水", "10/29\n木", "10/30\n金", "10/31\n土", "備考"]},
            {"type": "item",   "cells": ["", "千葉", "ベビーリーフ", "pc", "10", "10", "", "10", "10", "10", ""]},
            {"type": "item",   "cells": ["", "千葉", "ルッコラ", "pc", "", "", "休止", "", "", "", ""]},
            {"type": "item",   "cells": ["レア", "千葉", "ライフ・レアベジタブル用スイスチャード50g", "pc", "85", "", "", "", "94", "", "10/30は仮"]},
            {"type": "item",   "cells": ["レア", "千葉", "ケールバラ5kg（アクト農場）", "箱", "1", "", "3", "", "4", "", "新規"]},
            {"type": "item",   "cells": ["", "千葉", "人参10kg", "箱", "2", "", "2", "", "2", "", ""]},
            {"type": "item",   "cells": ["風か様", "千葉", "ホテル風か様用・有機人参10kg", "箱", "", "", "", "", "", "", "数量記入なし"]},
            {"type": "data",   "cells": ["", "", "箱数（原本の合計）", "", "588", "10", "311", "10", "596", "10", "千葉・群馬合算"]},
            {"type": "data",   "cells": ["", "", "物流", "", "千葉経由", "千葉経由", "千葉経由", "千葉経由", "千葉経由", "千葉経由", ""]},
            {"type": "spacer", "cells": [""] * _TODAY_TSUKIJI_COLS},
            {"type": "note",   "cells": ["※ レアベジタブル・ホテル風か様分はシール貼付をお願いします。"] + [""] * (_TODAY_TSUKIJI_COLS - 1)},
            {"type": "note",   "cells": ["※ 黄色＝レアベジタブル用　／　橙＝ホテル風か様用"] + [""] * (_TODAY_TSUKIJI_COLS - 1)},
            {"type": "note",   "cells": ["※ 箱数は原本の数値（千葉・群馬の合算）をそのまま記載しています。"] + [""] * (_TODAY_TSUKIJI_COLS - 1)},
        ]
        for _ in range(4):
            rows.append({"type": "data", "cells": [""] * _TODAY_TSUKIJI_COLS})
        return rows

    if fmt == "national_azabu":
        rows = [
            {"type": "title",    "cells": ["発注書　ナショナル麻布株式会社 御中（発注分のみ）"] + [""] * (_TODAY_NATIONAL_AZABU_COLS - 1)},
            {"type": "meta",     "cells": ["青果部 沖津様　／　発注先：㈱ベジコープ（FAX 03-6808-0900）"] + [""] * (_TODAY_NATIONAL_AZABU_COLS - 1)},
            {"type": "meta",     "cells": ["見積期間：2026年10月19日（月）〜10月24日（土）販売分　／　単価は税別　／　作成：2026年10月13日 内藤 渉"] + [""] * (_TODAY_NATIONAL_AZABU_COLS - 1)},
            {"type": "spacer",   "cells": [""] * _TODAY_NATIONAL_AZABU_COLS},
            {"type": "header",   "cells": [
                "品目", "産地", "規格・入数", "単価/p", "単価/cs", "JANコード",
                "10/19\n月", "10/20\n火", "10/21\n水", "10/22\n木", "10/23\n金", "10/24\n土",
                "備考・産地状況",
            ]},
            {"type": "category", "cells": ["果菜類"] + [""] * (_TODAY_NATIONAL_AZABU_COLS - 1)},
            {"type": "item",     "cells": ["ズッキーニ", "長野", "1本/10p", "250", "2,500", "4514811010289", "", "1cs", "", "1cs", "", "1cs", ""]},
            {"type": "item",     "cells": ["イエローズッキーニ", "長野", "1本/10p", "190", "1,900", "4514811011460", "", "1cs", "", "", "", "1cs", ""]},
            {"type": "category", "cells": ["根菜類"] + [""] * (_TODAY_NATIONAL_AZABU_COLS - 1)},
            {"type": "item",     "cells": ["人参", "青森・北海道・山梨", "400g/18p", "220", "3,960", "4514811010111", "", "1cs", "", "1cs", "1cs", "1cs", ""]},
            {"type": "item",     "cells": ["にんにく", "栃木", "1コ/10p", "198", "1,980", "4514811011187", "1cs", "1cs", "", "1cs", "1cs", "1cs", ""]},
            {"type": "category", "cells": ["果物類"] + [""] * (_TODAY_NATIONAL_AZABU_COLS - 1)},
            {"type": "item",     "cells": ["レモン", "熊本", "2コ/10p", "245", "2,450", "4514811010678", "1cs", "", "", "", "", "", ""]},
            {"type": "spacer",   "cells": [""] * _TODAY_NATIONAL_AZABU_COLS},
            {"type": "note",     "cells": ["※ 発注数の単位はケース（cs）。10/21（水）は納品なし（グレー）。"] + [""] * (_TODAY_NATIONAL_AZABU_COLS - 1)},
            {"type": "note",     "cells": ["※ 発注数の入っている品目のみ表示（発注なし・休止の品目は省略）。"] + [""] * (_TODAY_NATIONAL_AZABU_COLS - 1)},
        ]
        for _ in range(4):
            rows.append({"type": "data", "cells": [""] * _TODAY_NATIONAL_AZABU_COLS})
        return rows

    if fmt == "props_japan":
        rows = [
            {"type": "title",  "cells": ["注文書　株式会社プロップスジャパン（発注分のみ）"] + [""] * (_TODAY_PROPS_COLS - 1)},
            {"type": "meta",   "cells": ["宛先：ベジコープ 御中　／　担当：井上（TEL 045-474-5221　FAX 045-474-5222）"] + [""] * (_TODAY_PROPS_COLS - 1)},
            {"type": "meta",   "cells": ["納品期間：2026年9月21日（月）〜9月26日（土）　／　作成：2026年9月25日"] + [""] * (_TODAY_PROPS_COLS - 1)},
            {"type": "spacer", "cells": [""] * _TODAY_PROPS_COLS},
            {"type": "header", "cells": ["品番", "品名", "単位", "ロット", "9/21\n月", "9/22\n火", "9/23\n水", "9/24\n木", "9/25\n金", "9/26\n土"]},
            {"type": "item",   "cells": ["Y682", "有機たまねぎ400g", "パック", "10", "", "", "", "", "", "40"]},
            {"type": "item",   "cells": ["0636", "インカのめざめ500g", "パック", "10", "", "", "", "", "", "40"]},
            {"type": "item",   "cells": ["0663", "シャドークイーン500g", "パック", "10", "", "", "", "", "", "10"]},
            {"type": "item",   "cells": ["0667", "アンデスレッド500g", "パック", "10", "", "", "", "", "", "20"]},
            {"type": "item",   "cells": ["0855", "金美にんじん400g", "パック", "10", "", "", "", "", "", "20"]},
            {"type": "item",   "cells": ["0995", "リーキ", "パック", "10", "", "", "", "", "", "10"]},
            {"type": "item",   "cells": ["0827", "ゆりね", "パック", "10", "", "", "", "", "", "10"]},
            {"type": "spacer", "cells": [""] * _TODAY_PROPS_COLS},
            {"type": "note",   "cells": ["※ 急な欠品等は携帯電話（090-9857-5210）へご連絡ください。"] + [""] * (_TODAY_PROPS_COLS - 1)},
            {"type": "note",   "cells": ["※ 発注数の入っている品目のみ表示（発注なしの品目は省略）。"] + [""] * (_TODAY_PROPS_COLS - 1)},
        ]
        for _ in range(4):
            rows.append({"type": "data", "cells": [""] * _TODAY_PROPS_COLS})
        return rows

    if fmt == "fusui":
        rows = [
            {"type": "title",  "cells": ["発注書　株式会社風水プロジェクト（ゆうき市場）"] + [""] * (_TODAY_FUSUI_COLS - 1)},
            {"type": "meta",   "cells": ["株式会社ベジコープ 御中（12765）　／　発注者：青果発注 宮島　／　No.000000437576"] + [""] * (_TODAY_FUSUI_COLS - 1)},
            {"type": "meta",   "cells": ["ゆうき市場事業本部 ㈱風水プロジェクト 〒155-0032 東京都世田谷区代沢　TEL 050-5527-2131　FAX 03-5433-4185"] + [""] * (_TODAY_FUSUI_COLS - 1)},
            {"type": "meta",   "cells": ["発注日：2026年10月22日　／　納品指定日：2026年10月25日（日）　／　納品場所：引取にて"] + [""] * (_TODAY_FUSUI_COLS - 1)},
            {"type": "spacer", "cells": [""] * _TODAY_FUSUI_COLS},
            {"type": "header", "cells": ["商品コード", "商品名", "規格", "数量", "単価（円）", "金額（円）"]},
            {"type": "item",   "cells": ["1029510171", "有機青じそ 10枚P 有機認証（広島県）出来商店", "10枚P", "100", "125", "12,500"]},
            {"type": "spacer", "cells": [""] * _TODAY_FUSUI_COLS},
            {"type": "note",   "cells": ["※ 上記住所は納品場所ではありません。受注の返信FAXは上記の番号へお願いします。"] + [""] * (_TODAY_FUSUI_COLS - 1)},
            {"type": "note",   "cells": ["※ 内容確認後、返信をお願いします。変更がある場合はお電話ください。"] + [""] * (_TODAY_FUSUI_COLS - 1)},
        ]
        for _ in range(4):
            rows.append({"type": "data", "cells": [""] * _TODAY_FUSUI_COLS})
        return rows

    if fmt == "nanohana":
        rows = [
            {"type": "title",  "cells": ["発注書　なのはな生活協同組合"] + [""] * (_TODAY_NANOHANA_COLS - 1)},
            {"type": "meta",   "cells": ["宛先：株式会社ベジコープ 御中　／　発注番号：0455971　／　担当：渡邊"] + [""] * (_TODAY_NANOHANA_COLS - 1)},
            {"type": "meta",   "cells": ["発注日：2026年10月23日（金）　／　10月4回　／　納品日：2026年10月29日（木）　／　納品場所：なのはな生活協同組合"] + [""] * (_TODAY_NANOHANA_COLS - 1)},
            {"type": "meta",   "cells": ["発注元：〒263-0001 千葉市稲毛区長沼原町678-2　TEL 043-216-7087　FAX 043-215-0510"] + [""] * (_TODAY_NANOHANA_COLS - 1)},
            {"type": "spacer", "cells": [""] * _TODAY_NANOHANA_COLS},
            {"type": "header", "cells": ["注文No.", "商品名", "規格容量", "納入価格（円）", "総数（P）", "金額（円）"]},
            {"type": "item",   "cells": ["648", "有機じゃが芋", "600g", "230.0", "23", "5,290"]},
            {"type": "item",   "cells": ["650", "有機玉ねぎ", "600g", "230.0", "30", "6,900"]},
            {"type": "item",   "cells": ["658", "有機ルッコラ", "50g", "120.0", "12", "1,440"]},
            {"type": "item",   "cells": ["665", "有機生しい茸（菌床）", "90g", "178.0", "17", "3,026"]},
            {"type": "item",   "cells": ["666", "有機きくらげ", "60g", "147.0", "14", "2,058"]},
            {"type": "item",   "cells": ["667", "有機たもぎたけ", "100g", "210.0", "13", "2,730"]},
            {"type": "item",   "cells": ["668", "じゃが芋", "500g", "165.0", "12", "1,980"]},
            {"type": "item",   "cells": ["669", "じゃが芋", "1kg", "280.0", "26", "7,280"]},
            {"type": "item",   "cells": ["672", "玉ねぎ", "500g", "165.0", "40", "6,600"]},
            {"type": "item",   "cells": ["673", "玉ねぎ", "1kg", "265.0", "80", "21,200"]},
            {"type": "item",   "cells": ["675", "ごぼう（カット）", "200g", "160.0", "36", "5,760"]},
            {"type": "item",   "cells": ["680", "大根（カット）", "1本分", "180.0", "59", "10,620"]},
            {"type": "item",   "cells": ["681", "大根（ハーフ）", "1/2本", "120.0", "53", "6,360"]},
            {"type": "item",   "cells": ["687", "白菜", "1個", "290.0", "25", "7,250"]},
            {"type": "item",   "cells": ["688", "ミニ白菜", "1個", "155.0", "80", "12,400"]},
            {"type": "item",   "cells": ["689", "キャベツ", "1個", "190.0", "102", "19,380"]},
            {"type": "item",   "cells": ["705", "葉ねぎ", "100g", "130.0", "47", "6,110"]},
            {"type": "item",   "cells": ["199401", "長ねぎ（カット）", "300g", "280.0", "25", "7,000"]},
            {"type": "data",   "cells": ["合計", "", "", "", "694", "133,384"]},
            {"type": "spacer", "cells": [""] * _TODAY_NANOHANA_COLS},
            {"type": "note",   "cells": ["※ 午前着指定で発送をお願いします。"] + [""] * (_TODAY_NANOHANA_COLS - 1)},
            {"type": "note",   "cells": ["※ 金額は納入価格×総数で算出した参考値です（原本には記載なし）。"] + [""] * (_TODAY_NANOHANA_COLS - 1)},
        ]
        for _ in range(4):
            rows.append({"type": "data", "cells": [""] * _TODAY_NANOHANA_COLS})
        return rows

    if fmt == "greenworld":
        rows = [
            {"type": "title",  "cells": ["発注書　グリーンワールド株式会社"] + [""] * (_TODAY_GREENWORLD_COLS - 1)},
            {"type": "meta",   "cells": ["宛先：株式会社ベジコープ ご担当者様　／　担当：中谷（TEL 03-3857-7330　FAX 03-3857-7337）"] + [""] * (_TODAY_GREENWORLD_COLS - 1)},
            {"type": "meta",   "cells": ["発注日：2026年10月8日　／　店着予定日：2026年10月11日"] + [""] * (_TODAY_GREENWORLD_COLS - 1)},
            {"type": "spacer", "cells": [""] * _TODAY_GREENWORLD_COLS},
            {"type": "header", "cells": ["No.", "商品名", "規格", "入数", "ケース数", "価格（CS）", "合計"]},
            {"type": "item",   "cells": ["1", "有機カリーノケール（長野県産）", "1ケース", "", "2", "", ""]},
            {"type": "spacer", "cells": [""] * _TODAY_GREENWORLD_COLS},
            {"type": "data",   "cells": ["合計（ケース数）", "", "", "", "2", "", ""]},
            {"type": "spacer", "cells": [""] * _TODAY_GREENWORLD_COLS},
            {"type": "note",   "cells": ["※ 今回の発注は「有機カリーノケール（長野県産）2ケース」のみ（黄色）。価格欄は原本で未記入。"] + [""] * (_TODAY_GREENWORLD_COLS - 1)},
            {"type": "note",   "cells": ["※ ご確認のうえ、納品書の返信をお願いします。"] + [""] * (_TODAY_GREENWORLD_COLS - 1)},
        ]
        for _ in range(4):
            rows.append({"type": "data", "cells": [""] * _TODAY_GREENWORLD_COLS})
        return rows

    if fmt == "rosen":
        rows = [
            {"type": "title",  "cells": ["週間発注リスト 株式会社相鉄ローゼン"] + [""] * (_TODAY_ROSEN_COLS - 1)},
            {"type": "meta",   "cells": ["宛先：株式会社ベジコープ 御中"] + [""] * (_TODAY_ROSEN_COLS - 1)},
            {"type": "meta",   "cells": ["発注期間：2026年10月24日（土）〜10月30日（金）"] + [""] * (_TODAY_ROSEN_COLS - 1)},
            {"type": "spacer", "cells": [""] * _TODAY_ROSEN_COLS},
            {"type": "header", "cells": ["商品コード", "商品名", "入数", "原価", "総数", "10/24\n土", "10/25\n日", "10/26\n月", "10/27\n火", "10/28\n水", "10/29\n木", "10/30\n金", "備考"]},
            {"type": "item",   "cells": ["", "特別栽培ベビーリーフ40gパック", "", "", "", "", "", "", "", "", "", "", ""]},
            {"type": "item",   "cells": ["", "特別栽培小松菜250g袋", "", "", "", "", "", "", "", "", "", "", ""]},
            {"type": "spacer", "cells": [""] * _TODAY_ROSEN_COLS},
            {"type": "note",   "cells": ["※ 発注数の入っている品目のみ表示（発注なし・休止の品目は省略）。"] + [""] * (_TODAY_ROSEN_COLS - 1)},
            {"type": "note",   "cells": ["※ 原本の通りに数量を入力してください。"] + [""] * (_TODAY_ROSEN_COLS - 1)},
        ]
        for _ in range(4):
            rows.append({"type": "data", "cells": [""] * _TODAY_ROSEN_COLS})
        return rows

    rows = [
        {"type": "title",  "cells": ["千葉自動発注書（発注分のみ）", "", "", "", "", "", "", ""]},
        {"type": "meta",   "cells": ["宛先：千葉成田センター\u3000／\u3000発注先：葛西産直ファーム", "", "", "", "", "", "", ""]},
        {"type": "meta",   "cells": ["対象期間：2026年10月26日（月）〜10月31日（土）", "", "", "", "", "", "", ""]},
        {"type": "spacer", "cells": [""] * _TODAY_ORDER_COLS},
        {"type": "header", "cells": ["品目", "単位", "10/26\n月", "10/27\n火", "10/28\n水", "10/29\n木", "10/30\n金", "10/31\n土"]},
        {"type": "merged", "cells": ["今週（10/26〜10/31）の発注はありません（全品目 休止）", "", "", "", "", "", "", ""]},
        {"type": "spacer", "cells": [""] * _TODAY_ORDER_COLS},
        {"type": "note",   "cells": ["※ 発注数の入っている品目のみ表示する設定ですが、今週は該当する品目がありません。", "", "", "", "", "", "", ""]},
        {"type": "note",   "cells": ["※ 原本では大根・赤からし水菜・小江戸菜・スイスチャード・ほうれん草・キャベツが休止、ホテル風か様用は数量未記入。", "", "", "", "", "", "", ""]},
    ]
    for _ in range(6):
        rows.append({"type": "data", "cells": [""] * _TODAY_ORDER_COLS})
    return rows


def _normalize_today_order_rows(raw_rows: list, ncols: int = _TODAY_ORDER_COLS) -> list[dict]:
    allowed_types = {"title", "meta", "spacer", "header", "category", "item", "merged", "note", "data"}
    clean = []
    for r in raw_rows:
        rtype = (r.get("type") if isinstance(r, dict) else getattr(r, "type", "data")) or "data"
        if rtype not in allowed_types:
            rtype = "data"
        raw_cells = r.get("cells") if isinstance(r, dict) else getattr(r, "cells", [])
        cells = [str(c) if c is not None else "" for c in (raw_cells or [])[:ncols]]
        while len(cells) < ncols:
            cells.append("")
        clean.append({"type": rtype, "cells": cells})
    return clean


def _write_today_order_xlsx(rows: list[dict], fmt: str = "chiba", xlsx_path: Optional[Path] = None) -> None:
    import openpyxl
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.worksheet.datavalidation import DataValidation

    _, ncols, _, default_xlsx = _get_today_format_cfg(fmt)
    target_path = xlsx_path or default_xlsx

    last_non_empty = -1
    for idx, r in enumerate(rows):
        if any(str(c).strip() for c in r.get("cells", [])):
            last_non_empty = idx
    export_rows = rows[: max(1, last_non_empty + 1)]

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "発注書"

    if fmt == "haibukiya":
        col_widths = {
            "A": 18.0, "B": 15.0, "C": 12.0, "D": 14.0, "E": 9.5, "F": 9.5, "G": 16.0,
            "H": 7.5, "I": 7.5, "J": 7.5, "K": 7.5, "L": 7.5, "M": 7.5,
            "N": 7.5, "O": 7.5, "P": 7.5, "Q": 7.5, "R": 7.5, "S": 7.5,
            "T": 28.0,
        }
        for col_letter, width in col_widths.items():
            ws.column_dimensions[col_letter].width = width
    elif fmt == "props_japan":
        col_widths = {
            "A": 11.0, "B": 30.0, "C": 10.0, "D": 9.0,
            "E": 10.0, "F": 10.0, "G": 10.0, "H": 10.0, "I": 10.0, "J": 10.0,
        }
        for col_letter, width in col_widths.items():
            ws.column_dimensions[col_letter].width = width
    elif fmt == "national_azabu":
        col_widths = {
            "A": 20.0, "B": 14.0, "C": 12.0, "D": 9.0, "E": 9.5, "F": 16.0,
            "G": 8.0, "H": 8.0, "I": 8.0, "J": 8.0, "K": 8.0, "L": 8.0,
            "M": 28.0,
        }
        for col_letter, width in col_widths.items():
            ws.column_dimensions[col_letter].width = width
    elif fmt == "tsukiji":
        col_widths = {
            "A": 9.0, "B": 9.0, "C": 34.0, "D": 8.0,
            "E": 9.0, "F": 9.0, "G": 9.0, "H": 9.0, "I": 9.0, "J": 9.0,
            "K": 20.0,
        }
        for col_letter, width in col_widths.items():
            ws.column_dimensions[col_letter].width = width
    elif fmt == "fusui":
        col_widths = {"A": 14.0, "B": 42.0, "C": 10.0, "D": 9.0, "E": 11.0, "F": 11.0}
        for col_letter, width in col_widths.items():
            ws.column_dimensions[col_letter].width = width
    elif fmt == "nanohana":
        col_widths = {"A": 12.0, "B": 28.0, "C": 12.0, "D": 15.0, "E": 12.0, "F": 15.0}
        for col_letter, width in col_widths.items():
            ws.column_dimensions[col_letter].width = width
    elif fmt == "greenworld":
        col_widths = {"A": 7.0, "B": 36.0, "C": 12.0, "D": 9.0, "E": 10.0, "F": 12.0, "G": 12.0}
        for col_letter, width in col_widths.items():
            ws.column_dimensions[col_letter].width = width
    elif fmt == "rosen":
        col_widths = {
            "A": 8.0, "B": 36.0, "C": 8.0, "D": 10.0, "E": 10.0,
            "F": 10.0, "G": 10.0, "H": 10.0, "I": 10.0, "J": 10.0,
            "K": 10.0, "L": 10.0, "M": 18.0,
        }
        for col_letter, width in col_widths.items():
            ws.column_dimensions[col_letter].width = width
    else:
        ws.column_dimensions["A"].width = 48.0
        for col_letter in ("B", "C", "D", "E", "F", "G", "H"):
            ws.column_dimensions[col_letter].width = 10.0

    font_title = Font(name="Arial", size=18, bold=True, color="1F3864")
    font_meta = Font(name="Arial", size=11, bold=False, color="333333")
    font_hdr = Font(name="Arial", size=11, bold=True, color="FFFFFF")
    font_cat = Font(name="Arial", size=11, bold=True, color="1F3864")
    font_body = Font(name="Arial", size=11, bold=False, color="000000")
    font_note = Font(name="Arial", size=10, bold=False, color="333333")
    font_paused = Font(name="Arial", size=11, bold=True, color="DC2626")
    font_summary = Font(name="Arial", size=11, bold=True, color="1F3864")
    fill_hdr = PatternFill(fill_type="solid", start_color="1F3864", end_color="1F3864")
    fill_cat = PatternFill(fill_type="solid", start_color="D9E1F2", end_color="D9E1F2")
    fill_wed_off = PatternFill(fill_type="solid", start_color="E2E5EA", end_color="E2E5EA")
    fill_rare = PatternFill(fill_type="solid", start_color="FEF9C3", end_color="FEF9C3")
    fill_fuuka = PatternFill(fill_type="solid", start_color="FFEDD5", end_color="FFEDD5")
    fill_summary = PatternFill(fill_type="solid", start_color="D9E1F2", end_color="D9E1F2")
    thin_side = Side(style="thin", color="333333")
    grid_side = Side(style="thin", color="D0D0D0")

    for r_idx, row in enumerate(export_rows, start=1):
        rtype = row.get("type", "data")
        cells = row.get("cells", [])

        if rtype == "header":
            ws.row_dimensions[r_idx].height = 36.0
        elif rtype == "merged":
            ws.row_dimensions[r_idx].height = 28.0
        elif rtype == "category":
            ws.row_dimensions[r_idx].height = 22.0

        for c_idx in range(1, ncols + 1):
            raw_val = cells[c_idx - 1] if c_idx - 1 < len(cells) else ""
            val = raw_val
            if fmt == "chiba":
                is_num_col = (c_idx >= 3)
            elif fmt == "props_japan":
                is_num_col = (c_idx >= 4)
            elif fmt == "national_azabu":
                is_num_col = (c_idx in (4, 5) or (c_idx >= 7 and c_idx <= 12))
            elif fmt == "tsukiji":
                is_num_col = (5 <= c_idx <= 10)
            elif fmt == "fusui":
                is_num_col = (c_idx >= 4)
            elif fmt == "nanohana":
                is_num_col = (c_idx >= 4)
            elif fmt == "greenworld":
                is_num_col = (c_idx >= 4)
            elif fmt == "rosen":
                is_num_col = (c_idx in (4, 5) or (c_idx >= 6 and c_idx <= 12))
            else:
                is_num_col = (c_idx in (5, 6) or (c_idx >= 8 and c_idx <= 19))
            if rtype in ("item", "data") and is_num_col and str(raw_val).strip():
                try:
                    num = float(str(raw_val).replace(",", "").strip())
                    val = int(num) if num.is_integer() else num
                except ValueError:
                    val = raw_val
            cell = ws.cell(row=r_idx, column=c_idx, value=val if val != "" else None)

            if rtype == "title" and c_idx == 1:
                cell.font = font_title
            elif rtype == "meta" and c_idx == 1:
                cell.font = font_meta
            elif rtype == "header":
                cell.font = font_hdr
                cell.fill = fill_hdr
                if fmt == "haibukiya":
                    horiz = "left" if c_idx in (1, 2, 3, 4, 20) else ("right" if c_idx in (5, 6) else "center")
                elif fmt == "props_japan":
                    horiz = "left" if c_idx == 2 else ("right" if c_idx == 4 else "center")
                elif fmt == "national_azabu":
                    horiz = "left" if c_idx in (1, 2, 3, 13) else ("right" if c_idx in (4, 5) else "center")
                elif fmt == "tsukiji":
                    horiz = "center" if (1 <= c_idx <= 2 or c_idx == 4 or 5 <= c_idx <= 10) else ("left" if c_idx == 3 or c_idx == 11 else "center")
                elif fmt == "fusui":
                    horiz = "left" if c_idx == 2 else ("right" if c_idx >= 4 else "center")
                elif fmt == "nanohana":
                    horiz = "left" if c_idx == 2 else ("right" if c_idx >= 4 else "center")
                elif fmt == "greenworld":
                    horiz = "left" if c_idx == 2 else ("right" if c_idx >= 4 else "center")
                elif fmt == "rosen":
                    horiz = "left" if c_idx in (2, 13) else ("right" if c_idx in (4, 5) else "center")
                else:
                    horiz = "left" if c_idx == 1 else ("right" if c_idx == 2 else "center")
                cell.alignment = Alignment(horizontal=horiz, vertical="center", wrap_text=True)
            elif rtype == "category":
                cell.font = font_cat
                cell.fill = fill_cat
                cell.alignment = Alignment(horizontal="left", vertical="center")
                cell.border = Border(top=grid_side, bottom=grid_side, left=grid_side, right=grid_side)
            elif rtype == "merged":
                cell.font = font_body
                cell.alignment = Alignment(horizontal="center", vertical="center")
                cell.border = Border(bottom=thin_side)
            elif rtype == "note" and c_idx == 1:
                cell.font = font_note
            elif rtype in ("item", "data"):
                cell.font = font_body
                if fmt == "haibukiya":
                    if c_idx in (12, 13):
                        cell.fill = fill_wed_off
                    if c_idx in (5, 6) or (c_idx >= 8 and c_idx <= 19):
                        cell.alignment = Alignment(horizontal="right", vertical="center")
                    elif c_idx == 7:
                        cell.alignment = Alignment(horizontal="center", vertical="center")
                elif fmt == "national_azabu":
                    if c_idx == 9:
                        cell.fill = fill_wed_off
                    if c_idx in (4, 5) or (c_idx >= 7 and c_idx <= 12):
                        cell.alignment = Alignment(horizontal="right", vertical="center")
                    elif c_idx == 6:
                        cell.alignment = Alignment(horizontal="center", vertical="center")
                elif fmt == "tsukiji":
                    div_val = str(cells[0] if len(cells) > 0 else "").strip()
                    item_val = str(cells[2] if len(cells) > 2 else "").strip()
                    if div_val == "レア":
                        cell.fill = fill_rare
                    elif div_val == "風か様":
                        cell.fill = fill_fuuka
                    elif "箱数" in item_val:
                        cell.fill = fill_summary
                        cell.font = font_summary
                    if str(raw_val).strip() == "休止":
                        cell.font = font_paused
                        cell.alignment = Alignment(horizontal="center", vertical="center")
                    elif c_idx in (1, 2, 4):
                        cell.alignment = Alignment(horizontal="center", vertical="center")
                    elif 5 <= c_idx <= 10:
                        if str(raw_val).strip() == "千葉経由":
                            cell.alignment = Alignment(horizontal="center", vertical="center")
                        else:
                            cell.alignment = Alignment(horizontal="right", vertical="center")
                    elif c_idx == 11:
                        cell.alignment = Alignment(horizontal="left", vertical="center")
                elif fmt == "props_japan":
                    if c_idx in (1, 3):
                        cell.alignment = Alignment(horizontal="center", vertical="center")
                    elif c_idx >= 4:
                        cell.alignment = Alignment(horizontal="right", vertical="center")
                    else:
                        cell.alignment = Alignment(horizontal="left", vertical="center")
                elif fmt == "fusui":
                    if c_idx in (1, 3):
                        cell.alignment = Alignment(horizontal="center", vertical="center")
                    elif c_idx >= 4:
                        cell.alignment = Alignment(horizontal="right", vertical="center")
                    else:
                        cell.alignment = Alignment(horizontal="left", vertical="center")
                elif fmt == "nanohana":
                    first_cell = str(cells[0] if len(cells) > 0 else "").strip()
                    if first_cell == "合計":
                        cell.font = font_summary
                        cell.fill = fill_summary
                    if c_idx in (1, 3):
                        cell.alignment = Alignment(horizontal="center", vertical="center")
                    elif c_idx == 2:
                        cell.alignment = Alignment(horizontal="left", vertical="center")
                    elif c_idx >= 4:
                        cell.alignment = Alignment(horizontal="right", vertical="center")
                elif fmt == "greenworld":
                    first_cell = str(cells[0] if len(cells) > 0 else "").strip()
                    if first_cell == "合計（ケース数）":
                        cell.font = font_summary
                        cell.fill = fill_summary
                    if c_idx in (1, 4):
                        cell.alignment = Alignment(horizontal="center", vertical="center")
                    elif c_idx in (2, 3):
                        cell.alignment = Alignment(horizontal="left", vertical="center")
                    elif c_idx >= 5:
                        cell.alignment = Alignment(horizontal="right", vertical="center")
                elif fmt == "rosen":
                    if c_idx == 1:
                        cell.alignment = Alignment(horizontal="center", vertical="center")
                    elif c_idx == 2:
                        cell.alignment = Alignment(horizontal="left", vertical="center")
                    elif c_idx in (4, 5) or (c_idx >= 6 and c_idx <= 12):
                        cell.alignment = Alignment(horizontal="right", vertical="center")
                    elif c_idx == 13:
                        cell.alignment = Alignment(horizontal="left", vertical="center")
                    else:
                        cell.alignment = Alignment(horizontal="center", vertical="center")
                else:
                    if c_idx == 2 or c_idx >= 3:
                        cell.alignment = Alignment(horizontal="right", vertical="center")
                cell.border = Border(top=grid_side, bottom=grid_side, left=grid_side, right=grid_side)

        if rtype in ("merged", "category"):
            ws.merge_cells(start_row=r_idx, start_column=1, end_row=r_idx, end_column=ncols)

    if fmt in ("chiba", "props_japan"):
        dv_units = DataValidation(
            type="list",
            formula1='"' + ",".join(_TODAY_VALID_UNITS) + '"',
            allow_blank=False,
        )
        dv_units.errorTitle = "無効な単位"
        dv_units.error = "有効な単位を選択してください（cs, p, kg, 束, 袋, 箱, 本, パック など）"
        ws.add_data_validation(dv_units)
        unit_col_letter = "C" if fmt == "props_japan" else "B"
        dv_units.add(f"{unit_col_letter}6:{unit_col_letter}{max(50, len(export_rows) + 10)}")

    target_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(target_path))


@app.get("/api/today-order", dependencies=[Depends(_require_api_key)])
async def get_today_order(format: str = Query(default="chiba")):
    """Return the persisted Today Order spreadsheet rows for the selected format."""
    fmt, ncols, json_path, xlsx_path = _get_today_format_cfg(format)
    if json_path.exists():
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
            rows = _normalize_today_order_rows(data.get("rows") or [], ncols=ncols)
            if rows:
                return {"format": fmt, "rows": rows, "updated_at": data.get("updated_at"), "is_default": False}
        except Exception as exc:
            logger.warning("Failed to read %s: %s", json_path.name, exc)
    default_rows = _default_today_order_rows(fmt)
    if not xlsx_path.exists():
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, _write_today_order_xlsx, default_rows, fmt, xlsx_path)
        except Exception as exc:
            logger.warning("Failed to generate default %s: %s", xlsx_path.name, exc)
    return {"format": fmt, "rows": default_rows, "updated_at": None, "is_default": True}


@app.put("/api/today-order", dependencies=[Depends(_require_api_key)])
async def save_today_order(request: Request, payload: TodayOrderPayload, format: str = Query(default="chiba")):
    """Save Today Order spreadsheet rows to disk and regenerate the format's .xlsx."""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    fmt, ncols, json_path, xlsx_path = _get_today_format_cfg(format)
    clean_rows = _normalize_today_order_rows(payload.rows, ncols=ncols)
    if fmt in ("chiba", "props_japan"):
        name_idx = 1 if fmt == "props_japan" else 0
        unit_idx = 2 if fmt == "props_japan" else 1
        for idx, row in enumerate(clean_rows, start=1):
            rtype = row.get("type", "data")
            cells = row.get("cells", [])
            name = (cells[name_idx] if len(cells) > name_idx else "").strip()
            if (rtype == "item" or (rtype == "data" and name)) and name:
                ok, norm_unit, err_msg = _validate_today_unit(cells[unit_idx] if len(cells) > unit_idx else "")
                if not ok:
                    raise HTTPException(status_code=400, detail=f"Row {idx} ({name}): {err_msg}")
                cells[unit_idx] = norm_unit
    updated_at = time.strftime("%Y-%m-%dT%H:%M:%S")
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(
        json.dumps({"format": fmt, "rows": clean_rows, "updated_at": updated_at}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _write_today_order_xlsx, clean_rows, fmt, xlsx_path)
    except Exception as exc:
        logger.warning("Failed to regenerate %s: %s", xlsx_path.name, exc)
    _audit(request, "today_order_save", f"format={fmt} rows={len(clean_rows)}")
    return {"format": fmt, "saved": True, "row_count": len(clean_rows), "updated_at": updated_at}


@app.delete("/api/today-order", dependencies=[Depends(_require_api_key)])
async def reset_today_order(request: Request, format: str = Query(default="chiba")):
    """Delete saved Today Order overrides and restore default workbook for the selected format."""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    fmt, _, json_path, xlsx_path = _get_today_format_cfg(format)
    if json_path.exists():
        json_path.unlink()
    default_rows = _default_today_order_rows(fmt)
    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _write_today_order_xlsx, default_rows, fmt, xlsx_path)
    except Exception as exc:
        logger.warning("Failed to reset %s: %s", xlsx_path.name, exc)
    _audit(request, "today_order_reset", f"format={fmt}")
    return {"format": fmt, "reset": True, "rows": default_rows}


@app.post("/api/ocr/save/{job_id}", dependencies=[Depends(_require_api_key)])
async def save_ocr_job(
    request: Request,
    job_id: str = FPath(..., pattern=JOB_ID_REGEX, max_length=64),
    payload: Optional[SaveJobRequest] = None,
):
    """Persist an extracted OCR result to MySQL when Save is clicked, using explicit or auto-detected client."""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")

    job = jobs.get(job_id)
    req_client_id = payload.client_id if payload and payload.client_id else None
    if job is not None:
        if job.get("status") != "done":
            raise HTTPException(status_code=409, detail="OCR extraction is not finished yet")
        result = (payload.result if payload and payload.result else None) or job.get("result")
        filename = (payload.filename if payload and payload.filename else None) or job.get("filename") or ""
        engine = (payload.engine if payload and payload.engine else None) or job.get("engine") or "all"
        if req_client_id is None and job.get("client_id"):
            req_client_id = job.get("client_id")
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
            client_id=req_client_id,
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
async def health(request: Request):
    # Minimal health response for unauthenticated container probes; full details only when logged in
    if not _get_authenticated_user(request):
        return {"status": "ok"}
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
    """Create a new client. Body: {name_ja, name_en, code, keywords?, header_row?, heading_columns?}"""
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
        result = db.add_client(
            name_ja=name_ja,
            name_en=name_en,
            code=code,
            keywords=keywords,
            header_row=payload.header_row or 1,
            heading_columns=payload.heading_columns or "",
        )
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
    updated = db.update_client(
        client_id,
        name_ja=name_ja,
        name_en=name_en,
        code=code,
        keywords=keywords,
        header_row=payload.header_row or 1,
        heading_columns=payload.heading_columns or "",
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Client not found")
    _audit(request, "client_update", f"client_id={client_id}")
    return {"updated": True, "id": client_id}


@app.put("/api/db/clients/{client_id}/heading-format", dependencies=[Depends(_require_api_key)])
async def update_client_heading_format_endpoint(request: Request, client_id: int, payload: ClientHeadingPayload):
    """Update only the heading format (header_row and heading_columns) for a client."""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    updated = db.update_client_heading_format(
        client_id=client_id,
        header_row=payload.header_row,
        heading_columns=payload.heading_columns,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Client not found")
    _audit(request, "client_heading_format_update", f"client_id={client_id} header_row={payload.header_row}")
    return {
        "updated": True,
        "id": client_id,
        "header_row": payload.header_row,
        "heading_columns": payload.heading_columns,
    }


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


# ---------------------------------------------------------------------------
# Product Master API Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/db/products", dependencies=[Depends(_require_api_key)])
async def list_products(
    limit:     int = Query(default=500, ge=1, le=2000),
    offset:    int = Query(default=0,   ge=0),
    client_id: Optional[int] = Query(default=None, ge=1),
    q:         Optional[str] = Query(default=None, max_length=100),
):
    """Return all products from `ocr_products` (optionally filtered by client_id or search query)."""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    rows = db.list_products(limit=limit, offset=offset, client_id=client_id, query=q)
    return [_serialize_dates(r) for r in rows]


@app.get("/api/db/products/{product_id}", dependencies=[Depends(_require_api_key)])
async def get_product_detail(product_id: int):
    """Get single product detail."""
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    p = db.get_product(product_id)
    if not p:
        raise HTTPException(status_code=404, detail="Product not found")
    return _serialize_dates(p)


@app.post("/api/db/products", dependencies=[Depends(_require_api_key)])
async def create_product(request: Request, payload: ProductPayload):
    """Create a new product record."""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    code = payload.product_code.strip()
    name_ja = payload.name_ja.strip()
    if not code or not name_ja:
        raise HTTPException(status_code=400, detail="product_code and name_ja are required")
    try:
        prod = db.create_product(
            product_code=code,
            name_ja=name_ja,
            name_en=payload.name_en,
            spec=payload.spec,
            unit_price=payload.unit_price,
            client_id=payload.client_id,
        )
    except Exception as exc:
        if "Duplicate entry" in str(exc) or "1062" in str(exc):
            raise HTTPException(status_code=409, detail=f"Product code '{code}' already exists")
        logger.exception("Failed to create product: %s", exc)
        raise HTTPException(status_code=500, detail="Internal database error")
    _audit(request, "product_create", f"id={prod.get('id')} code={code}")
    return _serialize_dates(prod)


@app.put("/api/db/products/{product_id}", dependencies=[Depends(_require_api_key)])
async def update_product(request: Request, product_id: int, payload: ProductPayload):
    """Update an existing product."""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    code = payload.product_code.strip()
    name_ja = payload.name_ja.strip()
    if not code or not name_ja:
        raise HTTPException(status_code=400, detail="product_code and name_ja are required")
    try:
        updated = db.update_product(
            product_id=product_id,
            product_code=code,
            name_ja=name_ja,
            name_en=payload.name_en,
            spec=payload.spec,
            unit_price=payload.unit_price,
            client_id=payload.client_id,
        )
    except Exception as exc:
        if "Duplicate entry" in str(exc) or "1062" in str(exc):
            raise HTTPException(status_code=409, detail=f"Product code '{code}' already exists")
        logger.exception("Failed to update product %s: %s", product_id, exc)
        raise HTTPException(status_code=500, detail="Internal database error")
    if not updated:
        raise HTTPException(status_code=404, detail="Product not found")
    _audit(request, "product_update", f"id={product_id} code={code}")
    return {"updated": True, "id": product_id}


@app.delete("/api/db/products/{product_id}", dependencies=[Depends(_require_api_key)])
async def delete_product(request: Request, product_id: int):
    """Delete a product from master."""
    _check_rate_limit(request, "db_write", max_requests=60, window_s=60)
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    deleted = db.delete_product(product_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Product not found")
    _audit(request, "product_delete", f"id={product_id}")
    return {"deleted": True, "id": product_id}


@app.get("/api/db/jobs", dependencies=[Depends(_require_api_key)])
async def list_jobs(
    request:   Request,
    limit:     int = Query(default=50, ge=1, le=1000),
    offset:    int = Query(default=0,  ge=0),
    client_id: Optional[int] = Query(default=None, ge=1),
):
    """Return recent OCR jobs stored in MySQL (optionally filtered by client_id)."""
    _check_rate_limit(request, "db_read", max_requests=120, window_s=60)
    if not db.is_connected():
        raise HTTPException(status_code=503, detail="Database not connected")
    rows = db.list_jobs(limit=limit, offset=offset, client_id=client_id)
    return [_serialize_dates(r) for r in rows]


@app.get("/api/db/jobs/{job_id}", dependencies=[Depends(_require_api_key)])
async def db_job_detail(job_id: str = FPath(..., pattern=JOB_ID_REGEX, max_length=64)):
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


@app.delete("/api/db/jobs", dependencies=[Depends(_require_api_key)])
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
async def delete_job(
    request: Request,
    job_id: str = FPath(..., pattern=JOB_ID_REGEX, max_length=64),
):
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
async def db_statistics(request: Request):
    """Return aggregate statistics from the MySQL database."""
    _check_rate_limit(request, "db_read", max_requests=120, window_s=60)
    return db.db_stats()


# ---------------------------------------------------------------------------
# Background OCR task
# ---------------------------------------------------------------------------

OCR_TIMEOUT_S = 300  # 5 minutes


async def _run_ocr(
    job_id: str,
    file_path: str,
    engine: str,
    filename: str = "",
    client_id: Optional[int] = None,
):
    jobs[job_id]["status"] = "processing"

    # Fetch client data before OCR so engine can use heading/keyword hints.
    pre_client: Optional[dict] = None
    if db.is_connected() and client_id is not None and client_id > 0:
        pre_client = db.get_client_by_id(client_id)

    try:
        loop = asyncio.get_event_loop()
        result = await asyncio.wait_for(
            loop.run_in_executor(_ocr_executor, _sync_ocr, file_path, engine, pre_client),
            timeout=OCR_TIMEOUT_S,
        )
        if isinstance(result, dict):
            result["job_id"] = job_id
            if filename:
                result["filename"] = filename
            matched_client = None
            matched_mode = "auto"
            if db.is_connected():
                if client_id is not None and client_id > 0:
                    matched_client = pre_client or db.get_client_by_id(client_id)
                    matched_mode = "manual"
                if not matched_client:
                    matched_client = db.detect_client_for_result(result, filename=filename)
                    matched_mode = "auto"
            if matched_client:
                db.apply_client_ocr_formatting(
                    result,
                    matched_client,
                    filename=filename,
                    matched_mode=matched_mode,
                )
                jobs[job_id]["client"] = result.get("client") or matched_client
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


def _sync_ocr(file_path: str, engine: str, client_data: Optional[dict] = None) -> dict:
    from backend.ocr_engine import process_file
    return process_file(file_path, engines=engine, client_data=client_data)
