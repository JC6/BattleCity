// SPDX-License-Identifier: BSD-3-Clause
#include "emu.h"
#include "menu-slot-emblem.h"
#include "menu-picture-icons.h"
#include "ui/mainmenu.h"
#include "wallpaper-previews.h"
#include "screen-preview.h"
#include "fileio.h"
#include "util/ioprocs.h"
#include "rendutil.h"
#include "video.h"
#include <atomic>
#include <chrono>
#include <ctime>
#include <sys/stat.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
struct SDL_Window;
extern "C" SDL_Window *SDL_GetKeyboardFocus();
extern "C" bool SDL_SetWindowSize(SDL_Window *,int,int);
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
    if (auto *window=SDL_GetKeyboardFocus()) SDL_SetWindowSize(window,visible ? 960 : 320,visible ? 540 : 240);
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

constexpr auto blend = PRIMFLAG_BLENDMODE(BLENDMODE_ALPHA);
const rgb_t blue(3, 50, 120), navy(2, 15, 48), cyan(88, 191, 255);

void box(render_container &c, float x, float y, float w, float h, rgb_t color)
{
    c.add_rect(x,y,x+w,y+h,color,blend);
}

void brackets(render_container &c, float x, float y, float w, float h)
{
    // Each corner has a stepped outer stroke and a parallel inner highlight.
    for (int right=0; right<2; ++right) for (int bottom=0; bottom<2; ++bottom) {
        float const sx=right ? -1.f : 1.f, sy=bottom ? -1.f : 1.f;
        float const ox=right ? x+w+.010f : x-.010f, oy=bottom ? y+h+.018f : y-.018f;
        auto stroke=[&](int u,int v,int width,int height,rgb_t color) {
            float const x1=ox+sx*u/1280.f, x2=x1+sx*width/1280.f;
            float const y1=oy+sy*v/720.f, y2=y1+sy*height/720.f;
            box(c,std::min(x1,x2),std::min(y1,y2),std::abs(x2-x1),std::abs(y2-y1),color);
        };
        stroke(4,0,18,9,blue); stroke(0,4,9,18,blue);
        stroke(5,5,9,9,blue);
        stroke(6,0,15,1,cyan);
        stroke(5,1,17,2,cyan);
        stroke(4,3,6,1,cyan);
        stroke(17,3,5,2,cyan);
        stroke(4,4,9,1,cyan);
        stroke(0,5,8,1,cyan);
        stroke(9,5,13,1,cyan);
        stroke(0,6,22,1,cyan);
        stroke(0,7,8,1,cyan);
        stroke(9,7,12,1,cyan);
        stroke(0,8,3,1,cyan);
        stroke(4,8,3,1,cyan);
        stroke(8,8,6,1,cyan);
        stroke(0,9,13,2,cyan);
        stroke(0,11,12,2,cyan);
        stroke(0,13,8,4,cyan);
        stroke(0,17,3,2,cyan);
        stroke(4,17,4,2,cyan);
        stroke(0,19,7,2,cyan);
        stroke(1,21,6,1,cyan);
    }
}

void rounded(render_container &c,float x,float y,float w,float h,float rx,float ry,rgb_t color)
{
    rx=std::min(rx,w/2); ry=std::min(ry,h/2);
    box(c,x,y+ry,w,h-2*ry,color);
    constexpr int slices=8;
    for (int i=0;i<slices;++i) {
        float const v=1.f-(i+.5f)/slices;
        float const inset=rx*(1.f-std::sqrt(1.f-v*v)), band=ry/slices;
        box(c,x+inset,y+i*band,w-2*inset,band,color);
        box(c,x+inset,y+h-(i+1)*band,w-2*inset,band,color);
    }
}

void panel(render_container &c, float x, float y, float w, float h, bool focused = false)
{
    rounded(c,x,y,w,h,.012f,.020f,blue);
    rounded(c,x+.006f,y+.005f,w-.012f,h-.010f,.008f,.015f,rgb_t::black());
    if (focused) brackets(c,x,y,w,h);
}

