param(
    [Parameter(Mandatory = $true)][string]$Label,
    [string]$HelperPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\target\release\examples\lyrics_capture_check.exe')
)
$ErrorActionPreference = 'Stop'
if ($Label -notmatch '^[a-zA-Z0-9-]+$') { throw 'Label must contain only letters, numbers, and hyphens' }
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root "outputs\capture-performance\$Label"
if (Test-Path -LiteralPath $output) { throw "Measurement label already exists: $output" }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$exe = Join-Path $output 'lyrics-capture-performance.exe'
Copy-Item -LiteralPath $HelperPath -Destination $exe -Force
$manifestTool = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\mt.exe'
& $manifestTool -nologo '-manifest' (Join-Path $root 'outputs\obs-lyrics-tests.manifest') "-outputresource:$exe;#1"
if ($LASTEXITCODE -ne 0) { throw 'Unable to set isolated helper manifest' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LyricsPerformanceWindow {
    private delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    public static IntPtr FindOutput(uint targetProcessId) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((window, parameter) => {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId != targetProcessId || !IsWindowVisible(window)) return true;
            var title = new StringBuilder(512);
            GetWindowText(window, title, title.Capacity);
            if (!title.ToString().Contains("\u8bf7\u4f7f\u7528\u6e38\u620f\u6355\u6349")) return true;
            result = window;
            return false;
        }, IntPtr.Zero);
        return result;
    }
}
'@
function Get-Summary($Values) {
    $sorted = @($Values | Sort-Object)
    $aggregate = $sorted | Measure-Object -Average -Minimum -Maximum
    return [ordered]@{
        mean = $aggregate.Average
        p95 = $sorted[[Math]::Ceiling($sorted.Count * 0.95) - 1]
        min = $aggregate.Minimum
        max = $aggregate.Maximum
    }
}
$results = @()
foreach ($mode in @('normal', 'minimized')) {
    $path = Join-Path $output "$mode.json"
    if (Test-Path -LiteralPath $path) { throw "Measurement already exists: $path" }
    $info = [Diagnostics.ProcessStartInfo]::new($exe)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.ArgumentList.Add('{"width":960,"height":540,"x":100,"y":100}')
    $info.Environment.Remove('RUSTMUSIC_CAPTURE_FRAME_DIRECTORY') | Out-Null
    $info.Environment.Remove('RUSTMUSIC_CAPTURE_TEST_EXIT') | Out-Null
    $info.Environment['RUSTMUSIC_CAPTURE_PERFORMANCE_PATH'] = $path
    $process = [Diagnostics.Process]::Start($info)
    try {
        $ready = $process.StandardOutput.ReadLineAsync()
        if (-not $ready.Wait(30000)) { throw 'Performance helper did not become ready' }
        $line = $ready.Result
        if (-not $line -or ($line | ConvertFrom-Json).visible -ne $true) { throw "Performance helper failed: $line" }
        $window = [LyricsPerformanceWindow]::FindOutput($process.Id)
        if ($window -eq [IntPtr]::Zero) { throw 'Isolated helper output window was not found' }
        if ($mode -eq 'minimized') {
            $process.StandardInput.WriteLine('{"command":"minimize"}')
            $process.StandardInput.Flush()
            $deadline = (Get-Date).AddSeconds(5)
            while (-not [LyricsPerformanceWindow]::IsIconic($window)) {
                if ((Get-Date) -gt $deadline) { throw 'Isolated helper did not minimize' }
                Start-Sleep -Milliseconds 50
            }
        }
        if (-not $process.WaitForExit(120000)) { throw 'Performance sampling timed out' }
        $stderr = $process.StandardError.ReadToEnd()
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr | Set-Content -LiteralPath (Join-Path $output "$mode-stderr.log") -Encoding utf8
        "$line`n$stdout" | Set-Content -LiteralPath (Join-Path $output "$mode-stdout.log") -Encoding utf8
        if ($process.ExitCode -ne 0) { throw "Performance helper exit $($process.ExitCode): $stderr $stdout" }
        $samples = @(Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
        if ($samples.Count -ne 180) { throw "Expected 180 completed GPU frame transfers, got $($samples.Count)" }
        $steady = @($samples | Select-Object -Skip 30)
        $statistics = [ordered]@{}
        foreach ($field in @('captureMs','transferMs','decodeMs','presentMs','workMs','intervalMs')) {
            $statistics[$field] = Get-Summary @($steady | ForEach-Object { $_.$field })
        }
        $results += [ordered]@{
            mode = $mode
            helperProcessId = $process.Id
            dimensions = '960x540'
            samples = $samples.Count
            warmupDiscarded = 30
            measured = $steady.Count
            all180IntervalSumMs = ($samples | Measure-Object intervalMs -Sum).Sum
            steady150IntervalSumMs = ($steady | Measure-Object intervalMs -Sum).Sum
            completedGpuFramesPerSecond = 1000.0 / $statistics.intervalMs.mean
            intervalAbove33ms = @($steady | Where-Object { $_.intervalMs -gt 33 }).Count
            statistics = $statistics
        }
    } finally {
        if (-not $process.HasExited) {
            try { $process.StandardInput.WriteLine('{"command":"close"}'); $process.StandardInput.Flush() } catch {}
            if (-not $process.WaitForExit(5000)) { $process.Kill($true); $process.WaitForExit() }
        }
        $process.Dispose()
    }
}
$report = [ordered]@{
    label = $Label
    timestamp = (Get-Date).ToString('o')
    helperSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
    pipeline = 'webview2-composition-gpu'
    timingSemantics = [ordered]@{
        captureMs = 'Wait for the next composition GPU frame'
        transferMs = 'Zero: no image transfer or base64 decode'
        decodeMs = 'Zero: no image decode'
        presentMs = 'Acquire texture and submit GPU rendering'
        intervalMs = 'Elapsed time between consumed GPU frames'
    }
    obsTested = $false
    note = 'Each sample consumes a newly delivered composition GPU frame and presents it. Unique changed pixels, end-to-end animation latency, and OBS delivery are not measured. All stage values are CPU wall time, not CPU utilization or GPU execution time. The historical screenshot baseline uses a different pipeline.'
    results = $results
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'summary.json') -Encoding utf8
$report | ConvertTo-Json -Depth 8
