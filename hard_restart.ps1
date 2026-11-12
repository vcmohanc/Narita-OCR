Write-Host "Killing all Python processes..."
Get-Process -Name python -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  Killing PID $($_.Id)"
    $_.Kill()
}
Start-Sleep -Seconds 2

Write-Host "Clearing pycache..."
Get-ChildItem -Path E:\agent\ocr-webapp -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Starting server..."
& "E:\agent\ocr-webapp\venv\Scripts\python.exe" "E:\agent\ocr-webapp\run.py"
