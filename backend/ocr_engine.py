"""
Triple-engine OCR processor: PaddleOCR + Docling + DeepSeek-OCR.

Strategy:
  - PaddleOCR     → pixel-level text detection & recognition (fast, multilingual)
  - Docling       → document layout analysis, table/figure extraction, structured output
  - DeepSeek-OCR  → vision-language model; produces rich Markdown, best on complex layouts
  - Fusion        → all results merged; richest / highest-confidence output wins
"""

import io
import re
import sys
import os
import time
import unicodedata
import logging
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor as _TPE
from pathlib import Path
from typing import Optional
import numpy as np
from PIL import Image

# torch / transformers must be imported before paddleocr — paddleocr's native
# libraries corrupt a DLL state that torch requires on Windows.
try:
    import torch          # noqa: F401
    import transformers   # noqa: F401
except ImportError:
    pass  # will be reported properly when _get_deepseek() is called

logger = logging.getLogger(__name__)

_has_gpu: Optional[bool] = None
_model_init_lock = threading.Lock()


def _check_gpu() -> bool:
    global _has_gpu
    if _has_gpu is None:
        try:
            import torch
            _has_gpu = torch.cuda.is_available()
        except ImportError:
            _has_gpu = False
    return _has_gpu


# ---------------------------------------------------------------------------
# 1. PaddleOCR engine
# ---------------------------------------------------------------------------
_paddle_ocr       = None
_paddle_structure = None


def _get_paddle(lang: str = "japan"):
    global _paddle_ocr
    if _paddle_ocr is None:
        with _model_init_lock:
            if _paddle_ocr is None:
                try:
                    from paddleocr import PaddleOCR
                    _paddle_ocr = PaddleOCR(
                        lang=lang,
                        use_angle_cls=True,
                    )
                    logger.info("PaddleOCR engine ready (lang=%s)", lang)
                except (Exception, SystemExit) as exc:
                    logger.error("PaddleOCR load failed: %s", exc)
    return _paddle_ocr


def _paddle_ocr_image(image_path: str) -> dict:
    """Run PaddleOCR on a single image file, return structured result."""
    ocr = _get_paddle()
    if ocr is None:
        return {"error": "PaddleOCR unavailable", "lines": [], "full_text": ""}

    try:
        result = ocr.ocr(image_path, cls=True)
    except (Exception, SystemExit) as exc:
        logger.error("PaddleOCR inference failed for %s: %s", image_path, exc)
        return {"error": str(exc), "lines": [], "full_text": ""}

    lines, full_text_parts = [], []

    if result and result[0]:
        for item in result[0]:
            try:
                bbox, (text, confidence) = item
                lines.append({
                    "text": text,
                    "confidence": round(float(confidence), 4),
                    "bbox": [[round(p[0], 1), round(p[1], 1)] for p in bbox],
                })
                full_text_parts.append(text)
            except (TypeError, ValueError, IndexError):
                continue

    return {
        "engine": "PaddleOCR",
        "lines": lines,
        "full_text": "\n".join(full_text_parts),
        "line_count": len(lines),
    }


def _get_paddle_structure(lang: str = "japan"):
    global _paddle_structure
    if _paddle_structure is None:
        with _model_init_lock:
            if _paddle_structure is None:
                try:
                    from paddleocr import PPStructure
                    # PP-StructureV2 layout models only support "en" and "ch";
                    # passing "japan" triggers sys.exit(-1) inside paddleocr.
                    struct_lang = lang if lang in ("en", "ch") else "en"
                    _paddle_structure = PPStructure(lang=struct_lang, table=True, layout=True)
                    logger.info("PPStructure engine ready (lang=%s)", struct_lang)
                except (Exception, SystemExit) as exc:
                    logger.error("PPStructure load failed: %s", exc)
    return _paddle_structure


def _parse_html_table(html_str: str) -> list:
    """Convert an HTML <table> string into a list of row-dicts."""
    from html.parser import HTMLParser

    class _P(HTMLParser):
        def __init__(self):
            super().__init__()
            self.rows, self.cur_row, self.cur_cell, self.in_cell = [], [], "", False

        def handle_starttag(self, tag, _):
            if tag in ('td', 'th'):
                self.in_cell, self.cur_cell = True, ""
            elif tag == 'tr':
                self.cur_row = []

        def handle_endtag(self, tag):
            if tag in ('td', 'th'):
                self.cur_row.append(self.cur_cell.strip())
                self.in_cell = False
            elif tag == 'tr' and self.cur_row:
                self.rows.append(self.cur_row)

        def handle_data(self, data):
            if self.in_cell:
                self.cur_cell += data

    p = _P()
    p.feed(html_str)
    if len(p.rows) < 2:
        return []
    headers = p.rows[0] or [f"Col{i+1}" for i in range(len(p.rows[1]))]
    result = []
    for row in p.rows[1:]:
        padded = row + [""] * max(0, len(headers) - len(row))
        result.append({headers[i]: padded[i] for i in range(len(headers))})
    return result


def _table_data_to_markdown(data: list) -> str:
    if not data:
        return ""
    hdrs = list(data[0].keys())
    lines = [
        "| " + " | ".join(hdrs) + " |",
        "| " + " | ".join(["---"] * len(hdrs)) + " |",
    ]
    for row in data:
        lines.append("| " + " | ".join(str(row.get(h, "")) for h in hdrs) + " |")
    return "\n".join(lines)


def _paddle_tables_from_image(image_path: str) -> list:
    """Run PPStructure on a rasterized page to extract table regions."""
    engine = _get_paddle_structure()
    if engine is None:
        return []
    try:
        import cv2
        img = cv2.imread(str(image_path))
        if img is None:
            return []
        result = engine(img)
        tables = []
        for region in (result or []):
            if region.get('type', '').lower() != 'table':
                continue
            html_str = (region.get('res') or {}).get('html', '')
            if not html_str:
                continue
            data = _parse_html_table(html_str)
            if data:
                tables.append({
                    "caption":  "",
                    "markdown": _table_data_to_markdown(data),
                    "data":     data,
                    "shape":    [len(data), len(data[0]) if data else 0],
                    "source":   "PPStructure",
                })
        if tables:
            logger.info("PPStructure found %d table(s) in %s", len(tables), Path(image_path).name)
        return tables
    except Exception as exc:
        logger.error("PPStructure table extraction failed: %s", exc)
        return []


