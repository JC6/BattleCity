-- Observe the release cartridge's launch offsets and the visible tip of the player's barrel.
local machine=manager.machine
local device=machine.devices[":maincpu"]
local bus=device.spaces.program
local ppu=machine.devices[":ppu"].spaces.videoram
local addr={}
for line in io.lines(assert(os.getenv("BATTLECITY_LABELS"))) do
    local value,name=line:match("^al (%x+) %._([%w_]+)$")
    if name then addr[name]=tonumber(value,16) end
end
local pose,launch=0,0
local prepared=false
local owner=nil
barrel_hooks={}
local function read(address,fn)
    barrel_hooks[#barrel_hooks+1]=bus:install_read_tap(address,address,"shell barrel",fn)
end
-- The normal firing subroutine takes the tank slot in the accumulator. Give it
-- room to launch, then read back the position it actually stored for each direction.
read(addr.fire,function()
    if launch==4 then return end
    owner=device.state["A"].value
    assert(owner<8)
    local tank=addr.tanks+13*owner
    bus:write_u8(tank,80);bus:write_u8(tank+1,80);bus:write_u8(tank+2,launch)
    bus:write_u8(addr.shots+4*owner+3,0);bus:write_u8(addr.shot_blast+owner,0)
end)
barrel_hooks[#barrel_hooks+1]=bus:install_write_tap(addr.shots,addr.shots+31,"shell launch",function(address,value)
    if owner==nil or address~=addr.shots+4*owner+3 or value~=1 then return end
    local offset=addr.shots+4*owner
    print(string.format("BATTLECITY_LAUNCH %d %d %d",launch,
                        bus:read_u8(offset)-80,bus:read_u8(offset+1)-80))
    launch=launch+1
    owner=nil
end)
read(addr.render_tanks,function()
    if pose==8 then return end
    for i=0,7 do bus:write_u8(addr.tanks+13*i+3,0) end
    local slot=pose<4 and 0 or 2
    local a=addr.tanks+13*slot
    bus:write_u8(a,80);bus:write_u8(a+1,80);bus:write_u8(a+2,pose%4)
    bus:write_u8(a+3,1);bus:write_u8(a+4,1);bus:write_u8(a+5,0);bus:write_u8(a+10,0);bus:write_u8(a+7,0);bus:write_u8(a+9,0)
    bus:write_u8(addr.used_sprites,0);bus:write_u8(addr.shield_sprites,0)
    bus:write_u8(addr.tread+slot,0)
    prepared=true
end)
read(addr.draw_shots,function()
    if not prepared then return end
    assert(bus:read_u8(addr.used_sprites)==16,"body must occupy four OAM entries")
    local front,axes=-1000,{}
    for sprite=0,3 do
        local base=0x200+sprite*4
        local attr=bus:read_u8(base+2)
        local tile=0x1000+16*bus:read_u8(base+1)
        for y=0,7 do
            local row=tile+((attr&128)~=0 and 7-y or y)
            local plane=ppu:read_u8(row)|ppu:read_u8(row+8)
            for x=0,7 do
                if (plane&(1<<((attr&64)~=0 and x or 7-x)))~=0 then
                    local px=bus:read_u8(base+3)+x-96
                    local py=bus:read_u8(base)+1+y-96
                    local distance=({-py,px,py,-px})[pose%4+1]
                    if distance>front then front=distance;axes={} end
                    if distance==front then axes[#axes+1]=(pose%2==0 and px or py) end
                end
            end
        end
    end
    assert(#axes==1,"barrel tip must be one pixel wide")
    print(string.format("BATTLECITY_BARREL %s %d %d",pose<4 and "player" or "enemy",pose%4,axes[1]))
    prepared=false
    pose=pose+1
end)
barrel_result=emu.add_machine_frame_notifier(function()
    if launch==4 and pose==8 then
        print("BATTLECITY_BARRELS_OK")
        machine:exit()
    end
end)
