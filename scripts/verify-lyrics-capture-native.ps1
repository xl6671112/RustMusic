param([switch]$SkipObs)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'outputs\lyrics-capture-native'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$exe = Join-Path $output 'lyrics-capture-check.exe'
Copy-Item -LiteralPath (Join-Path $root 'src-tauri\target\release\examples\lyrics_capture_check.exe') -Destination $exe -Force
$manifestTool = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\mt.exe'
& $manifestTool -nologo "-manifest" (Join-Path $root 'outputs\obs-lyrics-tests.manifest') "-outputresource:$exe;#1"
if ($LASTEXITCODE -ne 0) { throw 'Unable to set test executable manifest' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LyricsCaptureWindowState {
    private delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    public static IntPtr FindOutput(uint targetProcessId) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((window, parameter) => {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId != targetProcessId) return true;
            var title = new StringBuilder(512);
            GetWindowText(window, title, title.Capacity);
            if (!title.ToString().Contains("请使用游戏捕捉")) return true;
            result = window;
            return false;
        }, IntPtr.Zero);
        return result;
    }
}
'@
function Start-Renderer([string]$Geometry = 'null', [switch]$Static) {
    $info = [Diagnostics.ProcessStartInfo]::new($exe)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.ArgumentList.Add($Geometry)
    $info.Environment['RUSTMUSIC_CAPTURE_FRAME_DIRECTORY'] = $output
    if ($Static) { $info.Environment['RUSTMUSIC_CAPTURE_STATIC_FIXTURE'] = '1' }
    $process = [Diagnostics.Process]::Start($info)
    $ready = $process.StandardOutput.ReadLineAsync()
    if (-not $ready.Wait(30000)) { $process.Kill(); throw 'Renderer did not become ready' }
    $line = $ready.Result
    if (-not $line -or ($line | ConvertFrom-Json).visible -ne $true) {
        if (-not $process.WaitForExit(5000)) { $process.Kill(); $process.WaitForExit() }
        throw "Renderer failed (exit $($process.ExitCode)): $line $($process.StandardError.ReadToEnd())"
    }
    Write-Output -NoEnumerate $process
}
function Get-RendererTree([int]$RootProcessId) {
    $all = @(Get-CimInstance Win32_Process)
    $ids = @($RootProcessId)
    do {
        $added = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object ProcessId)
        $ids += $added
    } while ($added.Count)
    return $ids
}
$first = $null
$second = $null
$resumed = $null
$staticWindow = $null
try {
    $first = Start-Renderer
    Write-Output "Renderer ready: $($first.Id)"
    if (-not $SkipObs) {
        & (Join-Path $PSScriptRoot 'verify-lyrics-game-capture.ps1')
        $first.StandardInput.WriteLine('{"command":"minimize"}')
        $first.StandardInput.Flush()
        Start-Sleep -Seconds 1
        $captureWindow = [LyricsCaptureWindowState]::FindOutput($first.Id)
        if ($captureWindow -eq [IntPtr]::Zero) { throw 'Capture title is missing the game-capture instruction' }
        if (-not [LyricsCaptureWindowState]::IsIconic($captureWindow)) { throw 'Capture fixture was not actually minimized' }
        & (Join-Path $PSScriptRoot 'verify-lyrics-game-capture.ps1')
        Copy-Item -LiteralPath (Join-Path $root 'outputs\lyrics-game-capture\report.json') -Destination (Join-Path $output 'minimized-game-capture-report.json') -Force
        $first.StandardInput.WriteLine('{"command":"visible","visible":true}')
        $first.StandardInput.Flush()
        Start-Sleep -Seconds 1
    }
    $second = Start-Renderer '{"width":640,"height":360,"x":100,"y":100}'
    $tree = @(Get-RendererTree $first.Id)
    $memoryBefore = (@(Get-Process -Id $tree -ErrorAction SilentlyContinue) | Measure-Object WorkingSet64 -Sum).Sum
    $first.StandardInput.WriteLine('{"command":"hibernate"}')
    $first.StandardInput.Flush()
    if (-not $first.WaitForExit(20000)) { throw 'Hidden renderer did not exit and release memory' }
    $geometryLine = ($first.StandardOutput.ReadToEnd() -split '\r?\n' | Where-Object { $_ -match '"geometry"' } | Select-Object -Last 1)
    if (-not $geometryLine) { throw 'Hibernation lost the window geometry' }
    $geometry = ($geometryLine | ConvertFrom-Json).geometry
    if ($second.HasExited) { throw 'Hiding one layer closed another independent layer' }
    $deadline = (Get-Date).AddSeconds(15)
    do {
        $remaining = @(Get-Process -Id $tree -ErrorAction SilentlyContinue)
        if (-not $remaining.Count) { break }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    if ($remaining.Count) { throw "Renderer descendants still use memory: $($remaining.Id -join ', ')" }
    $resumed = Start-Renderer ($geometry | ConvertTo-Json -Compress)
    if ($resumed.Id -eq $first.Id) { throw 'Show did not create a fresh renderer' }
    $resumed.StandardInput.WriteLine('{"command":"hibernate"}')
    $resumed.StandardInput.Flush()
    if (-not $resumed.WaitForExit(20000)) { throw 'Resumed renderer did not release memory' }
    $restoredLine = ($resumed.StandardOutput.ReadToEnd() -split '\r?\n' | Where-Object { $_ -match '"geometry"' } | Select-Object -Last 1)
    $restored = ($restoredLine | ConvertFrom-Json).geometry
    foreach ($key in @('width','height','x','y')) { if ($geometry.$key -ne $restored.$key) { throw "Restored window changed $key" } }
    $second.StandardInput.WriteLine('{"command":"close"}')
    $second.StandardInput.Flush()
    if (-not $second.WaitForExit(20000)) { throw 'Closing the other renderer did not exit' }
    $staticWindow = Start-Renderer -Static
    Start-Sleep -Seconds 2
    if ($staticWindow.HasExited) { throw 'A static lyric page exited instead of remaining ready' }
    $staticTree = @(Get-RendererTree $staticWindow.Id)
    $staticHandle = [LyricsCaptureWindowState]::FindOutput($staticWindow.Id)
    if ($staticHandle -eq [IntPtr]::Zero -or -not [LyricsCaptureWindowState]::PostMessage($staticHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Unable to close the isolated static lyric fixture through its title bar' }
    if (-not $staticWindow.WaitForExit(20000) -or $staticWindow.ExitCode -ne 0) { throw 'Title-bar close did not complete cleanly' }
    $deadline = (Get-Date).AddSeconds(15)
    do {
        $staticRemaining = @(Get-Process -Id $staticTree -ErrorAction SilentlyContinue)
        if (-not $staticRemaining.Count) { break }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    if ($staticRemaining.Count) { throw 'Title-bar close left static-page renderer processes alive' }
    $report = @{ passed=$true; hiddenProcessId=$first.Id; recreatedProcessId=$resumed.Id; releasedProcessIds=$tree; releasedWorkingSetBytes=$memoryBefore; independentLayer=$true; geometry=$geometry; restoredGeometry=$restored; obsTested=(-not $SkipObs); staticPageReady=$true; titleBarCloseClean=$true; staticReleasedProcessIds=$staticTree }
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'report.json') -Encoding utf8
    Write-Output ($report | ConvertTo-Json -Depth 5)
} finally {
    foreach ($process in @($first,$second,$resumed,$staticWindow)) {
        if ($process -and -not $process.HasExited) {
            try { $process.StandardInput.WriteLine('{"command":"close"}'); $process.StandardInput.Flush() } catch {}
            if (-not $process.WaitForExit(5000)) { $process.Kill() }
        }
    }
}
