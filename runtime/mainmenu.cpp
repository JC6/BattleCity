// SPDX-License-Identifier: BSD-3-Clause
#include "emu.h"
#include "ui/mainmenu.h"
#include "wallpaper-previews.h"
#include "fileio.h"
#include "util/ioprocs.h"
#include "rendutil.h"
#include "video.h"
#include <atomic>
#include <ctime>
#include <sys/stat.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#elif defined(__ANDROID__)
#include <jni.h>
extern "C" void *SDL_GetAndroidJNIEnv();
extern "C" void *SDL_GetAndroidActivity();
#endif

void battlecity_menu_visible(bool visible)
{
    static bool previous=false;
    if (previous==visible) return;
    previous=visible;
#ifdef __EMSCRIPTEN__
    EM_ASM({ document.getElementById("display").dataset.menu=String($0); }, int(visible));
#elif defined(__ANDROID__)
    auto *env=static_cast<JNIEnv *>(SDL_GetAndroidJNIEnv());
    auto activity=static_cast<jobject>(SDL_GetAndroidActivity());
    if (!activity) return;
    auto type=env->GetObjectClass(activity);
    auto method=env->GetMethodID(type,"showSystemMenu","(Z)V");
    env->CallVoidMethod(activity,method,jboolean(visible));
    env->DeleteLocalRef(type);
    env->DeleteLocalRef(activity);
#endif
}

// The SDL software renderer and the menu share two presentation flags.
// The emulated NES framebuffer and save states remain independent of them.
int battlecity_picture(int requested)
{
    static std::atomic<int> active{-1};
    int value=active.load(std::memory_order_relaxed);
    if (requested<0 && value>=0) return value;
#ifdef __EMSCRIPTEN__
    value=EM_ASM_INT({ return Module.pictureMode($0); }, requested);
#elif defined(__ANDROID__)
    auto *env=static_cast<JNIEnv *>(SDL_GetAndroidJNIEnv());
    auto activity=static_cast<jobject>(SDL_GetAndroidActivity());
    if (!activity) return 0;
    auto type=env->GetObjectClass(activity);
    auto method=env->GetMethodID(type,"pictureMode","(I)I");
    value=env->CallIntMethod(activity,method,jint(requested));
    env->DeleteLocalRef(type);
    env->DeleteLocalRef(activity);
#else
    value=std::max(0,requested);
#endif
    active.store(value,std::memory_order_relaxed);
    return value;
}

