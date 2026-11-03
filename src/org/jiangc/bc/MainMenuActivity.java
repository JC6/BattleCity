package org.jiangc.bc;

import android.app.AlertDialog;
import android.content.Intent;
import java.io.IOException;
import java.util.EnumSet;
import java.util.ArrayDeque;
import java.util.Deque;
import org.anddev.andengine.engine.handler.IUpdateHandler;
import org.anddev.andengine.entity.scene.Scene;
import org.jiangc.bc.game.*;
import org.jiangc.bc.input.InputHub;
import org.jiangc.bc.input.InputHub.Button;
import org.jiangc.bc.input.ScreenInput;

/** Original title, silent attract demonstration and hidden cutscene. */
public final class MainMenuActivity extends TvGameActivity {
    private final Deque<ScreenInput.Frame[]> inputs=new ArrayDeque<>();
    private static final ScreenInput.Frame EMPTY=new ScreenInput.Frame(EnumSet.noneOf(Button.class),EnumSet.noneOf(Button.class));
    private BattleRenderer renderer;
    private TitleSession title;
    private volatile boolean loaded,navigating;
    private boolean returning;
    private double accumulated;
    private volatile AlertDialog dialog;
    private String controllerNotice;
    private int requestedPlayers;
    private GameMemory memory(){return ((BattleCityApplication)getApplication()).memory();}
    @Override public void onLoadResources(){
        try{renderer=new BattleRenderer(this,mEngine);title=new TitleSession(Level.read(getAssets().open("battle/demo.txt")),memory());memory().takeCompletedGame();}
        catch(IOException e){throw new IllegalStateException("Missing bundled title assets",e);}
    }
    @Override public Scene onLoadScene(){
        Scene scene=new Scene(1);renderer.attach(scene);
        scene.registerUpdateHandler(new IUpdateHandler(){
            public void reset(){accumulated=0;}
            public void onUpdate(float seconds){
                if(navigating || dialog!=null || !foreground || !hasWindowFocus() || ((TvEngine)mEngine).isExplicitlyPaused())return;
                accumulated+=Math.min(.1,Math.max(0,seconds));int count=0;
                while(accumulated>=Game.TICK_SECONDS && count++<6){
                    accumulated-=Game.TICK_SECONDS;int action=TitleSession.NONE;
                    synchronized(inputs){while(!inputs.isEmpty() && action==TitleSession.NONE){ScreenInput.Frame[] event=inputs.removeFirst();action=title.input(event[0],event[1]);}}
                    if(action==TitleSession.NONE)action=title.step(EMPTY,EMPTY);
                    if(action!=TitleSession.NONE){navigating=true;int choice=action;boolean closing=title.screen==TitleSession.CLOSING;runOnUiThread(()->{if(closing)launch(choice);else prepareLaunch(choice);});break;}
                }
                if(count>=6)accumulated=Math.min(accumulated,Game.TICK_SECONDS);
                renderer.title(title,memory());
            }
        });return scene;
    }
    @Override public void onLoadComplete(){loaded=true;runOnUiThread(this::onInputChanged);}
    private void clear(){controllers().clear();resetDialogInput();synchronized(inputs){inputs.clear();}}
    private void prepareLaunch(int action){
        if(isFinishing() || isDestroyed())return;
        controllers().hub.prepareMenu();
        requestedPlayers=action==TitleSession.COOP?2:1;
        if(!controllers().hub.hasPlayers(requestedPlayers)){
            updateControllerNotice();
            clear();runOnUpdateThread(()->{title.returned();accumulated=0;navigating=false;});return;
        }
        requestedPlayers=0;updateControllerNotice();clear();runOnUpdateThread(()->{title.close(action);accumulated=0;navigating=false;});
    }
    private void launch(int action){
        if(isFinishing() || isDestroyed())return;
        controllers().hub.prepareMenu();
        if(!controllers().hub.hasPlayers(action==TitleSession.COOP?2:1)){prepareLaunch(action);return;}
        clear();returning=true;
        if(action==TitleSession.CONSTRUCTION)startActivity(new Intent(this,ConstructionActivity.class));
        else startActivity(new Intent(this,Level1Activity.class).putExtra("coop",action==TitleSession.COOP));
    }
    @Override protected void onGameResumed(){
        controllers().hub.prepareMenu();
        updateControllerNotice();
        if(returning && loaded){
            returning=false;clear();boolean completed=memory().takeCompletedGame();
            runOnUpdateThread(()->{if(completed)title.completedGame();else title.returned();accumulated=0;navigating=false;});
        }
    }
    @Override public void onPauseGame(){clear();accumulated=0;}
    @Override public void onButtons(int deviceId,EnumSet<Button> pressed,boolean gamepad){
        if(dialog!=null){dialogDirection(dialog,deviceId,pressed);return;}
        if(!foreground || !hasWindowFocus() || !loaded || navigating)return;
        if(title.screen==TitleSession.CLOSING)return;
        controllers().hub.prepareMenu();
        int player=gamepad?controllers().hub.player(deviceId):0;if(player<0)return;
        EnumSet<Button> actions=pressed.clone();
        // Remote aliases are outside the two NES pads and cannot trigger the secret.
        if(gamepad)actions.remove(Button.Y);
        else {if(actions.contains(Button.A))actions.add(Button.START);if(actions.contains(Button.DOWN))actions.add(Button.SELECT);if(actions.contains(Button.UP))actions.add(Button.Y);}
        ScreenInput.Frame[] event=new ScreenInput.Frame[2];
        for(int i=0;i<2;i++){InputHub.Controller d=controllers().hub.playerController(i);event[i]=new ScreenInput.Frame(d==null?EnumSet.noneOf(Button.class):d.held(),i==player?actions:EnumSet.noneOf(Button.class));}
        synchronized(inputs){inputs.addLast(event);}
    }
    private void updateControllerNotice(){
        if(!foreground||!loaded||dialog!=null)return;
        String problem=controllers().hub.joyconProblem(),next=problem==null?null:"Joy-Con · "+problem;
        if(next==null&&requestedPlayers>0&&!controllers().hub.hasPlayers(requestedPlayers))
            next=getString(requestedPlayers==2?R.string.need_two_controllers:R.string.need_controller);
        if(next!=null)notice(next);
        else if(controllerNotice!=null&&hint!=null&&controllerNotice.contentEquals(hint.getText()))hideNotice();
        controllerNotice=next;
    }
    @Override public void onInputChanged(){controllers().hub.prepareMenu();updateControllerNotice();}
    @Override public void onControllerDisconnected(int player){clear();onInputChanged();}
    @Override public void onWindowFocusChanged(boolean focus){super.onWindowFocusChanged(focus);synchronized(inputs){inputs.clear();}accumulated=0;}
    @Override public void onBackRequested(){
        if(!foreground || dialog!=null || !loaded)return;
        show(new AlertDialog.Builder(this).setTitle("退出游戏？").setPositiveButton("退出",(d,w)->finish()).setNegativeButton(R.string.cancel,null).create());
    }
    private void show(AlertDialog next){
        clear();dialog=next;
        next.setOnDismissListener(d->{if(dialog==next)dialog=null;clear();});
        next.show();installDialogInput(next);
    }
    @Override protected void onDestroy(){if(dialog!=null)dialog.dismiss();super.onDestroy();}
    boolean acceptingInput(){return loaded && !navigating && title.screen==TitleSession.MENU;}
    TitleSession title(){return title;}
    String displayedRow(int y){return renderer.displayedRow(y);}
    int displayedMenuSelection(){return renderer.menuSelection();}
    AlertDialog currentDialog(){return dialog;}
}
