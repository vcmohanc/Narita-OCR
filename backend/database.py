"""
MySQL database layer for the OCR web app.
Database: ocrdatabasedb (localhost)

Tables created automatically on startup:
  - ocr_jobs        : one row per OCR job, stores metadata + fused text
  - ocr_job_engines : per-engine sub-results (paddle / docling / deepseek)
  - ocr_tables      : extracted tables from Docling
"""

import json
import logging
import os
from contextlib import contextmanager
from datetime import datetime
from typing import Optional

import mysql.connector
from mysql.connector import pooling

logger = logging.getLogger(__name__)

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
        # Main jobs table
        """
        CREATE TABLE IF NOT EXISTS ocr_jobs (
            id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            job_id           VARCHAR(36)   NOT NULL UNIQUE,
            filename         VARCHAR(512)  NOT NULL,
            engine_requested VARCHAR(64)   NOT NULL DEFAULT 'all',
            status           ENUM('queued','processing','done','error') NOT NULL DEFAULT 'queued',
            primary_engine   VARCHAR(64)   NULL,
            fused_text       LONGTEXT      NULL,
            confidence_avg   FLOAT         NULL,
            processing_time_s FLOAT        NULL,
            error_message    TEXT          NULL,
            created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                           ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_status  (status),
            INDEX idx_created (created_at)
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
# Public write helpers
# ---------------------------------------------------------------------------

def save_job_queued(job_id: str, filename: str, engine: str):
    """Insert a new job row with status='queued'."""
    if not is_connected():
        return
    try:
        with _get_connection() as con:
            cur = con.cursor()
            cur.execute(
                """
                INSERT INTO ocr_jobs (job_id, filename, engine_requested, status, created_at, updated_at)
                VALUES (%s, %s, %s, 'queued', %s, %s)
                ON DUPLICATE KEY UPDATE status='queued', updated_at=%s
                """,
                (job_id, filename, engine,
                 datetime.utcnow(), datetime.utcnow(),
                 datetime.utcnow()),
            )
            cur.close()
    except Exception as exc:
        logger.error("DB save_job_queued failed: %s", exc)


def save_job_processing(job_id: str):
    """Update job status to 'processing'."""
    if not is_connected():
        return
    try:
        _update_job_status(job_id, "processing")
    except Exception as exc:
        logger.error("DB save_job_processing failed: %s", exc)


def save_job_done(job_id: str, result: dict):
    """
    Persist the completed OCR result.
    Writes to ocr_jobs, ocr_job_engines, and ocr_tables.
    """
    if not is_connected():
        return
    try:
        with _get_connection() as con:
            cur = con.cursor()

            # --- ocr_jobs ---
            cur.execute(
                """
                UPDATE ocr_jobs
                   SET status            = 'done',
                       primary_engine    = %s,
                       fused_text        = %s,
                       confidence_avg    = %s,
                       processing_time_s = %s,
                       result_json       = %s,
                       updated_at        = %s
                 WHERE job_id = %s
                """,
                (
                    result.get("primary_engine") or result.get("engine"),
                    result.get("fused_text") or result.get("full_text") or result.get("text") or result.get("markdown", ""),
                    result.get("confidence_avg"),
                    result.get("processing_time_s"),
                    json.dumps(result, ensure_ascii=False, default=str),
                    datetime.utcnow(),
                    job_id,
                ),
            )

            # --- ocr_job_engines (paddle / docling / deepseek) ---
            for engine_key in ("paddle", "docling", "deepseek"):
                eng = result.get(engine_key)
                if not eng:
                    # single-engine result stored directly
                    if result.get("engine", "").lower().startswith(engine_key):
                        eng = result
                    else:
                        continue
                if not eng:
                    continue

                lines = eng.get("lines", [])
                conf  = (
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

            # --- ocr_tables ---
            tables = result.get("tables", [])
            for idx, tbl in enumerate(tables):
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

            cur.close()
    except Exception as exc:
        logger.error("DB save_job_done failed: %s", exc)


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
    """Fetch a job row by job_id."""
    if not is_connected():
        return None
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            cur.execute("SELECT * FROM ocr_jobs WHERE job_id = %s", (job_id,))
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


def list_jobs(limit: int = 50, offset: int = 0) -> list:
    """Return recent jobs ordered by created_at DESC."""
    if not is_connected():
        return []
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            cur.execute(
                """
                SELECT job_id, filename, engine_requested, status,
                       primary_engine, confidence_avg, processing_time_s,
                       created_at, updated_at
                  FROM ocr_jobs
                 ORDER BY created_at DESC
                 LIMIT %s OFFSET %s
                """,
                (limit, offset),
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

def _migrate():
    """Add new columns to existing tables without recreating them."""
    with _get_connection() as con:
        cur = con.cursor()
        try:
            cur.execute("ALTER TABLE ocr_jobs ADD COLUMN result_json LONGTEXT NULL")
        except Exception:
            pass  # column already exists
        cur.close()


def _update_job_status(job_id: str, status: str):
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute(
            "UPDATE ocr_jobs SET status = %s, updated_at = %s WHERE job_id = %s",
            (status, datetime.utcnow(), job_id),
        )
        cur.close()