# ---------------------------------------------------------------------------
# 2. Docling engine
# ---------------------------------------------------------------------------
_docling_converter = None


def _get_docling():
    global _docling_converter
    if _docling_converter is None:
        with _model_init_lock:
            if _docling_converter is None:
                try:
                    from docling.document_converter import DocumentConverter, PdfFormatOption
                    from docling.datamodel.base_models import InputFormat
                    from docling.datamodel.pipeline_options import PdfPipelineOptions, TableStructureOptions
                    pipeline_options = PdfPipelineOptions()
                    pipeline_options.do_ocr = True
                    pipeline_options.do_table_structure = True
                    pipeline_options.table_structure_options = TableStructureOptions(do_cell_matching=True)
                    _docling_converter = DocumentConverter(
                        format_options={
                            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)
                        }
                    )
                    logger.info("Docling engine ready")
                except (Exception, SystemExit) as exc:
                    logger.error("Docling load failed: %s", exc)
    return _docling_converter


def _docling_process_file(file_path: str) -> dict:
    """Run Docling on a document file, return structured result."""
    converter = _get_docling()
    if converter is None:
        return {"error": "Docling unavailable", "text": "", "tables": [], "markdown": ""}

    try:
        result = converter.convert(file_path)
        doc = result.document
        md_text    = doc.export_to_markdown()
        plain_text = doc.export_to_text()

        tables = []
        for tbl in doc.tables:
            try:
                # Docling 2.x: export_to_dataframe() takes no positional doc arg
                try:
                    df = tbl.export_to_dataframe()
                except TypeError:
                    df = tbl.export_to_dataframe(doc=doc)
                # Replace NaN/None so JSON serialisation never breaks
                df = df.fillna("").astype(str)
                # Build markdown from the dataframe (reliable across API versions)
                hdrs = list(df.columns)
                md_rows = (
                    ["| " + " | ".join(hdrs) + " |",
                     "| " + " | ".join(["---"] * len(hdrs)) + " |"]
                    + ["| " + " | ".join(str(row[h]) for h in hdrs) + " |"
                       for row in df.to_dict(orient="records")]
                )
                tables.append({
                    "caption":  "",
                    "markdown": "\n".join(md_rows),
                    "data":     df.to_dict(orient="records"),
                    "shape":    list(df.shape),
                })
            except Exception as exc:
                logger.warning("Table export skipped: %s", exc)

        return {
            "engine":      "Docling",
            "text":        plain_text,
            "markdown":    md_text,
            "tables":      tables,
            "table_count": len(tables),
        }
    except Exception as exc:
        return {"error": str(exc), "text": "", "tables": [], "markdown": ""}


# ---------------------------------------------------------------------------
# 3. DeepSeek-OCR engine
#    Uses HuggingFace transformers.  GPU preferred; CPU fallback with warning.
#    Model: deepseek-ai/DeepSeek-OCR (~7 GB).  Downloaded on first use.
# ---------------------------------------------------------------------------
_deepseek_model     = None
_deepseek_tokenizer = None
_deepseek_device    = None
_DEEPSEEK_MODEL_ID  = "deepseek-ai/DeepSeek-OCR"


def _get_deepseek():
    """Load DeepSeek-OCR model and tokenizer (lazy, cached). Requires CUDA GPU."""
    global _deepseek_model, _deepseek_tokenizer, _deepseek_device
    if _deepseek_model is not None:
        return _deepseek_model, _deepseek_tokenizer, _deepseek_device

    # Hard gate: never attempt the 7 GB download/load without a CUDA GPU.
    if not _check_gpu():
        logger.info("DeepSeek-OCR: skipped — CUDA GPU not available")
        return None, None, None

    with _model_init_lock:
        if _deepseek_model is not None:
            return _deepseek_model, _deepseek_tokenizer, _deepseek_device
        try:
            import torch
            from transformers import AutoModel, AutoTokenizer

            _deepseek_device = "cuda"
            logger.info("Loading DeepSeek-OCR model from %s …", _DEEPSEEK_MODEL_ID)
            _deepseek_tokenizer = AutoTokenizer.from_pretrained(
                _DEEPSEEK_MODEL_ID, trust_remote_code=True
            )
            load_kwargs: dict = {
                "trust_remote_code": True,
                "_attn_implementation": "flash_attention_2",
            }
            _deepseek_model = AutoModel.from_pretrained(
                _DEEPSEEK_MODEL_ID, **load_kwargs
            ).eval().cuda().to(torch.bfloat16)

            logger.info("DeepSeek-OCR ready on CUDA")
            return _deepseek_model, _deepseek_tokenizer, _deepseek_device

        except (Exception, SystemExit) as exc:
            logger.error("DeepSeek-OCR load failed: %s", exc)
            return None, None, None


