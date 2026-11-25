#pragma once
#include <windows.h>

inline bool studio_one_connection_alive(HANDLE process, HANDLE thread) {
    return process && thread &&
        WaitForSingleObject(process, 0) == WAIT_TIMEOUT &&
        WaitForSingleObject(thread, 0) == WAIT_TIMEOUT;
}
