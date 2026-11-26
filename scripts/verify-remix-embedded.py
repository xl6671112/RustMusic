"""Check shipped EXE assets and process audio using only recovered Remix models."""
import argparse
import hashlib
import json
import mmap
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("executable", type=Path)
parser.add_argument("probe", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
sources = [Path("C:/Program Files/VstPlugIns/Acon Digital/Remix.dll")]
sources += [Path("C:/ProgramData/Acon Digital/AIModels") / name for name in
            ("VocalsSeparation.hance", "PianoSeparation.hance", "BassSeparation.hance", "DrumsSeparation.hance")]
assets = []
with args.executable.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as executable:
    for source in sources:
        expected = source.read_bytes()
        offset = executable.find(expected)
        if offset < 0:
            raise RuntimeError("Missing embedded dependency: " + source.name)
        recovered = executable[offset:offset + len(expected)]
        (args.output / source.name).write_bytes(recovered)
        assets.append(dict(name=source.name, bytes=len(recovered), offset=offset,
                           sha256=hashlib.sha256(recovered).hexdigest()))
probe = subprocess.run([str(args.probe.resolve()), str((args.output / "Remix.dll").resolve()),
                        "--models-dir", str(args.output.resolve())], capture_output=True, timeout=90)
log = (probe.stdout + probe.stderr).decode("utf8", errors="replace")
(args.output / "processing.log").write_text(log, encoding="utf8")
delta = re.search(r"mean_change=([0-9.]+)", log)
latency = re.findall(r"latency=([0-9]+)", log)
if probe.returncode or not delta or float(delta[1]) < 0.001 or len(latency) != 2 or min(map(int, latency)) == 0:
    raise RuntimeError("Recovered Remix processing failed; inspect processing.log")
report = dict(passed=True, executable=str(args.executable.resolve()),
              executableSha256=hashlib.file_digest(args.executable.open("rb"), "sha256").hexdigest(),
              assets=assets, modelReadsRedirectedToRecoveredAssets=True,
              meanDifference=float(delta[1]), latencyFrames=list(map(int, latency)),
              scope="Synthetic processing and embedded asset completeness, not subjective listening quality")
(args.output / "verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
print("PASS: EXE contains plugin + four models; recovered models process audio without installed model reads")
