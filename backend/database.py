"""
MySQL database layer for the OCR web app.
Database: ocrdatabasedb (localhost)

Tables created automatically on startup:
  - ocr_clients     : master list of clients/companies (seeded on init)
  - ocr_jobs        : one row per OCR job, stores metadata + fused text + client_id FK
  - ocr_job_engines : per-engine sub-results (paddle / docling / deepseek)
  - ocr_tables      : extracted tables from Docling
"""

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta
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
        "name_ja": "なのはな生活協同組合",
        "name_en": "Nanohana",
        "keywords": "なのはな生活協同組合,なのはな生協,なのはな,菜の花,nanohana",
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
        con.ping(reconnect=True, attempts=3, delay=1)
    except Exception as exc:
        logger.debug("Database ping reconnect check failed: %s", exc)
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
        # Authentication: Users table
        """
        CREATE TABLE IF NOT EXISTS ocr_users (
            id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            username        VARCHAR(64)  NOT NULL UNIQUE,
            display_name    VARCHAR(128) NOT NULL DEFAULT '',
            role            ENUM('admin','user') NOT NULL DEFAULT 'user',
            password_hash   VARCHAR(255) NOT NULL,
            is_active       TINYINT(1)   NOT NULL DEFAULT 1,
            failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
            locked_until    DATETIME     NULL,
            last_login_at   DATETIME     NULL,
            created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_username (username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """,
        # Authentication: Server-side Sessions table (stores SHA-256 hash of cookie token)
        """
        CREATE TABLE IF NOT EXISTS ocr_sessions (
            id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            token_hash CHAR(64)     NOT NULL UNIQUE,
            user_id    INT UNSIGNED NOT NULL,
            ip_address VARCHAR(64)  NULL,
            user_agent VARCHAR(255) NULL,
            expires_at DATETIME     NOT NULL,
            created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_token_hash (token_hash),
            INDEX idx_expires    (expires_at),
            CONSTRAINT fk_session_user FOREIGN KEY (user_id)
                REFERENCES ocr_users (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """,
        # Dynamic runtime & security settings (everything except MySQL bootstrap credentials)
        """
        CREATE TABLE IF NOT EXISTS ocr_settings (
            setting_key   VARCHAR(100) PRIMARY KEY,
            setting_value TEXT         NOT NULL,
            value_type    VARCHAR(20)  NOT NULL DEFAULT 'string',
            category      VARCHAR(50)  NOT NULL DEFAULT 'general',
            description   VARCHAR(255) NOT NULL DEFAULT '',
            is_secret     TINYINT(1)   NOT NULL DEFAULT 0,
            updated_by    VARCHAR(100) NOT NULL DEFAULT 'system',
            updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """,
    ]
    with _get_connection() as con:
        cur = con.cursor()
        for stmt in ddl:
            cur.execute(stmt)
        _seed_products(cur)
        _seed_default_admin(cur)
        _seed_default_settings(cur)
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


# ---------------------------------------------------------------------------
# Client-aware structured extraction helpers
# ---------------------------------------------------------------------------

def _nc(s) -> str:
    """Normalize cell text: full→half width, lowercase, strip spaces."""
    return unicodedata.normalize("NFKC", str(s or "")).strip().lower()


def _col_match_score(cell_text: str, col_name: str) -> float:
    """Return 0–1 similarity between a cell text and a column name."""
    nc = _nc(cell_text)
    ncol = _nc(col_name)
    if not nc or not ncol:
        return 0.0
    if nc == ncol:
        return 1.0
    if ncol in nc or nc in ncol:
        return 0.75
    # Character-set overlap
    nc_set = set(nc)
    ncol_set = set(ncol)
    overlap = len(nc_set & ncol_set)
    if overlap == 0 or len(ncol_set) < 2:
        return 0.0
    return min(overlap / len(ncol_set), 1.0) * 0.5


def _row_header_score(row_cells: list, heading_cols: list) -> float:
    """Score 0–1: fraction of heading_cols that have a matching cell in this row."""
    if not row_cells or not heading_cols:
        return 0.0
    matched = sum(
        1 for col in heading_cols
        if max((_col_match_score(cell, col) for cell in row_cells), default=0.0) >= 0.5
    )
    return matched / len(heading_cols)


def _find_header_row_index(rows: list, heading_cols: list, hint_idx: int = 0) -> int:
    """
    Return the 0-based row index that best matches heading_cols using fuzzy scoring.
    Searches a window around hint_idx first, then falls back to the full table.
    Returns -1 when no row scores ≥ 0.3.
    """
    if not rows or not heading_cols:
        return -1

    def _score(i):
        row = rows[i]
        if not isinstance(row, (list, tuple)):
            return 0.0
        return _row_header_score([str(c) for c in row if c is not None], heading_cols)

    best_score, best_idx = 0.0, -1
    # Prioritise rows near the hint
    window = list(range(max(0, hint_idx - 2), min(len(rows), hint_idx + 12)))
    remaining = [i for i in range(len(rows)) if i not in window]
    for i in window + remaining:
        s = _score(i)
        if s > best_score:
            best_score, best_idx = s, i
    return best_idx if best_score >= 0.3 else -1


