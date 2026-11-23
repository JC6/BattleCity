-- One pair of hexadecimal NES controller masks per display frame, from reset.
-- This harness only observes the bus. Replaying never consults game state to choose inputs.
local m=manager.machine
local cpu=m.devices[":maincpu"]
local b=cpu.spaces.program
local function r(a) return b:read_u8(a) end
local classic=os.getenv("BATTLECITY_CLASSIC")=="1"
local name=assert(os.getenv("BATTLECITY_SCENARIO"))
local demo=name=="attract"
local loop=name=="loop"
local initial_stage=tonumber(os.getenv("BATTLECITY_STAGE") or "1")
local win_stage=initial_stage%70+1
local follow=tonumber(os.getenv("BATTLECITY_FOLLOW") or "0")
local following=0
local goal=os.getenv("BATTLECITY_GOAL") or (loop and "loop" or name=="solo" and "stage-"..win_stage or "title")
local labels,pads={},{{},{}}
if not classic then for l in io.lines(assert(os.getenv("BATTLECITY_LABELS"))) do
    local h,n=l:match("^al (%x+) %._([%w_]+)$");if n then labels[n]=tonumber(h,16) end
end end
local function sym(n) return assert(labels[n],n) end
for tag,port in pairs(m.ioport.ports) do
    local id=tonumber(tag:match(":ctrl(%d)"))
    if id then for _,f in pairs(port.fields) do
        if f.enabled and f.type_class=="controller" then pads[id][f.mask]=f end
    end end
