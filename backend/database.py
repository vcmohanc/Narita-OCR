"""
MySQL database layer for the OCR web app.
Database: ocrdatabasedb (localhost)

Tables created automatically on startup:
  - ocr_clients     : master list of clients/companies (seeded on init)
  - ocr_jobs        : one row per OCR job, stores metadata + fused text + client_id FK
  - ocr_job_engines : per-engine sub-results (paddle / docling / deepseek)
  - ocr_tables      : extracted tables from Docling
"""

import json
import logging
import os
import re
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime
from typing import Optional

import mysql.connector
from mysql.connector import pooling

logger = logging.getLogger(__name__)

# Master client list seeded into `ocr_clients`
CLIENTS_SEED = [
    {
        "code": "greenwald",
        "name_ja": "グリーンワルド",
        "name_en": "Greenwald",
        "keywords": "グリーンワルド,greenwald",
    },
    {
        "code": "national",
        "name_ja": "ナショナル",
        "name_en": "National",
        "keywords": "ナショナル,national",
    },
    {
        "code": "props_japan",
        "name_ja": "プロップスジャパン",
        "name_en": "Props Japan",
        "keywords": "プロップスジャパン,プロップス,props japan,propsjapan,props_japan",
    },
    {
        "code": "rosen",
        "name_ja": "ローゼン",
        "name_en": "Rosen",
        "keywords": "ローゼン,口ーゼン,相鉄ローゼン,相鉄口ーゼン,rosen,sotetsu",
    },
    {
        "code": "wald_delica",
        "name_ja": "ワルドデリカ",
        "name_en": "Wald Delica",
        "keywords": "ワルドデリカ,ワルドデリ力,wald delica,walddelica,wald_delica",
    },
    {
        "code": "haibukiya",
        "name_ja": "灰吹屋",
        "name_en": "Haibukiya",
        "keywords": "灰吹屋,haibukiya",
    },
    {
        "code": "santoku",
        "name_ja": "三徳",
        "name_en": "Santoku",
        "keywords": "三徳,santoku",
    },
    {
        "code": "sanchoku",
        "name_ja": "産直",
        "name_en": "Sanchoku",
        "keywords": "産直,sanchoku",
    },
    {
        "code": "joso",
        "name_ja": "常総",
        "name_en": "Joso",
        "keywords": "常総,常総生協,joso",
    },
    {
        "code": "fusui_project",
        "name_ja": "風水プロジェクト",
        "name_en": "Fusui Project",
        "keywords": "風水プロジェクト,風水,fusui project,fusuiproject,fusui_project,fusui",
    },
    {
        "code": "nanohana",
        "name_ja": "なのはな",
        "name_en": "Nanohana",
        "keywords": "なのはな,菜の花,nanohana",
    },
]

# ---------------------------------------------------------------------------
# Config — override via environment variables or .env
# ---------------------------------------------------------------------------
DB_CONFIG = {
    "host":     os.getenv("MYSQL_HOST",     "127.0.0.1"),
    "port":     int(os.getenv("MYSQL_PORT", "3306")),
    "user":     os.getenv("MYSQL_USER",     "root"),
    "password": os.getenv("MYSQL_PASSWORD", ""),
    "database": os.getenv("MYSQL_DATABASE", "ocrdatabasedb"),
    "charset":  "utf8mb4",
    "use_unicode": True,
    "autocommit": False,
    "ssl_disabled": True,   # MariaDB local instance; no TLS needed
}

# ---------------------------------------------------------------------------
# Connection pool (created once at startup)
# ---------------------------------------------------------------------------
_pool: Optional[pooling.MySQLConnectionPool] = None


