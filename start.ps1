param([Parameter(ValueFromRemainingArguments=$true)][string[]]$DebateArgs)
& py -3 "$PSScriptRoot\debate.py" @DebateArgs
exit $LASTEXITCODE
