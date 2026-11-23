-- Cold boot, select the requested stage using pad 1, then inspect the first
-- rendered battlefield. No CPU, controller RAM or video memory is written.
local m = manager.machine
local cpu = m.devices[":maincpu"]
local ram = cpu.spaces.program
local vram = m.devices[":ppu"].spaces.videoram
local stage = assert(tonumber(os.getenv("BATTLECITY_STAGE")))
local classic = os.getenv("BATTLECITY_CLASSIC") == "1"
local labels, buttons = {}, {}
if not classic then
    for line in io.lines(assert(os.getenv("BATTLECITY_LABELS"))) do
        local address, name = line:match("^al (%x+) %._([%w_]+)$")
        if name then labels[name] = tonumber(address, 16) end
    end
end
for tag, port in pairs(m.ioport.ports) do
    if tag:match(":ctrl1") then
        for _, field in pairs(port.fields) do
            if field.enabled and field.type_class == "controller" then buttons[field.mask] = field end
        end
    end
end
local frame, first = 0, nil
local confirm = 420 + 8 * (stage - 1)
local play = classic and 0xc2e6 or labels.play
stage_observer = ram:install_read_tap(play, play, "first_play", function()
    if not first and frame > confirm and (cpu.state.PC.value == play or cpu.state.PC.value == play+1) then first = frame end
end)
local function snapshot()
    local index = ram:read_u8(classic and 0x85 or labels.stage) + (classic and 0 or 1)
    assert(index == stage, "selected " .. index .. ", expected " .. stage)
    local lines = {}
    for y = 0, 25 do
        local row = {}
        for x = 0, 25 do
            row[#row+1] = string.format("%02x", vram:read_u8(0x2042+y*32+x))
        end
        lines[#lines+1] = table.concat(row)
    end
    local icons = {}
    for i=0,19 do icons[#icons+1] = string.format("%02x",vram:read_u8(0x207d+(i//2)*32+i%2)) end
    lines[#lines+1] = table.concat(icons)
    local function pos(i, axis)
        if classic then return ram:read_u8((axis==0 and 0x90 or 0x98)+i)-24 end
        return ram:read_u8(labels.tanks+i*13+axis)
    end
    lines[#lines+1] = string.format("%d,%d,%d,%d",pos(0,0),pos(0,1),pos(5,0),pos(5,1))
    print("BATTLECITY_STAGE_FIELD " .. table.concat(lines,"/"))
end
stage_frames = emu.add_machine_frame_notifier(function()
    frame=frame+1
    local mask=0
    if (frame>=330 and frame<335) or (frame>=confirm and frame<confirm+4) then mask=8 end
    if frame>=395 and frame<395+8*(stage-1) and (frame-395)%8==0 then mask=1 end
    for key,field in pairs(buttons) do field:set_value(mask&key~=0 and 1 or 0) end
    if first and frame>=first+8 then
        local ok,err=pcall(snapshot)
        if not ok then print("BATTLECITY_STAGE_FAILED "..tostring(err)) end
        m:exit()
    elseif frame>confirm+400 then print("BATTLECITY_STAGE_FAILED stage never started");m:exit() end
end)
