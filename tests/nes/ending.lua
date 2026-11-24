-- Compare equivalent last-hit fixtures in the Famicom program and the homebrew.
-- All subsequent state is produced by the running cartridge.
local m=manager.machine
local bus=m.devices[":maincpu"].spaces.program
local classic=os.getenv("BATTLECITY_CLASSIC")=="1"
local scenario=assert(os.getenv("BATTLECITY_SCENARIO"))
local buttons=os.getenv("BATTLECITY_END_INPUT") or "neutral"
local win=scenario=="solo" or scenario=="coop"
local coop=scenario=="coop"
local a,pads={},{}
if not classic then
    for line in io.lines(assert(os.getenv("BATTLECITY_LABELS"))) do
        local v,n=line:match("^al (%x+) %._([%w_]+)$")
        if n then a[n]=tonumber(v,16) end
    end
end
for tag,port in pairs(m.ioport.ports) do
    if tag:match(":ctrl1") then for _,field in pairs(port.fields) do
        if field.enabled and field.type_class=="controller" then pads[field.mask]=field end
    end end
end
local frame,origin,done,score_frame=0,nil,false,nil
local capture=os.getenv("BATTLECITY_CAPTURE_DIR")
local record=buttons=="record"
local record_seen=false
local rows={}
local function event(name)
    if origin and not done then rows[#rows+1]=(frame-origin)..","..name end
end
local function finish()
    if record then assert(record_seen,"high-score screen did not display the reference lettering and score") end
    local result=table.concat(rows,"\n").."\n"
    local out=os.getenv("BATTLECITY_TRACE")
    if out then local f=assert(io.open(out,"w"));f:write(result);f:close() end
    local path=os.getenv("BATTLECITY_GOLDENS")
    if path then
        local f=assert(io.open(path));local expected=f:read("*a");f:close()
        if result~=expected then
            local i=0
            for line in expected:gmatch("[^\n]+") do
                i=i+1
                if rows[i]~=line then print("BATTLECITY_ENDING_FAILED "..scenario.." expected "..line.." got "..tostring(rows[i]));break end
            end
            if i<#rows then print("BATTLECITY_ENDING_FAILED extra or differing events") end
            done=true;m:exit();return
        end
    end
    done=true;print("BATTLECITY_ENDING_OK");m:exit()
end
local function put(addr,v) bus:write_u8(addr,v) end
local function setup()
    origin=frame;event("shot")
    if classic then
        for i=0,7 do put(0xa0+i,0);put(0x73+i,0) end
        for i=0,9 do put(0xcc+i,0) end
        put(0x73,8);put(0x74,3);put(0x75,2);put(0x76,coop and 0 or 6)
        if coop then put(0x77,6) end
        put(0x7f,0);put(0x80,win and 1 or 20);put(0x100,64)
        put(0x51,scenario=="lives" and 1 or 3);put(0x52,coop and 3 or 0)
        put(0x89,0);put(0x90,88);put(0x98,168);put(0xa0,0xa0);put(0xa8,0)
        local i=scenario=="lives" and 2 or 0
        if win then put(0x92,24);put(0x9a,24);put(0xa2,0xa2);put(0xaa,0x80) end
        put(0xb8+i,win and 24 or scenario=="base" and 120 or 88)
        put(0xc2+i,win and 22 or scenario=="base" and 216 or 166)
        put(0xcc+i,0x42);put(0xd6+i,0)
    else
        for i=0,7 do put(a.tanks+13*i+3,0);put(a.kills+i,0) end
        for i=0,9 do put(a.shots+4*i+3,0);put(a.shot_blast+i,0) end
        if record then
            for i=0,3 do put(a.scores+i,(185900 >> (8*i)) & 255) end
            for i,digit in ipairs({0,1,8,5,9,0,0}) do put(a.score_digits+i-1,digit) end
        end
        put(a.kills,8);put(a.kills+1,3);put(a.kills+2,2);put(a.kills+3,coop and 0 or 6)
        if coop then put(a.kills+4,6) end
        put(a.spawned,20);put(a.defeated,win and 19 or 0);put(a.freeze,0);put(a.freeze+1,16)
        put(a.lives,scenario=="lives" and 1 or 3);put(a.lives+1,coop and 3 or 0)
        put(a.tanks,64);put(a.tanks+1,144);put(a.tanks+3,1);put(a.tanks+11,0);put(a.tanks+12,0)
        if win then
            put(a.tanks+26,0);put(a.tanks+27,0);put(a.tanks+29,1);put(a.tanks+30,1)
            put(a.tanks+31,0);put(a.tanks+36,0);put(a.tanks+37,0);put(a.tanks+38,0)
        end
        local i=scenario=="lives" and 2 or 0
        put(a.shots+4*i,win and 6 or scenario=="base" and 102 or 70)
        put(a.shots+4*i+1,win and 4 or scenario=="base" and 198 or 148)
        put(a.shots+4*i+2,2);put(a.shots+4*i+3,1);put(a.shot_fast+i,0)
    end
end
ending_taps={}
local function tap(address,method,fn)
    ending_taps[#ending_taps+1]=bus[method](bus,address,address,"ending_"..address,fn)
end
tap(classic and 0xc2e6 or a.play,"install_read_tap",function()
    if frame>=710 and not origin then setup() end
end)
local function oncall(addr,name)
    if not addr then return end
    tap(addr,"install_read_tap",function()
        local pc=m.devices[":maincpu"].state.PC.value
        if (pc==addr or pc==addr+1) and origin and (name~="game-over" or score_frame) then
            event(name)
            if name=="tally" then score_frame=frame end
            if name=="next" or name=="title" then finish() end
        end
    end)
end
oncall(classic and 0xccd4 or a.result,"tally")
oncall(classic and 0xc5d9 or a.game_over_page,"game-over")
oncall(classic and 0xc159 or a.next_stage,"next")
oncall(classic and 0xc095 or a.title,"title")
for _,cue in ipairs({10,11,7,19,27}) do
    local last=-1
    tap((classic and 0x300 or a.audio_commands)+cue,"install_write_tap",function(_,v)
        if classic and m.devices[":maincpu"].state.PC.value>=0xea51 then return end
        if origin and v==1 and last~=frame then last=frame;event("cue-"..cue) end
    end)
end
ending_frames=emu.add_machine_frame_notifier(function()
    frame=frame+1
    pads[4]:set_value(coop and frame>=300 and frame<305 and 1 or 0)
    if record and not record_seen and bus:read_u8(a.mode)==8 then
        local data=m.screens[":screen"]:pixels()
        local function outline(x,y,columns)
            local hash=2166136261
            for cy=0,6 do for cx=0,columns-1 do
                local lit=0
                for v=0,3 do for u=0,3 do
                    local pixel=1+4*((y+cy*4+v)*256+x+cx*4+u)
                    local b,g,r=data:byte(pixel,pixel+2)
                    if math.max(b,g,r)>56 then lit=lit+1 end
                end end
                hash=((hash ~ (lit>=9 and 1 or 0))*16777619) & 0xffffffff
            end end
            return hash
        end
        -- 4x4-cell outlines measured in the 185900 Switch frame at 43:36.
        record_seen=outline(16,52,56)==0x5f1b57f1 and outline(48,104,48)==0xa79a5774
        if record_seen and capture then
            local f=assert(io.open(capture.."/record.bgra","wb"));f:write(data);f:close()
        end
    end
    if capture and origin then
        local t=frame-origin
        if t==9 or t==186 or t==240 or t==365 then
            local screen=m.screens[":screen"]
            local data,w,h=screen:pixels()
            assert(w==256 and h==240)
            local f=assert(io.open(capture.."/"..scenario.."-"..t..".bgra","wb"))
            f:write(data);f:close()
        end
    end
    local t=score_frame and frame-score_frame or -1
    local start=frame>=330 and frame<335 or frame>=420 and frame<425
    if buttons=="tap" and t==54 or buttons=="hold" and t>=54 and t<155 then start=true end
    pads[8]:set_value(start and 1 or 0)
    if not done and frame>3900 then done=true;print("BATTLECITY_ENDING_FAILED timeout "..table.concat(rows," "));m:exit() end
end)
