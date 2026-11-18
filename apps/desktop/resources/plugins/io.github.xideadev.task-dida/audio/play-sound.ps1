param([Parameter(Mandatory=$true)][string]$SoundPath)
$ErrorActionPreference = 'Stop'
(New-Object Media.SoundPlayer $SoundPath).PlaySync()