def _build_col_mapping(actual_header: list, client_cols: list) -> dict:
    """
    Map each index in actual_header to the best-matching client column name.
    Returns {actual_col_index: client_col_name}.
    """
    used: set[str] = set()
    col_map: dict[int, str] = {}
    for ci, cell in enumerate(actual_header):
        best_score, best_col = 0.0, None
        for client_col in client_cols:
            if client_col in used:
                continue
            score = _col_match_score(str(cell), client_col)
            if score > best_score:
                best_score, best_col = score, client_col
        if best_score >= 0.3 and best_col:
            col_map[ci] = best_col
            used.add(best_col)
        else:
            col_map[ci] = str(cell) if str(cell).strip() else f"列{ci + 1}"
    return col_map


def _extract_aligned_data_from_rows(
    rows_2d: list,
    client_cols: list,
    header_row_hint: int = 0,
) -> tuple[int, list[dict]]:
    """
    Find the header row in rows_2d using client_cols, then extract subsequent
    data rows as list[dict] keyed by client column names.
    Returns (header_row_index_found, extracted_rows).  header_row_index == -1 means not found.
    """
    if not rows_2d or not client_cols:
        return -1, []

    header_idx = _find_header_row_index(rows_2d, client_cols, header_row_hint)
    if header_idx < 0:
        return -1, []

    actual_header = [str(c) for c in rows_2d[header_idx] if c is not None]
    col_map = _build_col_mapping(actual_header, client_cols)

    extracted: list[dict] = []
    for row in rows_2d[header_idx + 1:]:
        if not isinstance(row, (list, tuple)):
            continue
        cells = [str(c) if c is not None else "" for c in row]
        row_dict: dict[str, str] = {}
        for ci, val in enumerate(cells):
            if not val.strip():
                continue
            col_name = col_map.get(ci, f"列{ci + 1}")
            # Merge with any value already assigned (can happen with merged cells)
            existing = row_dict.get(col_name, "")
            row_dict[col_name] = (existing + " " + val).strip() if existing else val.strip()
        if any(v for v in row_dict.values()):
            extracted.append(row_dict)

    return header_idx, extracted


def _extract_aligned_data_from_paddle_lines(
    lines: list,
    client_cols: list,
    header_row_hint: int = 0,
) -> list[dict]:
    """
    Use PaddleOCR bounding-box data to cluster text into rows, detect the header
    row by matching against client_cols, then assign data cells to columns using
    X-position proximity.  Returns list[dict] keyed by client column names.
    """
    if not lines or not client_cols:
        return []

    # --- Y-centre clustering into logical rows ---------------------------
    def _yc(line):
        pts = line.get("bbox") or []
        if not pts:
            return 0.0
        ys = [p[1] for p in pts]
        return (min(ys) + max(ys)) / 2.0

    def _xleft(line):
        pts = line.get("bbox") or []
        if not pts:
            return 0.0
        return min(p[0] for p in pts)

    sorted_lines = sorted(lines, key=_yc)
    row_groups: list[list] = []
    threshold = 15.0
    for line in sorted_lines:
        y = _yc(line)
        placed = False
        for group in row_groups:
            if abs(y - _yc(group[0])) <= threshold:
                group.append(line)
                placed = True
                break
        if not placed:
            row_groups.append([line])

    # Sort each group left-to-right
    for grp in row_groups:
        grp.sort(key=_xleft)

    text_rows = [[l["text"] for l in grp] for grp in row_groups]

    # --- Find header row -------------------------------------------------
    header_idx = _find_header_row_index(text_rows, client_cols, header_row_hint)
    if header_idx < 0:
        return []

    header_lines = row_groups[header_idx]
    header_x_lefts = [_xleft(l) for l in header_lines]
    header_texts = [l["text"] for l in header_lines]

    # Map header cells → client column names
    col_map = _build_col_mapping(header_texts, client_cols)

    # --- Extract data rows using X-proximity to header positions --------
    extracted: list[dict] = []
    for grp in row_groups[header_idx + 1:]:
        row_dict: dict[str, str] = {}
        for data_line in grp:
            x = _xleft(data_line)
            # Find the nearest header cell by X-distance
            best_hi, best_dist = 0, float("inf")
            for hi, hx in enumerate(header_x_lefts):
                dist = abs(x - hx)
                if dist < best_dist:
                    best_dist, best_hi = dist, hi
            col_name = col_map.get(best_hi, f"列{best_hi + 1}")
            existing = row_dict.get(col_name, "")
            val = data_line["text"].strip()
            if val:
                row_dict[col_name] = (existing + " " + val).strip() if existing else val
        if any(v for v in row_dict.values()):
            extracted.append(row_dict)

    return extracted


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
                    SELECT c.id, c.code, c.name_ja, c.name_en, c.keywords, c.header_row, c.heading_columns, c.skip_patterns, c.created_at,
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
                    "SELECT id, code, name_ja, name_en, keywords, header_row, heading_columns, skip_patterns, created_at "
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
        # Weighted by column specificity: longer / more unique columns score higher
        heading_cols = _parse_keywords_list(c.get("heading_columns") or "")
        matched_heading_count = 0
        for col in heading_cols:
            ncol = _normalize_text(col)
            scol = _strip_spaces(col)
            if not scol:
                continue
            if txt_strip and (scol in txt_strip or _keyword_matches(txt_norm, ncol)):
                col_weight = 8.0 if len(scol) >= 4 else 5.0
                score += col_weight
                matched_heading_count += 1
        # Bonus when multiple heading columns match — indicates this is the right client
        if matched_heading_count >= 3:
            score += matched_heading_count * 3.0

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