void chamfer(render_container &c,float x,float y,float w,float h,float cut,rgb_t color)
{
    constexpr int bands=28;
    for (int i=0;i<bands;++i) {
        float inset=cut*std::abs((2*i+1-bands)/float(bands));
        box(c,x+inset,y+i*h/bands,w-2*inset,h/bands,color);
    }
}

void label(mame_ui_manager &ui, render_target &target, std::string_view value, float x, float y,
           float w, float size, rgb_t color=rgb_t::white())
{
    ui.draw_text_full(target, value, x, y, w, text_layout::text_justify::CENTER,
        text_layout::word_wrapping::TRUNCATE, mame_ui_manager::NORMAL, color,
        rgb_t(0,0,0,0), nullptr, nullptr, size);
}

void header(mame_ui_manager &ui, render_target &t, std::string_view title,float y=.05f,float bottom=.885f)
{
    auto &c=*t.ui_container();
    box(c,0,0,1,1,rgb_t(212,0,0,0));
    rounded(c,.074f,y,.852f,bottom-y,.030f,.050f,navy);
    rounded(c,.079f,y+.007f,.842f,bottom-y-.014f,.026f,.044f,rgb_t(243,0,0,0));
    for (int band=0;band<20;++band) {
        float const inset=.041f*band/20;
        box(c,.210f+inset,y+.006f+band*.073f/20,.580f-2*inset,.073f/20,navy);
    }
    label(ui,t,title,.20f,y+.014f,.60f,.051f);
}

void button(mame_ui_manager &ui,render_target &t,std::string_view text,float x,float y,float w,bool focused)
{
    auto &c=*t.ui_container();
    chamfer(c,x,y,w,.061f,.013f,blue);
    chamfer(c,x+.012f,y+.005f,w-.024f,.051f,.010f,rgb_t::black());
    label(ui,t,text,x,y+.003f,w,.043f);
    if (focused) brackets(c,x,y,w,.061f);
}

void footer(mame_ui_manager &ui,render_target &t,bool slots=false, bool settings_help=false)
{
    auto &c=*t.ui_container();
    if (settings_help) {
        using clock=std::chrono::steady_clock;
        static auto const origin=clock::now();
        float const phase=std::fmod(std::chrono::duration<double>(clock::now()-origin).count()*.20,1.10);
        for (float x=-phase;x<1.f;x+=1.10f)
            ui.draw_text_full(t,"This screen is to configure the game settings.",x,.855f,.95f,
                text_layout::text_justify::LEFT,text_layout::word_wrapping::TRUNCATE,
                mame_ui_manager::NORMAL,rgb_t::white(),rgb_t::transparent(),nullptr,nullptr,.047f);
    }
    const float width=slots ? .58f : .51f;
    chamfer(c,-.037f,.933f,width+.037f,.100f,.034f,rgb_t(200,0,17));
    chamfer(c,-.044f,.940f,width+.035f,.095f,.029f,rgb_t::black());
#ifdef __ANDROID__
    std::string text="D-pad  Move    A  Confirm    B  Cancel";
    if (slots) text+="    X  Lock";
#else
    std::string text="Arrows  Move    Enter  Confirm    Backspace  Cancel";
    if (slots) text+="    Del  Lock";
#endif
    label(ui,t,text,.006f,.945f,width-.035f,.031f);
}

} // anonymous namespace

template<size_t H, size_t W>
static render_texture *menu_bitmap(running_machine &machine, bitmap_argb32 &bitmap, const char (&rows)[H][W],
                                   const char *keys, const uint32_t *colors)
{
    bitmap.allocate(W-1,H);
    for (size_t y=0;y<H;++y)
        for (size_t x=0;x<W-1;++x)
            bitmap.pix(y,x)=colors[std::strchr(keys,rows[y][x])-keys];
    auto *texture=machine.render().texture_alloc();
    texture->set_bitmap(bitmap,bitmap.cliprect(),TEXFORMAT_ARGB32);
    return texture;
}

