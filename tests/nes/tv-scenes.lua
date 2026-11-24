-- Keep the controller path for the moving shield/treads. Place only the two
-- incoming shots in the other fixture, then let the cartridge resolve both hits.
local ram=manager.machine.devices[":maincpu"].spaces.program
local pad={}
for tag,port in pairs(manager.machine.ioport.ports) do
    if tag:match(":ctrl1") then
        for _,field in pairs(port.fields) do
            if field.enabled and field.type_class=="controller" then pad[field.mask]=field end
        end
    end
end

local function update_scene(frame)
    if scene=="firing" or scene=="motion" then
        pad[128]:set_value(frame>=570 and frame<598 and 1 or 0)
        pad[16]:set_value(frame>=601 and frame<665 and 1 or 0)
        pad[1]:set_value((frame>=575 and frame<578 or frame>=618 and frame<621) and 1 or 0)
    elseif scene=="blast" and frame==684 then
        ram:write_u8(addr.tanks+11,0)
        ram:write_u8(addr.tanks+12,0)
        for _,hit in ipairs({{0,102,198},{2,70,196}}) do
            local slot,x,y=table.unpack(hit)
            local shot=addr.shots+4*slot
            ram:write_u8(shot,x)
            ram:write_u8(shot+1,y)
            ram:write_u8(shot+2,2)
            ram:write_u8(shot+3,1)
            ram:write_u8(addr.shot_fast+slot,0)
        end
    end
end

local function verify_scene()
    if scene=="firing" then
        assert(ram:read_u8(addr.shots+3)==1,"active P1 shell")
        assert(ram:read_u8(addr.tanks+11)>0 and ram:read_u8(addr.tread)==8,"moving shield and second tread pose")
    elseif scene=="blast" then
        local phase=ram:read_u8(addr.tanks+3)
        assert(phase>=42 and phase<=47,"large tank explosion: "..phase)
        assert(ram:read_u8(addr.ruined)==1,"headquarters hit")
    end
end
