param([Parameter(Mandatory=$true)][string]$TargetPath, [Parameter(Mandatory=$true)][string]$ReadyFile)
$lockHandle = [System.IO.File]::Open($TargetPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
  [System.IO.File]::WriteAllText($ReadyFile, 'locked', (New-Object System.Text.UTF8Encoding($false)))
  [Console]::In.ReadLine() | Out-Null
} finally {
  $lockHandle.Dispose()
}
