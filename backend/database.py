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
import time
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
    "ssl_disabled": os.getenv("MYSQL_SSL_DISABLED", "true").lower() in ("1", "true", "yes"),
    "connection_timeout": 5,
}

# ---------------------------------------------------------------------------
# Connection pool (created once at startup; retried lazily on first use)
# ---------------------------------------------------------------------------
_pool: Optional[pooling.MySQLConnectionPool] = None
_last_connect_attempt: float = 0.0
_RECONNECT_COOLDOWN = 15.0  # seconds between auto-reconnect attempts


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
    global _last_connect_attempt
    if _pool is not None:
        return True
    # Lazy reconnect: try once every _RECONNECT_COOLDOWN seconds
    if time.time() - _last_connect_attempt >= _RECONNECT_COOLDOWN:
        _last_connect_attempt = time.time()
        init_db()
    return _pool is not None


# ---------------------------------------------------------------------------
# DDL — table creation
# ---------------------------------------------------------------------------

def _create_tables():
    ddl = [
        # Clients / customers master table
        """
        CREATE TABLE IF NOT EXISTS ocr_clients (
            id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            code            VARCHAR(64)  NOT NULL UNIQUE,
            name_ja         VARCHAR(128) NOT NULL,
            name_en         VARCHAR(128) NOT NULL,
            keywords        TEXT         NULL,
            header_row      INT UNSIGNED NULL DEFAULT 1,
            heading_columns TEXT         NULL,
            created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
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
        # Product Master table
        """
        CREATE TABLE IF NOT EXISTS ocr_products (
            id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            product_code VARCHAR(64)   NOT NULL UNIQUE,
            name_ja      VARCHAR(255)  NOT NULL,
            name_en      VARCHAR(255)  NULL,
            spec         VARCHAR(128)  NULL,
            unit_price   DECIMAL(12,2) NULL,
            client_id    INT UNSIGNED  NULL,
            created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_code   (product_code),
            INDEX idx_client (client_id),
            CONSTRAINT fk_product_client FOREIGN KEY (client_id)
                REFERENCES ocr_clients (id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """,
    ]
    with _get_connection() as con:
        cur = con.cursor()
        for stmt in ddl:
            cur.execute(stmt)
        _seed_products(cur)
        cur.close()


# ---------------------------------------------------------------------------
# Client lookup & auto-detection
# ---------------------------------------------------------------------------

def _normalize_text(s: str) -> str:
    """Normalize full-width/half-width characters and lowercase for matching."""
    return unicodedata.normalize("NFKC", s or "").lower()


def _strip_spaces(s: str) -> str:
    """Strip whitespace, underscores, and hyphens from normalized string for flexible matching."""
    return re.sub(r"[\s_\-]+", "", _normalize_text(s))


def _parse_keywords_list(raw_kw_str: str) -> list[str]:
    """Parse comma/newline/tab-separated keywords, trimming whitespace."""
    if not raw_kw_str:
        return []
    parts = re.split(r"[,、\n\r\t;]+", str(raw_kw_str))
    result = []
    seen = set()
    for p in parts:
        token = p.strip()
        if token and token not in seen:
            seen.add(token)
            result.append(token)
    return result


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
                    SELECT c.id, c.code, c.name_ja, c.name_en, c.keywords, c.header_row, c.heading_columns, c.created_at,
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
                    "SELECT id, code, name_ja, name_en, keywords, header_row, heading_columns, created_at "
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
    Auto-detect matching client according to clients' "検出キーワード" (detection keywords),
    client names, codes, and heading formats. Uses weighted multi-tier scoring so that:
      - Filename matches give highest confidence (150 pts)
      - Exact client names and aliases give 100 pts
      - Specific multi-character detection keywords give 25 pts each
      - Generic heading columns give 5 pts each (cumulative)
    Matches using both normalized text and space-collapsed Japanese text.
    Guarantees no client detection keywords are skipped.
    """
    clients = list_clients(with_counts=False) if is_connected() else []
    if not clients:
        return None

    fn_norm = _normalize_text(filename)
    fn_strip = _strip_spaces(filename)
    txt_norm = _normalize_text(text)
    txt_strip = _strip_spaces(text)

    # If neither source has text, cannot match
    if not fn_strip and not txt_strip:
        return None

    scores: dict[int, tuple[float, dict]] = {}

    for c in clients:
        client_id = c["id"]
        score = 0.0

        # Tier 1: Client names & codes (Strongest entity identifier)
        id_tokens = [c.get("name_ja", ""), c.get("name_en", ""), c.get("code", "")]
        for raw_tok in id_tokens:
            if not raw_tok:
                continue
            ntok = _normalize_text(raw_tok)
            stok = _strip_spaces(raw_tok)
            if not stok:
                continue

            # Check filename first (very strong signal, with length specificity bonus)
            if fn_strip and (stok in fn_strip or _keyword_matches(fn_norm, ntok)):
                score += 150.0 + len(stok) * 5.0
            # Check OCR text
            elif txt_strip and (stok in txt_strip or _keyword_matches(txt_norm, ntok)):
                score += 100.0 + len(stok) * 3.0

        # Tier 2: Detection keywords (検出キーワード)
        kws = _parse_keywords_list(c.get("keywords") or "")
        for kw in kws:
            nkw = _normalize_text(kw)
            skw = _strip_spaces(kw)
            if not skw:
                continue

            # Check in filename
            if fn_strip and (skw in fn_strip or _keyword_matches(fn_norm, nkw)):
                score += 50.0 + len(skw) * 2.0
            # Check in OCR text
            elif txt_strip and (skw in txt_strip or _keyword_matches(txt_norm, nkw)):
                if len(skw) >= 4:
                    score += 25.0 + len(skw) * 1.0
                elif len(skw) >= 2:
                    score += 10.0
                else:
                    score += 4.0

        # Tier 3: Heading columns (見出しフォーマット項目)
        heading_cols = _parse_keywords_list(c.get("heading_columns") or "")
        for col in heading_cols:
            ncol = _normalize_text(col)
            scol = _strip_spaces(col)
            if not scol:
                continue
            if txt_strip and (scol in txt_strip or _keyword_matches(txt_norm, ncol)):
                score += 5.0

        if score > 0:
            scores[client_id] = (score, c)

    if not scores:
        return None

    # Pick the client with the highest match score
    best_client_id, (best_score, best_client) = max(scores.items(), key=lambda item: item[1][0])

    # Minimum threshold to avoid noise: at least 8 points
    if best_score < 8.0:
        return None

    return {
        "id":              best_client["id"],
        "code":            best_client["code"],
        "name_ja":         best_client["name_ja"],
        "name_en":         best_client["name_en"],
        "header_row":      best_client.get("header_row", 1),
        "heading_columns": best_client.get("heading_columns", ""),
        "match_score":     round(best_score, 1),
    }


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
    """
    Collect all candidate OCR text blocks, tables, captions, line tokens,
    and cell values from an OCR result dictionary.
    Guarantees no client detection keywords are skipped.
    """
    if not isinstance(result, dict):
        return ""

    chunks: list[str] = []

    # 1. Top-level fused text, full_text, text, markdown
    for key in ("fused_text", "full_text", "text", "markdown"):
        val = result.get(key)
        if isinstance(val, str) and val.strip():
            chunks.append(val.strip())

    # 2. Engine-specific outputs (Paddle, Docling, DeepSeek)
    for eng_key in ("paddle", "docling", "deepseek"):
        eng = result.get(eng_key)
        if isinstance(eng, dict):
            for sub_key in ("markdown", "text", "full_text"):
                val = eng.get(sub_key)
                if isinstance(val, str) and val.strip():
                    chunks.append(val.strip())
            # PaddleOCR line tokens
            for line in eng.get("lines", []):
                if isinstance(line, dict):
                    txt = line.get("text")
                    if isinstance(txt, str) and txt.strip():
                        chunks.append(txt.strip())

    # 3. Tables (captions, headers, markdown, and all cell values)
    tables = result.get("tables", [])
    if isinstance(tables, list):
        for tbl in tables:
            if isinstance(tbl, dict):
                caption = tbl.get("caption")
                if isinstance(caption, str) and caption.strip():
                    chunks.append(caption.strip())
                md = tbl.get("markdown")
                if isinstance(md, str) and md.strip():
                    chunks.append(md.strip())
                data = tbl.get("data")
                if isinstance(data, list):
                    for row in data:
                        if isinstance(row, dict):
                            for cell_val in row.values():
                                if cell_val is not None:
                                    s = str(cell_val).strip()
                                    if s:
                                        chunks.append(s)
                        elif isinstance(row, (list, tuple)):
                            for cell_val in row:
                                if cell_val is not None:
                                    s = str(cell_val).strip()
                                    if s:
                                        chunks.append(s)

    # 4. Custom sheets (if edited or parsed from Excel)
    custom_sheets = result.get("custom_sheets", [])
    if isinstance(custom_sheets, list):
        for s in custom_sheets:
            if isinstance(s, dict):
                name = s.get("name")
                if isinstance(name, str) and name.strip():
                    chunks.append(name.strip())
                rows = s.get("rows", [])
                if isinstance(rows, list):
                    for row in rows:
                        if isinstance(row, (list, tuple)):
                            for cell in row:
                                if cell is not None:
                                    cv = str(cell).strip()
                                    if cv:
                                        chunks.append(cv)

    return "\n".join(chunks)


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


def update_job_result(job_id: str, result: dict) -> bool:
    """Persist manually edited result_json and fused_text back to ocr_jobs."""
    if not is_connected():
        return False
    try:
        fused_text = (
            result.get("fused_text")
            or result.get("full_text")
            or result.get("text")
            or ""
        )
        result_json = json.dumps(result, ensure_ascii=False, default=str)
        with _get_connection() as con:
            cur = con.cursor()
            cur.execute("SELECT 1 FROM ocr_jobs WHERE job_id = %s LIMIT 1", (job_id,))
            if cur.fetchone() is None:
                cur.close()
                return False
            cur.execute(
                """
                UPDATE ocr_jobs
                   SET result_json = %s,
                       fused_text  = %s,
                       updated_at  = %s
                 WHERE job_id = %s
                """,
                (result_json, fused_text, datetime.utcnow(), job_id),
            )
            cur.close()
        return True
    except Exception as exc:
        logger.error("DB update_job_result failed: %s", exc)
        return False


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
        if not _column_exists(cur, "ocr_clients", "header_row"):
            cur.execute("ALTER TABLE ocr_clients ADD COLUMN header_row INT UNSIGNED NULL DEFAULT 1")
        if not _column_exists(cur, "ocr_clients", "heading_columns"):
            cur.execute("ALTER TABLE ocr_clients ADD COLUMN heading_columns TEXT NULL")
        cur.execute(
            """
            UPDATE ocr_clients
               SET header_row = 8,
                   heading_columns = '商品名, 規格母目, C/S入数, 単価, 金額, 備考'
             WHERE code = 'fusui_project' AND (heading_columns IS NULL OR heading_columns = '')
            """
        )
        cur.execute(
            """
            UPDATE ocr_clients
               SET header_row = 1,
                   heading_columns = '商品コード, 商品名, 規格, 数量, 単価, 金額'
             WHERE code != 'fusui_project' AND (heading_columns IS NULL OR heading_columns = '')
            """
        )
        _seed_clients(cur)
        cur.close()


def add_client(name_ja: str, name_en: str, code: str, keywords: str = "", header_row: Optional[int] = 1, heading_columns: str = "") -> dict:
    """Insert a new client. Returns the new row dict."""
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute(
            "INSERT INTO ocr_clients (code, name_ja, name_en, keywords, header_row, heading_columns) VALUES (%s, %s, %s, %s, %s, %s)",
            (code.strip(), name_ja.strip(), name_en.strip(), keywords.strip(), header_row or 1, (heading_columns or "").strip()),
        )
        new_id = cur.lastrowid
        cur.close()
    return {
        "id": new_id,
        "code": code,
        "name_ja": name_ja,
        "name_en": name_en,
        "keywords": keywords,
        "header_row": header_row or 1,
        "heading_columns": heading_columns,
    }


def update_client(client_id: int, name_ja: str, name_en: str, code: str, keywords: str = "", header_row: Optional[int] = 1, heading_columns: str = "") -> bool:
    """Update an existing client row. Returns True if a row was changed."""
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute(
            "UPDATE ocr_clients SET name_ja=%s, name_en=%s, code=%s, keywords=%s, header_row=%s, heading_columns=%s WHERE id=%s",
            (name_ja.strip(), name_en.strip(), code.strip(), keywords.strip(), header_row or 1, (heading_columns or "").strip(), client_id),
        )
        affected = cur.rowcount
        cur.close()
    return affected > 0


def get_client_by_id(client_id: int) -> Optional[dict]:
    """Retrieve a single client by ID."""
    if not is_connected():
        return None
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            cur.execute("SELECT * FROM ocr_clients WHERE id = %s", (client_id,))
            row = cur.fetchone()
            cur.close()
            return row
    except Exception as exc:
        logger.error("DB get_client_by_id failed: %s", exc)
        return None


def update_client_heading_format(client_id: int, header_row: int, heading_columns: str) -> bool:
    """Update only header_row and heading_columns for a client."""
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute(
            "UPDATE ocr_clients SET header_row = %s, heading_columns = %s WHERE id = %s",
            (header_row or 1, (heading_columns or "").strip(), client_id),
        )
        affected = cur.rowcount
        cur.close()
    return affected > 0


def delete_client_by_id(client_id: int) -> bool:
    """Delete a client (jobs' client_id becomes NULL via FK ON DELETE SET NULL)."""
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute("DELETE FROM ocr_clients WHERE id = %s", (client_id,))
        affected = cur.rowcount
        cur.close()
    return affected > 0


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


# ---------------------------------------------------------------------------
# Product Master CRUD
# ---------------------------------------------------------------------------

def _seed_products(cur):
    """Seed initial sample product if table is empty."""
    try:
        cur.execute("SELECT COUNT(*) FROM ocr_products")
        row = cur.fetchone()
        if row and row[0] == 0:
            cur.execute(
                """
                INSERT INTO ocr_products
                    (product_code, name_ja, name_en, spec, unit_price, client_id)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                ("1029510171", "有機青じそ", "Organic Shiso", "10枚 P", 125.00, 10),
            )
            logger.info("Seeded initial product 1029510171 into ocr_products")
    except Exception as exc:
        logger.warning("Could not seed products: %s", exc)


def list_products(limit: int = 500, offset: int = 0, client_id: Optional[int] = None, query: Optional[str] = None) -> list:
    """Return all products from `ocr_products` joined with client info."""
    if not is_connected():
        return []
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            sql = """
                SELECT p.id, p.product_code, p.name_ja, p.name_en, p.spec, p.unit_price,
                       p.client_id, c.code AS client_code, c.name_ja AS client_name_ja, c.name_en AS client_name_en,
                       c.header_row AS client_header_row, c.heading_columns AS client_heading_columns,
                       p.created_at, p.updated_at
                  FROM ocr_products p
             LEFT JOIN ocr_clients c ON p.client_id = c.id
                 WHERE 1=1
            """
            params = []
            if client_id is not None:
                sql += " AND p.client_id = %s"
                params.append(client_id)
            if query and query.strip():
                q = f"%{query.strip()}%"
                sql += " AND (p.product_code LIKE %s OR p.name_ja LIKE %s OR p.name_en LIKE %s OR p.spec LIKE %s)"
                params.extend([q, q, q, q])
            sql += " ORDER BY p.id DESC LIMIT %s OFFSET %s"
            params.extend([limit, offset])
            cur.execute(sql, tuple(params))
            rows = cur.fetchall()
            cur.close()
            for r in rows:
                if r.get("unit_price") is not None:
                    r["unit_price"] = float(r["unit_price"])
            return rows
    except Exception as exc:
        logger.error("DB list_products failed: %s", exc)
        return []


def get_product(product_id: int) -> Optional[dict]:
    """Retrieve a single product by ID."""
    if not is_connected():
        return None
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            cur.execute(
                """
                SELECT p.id, p.product_code, p.name_ja, p.name_en, p.spec, p.unit_price,
                       p.client_id, c.code AS client_code, c.name_ja AS client_name_ja, c.name_en AS client_name_en,
                       c.header_row AS client_header_row, c.heading_columns AS client_heading_columns,
                       p.created_at, p.updated_at
                  FROM ocr_products p
             LEFT JOIN ocr_clients c ON p.client_id = c.id
                 WHERE p.id = %s
                """,
                (product_id,),
            )
            row = cur.fetchone()
            cur.close()
            if row and row.get("unit_price") is not None:
                row["unit_price"] = float(row["unit_price"])
            return row
    except Exception as exc:
        logger.error("DB get_product failed: %s", exc)
        return None


def create_product(product_code: str, name_ja: str, name_en: str = "", spec: str = "", unit_price: Optional[float] = None, client_id: Optional[int] = None) -> dict:
    """Insert a new product into ocr_products."""
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute(
            """
            INSERT INTO ocr_products
                (product_code, name_ja, name_en, spec, unit_price, client_id)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (product_code.strip(), name_ja.strip(), (name_en or "").strip(), (spec or "").strip(), unit_price, client_id),
        )
        new_id = cur.lastrowid
        cur.close()
    return get_product(new_id) or {"id": new_id, "product_code": product_code, "name_ja": name_ja}


def update_product(product_id: int, product_code: str, name_ja: str, name_en: str = "", spec: str = "", unit_price: Optional[float] = None, client_id: Optional[int] = None) -> bool:
    """Update an existing product."""
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute(
            """
            UPDATE ocr_products
               SET product_code = %s,
                   name_ja      = %s,
                   name_en      = %s,
                   spec         = %s,
                   unit_price   = %s,
                   client_id    = %s,
                   updated_at   = %s
             WHERE id = %s
            """,
            (product_code.strip(), name_ja.strip(), (name_en or "").strip(), (spec or "").strip(), unit_price, client_id, datetime.utcnow(), product_id),
        )
        affected = cur.rowcount
        cur.close()
    return affected > 0


def delete_product(product_id: int) -> bool:
    """Delete a product by ID."""
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute("DELETE FROM ocr_products WHERE id = %s", (product_id,))
        affected = cur.rowcount
        cur.close()
    return affected > 0

