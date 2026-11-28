#define NOMINMAX
#include <windows.h>
#include <onnxruntime_c_api.h>
#include <dml_provider_factory.h>
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

struct AiSession {
    HMODULE runtime = nullptr;
    HMODULE directml = nullptr;
    const OrtApi* api = nullptr;
    OrtEnv* env = nullptr;
    OrtSessionOptions* options = nullptr;
    OrtSession* session = nullptr;
    OrtMemoryInfo* memory = nullptr;
    OrtAllocator* allocator = nullptr;
    std::string input_name;
    std::string output_name;
    bool gpu = false;
};

static void set_error(char* buffer, size_t capacity, const char* text) {
    if (!buffer || capacity == 0) return;
    strncpy_s(buffer, capacity, text ? text : "Unknown inference error", _TRUNCATE);
}

static void set_load_error(char* buffer, size_t capacity, const wchar_t* path, DWORD code) {
    const std::string message = "Could not load " + std::filesystem::path(path).u8string()
        + " (Windows error " + std::to_string(code) + ")";
    set_error(buffer, capacity, message.c_str());
}

static bool check_status(AiSession* state, OrtStatus* status, char* error, size_t capacity) {
    if (!status) return true;
    set_error(error, capacity, state && state->api ? state->api->GetErrorMessage(status) : "ONNX Runtime error");
    if (state && state->api) state->api->ReleaseStatus(status);
    return false;
}

extern "C" __declspec(dllexport) int __cdecl rm_ai_create(
    const wchar_t* runtime_path, const wchar_t* model_path, int use_gpu, int threads,
    void** output, int* actual_gpu, char* error, size_t error_capacity) {
    if (!runtime_path || !model_path || !output) {
        set_error(error, error_capacity, "Runtime, model, and output are required");
        return 0;
    }
    *output = nullptr;
    AiSession* state = new AiSession();
    auto fail = [&]() {
        if (state->session && state->api) state->api->ReleaseSession(state->session);
        if (state->memory && state->api) state->api->ReleaseMemoryInfo(state->memory);
        if (state->options && state->api) state->api->ReleaseSessionOptions(state->options);
        if (state->env && state->api) state->api->ReleaseEnv(state->env);
        if (state->runtime) FreeLibrary(state->runtime);
        if (state->directml) FreeLibrary(state->directml);
        delete state;
        return 0;
    };
    const DWORD load_flags = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS;
    state->runtime = LoadLibraryExW(runtime_path, nullptr, load_flags);
    if (!state->runtime) {
        set_load_error(error, error_capacity, runtime_path, GetLastError());
        return fail();
    }
    using GetApiBase = const OrtApiBase*(ORT_API_CALL*)();
    auto get_api_base = reinterpret_cast<GetApiBase>(GetProcAddress(state->runtime, "OrtGetApiBase"));
    if (!get_api_base) {
        set_error(error, error_capacity, "onnxruntime.dll is missing OrtGetApiBase");
        return fail();
    }
    const OrtApiBase* base = get_api_base();
    state->api = base ? base->GetApi(ORT_API_VERSION) : nullptr;
    if (!state->api) {
        set_error(error, error_capacity, "ONNX Runtime C API version mismatch");
        return fail();
    }
    if (!check_status(state, state->api->CreateEnv(ORT_LOGGING_LEVEL_ERROR, "RustMusic", &state->env), error, error_capacity)
        || !check_status(state, state->api->CreateSessionOptions(&state->options), error, error_capacity)
        || !check_status(state, state->api->SetSessionGraphOptimizationLevel(state->options, ORT_ENABLE_ALL), error, error_capacity)
        || !check_status(state, state->api->SetIntraOpNumThreads(state->options, std::max(1, threads)), error, error_capacity)) {
        return fail();
    }
    if (use_gpu) {
        using AppendDml = OrtStatus*(ORT_API_CALL*)(OrtSessionOptions*, int);
        auto append_dml = reinterpret_cast<AppendDml>(GetProcAddress(state->runtime, "OrtSessionOptionsAppendExecutionProvider_DML"));
        if (append_dml) {
            // DirectML is delay-loaded; keep its packaged copy loaded for the session.
            const auto directml_path = std::filesystem::path(runtime_path).parent_path() / L"DirectML.dll";
            state->directml = LoadLibraryExW(directml_path.c_str(), nullptr, load_flags);
            if (!state->directml) {
                set_load_error(error, error_capacity, directml_path.c_str(), GetLastError());
                return fail();
            }
            if (!check_status(state, state->api->SetSessionExecutionMode(state->options, ORT_SEQUENTIAL), error, error_capacity)
                || !check_status(state, state->api->DisableMemPattern(state->options), error, error_capacity)
                || !check_status(state, append_dml(state->options, 0), error, error_capacity)) {
                return fail();
            }
            state->gpu = true;
        }
    }
    if (!check_status(state, state->api->CreateSession(state->env, model_path, state->options, &state->session), error, error_capacity)
        || !check_status(state, state->api->GetAllocatorWithDefaultOptions(&state->allocator), error, error_capacity)
        || !check_status(state, state->api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &state->memory), error, error_capacity)) {
        return fail();
    }
    char* name = nullptr;
    if (!check_status(state, state->api->SessionGetInputName(state->session, 0, state->allocator, &name), error, error_capacity)) return fail();
    state->input_name = name;
    state->api->AllocatorFree(state->allocator, name);
    name = nullptr;
    if (!check_status(state, state->api->SessionGetOutputName(state->session, 0, state->allocator, &name), error, error_capacity)) return fail();
    state->output_name = name;
    state->api->AllocatorFree(state->allocator, name);
    if (actual_gpu) *actual_gpu = state->gpu ? 1 : 0;
    *output = state;
    return 1;
}

