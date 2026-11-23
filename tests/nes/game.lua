-- Build the homebrew with --labels and set BATTLECITY_LABELS for this harness.
local addresses = {}
for line in io.lines(assert(os.getenv("BATTLECITY_LABELS"))) do
    local hex, name = line:match("^al (%x+) %._([%w_]+)$")
    if name then addresses[name] = tonumber(hex, 16) end
end
local machine = manager.machine
local ram = machine.devices[":maincpu"].spaces.program
local function get(name, offset) return ram:read_u8(assert(addresses[name]) + (offset or 0)) end
local function put(name, value, offset) ram:write_u8(assert(addresses[name]) + (offset or 0), value) end
local function word(name, value)
    put(name, value & 255)
    put(name, value >> 8, 1)
end
local pads = {{}, {}}
for tag, port in pairs(machine.ioport.ports) do
    local n = tonumber(tag:match(":ctrl(%d)"))
    if n then
        for _, f in pairs(port.fields) do
            if f.enabled and f.type_class == "controller" then pads[n][f.mask] = f end
        end
    end
end
-- All actions run from the MAME frame callback. This also works on the
-- WebAssembly Lua runtime, where yielding a Lua coroutine crosses a C++ frame.
local steps, cursor = {}, 1
local function add(fn) steps[#steps+1]=fn end
local function once(fn) add(function() fn(); return true end) end
local function wait(frames)
    add(function()
        if frames==0 then return true end
        frames=frames-1
        return false
    end)
end
local function key(port,mask,ticks)
    once(function() assert(pads[port][mask]):set_value(1) end)
    wait(ticks or 5)
    once(function() pads[port][mask]:set_value(0) end)
    wait(5)
end
local function until_value(name,expected,offset,limit)
    local timeout=limit or 160
    add(function()
        if get(name,offset)==expected then return true end
        timeout=timeout-1
        assert(timeout>0,string.format("%s expected %d got %d (stage %d, defeated %d, tank %d/%d/%d, shot %d/%d/%d, board %d)",
            name,expected,get(name,offset),get("stage"),get("defeated"),get("tanks",26),get("tanks",27),
            get("tanks",29),get("shots"),get("shots",1),get("shots",3),get("board")))
        return false
    end)
end

local function live_stage()
    wait(280)
    key(1,4); key(1,8); until_value("mode",6); wait(30)
    key(1,8); until_value("mode",1); wait(40)
    -- Advance through the two open lanes, then fire toward the middle spawn.
    local tick=0
    local turned={false,false}
    add(function()
        tick=tick+1
        for p=1,2 do
            local y=get("tanks",(p-1)*13+1)
            local advance,target_direction=16,p==1 and 128 or 64
            local target_y=p==1 and 16 or 32
            if y<=target_y then turned[p]=true end
            local direction=not turned[p] and advance or (get("tanks",(p-1)*13+2)==(p==1 and 1 or 3) and 0 or target_direction)
            for _,mask in ipairs({16,32,64,128}) do
                pads[p][mask]:set_value(direction==mask and 1 or 0)
            end
            pads[p][1]:set_value(tick%12<4 and 1 or 0)
        end
        if get("defeated")>0 then
            assert(get("scores")>0 or get("scores",4)>0,"natural hit failed to score")
            return true
        end
        assert(tick<5000 and get("mode")==1,"no natural enemy hit")
        return false
    end)
end

local function editor_and_players()
    wait(280)
    until_value("mode",0)
    key(1,4); key(1,4); key(1,8); until_value("mode",2); wait(45)
    key(1,128); key(1,1)
    once(function() assert(get("design",1)==26,"editor brick") end)
    key(1,8); until_value("mode",0); wait(30)
    key(1,4); key(1,8); until_value("mode",6); wait(25)
    key(1,1); until_value("stage",1); key(1,2); key(1,8); until_value("mode",1); wait(45)
    once(function() assert(get("players")==2 and get("board",1)==26,"co-op custom map") end)
    key(1,16,12); key(2,16,12)
    once(function() assert(get("tanks",1)<192 and get("tanks",14)<192,"players did not move") end)
    key(1,1); key(2,1); key(1,8); until_value("mode",5)
    local before
    once(function() before=get("tanks",14) end)
    key(2,16,12)
    once(function() assert(before==get("tanks",14),"pause moved player") end)
    key(1,8); until_value("mode",1)
end

local function replay(battle_only)
    local screen,trace=machine.screens[":screen"],{}
    for pass=1,2 do
        once(function()
            if pass==1 then machine:save("field") else machine:load("field") end
        end)
        -- The display pipeline needs three neutral frames after restoring.
        wait(3)
        for tick=1,90 do
            once(function()
                pads[1][16]:set_value(tick<30 and 1 or 0)
                pads[2][128]:set_value(tick>=30 and tick<60 and 1 or 0)
                pads[1][1]:set_value(tick%18==0 and 1 or 0)
                pads[2][1]:set_value(tick%23==0 and 1 or 0)
            end)
            wait(1)
            once(function()
                local state={screen:pixels(),string.char(get("rng"),get("rng_index"),get("clock_high"))}
                for i=0,103 do state[#state+1]=string.char(get("tanks",i)) end
                for i=0,39 do state[#state+1]=string.char(get("shots",i)) end
                local sample=table.concat(state)
                if pass==1 then trace[tick]=sample
                else assert(sample==trace[tick],"replay diverged at "..tick) end
            end)
        end
    end
    once(function()
        assert(#trace==90)
        if battle_only then assert(trace[1]~=trace[90] and get("mode")==1 and get("stage")==0) end
    end)
end

local function terrain_and_pickups()
    once(function() put("board",31,14) end)
    for shot=1,2 do
        once(function() put("shots",18);put("shots",12,1);put("shots",2,2);put("shots",1,3) end)
        until_value("shots",0,3)
        wait(1)
        once(function()
            if shot==1 then assert((get("missing_bricks",27)&15)==3 and (get("board",14)&1)==1,"brick layer")
            else assert((get("board",14)&1)==0,"brick removal") end
        end)
    end
    local lives_before
    for _,kind in ipairs({1,1,1,2,3,4,5,6}) do
        once(function()
            lives_before=get("lives")
            put("tanks",0,9) -- clear friendly stun left by the replay
            put("bonus_x",get("tanks"));put("bonus_y",get("tanks",1));put("bonus",kind)
        end)
        until_value("bonus",0);wait(4)
        once(function()
            if kind==2 then assert(get("tanks",7)==3 and get("tanks",12)>0,"stars / helmet") end
            if kind==3 then assert(get("freeze",1)>0,"clock") end
            if kind==4 then assert(get("lives")==lives_before+1,"extra tank") end
            if kind==5 then
                for i=2,7 do assert(get("tanks",i*13+3)~=1,"grenade left an active enemy") end
            end
            if kind==6 then assert(get("board",149)>>4==2,"shovel") end
        end)
    end
    -- Enter the last three shovel timer units, aligned to the current frame.
    once(function() word("fortify",192-(get("combat_frame")&63)) end)
    until_value("board",28,149,40)
    until_value("board",44,149,24)
    until_value("fortify",0,0,200)
    once(function() assert(get("board",149)>>4==1,"shovel did not expire to brick") end)
    local address_tap, data_tap, high, address, water = nil, nil, nil, nil, {}
    once(function()
        address_tap=ram:install_write_tap(0x2006,0x2006,"water_address",function(_,v)
            if high then address=((high<<8)|v)&0x3fff;high=nil else high=v end
        end)
        data_tap=ram:install_write_tap(0x2007,0x2007,"water_palette",function(_,v)
            if address==0x3f09 or address==0x3f0a then water[address*256+v]=true end
            if address then address=address+1 end
        end)
    end)
    wait(76)
    once(function()
        address_tap:remove();data_tap:remove()
        for _,addr in ipairs({0x3f09,0x3f0a}) do
            assert(water[addr*256+60] and water[addr*256+18],"water palette did not alternate")
        end
    end)
end

-- Run these one-update fixtures at the cartridge's main-loop frame counter.
-- Video frames may pass while the 6502 is still processing the previous tick.
local function enemy_decisions()
    local cases, step, failure, tap = {}, 0, nil, nil
    local function fixture(slot,x,y,clock,seed)
        put("spawned",20); put("defeated",0); word("freeze",0)
        for i=0,9 do put("shots",0,4*i+3);put("shot_blast",0,i);put("shot_fast",0,i) end
        for i=0,168 do put("board",0,i) end
        for i=2,7 do put("tanks",0,13*i+3) end
        for i=0,1 do
            put("tanks",32+96*i,13*i); put("tanks",80,13*i+1); put("tanks",1,13*i+3)
        end
        local offset=13*slot
        put("tanks",x,offset); put("tanks",y,offset+1)
        put("tanks",0,offset+2); put("tanks",1,offset+3)
        put("tanks",1,offset+5); put("tanks",0,offset+6)
        put("tanks",0,offset+11); put("tanks",0,offset+12)
        word("battle_ticks",clock);put("clock_high",clock//64)
        put("combat_frame",(get("video_clock")-get("clock_origin")) & 255)
        put("rng",seed);put("rng_index",0x1c)
    end
    local function check_direction(slot,dir,action)
        assert(get("tanks",13*slot+2)==dir and get("tanks",13*slot+6)==action,
            "slot "..slot.." direction / pending decision")
    end
    local function at_tick(fn) cases[#cases+1]=fn end
    local function shot(slot,x,y,dir,speed)
        put("shots",x,slot*4);put("shots",y,slot*4+1)
        put("shots",dir,slot*4+2);put("shots",1,slot*4+3)
        put("shot_fast",speed,slot);put("shot_blast",0,slot)
    end
    at_tick(function()
        fixture(2,160,80,0,6); word("freeze",250)
        put("tanks",0,9); put("tanks",20,11); put("tanks",0,12)
        shot(1,35,77,2,1)
    end)
    at_tick(function()
        assert(get("tanks",9)==0 and get("shots",7)==0 and get("shot_blast",1)==0,
               "a shield must absorb a teammate's shot")
        put("tanks",0,11); shot(1,35,77,2,1)
    end)
    at_tick(function()
        assert(get("tanks",9)==200, "first friendly hit must start the stun")
        put("tanks",60,9); shot(1,35,77,2,1)
    end)
    at_tick(function()
        assert(get("tanks",9)>=59 and get("tanks",9)<=60 and get("shots",7)==0,
               "repeated friendly fire restarted the stun timer")
        fixture(2,80,80,0,6); word("freeze",250)
        put("tanks",3,31);put("tanks",4,30);put("tanks",0,36)
        put("tanks",3,7);put("tanks",0,9)
        shot(0,85,77,2,3)
    end)
    for remaining=3,1,-1 do
        at_tick(function()
            assert(get("tanks",30)==remaining and get("tanks",29)==1,"armour hit "..remaining)
            shot(0,85,77,2,3)
        end)
    end
    at_tick(function()
        assert(get("tanks",29)>=32,"fourth hit did not destroy armour")
        fixture(2,160,80,0,6);word("freeze",250)
        put("board",47,70);shot(0,84,77,2,1)
    end)
    at_tick(function()
        assert(get("board",70)==47 and get("shots",3)==0,"steel absorbed normal shell")
        shot(0,84,77,2,3)
    end)
    at_tick(function()
        assert((get("board",70)&1)==0,"upgraded cannon left steel intact")
        shot(8,60,40,1,0);shot(2,68,40,3,0)
    end)
    at_tick(function()
        assert(get("shots",35)==0 and get("shots",11)==0,"opposing secondary shell did not cancel")
        shot(0,44,40,1,1);put("press",128)
    end)
    at_tick(function()
        assert(get("shots",35)==1 and get("shots",32)==48 and get("shots",3)==1,
               "upgrade did not retain the flying shell in the second slot")
        fixture(2,160,80,0,6);word("freeze",250)
        put("tanks",1,2);put("tanks",0,8);put("tanks",0,9);word("fortify",0)
        put("board",95,67);put("pads",1)
    end)
    for _=1,3 do at_tick(function() put("pads",1) end) end
    local ice_x, ice_timer, ice_tread
    at_tick(function()
        ice_x,ice_timer,ice_tread=get("tanks"),get("tanks",8),get("tread")
        assert((ice_timer&0x90)==0x90 and (ice_timer&31)<=28,"ice did not engage")
        put("pads",2) -- try to reverse before steering is available
    end)
    for _=1,3 do at_tick(function() put("pads",0) end) end
    at_tick(function()
        assert(get("tanks")==ice_x+3 and get("tanks",2)==1 and get("tanks",8)==ice_timer-3,
               "ice must preserve heading and coast on three of four video frames")
        assert(get("tread")==ice_tread,"the tracks must remain stationary while sliding")
        fixture(2,160,80,0,6);word("freeze",250)
        put("tanks",0,8);put("tanks",0,11);put("tanks",0,12)
        put("board",79,67);put("has_trees",1)
    end)
    at_tick(function()
        local hidden=false
        for pos=0x200,0x2fc,4 do
            if ram:read_u8(pos+3)==48 and ram:read_u8(pos)==95 and (ram:read_u8(pos+2)&32)~=0 then hidden=true end
        end
        assert(hidden,"tree priority missing from tank sprite")
        put("has_trees",0)
    end)
    -- First co-op stage: 166-tick spawn interval, phase thresholds 20 and 41.
    at_tick(function() fixture(2,80,80,20*64,4) end)
    at_tick(function()
        check_direction(2,0,0)
        fixture(2,80,80,21*64,13)
    end)
    at_tick(function() check_direction(2,0,4) end)
    at_tick(function() check_direction(2,3,0); fixture(3,80,80,41*64,1) end)
    at_tick(function() check_direction(3,0,5) end)
    at_tick(function() check_direction(3,1,0); fixture(2,96,80,42*64,10) end)
    at_tick(function() check_direction(2,0,6) end)
    at_tick(function()
        check_direction(2,2,0)
        fixture(2,0,81,0,3); put("tanks",3,28)
    end)
    for _,state in ipairs({2,1,0}) do
        at_tick(function()
            check_direction(2,3,state); assert(get("tanks",26)==0,"blocked tank moved")
        end)
    end
    local off_slot
    at_tick(function()
        off_slot=2+(get("video_clock") & 1)
        fixture(off_slot,81,80,1,0)
        put("tanks",0,13*off_slot+5) -- alternate movement parity by slot
    end)
    at_tick(function()
        assert(get("shots",4*off_slot+3)==1 and get("tanks",13*off_slot+1)==80,"off-cycle enemy fire")
        fixture(2,81,80,1,0); word("freeze",10)
    end)
    at_tick(function()
        assert(get("shots",11)==0 and get("tanks",27)==80,"frozen enemy moved or fired")
    end)
    -- The carrier hit and reroll cases use independent reference rows in combat.lua.
    -- Block the centre entry with both a live player and a custom brick.
    -- Slot 6 stays occupied while slot 7 explodes, frees up, then respawns.
    at_tick(function()
        fixture(6,48,64,0,77);word("freeze",250)
        put("tanks",96);put("tanks",0,1);put("tanks",0,9)
        put("board",31,6);put("spawned",0);put("spawn_clock",0)
    end)
    at_tick(function()
        assert(get("spawned")==1 and get("tanks",94)==29 and get("tanks",91)==96,"occupied spawn")
        assert(get("board",6)==0,"spawn terrain");pads[1][32]:set_value(1)
    end)
    for i=1,6 do at_tick(function() end) end
    at_tick(function()
        pads[1][32]:set_value(0)
        assert(get("tanks",1)>0,"overlapped player could not leave")
        put("tanks",56,94);put("spawn_clock",0)
        put("shots",80,28);put("shots",50,29);put("shots",2,30);put("shots",1,31)
    end)
    at_tick(function()
        assert(get("tanks",68)==29 and get("tanks",65)==192,"occupied slot reuse")
        put("tanks",33,94);put("tanks",1,96);put("tanks",1,97);put("spawn_clock",0)
    end)
    at_tick(function()
        assert(get("tanks",94)==29 and get("tanks",91)==0 and get("spawned")==3,"highest free slot")
        assert(get("shots",31)==1 and get("shots",29)>50,"slot reuse lost old projectile")
        fixture(2,0,0,0,91);word("freeze",250)
        put("tanks",64);put("tanks",144,1);put("tanks",0,11);put("tanks",0,12)
        put("lives",3);put("tanks",2,7);put("board",31,160)
        put("shots",68,8);put("shots",149,9);put("shots",2,10);put("shots",1,11)
    end)
    at_tick(function() assert(get("tanks",3)==56 and get("lives")==3,"player death") end)
    local respawned,ready
    for i=1,85 do
        at_tick(function()
            local status=get("tanks",3)
            if status>1 and status<=29 then
                respawned=true
                assert(get("tanks")==64 and get("tanks",1)==192 and get("tanks",7)==0,"respawn state")
                assert(get("board",160)==0 and get("lives")==2,"respawn tile / lives")
            elseif status==1 and respawned then
                ready=true
                assert((get("tanks",11)|get("tanks",12))~=0,"missing respawn shield")
            end
        end)
    end
    at_tick(function() assert(respawned and ready,"respawn sequence incomplete") end)
    once(function()
        local last=get("frame")
        tap=ram:install_write_tap(addresses.frame,addresses.frame,"enemy_fixture",function(_,value)
            if value==last or step>=#cases or failure then return end
            last=value;step=step+1
            local ok,err=pcall(cases[step])
            if not ok then failure="enemy fixture "..step..": "..tostring(err) end
        end)
    end)
    local timeout=330
    add(function()
        if failure then error(failure) end
        timeout=timeout-1
        assert(timeout>0,"enemy fixtures timed out")
        if step<#cases then return false end
        tap:remove()
        return true
    end)
end

local function score(name,offset)
    local value=0
    for i=3,0,-1 do value=(value<<8)+get(name,(offset or 0)+i) end
    return value
end

local function stages()
    -- Set up the final enemy in each stage. A projectile must score the hit
    -- and run the real clear, result-screen and next-stage code.
    local heard, cue_tap = {}, nil
    once(function()
        local base=addresses.audio_commands
        cue_tap=ram:install_write_tap(base,base+27,"result_cues",function(address,value)
            if value==1 then heard[address-base]=true end
        end)
    end)
    for stage=0,34 do
        local before1,before2
        once(function()
            assert(get("stage")==stage and get("mode")==1)
            before1=score("scores");before2=score("scores",4)
            for i=0,7 do put("kills",0,i) end
            if stage==1 then put("kills",1,4) end -- tie after P1's final hit
            if stage==2 or stage==3 then put("kills",2,4) end
            if stage==3 then put("lives",0,1);put("tanks",0,16) end
            put("spawned",20);put("defeated",19)
            -- Hold the final enemy while this fixture exercises projectile scoring.
            put("freeze",200);put("freeze",0,1)
            for i=2,7 do put("tanks",0,i*13+3) end
            for i=0,9 do put("shots",0,i*4+3) end
            put("board",0,0)
            put("tanks",0,26);put("tanks",0,27);put("tanks",1,29)
            put("tanks",1,30);put("tanks",0,31);put("tanks",0,37);put("tanks",0,38)
            put("shots",6);put("shots",7,1);put("shots",0,2);put("shots",1,3)
        end)
        until_value("mode",3,nil,500)
        if stage==0 then replay(false) end
        until_value("tally_row",6,nil,500)
        once(function()
            local bonus1=(stage==0 or stage>=4) and 1000 or 0
            local bonus2=stage==2 and 1000 or 0
            assert(score("scores")==before1+100+bonus1 and score("scores",4)==before2+bonus2,
                "co-op clear bonus, stage "..(stage+1))
            if stage==3 then put("lives",3,1) end
        end)
        if stage==0 then wait(68);replay(false) end
        until_value("mode",1,nil,450);wait(32)
    end
    -- Seed the stage-70 victory boundary to exercise the second-loop wrap.
    once(function()
        assert(get("stage")==35)
        put("stage",69);put("spawned",20);put("defeated",20)
    end)
    until_value("mode",3,nil,500);until_value("mode",1,nil,1200)
    once(function() assert(get("stage")==0,"stage 70 did not wrap to stage 1") end)
    wait(40)
    once(function() put("shots",99);put("shots",196,1);put("shots",2,2);put("shots",1,3) end)
    until_value("mode",4,nil,550);until_value("mode",7,nil,800)
    until_value("mode",8)
    once(function() assert(score("high_score")==score("scores"),"new record") end)
    wait(40)
    local record_frame
    once(function() record_frame=machine.screens[":screen"]:pixels() end)
    wait(1)
    once(function()
        assert(record_frame~=machine.screens[":screen"]:pixels(),"record lettering did not change color")
        for id=0x15,0x1b do assert(heard[id],"missing result cue "..id) end
        cue_tap:remove()
    end)
    wait(375);until_value("mode",8);until_value("mode",0);wait(245)
    key(1,8);until_value("mode",6);wait(25);key(1,8);until_value("mode",1);wait(40)
    once(function() put("shots",99);put("shots",196,1);put("shots",2,2);put("shots",1,3) end)
    until_value("mode",4,nil,550);until_value("mode",7,nil,800);until_value("mode",0)
end

if os.getenv("BATTLECITY_LIVE_CHECK")=="1" then live_stage()
else editor_and_players();replay(true);terrain_and_pickups();enemy_decisions();stages() end
once(function() print("BATTLECITY_GAME_OK");machine:exit() end)
game_subscription=emu.add_machine_frame_notifier(function()
    while steps[cursor] do
        local ok,done=pcall(steps[cursor])
        if not ok then
            print("BATTLECITY_GAME_FAILED",done)
            cursor=#steps+1
            machine:exit()
            return
        end
        if not done then return end
        cursor=cursor+1
    end
end)