def parse_heading_columns(raw_cols: str) -> list[str]:
    """Parse heading_columns string into an ordered list of non-empty column names."""
    if not raw_cols:
        return []
    parts = re.split(r"\r?\n|,|、|\t|\|", str(raw_cols))
    cols: list[str] = []
    for part in parts:
        cleaned = part.strip().strip('"').strip("'")
        if cleaned:
            cols.append(cleaned)
    return cols


def _client_public_dict(client: Optional[dict]) -> Optional[dict]:
    """Normalize a client DB row into a JSON-serializable summary dict."""
    if not isinstance(client, dict) or not client.get("id"):
        return None
    out = {
        "id":              int(client["id"]),
        "code":            client.get("code") or "",
        "name_ja":         client.get("name_ja") or "",
        "name_en":         client.get("name_en") or "",
        "header_row":      max(1, int(client.get("header_row") or 1)),
        "heading_columns": client.get("heading_columns") or "",
        "skip_patterns":   client.get("skip_patterns") or "",
        "keywords":        client.get("keywords") or "",
    }
    if client.get("match_score") is not None:
        out["match_score"] = client["match_score"]
    return out


def apply_client_ocr_formatting(
    result: dict,
    client: Optional[dict],
    filename: str = "",
    matched_mode: str = "auto",
) -> dict:
    """
    Enrich an OCR result dict with matched/selected client metadata and apply
    the client's heading format (header_row & heading_columns) to extracted
    tables and custom_sheets.

    Enhanced: actively finds the real header row using fuzzy column matching,
    aligns data rows to the client's column schema, and stores the structured
    result in table['client_extracted_rows'].  Also runs a bbox-based extraction
    pass on PaddleOCR lines when available.
    """
    if not isinstance(result, dict):
        return result

    client_pub = _client_public_dict(client)
    if not client_pub:
        if matched_mode == "manual":
            result["client"] = None
            result.pop("client_ocr", None)
        return result

    client_cols = parse_heading_columns(client_pub.get("heading_columns", ""))
    header_row = max(1, int(client_pub.get("header_row") or 1))
    header_idx = header_row - 1

    # Scan OCR text for the client's 検出キーワード (detection keywords).
    # This runs regardless of whether the client was auto-detected or manually selected.
    kws_all = _parse_keywords_list(client_pub.get("keywords") or "")
    found_kws: list[str] = []
    if kws_all:
        combined_text = extract_combined_text(result)
        norm_hay = _normalize_text(combined_text)
        strip_hay = _strip_spaces(combined_text)
        # Also check filename against keywords
        fn = filename or (result.get("filename") or "")
        norm_fn = _normalize_text(fn)
        strip_fn = _strip_spaces(fn)
        for kw in kws_all:
            nkw = _normalize_text(kw)
            skw = _strip_spaces(kw)
            if not skw:
                continue
            in_text = skw in strip_hay or _keyword_matches(norm_hay, nkw)
            in_file = skw in strip_fn or _keyword_matches(norm_fn, nkw)
            if in_text or in_file:
                found_kws.append(kw)

    result["client"] = client_pub
    result["client_ocr"] = {
        "client_id":            client_pub["id"],
        "code":                 client_pub["code"],
        "name_ja":              client_pub["name_ja"],
        "name_en":              client_pub["name_en"],
        "header_row":           header_row,
        "heading_columns":      client_pub["heading_columns"],
        "parsed_columns":       client_cols,
        "matched_mode":         matched_mode,
        "keywords":             kws_all,
        "found_keywords":       found_kws,
        "keyword_match_count":  len(found_kws),
        "keyword_total_count":  len(kws_all),
    }

    custom_sheets = result.get("custom_sheets")
    if isinstance(custom_sheets, list):
        for sheet in custom_sheets:
            if not isinstance(sheet, dict) or sheet.get("name") == "Full Text":
                continue
            has_manual_custom = bool(sheet.get("customHeaders"))
            if not has_manual_custom or matched_mode == "manual" or sheet.get("clientHeadingId") is None:
                sheet["clientHeadingId"] = client_pub["id"]
                if client_cols:
                    sheet["clientHeaders"] = list(client_cols)
                rows = sheet.get("rows")
                if isinstance(rows, list) and len(rows) > 0:
                    sheet["hasHeader"] = True
                    sheet["headerIdx"] = min(header_idx, max(0, len(rows) - 1))

    # --- Enhanced: structured extraction aligned to client columns --------
    tables = result.get("tables")
    if isinstance(tables, list):
        for tbl in tables:
            if not isinstance(tbl, dict):
                continue
            tbl["client_header_row"] = header_row
            if client_cols:
                tbl["client_headers"] = list(client_cols)

            if not client_cols:
                continue

            # Build a 2-D list from the table's data
            data = tbl.get("data")
            rows_2d: list = []
            if isinstance(data, list) and data:
                first = data[0]
                if isinstance(first, dict):
                    keys = list(first.keys())
                    rows_2d = [keys] + [
                        [str(row.get(k, "")) for k in keys]
                        for row in data if isinstance(row, dict)
                    ]
                elif isinstance(first, (list, tuple)):
                    rows_2d = [[str(c) for c in row] for row in data]

            # Fall back to parsing the markdown string
            if not rows_2d and tbl.get("markdown", "").strip():
                md = tbl["markdown"].strip()
                for line in md.splitlines():
                    line = line.strip()
                    if not line or set(line.replace("|", "").replace("-", "").replace(":", "").strip()) == set():
                        continue
                    cells = [c.strip() for c in line.strip("|").split("|")]
                    if cells:
                        rows_2d.append(cells)

            if rows_2d:
                found_idx, extracted = _extract_aligned_data_from_rows(
                    rows_2d, client_cols, header_idx
                )
                if extracted:
                    tbl["client_extracted_rows"] = extracted
                    tbl["client_header_found_at"] = found_idx
                elif found_idx >= 0:
                    tbl["client_extracted_rows"] = []
                    tbl["client_header_found_at"] = found_idx

    # --- Bbox-based extraction from PaddleOCR lines ----------------------
    paddle = result.get("paddle") or {}
    lines = paddle.get("lines") or []
    if lines and client_cols:
        # Only run when lines carry bounding boxes
        if lines and isinstance(lines[0], dict) and lines[0].get("bbox"):
            paddle_extracted = _extract_aligned_data_from_paddle_lines(
                lines, client_cols, header_row - 1
            )
            if paddle_extracted:
                result["paddle_extracted_rows"] = paddle_extracted

    return result


