param([int]$Port = 8765)
& py -3 "$PSScriptRoot\ui_server.py" --port $Port --open
exit $LASTEXITCODE
