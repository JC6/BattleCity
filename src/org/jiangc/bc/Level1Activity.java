package org.jiangc.bc;

import android.app.AlertDialog;
import android.os.SystemClock;
import android.view.WindowManager;
import java.io.IOException;
import java.util.EnumSet;
import org.anddev.andengine.engine.handler.IUpdateHandler;
import org.anddev.andengine.entity.scene.Scene;
import org.jiangc.bc.audio.GameAudio;
import org.jiangc.bc.game.*;
import org.jiangc.bc.input.BattleInput;
import org.jiangc.bc.input.ScreenInput;
import org.jiangc.bc.input.InputHub;
import org.jiangc.bc.input.InputHub.Button;

/** Single/cooperative campaign. UI owns controllers; engine owns the campaign and scene. */
public final class Level1Activity extends TvGameActivity {
    private final BattleInput input=new BattleInput();
    private final ScreenInput selectionInput=new ScreenInput();
    private final StageSelection selection=new StageSelection();
    private final int[] participantSlots={-1,-1};
    private LevelCatalog levels;
    private BattleRenderer renderer;
    private volatile GameAudio audio;
    private volatile boolean started,selecting,loaded,transitionPending;
    private boolean coop;
    private volatile int screen=BattleSession.BATTLE;
    private Campaign campaign;
    private double accumulated;
    private int scoreCues,pauseTick;
    private double pauseAccumulated;

    private AlertDialog dialog;