extern "C" __declspec(dllexport) int __cdecl rm_ai_run(
    void* handle, const float* input, size_t input_count, const int64_t* shape, size_t rank,
    float** output, size_t* output_count, int64_t** output_shape, size_t* output_rank,
    char* error, size_t error_capacity) {
    auto* state = static_cast<AiSession*>(handle);
    if (!state || !input || !shape || !rank || !output || !output_count || !output_shape || !output_rank) {
        set_error(error, error_capacity, "Invalid inference arguments");
        return 0;
    }
    *output = nullptr; *output_count = 0; *output_shape = nullptr; *output_rank = 0;
    OrtValue* input_value = nullptr;
    OrtValue* output_value = nullptr;
    const char* input_names[] = { state->input_name.c_str() };
    const char* output_names[] = { state->output_name.c_str() };
    bool ok = check_status(state, state->api->CreateTensorWithDataAsOrtValue(
        state->memory, const_cast<float*>(input), input_count * sizeof(float), shape, rank,
        ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &input_value), error, error_capacity);
    if (ok) {
        OrtValue* inputs[] = { input_value };
        OrtValue* outputs[] = { nullptr };
        ok = check_status(state, state->api->Run(state->session, nullptr, input_names, inputs, 1,
            output_names, 1, outputs), error, error_capacity);
        output_value = outputs[0];
    }
    if (ok && output_value) {
        OrtTensorTypeAndShapeInfo* info = nullptr;
        ok = check_status(state, state->api->GetTensorTypeAndShape(output_value, &info), error, error_capacity);
        size_t count = 0, dims = 0;
        if (ok) ok = check_status(state, state->api->GetTensorShapeElementCount(info, &count), error, error_capacity);
        if (ok) ok = check_status(state, state->api->GetDimensionsCount(info, &dims), error, error_capacity);
        if (ok && count > 0 && dims > 0 && count <= SIZE_MAX / sizeof(float)) {
            auto* shape_copy = static_cast<int64_t*>(malloc(dims * sizeof(int64_t)));
            auto* data_copy = static_cast<float*>(malloc(count * sizeof(float)));
            void* data = nullptr;
            if (!shape_copy || !data_copy) {
                free(shape_copy); free(data_copy);
                set_error(error, error_capacity, "Not enough memory for inference output");
                ok = false;
            } else {
                ok = check_status(state, state->api->GetDimensions(info, shape_copy, dims), error, error_capacity)
                    && check_status(state, state->api->GetTensorMutableData(output_value, &data), error, error_capacity);
                if (ok) {
                    memcpy(data_copy, data, count * sizeof(float));
                    *output = data_copy; *output_count = count; *output_shape = shape_copy; *output_rank = dims;
                } else {
                    free(shape_copy); free(data_copy);
                }
            }
        } else if (ok) {
            set_error(error, error_capacity, "ONNX model returned an invalid output tensor");
            ok = false;
        }
        if (info) state->api->ReleaseTensorTypeAndShapeInfo(info);
    }
    if (output_value) state->api->ReleaseValue(output_value);
    if (input_value) state->api->ReleaseValue(input_value);
    return ok ? 1 : 0;
}

extern "C" __declspec(dllexport) int __cdecl rm_ai_input_shape(
    void* handle, int64_t* shape, size_t capacity, size_t* rank, char* error, size_t error_capacity) {
    auto* state = static_cast<AiSession*>(handle);
    if (!state || !shape || !rank) {
        set_error(error, error_capacity, "Invalid input-shape arguments");
        return 0;
    }
    OrtTypeInfo* type_info = nullptr;
    if (!check_status(state, state->api->SessionGetInputTypeInfo(state->session, 0, &type_info), error, error_capacity)) return 0;
    const OrtTensorTypeAndShapeInfo* tensor_info = nullptr;
    bool ok = check_status(state, state->api->CastTypeInfoToTensorInfo(type_info, &tensor_info), error, error_capacity);
    size_t dimensions = 0;
    if (ok) ok = tensor_info && check_status(state, state->api->GetDimensionsCount(tensor_info, &dimensions), error, error_capacity);
    if (ok && dimensions <= capacity) {
        ok = check_status(state, state->api->GetDimensions(tensor_info, shape, dimensions), error, error_capacity);
        if (ok) *rank = dimensions;
    } else if (ok) {
        set_error(error, error_capacity, "Input tensor rank exceeds bridge capacity");
        ok = false;
    }
    state->api->ReleaseTypeInfo(type_info);
    return ok ? 1 : 0;
}

extern "C" __declspec(dllexport) void __cdecl rm_ai_free(void* buffer) { free(buffer); }

extern "C" __declspec(dllexport) void __cdecl rm_ai_destroy(void* handle) {
    auto* state = static_cast<AiSession*>(handle);
    if (!state) return;
    if (state->session) state->api->ReleaseSession(state->session);
    if (state->memory) state->api->ReleaseMemoryInfo(state->memory);
    if (state->options) state->api->ReleaseSessionOptions(state->options);
    if (state->env) state->api->ReleaseEnv(state->env);
    if (state->runtime) FreeLibrary(state->runtime);
    if (state->directml) FreeLibrary(state->directml);
    delete state;
}
