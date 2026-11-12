@echo off
REM ===== DualOCR Setup Script (Windows) =====
REM Run once to install all Python dependencies.

echo.
echo [1/4] Upgrading pip...
python -m pip install --upgrade pip

echo.
echo [2/4] Installing PaddlePaddle (CPU version)...
python -m pip install paddlepaddle==2.6.2 -i https://pypi.tuna.tsinghua.edu.cn/simple

echo.
echo [3/4] Installing PaddleOCR and Docling...
python -m pip install paddleocr==2.9.1 docling==2.14.0

echo.
echo [4/4] Installing remaining dependencies...
python -m pip install -r requirements.txt

echo.
echo ===== Setup complete! =====
echo Run:  python run.py
echo Then open: http://localhost:8080
pause
