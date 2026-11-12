# Kill ALL python.exe processes (stops all uvicorn workers/reloaders)
Get-Process -Name "python" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "python3" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "All Python processes killed"
Start-Sleep -Seconds 2

# Clear pycache
Get-ChildItem -Path E:\agent\ocr-webapp -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Cache cleared. Starting fresh server..."
& "E:\agent\ocr-webapp\venv\Scripts\python.exe" "E:\agent\ocr-webapp\run.py"
