#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Recursively sets CreationTime and LastWriteTime on a directory and all its contents.

.PARAMETER Path
    Root directory to process. Defaults to current directory.

.PARAMETER Date
    Date/time to apply. Accepts any parseable datetime string, e.g. "2026-06-15", "2026-06-15 09:30:00".
    Defaults to now.

.PARAMETER Created
    Set CreationTime. Default: true.

.PARAMETER Modified
    Set LastWriteTime. Default: true.

.PARAMETER WhatIf
    Preview what would be changed without making any changes.

.EXAMPLE
    .\Set-FileDates.ps1
    Sets both timestamps to now on everything under the current directory.

.EXAMPLE
    .\Set-FileDates.ps1 -Path Z:\bose-soundtouch-hybrid -Date "2026-06-15 08:00:00"
    Sets both timestamps to June 15 2026 08:00 on the entire project tree.

.EXAMPLE
    .\Set-FileDates.ps1 -Path Z:\bose-soundtouch-hybrid -Date "2026-06-15" -Modified -WhatIf
    Preview setting only LastWriteTime to June 15 2026.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Position = 0)]
    [string] $Path = '.',

    [Parameter(Position = 1)]
    [string] $Date = '',

    [switch] $Created,
    [switch] $Modified
)

# If neither switch given, default to both
if (-not $Created -and -not $Modified) {
    $Created  = $true
    $Modified = $true
}

$targetDate = if ($Date) { [datetime]::Parse($Date) } else { Get-Date }

$resolvedPath = Resolve-Path -LiteralPath $Path -ErrorAction Stop

Write-Host "Root  : $resolvedPath"
Write-Host "Date  : $($targetDate.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Host "Set   : $(if ($Created) {'CreationTime '})$(if ($Modified) {'LastWriteTime'})"
if ($WhatIfPreference) { Write-Host "[WhatIf mode — no changes will be made]" -ForegroundColor Yellow }
Write-Host ''

# Collect root + all children (dirs first so parent timestamps stick after child writes)
$items = @(Get-Item -LiteralPath $resolvedPath) +
         @(Get-ChildItem -LiteralPath $resolvedPath -Recurse -Force)

$count = 0
foreach ($item in $items) {
    if ($PSCmdlet.ShouldProcess($item.FullName, "Set timestamps")) {
        if ($Created)  { $item.CreationTime  = $targetDate }
        if ($Modified) { $item.LastWriteTime = $targetDate }
        $count++
    } else {
        $count++  # still count in WhatIf so the total is accurate
    }
}

Write-Host "Done. $count item(s) processed."