end
local tape=not demo and assert(io.open(assert(os.getenv("BATTLECITY_INPUT"))))
local input,pos,exhausted="",1,nil
local function next_pads(frame)
    while tape and #input-pos+1<4 do
        local chunk=tape:read(32768)
        if not chunk then
            assert(pos==#input+1,"incomplete controller pair")
            tape:close();tape=nil;exhausted=frame
        else
            chunk=chunk:gsub("%s","")
            assert(not chunk:find("[^%x]"),"invalid controller input")
            input=input:sub(pos)..chunk;pos=1
        end
    end
    if not tape then return 0,0 end
    local first,second=tonumber(input:sub(pos,pos+1),16),tonumber(input:sub(pos+2,pos+3),16)
    pos=pos+4
    return first,second
end
local path=os.getenv("BATTLECITY_TRACE")
local out=path and assert(io.open(path,"w"))
path=os.getenv("BATTLECITY_GOLDENS")
local expected=path and assert(io.open(path))
local frame,tick,done,start=0,0,false,false
local fields={"display frame","battle update","tanks","shots","player lives/stars/shield/score","kill counts","enemies left","base destroyed","terrain digest"}
if demo then
    for _,field in ipairs({"clock","AI held/pressed","random reads"}) do fields[#fields+1]=field end
elseif loop then fields[#fields+1]="stage" end
local function split(line)
    local values={}
    for v in ((line or "")..","):gmatch("(.-),") do values[#values+1]=v end
    return values
end
local function write(line)
    if out then out:write(line,"\n") end
    if expected then
        local want=expected:read("*l")
        if line~=want then
            local a,b=split(want),split(line)
            for i=1,math.max(#a,#b) do
                if a[i]~=b[i] then
                    print(("BATTLECITY_CAMPAIGN_FAILED %s update %d, %s expected %s got %s"):format(
                        name,tick,fields[i] or tostring(i),tostring(a[i]),tostring(b[i])))
                    print("Display frame",frame)
                    break
                end
            end
            done=true;m:exit();return
        end
    end
end
local function finish(which)
    if done then return end
    write(frame..",end,"..which)
    if out then out:close() end
    if expected then
        if not done and expected:read("*l") then print("BATTLECITY_CAMPAIGN_FAILED "..name.." missing updates");done=true end
        expected:close()
    end
    if not done then
        if which~=goal then print("BATTLECITY_CAMPAIGN_FAILED "..name.." ended at "..which)
        else print("BATTLECITY_CAMPAIGN_OK") end
    end
    done=true;m:exit()
end
local function score(i)
    local v=0
    if classic then
        for j=0,6 do v=v*10+r(0x15+8*i+j) end
    else
        for j=3,0,-1 do v=v*256+r(sym("scores")+4*i+j) end
    end
    return v
end
-- Only recompute the terrain digest after a write to the field. Movement in
-- the reference can mark occupancy in the two high bits of a terrain byte.
local board_hash,dirty=nil,true
local function classic_tile(raw)
    if raw>=0xc8 and raw<=0xcf then return 48 end
    local tile=raw & 63
    return tile==32 and 0 or tile
end
local function terrain_hash()
    if not dirty then return board_hash end
    local h=2166136261
    for y=0,25 do for x=0,25 do
        local v
        if classic then
            v=classic_tile(r(0x442+y*32+x))
        else
            local cell=r(sym("board")+(y//2)*13+x//2)
            local kind=cell>>4
            if (cell & (1<<((y&1)*2+(x&1))))==0 then v=0
            elseif kind==1 then
                local missing=r(sym("missing_bricks")+y*13+x//2)
                v=15~((missing>>((x&1)*4))&15)
            else v=({[2]=16,[3]=18,[4]=34,[5]=33,[6]=48})[kind] or 0 end
        end
        h=((h~v)*16777619)&0xffffffff
    end end
    board_hash=("%08x"):format(h);dirty=false;return board_hash
end
local function sample()
    local tanks,shots,stats,kills={},{},{},{}
    for i=0,7 do
        local a=not classic and sym("tanks")+13*i
        local state=r(classic and 0xa0+i or a+3)
        local active=classic and state>=128 and state<224 or not classic and state==1
        if active then
            local x=classic and r(0x90+i)-24 or r(a)
            local y=classic and r(0x98+i)-24 or r(a+1)
            local dir=classic and (-state&3) or r(a+2)
            tanks[#tanks+1]=("%x%02x%02x%d"):format(i,x,y,dir)
        end
    end
    for i=0,9 do
        local a=not classic and sym("shots")+4*i
        local state=r(classic and 0xcc+i or a+3)
        if (classic and state>>4==4) or (not classic and state==1) then
            local x=classic and (r(0xb8+i)-18)%256 or r(a)
            local y=classic and (r(0xc2+i)-18)%256 or r(a+1)
            shots[#shots+1]=("%x%02x%02x%d"):format(i,x,y,classic and (-state&3) or r(a+2))
        end
    end
    for i=0,((name=="coop" or demo) and 1 or 0) do
        local lives=r(classic and 0x51+i or sym("lives")+i)
        local shield=classic and r(0x89+i) or (r(sym("tanks")+13*i+11)+256*r(sym("tanks")+13*i+12)+63)//64
        local stars=classic and (r(0xa8+i)>>5)&3 or r(sym("tanks")+13*i+7)
        -- An arriving tank has no equipped weapon until its spawn animation
        -- finishes. Its carried upgrade becomes visible on the first live tick.
        local state=r(classic and 0xa0+i or sym("tanks")+13*i+3)
        if (classic and state>=224) or (not classic and state>1 and state<=29) then stars=0 end
        stats[#stats+1]=("%d/%d/%d/%d"):format(lives,stars,shield,score(i))
        for k=0,3 do kills[#kills+1]=r(classic and 0x73+4*i+k or sym("kills")+4*i+k) end
    end
    local left=classic and r(0x80) or 20-r(sym("defeated"))
    local base=classic and (r(0x68)~=128) or not classic and (labels.ruined and r(labels.ruined)~=0 or not labels.ruined and r(sym("mode"))==4)
    return table.concat({frame,tick,table.concat(tanks,"."),table.concat(shots,"."),table.concat(stats,"."),table.concat(kills,"."),left,base and 1 or 0,terrain_hash()},",")
end
campaign_taps={}
local function observe_board(first,last)
    campaign_taps[#campaign_taps+1]=b:install_write_tap(first,last,"campaign_board_"..first,function() dirty=true end)
end
if classic then
    campaign_taps[#campaign_taps+1]=b:install_write_tap(0x442,0x77b,"campaign_board",function(addr,value)
        if not dirty and (addr-0x442)%32<26 then
            dirty=classic_tile(r(addr))~=classic_tile(value)
        end
    end)
else observe_board(sym("board"),sym("board")+168);observe_board(sym("missing_bricks"),sym("missing_bricks")+337) end
local function watch(pc,fn)
    campaign_taps[#campaign_taps+1]=b:install_read_tap(pc,pc,"campaign_"..pc,function()
        if not done and (cpu.state.PC.value==pc or cpu.state.PC.value==pc+1) then fn() end
    end)
end
local last_stage,transitions=nil,0
local pending,clock,ai,reads
local function demo_controls()
    local buttons={}
    for _,a in ipairs(classic and {6,7,8,9} or {sym("pads"),sym("pads")+1,sym("press"),sym("press")+1}) do
        local v=r(a)
        if not classic then
            local reversed=0
            for _=1,8 do reversed=(reversed<<1)|(v&1);v=v>>1 end
            v=reversed
        end
        buttons[#buttons+1]=("%02x"):format(v)
    end
    ai=table.concat(buttons)
    clock=("%02x%02x"):format(r(classic and 10 or sym("clock_high")),r(classic and 11 or sym("combat_frame")))
end
local function flush_demo()
    if not pending then return end
    write(table.concat({pending,clock or "",ai or "",table.concat(reads,".")},","))
    pending=nil
end
if demo then
    if not classic then watch(sym("snapshot_occupancy"),function() if pending then demo_controls() end end) end
    watch(classic and 0xd460 or sym("rng_mix"),function()
        if not pending then return end
        local index=r(classic and 16 or sym("rng_index"))
        reads[#reads+1]=("%02x%02x%02x"):format(index,classic and r(index) or cpu.state.A.value,
            r(classic and 15 or sym("rng")))
    end)
end
watch(classic and 0xc2e6 or sym("play"),function()
    if frame>470 then
        if demo then
            flush_demo()
            if done then return end
            start=true;tick=tick+1
            pending=sample();clock=nil;ai=nil;reads={}
            if classic then demo_controls() end
            return
        end
        local stage=classic and r(0x85) or r(sym("stage"))+1
        if not start and stage~=initial_stage then finish("unexpected-stage-"..stage);return end
        if loop and last_stage and stage~=last_stage then
            if stage~=last_stage%70+1 then finish("unexpected-stage-"..stage);return end
            transitions=transitions+1
            print("BATTLECITY_LOOP_STAGE",stage,frame,tick)
        end
        last_stage=stage
        if loop and transitions==70 or not loop and start and stage==win_stage then
            if following>=follow then finish(loop and "loop" or "stage-"..stage);return end
            following=following+1
        end
        start=true;tick=tick+1;write(sample()..(loop and ","..stage or ""))
    end
end)
watch(classic and (demo and 0xc09c or 0xc095) or sym("title"),function()
    if start then
        if demo then flush_demo() end
        finish("title")
    end
end)
campaign_frame=emu.add_machine_frame_notifier(function()
    frame=frame+1
    local first,second=next_pads(frame)
    for p=1,2 do
        local mask=p==1 and first or second
        for key,f in pairs(pads[p]) do f:set_value(mask&key~=0 and 1 or 0) end
    end
    if ((demo and frame>12000) or (exhausted and frame>=exhausted+1500)) and not done then finish("timeout") end
end)
