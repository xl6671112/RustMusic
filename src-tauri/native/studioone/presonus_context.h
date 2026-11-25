#pragma once

#include "pluginterfaces/vst/ivsteditcontroller.h"

namespace Presonus {
struct IContextInfoProvider : Steinberg::FUnknown {
    virtual Steinberg::tresult PLUGIN_API getContextInfoValue(
        Steinberg::int32& value, Steinberg::FIDString id) = 0;
    virtual Steinberg::tresult PLUGIN_API getContextInfoString(
        Steinberg::Vst::TChar* value, Steinberg::int32 max_chars, Steinberg::FIDString id) = 0;
};
DECLARE_CLASS_IID(IContextInfoProvider, 0x483e61ea, 0x17994494, 0x8199a35a, 0xebb35e3c)

struct IContextInfoProvider2 : IContextInfoProvider {
    using IContextInfoProvider::getContextInfoValue;
    virtual Steinberg::tresult PLUGIN_API getContextInfoValue(
        double& value, Steinberg::FIDString id) = 0;
    virtual Steinberg::tresult PLUGIN_API setContextInfoValue(
        Steinberg::FIDString id, double value) = 0;
    virtual Steinberg::tresult PLUGIN_API setContextInfoValue(
        Steinberg::FIDString id, Steinberg::int32 value) = 0;
    virtual Steinberg::tresult PLUGIN_API setContextInfoString(
        Steinberg::FIDString id, Steinberg::Vst::TChar* value) = 0;
};
DECLARE_CLASS_IID(IContextInfoProvider2, 0x61e45968, 0x3d364f39, 0xb15e1733, 0x4944172b)

namespace ContextInfo {
constexpr Steinberg::FIDString kId = "id";
constexpr Steinberg::FIDString kName = "name";
constexpr Steinberg::FIDString kType = "type";
constexpr Steinberg::FIDString kIndex = "index";
constexpr Steinberg::FIDString kVolume = "volume";
constexpr Steinberg::FIDString kMaxVolume = "maxVolume";
constexpr Steinberg::FIDString kPan = "pan";
constexpr Steinberg::FIDString kMute = "mute";
constexpr Steinberg::FIDString kSolo = "solo";
}
}
