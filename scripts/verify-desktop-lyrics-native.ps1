$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'outputs\lyrics-interaction\native'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$manifest = Join-Path $root 'src-tauri\windows-app-manifest.xml'
$manifestHash = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash
$sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$mt = Get-ChildItem -LiteralPath $sdk -Directory |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64\mt.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
if (-not $mt) { throw 'Windows SDK manifest tool was not found' }
$ErrorActionPreference = 'Continue'
try {
    $build = & cargo test --manifest-path (Join-Path $root 'src-tauri\Cargo.toml') --locked --features custom-protocol --no-run --message-format=json 2> (Join-Path $out 'build-stderr.txt')
} finally {
    $ErrorActionPreference = 'Stop'
}
if ($LASTEXITCODE) { throw 'Native test build failed' }
$artifact = $build | ForEach-Object {
    try { $_ | ConvertFrom-Json } catch { }
} | Where-Object { $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.target.name -eq 'rustmusic' -and $_.executable } | Select-Object -Last 1
if (-not $artifact) { throw 'Cargo did not return a native test executable' }
$source = [IO.Path]::GetFullPath($artifact.executable)
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$copy = Join-Path $out 'desktop-lyrics-unit-tests.exe'
Copy-Item -LiteralPath $source -Destination $copy -Force
$testManifest = Join-Path $out 'unit-tests-as-invoker.manifest'
& $mt "-inputresource:$copy;#1" "-out:$testManifest" -nologo | Out-Null
if ($LASTEXITCODE) { throw 'Cannot extract test manifest' }
$xml = Get-Content -LiteralPath $testManifest -Raw
if (-not $xml.Contains('level="requireAdministrator"')) { throw 'Unexpected test execution level' }
$xml.Replace('level="requireAdministrator"', 'level="asInvoker"') | Set-Content -LiteralPath $testManifest -Encoding utf8
& $mt '-manifest' $testManifest "-outputresource:$copy;#1" -nologo | Out-Null
if ($LASTEXITCODE) { throw 'Cannot embed test-only manifest' }
$filter = 'desktop_lyrics_tests::'
$result = & $copy $filter --nocapture 2>&1
$exitCode = $LASTEXITCODE
$result | Set-Content -LiteralPath (Join-Path $out 'test-output.txt')
$result | Write-Output
if ((Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash -ne $manifestHash) { throw 'Official application manifest changed' }
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Original test executable changed' }
@{ filter = $filter; exitCode = $exitCode; officialManifestUnchanged = $true; originalTestExecutableUnchanged = $true } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'verification.json')
if ($exitCode) { throw 'Native lyric region regression failed' }
