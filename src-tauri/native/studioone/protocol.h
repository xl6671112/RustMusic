#pragma once
#include <cstdint>

constexpr uint32_t SO_MAGIC = 0x534F4354;
constexpr uint32_t SO_VERSION = 3;
constexpr uint32_t SO_CHANNELS = 64;
constexpr uint32_t SO_READ = 1;
constexpr uint32_t SO_WRITE_VOLUME = 2;
constexpr uint32_t SO_WRITE_MONITOR = 3;
constexpr uint32_t SO_WRITE_PLUGIN_ENABLED = 4;
constexpr uint32_t SO_DISCONNECT = 5;
constexpr uint32_t SO_WRITE_MUTE = 6;
constexpr uint32_t SO_WRITE_SOLO = 7;
struct SoHost { uint32_t pid, thread; char name[96], title[256]; };
struct SoChannel {
    uint64_t token;
    uint32_t flags, bypass_id;
    int32_t type, index, mute, solo, monitor;
    double volume, max_volume, pan, bypass_value;
    char id[128], name[128], plugin[128];
};
struct SoReply {
    uint32_t status, channel_count;
    char error[256];
    SoChannel channels[SO_CHANNELS];
};
struct SoShared {
    uint32_t magic, version;
    volatile long request, response;
    uint32_t operation, controller_pid;
    uint64_t token;
    double value;
    SoReply reply;
};
