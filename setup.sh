#!/usr/bin/env bash
# ===== DualOCR Setup Script (Linux / macOS) =====
set -e

echo ""
echo "[1/4] Upgrading pip..."
python -m pip install --upgrade pip

echo ""
echo "[2/4] Installing PaddlePaddle (CPU)..."
python -m pip install paddlepaddle==2.6.2

echo ""
echo "[3/4] Installing PaddleOCR + Docling..."
python -m pip install paddleocr==2.9.1 docling==2.14.0

echo ""
echo "[4/4] Installing remaining dependencies..."
python -m pip install -r requirements.txt

echo ""
echo "===== Setup complete! ====="
echo "Run:  python run.py"
echo "Open: http://localhost:8080"
