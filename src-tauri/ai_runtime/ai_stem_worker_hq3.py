"""Offline HQ3 worker. MDX overlap/gain follows audio-separator (MIT)."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time

MODEL = "UVR-MDX-NET-Inst_HQ_3.onnx"
PRO_MODEL = "BS-Roformer-Resurrection-Instrumental.onnx"
FFT, HOP, BINS, FRAMES = 6144, 1024, 3072, 256
MDX_CONFIGS = {
    "mdx-hq3": (FFT, HOP, BINS, FRAMES, 1.022),
    "mdx-karaoke": (6144, 1024, 2048, 256, 1.035),
}


def apply_memory_limit(megabytes):
    """Limit this worker's private committed memory, leaving the player unaffected."""
    if not megabytes:
        return None
    limit = megabytes * 1024 * 1024
    if os.name != "nt":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        return None
    import ctypes
    from ctypes import wintypes
    class Basic(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                    ("flags", wintypes.DWORD), ("minimum_working_set", ctypes.c_size_t),
                    ("maximum_working_set", ctypes.c_size_t), ("active_processes", wintypes.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                    ("scheduling", wintypes.DWORD)]
    class Io(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in
                    ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]
    class Extended(ctypes.Structure):
        _fields_ = [("basic", Basic), ("io", Io), ("process_memory", ctypes.c_size_t),
                    ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t),
                    ("peak_job", ctypes.c_size_t)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    handle = kernel.CreateJobObjectW(None, None)
    info = Extended()
    info.basic.flags = 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
    info.process_memory = limit
    if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        raise ctypes.WinError(ctypes.get_last_error())
    return handle


class LimitedSession:
    def __init__(self, session, gpu_percent):
        self.session = session
        self.gpu_percent = gpu_percent

    def __getattr__(self, name):
        return getattr(self.session, name)

    def run(self, *args, **kwargs):
        started = time.monotonic()
        result = self.session.run(*args, **kwargs)
        if self.gpu_percent < 100 and self.session.get_providers()[0] != "CPUExecutionProvider":
            time.sleep((time.monotonic() - started) * (100 / self.gpu_percent - 1))
        return result


def spectrum(audio, fft, hop, bins, frame_count, window):
    trim = fft // 2
    padded = np.pad(audio, ((0, 0), (trim, trim)), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, fft, axis=-1)[:, ::hop]
    transformed = np.fft.rfft(frames * window, axis=-1).astype(np.complex64)
    return np.stack((transformed.real, transformed.imag), axis=1).transpose(0, 1, 3, 2).reshape(1, 4, fft // 2 + 1, frame_count)[:, :, :bins].copy()


def inverse(prediction, fft, hop, bins, frame_count, window):
    trim = fft // 2
    chunk = hop * (frame_count - 1)
    spec = prediction.reshape(2, 2, bins, frame_count)
    full = np.zeros((2, fft // 2 + 1, frame_count), np.complex64)
    full[:, :bins] = spec[:, 0] + 1j * spec[:, 1]
    frames = np.fft.irfft(full.transpose(0, 2, 1), n=fft, axis=-1).astype(np.float32)
    audio = np.zeros((2, chunk + fft), np.float32)
    weight = np.zeros(chunk + fft, np.float32)
    for index in range(frame_count):
        start = index * hop
        audio[:, start:start + fft] += frames[:, index] * window
        weight[start:start + fft] += window * window
    return audio[:, trim:-trim] / weight[trim:-trim]


def demix(mix, session, architecture="mdx-hq3"):
    fft, hop, bins, frame_count, _ = MDX_CONFIGS[architecture]
    trim = fft // 2
    chunk = hop * (frame_count - 1)
    generated = chunk - 2 * trim
    padding = generated + trim - mix.shape[-1] % generated
    mixture = np.pad(mix, ((0, 0), (trim, padding)))
    result = np.zeros_like(mixture)
    divider = np.zeros(mixture.shape[-1], np.float32)
    starts = range(0, mixture.shape[-1], int(0.75 * chunk))
    model_window = globals().get("WINDOW")
    if model_window is None or len(model_window) != fft:
        model_window = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(fft) / fft)).astype(np.float32)
    for number, start in enumerate(starts, 1):
        end = min(start + chunk, mixture.shape[-1])
        count = end - start
        part = np.pad(mixture[:, start:end], ((0, 0), (0, chunk - count)))
        spec = spectrum(part, fft, hop, bins, frame_count, model_window)
        spec[:, :, :3] = 0
        prediction = session.run(None, {"input": spec})[0]
        separated = inverse(prediction, fft, hop, bins, frame_count, model_window)[:, :count]
        blend_window = np.hanning(count)
        result[:, start:end] += separated * blend_window
        divider[start:end] += blend_window
        print(json.dumps({"phase": "inference", "completed": number, "total": len(starts)}), flush=True)
    selected = slice(trim, trim + mix.shape[-1])
    if np.any(divider[selected] <= 0):
        raise RuntimeError("uncovered output samples")
    return result[:, selected] / divider[selected]


def normalize(audio):
    peak = np.max(np.abs(audio))
    if not np.isfinite(peak):
        raise ValueError("audio contains non-finite samples")
    return audio * (0.9 / peak) if peak > 0.9 else audio


def split_karaoke_target(mix, target):
    """Karaoke 2 predicts the instrumental stem; vocals are its mixture residual."""
    instrumental = target
    vocals = mix - instrumental * MDX_CONFIGS["mdx-karaoke"][4]
    return instrumental, vocals


def resurrection_chunk(audio, session):
    fft, hop = 2048, 441
    window = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(fft) / fft)).astype(np.float32)
    single = audio.ndim == 2
    if single:
        audio = audio[None]
    padded = np.pad(audio, ((0, 0), (0, 0), (fft // 2, fft // 2)), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, fft, axis=-1)[:, :, ::hop]
    spec = np.fft.rfft(frames * window, axis=-1).astype(np.complex64)
    merged = spec.transpose(0, 3, 1, 2).reshape(audio.shape[0], 2050, spec.shape[2])
    real_input = np.stack((merged.real, merged.imag), axis=-1)
    mask = session.run(None, {"spectrum": real_input})[0][:, 0]
    prediction = merged * (mask[..., 0] + 1j * mask[..., 1])
    prediction = prediction.reshape(audio.shape[0], 1025, 2, -1).transpose(0, 2, 3, 1)
    frames = np.fft.irfft(prediction, n=fft, axis=-1).astype(np.float32)
    length = (frames.shape[2] - 1) * hop + fft
    result = np.zeros((audio.shape[0], 2, length), np.float32)
    divider = np.zeros(length, np.float32)
    for index in range(frames.shape[2]):
        start = index * hop
        result[:, :, start:start + fft] += frames[:, :, index, :] * window
        divider[start:start + fft] += window * window
    output = result[:, :, fft // 2:] / np.maximum(divider[fft // 2:], 1e-11)
    output = output[:, :, :audio.shape[-1]]
    return output[0] if single else output


def resurrection_demix(mix, session):
    # Match the published 749259-sample chunks, 50% overlap and 10% fades.
    chunk, step = 749259, 749259 // 2
    fade = chunk // 10
    border, original_length = chunk - step, mix.shape[-1]
    reflect_border = original_length > 2 * border
    if reflect_border:
        mix = np.pad(mix, ((0, 0), (border, border)), mode="reflect")
    result = np.zeros_like(mix)
    divider = np.zeros(mix.shape[-1], np.float32)
    window = np.ones(chunk, np.float32)
    window[:fade] = np.linspace(0, 1, fade)
    window[-fade:] = np.linspace(1, 0, fade)
    starts = range(0, mix.shape[-1], step)
    batch_size = 1 if session.get_providers()[0] == "DmlExecutionProvider" or int(os.environ.get("RUSTMUSIC_AI_MEMORY_MB", "0")) else 2
    pending = []
    for number, start in enumerate(starts, 1):
        count = min(chunk, mix.shape[-1] - start)
        part = np.pad(mix[:, start:start + count], ((0, 0), (0, chunk - count)),
                      mode="reflect" if count > chunk // 2 else "constant")
        pending.append((part, start, count))
        if len(pending) == batch_size or number == len(starts):
            predictions = resurrection_chunk(np.stack([item[0] for item in pending]), session)
            for prediction, (_, position, length) in zip(predictions, pending):
                current = window.copy()
                if position == 0:
                    current[:fade] = 1
                if position + length == mix.shape[-1]:
                    current[-fade:] = 1
                result[:, position:position + length] += prediction[:, :length] * current[:length]
                divider[position:position + length] += current[:length]
            pending.clear()
            print(json.dumps({"phase": "inference", "completed": number, "total": len(starts)}), flush=True)
    if np.any(divider <= 0):
        raise RuntimeError("uncovered BS-RoFormer Resurrection output samples")
    result /= divider
    return result[:, border:border + original_length] if reflect_border else result


def load_audio(source, root):
    import soundfile as sf
    import soxr
    output_subtype = "PCM_16"
    try:
        subtype = sf.info(str(source)).subtype
        if subtype == "PCM_24":
            output_subtype = "PCM_24"
        elif subtype in ("PCM_32", "FLOAT", "DOUBLE"):
            output_subtype = "PCM_32"
        audio, rate = sf.read(str(source), dtype="float32", always_2d=True)
    except (RuntimeError, sf.LibsndfileError):
        if os.environ.get("RUSTMUSIC_AI_NATIVE_DECODED") == "1":
            raise RuntimeError("The player's native audio decoder did not produce a readable WAV")
        command = [str(root / "ffmpeg/ffmpeg.exe"), "-v", "error", "-i", str(source),
                   "-vn", "-ac", "2", "-c:a", "pcm_f32le", "-f", "wav", "pipe:1"]
        output = subprocess.run(command, capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if output.returncode:
            raise RuntimeError(output.stderr.decode("utf-8", errors="replace")[-2000:])
        audio, rate = sf.read(io.BytesIO(output.stdout), dtype="float32", always_2d=True)
    if not audio.size or not np.isfinite(audio).all():
        raise ValueError("input audio is empty or contains non-finite samples")
    if rate != 44100:
        audio = soxr.resample(audio, rate, 44100, quality="HQ")
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    if audio.shape[1] != 2:
        raise ValueError("input audio must be mono or stereo")
    return np.ascontiguousarray(audio.T), output_subtype


def create_session(model, mode):
    architecture = os.environ.get("RUSTMUSIC_AI_ARCHITECTURE", "bs-roformer-resurrection" if model.name == PRO_MODEL else "mdx-hq3")
    expected = [2050, "frames", 2] if architecture == "bs-roformer-resurrection" else [4, MDX_CONFIGS[architecture][2], MDX_CONFIGS[architecture][3]]
    root = Path(os.environ.get("RUSTMUSIC_AI_RUNTIME_ROOT", model.parent.parent)).resolve()
    bridge_path = Path(os.environ.get("RUSTMUSIC_AI_INFERENCE_DLL", root.parent / "rustmusic-ai-inference.dll")).resolve()
    runtime_path = root / "_internal/onnxruntime/capi/onnxruntime.dll"

    class NativeSession:
        def __init__(self, use_gpu):
            import ctypes
            from ctypes import wintypes
            self.ctypes = ctypes
            self.dll = ctypes.CDLL(str(bridge_path))
            self.dll.rm_ai_create.argtypes = [
                wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_int, ctypes.c_int,
                ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_int),
                ctypes.POINTER(ctypes.c_char), ctypes.c_size_t,
            ]
            self.dll.rm_ai_create.restype = ctypes.c_int
            self.dll.rm_ai_run.argtypes = [
                ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_size_t,
                ctypes.POINTER(ctypes.c_int64), ctypes.c_size_t,
                ctypes.POINTER(ctypes.POINTER(ctypes.c_float)), ctypes.POINTER(ctypes.c_size_t),
                ctypes.POINTER(ctypes.POINTER(ctypes.c_int64)), ctypes.POINTER(ctypes.c_size_t),
                ctypes.POINTER(ctypes.c_char), ctypes.c_size_t,
            ]
            self.dll.rm_ai_run.restype = ctypes.c_int
            self.dll.rm_ai_input_shape.argtypes = [
                ctypes.c_void_p, ctypes.POINTER(ctypes.c_int64), ctypes.c_size_t,
                ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_char), ctypes.c_size_t,
            ]
            self.dll.rm_ai_input_shape.restype = ctypes.c_int
            self.dll.rm_ai_free.argtypes = [ctypes.c_void_p]
            self.dll.rm_ai_destroy.argtypes = [ctypes.c_void_p]
            self.handle = ctypes.c_void_p()
            actual_gpu = ctypes.c_int()
            error = ctypes.create_string_buffer(2048)
            ok = self.dll.rm_ai_create(
                str(runtime_path), str(model), int(use_gpu), min(8, os.cpu_count() or 1),
                ctypes.byref(self.handle), ctypes.byref(actual_gpu), error, len(error),
            )
            if not ok:
                raise RuntimeError(error.value.decode("utf-8", errors="replace"))
            self.gpu = bool(actual_gpu.value)
            dimensions = (ctypes.c_int64 * 16)()
            rank = ctypes.c_size_t()
            if not self.dll.rm_ai_input_shape(self.handle, dimensions, len(dimensions), ctypes.byref(rank), error, len(error)):
                self.close()
                raise RuntimeError(error.value.decode("utf-8", errors="replace"))
            self.shape = [int(dimensions[i]) if dimensions[i] >= 0 else "dynamic" for i in range(rank.value)]

        def run(self, _outputs, feed):
            import numpy as np
            tensor = np.ascontiguousarray(next(iter(feed.values())), dtype=np.float32)
            shape = (self.ctypes.c_int64 * tensor.ndim)(*tensor.shape)
            out_data = self.ctypes.POINTER(self.ctypes.c_float)()
            out_count = self.ctypes.c_size_t()
            out_shape = self.ctypes.POINTER(self.ctypes.c_int64)()
            out_rank = self.ctypes.c_size_t()
            error = self.ctypes.create_string_buffer(2048)
            ok = self.dll.rm_ai_run(
                self.handle, tensor.ctypes.data_as(self.ctypes.POINTER(self.ctypes.c_float)),
                tensor.size, shape, tensor.ndim, self.ctypes.byref(out_data),
                self.ctypes.byref(out_count), self.ctypes.byref(out_shape),
                self.ctypes.byref(out_rank), error, len(error),
            )
            if not ok:
                raise RuntimeError(error.value.decode("utf-8", errors="replace"))
            try:
                dimensions = np.ctypeslib.as_array(out_shape, shape=(out_rank.value,)).copy()
                output = np.ctypeslib.as_array(out_data, shape=(out_count.value,)).copy()
                return [output.reshape(tuple(int(size) for size in dimensions))]
            finally:
                self.dll.rm_ai_free(out_data)
                self.dll.rm_ai_free(out_shape)

        def get_providers(self):
            return ["DmlExecutionProvider" if self.gpu else "CPUExecutionProvider"]

        def get_inputs(self):
            return [type("Input", (), {"shape": self.shape})()]

        def close(self):
            handle = getattr(self, "handle", None)
            if handle:
                self.dll.rm_ai_destroy(self.handle)
                self.handle = None

        def __del__(self):
            self.close()

    try:
        session = NativeSession(mode == "GPU")
    except Exception:
        if mode != "GPU":
            raise
        session = NativeSession(False)
    actual = session.get_inputs()[0].shape[1:]
    if any(isinstance(size, int) and size != found for size, found in zip(expected, actual)) or len(expected) != len(actual):
        session.close()
        raise ValueError("model dimensions do not match the selected edition")
    return LimitedSession(session, int(os.environ.get("RUSTMUSIC_AI_GPU_PERCENT", "100")))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) not in (5, 6):
        raise SystemExit("usage: worker INPUT OUTPUT MODEL_DIR CPU|GPU [VOCALS_OUTPUT]")
    source, target, model_dir = (Path(value).resolve() for value in sys.argv[1:4])
    mode = sys.argv[4].upper()
    if mode not in ("CPU", "GPU"):
        raise ValueError("mode must be CPU or GPU")
    root = Path(os.environ.get("RUSTMUSIC_AI_RUNTIME_ROOT", model_dir.parent)).resolve()
    memory_mb = int(os.environ.get("RUSTMUSIC_AI_MEMORY_MB", "0"))
    gpu_percent = int(os.environ.get("RUSTMUSIC_AI_GPU_PERCENT", "100"))
    if not 10 <= gpu_percent <= 100 or (memory_mb != 0 and not 512 <= memory_mb <= 131072):
        raise ValueError("invalid AI resource limits")
    memory_job = apply_memory_limit(memory_mb)
    handles = []
    if os.name == "nt":
        for folder in (root / "_internal", *(root / "_internal").glob("*.libs"), root / "_internal/onnxruntime/capi"):
            if folder.is_dir():
                handles.append(os.add_dll_directory(str(folder)))
    global np, WINDOW
    import numpy as np
    WINDOW = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(FFT) / FFT)).astype(np.float32)
    import json
    import hashlib
    if os.environ.get("RUSTMUSIC_AI_MODEL_FILE"):
        selected_model = os.environ["RUSTMUSIC_AI_MODEL_FILE"]
        architecture = os.environ.get("RUSTMUSIC_AI_ARCHITECTURE")
        expected_hash = os.environ.get("RUSTMUSIC_AI_MODEL_SHA256")
        if architecture not in ("mdx-hq3", "mdx-karaoke", "bs-roformer-resurrection"):
            raise ValueError("unsupported model architecture")
    else:
        marker = json.loads((root / "runtime.json").read_text(encoding="utf-8-sig"))
        selected_model = {"lite": MODEL, "pro": PRO_MODEL}.get(marker.get("edition"))
        if not selected_model or marker.get("model") != selected_model:
            raise ValueError("AI edition does not match its model")
        architecture = "bs-roformer-resurrection" if selected_model == PRO_MODEL else "mdx-hq3"
        expected_hash = marker.get("model_sha256")
    model = model_dir / selected_model
    if not source.is_file() or not model.is_file():
        raise FileNotFoundError("input audio or selected model is missing")
    with model.open("rb") as model_file:
        model_hash = hashlib.file_digest(model_file, "sha256").hexdigest()
    if model_hash != expected_hash:
        raise ValueError("AI model checksum mismatch")
    mix, output_subtype = load_audio(source, root)
    output_subtype = os.environ.get("RUSTMUSIC_AI_OUTPUT_SUBTYPE", output_subtype)
    if output_subtype not in ("PCM_16", "PCM_24", "PCM_32"):
        raise ValueError("invalid output bit depth")
    mix = normalize(mix)
    session = create_session(model, mode)
    def separate():
        # Karaoke predicts accompaniment; vocals are the mixture residual.
        if architecture == "bs-roformer-resurrection":
            instrumental = resurrection_demix(mix, session)
            return instrumental, mix - instrumental
        if architecture == "mdx-karaoke":
            target = demix(mix, session, architecture)
            return split_karaoke_target(mix, target)
        instrumental = demix(mix, session)
        return instrumental, mix - instrumental * MDX_CONFIGS[architecture][4]
    retry_cpu = False
    try:
        instrumental, vocals = separate()
    except Exception:
        if session.get_providers()[0] == "CPUExecutionProvider":
            raise
        print("GPU inference failed; retrying with CPU", file=sys.stderr, flush=True)
        retry_cpu = True
        session = None
    if retry_cpu:
        # Leave the exception traceback and drop GPU allocations before retry.
        import gc
        gc.collect()
        session = create_session(model, "CPU")
        instrumental, vocals = separate()
    tracks = [(target, instrumental)]
    if len(sys.argv) == 6:
        tracks.append((Path(sys.argv[5]).resolve(), vocals))
    import soundfile as sf
    staged = []
    try:
        for destination, audio in tracks:
            if not np.isfinite(audio).all() or not np.any(audio):
                raise RuntimeError("output audio is silent or invalid")
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(destination.suffix + ".partial")
            staged.append((temporary, destination))
            pcm = normalize(audio).T
            sf.write(str(temporary), pcm, 44100, format="WAV", subtype=output_subtype)
        for temporary, destination in staged:
            temporary.replace(destination)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
    providers = session.get_providers()
    print(f"device={providers[0]}; providers={providers}; model={selected_model}; output={target}", flush=True)


if __name__ == "__main__":
    main()