def init_db() -> bool:
    """
    Create connection pool + ensure the target database and all tables exist.
    Returns True on success, False if MySQL is unreachable (app still works
    without DB — results stay in memory only).
    """
    global _pool
    try:
        # 1. Connect WITHOUT specifying the database to create it if missing
        bootstrap_cfg = {k: v for k, v in DB_CONFIG.items() if k != "database"}
        con = mysql.connector.connect(**bootstrap_cfg)
        cur = con.cursor()
        cur.execute(
            f"CREATE DATABASE IF NOT EXISTS `{DB_CONFIG['database']}` "
            f"CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        )
        con.commit()
        cur.close()
        con.close()

        # 2. Create the pool against the real database
        _pool = pooling.MySQLConnectionPool(
            pool_name="ocr_pool",
            pool_size=5,
            pool_reset_session=True,
            **DB_CONFIG,
        )

        # 3. Create tables + migrate
        _create_tables()
        _migrate()
        logger.info("MySQL connected → database '%s'", DB_CONFIG["database"])
        return True

    except Exception as exc:
        logger.warning("MySQL unavailable — running without persistence: %s", exc)
        _pool = None
        return False


@contextmanager
def _get_connection():
    """Yield a pooled connection; roll back on error, always return to pool."""
    if _pool is None:
        raise RuntimeError("Database pool not initialised")
    con = _pool.get_connection()
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def is_connected() -> bool:
    return _pool is not None


# ---------------------------------------------------------------------------
# DDL — table creation
# ---------------------------------------------------------------------------

def _create_tables():
    ddl = [
        # Clients / customers master table
        """
        CREATE TABLE IF NOT EXISTS ocr_clients (
            id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            code       VARCHAR(64)  NOT NULL UNIQUE,
            name_ja    VARCHAR(128) NOT NULL,
            name_en    VARCHAR(128) NOT NULL,
            keywords   TEXT         NULL,
            created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """,
        # Main jobs table
        """
        CREATE TABLE IF NOT EXISTS ocr_jobs (
            id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            job_id           VARCHAR(36)   NOT NULL UNIQUE,
            filename         VARCHAR(512)  NOT NULL,
            engine_requested VARCHAR(64)   NOT NULL DEFAULT 'all',
            client_id        INT UNSIGNED  NULL,
            status           ENUM('queued','processing','done','error') NOT NULL DEFAULT 'queued',
            primary_engine   VARCHAR(64)   NULL,
            fused_text       LONGTEXT      NULL,
            confidence_avg   FLOAT         NULL,
            processing_time_s FLOAT        NULL,
            result_json      LONGTEXT      NULL,
            error_message    TEXT          NULL,
            created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                           ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_status  (status),
            INDEX idx_created (created_at),
            INDEX idx_client  (client_id),
            CONSTRAINT fk_job_client FOREIGN KEY (client_id)
                REFERENCES ocr_clients (id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """,
        # Per-engine sub-results
        """
        CREATE TABLE IF NOT EXISTS ocr_job_engines (
            id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            job_id     VARCHAR(36)  NOT NULL,
            engine     VARCHAR(32)  NOT NULL,
            full_text  LONGTEXT     NULL,
            markdown   LONGTEXT     NULL,
            line_count INT          NULL,
            confidence_avg FLOAT    NULL,
            raw_json   JSON         NULL,
            created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_job (job_id),
            CONSTRAINT fk_engine_job FOREIGN KEY (job_id)
                REFERENCES ocr_jobs (job_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """,
        # Tables extracted by Docling
        """
        CREATE TABLE IF NOT EXISTS ocr_tables (
            id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            job_id     VARCHAR(36)  NOT NULL,
            tbl_index  INT          NOT NULL DEFAULT 0,
            caption    TEXT         NULL,
            markdown   LONGTEXT     NULL,
            shape_rows INT          NULL,
            shape_cols INT          NULL,
            data_json  JSON         NULL,
            created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_job (job_id),
            CONSTRAINT fk_table_job FOREIGN KEY (job_id)
                REFERENCES ocr_jobs (job_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """,
    ]
    with _get_connection() as con:
        cur = con.cursor()
        for stmt in ddl:
            cur.execute(stmt)
        cur.close()


# ---------------------------------------------------------------------------
# Client lookup & auto-detection
# ---------------------------------------------------------------------------

def _normalize_text(s: str) -> str:
    """Normalize full-width/half-width characters and lowercase for matching."""
    return unicodedata.normalize("NFKC", s or "").lower()


def _keyword_matches(norm_haystack: str, norm_kw: str) -> bool:
    """Match keyword in normalized text; use boundaries for ASCII-only keywords."""
    if not norm_kw or not norm_haystack:
        return False
    if re.fullmatch(r"[a-z0-9 _-]+", norm_kw):
        pattern = r"(?<![a-z0-9])" + re.escape(norm_kw) + r"(?![a-z0-9])"
        return re.search(pattern, norm_haystack) is not None
    return norm_kw in norm_haystack


def list_clients(with_counts: bool = True) -> list:
    """Return all rows from ocr_clients (optionally with done job counts)."""
    if not is_connected():
        return []
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            if with_counts:
                cur.execute(
                    """
                    SELECT c.id, c.code, c.name_ja, c.name_en, c.keywords, c.created_at,
                           COUNT(j.id) AS total_jobs,
                           SUM(j.status = 'done') AS done_jobs
                      FROM ocr_clients c
                      LEFT JOIN ocr_jobs j ON j.client_id = c.id
                     GROUP BY c.id
                     ORDER BY c.id ASC
                    """
                )
            else:
                cur.execute(
                    "SELECT id, code, name_ja, name_en, keywords, created_at "
                    "FROM ocr_clients ORDER BY id ASC"
                )
            rows = cur.fetchall()
            cur.close()
            for row in rows:
                if "total_jobs" in row:
                    row["total_jobs"] = int(row["total_jobs"] or 0)
                if "done_jobs" in row:
                    row["done_jobs"] = int(row["done_jobs"] or 0)
            return rows
    except Exception as exc:
        logger.error("DB list_clients failed: %s", exc)
        return []


def detect_client(filename: str = "", text: str = "") -> Optional[dict]:
    """
    Auto-detect matching client from filename first, then OCR text.
    Reads client definitions from `ocr_clients` when DB is connected.
    Returns {id, code, name_ja, name_en} or None.
    """
    clients = list_clients(with_counts=False) if is_connected() else []
    if not clients:
        return None

    # Build (normalized_keyword, client_dict) pairs sorted longest-first
    pairs: list[tuple[str, dict]] = []
    for c in clients:
        raw_kws = [c.get("name_ja", ""), c.get("name_en", ""), c.get("code", "")]
        if c.get("keywords"):
            raw_kws.extend(c["keywords"].split(","))
        seen_kws: set[str] = set()
        for kw in raw_kws:
            nkw = _normalize_text(kw).strip()
            if nkw and nkw not in seen_kws:
                seen_kws.add(nkw)
                pairs.append((nkw, c))

    pairs.sort(key=lambda item: len(item[0]), reverse=True)

    for source in (_normalize_text(filename), _normalize_text(text)):
        if not source:
            continue
        for nkw, client in pairs:
            if _keyword_matches(source, nkw):
                return {
                    "id":      client["id"],
                    "code":    client["code"],
                    "name_ja": client["name_ja"],
                    "name_en": client["name_en"],
                }
    return None


# ---------------------------------------------------------------------------
# Public write helpers
# ---------------------------------------------------------------------------

def save_job_queued(job_id: str, filename: str, engine: str) -> Optional[dict]:
    """Insert a new job row with status='queued' and auto-detected client_id."""
    if not is_connected():
        return None
    matched_client = detect_client(filename=filename)
    client_id = matched_client["id"] if matched_client else None
    try:
        with _get_connection() as con:
            cur = con.cursor()
            now = datetime.utcnow()
            cur.execute(
                """
                INSERT INTO ocr_jobs
                    (job_id, filename, engine_requested, client_id, status, created_at, updated_at)
                VALUES (%s, %s, %s, %s, 'queued', %s, %s)
                ON DUPLICATE KEY UPDATE
                    status='queued',
                    client_id=COALESCE(%s, client_id),
                    updated_at=%s
                """,
                (job_id, filename, engine, client_id, now, now, client_id, now),
            )
            cur.close()
        return matched_client
    except Exception as exc:
        logger.error("DB save_job_queued failed: %s", exc)
        return matched_client


def save_job_processing(job_id: str):
    """Update job status to 'processing'."""
    if not is_connected():
        return
    try:
        _update_job_status(job_id, "processing")
    except Exception as exc:
        logger.error("DB save_job_processing failed: %s", exc)


def extract_combined_text(result: dict) -> str:
    """Collect candidate OCR text blocks from a result dictionary for matching."""
    text_candidates = [
        result.get("fused_text"),
        result.get("full_text"),
        result.get("text"),
        result.get("markdown"),
    ]
    for eng_key in ("paddle", "docling", "deepseek"):
        eng = result.get(eng_key)
        if isinstance(eng, dict):
            text_candidates.extend([eng.get("markdown"), eng.get("text"), eng.get("full_text")])
    return "\n".join(t for t in text_candidates if isinstance(t, str) and t)


def detect_client_for_result(result: dict, filename: str = "") -> Optional[dict]:
    """Match an OCR result to a client in ocr_clients using filename first, then extracted text."""
    combined_text = extract_combined_text(result)
    return detect_client(filename=filename, text=combined_text)


def _insert_engine_and_table_rows(cur, job_id: str, result: dict) -> None:
    """Insert per-engine outputs and extracted Docling tables for a saved OCR job."""
    for engine_key in ("paddle", "docling", "deepseek"):
        eng = result.get(engine_key)
        if not eng:
            if result.get("engine", "").lower().startswith(engine_key):
                eng = result
            else:
                continue
        if not eng:
            continue

        lines = eng.get("lines", [])
        conf = (
            round(sum(l["confidence"] for l in lines) / len(lines), 4)
            if lines else None
        )
        cur.execute(
            """
            INSERT INTO ocr_job_engines
                (job_id, engine, full_text, markdown, line_count, confidence_avg, raw_json)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                job_id,
                engine_key,
                eng.get("full_text") or eng.get("text", ""),
                eng.get("markdown", ""),
                eng.get("line_count") or len(lines),
                conf,
                json.dumps(eng, ensure_ascii=False, default=str),
            ),
        )

    for idx, tbl in enumerate(result.get("tables", [])):
        shape = tbl.get("shape", [None, None])
        cur.execute(
            """
            INSERT INTO ocr_tables
                (job_id, tbl_index, caption, markdown, shape_rows, shape_cols, data_json)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                job_id,
                idx,
                tbl.get("caption", ""),
                tbl.get("markdown", ""),
                shape[0] if len(shape) > 0 else None,
                shape[1] if len(shape) > 1 else None,
                json.dumps(tbl.get("data", []), ensure_ascii=False, default=str),
            ),
        )


