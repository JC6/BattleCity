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
local cases = {}
for slot = 0,2 do
    for grade = 0,3 do
        for direction = 0,3 do
            for tread = 0,1 do
                for _,scene in ipairs({"open","forest","edge","crowded"}) do
                    cases[#cases+1] = {slot=slot, grade=grade, direction=direction, tread=tread, scene=scene}
                end
            end
        end
    end
end
local pose,launch=1,0
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
    local case=cases[pose]
    if not case then return end
    for i=0,7 do bus:write_u8(addr.tanks+13*i+3,0) end
    local slot=case.slot
    local a=addr.tanks+13*slot
    local xy=case.scene=="edge" and 192 or 80
    bus:write_u8(a,xy);bus:write_u8(a+1,xy);bus:write_u8(a+2,case.direction)
    bus:write_u8(a+3,1);bus:write_u8(a+4,1);bus:write_u8(a+10,0);bus:write_u8(a+9,0)
    bus:write_u8(a+5,slot==2 and case.grade or 0)
    bus:write_u8(a+7,slot<2 and case.grade or 0)
    bus:write_u8(addr.combat_frame,0)
    bus:write_u8(addr.used_sprites,case.scene=="crowded" and 244 or 0)
    bus:write_u8(addr.shield_sprites,case.scene=="forest" and (1<<slot) or 0)
    bus:write_u8(addr.has_trees,case.scene=="forest" and 1 or 0)
    if case.scene=="forest" then bus:write_u8(addr.board+5*13+5,0x45) end
    bus:write_u8(addr.tread+slot,8*case.tread)
    prepared=true
end)
read(addr.draw_shots,function()
    if not prepared then return end
    local case=cases[pose]
    local first=case.scene=="crowded" and 244 or 0
    local oam={}
    for address=first,bus:read_u8(addr.used_sprites)-1 do
        oam[#oam+1]=string.format("%02x",bus:read_u8(0x200+address))
    end
    print(string.format("BATTLECITY_POSE %d %d %d %d %s %s",case.slot,case.grade,
                        case.direction,case.tread,case.scene,table.concat(oam)))
    if case.grade==0 and case.scene=="open" and case.tread==0 then
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
                    local distance=({-py,px,py,-px})[case.direction+1]
                    if distance>front then front=distance;axes={} end
                    if distance==front then axes[#axes+1]=(case.direction%2==0 and px or py) end
                end
            end
        end
    end
    assert(#axes==1,"barrel tip must be one pixel wide")
    print(string.format("BATTLECITY_BARREL %s %d %d",({"player","player2","enemy"})[case.slot+1],case.direction,axes[1]))
    end
    prepared=false
    pose=pose+1
end)
barrel_result=emu.add_machine_frame_notifier(function()
    if launch==4 and pose>#cases then
        print("BATTLECITY_BARRELS_OK")
        machine:exit()
    end
end)
