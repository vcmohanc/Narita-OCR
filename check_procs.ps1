$pids = 14224, 23896, 21584
foreach ($p in $pids) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "PID $p = $($proc.Name) | $($proc.Path)"
    } else {
        Write-Host "PID $p = NOT FOUND"
    }
}
Write-Host "--- All python processes ---"
Get-Process -Name python -ErrorAction SilentlyContinue | Select-Object Id, Name, CPU | Format-Table
