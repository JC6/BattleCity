-- Sample the completed update at the next battle entry, before either program
-- can move a tank again. Inputs use display frames measured from confirmation.
local machine = manager.machine
local bus = machine.devices[":maincpu"].spaces.program
local classic = os.getenv("BATTLECITY_CLASSIC") == "1"
local scenario = assert(os.getenv("BATTLECITY_SCENARIO"))
assert(scenario == "idle" or scenario == "solo" or scenario == "coop" or scenario == "drops")
local symbols, pads = {}, {{}, {}}
if not classic then
    for line in io.lines(assert(os.getenv("BATTLECITY_LABELS"))) do
        local hex, name = line:match("^al (%x+) %._([%w_]+)$")
        if name then symbols[name] = tonumber(hex, 16) end
    end
end
for tag, port in pairs(machine.ioport.ports) do
    local number = tonumber(tag:match(":ctrl(%d)"))
    if number then
        for _, field in pairs(port.fields) do
            if field.enabled and field.type_class == "controller" then pads[number][field.mask] = field end
        end
    end
end
local function read(addr) return bus:read_u8(addr) end
local frame, tick, origin = 0, 0, nil
local events = {}
local function sample()
    local state = {}
    for i = 2, 7 do
        local addr = not classic and symbols.tanks + 13*i
        local status = read(classic and 0xa0+i or addr+3)
        if (classic and status >= 0x80 and status < 0xe0) or (not classic and status == 1) then
            local x = classic and read(0x90+i)-24 or read(addr)
            local y = classic and read(0x98+i)-24 or read(addr+1)
            local dir = classic and (-status & 3) or read(addr+2)
            state[#state+1] = string.format("%x%02x%02x%d",i,x,y,dir)
        end
    end
    local shots = {}
    for i = 0, 9 do
        local addr = not classic and symbols.shots+4*i
        local status = read(classic and 0xcc+i or addr+3)
        if (classic and status>>4 == 4) or (not classic and status == 1) then
            local x = classic and (read(0xb8+i)-18)%256 or read(addr)
            local y = classic and (read(0xc2+i)-18)%256 or read(addr+1)
            local dir = classic and (-status & 3) or read(addr+2)
            shots[#shots+1] = string.format("%x%02x%02x%d",i,x,y,dir)
        end
    end
    return table.concat(state,"."),table.concat(shots,"."),table.concat(events,".")
end
combat_taps = {}
local function watch(address, method, fn)
    combat_taps[#combat_taps+1] = bus[method](bus,address,address,"combat_"..address,fn)
end
watch(classic and 0xc1c5 or symbols.start_stage,"install_read_tap",function()
    if frame>=420 and not origin then origin=frame end
end)
for i=0,9 do
    local previous=false
    watch(classic and 0xcc+i or symbols.shots+4*i+3,"install_write_tap",function(_,value)
        local flying = classic and (value>>4)==4 or not classic and value==1
        if tick>0 and flying~=previous then
            events[#events+1]=(flying and "+" or "-")..i
        end
        previous=flying
    end)
end
local out_path=os.getenv("BATTLECITY_TRACE")
local out=out_path and assert(io.open(out_path,"w"))
local expected_path=os.getenv("BATTLECITY_GOLDENS")
local expected=expected_path and assert(io.open(expected_path))
-- Nine controlled hits: eight distinct item rolls and one occupied drop site.
-- Use an empty stretch of the reference score digits as the entropy input.
local function carrier_hit(seed, occupied)
    local function put(a,v) bus:write_u8(a,v) end
    local px,py=occupied and 24 or 0,occupied and 24 or 176
    if classic then
        for i=0,9 do put(0xcc+i,0) end
        for i=0,7 do put(0xa0+i,0) end
        put(0x90,px+24);put(0x98,py+24);put(0xa0,0xa0)
        put(0x92,24);put(0x9a,24);put(0xa2,0xa2);put(0xaa,0x84)
        put(0xb8,24);put(0xc2,22);put(0xcc,0x42);put(0xd6,0)
        put(0x100,10);put(0x7f,0);put(0x86,0);put(0x0a,0)
        for i=0x15,0x1b do put(i,0) end
        put(0x0f,seed);put(0x10,0x14)
    else
        local tank,shot=symbols.tanks,symbols.shots
        for i=0,9 do put(shot+i*4+3,0);put(symbols.shot_blast+i,0) end
        for i=0,7 do put(tank+i*13+3,0) end
        put(tank,px);put(tank+1,py);put(tank+3,1)
        put(tank+26,0);put(tank+27,0);put(tank+29,1)
        put(tank+30,1);put(tank+31,0);put(tank+36,1);put(tank+37,0);put(tank+38,0)
        put(shot,6);put(shot+1,4);put(shot+2,2);put(shot+3,1);put(symbols.shot_fast,0)
        put(symbols.spawned,20);put(symbols.freeze,250);put(symbols.freeze+1,0)
        put(symbols.bonus,0);put(symbols.clock_high,0)
        for i=0,3 do put(symbols.scores+i,0) end
        put(symbols.rng,seed);put(symbols.rng_index,0x14)
    end
end
local function drop_result()
    local types={2,3,6,1,5,4}
    local kind=classic and types[read(0x88)+1] or read(symbols.bonus)
    local x=classic and read(0x86)-24 or read(symbols.bonus_x)
    local y=classic and read(0x87)-24 or read(symbols.bonus_y)
    return string.format("%d,%d,%d,%d,%d",tick-100,kind,x,y,
        read(classic and 0x10 or symbols.rng_index)-0x14)
end
local finished=false
watch(classic and 0xc2e6 or symbols.play,"install_read_tap",function()
    if not origin or finished then return end
    local drops=scenario=="drops"
    if (drops and tick>=100) or (not drops and tick>0) then
        local row
        if drops then row=drop_result()
        else
            local tanks,shots,actions=sample()
            row=string.format("%d,%d,%s,%s,%s",tick,frame-origin,tanks,shots,actions)
        end
        if out then out:write(row,"\n") end
        local want=expected and expected:read("*l")
        if expected and want~=row then
            print("BATTLECITY_COMBAT_FAILED "..scenario.." expected "..tostring(want).." got "..row)
            finished=true;machine:exit();return
        end
        events={}
        if (drops and tick==108) or tick==600 then
            if out then out:close() end
            if expected then
                local extra=expected:read("*l");expected:close()
                if extra then
                    print("BATTLECITY_COMBAT_FAILED "..scenario.." unexpected remaining row "..extra)
                    finished=true;machine:exit();return
                end
            end
            finished=true
            print("BATTLECITY_COMBAT_OK")
            machine:exit();return
        end
    end
    tick=tick+1
    if drops and tick>=100 then carrier_hit((tick-100)%8,tick==108) end
end)
combat_subscription=emu.add_machine_frame_notifier(function()
    frame=frame+1
    local t=origin and frame-origin or 0
    local coop=scenario=="coop"
    pads[1][4]:set_value(coop and frame>=300 and frame<305 and 1 or 0)
    pads[1][8]:set_value((frame>=330 and frame<335 or frame>=420 and frame<425) and 1 or 0)
    pads[1][16]:set_value((scenario=="solo" or coop) and t>=145 and t<232 and 1 or 0)
    pads[1][128]:set_value((scenario=="solo" or coop) and t>=252 and t<276 and 1 or 0)
    pads[1][1]:set_value((scenario=="solo" or coop) and t>=157 and t<540 and t%47<3 and 1 or 0)
    pads[2][16]:set_value(coop and t>=150 and t<263 and 1 or 0)
    pads[2][64]:set_value(coop and t>=287 and t<308 and 1 or 0)
    pads[2][2]:set_value(coop and t>=170 and t<530 and t%61<3 and 1 or 0)
    if frame>1900 and not finished then print("BATTLECITY_COMBAT_FAILED timeout");machine:exit() end
end)