class battle_slots
{
public:
    explicit battle_slots(running_machine &machine) : m_machine(machine)
    {
        m_emblem=menu_bitmap(machine,m_emblem_bitmap,slot_emblem::rows,slot_emblem::keys,slot_emblem::colors);
    }
    ~battle_slots() { clear(); m_machine.render().texture_free(m_emblem); }
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
            constexpr float px=1.f/1280, py=1.f/720;
            panel(c,x,291*py,.166f,.651f-291*py);
            // The tab rises above the card, leaving the lock on a black background.
            for (int y=0;y<29;++y) {
                int const inset=y<14 ? int(std::round(13-std::sqrt(169-std::pow(13-y,2)))) : 0;
                int const end=y<3 ? 151+2*y : 156+(y-3)*3/4;
                box(c,x+inset*px,(265+y)*py,(end-inset)*px,py,blue);
            }
            if (int(i)==selected) brackets(c,x,.366f,.166f,.285f);
            if (occupied(i)) label(ui,target,card.date,x+.003f,269*py,.098f,.028f);
            else for (int dash=0;dash<12;++dash) {
                box(c,x+(12+9*dash)*px,279*py,7*px,py,rgb_t(220,239,255));
                box(c,x+(12+9*dash)*px,280*py,7*px,py,rgb_t(152,177,209));
            }
            label(ui,target,std::to_string(i+1),x+.096f,269*py,.034f,.032f);
            auto lock_color=card.locked ? cyan : rgb_t(53,57,65);
            rounded(c,x+.148f,.372f,.009f,.017f,.0045f,.008f,lock_color);
            rounded(c,x+.150f,.375f,.005f,.013f,.0025f,.004f,rgb_t::black());
            box(c,x+.146f,.382f,.013f,.011f,lock_color);
            if (card.texture)
                c.add_quad(x+.007f,.405f,x+.159f,.642f,rgb_t::white(),card.texture,blend);
            else if (occupied(i))
                label(ui,target,"Saved",x,.505f,.166f,.034f);
            else {
                float const left=x+42.f/1280.f;
                c.add_quad(left,369.f/720.f,left+130.f/1280.f,393.f/720.f,rgb_t::white(),m_emblem,blend);
            }
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
    bitmap_argb32 m_emblem_bitmap;
    render_texture *m_emblem=nullptr;
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
    virtual bool advance() { return false; }
    bool handle(event const *ev) override
    {
        if (advance()) return true;
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

void system_screen(mame_ui_manager &ui,render_target &t,battle_slots const &cards,
                   uintptr_t active,int slot=-1)
{
    header(ui,t,"System Menu");
    button(ui,t,"Save",.389f,.164f,.222f,active==save);
    button(ui,t,"Load",.389f,.253f,.222f,active==load);
    cards.draw(ui,t,slot);
    button(ui,t,"Settings",.262f,.702f,.221f,active==settings);
    button(ui,t,"Game Reset",.518f,.702f,.221f,active==reset_game);
    button(ui,t,"Return to Main Menu",.360f,.792f,.280f,active==resume);
    footer(ui,t,true);
}

class confirmation_menu : public choice_menu
{
public:
    confirmation_menu(mame_ui_manager &ui,render_target &target,action command,unsigned slot=0)
        : choice_menu(ui,target,"Confirm"),command(command),slot(slot),cards(machine())
    {
        set_needs_prev_menu_item(false);
        set_process_flags(PROCESS_LR_ALWAYS);
        cards.refresh();
    }
private:
    action command;
    unsigned slot;
    battle_slots cards;
    void populate() override
    {
        item_append("Yes",0,reinterpret_cast<void *>(1));
        item_append("No",0,reinterpret_cast<void *>(2));
    }
    void horizontally(int) override { set_selected_index(1-selected_index()); }
    void draw(uint32_t) override
    {
        system_screen(ui(),target(),cards,command,slot ? int(slot)-1 : -1);
        auto &c=container();
        box(c,.251f,.334f,.498f,.296f,rgb_t(3,24,78));
        std::string question;
        if (command==save) {
            question=cards.occupied(slot-1) ? "Overwrite Save Data " : "Saving current play state to Save Data ";
            question+=std::to_string(slot)+(cards.occupied(slot-1) ? "?" : "...");
        } else if (command==resume) question="Do you really want to close the game and return to";
        else question="Do you really want to reset the game?";
        label(ui(),target(),question,.255f,.359f,.490f,.031f);
        if (command==resume) label(ui(),target(),"the Main Menu?",.26f,.389f,.48f,.031f);
        label(ui(),target(),"Yes",.407f,.55f,.077f,.035f,selected_index()==0 ? cyan : rgb_t::white());
        label(ui(),target(),"No",.498f,.55f,.077f,.035f,selected_index()==1 ? cyan : rgb_t::white());
    }
    void choose(uintptr_t value) override
    {
        if (value==2) { stack_pop(); return; }
        if (command==save) machine().schedule_save(std::to_string(slot));
        else machine().schedule_soft_reset();
        stack_reset();
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
        system_screen(ui(),target(),cards,saving ? save : load,selected_index());
    }
    void choose(uintptr_t slot) override
    {
        if ((!saving && !exists(slot)) || (saving && cards.locked(slot-1))) return;
        if (saving) {
            stack_push<confirmation_menu>(ui(),target(),save,unsigned(slot));
            return;
        }
        machine().schedule_load(std::to_string(slot));
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
        } else {
            badges=menu_bitmap(machine(),badge_bitmap,picture_icons::rows,picture_icons::keys,picture_icons::colors);
            texture=machine().render().texture_alloc();
            update_sample();
        }
    }
    ~display_menu() override {
        if (badges) machine().render().texture_free(badges);
        if (texture) machine().render().texture_free(texture);
        for (auto *item:wall_textures) if (item) machine().render().texture_free(item);
    }
private:
    bool wallpaper;
    std::array<bitmap_argb32,3> wall_bitmaps;
    std::array<render_texture *,3> wall_textures{};
    bitmap_argb32 bitmap;
    bitmap_argb32 badge_bitmap;
    render_texture *badges=nullptr;
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
        else if (value==6 || value==7) {
            battlecity_picture(battlecity_picture(-1) ^ (value==6 ? 1 : 2));
            update_sample();
        }
        else preference(wallpaper,int(value)-1);
    }
    void update_sample()
    {
        draw_screen_sample(bitmap,battlecity_picture(-1));
        texture->set_bitmap(bitmap,bitmap.cliprect(),TEXFORMAT_ARGB32);
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
        // Visible image extents in the four 1280x720 reference thumbnails.
        static constexpr int widths[]={76,86,65,134}, heights[]={56,75,56,75};
        bool const large=w>.2f;
        float const pw=widths[i]*(large ? 164.f/86.f : 1.f)/1280.f;
        float const ph=heights[i]*(large ? 144.f/75.f : 1.f)/720.f;
        float const left=x+(w-pw)/2, top=y+(h-ph)/2;
        container().add_quad(left,top,left+pw,top+ph,rgb_t::white(),texture,blend);
    }
    void draw(uint32_t) override
    {
        header(ui(),target(),wallpaper ? "Wallpaper Settings" : "Screen Settings");
        int current=preference(wallpaper,-1);
        rounded(container(),.383f,.184f,.234f,.240f,.012f,.025f,rgb_t(61,63,76));
        rounded(container(),.392f,.190f,.216f,.228f,.008f,.019f,rgb_t::black());
        preview(current,.389f,.191f,.222f,.226f);
        for (int i=0;i<4;++i) {
            float x=.170f+.173f*i;
            panel(container(),x,.496f,.141f,.147f,selected_index()==i);
            if (current==i) {
                rounded(container(),x,.496f,.141f,.147f,.012f,.020f,rgb_t(125,168,229));
                rounded(container(),x+.009f,.502f,.123f,.135f,.008f,.014f,rgb_t::black());
            }
            preview(i,x+.008f,.505f,.125f,.129f);
            if (!wallpaper) label(ui(),target(),screens[i],x-.012f,.656f,.165f,.036f);
        }
        if (!wallpaper) {
            constexpr float px=1.f/1280, py=1.f/720;
            for (int i=0;i<2;++i) {
                auto &c=container();
                float const top=(137+42*i)*py;
                rounded(c,802*px,top,34*px,34*py,17*px,17*py,rgb_t(0,19,64));
                // Both badges contain the same pixel S. The lower flag has scan lines.
                static constexpr unsigned glyph[]={0x3c,0x66,0x60,0x3c,0x06,0x66,0x3c};
                for (int row=0;row<7;++row)
                    for (int col=0;col<7;++col)
                        if (glyph[row] & (0x40>>col))
                            box(c,(805+2*col)*px,top+(9+2*row)*py,2*px,2*py,rgb_t(100,4,16));
                auto gold=rgb_t(104,79,8);
                box(c,819*px,top+8*py,3*px,21*py,gold);
                box(c,817*px,top+27*py,7*px,3*py,gold);
                for (int row=0;row<12;++row)
                    box(c,822*px,top+(9+row)*py,(1+std::min(row,11-row)*2)*px,py,
                        i && row%2 ? rgb_t(64,51,8) : gold);
            }
            container().add_quad(801*px,136*py,837*px,214*py,rgb_t::white(),badges,blend);
            int picture=battlecity_picture(-1);
            for (int i=0;i<2;++i) {
                float y=.201f+.058f*i;
                std::string name=i ? "Scan Lines" : "Anti-Aliasing";
                auto &c=container();
                float const top=(137+42*i)*py;
                for (auto [dx,dy]:{std::pair{0,-7},{-7,0},{7,0},{0,7}}) {
                    rounded(c,(859+dx)*px,top+(13+dy)*py,8*px,8*py,4*px,4*py,rgb_t(222,222,222));
                    if (dy!=-7 && !(picture & (1<<i)))
                        rounded(c,(861+dx)*px,top+(15+dy)*py,4*px,4*py,2*px,2*py,rgb_t::black());
                }
                ui().draw_text_full(target(),name,879*px,y-.003f,.16f,text_layout::text_justify::LEFT,
                    text_layout::word_wrapping::TRUNCATE,mame_ui_manager::NORMAL,rgb_t::white(),
                    rgb_t::transparent(),nullptr,nullptr,.032f);
                if (selected_index()==i+4) brackets(container(),.625f,y,.169f,.041f);
            }
        }
        button(ui(),target(),"Return to Settings",.369f,.770f,.262f,selected_index()==(wallpaper ? 4 : 6));
        footer(ui(),target(),false,true);
    }
};