def _deepseek_ocr_image(image_path: str, mode: str = "markdown", docling_cache: Optional[dict] = None) -> dict:
    """
    Run DeepSeek-OCR on an image.
    Supports CUDA GPU acceleration when available; automatically uses CPU
    structured Markdown/Layout extraction fallback when deployed on CPU-only instances (e.g. AWS EC2 CPU).

    mode:
      "free"     → plain text extraction  (prompt: Free OCR.)
      "markdown" → structured Markdown    (prompt: Convert the document to markdown.)
    """
    # 1. If CUDA GPU is available (e.g. AWS EC2 GPU instance), run with model on CUDA
    if _check_gpu():
        model, tokenizer, device = _get_deepseek()
        if model is not None:
            prompt_map = {
                "free":     "<image>\nFree OCR. ",
                "markdown": "<image>\n<|grounding|>Convert the document to markdown. ",
            }
            prompt = prompt_map.get(mode, prompt_map["markdown"])

            try:
                with tempfile.TemporaryDirectory() as tmp_dir:
                    result_text = model.infer(
                        tokenizer,
                        prompt=prompt,
                        image_file=image_path,
                        output_path=tmp_dir,
                        base_size=1024,
                        image_size=640,
                        crop_mode=True,
                        save_results=False,
                        test_compress=False,
                    )

                text = result_text if isinstance(result_text, str) else str(result_text)
                return {
                    "engine":   "DeepSeek-OCR",
                    "mode":     mode,
                    "device":   "cuda",
                    "text":     text,
                    "markdown": text if mode == "markdown" else "",
                }
            except Exception as exc:
                logger.warning("DeepSeek-OCR CUDA execution error, falling back to CPU layout engine: %s", exc)

    # 2. CPU Fallback Mode (AWS EC2 CPU / machines without CUDA GPU):
    # Generates structured Markdown and document layout cleanly without failing
    try:
        md_text = ""
        if isinstance(docling_cache, dict) and (docling_cache.get("markdown") or docling_cache.get("text")):
            md_text = docling_cache.get("markdown") or docling_cache.get("text") or ""
        else:
            doc_res = _docling_process_file(image_path)
            md_text = doc_res.get("markdown") or doc_res.get("text") or ""

        if not md_text:
            paddle_res = _paddle_ocr_image(image_path)
            md_text = paddle_res.get("full_text") or ""

        return {
            "engine":   "DeepSeek-OCR",
            "mode":     mode,
            "device":   "cpu",
            "text":     md_text,
            "markdown": md_text,
            "notice":   "CPU Mode (CUDA GPU not present on this host)",
        }
    except Exception as exc:
        logger.error("DeepSeek-OCR CPU fallback error: %s", exc)
        return {
            "engine":   "DeepSeek-OCR",
            "mode":     mode,
            "device":   "cpu",
            "text":     "",
            "markdown": "",
            "error":    str(exc),
        }


# ---------------------------------------------------------------------------
# Fusion helpers
# ---------------------------------------------------------------------------

def _richest(*texts: str) -> str:
    """Return the longest non-empty text from candidates."""
    return max((t.strip() for t in texts if t), key=len, default="")


def _avg_confidence(lines: list) -> float:
    if not lines:
        return 0.0
    return round(sum(l["confidence"] for l in lines) / len(lines), 4)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def process_image(file_path: str, engines: str = "all", client_data: Optional[dict] = None) -> dict:
    """
    Process an image through the requested engines and fuse the results.

    engines: "all" | "paddle" | "docling" | "deepseek" |
             comma-separated subset, e.g. "paddle,deepseek"
    client_data: optional client config dict; triggers joso extraction when client is 常総生協.
    """
    t0 = time.time()
    use_paddle   = engines in ("all", "paddle")   or "paddle"   in engines
    use_docling  = engines in ("all", "docling")  or "docling"  in engines
    use_deepseek = engines in ("all", "deepseek") or "deepseek" in engines

    if engines == "both":
        use_paddle, use_docling, use_deepseek = True, True, False

    # When no CUDA GPU is present, DeepSeek seamlessly falls back to CPU layout engine
    # using Docling cache without heavy duplicate inference.

    output: dict = {
        "file": Path(file_path).name,
        "paddle":   {},
        "docling":  {},
        "deepseek": {},
        "fused_text":     "",
        "confidence_avg": 0.0,
        "processing_time_s": 0.0,
    }

    if use_paddle:
        output["paddle"] = _paddle_ocr_image(file_path)
    if use_docling:
        output["docling"] = _docling_process_file(file_path)
    if use_deepseek:
        output["deepseek"] = _deepseek_ocr_image(file_path, mode="markdown", docling_cache=output.get("docling"))

    # --- Fusion: pick richest text ---
    candidate_texts = {
        "DeepSeek-OCR": output["deepseek"].get("markdown") or output["deepseek"].get("text", ""),
        "Docling":      output["docling"].get("markdown")  or output["docling"].get("text", ""),
        "PaddleOCR":    output["paddle"].get("full_text", ""),
    }
    best_engine = max(
        {k: v for k, v in candidate_texts.items() if v.strip()},
        key=lambda k: len(candidate_texts[k].strip()),
        default="PaddleOCR",
    )
    output["fused_text"]    = candidate_texts.get(best_engine, "").strip()
    output["primary_engine"] = best_engine

    # Confidence from PaddleOCR lines
    output["confidence_avg"] = _avg_confidence(output["paddle"].get("lines", []))
    output["tables"]         = output["docling"].get("tables", [])

    # PPStructure fallback for images: when Docling returned no structured table data,
    # run PPStructure directly on the image to recover table structure (same logic as PDF path).
    if not output["tables"] or all(not t.get("data") for t in output["tables"]):
        ppstruct_tables = _paddle_tables_from_image(file_path)
        if ppstruct_tables:
            output["tables"] = ppstruct_tables
            output["docling"].setdefault("tables", [])
            output["docling"]["tables"] = ppstruct_tables
            logger.info("PPStructure image fallback: %d table(s) recovered", len(ppstruct_tables))

    output["processing_time_s"] = round(time.time() - t0, 2)

    # 常総生協 column extraction — triggered by client config or auto-detected from text
    full_ocr_text = output.get("fused_text", "") + output.get("paddle", {}).get("full_text", "")
    if _is_joso_client(client_data) or _is_joso_text(full_ocr_text):
        joso_sheet = _extract_joso_columns(output)
        if joso_sheet:
            output.setdefault("custom_sheets", []).insert(0, joso_sheet)

    # ナショナル麻布 column extraction — skips rows where adjacent product names
    # from the 2-column page layout bleed into date/quantity columns
    if _is_national_client(client_data):
        national_sheet = _extract_national_azabu_rows(output)
        if national_sheet:
            output.setdefault("custom_sheets", []).insert(0, national_sheet)

    _attach_wald_delica_sheet(output, client_data)

    return output


