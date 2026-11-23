-- Identical controller edges for both cores. CPU event timestamps record the
-- vblank number and count only actual battle updates since stage selection.
local machine=manager.machine
local bus=machine.devices[":maincpu"].spaces.program
local screen=machine.screens[":screen"]
local players=tonumber(os.getenv("BATTLECITY_PLAYERS") or "1")
local classic=os.getenv("BATTLECITY_CLASSIC")=="1"
local addr, pads={},{}
if not classic then
    for line in io.lines(assert(os.getenv("BATTLECITY_LABELS"))) do
        local hex,name=line:match("^al (%x+) %._([%w_]+)$")
        if name then addr[name]=tonumber(hex,16) end
    end
end
for tag, port in pairs(machine.ioport.ports) do
    if tag:match(":ctrl1") then
        for _,field in pairs(port.fields) do
            if field.enabled and field.type_class=="controller" then pads[field.mask]=field end
        end
    end
end
local frame,battle,origin=0,0,nil
local events,slots,log={}, {}, {}
local function record(name,detail)
    if not origin or events[name] then return end
    local entry={frame-origin,battle,detail}
    events[name]=entry
    log[#log+1]=string.format("%s=%d/%d%s",name,entry[1],entry[2],detail and ("/"..detail) or "")
end
opening_taps={}
local function watch(kind,address,fn)
    local method=kind=="read" and bus.install_read_tap or bus.install_write_tap
    opening_taps[#opening_taps+1]=method(bus,address,address,"opening_"..address,fn)
end
watch("read",classic and 0xc1c5 or addr.start_stage,function()
    if frame>=420 and not origin then origin=frame;record("confirm") end
end)
watch("read",classic and 0xc2e6 or addr.play,function() if origin then battle=battle+1 end end)
if classic then
    watch("read",0xccc8,function() record("curtain") end)
else
    watch("write",addr.curtain_pair,function(_,value) if value==16 then record("curtain") end end)
end
for slot=0,7 do
    local status=classic and 0xa0+slot or addr.tanks+13*slot+3
    local last
    watch("write",status,function(_,value)
        if not origin or last==value then return end
        last=value
        if (classic and value==0xf0) or (not classic and value==29) then
            if slot<2 then record("p"..(slot+1).."_birth")
            elseif #slots<3 then
                slots[#slots+1]=slot
                local x=bus:read_u8(classic and 0x90+slot or addr.tanks+13*slot)
                record("enemy"..#slots,string.format("%d:%d",slot,classic and x-24 or x))
            end
        elseif (classic and value>=0x80 and value<0xe0) or (not classic and value==1) then
            if slot<2 and events["p"..(slot+1).."_birth"] then record("p"..(slot+1).."_ready") end
        end
    end)
end
local function validate()
    local expected={
        confirm={0,0}, curtain={78,0}, visible={81,0}, p1_birth={94,0},
        p1_ready={133,37}, fire={134,37}, move={135,38},
        enemy1={97,1,players==1 and "5:96" or "7:96"},
        enemy2=players==1 and {284,188,"4:192"} or {264,168,"6:192"},
        enemy3=players==1 and {471,375,"3:0"} or {431,335,"5:0"},
    }
    if players==2 then expected.p2_birth={94,0}; expected.p2_ready={133,37}
    else assert(not events.p2_birth,"solo started P2") end
    for name,target in pairs(expected) do
        local actual=assert(events[name],"missing "..name)
        for i,value in ipairs(target) do
            assert(actual[i]==value,string.format("%s field %d expected %s got %s",name,i,value,actual[i]))
        end
    end
end
-- Compare the PPU nametable with all 676 terrain quadrants on the first
-- completed frame. This also catches rows that contain valid but wrong CHR IDs.
local function verify_board()
    local vram=machine.devices[":ppu"].spaces.videoram
    for y=0,25 do
        for x=0,25 do
            local cell=bus:read_u8(addr.board+(y//2)*13+x//2)
            local quadrant=(y%2)*2+(x%2)
            local tile=cell>>4
            if (cell & (1<<quadrant))==0 then tile=0
            elseif tile==6 then tile=8+quadrant end
            local actual=vram:read_u8(0x2042+y*32+x)
            assert(actual==tile,string.format("field tile (%d,%d): expected %d got %d",x,y,tile,actual))
        end
    end
end
local function verify_enemy_count()
    local vram=machine.devices[":ppu"].spaces.videoram
    for i=0,19 do
        local tile=vram:read_u8(0x207d+(i//2)*32+i%2)
        assert(tile==(i<19 and 12 or 14),"enemy count icon "..i)
    end
end
local grey,board_verified,count_verified
local function step()
    frame=frame+1
    pads[4]:set_value(players==2 and frame>=300 and frame<305 and 1 or 0)
    pads[8]:set_value((frame>=330 and frame<335 or frame>=420 and frame<425) and 1 or 0)
    pads[16]:set_value(frame>425 and not events.move and 1 or 0)
    pads[1]:set_value(frame>425 and not events.fire and frame%2==1 and 1 or 0)
    pads[2]:set_value(frame>425 and not events.fire and frame%2==0 and 1 or 0)
    if frame==430 then grey=screen:pixel(84,116) end
    if origin and grey and screen:pixel(84,116)~=grey then record("visible") end
    if not classic and events.enemy1 and not board_verified then
        verify_board()
        board_verified=true
    end
    if not classic and events.p1_ready and not count_verified then
        verify_enemy_count()
        count_verified=true
    end
    if events.p1_birth then
        local y=bus:read_u8(classic and 0x98 or addr.tanks+1)
        if y<(classic and 216 or 192) then record("move") end
        if bus:read_u8(classic and 0xcc or addr.shots+3)~=0 then record("fire") end
    end
    if events.enemy3 then
        print("OPENING_TRACE "..players.."P "..table.concat(log," "))
        validate()
        print("BATTLECITY_OPENING_OK")
        machine:exit()
    end
    assert(frame<1450,"opening timed out: "..table.concat(log," "))
end
opening_subscription=emu.add_machine_frame_notifier(function()
    local ok,err=pcall(step)
    if not ok then print("BATTLECITY_OPENING_FAILED "..tostring(err));machine:exit() end
end)
