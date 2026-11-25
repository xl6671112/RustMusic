#define NOMINMAX
#include <windows.h>
#include <tlhelp32.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <vector>
#include "protocol.h"
#include "presonus_context.h"
#include "connection_lifetime.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
using namespace Steinberg;
using namespace Steinberg::Vst;

struct Insert {
    IEditController* controller = nullptr;
    IComponentHandler* handler = nullptr;
    uint64_t token = 0;
    uint32_t bypass_id = 0;
    bool has_bypass = false;
    bool bypass_checked = false;
    std::string name;
};
using Create = tresult (PLUGIN_API*)(IPluginFactory*, FIDString, FIDString, void**);
using Release = uint32 (PLUGIN_API*)(FUnknown*);
using SetHandler = tresult (PLUGIN_API*)(IEditController*, IComponentHandler*);
struct FactoryHook { Create original; };
struct LocalConnection { HANDLE mapping, process, thread; SoShared* shared; HHOOK hook; };

static HMODULE module_handle;
static std::recursive_mutex records_mutex;
static std::vector<Insert> inserts;
static std::map<void**, FactoryHook> factories;
static std::map<void**, Release> releases;
static std::map<void**, SetHandler> handlers;
static std::map<FUnknown*, IEditController*> owners;
static std::map<uint32_t, LocalConnection> connections;
static std::mutex connections_mutex;
static uint64_t next_token = 1;
static bool capture_active;
static thread_local SoShared* remote_shared;
static thread_local HANDLE remote_mapping;
static thread_local HANDLE owner_process;
static thread_local UINT_PTR timer_id;
static bool connection_targets_alive(HANDLE process, HANDLE thread) {
    return studio_one_connection_alive(process, thread);
}
static tresult PLUGIN_API create_instance(IPluginFactory*, FIDString, FIDString, void**);
static uint32 PLUGIN_API release_object(FUnknown*);
static tresult PLUGIN_API set_handler(IEditController*, IComponentHandler*);

