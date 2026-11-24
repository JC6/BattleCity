-- Same controller edges on both release platforms and none after stage entry.
local start_field
for tag,port in pairs(manager.machine.ioport.ports) do
    if tag:match(":ctrl1") then
        for _,field in pairs(port.fields) do
            if field.enabled and field.type_class=="controller" and field.mask==8 then start_field=field end
        end
    end
end
assert(start_field,"P1 Start missing")
local tick=0
clock_inputs=emu.add_machine_frame_notifier(function()
    tick=tick+1
    start_field:set_value((tick>=330 and tick<335 or tick>=420 and tick<425) and 1 or 0)
end)
