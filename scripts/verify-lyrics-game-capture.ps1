param(
    [switch]$PrepareOnly,
    [string]$WindowTitle = '透明歌词游戏采集验证',
    [string]$WindowExe = 'lyrics-capture-check.exe',
    [int]$Width = 960,
    [int]$Height = 540,
    [int]$TimeoutSeconds = 70
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = [IO.Path]::GetFullPath((Join-Path $root 'outputs\lyrics-game-capture'))
$installed = 'C:\Program Files\obs-studio'
$runtime = Join-Path $output 'obs'
$binaryDirectory = Join-Path $runtime 'bin\64bit'
$obs = Join-Path $binaryDirectory 'obs64.exe'
$config = Join-Path $runtime 'config\obs-studio'
$profile = Join-Path $config 'basic\profiles\lyrics-game-capture'
$scenes = Join-Path $config 'basic\scenes'
$screenshots = Join-Path $output 'screenshots'
$reportPath = Join-Path $output 'report.json'
$lua = Join-Path $PSScriptRoot 'verify-lyrics-game-capture.lua'
if ($Width -lt 320 -or $Height -lt 180 -or $Width -gt 3840 -or $Height -gt 2160) { throw 'Invalid capture dimensions' }
if (-not (Test-Path -LiteralPath (Join-Path $installed 'bin\64bit\obs64.exe'))) { throw 'Installed OBS is missing' }
New-Item -ItemType Directory -Path $binaryDirectory,$profile,$scenes,$screenshots -Force | Out-Null
if (-not (Test-Path -LiteralPath $obs)) {
    Copy-Item -Path (Join-Path $installed 'bin\64bit\*') -Destination $binaryDirectory -Recurse
}
foreach ($directory in @('data', 'obs-plugins')) {
    $link = Join-Path $runtime $directory
    $target = Join-Path $installed $directory
    if (Test-Path -LiteralPath $link) {
        $entry = Get-Item -LiteralPath $link
        if ($entry.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath($entry.Target) -ne $target) { throw "Unexpected runtime directory: $link" }
    } else {
        New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    }
}
@"
[General]
EnableAutoUpdates=false
FirstRun=true
LastVersion=486604803

[Video]
Renderer=Direct3D 11

[OBSWebSocket]
ServerEnabled=false
"@ | Set-Content -LiteralPath (Join-Path $config 'global.ini') -Encoding utf8
@"
[General]
Name=lyrics-game-capture

[Video]
BaseCX=$Width
BaseCY=$Height
OutputCX=$Width
OutputCY=$Height
FPSNum=30
FPSDen=1

[Output]
Mode=Simple

[SimpleOutput]
FilePath=$screenshots

[AdvOut]
RecFilePath=$screenshots
"@ | Set-Content -LiteralPath (Join-Path $profile 'basic.ini') -Encoding utf8
Add-Type -AssemblyName System.Drawing
$backdropPath = Join-Path $output 'backdrop.png'
$image = [Drawing.Bitmap]::new($Width, $Height)
$drawing = [Drawing.Graphics]::FromImage($image)
try {
    $drawing.Clear([Drawing.Color]::FromArgb(255, 208, 32, 128))
    $image.Save($backdropPath, [Drawing.Imaging.ImageFormat]::Png)
} finally { $drawing.Dispose(); $image.Dispose() }
$sceneItems = @()
foreach ($item in @(@{ name='Backdrop'; uuid='lyrics-capture-backdrop'; id=1 }, @{ name='Native lyric capture'; uuid='lyrics-capture-game'; id=2 })) {
    $sceneItems += @{
        name=$item.name; source_uuid=$item.uuid; id=$item.id; visible=$true; locked=$false
        rot=0.0; pos=@{x=0.0;y=0.0}; scale=@{x=1.0;y=1.0}; align=5; bounds_type=0; bounds_align=0
        bounds=@{x=0.0;y=0.0}; crop_left=0; crop_right=0; crop_top=0; crop_bottom=0
        group_item=$false; scale_filter=''; blend_method='default'; blend_type='normal'; private_settings=@{}
    }
}
$collection = @{
    name='lyrics-game-capture'; current_scene='Lyrics capture validation'; current_program_scene='Lyrics capture validation'
    scene_order=@(@{name='Lyrics capture validation'}); groups=@(); quick_transitions=@()
    sources=@(
        @{name='Lyrics capture validation';uuid='lyrics-capture-scene';id='scene';versioned_id='scene';settings=@{id='Lyrics capture validation';items=$sceneItems};mixers=0;sync=0;flags=0;volume=1.0;balance=0.5;enabled=$true;private_settings=@{}},
        @{name='Backdrop';uuid='lyrics-capture-backdrop';id='image_source';versioned_id='image_source';settings=@{file=$backdropPath}},
        @{name='Native lyric capture';uuid='lyrics-capture-game';id='game_capture';versioned_id='game_capture';settings=@{capture_mode='window';window="$WindowTitle`:`:$WindowExe";allow_transparency=$true;capture_cursor=$false;anti_cheat_hook=$true;limit_framerate=$true;priority=1};mixers=0;sync=0;flags=0;volume=1.0;balance=0.5;enabled=$true;private_settings=@{}}
    )
    modules=@{'scripts-tool'=@(@{path=($lua -replace '\\','/');settings=@{window_title=$WindowTitle;window_exe=$WindowExe}})}
}
$collection | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $scenes 'lyrics-game-capture.json') -Encoding utf8
if ($PrepareOnly) { Write-Output "Prepared isolated OBS at $runtime"; return }
$target = Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($WindowExe)) -ErrorAction SilentlyContinue
if (-not $target) { throw "Capture target is not running: $WindowExe" }
if (Get-Process obs64 -ErrorAction SilentlyContinue | Where-Object Path -eq $obs) { throw 'The isolated OBS runtime is already running' }
$started = Get-Date
$process = Start-Process -FilePath $obs -ArgumentList @('--portable','--multi','--collection','lyrics-game-capture','--profile','lyrics-game-capture','--disable-updater','--disable-missing-files-check') -WorkingDirectory $binaryDirectory -WindowStyle Hidden -PassThru
$latest = $null
try {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 500
        $latest = Get-ChildItem -LiteralPath (Join-Path $config 'logs') -Filter '*.txt' -ErrorAction SilentlyContinue | Where-Object LastWriteTime -ge $started.AddSeconds(-1) | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        $contents = if ($latest) { Get-Content -LiteralPath $latest.FullName -Raw } else { '' }
        if ($contents -match 'LYRICS_GAME_CAPTURE_COMPOSITE=') { break }
        if ($process.HasExited) { throw "Isolated OBS exited: $($process.ExitCode)" }
    } while ((Get-Date) -lt $deadline)
    if ($contents -notmatch 'LYRICS_GAME_CAPTURE_COMPOSITE=') { throw 'Timed out waiting for game-capture screenshots' }
    $windowMatch = [regex]::Match($contents, 'LYRICS_GAME_CAPTURE_WINDOW=([^\r\n]+)')
    if (-not $windowMatch.Success) { throw 'OBS did not select the exact native helper window' }
    $paths = @()
    foreach ($kind in @('SOURCE_1','SOURCE_2','SOURCE_3','COMPOSITE')) {
        $match = [regex]::Match($contents, "LYRICS_GAME_CAPTURE_$kind=([^\r\n]+)")
        if (-not $match.Success) { throw "Missing screenshot: $kind" }
        $path = Join-Path $output ($kind.ToLowerInvariant() + '.png')
        Copy-Item -LiteralPath $match.Groups[1].Value -Destination $path -Force
        $paths += $path
    }
    if (-not ('LyricsCapturePixels' -as [type])) {
        Add-Type -ReferencedAssemblies System.Drawing.Common,System.Drawing.Primitives,System.Private.Windows.GdiPlus,System.Private.Windows.Core,System.Security.Cryptography,System.Collections -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class LyricsCapturePixels {
    private static object Pixel(Bitmap bitmap, int x, int y) {
        var pixel = bitmap.GetPixel(x, y);
        return new { r=pixel.R, g=pixel.G, b=pixel.B };
    }
    public static object Analyze(string path) {
        using (var bitmap = new Bitmap(path)) {
            var samples = new { background=Pixel(bitmap, 5, 5), solid=Pixel(bitmap, 40, 40), translucent=Pixel(bitmap, 100, 40), glow=Pixel(bitmap, 185, 40) };
            var data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try {
                var bytes = new byte[Math.Abs(data.Stride) * bitmap.Height];
                Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
                int transparent=0, partial=0, opaque=0, backdrop=0;
                for (int y=0; y<bitmap.Height; y++) for (int x=0; x<bitmap.Width; x++) {
                    int i=y*Math.Abs(data.Stride)+x*4;
                    if (bytes[i+3]==0) transparent++; else if (bytes[i+3]==255) opaque++; else partial++;
                    if (Math.Abs(bytes[i+2]-208)<=3 && Math.Abs(bytes[i+1]-32)<=3 && Math.Abs(bytes[i]-128)<=3) backdrop++;
                }
                using (var sha = SHA256.Create()) return new { width=bitmap.Width, height=bitmap.Height, transparent, partial, opaque, backdrop, pixelHash=BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", ""), samples };
            } finally { bitmap.UnlockBits(data); }
        }
    }
}
'@
    }
    $frames = @($paths | ForEach-Object { [LyricsCapturePixels]::Analyze($_) })
    # OBS 29.1 source screenshots use RGBX and discard alpha; verify composition over a known backdrop instead.
    $sourceSamples = $frames[0].samples
    $compositeSamples = $frames[3].samples
    if ($sourceSamples.background.r -gt 3 -or $sourceSamples.background.g -gt 3 -or $sourceSamples.background.b -gt 3) { throw 'Source transparent test area was not clear' }
    foreach ($channel in @('r','g','b')) {
        if ($sourceSamples.solid.$channel -lt 250 -or $compositeSamples.solid.$channel -lt 250) { throw 'Opaque pixels were not preserved' }
    }
    if ([Math]::Abs($compositeSamples.background.r-208) -gt 3 -or [Math]::Abs($compositeSamples.background.g-32) -gt 3 -or [Math]::Abs($compositeSamples.background.b-128) -gt 3) { throw 'Transparent pixels did not preserve the scene backdrop' }
    if ($compositeSamples.translucent.r -lt $sourceSamples.translucent.r+20 -or $compositeSamples.translucent.g -lt 50 -or $compositeSamples.translucent.r -ge 195) { throw 'Translucent pixels did not blend with the scene backdrop' }
    # The fixed rgba(50,220,100,.45) block must blend once in OBS's linear color space.
    $foreground = @(50,220,100)
    $background = @(208,32,128)
    $channels = @('r','g','b')
    for ($index=0; $index -lt 3; $index++) {
        $channel = $channels[$index]
        if ([Math]::Abs($sourceSamples.translucent.$channel-$foreground[$index]) -gt 3) { throw 'Game-capture texture must preserve straight-alpha source colors' }
        $values = @($foreground[$index],$background[$index]) | ForEach-Object {
            $srgb = $_ / 255.0
            if ($srgb -le 0.04045) { $srgb/12.92 } else { [Math]::Pow(($srgb+0.055)/1.055,2.4) }
        }
        $linear = $values[0]*0.45+$values[1]*0.55
        $expected = 255.0 * $(if ($linear -le 0.0031308) { 12.92*$linear } else { 1.055*[Math]::Pow($linear,1.0/2.4)-0.055 })
        if ([Math]::Abs($compositeSamples.translucent.$channel-$expected) -gt 5) { throw "Translucent $channel channel differs from a single alpha blend: expected $expected, got $($compositeSamples.translucent.$channel)" }
    }
    if ([Math]::Abs($compositeSamples.glow.r-208)+[Math]::Abs($compositeSamples.glow.g-32)+[Math]::Abs($compositeSamples.glow.b-128) -lt 3) { throw 'Transparent glow was not preserved' }
    if (@($frames[0..2].pixelHash | Select-Object -Unique).Count -lt 2) { throw 'Game-capture pixels did not change across frames' }
    if ($frames[3].backdrop -lt ($Width * $Height / 10)) { throw 'Transparent source did not preserve the colored scene backdrop' }
    Copy-Item -LiteralPath $latest.FullName -Destination (Join-Path $output 'obs.log') -Force
    @{passed=$true;captureType='game_capture';allowTransparency=$true;window=$windowMatch.Groups[1].Value;obsProcessId=$process.Id;targetProcessIds=@($target.Id);frames=$frames;screenshots=$paths;recordingStarted=$false;streamingStarted=$false} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Output "PASS: native game capture preserved transparent, translucent, opaque and animated pixels. Report: $reportPath"
} catch {
    if ($latest) { Copy-Item -LiteralPath $latest.FullName -Destination (Join-Path $output 'obs.log') -Force }
    @{passed=$false;error=$_.Exception.Message;obsProcessId=$process.Id;recordingStarted=$false;streamingStarted=$false} | ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding utf8
    throw
} finally {
    if ($process -and -not $process.HasExited -and $process.Path -eq $obs) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
}
