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

# ---------------------------------------------------------------------------
# 1. PaddleOCR engine
# ---------------------------------------------------------------------------
_paddle_ocr = None


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
                df     = tbl.export_to_dataframe(doc=doc)
                md_tbl = tbl.export_to_markdown(doc=doc) if hasattr(tbl, "export_to_markdown") else ""
                tables.append({
                    "caption":  "",
                    "markdown": md_tbl,
                    "data":     df.to_dict(orient="records"),
                    "shape":    list(df.shape),
                })
            except Exception:
                pass

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
    """Load DeepSeek-OCR model and tokenizer (lazy, cached)."""
    global _deepseek_model, _deepseek_tokenizer, _deepseek_device
    if _deepseek_model is not None:
        return _deepseek_model, _deepseek_tokenizer, _deepseek_device

    try:
        import torch
        from transformers import AutoModel, AutoTokenizer

        has_cuda = torch.cuda.is_available()
        _deepseek_device = "cuda" if has_cuda else "cpu"

        if not has_cuda:
            logger.warning(
                "DeepSeek-OCR: no CUDA GPU detected — running on CPU is very slow. "
                "Install CUDA-enabled PyTorch for production use."
            )

        logger.info("Loading DeepSeek-OCR model from %s …", _DEEPSEEK_MODEL_ID)
        _deepseek_tokenizer = AutoTokenizer.from_pretrained(
            _DEEPSEEK_MODEL_ID, trust_remote_code=True
        )

        load_kwargs: dict = {"trust_remote_code": True, "use_safetensors": True}
        if has_cuda:
            load_kwargs["_attn_implementation"] = "flash_attention_2"
            _deepseek_model = AutoModel.from_pretrained(
                _DEEPSEEK_MODEL_ID, **load_kwargs
            ).eval().cuda().to(torch.bfloat16)
        else:
            # CPU mode: float32, no flash attention
            _deepseek_model = AutoModel.from_pretrained(
                _DEEPSEEK_MODEL_ID, **load_kwargs
            ).eval()

        logger.info("DeepSeek-OCR ready on %s", _deepseek_device)
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

    # Always run PaddleOCR for per-line confidence (unless explicitly excluded)
    if engines == "both":
        use_paddle, use_docling, use_deepseek = True, True, False

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
    Docling leads on text PDFs; PaddleOCR covers all pages as raster images.
    """
    t0 = time.time()
    use_paddle   = engines in ("all", "paddle")   or "paddle"   in engines
    use_docling  = engines in ("all", "docling")  or "docling"  in engines
    use_deepseek = engines in ("all", "deepseek") or "deepseek" in engines
    if engines == "both":
        use_paddle, use_docling, use_deepseek = True, True, False

    output: dict = {
        "file": Path(file_path).name,
        "paddle":   {},
        "docling":  {},
        "deepseek": {},
        "fused_text":     "",
        "tables":         [],
        "processing_time_s": 0.0,
    }

    # Docling (full document - handles text-based PDFs and structure)
    if use_docling:
        output["docling"] = _docling_process_file(file_path)
        output["tables"]  = output["docling"].get("tables", [])
        if output["docling"].get("error"):
            logger.warning("Docling error: %s", output["docling"]["error"])

    # PaddleOCR + DeepSeek: rasterize ALL pages then process
    if use_paddle or use_deepseek:
        page_images = _pdf_to_images(file_path, dpi=200)

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
                # DeepSeek on first page only (expensive; model is 7 GB)
                output["deepseek"] = _deepseek_ocr_image(str(page_images[0]), mode="markdown")

            # Remove temp images
            for img_path in page_images:
                img_path.unlink(missing_ok=True)

        else:
            msg = "Could not rasterize PDF. Install PyMuPDF: pip install pymupdf"
            if use_paddle:
                output["paddle"]   = {"error": msg, "lines": [], "full_text": ""}
            if use_deepseek:
                output["deepseek"] = {"error": msg, "text": "", "markdown": ""}

    # Fusion
    candidate_texts = {
        "DeepSeek-OCR": output["deepseek"].get("markdown") or output["deepseek"].get("text", ""),
        "Docling":      output["docling"].get("markdown")  or output["docling"].get("text", ""),
        "PaddleOCR":    output["paddle"].get("full_text", ""),
    }
    best_engine = max(
        {k: v for k, v in candidate_texts.items() if v.strip()},
        key=lambda k: len(candidate_texts[k].strip()),
        default="Docling",
    )
    output["fused_text"]     = candidate_texts.get(best_engine, "").strip()
    output["primary_engine"] = best_engine
    output["confidence_avg"] = _avg_confidence(output["paddle"].get("lines", []))
    output["processing_time_s"] = round(time.time() - t0, 2)
    return output


SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}
SUPPORTED_DOC_EXTS   = {".pdf", ".docx", ".pptx", ".html", ".xlsx"}


def process_file(file_path: str, engines: str = "all") -> dict:
    """Auto-dispatch based on file extension."""
    ext = Path(file_path).suffix.lower()
    if ext in SUPPORTED_IMAGE_EXTS:
        return process_image(file_path, engines=engines)
    elif ext in SUPPORTED_DOC_EXTS:
        return process_pdf(file_path, engines=engines)
    else:
        return {"error": f"Unsupported file type: {ext}", "fused_text": ""}
