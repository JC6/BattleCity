-- Cold boot without input. Reference entry frames were measured from reset.
local machine=manager.machine
local cpu=machine.devices[":maincpu"]
local ram=cpu.spaces.program
local vram=machine.devices[":ppu"].spaces.videoram
local classic=os.getenv("BATTLECITY_CLASSIC")=="1"
local input=os.getenv("BATTLECITY_ATTRACT_INPUT") or "start"
local natural=input=="natural"
local labels={}
if classic then
    -- Entry points in the reference identified by SHA-1 in verify_stages.py.
    labels={title=natural and 0xc09c or 0xd16a,title_cursor=0xc9c0,start_stage=0xc3b5,play=0xc2e6}
else for line in io.lines(assert(os.getenv("BATTLECITY_LABELS"))) do
    local hex,name=line:match("^al (%x+) %._([%w_]+)$")
    if name then labels[name]=tonumber(hex,16) end
end end
local buttons={{},{}}
for tag,port in pairs(machine.ioport.ports) do
    local id=tonumber(tag:match(":ctrl(%d)"))
    if id then for _,f in pairs(port.fields) do
        if f.enabled and f.type_class=="controller" then buttons[id][f.mask]=f end
    end end
end
local ticks,events,frame=0,{},0
local trace=os.getenv("BATTLECITY_TRACE")
local returned,menu_frame
local function read(label) return ram:read_u8(labels[label]) end
-- Each letter is made of 4×4-pixel pieces of destructible brick. Sample
-- collision RAM before either demo player or its shots can change it.
local function letter_bricks(left,top,width)
    local pieces,hash,visible=0,2166136261,true
    for y=top,top+3 do
        for x=left,left+width-1 do
            local mask=0
            if classic then
                local tile=ram:read_u8(0x442+y*32+x) & 63
                if tile<16 then mask=tile end
            else
                local cell=ram:read_u8(labels.board+(y//2)*13+x//2)
                if cell>>4==1 and (cell & (1<<((y%2)*2+x%2)))~=0 then
                    local missing=ram:read_u8(labels.missing_bricks+y*13+x//2)
                    mask=15 ~ ((missing>>((x%2)*4)) & 15)
                end
            end
            local tile=vram:read_u8(0x2042+y*32+x)
            local rendered
            if classic then rendered=tile==0x20 and 0 or tile
            elseif tile==1 then rendered=15
            elseif tile>=225 and tile<=239 then rendered=tile-224
            else rendered=tile==0 and 0 or -1 end
            visible=visible and rendered==mask
            hash=((hash~mask)*16777619)&0xffffffff
            for bit=0,3 do pieces=pieces+((mask>>bit) & 1) end
        end
    end
    return pieces,hash,visible
end
local battle_bricks,city_bricks,bricks_left
local battle_hash,city_hash,battle_visible,city_visible
attract_taps={}
for _,name in ipairs({"title","title_cursor","start_stage","play"}) do
    local address=assert(labels[name])
    attract_taps[#attract_taps+1]=ram:install_read_tap(address,address,"attract_"..name,function()
        if cpu.state.PC.value~=address and cpu.state.PC.value~=address+1 then return end
        if name=="title" and ticks>0 and not returned then
            returned=frame
            if natural then
                bricks_left=letter_bricks(1,7,24)+letter_bricks(6,13,16)
            end
        end
        if name=="title_cursor" and returned and not menu_frame then menu_frame=frame end
        events[name]=events[name] or frame
        if name=="play" and (classic or read("demo")==1) and not returned then
            if ticks==0 and natural then
                battle_bricks,battle_hash,battle_visible=letter_bricks(1,7,24)
                city_bricks,city_hash,city_visible=letter_bricks(6,13,16)
            end
            ticks=ticks+1
        end
    end)
end
attract_frame=emu.add_machine_frame_notifier(function()
    frame=frame+1
    if natural then
        if menu_frame then
            if trace then
                local file=assert(io.open(trace,"w"))
                file:write("title_cursor,demo_setup,first_update,return_to_title,menu_ready,combat_updates,battle_brick_quarters,city_brick_quarters,brick_quarters_removed\n")
                file:write(table.concat({events.title_cursor,events.start_stage,events.play,returned,menu_frame,ticks,battle_bricks,city_bricks,battle_bricks+city_bricks-bricks_left},","),"\n")
                file:close()
            end
            print("BATTLECITY_ATTRACT_RETURN",returned,menu_frame,ticks)
            if events.title_cursor~=266 or events.start_stage~=854 or events.play~=881 then
                print("BATTLECITY_ATTRACT_FAILED startup timing",events.title_cursor,events.start_stage,events.play)
            elseif battle_hash~=0x9e69858f or city_hash~=0x3f8eacef or not (battle_visible and city_visible) then
                print("BATTLECITY_ATTRACT_FAILED brick lettering",battle_hash,city_hash,battle_visible,city_visible)
            elseif battle_bricks~=143 or city_bricks~=84 or battle_bricks+city_bricks-bricks_left~=176 then
                print("BATTLECITY_ATTRACT_FAILED brick damage",battle_bricks,city_bricks,bricks_left)
            elseif returned~=4083 or menu_frame~=4327 or ticks~=3203 then
                print("BATTLECITY_ATTRACT_FAILED timeline",returned,menu_frame,ticks)
            else
                print("BATTLECITY_ATTRACT_OK")
            end
            machine:exit()
        elseif frame>=12000 then
            print("BATTLECITY_ATTRACT_FAILED demo did not return to the title menu")
            machine:exit()
        end
        return
    end
    local second=input:sub(1,2)=="p2"
    local select_button=input:find("select",1,true)~=nil
    local interrupt=second and 1040 or 1020
    buttons[2][select_button and 4 or 8]:set_value(second and frame>=1020 and frame<1025 and 1 or 0)
    buttons[1][4]:set_value(select_button and frame>=interrupt and frame<interrupt+5 and 1 or 0)
    buttons[1][8]:set_value(((not select_button and frame>=interrupt and frame<interrupt+5)
        or (frame>=1070 and frame<1075)) and 1 or 0)
    if frame==1100 then
        local ok=events.title_cursor==266 and events.start_stage==854 and events.play==881
            and returned and returned>=interrupt and returned<=interrupt+3
            and menu_frame and menu_frame<1070
            and (classic and ram:read_u8(0x85)==1 or not classic and read("demo")==0 and read("mode")==6)
        if ok then print("BATTLECITY_ATTRACT_OK")
        else print("BATTLECITY_ATTRACT_FAILED interruption",input,returned,menu_frame,ticks) end
        machine:exit()
    end
end)
