#Requires -Version 7.0
[CmdletBinding()]
param(
    [string] $HerdrHome = $(if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME '.config\herdr-app' }),
    [switch] $DryRun,
    [switch] $ReplaceConflictingKeys,
    [switch] $Activate
)

$ErrorActionPreference = 'Stop'
$bundleRoot = $PSScriptRoot
$target = [IO.Path]::GetFullPath($HerdrHome)
$manifest = Get-Content -LiteralPath (Join-Path $bundleRoot 'bundle.json') -Raw | ConvertFrom-Json -AsHashtable
$bundleKeys = Get-Content -LiteralPath (Join-Path $bundleRoot 'keys.json') -Raw | ConvertFrom-Json -AsHashtable
$keyPath = Join-Path $target 'keys.json'
$stage = $null
$installed = [Collections.Generic.List[string]]::new()
$createdParents = [Collections.Generic.List[string]]::new()
$keysWritten = $false
$backup = $null
$oldHome = $env:HERDR_APP_HOME

function Invoke-App([string[]] $Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($app.Source)
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(60000)) {
            $process.Kill($true)
            $process.WaitForExit()
            throw 'Herdr command timed out after 60 seconds.'
        }
        return @{ code = $process.ExitCode; output = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult() }
    } finally { $process.Dispose() }
}

function Assert-SafePath([string] $Root, [string] $Relative) {
    if ([IO.Path]::IsPathRooted($Relative) -or $Relative -match '(^|[\\/])\.\.([\\/]|$)') {
        throw "Unsafe bundle path: $Relative"
    }
    $path = Join-Path $Root $Relative
    $ancestor = $path
    while ($ancestor -and $ancestor.Length -ge $Root.Length) {
        if (Test-Path -LiteralPath $ancestor) {
            if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Linked destination or bundle path is not supported: $ancestor"
            }
        }
        $next = Split-Path $ancestor -Parent
        if ($next -eq $ancestor) { break }
        $ancestor = $next
    }
    return $path
}

function Check-Mods([string] $Root) {
    $env:HERDR_APP_HOME = $Root
    foreach ($name in $manifest.mods.Keys | Sort-Object) {
        $modRoot = Join-Path $Root "mods\$name"
        $generated = @('gpui-kit.d.ts', 'jsconfig.json') |
            ForEach-Object { Join-Path $modRoot $_ } |
            Where-Object { !(Test-Path -LiteralPath $_) }
        try {
            $result = Invoke-App @('check', $modRoot)
            Write-Host $result.output.Trim()
            if ($result.code -ne 0) { throw "Native mod validation failed: $name (exit $($result.code))" }
            Write-Host "PASS herdr-app check mods\$name"
        } finally {
            foreach ($path in $generated) {
                if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
            }
        }
    }
}