    @Override public void onLoadResources(){
        coop=getIntent().getBooleanExtra("coop",false);
        try{levels=LevelCatalog.read(getAssets()::open);renderer=new BattleRenderer(this,mEngine);}
        catch(IOException e){throw new IllegalStateException("Missing bundled battle assets",e);}
        audio=new GameAudio(this,()->foreground && hasWindowFocus(),()->pause(false));
    }
    @Override public Scene onLoadScene(){
        Scene scene=new Scene(1);renderer.attach(scene);renderer.selection(selection.stage());
        scene.registerUpdateHandler(new IUpdateHandler(){
            @Override public void reset(){accumulated=0;}
            @Override public void onUpdate(float seconds){update(seconds);}
        });
        return scene;
    }
    @Override public void onLoadComplete(){loaded=true;runOnUiThread(()->{
        selectStage();
    });}
    private void update(float seconds){
        if(transitionPending || !foreground || !hasWindowFocus())return;
        if(tvEngine().isExplicitlyPaused()){
            pauseAccumulated+=Math.min(.1,Math.max(0,seconds));
            while(pauseAccumulated>=Game.TICK_SECONDS){pauseAccumulated-=Game.TICK_SECONDS;pauseTick++;}
            if(campaign!=null)renderer.render(campaign.session(),true,pauseTick);
            else if(selecting)renderer.selection(selection.stage(),true,pauseTick);
            return;
        }
        if(selecting){
            accumulated+=Math.min(.1,Math.max(0,seconds));int count=0;
            while(accumulated>=Game.TICK_SECONDS && count++<6){accumulated-=Game.TICK_SECONDS;selection.step(selectionInput.consume());}
            if(count>=6)accumulated=Math.min(accumulated,Game.TICK_SECONDS);
            renderer.selection(selection.stage());return;
        }
        if(campaign==null)return;
        BattleSession session=campaign.session();
        accumulated+=Math.min(.1,Math.max(0,seconds));int steps=0;
        while(accumulated>=Game.TICK_SECONDS && steps++<6){
            accumulated-=Game.TICK_SECONDS;
            int before=session.screen;
            audio.play(campaign.step(input.consume()));
            if(campaign.session()!=session){beginStageTransition();break;}
            audio.state(session.game.state);
            if(session.screen==BattleSession.SCORE){
                int cues=session.cueCount();if(cues>scoreCues)audio.count();scoreCues=cues;
            }
            if(before!=session.screen){
                screen=session.screen;
                if(screen==BattleSession.GAME_OVER){audio.reset();audio.gameOver();}
                if(screen==BattleSession.HISCORE){audio.reset();audio.highScore();}
                runOnUiThread(this::updateHint);
                if(screen==BattleSession.DONE){
                    audio.reset();
                    transitionPending=true;input.clear();
                    runOnUiThread(()->{clearInput();finish();});return;
                }
            }
        }
        // Never catch up a backlog following a long frame, focus loss, or pause.
        if(steps>=6)accumulated=Math.min(accumulated,Game.TICK_SECONDS);
        renderer.render(campaign.session());
    }
    private void resetPresentation(){
        accumulated=0;scoreCues=0;screen=BattleSession.BATTLE;
        audio.reset();audio.intro();
    }
    private void beginStageTransition(){
        // The engine never waits synchronously for UI work. Neither clock nor inputs
        // advance until the UI has blocked held keys and required stick recentering.
        transitionPending=true;input.clear();resetPresentation();
        runOnUiThread(()->{
            if(isFinishing() || isDestroyed())return;
            clearInput();transitionPending=false;updateHint();
        });
    }
    private TvEngine tvEngine(){return (TvEngine)mEngine;}
    private boolean online(){for(int i=0;i<(coop?2:1);i++)if(participantSlots[i]<0 || controllers().hub.playerController(participantSlots[i])==null)return false;return true;}
    private int participant(int deviceId){int slot=controllers().hub.player(deviceId);for(int i=0;i<(coop?2:1);i++)if(slot>=0 && participantSlots[i]==slot)return i;return -1;}
    private GameMemory memory(){return ((BattleCityApplication)getApplication()).memory();}
    private void selectStage(){
        int selected=controllers().hub.playerController(0)!=null?0:controllers().hub.playerController(1)!=null?1:-1;
        if(selected<0){finish();return;}
        if(coop){if(controllers().hub.playerController(0)==null || controllers().hub.playerController(1)==null){finish();return;}participantSlots[0]=0;participantSlots[1]=1;}
        else participantSlots[0]=selected;
        clearInput();selecting=true;updateHint();
    }
    private void start(){
        if(!online()){updateHint();return;}
        if(!audio.acquireFocus()){notice(getString(R.string.audio_focus_unavailable));return;}
        hideNotice();transitionPending=true;clearInput();selecting=false;started=true;
        int[] custom=memory().customTiles();
        runOnUpdateThread(()->{
            campaign=new Campaign(levels,coop,()->(int)SystemClock.elapsedRealtimeNanos(),selection.stage(),custom,memory());
            resetPresentation();transitionPending=false;
        });
        audio.pause(false,false);updateHint();
    }
    private void clearInput(){controllers().clear();resetDialogInput();input.clear();selectionInput.clear();}
    private void pause(boolean manual){
        if((!started && !selecting) || mEngine==null)return;
        tvEngine().setExplicitlyPaused(true);
        // setExplicitlyPaused has waited for any in-flight engine tick to finish.
        accumulated=0;pauseTick=0;pauseAccumulated=0;clearInput();selection.clearInput();if(audio!=null)audio.pause(true,manual && started);updateHint();
    }
    private void togglePause(boolean manual){
        if(!tvEngine().isExplicitlyPaused()){pause(manual);return;}
        if(!online()){updateHint();return;}
        if(started && !audio.acquireFocus()){notice(getString(R.string.audio_focus_unavailable));return;}
        hideNotice();clearInput();selection.clearInput();accumulated=0;if(started)audio.pause(false,false);tvEngine().setExplicitlyPaused(false);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);updateHint();
    }
    @Override public void onButtons(int deviceId,EnumSet<Button> pressed,boolean gamepad){
        if(gamepad)controllers().traceRoute(deviceId,participant(deviceId),dialog!=null?"dialog":
                !loaded?"loading":tvEngine().isExplicitlyPaused()?"paused":selecting?"selection":"screen-"+screen);
        if(dialog!=null){dialogDirection(dialog,deviceId,pressed);return;}
        if(!foreground || !hasWindowFocus() || !loaded)return;
        if(started && !tvEngine().isExplicitlyPaused() && screen==BattleSession.GAME_OVER && (pressed.contains(Button.START)||pressed.contains(Button.SELECT))){
            if(!gamepad || participant(deviceId)==0){clearInput();runOnUpdateThread(()->campaign.skipGameOver());}return;
        }
        if(!gamepad && pressed.contains(Button.B)){onBackRequested();return;}
        int player=gamepad?participant(deviceId):-1;
        boolean pauseKey=(gamepad && player>=0 && pressed.contains(Button.START)) ||
                (!gamepad && (pressed.contains(Button.START) || pressed.contains(Button.A)));
        if(tvEngine().isExplicitlyPaused()){
            if(pauseKey)togglePause(true);return;
        }
        if(transitionPending)return;
        if(selecting){
            if(!gamepad){if(pressed.contains(Button.A) || pressed.contains(Button.START))start();}
            else if(player==0){
                if(pressed.contains(Button.START))start();else selectionInput.update(controllers().hub.controller(deviceId).held(),pressed);
            }
            return;
        }
        if(pauseKey){togglePause(true);return;}
        if(player>=0 && !transitionPending && !tvEngine().isExplicitlyPaused() && screen==BattleSession.BATTLE && (pressed.contains(Button.A) || pressed.contains(Button.B))){
            InputHub.Controller d=controllers().hub.controller(deviceId);
            if(d!=null && d.ready())input.update(player,d.held(),true);
        }
    }
    @Override public void onInputChanged(){
        if(selecting && !transitionPending && !tvEngine().isExplicitlyPaused() && dialog==null){
            InputHub.Controller owner=controllers().hub.playerController(participantSlots[0]);
            selectionInput.held(owner==null?EnumSet.noneOf(Button.class):owner.held());
        }
        if(started && !transitionPending && screen==BattleSession.BATTLE && !tvEngine().isExplicitlyPaused() && dialog==null)for(int i=0;i<(coop?2:1);i++){
            InputHub.Controller d=controllers().hub.playerController(participantSlots[i]);input.update(i,d==null?EnumSet.noneOf(Button.class):d.held(),false);
        }
        if(!started || tvEngine().isExplicitlyPaused())updateHint();
    }
    @Override public void onControllerDisconnected(int slot){
        if(started || selecting)for(int i=0;i<(coop?2:1);i++)if(participantSlots[i]==slot){pause(false);break;}
        updateHint();
    }
    @Override public void onPauseGame(){pause(false);}
    @Override public void onResumeGame(){updateHint();}
    @Override public void onWindowFocusChanged(boolean hasFocus){
        super.onWindowFocusChanged(hasFocus);
        input.clear();selectionInput.clear();if(!hasFocus)pause(false);else updateHint();
    }
    private String statusNotice;
    private void updateHint(){
        if(!loaded || hint==null)return;
        String next=!online()?getString(R.string.battle_disconnected):audio!=null&&audio.unavailable()?getString(R.string.battle_silent):null;
        if(next!=null)notice(next);
        else if(statusNotice!=null && statusNotice.contentEquals(hint.getText()))hideNotice();
        statusNotice=next;
    }
    @Override public void onBackRequested(){
        if(dialog!=null || !foreground)return;pause(false);clearInput();
        AlertDialog next=new AlertDialog.Builder(this).setTitle("返回主菜单？").setMessage("本局进度将丢弃。")
                .setPositiveButton("返回主菜单",(d,w)->finish()).setNegativeButton(R.string.cancel,null).create();
        dialog=next;
        next.setOnDismissListener(d->{dialog=null;clearInput();updateHint();});
        next.show();installDialogInput(next);next.getButton(AlertDialog.BUTTON_NEGATIVE).requestFocus();
    }
    @Override protected void onDestroy(){
        if(dialog!=null)dialog.dismiss();if(audio!=null)audio.close();super.onDestroy();
    }
    // Package visibility for device tests: callers synchronize on the engine.
    BattleSession session(){return campaign==null?null:campaign.session();}
    boolean started(){return started;}
    boolean selecting(){return selecting;}
    int selectedStage(){return selection.stage();}
}