def save_extracted_job(job_id: str, filename: str, engine: str, result: dict) -> dict:
    """
    Persist an already-extracted OCR result into ocr_jobs, ocr_job_engines, and ocr_tables.
    Matches the client according to filename (with extracted text fallback) and inserts
    a new row each time Save is clicked (generating a new UUID if job_id already exists).
    """
    if not is_connected():
        raise RuntimeError("MySQL database is not connected")

    matched_client = detect_client_for_result(result, filename=filename)
    client_id = matched_client["id"] if matched_client else None

    result_to_store = dict(result)
    if matched_client:
        result_to_store["client"] = matched_client
    result_to_store["filename"] = filename

    now = datetime.utcnow()
    save_id = (job_id or "").strip()
    if not save_id or len(save_id) > 36:
        save_id = str(uuid.uuid4())

    safe_filename = (filename or "unknown")[:512]
    req_engine = (engine or result.get("engine") or result.get("primary_engine") or "all")[:64]
    prim_engine = result.get("primary_engine") or result.get("engine")
    if isinstance(prim_engine, str):
        prim_engine = prim_engine[:64]

    with _get_connection() as con:
        cur = con.cursor()
        cur.execute("SELECT 1 FROM ocr_jobs WHERE job_id = %s LIMIT 1", (save_id,))
        if cur.fetchone() is not None:
            save_id = str(uuid.uuid4())
        result_to_store["job_id"] = save_id

        cur.execute(
            """
            INSERT INTO ocr_jobs
                (job_id, client_id, filename, status, engine_requested, primary_engine,
                 fused_text, confidence_avg, processing_time_s, result_json,
                 created_at, updated_at)
            VALUES (%s, %s, %s, 'done', %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                save_id,
                client_id,
                safe_filename,
                req_engine,
                prim_engine,
                result.get("fused_text") or result.get("full_text") or result.get("text") or result.get("markdown", ""),
                result.get("confidence_avg"),
                result.get("processing_time_s"),
                json.dumps(result_to_store, ensure_ascii=False, default=str),
                now,
                now,
            ),
        )
        _insert_engine_and_table_rows(cur, save_id, result_to_store)
        cur.close()

    return {
        "job_id": save_id,
        "filename": safe_filename,
        "client": matched_client,
    }


def save_job_done(job_id: str, result: dict, filename: str = "") -> Optional[dict]:
    """
    Persist the completed OCR result.
    Auto-detects client from filename and extracted OCR text,
    then writes to ocr_jobs, ocr_job_engines, and ocr_tables.
    """
    if not is_connected():
        return None
    try:
        matched_client = detect_client_for_result(result, filename=filename)
        client_id = matched_client["id"] if matched_client else None
        if matched_client and "client" not in result:
            result["client"] = matched_client

        with _get_connection() as con:
            cur = con.cursor()

            # --- ocr_jobs ---
            cur.execute(
                """
                UPDATE ocr_jobs
                   SET status            = 'done',
                       client_id         = COALESCE(%s, client_id),
                       primary_engine    = %s,
                       fused_text        = %s,
                       confidence_avg    = %s,
                       processing_time_s = %s,
                       result_json       = %s,
                       updated_at        = %s
                 WHERE job_id = %s
                """,
                (
                    client_id,
                    result.get("primary_engine") or result.get("engine"),
                    result.get("fused_text") or result.get("full_text") or result.get("text") or result.get("markdown", ""),
                    result.get("confidence_avg"),
                    result.get("processing_time_s"),
                    json.dumps(result, ensure_ascii=False, default=str),
                    datetime.utcnow(),
                    job_id,
                ),
            )

            _insert_engine_and_table_rows(cur, job_id, result)
            cur.close()
        return matched_client
    except Exception as exc:
        logger.error("DB save_job_done failed: %s", exc)
        return None


def save_job_error(job_id: str, error: str):
    """Update job status to 'error' with the error message."""
    if not is_connected():
        return
    try:
        with _get_connection() as con:
            cur = con.cursor()
            cur.execute(
                """
                UPDATE ocr_jobs
                   SET status = 'error', error_message = %s, updated_at = %s
                 WHERE job_id = %s
                """,
                (error, datetime.utcnow(), job_id),
            )
            cur.close()
    except Exception as exc:
        logger.error("DB save_job_error failed: %s", exc)


# ---------------------------------------------------------------------------
# Public read helpers
# ---------------------------------------------------------------------------

def get_job(job_id: str) -> Optional[dict]:
    """Fetch a job row by job_id (joined with client metadata)."""
    if not is_connected():
        return None
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            cur.execute(
                """
                SELECT j.*,
                       c.code    AS client_code,
                       c.name_ja AS client_name_ja,
                       c.name_en AS client_name_en
                  FROM ocr_jobs j
                  LEFT JOIN ocr_clients c ON c.id = j.client_id
                 WHERE j.job_id = %s
                """,
                (job_id,),
            )
            row = cur.fetchone()
            cur.close()
            return row
    except Exception as exc:
        logger.error("DB get_job failed: %s", exc)
        return None


def get_job_result(job_id: str) -> Optional[dict]:
    """Return the full OCR result dict stored in result_json, or None."""
    if not is_connected():
        return None
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            cur.execute("SELECT result_json FROM ocr_jobs WHERE job_id = %s", (job_id,))
            row = cur.fetchone()
            cur.close()
            if row and row.get("result_json"):
                return json.loads(row["result_json"])
            return None
    except Exception as exc:
        logger.error("DB get_job_result failed: %s", exc)
        return None


def list_jobs(limit: int = 50, offset: int = 0, client_id: Optional[int] = None) -> list:
    """Return recent jobs ordered by created_at DESC (with client info)."""
    if not is_connected():
        return []
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            where_sql = "WHERE j.client_id = %s" if client_id is not None else ""
            params = (client_id, limit, offset) if client_id is not None else (limit, offset)
            cur.execute(
                f"""
                SELECT j.job_id, j.filename, j.engine_requested, j.client_id,
                       c.code    AS client_code,
                       c.name_ja AS client_name_ja,
                       c.name_en AS client_name_en,
                       j.status, j.primary_engine, j.confidence_avg,
                       j.processing_time_s, j.created_at, j.updated_at
                  FROM ocr_jobs j
                  LEFT JOIN ocr_clients c ON c.id = j.client_id
                 {where_sql}
                 ORDER BY j.created_at DESC
                 LIMIT %s OFFSET %s
                """,
                params,
            )
            rows = cur.fetchall()
            cur.close()
            return rows
    except Exception as exc:
        logger.error("DB list_jobs failed: %s", exc)
        return []


def get_job_engines(job_id: str) -> list:
    """Return per-engine rows for a given job."""
    if not is_connected():
        return []
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            cur.execute(
                "SELECT * FROM ocr_job_engines WHERE job_id = %s ORDER BY engine",
                (job_id,),
            )
            rows = cur.fetchall()
            cur.close()
            return rows
    except Exception as exc:
        logger.error("DB get_job_engines failed: %s", exc)
        return []


def get_job_tables(job_id: str) -> list:
    """Return extracted table rows for a given job."""
    if not is_connected():
        return []
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            cur.execute(
                "SELECT * FROM ocr_tables WHERE job_id = %s ORDER BY tbl_index",
                (job_id,),
            )
            rows = cur.fetchall()
            cur.close()
            return rows
    except Exception as exc:
        logger.error("DB get_job_tables failed: %s", exc)
        return []


def db_stats() -> dict:
    """Return aggregate statistics from the database."""
    if not is_connected():
        return {"connected": False}
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            cur.execute(
                """
                SELECT
                    COUNT(*)                                     AS total_jobs,
                    SUM(status = 'done')                         AS done_jobs,
                    SUM(status = 'error')                        AS error_jobs,
                    AVG(CASE WHEN status='done' THEN confidence_avg END) AS avg_confidence,
                    AVG(CASE WHEN status='done' THEN processing_time_s END) AS avg_time_s
                FROM ocr_jobs
                """
            )
            stats = cur.fetchone()
            cur.close()
            stats["connected"] = True
            return stats
    except Exception as exc:
        logger.error("DB db_stats failed: %s", exc)
        return {"connected": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _column_exists(cur, table: str, column: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = %s
           AND COLUMN_NAME = %s
         LIMIT 1
        """,
        (table, column),
    )
    return cur.fetchone() is not None