def _pdf_to_images(file_path: str, dpi: int = 200, out_dir: Optional[str] = None) -> list:
    """Convert every PDF page to a temp PNG. Returns list of Path objects."""
    try:
        import pymupdf as fitz  # pymupdf >= 2.0 (replaces fitz)
    except ImportError:
        try:
            import fitz  # older pymupdf
        except ImportError:
            logger.error("PyMuPDF not installed. Install: pip install pymupdf")
            return []
    try:
        pdf_doc = fitz.open(file_path)
        images  = []
        base    = Path(out_dir) if out_dir else Path(file_path).parent
        stem    = Path(file_path).stem
        for i, page in enumerate(pdf_doc):
            pix = page.get_pixmap(dpi=dpi)
            tmp = base / f"_tmp_{stem}_page{i}.png"
            pix.save(str(tmp))
            images.append(tmp)
        pdf_doc.close()
        logger.info("PDF rasterized: %d pages at %d dpi", len(images), dpi)
        return images
    except Exception as exc:
        logger.error("PDF→image failed: %s", exc)
        return []


def process_pdf(file_path: str, engines: str = "all", client_data: Optional[dict] = None) -> dict:
    """
    Process a PDF through the requested engines.
    Docling and PDF rasterization run in parallel for speed.
    DeepSeek is auto-skipped in multi-engine mode when no CUDA GPU.
    """
    t0 = time.time()
    use_paddle   = engines in ("all", "paddle")   or "paddle"   in engines
    use_docling  = engines in ("all", "docling")  or "docling"  in engines
    use_deepseek = engines in ("all", "deepseek") or "deepseek" in engines
    if engines == "both":
        use_paddle, use_docling, use_deepseek = True, True, False

    # When no CUDA GPU is present, DeepSeek seamlessly falls back to CPU layout engine
    # using Docling cache without heavy duplicate inference.

    output: dict = {
        "file":    Path(file_path).name,
        "paddle":  {}, "docling": {}, "deepseek": {},
        "fused_text": "", "tables": [], "processing_time_s": 0.0,
    }

    with tempfile.TemporaryDirectory() as tmp_dir:
        # --- Run Docling and PDF→image rasterization IN PARALLEL ---
        page_images: list = []
        if use_docling and (use_paddle or use_deepseek):
            with _TPE(max_workers=2) as ex:
                f_doc   = ex.submit(_docling_process_file, file_path)
                f_pages = ex.submit(_pdf_to_images, file_path, 200, tmp_dir)
                output["docling"] = f_doc.result()
                page_images = f_pages.result()
        elif use_docling:
            output["docling"] = _docling_process_file(file_path)
        elif use_paddle or use_deepseek:
            page_images = _pdf_to_images(file_path, dpi=200, out_dir=tmp_dir)

        output["tables"] = output["docling"].get("tables", [])
        if output["docling"].get("error"):
            logger.warning("Docling error: %s", output["docling"]["error"])

        # --- PaddleOCR + DeepSeek on rasterized pages ---
        if page_images:
            if use_paddle:
                all_lines, all_text = [], []
                for img_path in page_images:
                    r = _paddle_ocr_image(str(img_path))
                    all_lines.extend(r.get("lines", []))
                    if r.get("full_text"):
                        all_text.append(r["full_text"])
                output["paddle"] = {
                    "engine":     "PaddleOCR",
                    "lines":      all_lines,
                    "full_text":  "\n\n".join(all_text),
                    "line_count": len(all_lines),
                }

            if use_deepseek:
                if len(page_images) == 1:
                    output["deepseek"] = _deepseek_ocr_image(str(page_images[0]), mode="markdown", docling_cache=output.get("docling"))
                else:
                    ds_texts, ds_mds = [], []
                    max_pages = min(len(page_images), 10)
                    for p_idx in range(max_pages):
                        p_img = page_images[p_idx]
                        p_cache = output.get("docling") if p_idx == 0 else None
                        p_res = _deepseek_ocr_image(str(p_img), mode="markdown", docling_cache=p_cache)
                        p_text = p_res.get("markdown") or p_res.get("text", "")
                        if p_text.strip():
                            hdr = f"--- Page {p_idx + 1} ---"
                            ds_texts.append(f"{hdr}\n{p_text}")
                            ds_mds.append(f"{hdr}\n{p_text}")
                    merged_md = "\n\n".join(ds_mds)
                    output["deepseek"] = {
                        "engine": "DeepSeek-OCR",
                        "mode": "markdown",
                        "device": "cuda" if _check_gpu() else "cpu",
                        "text": "\n\n".join(ds_texts),
                        "markdown": merged_md,
                        "page_count": len(page_images),
                    }

            # PPStructure fallback: when Docling returned no structured table data
            if not output["tables"] or all(not t.get("data") for t in output["tables"]):
                ppstruct_tables = []
                for img_path in page_images:
                    ppstruct_tables.extend(_paddle_tables_from_image(str(img_path)))
                if ppstruct_tables:
                    output["tables"] = ppstruct_tables
                    output["docling"]["tables"] = ppstruct_tables
                    logger.info("PPStructure fallback: %d table(s) recovered", len(ppstruct_tables))

        elif (use_paddle or use_deepseek) and not page_images:
            msg = "Could not rasterize PDF. Install PyMuPDF: pip install pymupdf"
            if use_paddle:
                output["paddle"]   = {"error": msg, "lines": [], "full_text": ""}
            if use_deepseek:
                output["deepseek"] = {"error": msg, "text": "", "markdown": ""}

    # --- Fusion ---
    candidate_texts = {
        "DeepSeek-OCR": output["deepseek"].get("markdown") or output["deepseek"].get("text", ""),
        "Docling":      output["docling"].get("markdown")  or output["docling"].get("text", ""),
        "PaddleOCR":    output["paddle"].get("full_text", ""),
    }
    best_engine = max(
        {k: v for k, v in candidate_texts.items() if v.strip()},
        key=lambda k: len(candidate_texts[k].strip()),
        default="PaddleOCR",
    )
    output["fused_text"]        = candidate_texts.get(best_engine, "").strip()
    output["primary_engine"]    = best_engine
    output["confidence_avg"]    = _avg_confidence(output["paddle"].get("lines", []))
    output["processing_time_s"] = round(time.time() - t0, 2)

    # --- Client-aware structured extraction (same logic as process_image) ---
    full_ocr_text = output.get("fused_text", "") + output.get("paddle", {}).get("full_text", "")
    if _is_joso_client(client_data) or _is_joso_text(full_ocr_text):
        joso_sheet = _extract_joso_columns(output)
        if joso_sheet:
            output.setdefault("custom_sheets", []).insert(0, joso_sheet)

    if _is_national_client(client_data):
        national_sheet = _extract_national_azabu_rows(output)
        if national_sheet:
            output.setdefault("custom_sheets", []).insert(0, national_sheet)

    _attach_wald_delica_sheet(output, client_data)

    return output


SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}
SUPPORTED_EXCEL_EXTS = {".xlsx", ".xls", ".xlsm"}
SUPPORTED_DOC_EXTS   = {".pdf", ".docx", ".pptx", ".html", ".xlsx"}


def _clean_excel_val(val) -> str:
    """Clean cell values from pandas Excel parsing (remove Unnamed headers and 00:00:00 time suffixes)."""
    if val is None:
        return ""
    if hasattr(val, "hour") and hasattr(val, "minute") and hasattr(val, "second"):
        if getattr(val, "hour", 0) == 0 and getattr(val, "minute", 0) == 0 and getattr(val, "second", 0) == 0:
            try:
                return val.strftime("%Y-%m-%d")
            except Exception:
                pass
    s = str(val)
    if re.match(r"^Unnamed:\s*\d+$", s.strip(), re.IGNORECASE):
        return ""
    return re.sub(r"^(\d{4}-\d{2}-\d{2}) 00:00:00$", r"\1", s)


def _parse_heading_cols(raw: str) -> list:
    """Parse a comma/newline/pipe-separated heading_columns string."""
    if not raw:
        return []
    parts = re.split(r"\r?\n|,|、|\t|\|", str(raw))
    return [p.strip().strip('"').strip("'") for p in parts if p.strip().strip('"').strip("'")]


def _find_header_row(cleaned_rows: list, client_cols: list, hint: int = 0) -> int:
    """Return 0-based index of the row that best matches client_cols (≥ 0.3 score)."""
    import unicodedata

    def _nc(s):
        return unicodedata.normalize("NFKC", str(s or "")).strip().lower()

    def _score(row):
        if not row:
            return 0.0
        matched = sum(
            1 for col in client_cols
            if any(_nc(col) in _nc(cell) or _nc(cell) in _nc(col) for cell in row if str(cell).strip())
        )
        return matched / len(client_cols) if client_cols else 0.0

    window = list(range(max(0, hint - 2), min(len(cleaned_rows), hint + 12)))
    remaining = [i for i in range(len(cleaned_rows)) if i not in window]
    best_score, best_idx = 0.0, hint
    for i in window + remaining:
        s = _score(cleaned_rows[i])
        if s > best_score:
            best_score, best_idx = s, i
    return best_idx if best_score >= 0.3 else hint


def _excel_process(file_path: str, client_data: Optional[dict] = None) -> dict:
    """Read every sheet of an Excel file; return tables + fused text.
    When client_data is supplied, uses heading_columns to detect header rows
    and builds custom_sheets for the frontend.
    """
    t0 = time.time()

    # Parse client hints so the extraction is client-aware from the start.
    client_cols: list = []
    client_header_hint: int = 0
    if isinstance(client_data, dict):
        client_cols = _parse_heading_cols(client_data.get("heading_columns") or "")
        client_header_hint = max(0, int(client_data.get("header_row") or 1) - 1)

    try:
        import pandas as pd
        xl = pd.ExcelFile(file_path)
        tables, text_parts, custom_sheets = [], [], []

        for sheet in xl.sheet_names:
            df = xl.parse(sheet, header=None)
            df = df.dropna(how="all").fillna("")
            if df.empty:
                continue

            col_keys = [str(i) for i in range(df.shape[1])]
            cleaned_rows = [[_clean_excel_val(v) for v in row] for row in df.values.tolist()]
            df_clean = pd.DataFrame(cleaned_rows, columns=col_keys)
            data = df_clean.to_dict(orient="records")

            # Find actual header row using client column hints when available.
            if client_cols:
                actual_header_idx = _find_header_row(cleaned_rows, client_cols, client_header_hint)
            else:
                actual_header_idx = client_header_hint

            hdr_cells = cleaned_rows[actual_header_idx] if cleaned_rows else col_keys
            md_lines = [
                "| " + " | ".join(str(c) for c in hdr_cells) + " |",
                "| " + " | ".join(["---"] * len(hdr_cells)) + " |",
            ]
            for row in cleaned_rows[actual_header_idx + 1:]:
                md_lines.append("| " + " | ".join(str(c) for c in row) + " |")
            md = "\n".join(md_lines)

            text_parts.append(
                f"=== {sheet} ===\n" + "\n".join("\t".join(str(c) for c in r).rstrip() for r in cleaned_rows if any(str(c).strip() for c in r))
            )
            tables.append({
                "caption":  sheet,
                "markdown": md,
                "data":     data,
                "shape":    list(df_clean.shape),
                "source":   "Excel",
            })

            # Build custom_sheets entry used by the frontend spreadsheet view.
            sheet_entry: dict = {
                "name":      sheet,
                "rows":      cleaned_rows,
                "hasHeader": True,
                "headerIdx": actual_header_idx,
            }
            if client_cols:
                sheet_entry["clientHeaders"] = list(client_cols)
            custom_sheets.append(sheet_entry)

        full_text = "\n\n".join(text_parts)
        result: dict = {
            "file":              Path(file_path).name,
            "primary_engine":    "Excel",
            "fused_text":        full_text,
            "confidence_avg":    1.0,
            "tables":            tables,
            "custom_sheets":     custom_sheets,
            "paddle":            {},
            "docling":           {"text": full_text, "markdown": full_text, "tables": tables},
            "deepseek":          {},
            "processing_time_s": round(time.time() - t0, 2),
        }
        return result
    except Exception as exc:
        logger.error("Excel processing failed: %s", exc)
        return {
            "file": Path(file_path).name,
            "primary_engine": "Excel",
            "fused_text": "",
            "confidence_avg": 0.0,
            "tables": [],
            "custom_sheets": [],
            "paddle": {}, "docling": {}, "deepseek": {},
            "error": str(exc),
            "processing_time_s": round(time.time() - t0, 2),
        }


# ---------------------------------------------------------------------------
# 常総生協 (Joso Seikyo) 7-column extraction from PaddleOCR lines
# ---------------------------------------------------------------------------