# ---------------------------------------------------------------------------
# Public write helpers
# ---------------------------------------------------------------------------

def save_job_queued(
    job_id: str,
    filename: str,
    engine: str,
    client_id: Optional[int] = None,
) -> Optional[dict]:
    """Insert a new job row with status='queued' and selected or auto-detected client_id."""
    if not is_connected():
        return None
    if client_id is not None:
        matched_client = _client_public_dict(get_client_by_id(int(client_id)))
    else:
        matched_client = detect_client(filename=filename)
    resolved_client_id = matched_client["id"] if matched_client else client_id
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
                (job_id, filename, engine, resolved_client_id, now, now, resolved_client_id, now),
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


def save_extracted_job(
    job_id: str,
    filename: str,
    engine: str,
    result: dict,
    client_id: Optional[int] = None,
) -> dict:
    """
    Persist an already-extracted OCR result into ocr_jobs, ocr_job_engines, and ocr_tables.
    Uses explicit client_id (or client already attached to result) if provided, otherwise
    matches the client according to filename and extracted text.
    Inserts a new row each time Save is clicked (generating a new UUID if job_id already exists).
    """
    if not is_connected():
        raise RuntimeError("MySQL database is not connected")

    result_to_store = dict(result or {})
    matched_client = None
    matched_mode = "auto"

    if client_id is not None and int(client_id) > 0:
        matched_client = _client_public_dict(get_client_by_id(int(client_id)))
        matched_mode = "manual"
    elif isinstance(result_to_store.get("client"), dict) and result_to_store["client"].get("id"):
        cid = int(result_to_store["client"]["id"])
        matched_client = _client_public_dict(get_client_by_id(cid)) or _client_public_dict(result_to_store["client"])
        matched_mode = (result_to_store.get("client_ocr") or {}).get("matched_mode") or "manual"
    else:
        unassigned_explicit = (
            "client" in result_to_store
            and result_to_store.get("client") is None
            and (result_to_store.get("client_ocr") or {}).get("matched_mode") == "unassigned"
        )
        if not unassigned_explicit:
            matched_client = detect_client_for_result(result_to_store, filename=filename)

    resolved_client_id = matched_client["id"] if matched_client else None
    apply_client_ocr_formatting(
        result_to_store,
        matched_client,
        filename=filename,
        matched_mode=matched_mode,
    )
    result_to_store["filename"] = filename

    now = datetime.utcnow()
    save_id = (job_id or "").strip()
    if not save_id or len(save_id) > 36:
        save_id = str(uuid.uuid4())

    safe_filename = (filename or "unknown")[:512]
    req_engine = (engine or result_to_store.get("engine") or result_to_store.get("primary_engine") or "all")[:64]
    prim_engine = result_to_store.get("primary_engine") or result_to_store.get("engine")
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
                resolved_client_id,
                safe_filename,
                req_engine,
                prim_engine,
                result_to_store.get("fused_text") or result_to_store.get("full_text") or result_to_store.get("text") or result_to_store.get("markdown", ""),
                result_to_store.get("confidence_avg"),
                result_to_store.get("processing_time_s"),
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


