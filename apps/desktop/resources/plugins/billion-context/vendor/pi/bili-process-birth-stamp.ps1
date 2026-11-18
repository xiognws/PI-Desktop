# Print one process's creation time in ISO-8601 round-trip form.
#
# Called by pi-native.mjs (processBirthStamp) as:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <this> <pid>
#
# The timestamp keys the wedged-proxy ledger, so a recycled PID is not mistaken
# for the process that was observed earlier. Prints nothing and exits non-zero
# when the PID is gone, and the caller falls back to a PID-only key.
param([int]$ProcessId)
$ErrorActionPreference = 'Stop'
(Get-Process -Id $ProcessId).StartTime.ToString('o')
