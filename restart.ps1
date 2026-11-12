Get-ChildItem -Path E:\agent\ocr-webapp -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Cache cleared"
Set-Location E:\agent\ocr-webapp
& "E:\agent\ocr-webapp\venv\Scripts\python.exe" run.py