def save_job_done(
    job_id: str,
    result: dict,
    filename: str = "",
    client_id: Optional[int] = None,
) -> Optional[dict]:
    """
    Persist the completed OCR result.
    Uses explicit client_id if provided, otherwise auto-detects client from filename
    and extracted OCR text, then writes to ocr_jobs, ocr_job_engines, and ocr_tables.
    """
    if not is_connected():
        return None
    try:
        matched_mode = "auto"
        if client_id is not None and int(client_id) > 0:
            matched_client = _client_public_dict(get_client_by_id(int(client_id)))
            matched_mode = "manual"
        elif isinstance(result, dict) and isinstance(result.get("client"), dict) and result["client"].get("id"):
            cid = int(result["client"]["id"])
            matched_client = _client_public_dict(get_client_by_id(cid)) or _client_public_dict(result["client"])
            matched_mode = (result.get("client_ocr") or {}).get("matched_mode") or "manual"
        else:
            matched_client = detect_client_for_result(result, filename=filename)

        resolved_client_id = matched_client["id"] if matched_client else None
        apply_client_ocr_formatting(
            result,
            matched_client,
            filename=filename,
            matched_mode=matched_mode,
        )

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
                    resolved_client_id,
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
    """Persist manually edited result_json, fused_text, and client_id back to ocr_jobs."""
    if not is_connected():
        return False
    try:
        fused_text = (
            result.get("fused_text")
            or result.get("full_text")
            or result.get("text")
            or ""
        )
        client_obj = result.get("client")
        has_client_key = isinstance(result, dict) and ("client" in result)
        new_client_id = (
            int(client_obj["id"])
            if isinstance(client_obj, dict) and client_obj.get("id")
            else None
        )
        result_json = json.dumps(result, ensure_ascii=False, default=str)
        with _get_connection() as con:
            cur = con.cursor()
            cur.execute("SELECT 1 FROM ocr_jobs WHERE job_id = %s LIMIT 1", (job_id,))
            if cur.fetchone() is None:
                cur.close()
                return False
            if has_client_key:
                cur.execute(
                    """
                    UPDATE ocr_jobs
                       SET result_json = %s,
                           fused_text  = %s,
                           client_id   = %s,
                           updated_at  = %s
                     WHERE job_id = %s
                    """,
                    (result_json, fused_text, new_client_id, datetime.utcnow(), job_id),
                )
            else:
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
        if not _index_exists(cur, "ocr_jobs", "idx_client_created"):
            cur.execute("ALTER TABLE ocr_jobs ADD INDEX idx_client_created (client_id, created_at)")
        if not _index_exists(cur, "ocr_products", "idx_client_id"):
            cur.execute("ALTER TABLE ocr_products ADD INDEX idx_client_id (client_id, id)")
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
        if not _column_exists(cur, "ocr_clients", "skip_patterns"):
            cur.execute("ALTER TABLE ocr_clients ADD COLUMN skip_patterns TEXT NULL")
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
               SET header_row = 5,
                   heading_columns = '注文No., 商品名, 規格容量, 納入価格（円）, 総数（P）, 金額（円）'
             WHERE code = 'nanohana' AND (heading_columns IS NULL OR heading_columns = '' OR header_row = 1)
            """
        )
        cur.execute(
            """
            UPDATE ocr_clients
               SET header_row = 1,
                   heading_columns = '商品コード, 商品名, 規格, 数量, 単価, 金額'
             WHERE code NOT IN ('fusui_project', 'nanohana') AND (heading_columns IS NULL OR heading_columns = '')
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
    """Update an existing client row. Returns True if the client exists."""
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute(
            "UPDATE ocr_clients SET name_ja=%s, name_en=%s, code=%s, keywords=%s, header_row=%s, heading_columns=%s WHERE id=%s",
            (name_ja.strip(), name_en.strip(), code.strip(), keywords.strip(), header_row or 1, (heading_columns or "").strip(), client_id),
        )
        affected = cur.rowcount
        if affected == 0:
            cur.execute("SELECT id FROM ocr_clients WHERE id = %s", (client_id,))
            exists = cur.fetchone() is not None
            cur.close()
            return exists
        cur.close()
    return True


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


def update_client_heading_format(client_id: int, header_row: int, heading_columns: str, skip_patterns: str = "") -> bool:
    """Update header_row, heading_columns and skip_patterns for a client."""
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute(
            "UPDATE ocr_clients SET header_row = %s, heading_columns = %s, skip_patterns = %s WHERE id = %s",
            (header_row or 1, (heading_columns or "").strip(), (skip_patterns or "").strip(), client_id),
        )
        affected = cur.rowcount
        if affected == 0:
            # MySQL rowcount is 0 when no rows changed AND when row not found.
            # Distinguish the two cases so "same values" doesn't falsely 404.
            cur.execute("SELECT id FROM ocr_clients WHERE id = %s", (client_id,))
            exists = cur.fetchone() is not None
            cur.close()
            return exists
        cur.close()
    return True


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


# ---------------------------------------------------------------------------
# Authentication & Session Management (Production Security)
# ---------------------------------------------------------------------------

