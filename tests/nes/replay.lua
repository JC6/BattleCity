local machine = manager.machine
local ram = machine.devices[":maincpu"].spaces["program"]
local screen = machine.screens[":screen"]
local pads = {}
for tag, port in pairs(machine.ioport.ports) do
    for _, field in pairs(port.fields) do
        local player = tonumber(tag:match(":ctrl(%d)"))
        if player and field.mask == 1 and field.enabled and field.type_class == "controller" then
            pads[player] = field
        end
    end
end
assert(pads[1] and pads[2], "missing controller A buttons")
local cold = os.getenv("BATTLECITY_COLD_REPLAY") == "1"
local phase, tick = 0, 0
local trace = assert(io.open("probe.frames", cold and "rb" or "w+b"))
local first_pixels, varied
local preroll_frames = 3
local presentation_frame = 60
local function input(t)
    pads[1]:set_value(math.floor(t / 15) % 2)
    pads[2]:set_value(math.floor(t / 30) % 2)
end
local function step()
    if phase == 4 then return end
    tick = tick + 1
    if phase == 0 then
        if tick == presentation_frame - preroll_frames then
            if cold then
                machine:load("checkpoint")
                phase, tick = 2, -preroll_frames
                input(0)
                return
            end
            machine:save("checkpoint")
        end
        if tick == presentation_frame then
            phase, tick = 1, 0
            input(0)
        end
        return
    end
    -- Rebuild the video pipeline from the earlier checkpoint before presenting frame 1.
    if tick <= 0 then
        input(0)
        return
    end
    if phase == 3 then
        -- Follow a new input branch after restoring the same checkpoint.
        local original = assert(trace:read(#screen:pixels()))
        if tick == 12 then
            assert(screen:pixels() ~= original, "branch reproduced the abandoned picture")
        end
        if tick == 45 then
            assert(ram:read_u8(1) == 0 and ram:read_u8(2) == 1, "branch input mismatch")

            trace:close()
            phase = 4
            print("MAME_REPLAY_OK")
            machine:exit()
        else
            pads[1]:set_value(0)
            pads[2]:set_value(1)
        end
        return
    end
    if tick % 15 == 10 then
        assert(ram:read_u8(1) == math.floor((tick - 1) / 15) % 2, "player 1 mismatch")
        assert(ram:read_u8(2) == math.floor((tick - 1) / 30) % 2, "player 2 mismatch")
    end
    local pixels = screen:pixels()
    if phase == 1 then
        assert(trace:write(pixels))
        if first_pixels == nil then first_pixels = pixels end
        varied = varied or pixels ~= first_pixels
    else
        assert(trace:read(#pixels) == pixels, "video mismatch on frame " .. tick)
    end
    if tick == 120 then
        if phase == 2 then
            assert(trace:seek("set", 0))
            machine:load("checkpoint")
            phase, tick = 3, -preroll_frames
            input(0)
            return
        end
        assert(varied, "cartridge produced a static picture")
        assert(trace:seek("set", 0))
        machine:load("checkpoint")
        phase, tick = 2, -preroll_frames
        input(0)
        return
    end
    input(tick)
end
probe_subscription = emu.add_machine_frame_notifier(function()
    local ok, message = pcall(step)
    if not ok then
        print("MAME_REPLAY_FAILED", tick, message)
        machine:exit()
    end
end)