struct staff_line { unsigned y; unsigned height; char const *text; };
constexpr staff_line staff[] = {
#include "staff-roll.inc"
};

class credits_menu : public choice_menu
{
public:
    credits_menu(mame_ui_manager &ui,render_target &target) : choice_menu(ui,target,"Staff Credits")
    { set_needs_prev_menu_item(false); }
private:
    using clock=std::chrono::steady_clock;
    clock::time_point previous=clock::now();
    float distance=0;
    float final_seconds=0;
    void populate() override { item_append("Staff Credits",0,reinterpret_cast<void *>(1)); }
    void choose(uintptr_t) override { stack_pop(); }
    bool advance() override
    {
        auto now=clock::now();
        float elapsed=std::min(.25f,std::chrono::duration<float>(now-previous).count());
        previous=now;
        // The recording shows 80 and 640 pixels/second on a 720-line image.
        float const stop=staff[std::size(staff)-1].y+360.f;
        distance=std::min(stop,distance+elapsed*(machine().ioport().type_pressed(IPT_UI_DOWN) ? 640.f : 80.f));
        if (distance<stop) return false;
        final_seconds+=elapsed;
        if (final_seconds<4.f) return false;
        stack_pop();
        return true;
    }
    void draw(uint32_t) override
    {
        box(container(),0,0,1,1,rgb_t::black());
        float top=distance-720.f;
        auto line=std::lower_bound(std::begin(staff),std::end(staff),top-36.f,
                       [](staff_line const &line,float y) { return line.y<y; });
        for (;line!=std::end(staff) && line->y<=distance;++line) {
            float y=(line->y-top)/720.f;
            float intensity=std::clamp(std::min(y,1.f-y)*14.f,0.f,1.f);
            auto shade=uint8_t(255*intensity);
            rgb_t color=line==staff ? rgb_t(0,uint8_t(180*intensity),uint8_t(217*intensity)) : rgb_t(shade,shade,shade);
            label(ui(),target(),line->text,.04f,y-line->height/1440.f,.92f,line->height/720.f,color);
        }
    }
};

