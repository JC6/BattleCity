-- Exercise the production OAM writer and decode its four directional PPU tiles.
local machine=manager.machine
local cpu=machine.devices[":maincpu"].spaces.program
local ppu=machine.devices[":ppu"].spaces.videoram
local labels={}
for line in io.lines(assert(os.getenv("BATTLECITY_LABELS"))) do
    local address,name=line:match("^al (%x+) %._([%w_]+)$")
    if name then labels[name]=tonumber(address,16) end
end
-- Red and green tank projectiles use the same grey palette. Rows start
-- three pixels left and one pixel above the original shell centre.
local patterns={
    {"..#.",".###",".###",".###"}, {"###.","####","###.","...."},
    {".###",".###",".###","..#."}, {".###","####",".###","...."}
}
local armed,seen=false,0
shell_setup=cpu:install_read_tap(labels.draw_shots,labels.draw_shots,"four shells",function()
    if armed then return end
    armed=true
    cpu:write_u8(labels.used_sprites,0)
    for i=0,9 do
        local address=labels.shots+4*i
        cpu:write_u8(address,60+8*i);cpu:write_u8(address+1,80)
        cpu:write_u8(address+2,i%4);cpu:write_u8(address+3,i<4 and 1 or 0)
        cpu:write_u8(labels.shot_blast+i,0)
    end
end)
shell_oam=cpu:install_write_tap(0x200,0x20f,"rendered shell",function(address,tile)
    if not armed or seen==4 or address~=0x201+4*seen then return end
    local attr=cpu:read_u8(address+1)
    local left=cpu:read_u8(address+2)-(60+8*seen+15)
    local top=cpu:read_u8(address-1)+1-97
    assert((attr&3)==2,"shell palette")
    local count=0
    for y=0,7 do
        local sy=(attr&128)~=0 and 7-y or y
        local low=ppu:read_u8(0x1000+16*tile+sy)
        local high=ppu:read_u8(0x1000+16*tile+sy+8)
        for x=0,7 do
            local bit=(attr&64)~=0 and x or 7-x
            local color=((low>>bit)&1)+2*((high>>bit)&1)
            if color~=0 then
                local px,py=left+x+1,top+y+1
                assert(color==2 and px>=1 and px<=4 and py>=1 and py<=4 and
                       patterns[seen+1][py]:sub(px,px)=="#","shell pixel or anchor differs in direction "..seen)
                count=count+1
            end
        end
    end
    assert(count==10,"shell area differs in direction "..seen)
    print(string.format("BATTLECITY_SHELL_OAM %d %d %d %d %d",seen,tile,attr,left-1,top+1))
    seen=seen+1
end)
shell_result=emu.add_machine_frame_notifier(function()
    if seen==4 then print("BATTLECITY_SHELLS_OK four anchored OAM silhouettes");machine:exit() end
end)