def _index_exists(cur, table: str, index_name: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = %s
           AND INDEX_NAME = %s
         LIMIT 1
        """,
        (table, index_name),
    )
    return cur.fetchone() is not None


def _constraint_exists(cur, table: str, constraint_name: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = %s
           AND CONSTRAINT_NAME = %s
         LIMIT 1
        """,
        (table, constraint_name),
    )
    return cur.fetchone() is not None


def _seed_clients(cur):
    """Ensure the 11 configured clients exist in `ocr_clients` (idempotent)."""
    for client in CLIENTS_SEED:
        cur.execute(
            """
            INSERT IGNORE INTO ocr_clients (code, name_ja, name_en, keywords)
            VALUES (%s, %s, %s, %s)
            """,
            (client["code"], client["name_ja"], client["name_en"], client["keywords"]),
        )


def _migrate():
    """Add new columns/constraints to existing tables and seed clients."""
    with _get_connection() as con:
        cur = con.cursor()
        if not _column_exists(cur, "ocr_jobs", "result_json"):
            cur.execute("ALTER TABLE ocr_jobs ADD COLUMN result_json LONGTEXT NULL")
        if not _column_exists(cur, "ocr_jobs", "client_id"):
            cur.execute("ALTER TABLE ocr_jobs ADD COLUMN client_id INT UNSIGNED NULL AFTER engine_requested")
        if not _index_exists(cur, "ocr_jobs", "idx_client"):
            cur.execute("ALTER TABLE ocr_jobs ADD INDEX idx_client (client_id)")
        if not _constraint_exists(cur, "ocr_jobs", "fk_job_client"):
            cur.execute(
                """
                ALTER TABLE ocr_jobs
                ADD CONSTRAINT fk_job_client FOREIGN KEY (client_id)
                    REFERENCES ocr_clients (id) ON DELETE SET NULL
                """
            )
        _seed_clients(cur)
        cur.close()