_PBKDF2_ITERATIONS = 600_000
_MAX_FAILED_ATTEMPTS = 5
_LOCKOUT_MINUTES = 15


def hash_password(password: str) -> str:
    """Hash a password using PBKDF2-HMAC-SHA256 with a 32-byte random salt."""
    salt = secrets.token_bytes(32)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${_PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    """Verify a plaintext password against a stored PBKDF2-HMAC-SHA256 hash in constant time."""
    try:
        algo, iters_str, salt_hex, hash_hex = stored_hash.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        iterations = int(iters_str)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


def _hash_session_token(raw_token: str) -> str:
    return hashlib.sha256((raw_token or "").encode("utf-8")).hexdigest()


def _seed_default_admin(cur) -> None:
    """Seed initial admin account into ocr_users if no users exist yet."""
    try:
        cur.execute("SELECT COUNT(*) FROM ocr_users")
        row = cur.fetchone()
        if row and row[0] == 0:
            admin_user = os.getenv("ADMIN_USERNAME", "admin").strip() or "admin"
            admin_pass = os.getenv("ADMIN_PASSWORD", "Narita@2026!").strip() or "Narita@2026!"
            pw_hash = hash_password(admin_pass)
            cur.execute(
                """
                INSERT INTO ocr_users (username, display_name, role, password_hash, is_active)
                VALUES (%s, %s, 'admin', %s, 1)
                """,
                (admin_user, "管理者 (Admin)", pw_hash),
            )
            logger.info("Seeded default admin user '%s' into ocr_users", admin_user)
    except Exception as exc:
        logger.warning("Could not seed default admin user: %s", exc)


def authenticate_user(username: str, password: str) -> tuple[Optional[dict], str]:
    """
    Verify username + password against `ocr_users`.
    Enforces account lockout after _MAX_FAILED_ATTEMPTS consecutive failures.
    Returns (user_dict, status_code) where status_code is 'ok' | 'invalid' | 'locked' | 'inactive' | 'unavailable'.
    """
    if not is_connected():
        return None, "unavailable"
    uname = (username or "").strip()
    if not uname or not password:
        return None, "invalid"

    now = datetime.utcnow()
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            cur.execute(
                """
                SELECT id, username, display_name, role, password_hash,
                       is_active, failed_attempts, locked_until
                  FROM ocr_users
                 WHERE LOWER(username) = LOWER(%s)
                 LIMIT 1
                """,
                (uname,),
            )
            user = cur.fetchone()
            if not user:
                # Constant-time dummy work to mitigate username enumeration timing
                hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), b"dummy_salt_padding", 50_000)
                cur.close()
                return None, "invalid"

            if not user.get("is_active"):
                cur.close()
                return None, "inactive"

            locked_until = user.get("locked_until")
            if locked_until and locked_until > now:
                cur.close()
                return None, "locked"

            if not verify_password(password, user["password_hash"]):
                max_attempts = get_setting_int("login_max_attempts", _MAX_FAILED_ATTEMPTS, min_val=1, max_val=50)
                lockout_mins = get_setting_int("login_lockout_minutes", _LOCKOUT_MINUTES, min_val=1, max_val=1440)
                attempts = int(user.get("failed_attempts") or 0) + 1
                if attempts >= max_attempts:
                    lock_exp = now + timedelta(minutes=lockout_mins)
                    cur.execute(
                        "UPDATE ocr_users SET failed_attempts = %s, locked_until = %s WHERE id = %s",
                        (attempts, lock_exp, user["id"]),
                    )
                    cur.close()
                    return None, "locked"
                cur.execute(
                    "UPDATE ocr_users SET failed_attempts = %s WHERE id = %s",
                    (attempts, user["id"]),
                )
                cur.close()
                return None, "invalid"

            cur.execute(
                """
                UPDATE ocr_users
                   SET failed_attempts = 0,
                       locked_until    = NULL,
                       last_login_at   = %s
                 WHERE id = %s
                """,
                (now, user["id"]),
            )
            cur.close()
            return {
                "id":           user["id"],
                "username":     user["username"],
                "display_name": user["display_name"],
                "role":         user["role"],
            }, "ok"
    except Exception as exc:
        logger.error("authenticate_user failed: %s", exc)
        return None, "unavailable"