namespace ui {
namespace {
enum action : uintptr_t { save = 1, load, settings, reset_game, resume };

void panel(render_container &c, float x, float y, float w, float h, bool focused = false)
{
    c.add_rect(x, y, x+w, y+h, focused ? rgb_t(166,201,255) : rgb_t(25,63,120), PRIMFLAG_BLENDMODE(BLENDMODE_ALPHA));
    c.add_rect(x+.004f, y+.005f, x+w-.004f, y+h-.005f, rgb_t(255,4,9,20), PRIMFLAG_BLENDMODE(BLENDMODE_ALPHA));
}

void label(mame_ui_manager &ui, render_target &target, std::string_view value, float x, float y, float w, float size)
{
    ui.draw_text_full(target, value, x, y, w, text_layout::text_justify::CENTER,
        text_layout::word_wrapping::TRUNCATE, mame_ui_manager::NORMAL, rgb_t::white(),
        rgb_t(0,0,0,0), nullptr, nullptr, size);
}

} // anonymous namespace

class battle_slots
{
public:
    explicit battle_slots(running_machine &machine) : m_machine(machine) {}
    ~battle_slots() { clear(); }
    void refresh()
    {
        clear();
        for (unsigned i=0; i<m_cards.size(); ++i) {
            char const *search = nullptr;
            auto path = m_machine.compose_saveload_filename(std::to_string(i+1), &search);
            emu_file state(search ? search : "", OPEN_FLAG_READ);
            if (state.open(path)) continue;
            auto &card=m_cards[i];
            card.date="Saved";
            card.path=state.fullpath();
            emu_file lock(OPEN_FLAG_READ);
            card.locked=!lock.open(card.path+".lock");
            struct stat info;
            if (!stat(state.fullpath(), &info)) {
                char date[16];
                if (auto *local=std::localtime(&info.st_mtime); local && std::strftime(date,sizeof(date),"%Y/%m/%d",local))
                    card.date=date;
            }
            emu_file preview(search ? search : "", OPEN_FLAG_READ);
            if (!preview.open(path+".png"))
                render_load_png(card.bitmap,preview); // Returns transparency, including false for a valid opaque PNG.
            if (card.bitmap.valid()) {
                card.texture=m_machine.render().texture_alloc();
                card.texture->set_bitmap(card.bitmap,card.bitmap.cliprect(),TEXFORMAT_ARGB32);
            }
        }
    }
    bool occupied(unsigned i) const { return !m_cards[i].date.empty(); }
    bool locked(unsigned i) const { return m_cards[i].locked; }
    void toggle_lock(unsigned i)
    {
        auto &card=m_cards[i];
        if (!occupied(i)) return;
        auto const path=card.path+".lock";
        if (card.locked) {
            if (std::remove(path.c_str())) return;
        } else {
            emu_file file(OPEN_FLAG_WRITE | OPEN_FLAG_CREATE);
            if (file.open(path)) return;
        }
        card.locked=!card.locked;
#ifdef __EMSCRIPTEN__
        EM_ASM({ Module.persistGameState("Slot lock saved."); });
#endif
    }
    void draw(mame_ui_manager &ui, render_target &target, int selected) const
    {
        auto &c=*target.ui_container();
        for (unsigned i=0; i<m_cards.size(); ++i) {
            float x=.125f+.195f*i;
            auto const &card=m_cards[i];
            panel(c,x,.366f,.166f,.285f,int(i)==selected);
            label(ui,target,card.date+"   "+std::to_string(i+1)+(card.locked ? "  [L]" : ""),x,.369f,.166f,.027f);
            if (card.texture)
                c.add_quad(x+.007f,.405f,x+.159f,.642f,rgb_t::white(),card.texture,PRIMFLAG_BLENDMODE(BLENDMODE_ALPHA));
            else
                label(ui,target,occupied(i) ? "Saved" : "Empty",x,.505f,.166f,.034f);
        }
    }
private:
    struct card { std::string date, path; bool locked=false; bitmap_argb32 bitmap; render_texture *texture=nullptr; };
    void clear()
    {
        for (auto &card:m_cards) {
            if (card.texture) m_machine.render().texture_free(card.texture);
            card.texture=nullptr;
            card.bitmap.reset();
            card.date.clear();
            card.path.clear();
            card.locked=false;
        }
    }
    running_machine &m_machine;
    std::array<card,4> m_cards;
};

namespace {

int preference(bool wallpaper, int requested)
{
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({ return $0 ? Module.wallpaperMode($1) : Module.screenMode($1); }, int(wallpaper), requested);
#elif defined(__ANDROID__)
    auto *env = static_cast<JNIEnv *>(SDL_GetAndroidJNIEnv());
    auto activity = static_cast<jobject>(SDL_GetAndroidActivity());
    if (!activity) return 0;
    auto type = env->GetObjectClass(activity);
    auto method = env->GetMethodID(type, wallpaper ? "wallpaperMode" : "screenMode", "(I)I");
    int result = env->CallIntMethod(activity, method, jint(requested));
    env->DeleteLocalRef(type);
    env->DeleteLocalRef(activity);
    return result;
#else
    return 0;
#endif
}

// Wait for release before passing control to another page or to the cartridge.
class choice_menu : public menu
{
public:
    choice_menu(mame_ui_manager &ui, render_target &target, std::string title)
        : menu(ui, target) { set_heading(std::move(title)); }
private:
    virtual void choose(uintptr_t value) = 0;
    virtual void horizontally(int delta) {}
    virtual void auxiliary(int key) {}
    bool handle(event const *ev) override
    {
        if (ev && (ev->iptkey == IPT_UI_LEFT || ev->iptkey == IPT_UI_RIGHT)) {
            horizontally(ev->iptkey == IPT_UI_LEFT ? -1 : 1);
            return true;
        }
        if (ev) auxiliary(ev->iptkey);
        if (ev && ev->iptkey == IPT_UI_SELECT)
            pending = reinterpret_cast<uintptr_t>(ev->itemref);
        if (pending && !machine().ioport().type_pressed(IPT_UI_SELECT)) {
            auto value = pending;
            pending = 0;
            choose(value);
        }
        return false;
    }
    uintptr_t pending = 0;
};

class overwrite_menu : public choice_menu
{
public:
    overwrite_menu(mame_ui_manager &ui, render_target &target, uintptr_t slot)
        : choice_menu(ui, target, "Overwrite Slot " + std::to_string(slot) + "?"), slot(slot) {}
private:
    uintptr_t slot;
    void populate() override
    {
        item_append("Cancel", 0, reinterpret_cast<void *>(1));
        item_append("Overwrite", 0, reinterpret_cast<void *>(2));
    }
    void choose(uintptr_t value) override
    {
        if (value == 1) stack_pop();
        else {
            machine().schedule_save(std::to_string(slot));
            stack_reset();
        }
    }
};

class slots_menu : public choice_menu
{
public:
    slots_menu(mame_ui_manager &ui, render_target &target, bool saving)
        : choice_menu(ui, target, saving ? "Save" : "Load"), saving(saving), cards(machine())
    {
        set_needs_prev_menu_item(false);
        set_process_flags(PROCESS_LR_ALWAYS);
        cards.refresh();
    }
private:
    bool saving;
    battle_slots cards;
    bool exists(uintptr_t slot) const { return cards.occupied(slot-1); }
    void auxiliary(int key) override
    {
        if (key==IPT_UI_CLEAR) cards.toggle_lock(selected_index());
    }
    void populate() override
    {
        for (uintptr_t slot=1; slot<=4; ++slot)
            item_append("Slot " + std::to_string(slot),0,reinterpret_cast<void *>(slot));
    }
    void horizontally(int delta) override { set_selected_index((selected_index()+delta+4)%4); }
    void draw(uint32_t) override
    {
        panel(container(),.045f,.12f,.91f,.70f);
        label(ui(),target(),saving ? "Save" : "Load",.2f,.19f,.6f,.052f);
        cards.draw(ui(),target(),selected_index());
#ifdef __ANDROID__
        label(ui(),target(),"West button: Lock / Unlock",.2f,.715f,.6f,.033f);
#else
        label(ui(),target(),"Delete: Lock / Unlock",.2f,.715f,.6f,.033f);
#endif
    }
    void choose(uintptr_t slot) override
    {
        if ((!saving && !exists(slot)) || (saving && cards.locked(slot-1))) return;
        if (saving && exists(slot)) {
            stack_push<overwrite_menu>(ui(), target(), slot);
            return;
        }
        if (saving) machine().schedule_save(std::to_string(slot));
        else machine().schedule_load(std::to_string(slot));
        stack_reset();
    }
};

class display_menu : public choice_menu
{
public:
    display_menu(mame_ui_manager &ui, render_target &target, bool wallpaper)
        : choice_menu(ui,target,wallpaper ? "Wallpaper Settings" : "Screen Settings"), wallpaper(wallpaper)
    {
        set_needs_prev_menu_item(false);
        set_process_flags(PROCESS_LR_ALWAYS);
        int width=0, height=0;
        machine().video().compute_snapshot_size(width,height);
        if (wallpaper) {
            static uint8_t const *const images[]={wallpaper_surround_jpeg,wallpaper_stars_jpeg,wallpaper_symbols_jpeg};
            static constexpr size_t sizes[]={sizeof(wallpaper_surround_jpeg),sizeof(wallpaper_stars_jpeg),sizeof(wallpaper_symbols_jpeg)};
            for (size_t i=0;i<wall_textures.size();++i) {
                if (auto input=util::ram_read(images[i],sizes[i])) render_load_jpeg(wall_bitmaps[i],*input);
                if (!wall_bitmaps[i].valid()) continue;
                auto *item=machine().render().texture_alloc();
                item->set_bitmap(wall_bitmaps[i],wall_bitmaps[i].cliprect(),TEXFORMAT_ARGB32);
                wall_textures[i]=item;
            }
        } else if (width>0 && height>0) {
            bitmap.allocate(width,height);
            machine().video().pixels(&bitmap.pix(0));
            for (int y=0;y<height;++y)
                for (int x=0;x<width;++x) bitmap.pix(y,x)|=0xff000000;
            texture=machine().render().texture_alloc();
            texture->set_bitmap(bitmap,bitmap.cliprect(),TEXFORMAT_ARGB32);
        }
    }
    ~display_menu() override {
        if (texture) machine().render().texture_free(texture);
        for (auto *item:wall_textures) if (item) machine().render().texture_free(item);
    }
private:
    bool wallpaper;
    std::array<bitmap_argb32,3> wall_bitmaps;
    std::array<render_texture *,3> wall_textures{};
    bitmap_argb32 bitmap;
    render_texture *texture=nullptr;
    static constexpr char const *screens[]={"4:3","Zoom","Dot-by-Dot","Full Screen"};
    static constexpr char const *walls[]={"Original","Stars","Symbols","Black"};
    void populate() override
    {
        for (int i=0;i<4;++i)
            item_append(wallpaper ? walls[i] : screens[i],0,reinterpret_cast<void *>(uintptr_t(i+1)));
        if (!wallpaper) {
            item_append("Anti-Aliasing",0,reinterpret_cast<void *>(6));
            item_append("Scan Lines",0,reinterpret_cast<void *>(7));
        }
        item_append("Return to Settings",0,reinterpret_cast<void *>(5));
    }
    void horizontally(int delta) override
    {
        if (selected_index()<4) set_selected_index((selected_index()+4+delta)%4);
    }
    void choose(uintptr_t value) override
    {
        if (value==5) stack_pop();
        else if (value==6 || value==7) battlecity_picture(battlecity_picture(-1) ^ (value==6 ? 1 : 2));
        else preference(wallpaper,int(value)-1);
    }
    void preview(int i,float x,float y,float w,float h) const
    {
        if (wallpaper) {
            if (size_t(i)<wall_textures.size() && wall_textures[i])
                container().add_quad(x,y,x+w,y+h,rgb_t::white(),wall_textures[i],PRIMFLAG_BLENDMODE(BLENDMODE_ALPHA));
            else
                container().add_rect(x,y,x+w,y+h,rgb_t::black(),PRIMFLAG_BLENDMODE(BLENDMODE_ALPHA));
            return;
        }
        if (!texture) return;
        static constexpr float width_factors[]={.62f,.80f,.55f,.96f};
        static constexpr float height_factors[]={.78f,.97f,.78f,.97f};
        float dx=w*(1-width_factors[i])/2,dy=h*(1-height_factors[i])/2;
        container().add_quad(x+dx,y+dy,x+w-dx,y+h-dy,rgb_t::white(),texture,PRIMFLAG_BLENDMODE(BLENDMODE_ALPHA));
    }
    void draw(uint32_t) override
    {
        panel(container(),.025f,.055f,.95f,.875f);
        label(ui(),target(),wallpaper ? "Wallpaper Settings" : "Screen Settings",.1f,.095f,.8f,.053f);
        int current=preference(wallpaper,-1);
        panel(container(),.33f,.21f,.34f,.27f);
        preview(current,.34f,.219f,.32f,.252f);
        for (int i=0;i<4;++i) {
            float x=.06f+.223f*i;
            panel(container(),x,.56f,.21f,.115f,selected_index()==i);
            preview(i,x+.006f,.566f,.198f,.103f);
            label(ui(),target(),wallpaper ? (current==i ? "On" : "") : screens[i],x,.69f,.21f,.036f);
        }
        if (!wallpaper) {
            int picture=battlecity_picture(-1);
            for (int i=0;i<2;++i) {
                float y=.255f+.085f*i;
                panel(container(),.697f,y,.245f,.066f,selected_index()==i+4);
                std::string name=i ? "Scan Lines" : "Anti-Aliasing";
                label(ui(),target(),name+(picture & (1<<i) ? "  On" : "  Off"),.697f,y+.012f,.245f,.034f);
            }
        }
        panel(container(),.29f,.805f,.42f,.072f,selected_index()==(wallpaper ? 4 : 6));
        label(ui(),target(),"Return to Settings",.29f,.818f,.42f,.040f);
    }
};

class reset_menu : public choice_menu
{
public:
    reset_menu(mame_ui_manager &ui, render_target &target) : choice_menu(ui,target,"Reset Battle City?") {}
private:
    void populate() override
    {
        item_append("Cancel",0,reinterpret_cast<void *>(1));
        item_append("Game Reset",0,reinterpret_cast<void *>(2));
    }
    void choose(uintptr_t value) override
    {
        if (value==2) { machine().schedule_soft_reset(); stack_reset(); }
        else stack_pop();
    }
};

class information_menu : public choice_menu
{
public:
    information_menu(mame_ui_manager &ui, render_target &target, bool controls)
        : choice_menu(ui,target,controls ? "Controller Settings" : "Staff Credits"), controls(controls)
    { set_needs_prev_menu_item(false); }
private:
    bool controls;
    void populate() override
    {
#ifdef __ANDROID__
        if (controls) item_append("Pair Gamepads",0,reinterpret_cast<void *>(2));
#endif
        item_append("Return to Settings",0,reinterpret_cast<void *>(1));
    }
    void choose(uintptr_t value) override
    {
#ifdef __ANDROID__
        if (value==2) {
            auto *env=static_cast<JNIEnv *>(SDL_GetAndroidJNIEnv());
            auto activity=static_cast<jobject>(SDL_GetAndroidActivity());
            if (!activity) return;
            auto type=env->GetObjectClass(activity);
            auto method=env->GetMethodID(type,"pairGamepads","()V");
            env->CallVoidMethod(activity,method);
            env->DeleteLocalRef(type);
            env->DeleteLocalRef(activity);
            return;
        }
#endif
        stack_pop();
    }
    void draw(uint32_t) override
    {
        panel(container(),.08f,.11f,.84f,.76f);
        label(ui(),target(),controls ? "Controller Settings" : "Staff Credits",.15f,.17f,.7f,.055f);
        char const *const credits[]={
            "Battle City (1985)     NAMCO",
            "Switch collection     M2 / Bandai Namco Entertainment",
            "Recreation     Battle City project",
            "NES runtime     MAME / SDL"
        };
#ifdef __ANDROID__
        char const *const keys[]={"Player 1 and Player 2 use separate gamepads",
            "D-pad  Move       A / B  Fire","Select  Choose mode       Start  Start / Pause",
            "Left shoulder  Menu       Right shoulder  Rewind"};
#else
        char const *const keys[]={"Player 1    W A S D  Move       J / K  Fire",
            "Player 2    Arrow keys  Move       N / M  Fire",
            "Right Shift  Choose mode       Enter  Start / Pause","Esc  Menu       R  Rewind"};
#endif
        for (int i=0;i<4;++i) label(ui(),target(),controls ? keys[i] : credits[i],.12f,.30f+i*.085f,.76f,.035f);
        auto const selected=reinterpret_cast<uintptr_t>(get_selection_ref());
#ifdef __ANDROID__
        if (controls) {
            panel(container(),.33f,.65f,.34f,.061f,selected==2);
            label(ui(),target(),"Pair Gamepads",.33f,.658f,.34f,.035f);
        }
#endif
        panel(container(),.32f,.755f,.36f,.065f,selected==1);
        label(ui(),target(),"Return to Settings",.32f,.764f,.36f,.035f);
    }
};

class settings_menu : public choice_menu
{
public:
    settings_menu(mame_ui_manager &ui, render_target &target) : choice_menu(ui,target,"Settings")
    {
        set_needs_prev_menu_item(false);
        set_process_flags(PROCESS_LR_ALWAYS);
    }
private:
    static constexpr char const *items[]={"Screen Settings","Wallpaper Settings","Controller Settings","Staff Credits"};
    void populate() override
    {
        for (uintptr_t i=0;i<4;++i) item_append(items[i],0,reinterpret_cast<void *>(i+1));
        item_append("Return to Menu",0,reinterpret_cast<void *>(5));
    }
    void horizontally(int delta) override
    {
        if (selected_index()<4) set_selected_index((selected_index()+4+delta)%4);
    }
    void choose(uintptr_t value) override
    {
        if (value==5) stack_pop();
        else if (value<=2) stack_push<display_menu>(ui(),target(),value==2);
        else stack_push<information_menu>(ui(),target(),value==3);
    }
    void draw(uint32_t) override
    {
        panel(container(),.08f,.15f,.84f,.69f);
        label(ui(),target(),"Settings",.20f,.20f,.60f,.055f);
        for (int i=0;i<4;++i) {
            float x=.10f+.20f*i;
            panel(container(),x,.39f,.19f,.22f,selected_index()==i);
            label(ui(),target(),items[i],x,.48f,.19f,.035f);
        }
        panel(container(),.33f,.731f,.34f,.064f,selected_index()==4);
        label(ui(),target(),"Return to Menu",.33f,.74f,.34f,.035f);
    }
};
} // anonymous namespace

menu_main::menu_main(mame_ui_manager &mui, render_target &target) : menu(mui, target), m_phase(machine().phase())
{
    set_needs_prev_menu_item(false);
    set_process_flags(PROCESS_LR_ALWAYS);
    set_heading("System Menu");
    m_slots=std::make_unique<battle_slots>(machine());
}
menu_main::~menu_main() = default;
void menu_main::menu_activated()
{
    m_phase=machine().phase();
    m_slots->refresh();
}
void menu_main::populate()
{
    if (m_phase == machine_phase::RUNNING) {
        item_append("Save",0,reinterpret_cast<void *>(save));
        item_append("Load",0,reinterpret_cast<void *>(load));
        item_append("Settings",0,reinterpret_cast<void *>(settings));
        item_append("Game Reset",0,reinterpret_cast<void *>(reset_game));
    }
    item_append("Return to Game",0,reinterpret_cast<void *>(resume));
}
void menu_main::draw(uint32_t)
{
    panel(container(),.075f,.049f,.85f,.841f);
    label(ui(),target(),"System Menu",.15f,.085f,.7f,.058f);
    auto button=[this](action id,std::string_view name,float x,float y,float width) {
        panel(container(),x,y,width,.067f,get_selection_ref()==reinterpret_cast<void *>(id));
        label(ui(),target(),name,x,y+.011f,width,.043f);
    };
    if (m_phase==machine_phase::RUNNING) {
        button(save,"Save",.389f,.163f,.222f);
        button(load,"Load",.389f,.251f,.222f);
        m_slots->draw(ui(),target(),-1);
        button(settings,"Settings",.263f,.700f,.220f);
        button(reset_game,"Game Reset",.518f,.700f,.220f);
    }
    button(resume,"Return to Game",.35f,.79f,.30f);
}
bool menu_main::handle(event const *ev)
{
    if (ev && (ev->iptkey==IPT_UI_LEFT || ev->iptkey==IPT_UI_RIGHT)) {
        auto selected=reinterpret_cast<uintptr_t>(get_selection_ref());
        if (selected==settings || selected==reset_game) set_selected_index(selected==settings ? 3 : 2);
        return true;
    }
    if (ev && ev->iptkey==IPT_UI_SELECT)
        m_pending_action=reinterpret_cast<uintptr_t>(ev->itemref);
    if (!m_pending_action || machine().ioport().type_pressed(IPT_UI_SELECT)) return false;
    auto selected=m_pending_action;
    m_pending_action=0;
    switch (selected) {
    case save: case load: stack_push<slots_menu>(ui(),target(),selected==save); break;
    case settings: stack_push<settings_menu>(ui(),target()); break;
    case reset_game: stack_push<reset_menu>(ui(),target()); break;
    case resume: stack_pop(); break;
    }
    return false;
}
} // namespace ui
