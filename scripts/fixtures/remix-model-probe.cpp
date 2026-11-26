// Reproduce missing Remix model dependencies in this process only.
#include <windows.h>
#include <MinHook.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

struct Effect {
    int32_t magic;
    intptr_t (*dispatch)(Effect*, int32_t, int32_t, intptr_t, void*, float);
    void* process;
    void (*set)(Effect*, int32_t, float);
    float (*get)(Effect*, int32_t);
    int32_t programs, params, inputs, outputs, flags;
    intptr_t reserved1, reserved2;
    int32_t latency, quality1, quality2;
    float ratio;
    void *object, *user;
    int32_t id, version;
    void (*replace)(Effect*, float**, float**, int32_t);
    void* double_replace;
    unsigned char future[56];
};

static decltype(&CreateFileW) original_create_file;
static bool deny_models;
static std::wstring model_directory;
static unsigned model_attempts;

static HANDLE WINAPI trace_file(LPCWSTR path, DWORD access, DWORD share,
    LPSECURITY_ATTRIBUTES security, DWORD creation, DWORD flags, HANDLE template_file) {
    const bool model = path && std::wstring(path).find(L".hance") != std::wstring::npos;
    if (model) {
        ++model_attempts;
        fwprintf(stderr, L"model_read=%ls denied=%d\n", path, deny_models);
        if (deny_models) {
            SetLastError(ERROR_FILE_NOT_FOUND);
            return INVALID_HANDLE_VALUE;
        }
        if (!model_directory.empty()) {
            const auto name = std::wstring(path).substr(std::wstring(path).find_last_of(L"/\\") + 1);
            const auto redirected = model_directory + L"\\" + name;
            return original_create_file(redirected.c_str(), access, share, security, creation, flags, template_file);
        }
    }
    return original_create_file(path, access, share, security, creation, flags, template_file);
}

static intptr_t callback(Effect* effect, int32_t op, int32_t, intptr_t, void*, float) {
    switch (op) {
    case 1: return 2400;
    case 16: return effect ? reinterpret_cast<intptr_t>(effect->user) : 44100;
    case 17: return 1024;
    case 32: case 37: return 1;
    default: return 0;
    }
}

static std::vector<float> render(HMODULE library, float amount) {
    using Entry = Effect* (*)(decltype(&callback));
    auto entry = reinterpret_cast<Entry>(GetProcAddress(library, "VSTPluginMain"));
    if (!entry) throw "VSTPluginMain missing";
    auto effect = entry(callback);
    if (!effect || effect->magic != 0x56737450 || effect->inputs != 2 ||
        effect->outputs < 2 || effect->outputs > 12 || effect->params < 15 ||
        !effect->set || !effect->get || !effect->replace || !effect->dispatch)
        throw "Unsupported VST layout";
    effect->user = reinterpret_cast<void*>(44100);
    effect->dispatch(effect, 0, 0, 0, nullptr, 0);
    effect->dispatch(effect, 10, 0, 0, nullptr, 44100);
    effect->dispatch(effect, 11, 0, 1024, nullptr, 0);
    for (int i = 0; i < 5; ++i) effect->set(effect, i, .8f);
    for (int i = 5; i < 15; ++i) effect->set(effect, i, 0);
    effect->dispatch(effect, 12, 0, 1, nullptr, 0);
    effect->dispatch(effect, 71, 0, 0, nullptr, 0);
    effect->set(effect, 0, .8f * (1 - amount));
    effect->set(effect, 5, amount == 1 ? 1.f : 0.f);
    printf("strength=%.0f gain=%.6f mute=%.6f latency=%d\n", amount * 100,
        effect->get(effect, 0), effect->get(effect, 5), effect->latency);
    std::array<std::array<float, 1024>, 2> input{};
    std::array<std::array<float, 1024>, 12> output{};
    float* ins[] = {input[0].data(), input[1].data()};
    float* outs[12];
    for (int i = 0; i < 12; ++i) outs[i] = output[i].data();
    std::vector<float> result;
    for (int offset = 0; offset < 44100 * 6; offset += 64) {
        for (int i = 0; i < 64; ++i) {
            const double t = double(offset + i) / 44100;
            const float voice = float(std::sin(6.283185307 * 440 * t) * .25);
            const float music = float(std::sin(6.283185307 * 173 * t) * .2);
            input[0][i] = voice + music;
            input[1][i] = voice - music;
        }
        effect->replace(effect, ins, outs, 64);
        if (offset >= 44100 * 3) {
            for (int i = 0; i < 64; ++i) {
                result.push_back(output[0][i]);
                result.push_back(output[1][i]);
            }
        }
    }
    effect->dispatch(effect, 72, 0, 0, nullptr, 0);
    effect->dispatch(effect, 12, 0, 0, nullptr, 0);
    effect->dispatch(effect, 1, 0, 0, nullptr, 0);
    return result;
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 2 || argc > 4 || (argc == 3 && std::wstring(argv[2]) != L"--deny-models") ||
        (argc == 4 && std::wstring(argv[2]) != L"--models-dir")) {
        fprintf(stderr, "Usage: remix-model-probe.exe <absolute Remix.dll path> [--deny-models | --models-dir directory]\n");
        return 2;
    }
    deny_models = argc == 3;
    if (argc == 4) model_directory = argv[3];
    if (MH_Initialize() != MH_OK || MH_CreateHookApi(L"kernel32", "CreateFileW",
        reinterpret_cast<void*>(trace_file), reinterpret_cast<void**>(&original_create_file)) != MH_OK ||
        MH_EnableHook(MH_ALL_HOOKS) != MH_OK) {
        fprintf(stderr, "Unable to trace model reads\n");
        return 3;
    }
    const auto library = LoadLibraryW(argv[1]);
    int status = 0;
    if (!library) {
        fprintf(stderr, "DLL load failed: Windows error %lu\n", GetLastError());
        status = 4;
    } else {
        try {
            auto dry = render(library, 0), wet = render(library, 1);
            if (dry.size() != wet.size() || dry.empty()) throw "Invalid output length";
            double delta = 0, energy = 0;
            for (size_t i = 0; i < dry.size(); ++i) {
                if (!std::isfinite(dry[i]) || !std::isfinite(wet[i])) throw "Invalid audio sample";
                delta += std::abs(double(dry[i]) - wet[i]);
                energy += double(wet[i]) * wet[i];
            }
            printf("model_attempts=%u denied=%d mean_change=%.9f wet_rms=%.9f\n",
                model_attempts, deny_models, delta / dry.size(), std::sqrt(energy / wet.size()));
            puts("This synthetic test measures processing changes, not audible vocal-removal quality.");
        } catch (const char* error) {
            fprintf(stderr, "%s\n", error);
            status = 5;
        }
        FreeLibrary(library);
    }
    MH_Uninitialize();
    return status;
}
