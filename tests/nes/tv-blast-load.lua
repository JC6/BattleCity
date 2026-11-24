-- Move two groups of exploding enemies across the field. The cartridge still
-- builds its own OAM and paints the explosion at every emulator display frame.
local blasts=0
blast_load=emu.add_machine_frame_notifier(function()
    blasts=blasts+1
    if blasts<564 or blasts%12~=0 or ram:read_u8(mode_address)~=1 then return end
    for slot=2,7 do
        local tank=tank_address+13*slot
        ram:write_u8(tank,16+((slot*31+blasts//12*7)%172))
        ram:write_u8(tank+1,28+((slot*29+blasts//12*9)%154))
        ram:write_u8(tank+3,46)
    end
    if blasts%120==0 then
        local file=assert(io.open(stress_path,"w"))
        file:write(blasts);file:close()
    end
end)
