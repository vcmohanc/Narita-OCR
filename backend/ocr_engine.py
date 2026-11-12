"""
Triple-engine OCR processor: PaddleOCR + Docling + DeepSeek-OCR.

Strategy:
  - PaddleOCR     → pixel-level text detection & recognition (fast, multilingual)
  - Docling       → document layout analysis, table/figure extraction, structured output
  - DeepSeek-OCR  → vision-language model; produces rich Markdown, best on complex layouts
  - Fusion        → all results merged; richest / highest-confidence output wins
"""

import io
import sys
import os
import time
import logging
import tempfile
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
        try:
            from paddleocr import PaddleOCR
            _paddle_ocr = PaddleOCR(
                lang=lang,
                use_angle_cls=True,
            )
            logger.info("PaddleOCR engine ready (lang=%s)", lang)
        except Exception as exc:
            logger.error("PaddleOCR load failed: %s", exc)
    return _paddle_ocr


def _paddle_ocr_image(image_path: str) -> dict:
    """Run PaddleOCR on a single image file, return structured result."""
    ocr = _get_paddle()
    if ocr is None:
        return {"error": "PaddleOCR unavailable", "lines": [], "full_text": ""}

    result = ocr.ocr(image_path, cls=True)
    lines, full_text_parts = [], []

    if result and result[0]:
        for item in result[0]:
            bbox, (text, confidence) = item
            lines.append({
                "text": text,
                "confidence": round(float(confidence), 4),
                "bbox": [[round(p[0], 1), round(p[1], 1)] for p in bbox],
            })
            full_text_parts.append(text)

    return {
        "engine": "PaddleOCR",
        "lines": lines,
        "full_text": "\n".join(full_text_parts),
        "line_count": len(lines),
    }


def _get_paddle_structure(lang: str = "japan"):
    global _paddle_structure
    if _paddle_structure is None:
        try:
            from paddleocr import PPStructure
            _paddle_structure = PPStructure(lang=lang, table=True, layout=True)
            logger.info("PPStructure engine ready (lang=%s)", lang)
        except Exception as exc:
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
        except Exception as exc:
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

    except Exception as exc:
        logger.error("DeepSeek-OCR load failed: %s", exc)
        return None, None, None


def _deepseek_ocr_image(image_path: str, mode: str = "markdown") -> dict:
    """
    Run DeepSeek-OCR on an image.

    mode:
      "free"     → plain text extraction  (prompt: Free OCR.)
      "markdown" → structured Markdown    (prompt: Convert the document to markdown.)
    """
    if not _check_gpu():
        return {
            "error": "DeepSeek-OCR requires a CUDA GPU — not available on this machine",
            "text": "", "markdown": "",
        }
    model, tokenizer, device = _get_deepseek()
    if model is None:
        return {"error": "DeepSeek-OCR unavailable", "text": "", "markdown": ""}

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

        # model.infer returns the generated string
        text = result_text if isinstance(result_text, str) else str(result_text)

        return {
            "engine":   "DeepSeek-OCR",
            "mode":     mode,
            "text":     text,
            "markdown": text if mode == "markdown" else "",
        }
    except Exception as exc:
        logger.error("DeepSeek-OCR inference error: %s", exc)
        return {"error": str(exc), "text": "", "markdown": ""}


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

def process_image(file_path: str, engines: str = "all") -> dict:
    """
    Process an image through the requested engines and fuse the results.

    engines: "all" | "paddle" | "docling" | "deepseek" |
             comma-separated subset, e.g. "paddle,deepseek"
    """
    t0 = time.time()
    use_paddle   = engines in ("all", "paddle")   or "paddle"   in engines
    use_docling  = engines in ("all", "docling")  or "docling"  in engines
    use_deepseek = engines in ("all", "deepseek") or "deepseek" in engines

    if engines == "both":
        use_paddle, use_docling, use_deepseek = True, True, False

    # Auto-skip DeepSeek when no GPU and not explicitly requested
    if use_deepseek and engines != "deepseek" and not _check_gpu():
        use_deepseek = False

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
        output["deepseek"] = _deepseek_ocr_image(file_path, mode="markdown")

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
    output["processing_time_s"] = round(time.time() - t0, 2)
    return output


