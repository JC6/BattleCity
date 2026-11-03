package org.jiangc.bc;

import java.io.IOException;
import java.util.EnumSet;
import org.anddev.andengine.engine.handler.IUpdateHandler;
import org.anddev.andengine.entity.scene.Scene;
import org.jiangc.bc.game.ConstructionState;
import org.jiangc.bc.game.Game;
import org.jiangc.bc.game.GameMemory;
import org.jiangc.bc.input.InputHub;
import org.jiangc.bc.input.InputHub.Button;
import org.jiangc.bc.input.ScreenInput;

/** One controller owns editing. START after a pause only resumes, never exits. */
public final class ConstructionActivity extends TvGameActivity {
    private final ScreenInput input=new ScreenInput();
    private ConstructionState construction;
    private BattleRenderer renderer;
    private volatile boolean loaded,editing;
    private boolean leaving;
    private int owner=-1,tick,pauseTick;
    private double pauseAccumulated;
    private double accumulated;
    private GameMemory memory(){return ((BattleCityApplication)getApplication()).memory();}
    private TvEngine engine(){return (TvEngine)mEngine;}
    private boolean online(){return owner>=0 && controllers().hub.playerController(owner)!=null;}
    @Override public void onLoadResources(){
        construction=memory().construction();construction.enter();
        try{renderer=new BattleRenderer(this,mEngine);}catch(IOException e){throw new IllegalStateException("Missing bundled battle assets",e);}
    }
    @Override public Scene onLoadScene(){
        Scene scene=new Scene(1);renderer.attach(scene);renderer.construction(construction,0);
        scene.registerUpdateHandler(new IUpdateHandler(){
            @Override public void reset(){accumulated=0;}
            @Override public void onUpdate(float seconds){
                if(!editing || !foreground || !hasWindowFocus())return;
                if(engine().isExplicitlyPaused()){
                    pauseAccumulated+=Math.min(.1,Math.max(0,seconds));
                    while(pauseAccumulated>=Game.TICK_SECONDS){pauseAccumulated-=Game.TICK_SECONDS;pauseTick++;}
                    renderer.construction(construction,tick,true,pauseTick);return;
                }
                accumulated+=Math.min(.1,Math.max(0,seconds));int steps=0;
                while(accumulated>=Game.TICK_SECONDS && steps++<6){accumulated-=Game.TICK_SECONDS;construction.step(input.consume());tick++;}
                if(steps>=6)accumulated=Math.min(accumulated,Game.TICK_SECONDS);
                renderer.construction(construction,tick);
            }
        });
        return scene;
    }
    @Override public void onLoadComplete(){loaded=true;runOnUiThread(()->{
        owner=controllers().hub.playerController(0)!=null?0:controllers().hub.playerController(1)!=null?1:-1;
        if(owner<0){finish();return;}clearInput();editing=true;setScreenAwakeAllowed(true);updateHint();
    });}
    private void clearInput(){controllers().clear();input.clear();}
    private void pause(){
        if(!editing || mEngine==null)return;
        setScreenAwakeAllowed(false);
        engine().setExplicitlyPaused(true);accumulated=0;pauseTick=0;pauseAccumulated=0;clearInput();construction.clearInput();
        memory().saveConstruction(construction);updateHint();
    }
    private void resume(){
        if(!online()){updateHint();return;}
        clearInput();construction.clearInput();accumulated=0;engine().setExplicitlyPaused(false);
        setScreenAwakeAllowed(true);updateHint();
    }
    @Override public void onButtons(int deviceId,EnumSet<Button> pressed,boolean gamepad){
        if(!foreground || !hasWindowFocus() || !loaded || leaving)return;
        if(!gamepad && pressed.contains(Button.B)){onBackRequested();return;}
        if(!editing)return;
        boolean owns=gamepad && controllers().hub.player(deviceId)==owner;
        if(engine().isExplicitlyPaused()){
            if((owns && pressed.contains(Button.START)) || (!gamepad && (pressed.contains(Button.A)||pressed.contains(Button.START))))resume();
            return;
        }
        if(owns){if(pressed.contains(Button.START))onBackRequested();else input.update(controllers().hub.controller(deviceId).held(),pressed);}
    }
    @Override public void onInputChanged(){
        if(editing && !engine().isExplicitlyPaused() && !leaving){
            InputHub.Controller device=controllers().hub.playerController(owner);
            input.held(device==null?EnumSet.noneOf(Button.class):device.held());
        }
        if(!editing || engine().isExplicitlyPaused())updateHint();
    }
    @Override public void onControllerDisconnected(int slot){if(slot==owner)pause();updateHint();}
    @Override public void onPauseGame(){pause();}
    @Override protected void onGameResumed(){updateHint();}
    @Override public void onWindowFocusChanged(boolean focus){super.onWindowFocusChanged(focus);input.clear();if(!focus)pause();else updateHint();}
    @Override public void onBackRequested(){if(leaving || !foreground)return;leaving=true;pause();if(editing)memory().finishConstruction();clearInput();finish();}
    private void updateHint(){
        if(!loaded || hint==null)return;
        if(!online())notice(getString(R.string.battle_disconnected));else hideNotice();
    }
    // Device tests inspect the model only while holding the engine lock.
    ConstructionState construction(){return construction;}
    boolean editing(){return editing;}
}
