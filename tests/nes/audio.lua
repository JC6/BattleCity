-- Hash actual NES sound-register writes against the independently decoded
-- classic reference traces used by the project's platform tests.
local labels = {}
for line in io.lines(assert(os.getenv("BATTLECITY_LABELS"))) do
    local hex, name = line:match("^al (%x+) %._([%w_]+)$")
    if name then labels[name] = tonumber(hex,16) end
end
local file = assert(io.open(assert(os.getenv("BATTLECITY_GOLDENS")), "r"))
local source = file:read("*a")
file:close()
local cases = {}
for id, frames, hash, writes in source:gmatch("(0x%x+): %[(%d+), (0x%x+), (%d+)%]") do
    cases[#cases+1] = {id=tonumber(id), frames=tonumber(frames), hash=tonumber(hash), writes=tonumber(writes)}
end
assert(#cases==27,"missing reference audio traces")
local machine = manager.machine
local bus = machine.devices[":maincpu"].spaces.program
local index, warmup = 0, 90
local frame, hash, writes
local function mix(byte) hash = ((hash ~ byte) * 16777619) & 0xffffffff end
audio_tap = bus:install_write_tap(0x4000,0x400f,"cue_trace",function(addr, value, mask)
    if not frame then return end
    local reg = addr & 3
    mix(frame & 255); mix(frame >> 8); mix((addr-0x4000) >> 2); mix(reg); mix(value)
    if reg==3 then writes=writes+1 end
end)
local function tick()
    if warmup>0 then
        warmup=warmup-1
        -- Isolate the requested cue from the title demonstration's battle sounds.
        if warmup==0 then bus:write_u8(labels.custom,1) end
        return
    end
    if frame then
        local case = cases[index]
        if frame<case.frames then frame=frame+1; return end
        assert(writes==case.writes and hash==case.hash,
            string.format("slot %02X: expected %08X/%d, got %08X/%d",case.id,case.hash,case.writes,hash,writes))
        frame=nil
        bus:write_u8(labels.audio_clear,1)
        return
    end
    index=index+1
    if index>#cases then
        print("BATTLECITY_AUDIO_OK 27 full APU register traces")
        machine:exit()
        return
    end
    bus:write_u8(labels.audio_commands+cases[index].id,1)
    frame,hash,writes=1,2166136261,0
end
audio_frames=emu.add_machine_frame_notifier(function()
    local ok,err=pcall(tick)
    if not ok then
        print("BATTLECITY_AUDIO_FAILED",err)
        machine:exit()
    end
end)