def _pdf_to_images(file_path: str, dpi: int = 200) -> list:
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
        base    = Path(file_path).parent
        for i, page in enumerate(pdf_doc):
            pix = page.get_pixmap(dpi=dpi)
            tmp = base / f"_tmp_page{i}.png"
            pix.save(str(tmp))
            images.append(tmp)
        pdf_doc.close()
        logger.info("PDF rasterized: %d pages at %d dpi", len(images), dpi)
        return images
    except Exception as exc:
        logger.error("PDF→image failed: %s", exc)
        return []


def process_pdf(file_path: str, engines: str = "all") -> dict:
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

    # Auto-skip DeepSeek when no GPU and not explicitly requested
    if use_deepseek and engines != "deepseek" and not _check_gpu():
        use_deepseek = False

    output: dict = {
        "file":    Path(file_path).name,
        "paddle":  {}, "docling": {}, "deepseek": {},
        "fused_text": "", "tables": [], "processing_time_s": 0.0,
    }

    # --- Run Docling and PDF→image rasterization IN PARALLEL ---
    page_images: list = []
    if use_docling and (use_paddle or use_deepseek):
        with _TPE(max_workers=2) as ex:
            f_doc   = ex.submit(_docling_process_file, file_path)
            f_pages = ex.submit(_pdf_to_images, file_path, 200)
            output["docling"] = f_doc.result()
            page_images = f_pages.result()
    elif use_docling:
        output["docling"] = _docling_process_file(file_path)
    elif use_paddle or use_deepseek:
        page_images = _pdf_to_images(file_path, dpi=200)

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
            output["deepseek"] = _deepseek_ocr_image(str(page_images[0]), mode="markdown")

        for img_path in page_images:
            img_path.unlink(missing_ok=True)

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
    return output


SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}
SUPPORTED_EXCEL_EXTS = {".xlsx", ".xls", ".xlsm"}
SUPPORTED_DOC_EXTS   = {".pdf", ".docx", ".pptx", ".html", ".xlsx"}


def _excel_process(file_path: str) -> dict:
    """Read every sheet of an Excel file; return tables + fused text."""
    t0 = time.time()
    try:
        import pandas as pd
        xl = pd.ExcelFile(file_path)
        tables, text_parts = [], []

        for sheet in xl.sheet_names:
            df = xl.parse(sheet, header=0)
            df = df.dropna(how="all").fillna("")
            if df.empty:
                continue

            # Normalise column names to strings
            df.columns = [str(c) for c in df.columns]
            data = df.astype(str).to_dict(orient="records")

            md_lines = ["| " + " | ".join(df.columns) + " |",
                        "| " + " | ".join(["---"] * len(df.columns)) + " |"]
            for row in data:
                md_lines.append("| " + " | ".join(row[c] for c in df.columns) + " |")
            md = "\n".join(md_lines)

            text_parts.append(f"=== {sheet} ===\n" + df.to_string(index=False))
            tables.append({
                "caption":  sheet,
                "markdown": md,
                "data":     data,
                "shape":    list(df.shape),
                "source":   "Excel",
            })

        full_text = "\n\n".join(text_parts)
        return {
            "file":              Path(file_path).name,
            "primary_engine":    "Excel",
            "fused_text":        full_text,
            "confidence_avg":    1.0,
            "tables":            tables,
            "paddle":            {},
            "docling":           {"text": full_text, "markdown": full_text, "tables": tables},
            "deepseek":          {},
            "processing_time_s": round(time.time() - t0, 2),
        }
    except Exception as exc:
        logger.error("Excel processing failed: %s", exc)
        return {
            "file": Path(file_path).name,
            "primary_engine": "Excel",
            "fused_text": "",
            "confidence_avg": 0.0,
            "tables": [],
            "paddle": {}, "docling": {}, "deepseek": {},
            "error": str(exc),
            "processing_time_s": round(time.time() - t0, 2),
        }


def process_file(file_path: str, engines: str = "all") -> dict:
    """Auto-dispatch based on file extension."""
    ext = Path(file_path).suffix.lower()
    if ext in SUPPORTED_IMAGE_EXTS:
        return process_image(file_path, engines=engines)
    elif ext in SUPPORTED_EXCEL_EXTS:
        return _excel_process(file_path)
    elif ext in SUPPORTED_DOC_EXTS:
        return process_pdf(file_path, engines=engines)
    else:
        return {"error": f"Unsupported file type: {ext}", "fused_text": ""}