class information_menu : public choice_menu
{
public:
    information_menu(mame_ui_manager &ui, render_target &target)
        : choice_menu(ui,target,"Controller Settings")
    { set_needs_prev_menu_item(false); }
private:
    void populate() override
    {
#ifdef __ANDROID__
        item_append("Pair Gamepads",0,reinterpret_cast<void *>(2));
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
        header(ui(),target(),"Controller Settings");
        footer(ui(),target(),false,true);
#ifdef __ANDROID__
        char const *const keys[]={"Player 1 and Player 2 use separate gamepads",
            "D-pad  Move       A / B  Fire","Select  Choose mode       Start  Start / Pause",
            "Left shoulder  Menu       Right shoulder  Rewind"};
#else
        char const *const keys[]={"Player 1    W A S D  Move       J / K  Fire",
            "Player 2    Arrow keys  Move       N / M  Fire",
            "Right Shift  Choose mode       Enter  Start / Pause","Esc  Menu       R  Rewind"};
#endif
        for (int i=0;i<4;++i) label(ui(),target(),keys[i],.12f,.30f+i*.085f,.76f,.035f);
        auto const selected=reinterpret_cast<uintptr_t>(get_selection_ref());
#ifdef __ANDROID__
        {
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
        else if (value==3) stack_push<information_menu>(ui(),target());
        else stack_push<credits_menu>(ui(),target());
    }
    void draw(uint32_t) override
    {
        header(ui(),target(),"Settings",.13f,.805f);
        for (int i=0;i<4;++i) {
            float x=.106f+.203f*i, cy=.433f, cx=x+.090f;
            panel(container(),x,.350f,.180f,.215f,selected_index()==i);
            auto line=[&](float ax,float ay,float bx,float by) {
                container().add_line(cx+ax,cy+ay,cx+bx,cy+by,.004f,rgb_t(99,158,218),blend);
            };
            if (i==0) {
                panel(container(),cx-.044f,cy-.050f,.071f,.068f);
                panel(container(),cx-.023f,cy-.026f,.071f,.068f);
            } else if (i==1) {
                line(-.045f,-.031f,-.015f,-.045f); line(-.015f,-.045f,.028f,-.017f);
                line(.028f,-.017f,.014f,.037f); line(.014f,.037f,-.032f,.009f);
                line(-.032f,.009f,-.045f,.031f); line(-.045f,.031f,-.045f,-.031f);
            } else if (i==2) {
                line(-.048f,.036f,-.036f,-.027f); line(-.036f,-.027f,.034f,-.027f);
                line(.034f,-.027f,.048f,.036f); line(.048f,.036f,.014f,.009f);
                line(.014f,.009f,-.014f,.009f); line(-.014f,.009f,-.048f,.036f);
                line(-.026f,-.004f,-.010f,-.004f); line(-.018f,-.014f,-.018f,.006f);
                line(.018f,-.003f,.023f,-.003f);
            } else {
                line(-.040f,-.031f,-.025f,.034f); line(-.025f,.034f,-.006f,-.031f);
                line(-.006f,-.031f,-.040f,-.031f); line(.007f,-.031f,.035f,.034f);
                line(.035f,-.031f,.007f,.034f);
            }
            label(ui(),target(),items[i],x,.499f,.18f,.032f);
        }
        button(ui(),target(),"Return to Menu",.367f,.691f,.266f,selected_index()==4);
        footer(ui(),target(),false,true);
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
    item_append("Return to Main Menu",0,reinterpret_cast<void *>(resume));
}
void menu_main::draw(uint32_t)
{
    system_screen(ui(),target(),*m_slots,reinterpret_cast<uintptr_t>(get_selection_ref()));
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
    case reset_game: case resume: stack_push<confirmation_menu>(ui(),target(),action(selected)); break;
    }
    return false;
}
} // namespace ui