static void copy_text(char* out, size_t size, const std::string& value) {
    if (!size) return;
    const auto count = (std::min)(size - 1, value.size());
    memcpy(out, value.data(), count);
    out[count] = 0;
}
static std::string utf8(const wchar_t* value) {
    if (!value) return {};
    int count = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
    if (count <= 1) return {};
    std::string result(count, 0);
    WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), count, nullptr, nullptr);
    result.resize(count - 1);
    return result;
}
static const char* studio_host_name(DWORD pid) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return nullptr;
    BOOL wow = FALSE;
    wchar_t path[32768]{};
    DWORD count = 32768;
    const bool valid = IsWow64Process(process, &wow) && !wow &&
        QueryFullProcessImageNameW(process, 0, path, &count);
    CloseHandle(process);
    if (!valid) return nullptr;
    std::wstring name(path, count);
    const auto split = name.find_last_of(L"\\/");
    if (split != std::wstring::npos) name.erase(0, split + 1);
    std::transform(name.begin(), name.end(), name.begin(), towlower);
    if (name == L"studio one.exe") return "Studio One";
    if (name == L"studio pro.exe") return "Studio Pro";
    return nullptr;
}
static bool studio_one_process(DWORD pid) {
    const auto* name = studio_host_name(pid);
    return name && strcmp(name, "Studio One") == 0;
}
static bool write_slot(void** table, size_t slot, void* replacement) {
    DWORD old = 0;
    if (!VirtualProtect(table + slot, sizeof(void*), PAGE_READWRITE, &old)) return false;
    InterlockedExchangePointer(table + slot, replacement);
    DWORD ignored = 0;
    VirtualProtect(table + slot, sizeof(void*), old, &ignored);
    return true;
}
static void restore_slot(void** table, size_t slot, void* hooked, void* original) {
    MEMORY_BASIC_INFORMATION info{};
    if (!table || !VirtualQuery(table + slot, &info, sizeof(info)) ||
        info.State != MEM_COMMIT || (info.Protect & (PAGE_NOACCESS | PAGE_GUARD))) return;
    if (table[slot] == hooked) write_slot(table, slot, original);
}
static void stop_capture() {
    std::lock_guard<std::recursive_mutex> guard(records_mutex);
    capture_active = false;
    for (const auto& [table, hook] : factories)
        restore_slot(table, 6, reinterpret_cast<void*>(create_instance), reinterpret_cast<void*>(hook.original));
    for (const auto& [table, original] : releases)
        restore_slot(table, 2, reinterpret_cast<void*>(release_object), reinterpret_cast<void*>(original));
    for (const auto& [table, original] : handlers)
        restore_slot(table, 16, reinterpret_cast<void*>(set_handler), reinterpret_cast<void*>(original));
    for (const auto& item : inserts) if (item.handler) item.handler->release();
    inserts.clear();
    owners.clear();
}
static uint32 PLUGIN_API release_object(FUnknown* object) {
    std::lock_guard<std::recursive_mutex> guard(records_mutex);
    auto table = *reinterpret_cast<void***>(object);
    auto found_original = releases.find(table);
    if (found_original == releases.end()) return 0;
    auto original = found_original->second;
    const auto remaining = original(object);
    auto owner = owners.find(object);
    auto controller = owner == owners.end() ? nullptr : owner->second;
    auto found = std::find_if(inserts.begin(), inserts.end(),
        [controller](const Insert& value) { return value.controller == controller; });
    if (remaining == 0 && found != inserts.end()) {
        auto handler = found->handler;
        inserts.erase(found);
        for (auto it = owners.begin(); it != owners.end();) {
            if (it->second == controller) it = owners.erase(it);
            else ++it;
        }
        if (handler) handler->release();
    }
    return remaining;
}
static tresult PLUGIN_API set_handler(IEditController* controller, IComponentHandler* handler) {
    std::lock_guard<std::recursive_mutex> guard(records_mutex);
    auto original = handlers.at(*reinterpret_cast<void***>(controller));
    const auto result = original(controller, handler);
    if (result == kResultOk) {
        for (auto& item : inserts) if (item.controller == controller) {
            if (handler) handler->addRef();
            auto old = item.handler;
            item.handler = handler;
            item.bypass_checked = false;
            if (old) old->release();
        }
    }
    return result;
}
static void capture_controller(IEditController* controller, const std::string& name) {
    if (!controller) return;
    std::lock_guard<std::recursive_mutex> guard(records_mutex);
    if (!capture_active) return;
    if (std::any_of(inserts.begin(), inserts.end(), [controller](const Insert& item) {
        return item.controller == controller;
    })) return;
    auto table = *reinterpret_cast<void***>(controller);
    bool ready = true;
    if (table[2] != reinterpret_cast<void*>(release_object)) {
        releases[table] = reinterpret_cast<Release>(table[2]);
        if (!write_slot(table, 2, reinterpret_cast<void*>(release_object))) {
            releases.erase(table);
            ready = false;
        }
    }
    if (ready && table[16] != reinterpret_cast<void*>(set_handler)) {
        handlers[table] = reinterpret_cast<SetHandler>(table[16]);
        if (!write_slot(table, 16, reinterpret_cast<void*>(set_handler))) {
            handlers.erase(table);
            ready = false;
        }
    }
    if (!ready) return;
    Insert item;
    item.controller = controller;
    item.token = next_token++;
    item.name = name;
    inserts.push_back(std::move(item));
    owners[reinterpret_cast<FUnknown*>(controller)] = controller;
}
static std::string plugin_name(IPluginFactory* factory, FIDString cid) {
    if (!factory || !cid) return "VST3 插件";
    for (int32 index = 0; index < factory->countClasses(); ++index) {
        PClassInfo info{};
        if (factory->getClassInfo(index, &info) == kResultOk &&
            std::memcmp(info.cid, cid, sizeof(TUID)) == 0 && info.name[0]) {
            return reinterpret_cast<const char*>(info.name);
        }
    }
    return "VST3 插件";
}
static tresult PLUGIN_API create_instance(IPluginFactory* factory, FIDString cid,
    FIDString iid, void** output) {
    Create original = nullptr;
    bool capture = false;
    {
        std::lock_guard<std::recursive_mutex> guard(records_mutex);
        auto found = factories.find(*reinterpret_cast<void***>(factory));
        if (found == factories.end()) return kResultFalse;
        original = found->second.original;
        capture = capture_active;
    }
    const auto result = original(factory, cid, iid, output);
    if (!capture || result != kResultOk || !output || !*output) return result;
    auto primary = reinterpret_cast<FUnknown*>(*output);
    IEditController* controller = nullptr;
    if (primary->queryInterface(INLINE_UID_OF(IEditController),
        reinterpret_cast<void**>(&controller)) == kResultOk && controller) {
        capture_controller(controller, plugin_name(factory, cid));
        controller->release();
    }
    return result;
}
static void scan_factories() {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
    if (snapshot == INVALID_HANDLE_VALUE) return;
    MODULEENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Module32FirstW(snapshot, &entry)) do {
        auto factory_fn = reinterpret_cast<IPluginFactory* (*)()>(
            GetProcAddress(entry.hModule, "GetPluginFactory"));
        if (!factory_fn) continue;
        auto factory = factory_fn();
        if (!factory) continue;
        auto table = *reinterpret_cast<void***>(factory);
        {
            std::lock_guard<std::recursive_mutex> guard(records_mutex);
            if (table[6] != reinterpret_cast<void*>(create_instance)) {
                auto original = reinterpret_cast<Create>(table[6]);
                factories[table] = {original};
                if (!write_slot(table, 6, reinterpret_cast<void*>(create_instance)))
                    factories.erase(table);
            }
        }
        factory->release();
    } while (Module32NextW(snapshot, &entry));
    CloseHandle(snapshot);
}
static bool context_int(Presonus::IContextInfoProvider2* provider, const char* id, int32& value) {
    const auto result = provider->getContextInfoValue(value, id);
    return result == kResultOk || result == kResultTrue;
}
static bool set_context_switch(Presonus::IContextInfoProvider2* provider, const char* key, int32 value) {
    int32 current = 0;
    if (!context_int(provider, key, current)) return false;
    return provider->setContextInfoValue(key, value) == kResultOk &&
        context_int(provider, key, current) && current == value;
}
static bool context_double(Presonus::IContextInfoProvider2* provider, const char* id, double& value) {
    const auto result = provider->getContextInfoValue(value, id);
    return (result == kResultOk || result == kResultTrue) && std::isfinite(value);
}
static bool context_string(Presonus::IContextInfoProvider2* provider, const char* id, char* output, size_t size) {
    String128 value{};
    const auto result = provider->getContextInfoString(value, 128, id);
    if (result != kResultOk && result != kResultTrue) return false;
    copy_text(output, size, utf8(reinterpret_cast<wchar_t*>(value)));
    return true;
}
static bool read_insert(Insert& item, SoChannel& channel) {
    channel = {};
    channel.token = item.token;
    copy_text(channel.plugin, sizeof(channel.plugin), item.name);
    channel.flags |= 2048;
    if (item.handler) {
        if (!item.bypass_checked) {
            item.bypass_checked = true;
            item.has_bypass = false;
            const auto count = item.controller->getParameterCount();
            for (int index = 0; index < count; ++index) {
                ParameterInfo info{};
                if (item.controller->getParameterInfo(index, info) == kResultOk &&
                    (info.flags & ParameterInfo::kIsBypass)) {
                    item.bypass_id = info.id;
                    item.has_bypass = true;
                    break;
                }
            }
        }
        Presonus::IContextInfoProvider2* provider = nullptr;
        if (item.handler->queryInterface(Presonus::IContextInfoProvider2_iid,
            reinterpret_cast<void**>(&provider)) == kResultOk && provider) {
            if (context_string(provider, Presonus::ContextInfo::kId, channel.id, sizeof(channel.id))) channel.flags |= 1;
            if (context_string(provider, Presonus::ContextInfo::kName, channel.name, sizeof(channel.name))) channel.flags |= 2;
            if (context_int(provider, Presonus::ContextInfo::kType, channel.type)) channel.flags |= 4;
            if (context_int(provider, Presonus::ContextInfo::kIndex, channel.index)) channel.flags |= 8;
            if (context_double(provider, Presonus::ContextInfo::kVolume, channel.volume)) channel.flags |= 16;
            if (context_double(provider, Presonus::ContextInfo::kMaxVolume, channel.max_volume)) channel.flags |= 32;
            if (context_double(provider, Presonus::ContextInfo::kPan, channel.pan)) channel.flags |= 64;
            if (context_int(provider, Presonus::ContextInfo::kMute, channel.mute)) channel.flags |= 128;
            if (context_int(provider, Presonus::ContextInfo::kSolo, channel.solo)) channel.flags |= 256;
            if (context_int(provider, "monitorActive", channel.monitor) ||
                context_int(provider, "monitor", channel.monitor)) channel.flags |= 512;
            provider->release();
        }
    }
    channel.bypass_id = item.bypass_id;
    if (item.has_bypass && item.handler) {
        channel.bypass_value = item.controller->getParamNormalized(item.bypass_id);
        if (std::isfinite(channel.bypass_value)) channel.flags |= 1024;
    }
    return true;
}
static void read_all(SoReply& reply) {
    reply = {};
    std::lock_guard<std::recursive_mutex> guard(records_mutex);
    for (auto& item : inserts) {
        if (reply.channel_count == SO_CHANNELS) break;
        SoChannel channel{};
        if (read_insert(item, channel)) reply.channels[reply.channel_count++] = channel;
    }
}
static void execute(SoShared& shared) {
    auto& reply = shared.reply;
    read_all(reply);
    if (shared.operation == SO_READ) return;
    std::lock_guard<std::recursive_mutex> guard(records_mutex);
    auto item = std::find_if(inserts.begin(), inserts.end(),
        [&shared](const Insert& value) { return value.token == shared.token; });
    if (item == inserts.end()) {
        reply.status = 1;
        copy_text(reply.error, sizeof(reply.error), "目标轨道或插件已关闭");
        return;
    }
    bool written = false;
    if (shared.operation == SO_WRITE_VOLUME && item->handler) {
        Presonus::IContextInfoProvider2* provider = nullptr;
        if (item->handler->queryInterface(Presonus::IContextInfoProvider2_iid,
            reinterpret_cast<void**>(&provider)) == kResultOk && provider) {
            double maximum = 1.0;
            context_double(provider, Presonus::ContextInfo::kMaxVolume, maximum);
            written = std::isfinite(shared.value) && shared.value >= 0 &&
                shared.value <= maximum &&
                provider->setContextInfoValue(Presonus::ContextInfo::kVolume, shared.value) == kResultOk;
            provider->release();
        }
    } else if (shared.operation == SO_WRITE_MONITOR && item->handler &&
        (shared.value == 0 || shared.value == 1)) {
        Presonus::IContextInfoProvider2* provider = nullptr;
        if (item->handler->queryInterface(Presonus::IContextInfoProvider2_iid,
            reinterpret_cast<void**>(&provider)) == kResultOk && provider) {
            int32 current = 0;
            const char* key = context_int(provider, "monitorActive", current) ? "monitorActive" : "monitor";
            written = set_context_switch(provider, key, static_cast<int32>(shared.value));
            provider->release();
        }
    } else if (shared.operation == SO_WRITE_PLUGIN_ENABLED && item->has_bypass &&
        item->handler && (shared.value == 0 || shared.value == 1)) {
        const double bypass = shared.value == 1 ? 0.0 : 1.0;
        written = item->handler->beginEdit(item->bypass_id) == kResultOk;
        if (written) {
            const auto set = item->controller->setParamNormalized(item->bypass_id, bypass);
            const auto edit = set == kResultOk ? item->handler->performEdit(item->bypass_id, bypass) : kResultFalse;
            const auto end = item->handler->endEdit(item->bypass_id);
            written = set == kResultOk && edit == kResultOk && end == kResultOk &&
                std::abs(item->controller->getParamNormalized(item->bypass_id) - bypass) < 1e-5;
        }
    } else if ((shared.operation == SO_WRITE_MUTE || shared.operation == SO_WRITE_SOLO) &&
        item->handler && (shared.value == 0 || shared.value == 1)) {
        Presonus::IContextInfoProvider2* provider = nullptr;
        if (item->handler->queryInterface(Presonus::IContextInfoProvider2_iid,
            reinterpret_cast<void**>(&provider)) == kResultOk && provider) {
            const auto key = shared.operation == SO_WRITE_MUTE
                ? Presonus::ContextInfo::kMute : Presonus::ContextInfo::kSolo;
            written = set_context_switch(provider, key, static_cast<int32>(shared.value));
            provider->release();
        }
    }
    if (!written) {
        reply.status = 1;
        copy_text(reply.error, sizeof(reply.error), "Studio One 未确认控制生效");
    } else read_all(reply);
}
static void CALLBACK tick(HWND, UINT, UINT_PTR id, DWORD) {
    if (!remote_shared) return;
    if (!owner_process && remote_shared->controller_pid)
        owner_process = OpenProcess(SYNCHRONIZE, FALSE, remote_shared->controller_pid);
    if (owner_process && WaitForSingleObject(owner_process, 0) == WAIT_OBJECT_0) {
        stop_capture();
        auto shared = remote_shared;
        auto mapping = remote_mapping;
        remote_shared = nullptr;
        remote_mapping = nullptr;
        timer_id = 0;
        KillTimer(nullptr, id);
        UnmapViewOfFile(shared);
        CloseHandle(mapping);
        CloseHandle(owner_process);
        owner_process = nullptr;
        return;
    }
    static ULONGLONG last_scan = 0;
    if (GetTickCount64() - last_scan > 1500) {
        scan_factories();
        last_scan = GetTickCount64();
    }
    auto shared = remote_shared;
    const LONG request = InterlockedCompareExchange(&shared->request, 0, 0);
    if (request != InterlockedCompareExchange(&shared->response, 0, 0) &&
        shared->magic == SO_MAGIC && shared->version == SO_VERSION) {
        if (shared->operation == SO_DISCONNECT) {
            stop_capture();
            InterlockedExchange(&shared->response, request);
            const auto mapping = remote_mapping;
            remote_shared = nullptr;
            remote_mapping = nullptr;
            timer_id = 0;
            KillTimer(nullptr, id);
            UnmapViewOfFile(shared);
            if (mapping) CloseHandle(mapping);
            if (owner_process) CloseHandle(owner_process);
            owner_process = nullptr;
            return;
        }
        execute(*shared);
        InterlockedExchange(&shared->response, request);
    }
}
static LRESULT CALLBACK on_message(int code, WPARAM wparam, LPARAM lparam) {
    if (code >= 0 && !remote_shared) {
        wchar_t name[96]{};
        swprintf_s(name, L"Local\\RustMusicStudioOneControl-v3-%lu", GetCurrentProcessId());
        HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
        if (mapping) {
            auto shared = static_cast<SoShared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SoShared)));
            if (shared) {
                remote_shared = shared;
                remote_mapping = mapping;
                owner_process = OpenProcess(SYNCHRONIZE, FALSE, shared->controller_pid);
                timer_id = SetTimer(nullptr, 0, 100, tick);
                if (timer_id) {
                    {
                        std::lock_guard<std::recursive_mutex> guard(records_mutex);
                        capture_active = true;
                    }
                    HMODULE pinned = nullptr;
                    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                        reinterpret_cast<LPCWSTR>(&on_message), &pinned);
                } else {
                    remote_shared = nullptr;
                    remote_mapping = nullptr;
                    if (owner_process) CloseHandle(owner_process);
                    owner_process = nullptr;
                    UnmapViewOfFile(shared);
                    CloseHandle(mapping);
                }
            } else CloseHandle(mapping);
        }
    }
    return CallNextHookEx(nullptr, code, wparam, lparam);
}
static bool exchange(LocalConnection& connection, uint32_t operation, uint64_t token,
    double value, SoReply* reply) {
    auto shared = connection.shared;
    if (InterlockedCompareExchange(&shared->request, 0, 0) !=
        InterlockedCompareExchange(&shared->response, 0, 0)) return false;
    shared->operation = operation;
    shared->token = token;
    shared->value = value;
    const LONG sequence = InterlockedIncrement(&shared->request);
    for (int attempt = 0; attempt < 150; ++attempt) {
        if (InterlockedCompareExchange(&shared->response, 0, 0) == sequence) {
            if (reply) memcpy(reply, &shared->reply, sizeof(*reply));
            return true;
        }
        Sleep(10);
    }
    return false;
}
static bool close_connection(LocalConnection& connection) {
    if (connection.shared && connection_targets_alive(connection.process, connection.thread)) {
        SoReply ignored{};
        if (!exchange(connection, SO_DISCONNECT, 0, 0, &ignored)) return false;
    }
    if (connection.shared) UnmapViewOfFile(connection.shared);
    if (connection.hook) UnhookWindowsHookEx(connection.hook);
    if (connection.mapping) CloseHandle(connection.mapping);
    if (connection.thread) CloseHandle(connection.thread);
    if (connection.process) CloseHandle(connection.process);
    connection = {};
    return true;
}
static void prune_connections() {
    for (auto it = connections.begin(); it != connections.end();) {
        if (connection_targets_alive(it->second.process, it->second.thread)) ++it;
        else {
            close_connection(it->second);
            it = connections.erase(it);
        }
    }
}
extern "C" __declspec(dllexport) uint32_t so_hosts(SoHost* output, uint32_t capacity) {
    std::lock_guard<std::mutex> guard(connections_mutex);
    prune_connections();
    struct Result { SoHost* output; uint32_t capacity, count; } result{output, capacity, 0};
    EnumWindows([](HWND window, LPARAM raw) -> BOOL {
        auto& result = *reinterpret_cast<Result*>(raw);
        if (!IsWindowVisible(window) || GetWindowTextLengthW(window) == 0 ||
            result.count >= result.capacity) return TRUE;
        DWORD pid = 0;
        const DWORD thread = GetWindowThreadProcessId(window, &pid);
        const auto* name = studio_host_name(pid);
        if (!name) return TRUE;
        for (uint32_t n = 0; n < result.count; ++n) if (result.output[n].pid == pid) return TRUE;
        auto& host = result.output[result.count++];
        host.pid = pid; host.thread = thread;
        wchar_t title[256]{};
        GetWindowTextW(window, title, 256);
        copy_text(host.title, sizeof(host.title), utf8(title));
        copy_text(host.name, sizeof(host.name), name);
        return TRUE;
    }, reinterpret_cast<LPARAM>(&result));
    return result.count;
}
extern "C" __declspec(dllexport) uint32_t so_connect(uint32_t pid, uint32_t thread) {
    std::lock_guard<std::mutex> guard(connections_mutex);
    if (!studio_one_process(pid)) return ERROR_NOT_SUPPORTED;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
    if (!process) return GetLastError();
    HANDLE target = OpenThread(THREAD_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, thread);
    if (!target) { auto error = GetLastError(); CloseHandle(process); return error; }
    if (GetProcessIdOfThread(target) != pid || WaitForSingleObject(process, 0) != WAIT_TIMEOUT ||
        WaitForSingleObject(target, 0) != WAIT_TIMEOUT) {
        CloseHandle(target); CloseHandle(process); return ERROR_INVALID_PARAMETER;
    }
    auto found = connections.find(pid);
    if (found != connections.end()) {
        CloseHandle(target); CloseHandle(process);
        SoReply reply{};
        return exchange(found->second, SO_READ, 0, 0, &reply) ? 0 : ERROR_TIMEOUT;
    }
    wchar_t name[96]{};
    swprintf_s(name, L"Local\\RustMusicStudioOneControl-v3-%lu", pid);
    HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
        sizeof(SoShared), name);
    if (!mapping) { auto error = GetLastError(); CloseHandle(target); CloseHandle(process); return error; }
    auto shared = static_cast<SoShared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SoShared)));
    if (!shared) { auto error = GetLastError(); CloseHandle(mapping); CloseHandle(target); CloseHandle(process); return error; }
    if (shared->magic != SO_MAGIC || shared->version != SO_VERSION) {
        memset(shared, 0, sizeof(*shared)); shared->magic = SO_MAGIC; shared->version = SO_VERSION;
    }
    shared->controller_pid = GetCurrentProcessId();
    auto hook = SetWindowsHookExW(WH_GETMESSAGE, on_message, module_handle, thread);
    if (!hook || !PostThreadMessageW(thread, WM_NULL, 0, 0)) {
        const auto error = GetLastError();
        if (hook) UnhookWindowsHookEx(hook);
        UnmapViewOfFile(shared); CloseHandle(mapping); CloseHandle(target); CloseHandle(process);
        return error;
    }
    auto [inserted, _] = connections.emplace(pid, LocalConnection{mapping, process, target, shared, hook});
    SoReply reply{};
    if (exchange(inserted->second, SO_READ, 0, 0, &reply)) return 0;
    if (close_connection(inserted->second)) connections.erase(inserted);
    return ERROR_TIMEOUT;
}
extern "C" __declspec(dllexport) uint32_t so_exchange(uint32_t pid, uint32_t operation,
    uint64_t token, double value, SoReply* reply) {
    std::lock_guard<std::mutex> guard(connections_mutex);
    auto found = connections.find(pid);
    if (found == connections.end()) return ERROR_NOT_CONNECTED;
    if (!reply || (operation != SO_READ && operation != SO_WRITE_VOLUME &&
        operation != SO_WRITE_MONITOR && operation != SO_WRITE_PLUGIN_ENABLED &&
        operation != SO_WRITE_MUTE && operation != SO_WRITE_SOLO)) return ERROR_INVALID_PARAMETER;
    return exchange(found->second, operation, token, value, reply) ? 0 : ERROR_TIMEOUT;
}
extern "C" __declspec(dllexport) uint32_t so_disconnect(uint32_t pid) {
    std::lock_guard<std::mutex> guard(connections_mutex);
    auto found = connections.find(pid);
    if (found == connections.end()) return 0;
    if (!close_connection(found->second)) return ERROR_TIMEOUT;
    connections.erase(found);
    return 0;
}
extern "C" __declspec(dllexport) uint32_t so_disconnect_all() {
    std::lock_guard<std::mutex> guard(connections_mutex);
    uint32_t result = 0;
    for (auto it = connections.begin(); it != connections.end();) {
        if (close_connection(it->second)) it = connections.erase(it);
        else { result = ERROR_TIMEOUT; ++it; }
    }
    return result;
}
BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) { module_handle = instance; DisableThreadLibraryCalls(instance); }
    return TRUE;
}