try {
    if (!(Test-Path -LiteralPath $target -PathType Container)) {
        throw "Herdr home must already exist with installed stock mods: $target"
    }
    $app = Get-Command herdr-app -CommandType Application -ErrorAction Stop | Select-Object -First 1
    foreach ($program in 'node', 'git', 'hc', 'copilot', 'pwsh') {
        $null = Get-Command $program -ErrorAction Stop
    }
    foreach ($relative in $manifest.stockRequirements) {
        $path = Assert-SafePath $target $relative
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing installed Herdr dependency: $relative" }
    }
    $paths = [Collections.Generic.List[string]]::new()
    $paths.Add("layouts\$($manifest.layout).json")
    $paths.Add("themes\$($manifest.theme).json")
    foreach ($name in $manifest.mods.Keys) {
        if ($name -notmatch '^[a-z0-9-]+$') { throw "Unsafe mod name: $name" }
        $paths.Add("mods\$name")
        foreach ($file in $manifest.mods[$name]) {
            $source = Assert-SafePath $bundleRoot "mods\$name\$file"
            if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing bundle file: $source" }
        }
    }
    foreach ($relative in $paths) {
        $destination = Assert-SafePath $target $relative
        if (Test-Path -LiteralPath $destination) { throw "Name collision: $relative. No files were changed. See README uninstall/update policy." }
        if ($relative -notlike 'mods\*') {
            $source = Assert-SafePath $bundleRoot $relative
            $null = Get-Content -LiteralPath $source -Raw | ConvertFrom-Json
        }
    }
    $null = Assert-SafePath $target 'keys.json'
    $hadKeys = Test-Path -LiteralPath $keyPath
    $original = if ($hadKeys) { [IO.File]::ReadAllBytes($keyPath) } else { $null }
    $keys = if ($hadKeys) { Get-Content -LiteralPath $keyPath -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
    if ($keys -isnot [Collections.IDictionary]) { throw 'Recipient keys.json must contain an object.' }
    foreach ($section in $keys.Keys) {
        if ($keys[$section] -isnot [Collections.IDictionary]) { throw "Recipient key section must contain an object: $section" }
    }
    $conflicts = [Collections.Generic.List[string]]::new()
    foreach ($section in $bundleKeys.Keys) {
        if (!$keys.Contains($section)) { $keys[$section] = @{} }
        if ($keys[$section] -isnot [Collections.IDictionary]) { throw "Recipient key section must contain an object: $section" }
        foreach ($key in $bundleKeys[$section].Keys) {
            $action = $bundleKeys[$section][$key]
            foreach ($existingSection in $keys.Keys) {
                foreach ($existingKey in $keys[$existingSection].Keys) {
                    if ($existingKey.StartsWith("$key ", [StringComparison]::OrdinalIgnoreCase) -or
                        $key.StartsWith("$existingKey ", [StringComparison]::OrdinalIgnoreCase)) {
                        throw "Key prefix collision: $section/$key with $existingSection/$existingKey. Remap before installing."
                    }
                }
            }
            if ($keys[$section].Contains($key) -and $keys[$section][$key] -ne $action) {
                $conflicts.Add("$section/${key}: $($keys[$section][$key]) -> $action")
            }
            if ($section -eq 'global' -and $keys.Contains('terminal') -and $keys.terminal.Contains($key)) {
                throw "Terminal key collision: $key. Terminal mappings are never overwritten; remap before installing."
            }
            $keys[$section][$key] = $action
        }
    }
    if ($conflicts.Count -and !$ReplaceConflictingKeys) {
        throw "Key collisions; no files were changed:`n$($conflicts -join "`n")`nReview, then explicitly pass -ReplaceConflictingKeys."
    }
    $version = Invoke-App @('--version')
    Write-Host "Installed: $($version.output.Trim()); bundle baseline herdr-app $($manifest.baseline.'herdr-app'), hc $($manifest.baseline.hc)."
    if ($version.code -ne 0) { throw 'Cannot determine Herdr version.' }
    if ($conflicts.Count) { Write-Host "Explicit key replacements:`n$($conflicts -join "`n")" }
    if ($DryRun) {
        Write-Host "DRY RUN: copy $($paths.Count) entries, validate eight mods, merge only bundled keys into $target."
        if ($Activate) { Write-Host "DRY RUN: request layout.switch $($manifest.layout) after installation." }
        return
    }
    $stage = Join-Path $target ('.install-stage-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $stage
    foreach ($relative in $paths) {
        $staged = Join-Path $stage $relative
        $null = New-Item -ItemType Directory -Path (Split-Path $staged -Parent) -Force
        if ($relative -like 'mods\*') {
            $name = Split-Path $relative -Leaf
            $null = New-Item -ItemType Directory -Path $staged
            foreach ($file in $manifest.mods[$name]) {
                Copy-Item -LiteralPath (Join-Path $bundleRoot "$relative\$file") -Destination (Join-Path $staged $file)
            }
        } else {
            Copy-Item -LiteralPath (Join-Path $bundleRoot $relative) -Destination $staged
        }
    }
    [IO.File]::WriteAllText((Join-Path $stage 'keys.json'), ($keys | ConvertTo-Json -Depth 30) + "`n", [Text.UTF8Encoding]::new($false))
    Check-Mods $stage
    foreach ($relative in $paths) {
        $destination = Assert-SafePath $target $relative
        if (Test-Path -LiteralPath $destination) { throw "Destination changed during validation: $relative" }
    }
    if ((Test-Path -LiteralPath $keyPath) -ne $hadKeys -or
        ($hadKeys -and [Convert]::ToBase64String([IO.File]::ReadAllBytes($keyPath)) -ne [Convert]::ToBase64String($original))) {
        throw 'Recipient keys changed during validation; retry after closing other editors.'
    }
    if ($hadKeys) {
        $backup = Join-Path $target ('keys.before-herdr-layout-' + [guid]::NewGuid().ToString('N') + '.json')
        [IO.File]::WriteAllBytes($backup, $original)
    }
    foreach ($relative in $paths) {
        $destination = Join-Path $target $relative
        $parent = Split-Path $destination -Parent
        if (!(Test-Path -LiteralPath $parent)) {
            $createdParents.Add($parent)
            $null = New-Item -ItemType Directory -Path $parent
        }
        if ($relative -like 'mods\*') { [IO.Directory]::Move((Join-Path $stage $relative), $destination) }
        else { [IO.File]::Move((Join-Path $stage $relative), $destination) }
        $installed.Add($destination)
    }
    [IO.File]::Move((Join-Path $stage 'keys.json'), $keyPath, $true)
    $keysWritten = $true
    Check-Mods $target
} catch {
    $failure = $_
    if ($keysWritten) {
        if ($hadKeys) { [IO.File]::WriteAllBytes($keyPath, $original) }
        else { Remove-Item -LiteralPath $keyPath -Force }
    }
    foreach ($path in $installed | Sort-Object -Descending) { Remove-Item -LiteralPath $path -Recurse -Force }
    foreach ($path in $createdParents | Sort-Object -Descending) {
        if (!(Get-ChildItem -LiteralPath $path -Force)) { Remove-Item -LiteralPath $path }
    }
    if ($backup -and (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $backup -Force }
    throw $failure
} finally {
    $env:HERDR_APP_HOME = $oldHome
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
}

Write-Host "Installed files and merged keys in $target."
if ($backup) { Write-Host "Original keys backup: $backup" }
if ($Activate) {
    try {
        $env:HERDR_APP_HOME = $target
        $result = Invoke-App @('do', 'layout.switch', (@{ name = $manifest.layout } | ConvertTo-Json -Compress))
        if ($result.code -ne 0) { throw $result.output }
        $response = $result.output | ConvertFrom-Json -AsHashtable
        if ($response.error) { throw ($response.error | ConvertTo-Json -Compress) }
        Write-Host "Activated $($manifest.layout)."
    } catch {
        throw "Files are installed, but activation failed: $_. Open Herdr with this home and switch layouts manually."
    } finally { $env:HERDR_APP_HOME = $oldHome }
} else {
    Write-Host 'Not activated. Open Herdr with this home, then use Ctrl+Shift+L to select files-left.'
}
