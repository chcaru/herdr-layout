#Requires -Version 7.0
param(
    [string] $StockHome = $(if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME '.config\herdr-app' })
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $root 'bundle.json') -Raw | ConvertFrom-Json -AsHashtable
$workspace = Join-Path $PSScriptRoot ('.homes\' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $workspace
$passed = 0

function Assert([bool] $Condition, [string] $Message) {
    if (!$Condition) { throw $Message }
}

function Snapshot([string] $HomePath) {
    return (Get-ChildItem -LiteralPath $HomePath -Recurse -Force | Sort-Object FullName | ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($HomePath, $_.FullName)
        if ($_.PSIsContainer) { "D $relative" }
        else { "F $relative $((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }
    }) -join "`n"
}

function New-Home([string] $Name, [hashtable] $Keys = @{
    global = @{ 'ctrl-shift-p' = 'mod.open:palette'; 'alt-1' = 'space.select:1' }
    terminal = @{ 'ctrl-shift-c' = 'terminal.copy'; 'ctrl-backspace' = "send:`u{0017}" }
}) {
    $homePath = Join-Path $workspace $Name
    $null = New-Item -ItemType Directory -Path $homePath
    foreach ($relative in $manifest.stockRequirements) {
        $dest = Join-Path $homePath $relative
        $null = New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force
        Copy-Item -LiteralPath (Join-Path $StockHome $relative) -Destination $dest
    }
    [IO.File]::WriteAllText((Join-Path $homePath 'keys.json'), ($Keys | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    foreach ($file in 'settings.json', 'programs.json', 'shared.json', 'view.json', 'window.json', 'data\sentinel.txt', 'mods\existing\data.json') {
        $path = Join-Path $homePath $file
        $null = New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force
        [IO.File]::WriteAllText($path, "recipient-owned: $file`n")
    }
    return $homePath
}

function Run-Installer([string] $HomePath, [string[]] $Options = @(), [string] $Installer = (Join-Path $root 'Install.ps1')) {
    $output = & pwsh -NoProfile -NonInteractive -File $Installer -HerdrHome $HomePath @Options 2>&1
    return @{ code = $LASTEXITCODE; output = $output -join "`n" }
}

function Pass([string] $Name) { $script:passed++; Write-Host "PASS $Name" }

try {
    $homePath = New-Home 'collision'
    $before = Snapshot $homePath
    $result = Run-Installer $homePath
    Assert ($result.code -ne 0 -and $result.output -match 'Key collisions') "Expected key rejection: $($result.output)"
    Assert ((Snapshot $homePath) -ceq $before) 'Conflict rejection mutated recipient files or directories.'
    Pass 'stock palette conflict rejects with zero mutation'

    $result = Run-Installer $homePath @('-DryRun', '-ReplaceConflictingKeys')
    Assert ($result.code -eq 0 -and $result.output -match 'DRY RUN') "Dry run failed: $($result.output)"
    Assert ((Snapshot $homePath) -ceq $before) 'Dry run mutated recipient files or directories.'
    Pass 'explicit override dry run changes nothing'

    $stockBefore = @{}
    foreach ($file in Get-ChildItem $homePath -Recurse -File | Where-Object Name -ne 'keys.json') {
        $stockBefore[$file.FullName] = (Get-FileHash $file.FullName).Hash
    }
    $originalKeys = [IO.File]::ReadAllBytes((Join-Path $homePath 'keys.json'))
    $result = Run-Installer $homePath @('-ReplaceConflictingKeys')
    Assert ($result.code -eq 0) "Install failed: $($result.output)"
    Write-Host $result.output
    $keys = Get-Content (Join-Path $homePath 'keys.json') -Raw | ConvertFrom-Json -AsHashtable
    Assert ($keys.global['ctrl-shift-p'] -eq 'mod.open:custom-palette') 'Palette override missing.'
    Assert ($keys.global['alt-1'] -eq 'space.select:1') 'Recipient binding changed.'
    Assert ($keys.terminal['ctrl-shift-c'] -eq 'terminal.copy') 'Terminal copy mapping changed.'
    Assert ($keys.terminal['ctrl-backspace'] -eq "send:`u{0017}") 'Terminal send mapping changed.'
    foreach ($file in $stockBefore.Keys) { Assert ((Get-FileHash $file).Hash -eq $stockBefore[$file]) "Recipient state changed: $file" }
    $backups = @(Get-ChildItem $homePath -Filter 'keys.before-herdr-layout-*.json')
    Assert ($backups.Count -eq 1) 'Expected one original-key backup.'
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($backups[0].FullName)) -eq [Convert]::ToBase64String($originalKeys)) 'Backup lost original bytes.'
    foreach ($mod in $manifest.mods.Keys) {
        $actual = @(Get-ChildItem (Join-Path $homePath "mods\$mod") -Recurse -File)
        Assert ($actual.Count -eq $manifest.mods[$mod].Count) "Unexpected files leaked into $mod."
    }
    Assert (!(Get-ChildItem $homePath -Filter '.install-stage-*')) 'Staging folder leaked.'
    Pass 'successful merge preserves stock bindings, terminal mappings, and all recipient state'

    $before = Snapshot $homePath
    $result = Run-Installer $homePath @('-ReplaceConflictingKeys')
    Assert ($result.code -ne 0 -and $result.output -match 'Name collision') 'Rerun should reject existing names.'
    Assert ((Snapshot $homePath) -ceq $before) 'Rerun changed installed files.'
    Pass 'rerun and update reject existing custom names without mutation'

    $homePath = New-Home 'fresh-keys' @{ global = @{ 'alt-1' = 'space.select:1' }; terminal = @{ 'ctrl-shift-c' = 'terminal.copy' } }
    $result = Run-Installer $homePath
    Assert ($result.code -eq 0) "Nonconflicting install failed: $($result.output)"
    Pass 'nonconflicting recipient keys install without overwrite flag'

    $homePath = New-Home 'terminal-conflict' @{ global = @{}; terminal = @{ 'ctrl-alt-f' = 'terminal.copy' } }
    $before = Snapshot $homePath
    $result = Run-Installer $homePath @('-ReplaceConflictingKeys')
    Assert ($result.code -ne 0 -and $result.output -match 'Terminal key collision') 'Terminal mapping collision was not rejected.'
    Assert ((Snapshot $homePath) -ceq $before) 'Terminal conflict mutated files.'
    Pass 'terminal conflicts cannot be forced'

    $homePath = New-Home 'prefix-conflict' @{ global = @{ 'ctrl-alt-c' = 'tab.new' }; terminal = @{} }
    $before = Snapshot $homePath
    $result = Run-Installer $homePath @('-ReplaceConflictingKeys')
    Assert ($result.code -ne 0 -and $result.output -match 'Key prefix collision') 'Chord-prefix collision was not rejected.'
    Assert ((Snapshot $homePath) -ceq $before) 'Prefix conflict mutated files.'
    Pass 'chord prefix conflicts cannot be forced'

    $homePath = New-Home 'missing-dependency'
    Remove-Item (Join-Path $homePath 'mods\files\file.svg')
    $before = Snapshot $homePath
    $result = Run-Installer $homePath @('-ReplaceConflictingKeys')
    Assert ($result.code -ne 0 -and $result.output -match 'Missing installed Herdr dependency') 'Missing dependency was not rejected.'
    Assert ((Snapshot $homePath) -ceq $before) 'Dependency rejection mutated files.'
    Pass 'missing stock dependency rejects before writing'

    $broken = Join-Path $workspace 'invalid-bundle'
    $null = New-Item -ItemType Directory -Path $broken
    foreach ($entry in 'Install.ps1', 'bundle.json', 'keys.json', 'mods', 'layouts', 'themes') {
        Copy-Item -LiteralPath (Join-Path $root $entry) -Destination (Join-Path $broken $entry) -Recurse
    }
    [IO.File]::WriteAllText((Join-Path $broken 'mods\agents-titles\main.js'), 'this is deliberately invalid JavaScript !')
    $homePath = New-Home 'validation-failure'
    $before = Snapshot $homePath
    $result = Run-Installer $homePath @('-ReplaceConflictingKeys') (Join-Path $broken 'Install.ps1')
    Assert ($result.code -ne 0 -and $result.output -match 'Native mod validation failed') "Native validation should fail: $($result.output)"
    Assert ((Snapshot $homePath) -ceq $before) 'Validation failure left broken destination files or state.'
    Pass 'native validation failure cleans staging and leaves recipient unchanged'

    $homePath = New-Home 'rollback'
    $before = Snapshot $homePath
    $shim = Join-Path $workspace 'native-check-shim'
    $null = New-Item -ItemType Directory -Path $shim
    $realApp = (Get-Command herdr-app -CommandType Application | Select-Object -First 1).Source
    Copy-Item -LiteralPath (Get-Command node -CommandType Application | Select-Object -First 1).Source -Destination (Join-Path $shim 'herdr-app.exe')
    $hook = Join-Path $shim 'check-hook.cjs'
    [IO.File]::WriteAllText($hook, @'
const cp = require("node:child_process");
const args = process.argv.slice(1);
args[0] = require("node:path").basename(args[0]);
if (args[0] === "check" && args[1].endsWith("rollback\\mods\\custom-palette")) {
  console.error("Injected post-copy check failure");
  process.exit(31);
}
const result = cp.spawnSync(process.env.HERDR_TEST_REAL_APP, args, { encoding: "utf8" });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
'@)
    $savedPath = $env:PATH
    $savedOptions = $env:NODE_OPTIONS
    $savedApp = $env:HERDR_TEST_REAL_APP
    try {
        $env:PATH = "$shim;$env:PATH"
        $env:NODE_OPTIONS = "--require=`"$($hook.Replace('\', '\\'))`""
        $env:HERDR_TEST_REAL_APP = $realApp
        $result = Run-Installer $homePath @('-ReplaceConflictingKeys')
    } finally {
        $env:PATH = $savedPath
        $env:NODE_OPTIONS = $savedOptions
        $env:HERDR_TEST_REAL_APP = $savedApp
    }
    Assert ($result.code -ne 0 -and $result.output -match 'Injected post-copy check failure') "Post-copy failure not reached: $($result.output)"
    Assert ((Snapshot $homePath) -ceq $before) 'Post-copy rollback failed to restore recipient bytes and directories.'
    Pass 'post-copy validation failure rolls back files, key merge, backup, and staging'
    Write-Host "$passed installer cases passed."
} finally {
    Remove-Item -LiteralPath $workspace -Recurse -Force
    $parent = Split-Path $workspace -Parent
    if (!(Get-ChildItem -LiteralPath $parent -Force)) { Remove-Item -LiteralPath $parent }
}
