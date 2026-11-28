local obs = obslua
local source_name = "Native lyric capture"
local scene_name = "Lyrics capture validation"
local expected_title = ""
local expected_exe = ""
local configured = false
local requested = false
local captures = 0
local started = 0
local activated_source = nil

local function screenshot_taken(event)
    if event ~= obs.OBS_FRONTEND_EVENT_SCREENSHOT_TAKEN or not requested then return end
    local path = obs.obs_frontend_get_last_screenshot()
    if not path or path == "" then return end
    local kind = captures < 3 and ("SOURCE_" .. tostring(captures + 1)) or "COMPOSITE"
    print("LYRICS_GAME_CAPTURE_" .. kind .. "=" .. path)
    captures = captures + 1
    requested = false
end

local function configure(source)
    local properties = obs.obs_source_properties(source)
    if not properties then return false end
    local windows = obs.obs_properties_get(properties, "window")
    local selection = nil
    if windows then
        for index = 0, obs.obs_property_list_item_count(windows) - 1 do
            local label = obs.obs_property_list_item_name(windows, index) or ""
            local value = obs.obs_property_list_item_string(windows, index) or ""
            if string.find(label, expected_title, 1, true)
                and string.find(string.lower(value), string.lower(expected_exe), 1, true) then
                print("LYRICS_GAME_CAPTURE_CANDIDATE=" .. value)
                selection = value
                local _, _, class = string.find(value, "^[^:]*:([^:]+):")
                if class and class ~= "" then break end
            end
        end
    end
    obs.obs_properties_destroy(properties)
    if not selection then return false end
    local settings = obs.obs_source_get_settings(source)
    obs.obs_data_set_string(settings, "capture_mode", "window")
    obs.obs_data_set_string(settings, "window", selection)
    obs.obs_data_set_int(settings, "priority", 1)
    obs.obs_data_set_bool(settings, "allow_transparency", true)
    obs.obs_data_set_bool(settings, "capture_cursor", false)
    obs.obs_data_set_bool(settings, "anti_cheat_hook", true)
    obs.obs_source_update(source, settings)
    obs.obs_data_release(settings)
    print("LYRICS_GAME_CAPTURE_WINDOW=" .. selection)
    return true
end

local function tick()
    if requested or captures >= 4 or os.time() - started < 3 then return end
    local source = obs.obs_get_source_by_name(source_name)
    if not source then return end
    if not activated_source then
        activated_source = source
        obs.obs_source_addref(activated_source)
        obs.obs_source_inc_showing(activated_source)
    end
    if not configured then configured = configure(source) end
    if not configured or obs.obs_source_get_width(source) == 0 or obs.obs_source_get_height(source) == 0 then
        obs.obs_source_release(source)
        return
    end
    if os.time() - started < 8 + captures * 3 then
        obs.obs_source_release(source)
        return
    end
    if captures == 3 then
        obs.obs_source_release(source)
        source = obs.obs_get_source_by_name(scene_name)
        if not source then return end
    end
    requested = true
    obs.obs_frontend_take_source_screenshot(source)
    obs.obs_source_release(source)
end

function script_description()
    return "Checks an isolated native Direct3D lyrics game-capture source without streaming or recording."
end

function script_load(settings)
    expected_title = obs.obs_data_get_string(settings, "window_title")
    expected_exe = obs.obs_data_get_string(settings, "window_exe")
    if not obs.obs_frontend_take_source_screenshot or not obs.obs_frontend_get_last_screenshot then
        print("LYRICS_GAME_CAPTURE_ERROR=screenshot API unavailable")
        return
    end
    started = os.time()
    obs.obs_frontend_add_event_callback(screenshot_taken)
    obs.timer_add(tick, 500)
    print("LYRICS_GAME_CAPTURE_READY")
end

function script_unload()
    obs.timer_remove(tick)
    obs.obs_frontend_remove_event_callback(screenshot_taken)
    if activated_source then
        obs.obs_source_dec_showing(activated_source)
        obs.obs_source_release(activated_source)
        activated_source = nil
    end
end
