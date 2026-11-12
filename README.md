# DualOCR — High-Accuracy OCR Web App

Combines **PaddleOCR** and **Docling** in a single web application for maximum OCR accuracy.

## Architecture

```
uploads/ ← user files
ocr-webapp/
  backend/
    main.py        ← FastAPI server, upload/job endpoints
    ocr_engine.py  ← Dual-engine OCR logic + fusion
  frontend/
    templates/index.html
    static/style.css
    static/app.js
  run.py           ← Entry point
  requirements.txt
```

## Engine Roles

| Engine | Strength |
|--------|----------|
| **PaddleOCR** | Pixel-level text detection (DB++ detector), recognition (SVTR_LCNet), angle correction, multilingual |
| **Docling** | Document layout understanding, table/figure extraction, Markdown export, PDF structure |

**Fusion**: Both engines run on every file. The richer, higher-confidence output wins.

## Setup

### 1. Install Python 3.10+

### 2. Run setup script

**Windows:**
```
cd ocr-webapp
setup.bat
```

**Linux / macOS:**
```
cd ocr-webapp
bash setup.sh
```

### 3. Start the server

```
python run.py
```

Open **http://localhost:8080** in your browser.

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/ocr/upload?engine=both` | Upload file, start OCR job |
| `GET`  | `/api/ocr/status/{job_id}` | Poll job status |
| `GET`  | `/api/ocr/result/{job_id}` | Retrieve full result |
| `GET`  | `/api/health` | Health check |

### Supported `engine` values
- `both` — PaddleOCR + Docling (default, highest accuracy)
- `paddle` — PaddleOCR only
- `docling` — Docling only

### Supported file types
Images: `.jpg` `.jpeg` `.png` `.bmp` `.tif` `.tiff` `.webp`  
Documents: `.pdf` `.docx` `.pptx` `.xlsx` `.html`

## Tips for Maximum Accuracy

1. **Use Both engines** (default) — fusion always wins over a single engine
2. **High-DPI scans** — scan at 300 DPI or higher for image files
3. **PDF over image** — Docling handles native PDFs best; for scanned PDFs, Docling runs built-in OCR
4. **Confidence threshold** — PaddleOCR reports per-line confidence; lines < 70% are shown in amber/red

## Repositories Used

- PaddleOCR: `E:\agent\PaddleOCR`
- Docling:   `E:\agent\docling`
