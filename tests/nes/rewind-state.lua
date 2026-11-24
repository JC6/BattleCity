-- Hash-free comparison of all NES work RAM at real core save/load boundaries.
-- The enclosing test provides checkpoint_report(kind, time, matched).
local m=manager.machine
local bus=m.devices[":maincpu"].spaces.program
local history={}
local function work_ram()
    local bytes={}
    for address=0,2047 do bytes[#bytes+1]=string.char(bus:read_u8(address)) end
    return table.concat(bytes)
end
rewind_saved=emu.add_machine_pre_save_notifier(function()
    local time=m.time:as_double()
    history[#history+1]={stamp=time,bytes=work_ram()}
    if #history>120 then table.remove(history,1) end
    checkpoint_report("save",time,1)
end)
rewind_loaded=emu.add_machine_post_load_notifier(function()
    -- A synchronous hotkey may fire inside a CPU timeslice. Look up the actual
    -- restored RAM to report its capture time; the caller's clock can still be
    -- on the abandoned timeline during this notification.
    local bytes=work_ram()
    for i=#history,1,-1 do
        if bytes==history[i].bytes then
            checkpoint_report("load",history[i].stamp,1)
            for j=#history,i+1,-1 do history[j]=nil end
            return
        end
    end
    checkpoint_report("load",m.time:as_double(),-1)
end)