def create_session(user_id: int, ip_address: str = "", user_agent: str = "", ttl_seconds: int = 43200) -> str:
    """Create a cryptographically random 256-bit server-side session and return raw token."""
    raw_token = secrets.token_urlsafe(32)
    token_hash = _hash_session_token(raw_token)
    now = datetime.utcnow()
    expires_at = now + timedelta(seconds=ttl_seconds)
    with _get_connection() as con:
        cur = con.cursor()
        # Prune expired sessions opportunistically
        cur.execute("DELETE FROM ocr_sessions WHERE expires_at < %s", (now,))
        cur.execute(
            """
            INSERT INTO ocr_sessions (token_hash, user_id, ip_address, user_agent, expires_at, created_at)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (token_hash, user_id, (ip_address or "")[:64], (user_agent or "")[:255], expires_at, now),
        )
        cur.close()
    return raw_token


def get_session_user(raw_token: str) -> Optional[dict]:
    """Validate a raw session cookie token against `ocr_sessions` + `ocr_users`."""
    if not raw_token or not is_connected():
        return None
    token_hash = _hash_session_token(raw_token)
    now = datetime.utcnow()
    try:
        with _get_connection() as con:
            cur = con.cursor(dictionary=True)
            cur.execute(
                """
                SELECT u.id, u.username, u.display_name, u.role
                  FROM ocr_sessions s
                  JOIN ocr_users u ON u.id = s.user_id
                 WHERE s.token_hash = %s
                   AND s.expires_at > %s
                   AND u.is_active = 1
                 LIMIT 1
                """,
                (token_hash, now),
            )
            row = cur.fetchone()
            cur.close()
            return row
    except Exception as exc:
        logger.error("get_session_user failed: %s", exc)
        return None


def delete_session(raw_token: str) -> None:
    """Revoke a session immediately on logout."""
    if not raw_token or not is_connected():
        return
    token_hash = _hash_session_token(raw_token)
    try:
        with _get_connection() as con:
            cur = con.cursor()
            cur.execute("DELETE FROM ocr_sessions WHERE token_hash = %s", (token_hash,))
            cur.close()
    except Exception as exc:
        logger.error("delete_session failed: %s", exc)


def delete_user_sessions(user_id: int, keep_token: str = "") -> None:
    """Revoke all sessions for a user (optionally keeping current session)."""
    if not is_connected():
        return
    try:
        with _get_connection() as con:
            cur = con.cursor()
            if keep_token:
                cur.execute(
                    "DELETE FROM ocr_sessions WHERE user_id = %s AND token_hash != %s",
                    (user_id, _hash_session_token(keep_token)),
                )
            else:
                cur.execute("DELETE FROM ocr_sessions WHERE user_id = %s", (user_id,))
            cur.close()
    except Exception as exc:
        logger.error("delete_user_sessions failed: %s", exc)


def change_user_password(user_id: int, current_password: str, new_password: str, current_token: str = "") -> tuple[bool, str]:
    """Verify current password, update to new strong password, and revoke other sessions."""
    if not is_connected():
        return False, "Database unavailable"
    if len(new_password or "") < 8:
        return False, "新しいパスワードは8文字以上にしてください"
    with _get_connection() as con:
        cur = con.cursor(dictionary=True)
        cur.execute("SELECT id, password_hash FROM ocr_users WHERE id = %s LIMIT 1", (user_id,))
        user = cur.fetchone()
        if not user or not verify_password(current_password, user["password_hash"]):
            cur.close()
            return False, "現在のパスワードが正しくありません"
        new_hash = hash_password(new_password)
        cur.execute(
            "UPDATE ocr_users SET password_hash = %s, failed_attempts = 0, locked_until = NULL WHERE id = %s",
            (new_hash, user_id),
        )
        cur.close()
    delete_user_sessions(user_id, keep_token=current_token)
    return True, "パスワードを更新しました"


def list_users() -> list[dict]:
    """List all registered users (admin view; never returns password_hash)."""
    if not is_connected():
        return []
    with _get_connection() as con:
        cur = con.cursor(dictionary=True)
        cur.execute(
            """
            SELECT id, username, display_name, role, is_active, last_login_at, created_at
              FROM ocr_users
             ORDER BY id ASC
            """
        )
        rows = cur.fetchall()
        cur.close()
        return rows


def create_user(username: str, password: str, display_name: str = "", role: str = "user") -> dict:
    """Create a new user account."""
    uname = (username or "").strip()
    if not uname or len(uname) < 3:
        raise ValueError("ユーザー名は3文字以上にしてください")
    if len(password or "") < 8:
        raise ValueError("パスワードは8文字以上にしてください")
    safe_role = "admin" if role == "admin" else "user"
    pw_hash = hash_password(password)
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute(
            """
            INSERT INTO ocr_users (username, display_name, role, password_hash, is_active)
            VALUES (%s, %s, %s, %s, 1)
            """,
            (uname, (display_name or uname).strip(), safe_role, pw_hash),
        )
        new_id = cur.lastrowid
        cur.close()
    return {"id": new_id, "username": uname, "display_name": display_name or uname, "role": safe_role, "is_active": 1}


def delete_user(user_id: int) -> bool:
    """Delete a user by ID (cascades to sessions)."""
    with _get_connection() as con:
        cur = con.cursor()
        cur.execute("DELETE FROM ocr_users WHERE id = %s", (user_id,))
        affected = cur.rowcount
        cur.close()
    return affected > 0


# ═══════════════════════════════════════════════════════════════════════════
# Dynamic Runtime Settings (ocr_settings)
# ═══════════════════════════════════════════════════════════════════════════

_SECRET_MASK = "••••••••"

_DEFAULT_SETTINGS = [
    ("session_ttl_seconds", os.getenv("SESSION_TTL_SECONDS", "43200"), "int", "security", "セッション有効期限 (秒、例: 43200 = 12時間)", 0),
    ("login_max_attempts", "5", "int", "security", "ロックアウトまでの最大ログイン失敗回数", 0),
    ("login_lockout_minutes", "15", "int", "security", "アカウントロックアウト時間 (分)", 0),
    ("login_rate_limit_per_min", "20", "int", "security", "IPごとのログイン試行上限 (回/分)", 0),
    ("max_file_size_mb", "50", "int", "ocr", "アップロード最大ファイルサイズ (MB)", 0),
    ("max_queued_jobs", os.getenv("MAX_QUEUED_JOBS", "20"), "int", "ocr", "同時キューイング可能なOCRジョブ上限数", 0),
    ("ocr_api_key", os.getenv("OCR_API_KEY", "").strip(), "string", "security", "外部連携用 X-API-Key (空欄の場合は無効)", 1),
    ("cors_origins", os.getenv("CORS_ORIGINS", "http://localhost:8080,http://127.0.0.1:8080"), "string", "network", "許可するCORSオリジン (カンマ区切り)", 0),
]

_INT_SETTING_BOUNDS = {
    "session_ttl_seconds": (300, 2592000),
    "login_max_attempts": (1, 50),
    "login_lockout_minutes": (1, 1440),
    "login_rate_limit_per_min": (1, 600),
    "max_file_size_mb": (1, 500),
    "max_queued_jobs": (1, 200),
}


def _seed_default_settings(cur) -> None:
    """Insert default runtime settings into ocr_settings if not already present."""
    try:
        for key, val, vtype, cat, desc, is_sec in _DEFAULT_SETTINGS:
            cur.execute(
                """
                INSERT IGNORE INTO ocr_settings
                    (setting_key, setting_value, value_type, category, description, is_secret, updated_by)
                VALUES (%s, %s, %s, %s, %s, %s, 'system')
                """,
                (key, str(val), vtype, cat, desc, is_sec),
            )
    except Exception as exc:
        logger.warning("Could not seed default settings: %s", exc)


def get_setting(key: str, default: str = "") -> str:
    """Fetch a single setting value from ocr_settings, returning default if unavailable."""
    if not is_connected():
        return default
    try:
        with _get_connection() as con:
            cur = con.cursor()
            cur.execute("SELECT setting_value FROM ocr_settings WHERE setting_key = %s LIMIT 1", (key,))
            row = cur.fetchone()
            cur.close()
        if row is not None and row[0] is not None:
            return str(row[0])
    except Exception:
        pass
    return default


def get_setting_int(key: str, default: int = 0, min_val: Optional[int] = None, max_val: Optional[int] = None) -> int:
    """Fetch an integer setting from ocr_settings with optional clamping."""
    raw = get_setting(key, str(default))
    try:
        val = int(str(raw).strip())
    except (TypeError, ValueError):
        val = default
    if min_val is not None and val < min_val:
        val = min_val
    if max_val is not None and val > max_val:
        val = max_val
    return val


def get_all_settings(mask_secrets: bool = True) -> list[dict]:
    """Return all settings ordered by category and key."""
    if not is_connected():
        return []
    with _get_connection() as con:
        cur = con.cursor(dictionary=True)
        cur.execute(
            """
            SELECT setting_key, setting_value, value_type, category,
                   description, is_secret, updated_by, updated_at
              FROM ocr_settings
             ORDER BY category ASC, setting_key ASC
            """
        )
        rows = cur.fetchall()
        cur.close()
    for r in rows:
        has_val = bool(r.get("setting_value"))
        r["has_value"] = has_val
        if mask_secrets and r.get("is_secret") and has_val:
            r["setting_value"] = _SECRET_MASK
        if r.get("updated_at") is not None:
            r["updated_at"] = str(r["updated_at"])
    return rows


def update_settings(updates: dict, updated_by: str = "admin") -> list[dict]:
    """Validate and update existing keys in ocr_settings."""
    if not isinstance(updates, dict) or not updates:
        raise ValueError("更新する設定が指定されていません")

    with _get_connection() as con:
        cur = con.cursor(dictionary=True)
        cur.execute("SELECT setting_key, value_type, is_secret FROM ocr_settings")
        meta = {row["setting_key"]: row for row in cur.fetchall()}

        for key, raw_val in updates.items():
            if key not in meta:
                cur.close()
                raise ValueError(f"不明な設定キーです: {key}")
            val_str = "" if raw_val is None else str(raw_val).strip()
            if meta[key]["is_secret"] and val_str == _SECRET_MASK:
                # Leave secret unchanged when UI submits the mask placeholder
                continue
            if meta[key]["value_type"] == "int":
                try:
                    num = int(val_str)
                except ValueError:
                    cur.close()
                    raise ValueError(f"{key} は整数で指定してください")
                if key in _INT_SETTING_BOUNDS:
                    lo, hi = _INT_SETTING_BOUNDS[key]
                    if num < lo or num > hi:
                        cur.close()
                        raise ValueError(f"{key} は {lo}〜{hi} の範囲で指定してください")
                val_str = str(num)
            cur.execute(
                """
                UPDATE ocr_settings
                   SET setting_value = %s,
                       updated_by    = %s
                 WHERE setting_key   = %s
                """,
                (val_str, (updated_by or "admin")[:100], key),
            )
        cur.close()
    return get_all_settings(mask_secrets=True)


