-- Capture isolated cartridge cues for comparison with the Switch mix.
-- Use MAME -wavwrite and the same game.lbl as the packaged ROM.
local bus=manager.machine.devices[":maincpu"].spaces.program
local labels={}
for line in io.lines(assert(os.getenv("BATTLECITY_LABELS"))) do
    local v,n=line:match("^al (%x+) %._([%w_]+)$")
    if n then labels[n]=tonumber(v,16) end
end
local cues={{15},{7},{19,20},{24,25,26}}
local frame=0
cue_recording=emu.add_machine_frame_notifier(function()
    frame=frame+1
    if frame==90 then bus:write_u8(labels.custom,1) end
    for i,commands in ipairs(cues) do
        if frame==180*i-15 then bus:write_u8(labels.audio_clear,1) end
        if frame==180*i then
            for _,id in ipairs(commands) do bus:write_u8(labels.audio_commands+id,1) end
        end
    end
    if frame==900 then print("BATTLECITY_CUE_RECORDING_OK");manager.machine:exit() end
end)