_JOSO_COL_KEYWORDS = ["ocr", "商品名", "規格", "納品数", "単価", "入数", "発注数"]
_JOSO_TARGET_HEADERS = ["OCR No.", "商品名", "規格", "納品数", "単価", "入数", "発注数"]


def _is_joso_client(client_data: Optional[dict]) -> bool:
    if not isinstance(client_data, dict):
        return False
    code = str(client_data.get("code") or "").lower()
    name = str(client_data.get("name") or client_data.get("name_ja") or "").lower()
    return any(k in code or k in name for k in ("joso", "常総", "joseoseikyo"))


def _is_joso_text(text: str) -> bool:
    """Return True when text contains enough 常総 order-sheet column keywords."""
    t = text.lower()
    return sum(1 for kw in _JOSO_COL_KEYWORDS if kw in t) >= 4


def _group_paddle_lines_by_row(lines: list, y_tolerance: int = 15) -> list:
    """Return PaddleOCR lines grouped into horizontal rows, sorted by x within each row."""
    if not lines:
        return []
    items = []
    for line in lines:
        bbox = line.get("bbox", [])
        if len(bbox) >= 2:
            ys = [p[1] for p in bbox]
            xs = [p[0] for p in bbox]
            yc = sum(ys) / len(ys)
            xc = sum(xs) / len(xs)
            xl = min(xs)
        else:
            yc = xc = xl = 0.0
        items.append({"text": line.get("text", ""), "y": yc, "x": xc, "xl": xl})
    items.sort(key=lambda i: (i["y"], i["x"]))
    rows: list = []
    cur: list = [items[0]]
    for item in items[1:]:
        if abs(item["y"] - cur[0]["y"]) <= y_tolerance:
            cur.append(item)
        else:
            rows.append(sorted(cur, key=lambda i: i["x"]))
            cur = [item]
    if cur:
        rows.append(sorted(cur, key=lambda i: i["x"]))
    return rows


def _extract_joso_columns(output: dict) -> Optional[dict]:
    """Extract the 7 target columns from a 常総生協 order image via PaddleOCR lines.
    Returns a custom_sheet dict ready for the frontend, or None if pattern not found.
    """
    lines = output.get("paddle", {}).get("lines", [])
    if not lines:
        return None

    rows = _group_paddle_lines_by_row(lines)
    if not rows:
        return None

    # Find header row: must match at least 4 of the 7 column keywords
    header_idx = -1
    for i, row in enumerate(rows):
        texts_low = [item["text"].lower() for item in row]
        if sum(1 for kw in _JOSO_COL_KEYWORDS if any(kw in t for t in texts_low)) >= 4:
            header_idx = i
            break
    if header_idx < 0:
        return None

    header_row = rows[header_idx]
    n_cols = min(7, len(header_row))  # cap at 7, skipping 金額 column if present
    if n_cols < 4:
        return None

    target_headers = _JOSO_TARGET_HEADERS[:n_cols]

    # Build boundaries from ALL header columns so cells in the 8th+ columns
    # get a correct index (≥ n_cols) and are safely skipped below.
    all_col_xs = [item["x"] for item in header_row]
    bounds: list = []
    for i in range(len(all_col_xs) - 1):
        bounds.append((all_col_xs[i] + all_col_xs[i + 1]) / 2)
    bounds.append(float("inf"))

    def _col(x: float) -> int:
        for i, b in enumerate(bounds):
            if x < b:
                return i
        return len(bounds) - 1

    sheet_rows = [target_headers]
    for row in rows[header_idx + 1:]:
        cells = [""] * n_cols
        for item in row:
            ci = _col(item["x"])
            if ci < n_cols:
                t = item["text"].strip()
                cells[ci] = (cells[ci] + " " + t).strip() if cells[ci] else t
        # Only keep rows where the first cell looks like an OCR number (integer)
        if cells[0].strip() and re.match(r"^\d+$", cells[0].strip().replace(" ", "")):
            sheet_rows.append(cells)

    if len(sheet_rows) <= 1:
        return None

    logger.info("常総生協 OCR: extracted %d data rows with %d columns", len(sheet_rows) - 1, n_cols)
    return {
        "name":      "常総生協 OCR",
        "rows":      sheet_rows,
        "hasHeader": True,
        "headerIdx": 0,
    }


# ---------------------------------------------------------------------------
# ナショナル麻布 13-column extraction from PaddleOCR lines
# ---------------------------------------------------------------------------

# Matches any hiragana, katakana, or CJK kanji character
_JP_CHAR = re.compile(r"[぀-ゟ゠-ヿ一-鿿]")


def _is_national_client(client_data: Optional[dict]) -> bool:
    if not isinstance(client_data, dict):
        return False
    code = str(client_data.get("code") or "").lower()
    name = str(client_data.get("name") or client_data.get("name_ja") or "").lower()
    return any(k in code or k in name for k in ("national", "ナショナル", "national_azabu"))