def delete_jobs_bulk(job_ids: list) -> int:
    """Delete multiple jobs by job_id. Returns count of deleted rows."""
    if not is_connected() or not job_ids:
        return 0
    try:
        placeholders = ",".join(["%s"] * len(job_ids))
        with _get_connection() as con:
            cur = con.cursor()
            cur.execute(f"DELETE FROM ocr_jobs WHERE job_id IN ({placeholders})", job_ids)
            affected = cur.rowcount
            cur.close()
        return affected
    except Exception as exc:
        logger.error("DB delete_jobs_bulk failed: %s", exc)
        return 0


def delete_job(job_id: str) -> bool:
    """Delete a job and its child rows (cascades to ocr_job_engines + ocr_tables)."""
    if not is_connected():
        return False
    try:
        with _get_connection() as con:
            cur = con.cursor()
            cur.execute("DELETE FROM ocr_jobs WHERE job_id = %s", (job_id,))
            affected = cur.rowcount
            cur.close()
        return affected > 0
    except Exception as exc:
        logger.error("DB delete_job failed: %s", exc)
        return False


def cleanup_stale_jobs(older_than_minutes: int = 5) -> int:
    """Mark processing/queued jobs older than N minutes as error (server restarted)."""
    if not is_connected():
        return 0
    try:
        with _get_connection() as con:
            cur = con.cursor()
            cur.execute(
                """
                UPDATE ocr_jobs
                   SET status        = 'error',
                       error_message = 'Server restarted while processing',
                       updated_at    = %s
                 WHERE status IN ('processing', 'queued')
                   AND created_at < DATE_SUB(%s, INTERVAL %s MINUTE)
                """,
                (datetime.utcnow(), datetime.utcnow(), older_than_minutes),
            )
            affected = cur.rowcount
            cur.close()
        if affected:
            logger.info("Cleaned up %d stale job(s)", affected)
        return affected
    except Exception as exc:
        logger.error("DB cleanup_stale_jobs failed: %s", exc)
        return 0


def _update_job_status(job_id: str, status: str):
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute(
            "UPDATE ocr_jobs SET status = %s, updated_at = %s WHERE job_id = %s",
            (status, datetime.utcnow(), job_id),
        )
        cur.close()