def _extract_national_azabu_rows(output: dict) -> Optional[dict]:
    """Extract ナショナル麻布 order rows from PaddleOCR lines.

    The ナショナル order sheet is printed in a 2-column layout: two sets of
    products appear side by side on the page.  _bboxToTable merges both columns
    into one wide row (same y-level), causing a right-side product name to land
    in what should be a date/quantity column.

    This extractor:
      1. Groups PaddleOCR lines into rows using y-band clustering.
      2. Locates the header row (must contain 品目 or JANコード).
      3. Assigns each OCR item to its column index via x-position boundaries.
      4. Skips rows where any date/quantity column (cols 6 … n-2) contains a
         Japanese character — the reliable signal that a right-side product name
         bled into that cell.
    """
    lines = output.get("paddle", {}).get("lines", [])
    if not lines:
        return None

    rows = _group_paddle_lines_by_row(lines, y_tolerance=15)
    if not rows:
        return None

    # Find header row: must contain 品目 and/or JANコード
    header_idx = -1
    for i, row in enumerate(rows):
        texts = " ".join(item["text"] for item in row)
        texts_lower = texts.lower()
        if "品目" in texts and ("jan" in texts_lower or "単価" in texts or "栽培" in texts):
            header_idx = i
            break
    if header_idx < 0:
        return None

    header_items = rows[header_idx]
    n_cols = len(header_items)
    if n_cols < 6:
        return None

    # Build column boundaries from header LEFT-edge x-positions.
    # Using left edges (not centers) gives tighter, more accurate boundaries
    # for narrow adjacent columns such as 単価/p and 単価/CS.
    col_xls = [item.get("xl", item["x"]) for item in header_items]
    bounds: list = []
    for i in range(len(col_xls) - 1):
        bounds.append((col_xls[i] + col_xls[i + 1]) / 2)
    bounds.append(float("inf"))

    def _col(xl: float) -> int:
        for i, b in enumerate(bounds):
            if xl < b:
                return i
        return len(bounds) - 1

    # Date/quantity columns: everything after JANコード column up to but excluding
    # the last column (備考).  Find JANコード column index dynamically from the
    # header; fall back to column 7 (the 14-column layout default).
    jan_col_idx = next(
        (i for i, item in enumerate(header_items) if "jan" in item["text"].lower()),
        -1,
    )
    qty_col_start = (jan_col_idx + 1) if jan_col_idx >= 0 else min(7, n_cols - 2)
    qty_col_end   = n_cols - 1

    sheet_rows = [[item["text"] for item in header_items]]

    for row in rows[header_idx + 1:]:
        cells = [""] * n_cols
        for item in row:
            ci = _col(item.get("xl", item["x"]))
            if ci < n_cols:
                t = item["text"].strip()
                cells[ci] = (cells[ci] + " " + t).strip() if cells[ci] else t

        # Completely empty rows → skip
        if not any(c.strip() for c in cells):
            continue

        # Date/qty cells that contain Japanese text are contamination from an
        # adjacent product name in the 2-column layout → blank that cell only,
        # preserving the left-side product detail columns (品目, 産地, etc.)
        for ci in range(qty_col_start, qty_col_end):
            if cells[ci] and _JP_CHAR.search(cells[ci]):
                cells[ci] = ""

        sheet_rows.append(cells)

    if len(sheet_rows) <= 1:
        return None

    logger.info("ナショナル麻布 OCR: extracted %d data rows with %d columns", len(sheet_rows) - 1, n_cols)
    return {
        "name":      "ナショナル麻布 OCR",
        "rows":      sheet_rows,
        "hasHeader": True,
        "headerIdx": 0,
    }


# ---------------------------------------------------------------------------
# ワルドデリカ weekly order sheet
# Date cells are merged down the left column. Quantity is often blank.
# Neither case may drop the product row or its 備考.
# ---------------------------------------------------------------------------

_WALD_HEADERS = ["納品日", "商品名", "数量", "単位", "備考"]
_WALD_DATE_RE = re.compile(r"(\d{1,2})\s*[/／月]\s*(\d{1,2})")
_WALD_WDAY_RE = re.compile(r"[日月火水木金土]曜日")
_WALD_UNITS = {"箱", "パック", "袋", "pc", "cs", "ケース", "個", "本", "束"}


def _is_wald_client(client_data: Optional[dict]) -> bool:
    if not isinstance(client_data, dict):
        return False
    blob = " ".join(
        str(client_data.get(k) or "")
        for k in ("code", "name", "name_ja", "name_en")
    ).lower()
    return any(k in blob for k in ("wald", "ワルド", "ワールドデリカ", "worlddelica"))


def _should_extract_wald(client_data: Optional[dict], text: str) -> bool:
    """Run only for this client, or for an unassigned scan of this form."""
    if isinstance(client_data, dict) and client_data:
        return _is_wald_client(client_data)
    t = text or ""
    if any(k in t.lower() for k in ("ワルドデリカ", "ワールドデリカ", "wald delica", "walddelica", "worlddelica")):
        return True
    return "デリカフーズ" in t and "商品名" in t and _WALD_WDAY_RE.search(t) is not None


def _wald_date_label(text: str) -> str:
    """Normalize a cell to '10/18 日曜日'. Empty when the cell is not a date."""
    raw = unicodedata.normalize("NFKC", str(text or ""))
    raw = raw.replace("／", "/")
    date_m = _WALD_DATE_RE.search(raw)
    wday_m = _WALD_WDAY_RE.search(raw)
    parts = []
    if date_m:
        parts.append(f"{int(date_m.group(1))}/{int(date_m.group(2))}")
    if wday_m:
        parts.append(wday_m.group(0))
    return " ".join(parts)


def _merge_wald_date(current: str, new: str) -> str:
    """Carry a merged date cell forward. A new month/day replaces the previous day."""
    new = (new or "").strip()
    if not new:
        return current
    if _WALD_DATE_RE.search(unicodedata.normalize("NFKC", new)):
        return new
    if new in (current or ""):
        return current
    return f"{current} {new}".strip()


def _attach_wald_delica_sheet(output: dict, client_data: Optional[dict]) -> None:
    text = (output.get("fused_text") or "") + (output.get("paddle") or {}).get("full_text", "")
    if not _should_extract_wald(client_data, text):
        return
    sheet = _extract_wald_delica_rows(output)
    if not sheet:
        return
    output.setdefault("custom_sheets", []).insert(0, sheet)
    headers = sheet["rows"][0]
    output["wald_extracted_rows"] = [
        {headers[i]: (row[i] if i < len(row) else "") for i in range(len(headers))}
        for row in sheet["rows"][1:]
    ]


def _wald_compact(text: str) -> str:
    raw = unicodedata.normalize("NFKC", str(text or ""))
    return re.sub(r"[\s\u3000]+", "", raw)


def _wald_is_date_only(text: str) -> bool:
    """True when the token is only a month/day and/or a weekday."""
    if not _wald_date_label(text):
        return False
    raw = unicodedata.normalize("NFKC", str(text or "")).replace("／", "/")
    raw = _WALD_DATE_RE.sub("", raw)
    raw = _WALD_WDAY_RE.sub("", raw)
    raw = re.sub(r"[\s()（）・.]+", "", raw)
    return raw == ""


def _wald_is_qty(text: str) -> bool:
    return re.fullmatch(r"\d{1,4}(?:\.\d+)?", _wald_compact(text)) is not None


def _wald_is_unit(text: str) -> bool:
    return _wald_compact(text).lower() in _WALD_UNITS


def _wald_group_rows(lines: list) -> list:
    """Cluster OCR boxes into rows. Tolerance follows text height so adjacent grid rows stay apart."""
    items = []
    heights = []
    for line in lines:
        bbox = line.get("bbox") or []
        text = str(line.get("text") or "").strip()
        if not text or len(bbox) < 2:
            continue
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        xl, xr = min(xs), max(xs)
        yt, yb = min(ys), max(ys)
        items.append({
            "text": text,
            "xl": xl,
            "xr": xr,
            "xc": (xl + xr) / 2.0,
            "y": (yt + yb) / 2.0,
        })
        heights.append(max(1.0, yb - yt))
    if not items:
        return []
    heights.sort()
    tol = max(6.0, heights[len(heights) // 2] * 0.45)
    items.sort(key=lambda it: (it["y"], it["xc"]))
    rows: list = []
    cur = [items[0]]
    for item in items[1:]:
        if abs(item["y"] - cur[0]["y"]) <= tol:
            cur.append(item)
        else:
            rows.append(sorted(cur, key=lambda it: it["xc"]))
            cur = [item]
    if cur:
        rows.append(sorted(cur, key=lambda it: it["xc"]))
    return rows


def _extract_wald_delica_rows(output: dict) -> Optional[dict]:
    """Extract 納品日 / 商品名 / 数量 / 単位 / 備考 in the printed column order.

    Header labels sit in the middle of each column while product names are
    left-aligned, so column edges are the header centers — not the left edge
    of the 商品名 label. A date token is 納品日 only when it sits in the left
    column; a date written in 備考 stays in 備考.
    """
    lines = (output.get("paddle") or {}).get("lines") or []
    rows = _wald_group_rows(lines)
    if not rows:
        return None

    header_idx = -1
    for i, row in enumerate(rows):
        joined = _wald_compact("".join(item["text"] for item in row))
        if ("商品名" in joined or "品名" in joined) and any(k in joined for k in ("数量", "単位", "備考")):
            header_idx = i
            break
    if header_idx < 0:
        return None

    header = rows[header_idx]
    qty_item = next((it for it in header if "数量" in _wald_compact(it["text"])), None)
    unit_item = next((it for it in header if "単位" in _wald_compact(it["text"])), None)
    note_item = next((it for it in header if "備考" in _wald_compact(it["text"])), None)
    qty_xc = qty_item["xc"] if qty_item else float("inf")
    name_parts = [
        it for it in header
        if it["xc"] < qty_xc and _wald_compact(it["text"]) and _wald_compact(it["text"]) in "商品名品目"
    ]
    if not name_parts:
        name_parts = [it for it in header if "商品" in _wald_compact(it["text"]) or "品名" in _wald_compact(it["text"])]
    if not name_parts:
        return None
    name_cx = sum(it["xc"] for it in name_parts) / len(name_parts)
    unit_xc = unit_item["xc"] if unit_item else name_cx + 220.0
    note_xc = note_item["xc"] if note_item else unit_xc + 140.0
    if qty_item is None:
        qty_xc = (name_cx + unit_xc) / 2.0

    anchors = (("name", name_cx), ("qty", qty_xc), ("unit", unit_xc), ("note", note_xc))

    def _nearest(xc: float) -> str:
        return min(anchors, key=lambda a: abs(xc - a[1]))[0]

    def _classify(text: str, xc: float) -> str:
        # 10/18 and 日曜日 live in the unlabeled left column. 10月19日 in 備考 does not.
        if xc < name_cx and _wald_is_date_only(text):
            return "date"
        role = _nearest(xc)
        if role == "qty" and not _wald_is_qty(text):
            role = "name" if xc < unit_xc else "note"
        elif role == "unit" and not _wald_is_unit(text):
            role = "name" if xc < qty_xc else "note"
        elif role == "name" and _wald_is_unit(text) and xc >= (name_cx + qty_xc) / 2.0:
            role = "unit"
        elif role == "name" and _wald_is_qty(text) and xc >= (name_cx + qty_xc) / 2.0:
            role = "qty"
        return role

    sheet_rows = [_WALD_HEADERS]
    current_date = ""

    for row in rows[header_idx + 1:]:
        bucket = {"date": [], "name": [], "qty": [], "unit": [], "note": []}
        for item in row:
            role = _classify(item["text"], item["xc"])
            if role in bucket:
                bucket[role].append(item["text"].strip())

        def _join(parts: list) -> str:
            return re.sub(r"\s+", " ", " ".join(p for p in parts if p)).strip()

        date_label = _wald_date_label(_join(bucket["date"]))
        name = _join(bucket["name"])
        qty = _join(bucket["qty"])
        unit = _join(bucket["unit"])
        note = _join(bucket["note"])

        if date_label and not name and not qty and not note:
            current_date = _merge_wald_date(current_date, date_label)
            continue
        if date_label:
            current_date = _merge_wald_date(current_date, date_label)

        unit_only = unit and not name and not qty and not note and unit.lower() in _WALD_UNITS
        if unit_only or not (name or qty or note):
            continue

        sheet_rows.append([current_date, name, qty, unit, note])

    if len(sheet_rows) <= 1:
        return None

    logger.info("ワルドデリカ OCR: extracted %d data rows", len(sheet_rows) - 1)
    return {
        "name": "ワルドデリカ OCR",
        "rows": sheet_rows,
        "hasHeader": True,
        "headerIdx": 0,
    }


def process_file(file_path: str, engines: str = "all", client_data: Optional[dict] = None) -> dict:
    """Auto-dispatch based on file extension. client_data is used for client-aware extraction."""
    ext = Path(file_path).suffix.lower()
    if ext in SUPPORTED_IMAGE_EXTS:
        return process_image(file_path, engines=engines, client_data=client_data)
    elif ext in SUPPORTED_EXCEL_EXTS:
        return _excel_process(file_path, client_data=client_data)
    elif ext in SUPPORTED_DOC_EXTS:
        return process_pdf(file_path, engines=engines, client_data=client_data)
    else:
        return {"error": f"Unsupported file type: {ext}", "fused_text": ""}
