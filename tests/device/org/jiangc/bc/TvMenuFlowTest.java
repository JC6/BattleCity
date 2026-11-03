package org.jiangc.bc;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.KeyEvent;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.anddev.andengine.engine.handler.IUpdateHandler;
import org.jiangc.bc.game.BattleSession;
import org.jiangc.bc.game.GameState;
import org.jiangc.bc.game.LevelCatalog;
import org.jiangc.bc.game.TitleSession;
import org.jiangc.bc.input.InputHub;
import org.jiangc.bc.input.InputHub.Button;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real menu navigation and Android event dispatch with synthetic device discovery. */
@RunWith(AndroidJUnit4.class)
public class TvMenuFlowTest {
    private static final long TIMEOUT_MS = 10_000;
    private static final String DEVICE_PREFIX = "test-controller-";
    private final String descriptorPrefix = DEVICE_PREFIX + UUID.randomUUID() + "-";
    // Activity references and lifecycle state are accessed only on the main thread.
    private final List<Activity> activities = new ArrayList<>();
    private Activity resumed;
    private BattleCityApplication app;
    private TestControllers devices;
    private ActivityScenario<MainMenuActivity> root;
    private final Application.ActivityLifecycleCallbacks callbacks = new Application.ActivityLifecycleCallbacks() {
        @Override public void onActivityCreated(Activity activity, Bundle state) {
            if (activity instanceof TvGameActivity) activities.add(activity);
        }
        @Override public void onActivityResumed(Activity activity) { resumed = activity; }
        @Override public void onActivityPaused(Activity activity) { if (resumed == activity) resumed = null; }
        @Override public void onActivityStarted(Activity activity) { }
        @Override public void onActivityStopped(Activity activity) { }
        @Override public void onActivitySaveInstanceState(Activity activity, Bundle state) { }
        @Override public void onActivityDestroyed(Activity activity) { }
    };

    @Before public void beforeTest() {
        DeviceTestDiagnostics.begin();
        app = ApplicationProvider.getApplicationContext();
        app.memory().clearConstruction();
        clearSyntheticControllers();
        ui(()->devices=new TestControllers(app));
        await("Previous audio worker must exit", () -> audioWorkers() == 0);
        ui(() -> app.registerActivityLifecycleCallbacks(callbacks));
    }

    @After public void afterTest() {
        try {
            // Closing only the root scenario does not guarantee that its children are destroyed.
            ui(() -> {
                for (int i = activities.size() - 1; i >= 0; i--) {
                    Activity activity = activities.get(i);
                    if (!activity.isDestroyed()) activity.finish();
                }
            });
            if (root != null) root.close();
            awaitUi("All launched activities must be destroyed", () ->
                    activities.stream().allMatch(Activity::isDestroyed));
        } finally {
            try {
                ui(() -> app.unregisterActivityLifecycleCallbacks(callbacks));
                clearSyntheticControllers();
                ui(()->devices.close());
                await("Audio workers must exit even after a failed assertion", () -> audioWorkers() == 0);
            } finally {
                DeviceTestDiagnostics.end();
            }
        }
    }

    @Test public void constructionSelectedStageAndRecordReturnToOriginalMenu() throws Exception {
        LevelCatalog levels = LevelCatalog.read(app.getAssets()::open);
        MainMenuActivity menu = launchMenu();
        connect(101);
        int oldHigh = app.memory().highScore();
        int[] oldScores = app.memory().lastScores();
        remote(menu, KeyEvent.KEYCODE_DPAD_DOWN);
        remote(menu, KeyEvent.KEYCODE_DPAD_DOWN);
        remote(menu, KeyEvent.KEYCODE_DPAD_CENTER);
        ConstructionActivity editor = child(ConstructionActivity.class, null);

        awaitUi("Controller must own the editor", editor::editing);
        for (int i = 1; i <= 4; i++) {
            int expected = i;
            press(editor, 101, Button.RIGHT);
            awaitEngine(editor, "Editor cursor must move right", () -> editor.construction().x() == expected);
        }
        for (int i = 1; i <= 4; i++) {
            int expected = i;
            press(editor, 101, Button.DOWN);
            awaitEngine(editor, "Editor cursor must move down", () -> editor.construction().y() == expected);
        }
        int marker = 8 * 26 + 8;
        press(editor, 101, Button.A);
        awaitEngine(editor, "First press must paint before cycling", () -> editor.construction().tiles()[marker + 1] == 1);
        for (int code = 1; code <= 10; code++) {
            int expected = code;
            press(editor, 101, Button.A);
            awaitEngine(editor, "Editor must consume each block selection", () -> editor.construction().code() == expected);
        }
        AtomicReference<int[]> draft = new AtomicReference<>();
        onEngine(editor, () -> {
            draft.set(editor.construction().tiles());
            for (int offset : new int[]{0, 1, 26, 27}) assertEquals(3, draft.get()[marker + offset]);
        });
        press(editor, 101, Button.START);
        returned(menu, editor, oldHigh, oldScores[0], oldScores[1]);
        assertArrayEquals(draft.get(), app.memory().customTiles());

        remote(menu, KeyEvent.KEYCODE_DPAD_UP);
        remote(menu, KeyEvent.KEYCODE_DPAD_UP);
        remote(menu, KeyEvent.KEYCODE_DPAD_CENTER);
        Level1Activity battle = child(Level1Activity.class, null);
        awaitUi("Single player must enter stage selection", battle::selecting);
        press(battle, 101, Button.A);
        awaitEngine(battle, "Stage selection must reach stage two", () -> battle.selectedStage() == 2);
        start(battle);
        onEngine(battle, () -> {
            GameState state = battle.session().game.state;
            assertEquals(2, state.stage);
            assertEquals(1, state.players.length);
            assertArrayEquals(draft.get(), state.tiles);
            assertArrayEquals(levels.level(2).enemies(), state.enemyQueue);
        });
        int record = oldHigh + 1000;
        AtomicBoolean recordShown = lose(battle, record);
        awaitEngine(battle, "New record must enter HISCORE", () -> battle.session().screen == BattleSession.HISCORE);
        returned(menu, battle, record, record, 0);
        assertTrue("Record presentation must have run", recordShown.get());
        assertNull("Game Over must discard the construction draft", app.memory().customTiles());

        remote(menu, KeyEvent.KEYCODE_DPAD_CENTER);
        Level1Activity fresh = child(Level1Activity.class, battle);
        start(fresh);
        assertFreshGame(fresh, levels, false, record);
    }

    @Test public void coopGateAndIndividualScoresReturnToOriginalMenu() throws Exception {
        LevelCatalog levels = LevelCatalog.read(app.getAssets()::open);
        MainMenuActivity menu = launchMenu();
        int high = app.memory().highScore();
        remote(menu, KeyEvent.KEYCODE_DPAD_DOWN);
        remote(menu, KeyEvent.KEYCODE_DPAD_CENTER);
        awaitUi("Missing controllers must show a title notice",()->menu.hint.getVisibility()==android.view.View.VISIBLE
                && menu.hint.getText().toString().equals(menu.getString(R.string.need_two_controllers)));
        ui(()->assertEquals(1,activities.size()));
        awaitUi("Title must accept the next confirmation",menu::acceptingInput);
        connect(101);remote(menu,KeyEvent.KEYCODE_DPAD_CENTER);
        awaitUi("One controller must show a notice",()->menu.hint.getVisibility()==android.view.View.VISIBLE
                && menu.hint.getText().toString().equals(menu.getString(R.string.need_two_controllers)));
        ui(()->assertEquals(1,activities.size()));
        awaitUi("Title must accept the next confirmation",menu::acceptingInput);
        connect(202);remote(menu,KeyEvent.KEYCODE_DPAD_CENTER);
        Level1Activity battle=child(Level1Activity.class,null);
        start(battle);
        assertFreshGame(battle, levels, true, high);
        // Both individual scores stay below the record, even though their sum exceeds it.
        int first = high - 200, second = high - 100;
        AtomicBoolean recordShown = lose(battle, first, second);
        returned(menu, battle, high, first, second);
        assertFalse("Combined scores must not trigger a record presentation", recordShown.get());
        assertEquals(high, app.memory().highScore());
        assertArrayEquals(new int[]{first, second}, app.memory().lastScores());

        remote(menu, KeyEvent.KEYCODE_DPAD_CENTER);
        Level1Activity fresh = child(Level1Activity.class, battle);
        start(fresh);
        assertFreshGame(fresh, levels, true, high);
    }

    @Test public void rapidMenuInputKeepsHighlightAndDestinationInSync() throws Exception {
        MainMenuActivity menu = launchMenu();
        connect(101);connect(202);
        int high = app.memory().highScore();
        int[] scores = app.memory().lastScores();
        selectInOneFrame(menu, 0);
        selectInOneFrame(menu, 2, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_DOWN);
        selectInOneFrame(menu, 2, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN);
        selectInOneFrame(menu, 0, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_UP,
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN);
        selectInOneFrame(menu, 2, KeyEvent.KEYCODE_DPAD_UP);
        selectInOneFrame(menu, 0, KeyEvent.KEYCODE_DPAD_DOWN);
        selectInOneFrame(menu, 2, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_DOWN);

        remote(menu, KeyEvent.KEYCODE_DPAD_CENTER);
        ConstructionActivity editor = child(ConstructionActivity.class, null);
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
        returned(menu, editor, high, scores[0], scores[1]);
        selectInOneFrame(menu, 2);
        selectInOneFrame(menu, 1, KeyEvent.KEYCODE_DPAD_UP);
        remote(menu, KeyEvent.KEYCODE_DPAD_CENTER);
        Level1Activity battle = child(Level1Activity.class, null);
        ui(() -> assertTrue("Highlighted cooperative mode must be the actual destination",
                battle.getIntent().getBooleanExtra("coop", false)));
    }

    @Test public void attractDemoCanBeInterruptedWithoutStartingOrChangingRecords() throws Exception {
        MainMenuActivity menu=launchMenu();int high=app.memory().highScore();int[] scores=app.memory().lastScores();
        onEngine(menu,()->menu.title().elapsed=639);
        awaitEngine(menu,"Idle title must start demo",()->menu.title().screen==TitleSession.DEMO);
        remote(menu,KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE);
        awaitEngine(menu,"START must return to menu",()->menu.title().screen==TitleSession.MENU);
        assertEquals(high,app.memory().highScore());assertArrayEquals(scores,app.memory().lastScores());
        ui(()->assertEquals(1,activities.size()));assertEquals(0,audioWorkers());
    }

    @Test public void twoControllerSecretShowsCreditsBeforeLaunchingSelectedMode() throws Exception {
        MainMenuActivity menu=launchMenu();connect(101);connect(202);ui(()->app.controllers().hub.hasPlayers(2));
        for(int i=0;i<7;i++)app.memory().finishConstruction();
        ui(()->TestControllers.key(menu,101,Button.DOWN,true));
        for(int i=0;i<8;i++)press(menu,202,Button.A);
        ui(()->{TestControllers.key(menu,101,Button.DOWN,false);TestControllers.key(menu,101,Button.RIGHT,true);});
        for(int i=0;i<12;i++)press(menu,202,Button.B);
        ui(()->TestControllers.key(menu,101,Button.RIGHT,false));press(menu,101,Button.START);
        awaitEngine(menu,"Original secret must enter credits",()->menu.title().screen==TitleSession.CREDITS);
        onEngine(menu,()->menu.title().elapsed=128);
        awaitEngine(menu,"Credits must draw their first line",()->menu.displayedRow(64).contains("THIS PROGRAM WAS"));
        onEngine(menu,()->menu.title().elapsed=885);child(Level1Activity.class,null);
    }

    @Test public void startSkipsGameOverButPreservesNewRecordPresentation() throws Exception {
        MainMenuActivity menu=launchMenu();connect(101);remote(menu,KeyEvent.KEYCODE_DPAD_CENTER);Level1Activity battle=child(Level1Activity.class,null);
        start(battle);int score=app.memory().highScore()+1000;
        AtomicBoolean record=lose(battle,score);
        ui(()->{battle.onWindowFocusChanged(false);battle.onWindowFocusChanged(true);assertTrue(((TvEngine)battle.getEngine()).isExplicitlyPaused());});
        press(battle,101,Button.START);
        ui(()->assertFalse("First START must resume a paused Game Over",((TvEngine)battle.getEngine()).isExplicitlyPaused()));
        onEngine(battle,()->assertEquals(BattleSession.GAME_OVER,battle.session().screen));
        press(battle,101,Button.START);
        awaitEngine(battle,"Skipping Game Over must still show record",()->battle.session().screen==BattleSession.HISCORE);
        returned(menu,battle,score,score,0);assertTrue(record.get());
    }

    @Test public void firstControllerStartEntersSelectionWithoutReadyPageOrExtraConfirmation()throws Exception{
        MainMenuActivity menu=launchMenu();connect(101);
        press(menu,101,Button.START);
        Level1Activity battle=child(Level1Activity.class,null);
        ui(()->{assertTrue(battle.selecting());assertFalse(battle.started());assertEquals(101,app.controllers().hub.playerController(0).deviceIds().get(0).intValue());assertEquals(android.view.View.GONE,battle.hint.getVisibility());});
        onEngine(battle,()->assertEquals(1,battle.selectedStage()));
        start(battle);
        ui(()->TestControllers.press(battle,101,Button.SELECT));
        ui(()->assertTrue("SELECT must not open an exit dialog",battle.hasWindowFocus()));
        onEngine(battle,()->{
            GameState g=battle.session().game.state;g.phase=GameState.PLAYING;g.spawnTimer=10000;g.tanks.forEach(t->{t.spawnTicks=0;t.shieldTicks=1000;});
        });
        ui(()->{TestControllers.axes(battle,101,0,0,0,0);TestControllers.axes(battle,101,1,0,0,0);});
        awaitEngine(battle,"Actual AXIS_X dispatch must move player right",()->battle.session().game.playerTank(0).direction==1);
        ui(()->{TestControllers.axes(battle,101,0,0,0,0);TestControllers.axes(battle,101,0,0,0,-1);});
        awaitEngine(battle,"Actual HAT_Y dispatch must move player up",()->battle.session().game.playerTank(0).direction==0);
    }

    @Test public void pairedJoyconsShareOnePlayerAndKeepMovementWhileFiring()throws Exception{
        MainMenuActivity menu=launchMenu();connectPair();
        pairStart(menu,202);Level1Activity battle=child(Level1Activity.class,null);
        ui(()->{assertEquals(List.of(101,202),app.controllers().hub.playerController(0).deviceIds());assertNull(app.controllers().hub.playerController(1));});
        pairStart(battle,202);awaitEngine(battle,"Pair must start one-player stage",()->battle.session()!=null);
        AtomicBoolean fired=new AtomicBoolean();arena(battle,fired,null);
        leftAxes(battle,101,0,0);leftAxes(battle,101,1,0);
        ui(()->TestControllers.rawKey(battle,202,KeyEvent.KEYCODE_UNKNOWN,0x130,true));
        awaitEngine(battle,"Left movement and right fire must act on one tank",()->battle.session().game.playerTank(0).x>64&&fired.get());
        ui(()->{
            TestControllers.rawAxes(battle,202,new int[]{11,14},new float[]{-1,1});
            assertEquals(java.util.EnumSet.of(Button.RIGHT,Button.B),app.controllers().hub.playerController(0).held());
        });
        leftAxes(battle,101,0,0);
        ui(()->{
            assertEquals(java.util.EnumSet.of(Button.B),app.controllers().hub.playerController(0).held());
            TestControllers.rawKey(battle,202,KeyEvent.KEYCODE_UNKNOWN,0x130,false);
            assertTrue(app.controllers().hub.playerController(0).held().isEmpty());
        });
        pairStart(battle,202);ui(()->assertTrue(((TvEngine)battle.getEngine()).isExplicitlyPaused()));
        leftAxes(battle,101,0,0);pairStart(battle,202);ui(()->assertFalse(((TvEngine)battle.getEngine()).isExplicitlyPaused()));
        ui(()->{
            devices.joycon(404,descriptorPrefix+404,true);
            assertTrue(((TvEngine)battle.getEngine()).isExplicitlyPaused());
            assertNull(app.controllers().hub.playerController(0));
            assertTrue(app.controllers().hub.joyconProblem().contains("多余"));
            devices.disconnect(404);
            assertNotNull(app.controllers().hub.playerController(0));
            assertTrue(((TvEngine)battle.getEngine()).isExplicitlyPaused());
        });
    }
    @Test public void incompletePairCannotJoinOrReplayHeldStart()throws Exception{
        MainMenuActivity menu=launchMenu();ui(()->devices.joycon(202,descriptorPrefix+202,false));
        ui(()->{
            TestControllers.rawKey(menu,202,KeyEvent.KEYCODE_UNKNOWN,0x13b,true);
            assertNull(app.controllers().hub.playerController(0));
            assertEquals(TitleSession.MENU,menu.title().screen);
            devices.joycon(101,descriptorPrefix+101,true);
            assertNull(app.controllers().hub.playerController(0));
            TestControllers.rawKey(menu,202,KeyEvent.KEYCODE_UNKNOWN,0x13b,false);
        });
        pairStart(menu,202);Level1Activity battle=child(Level1Activity.class,null);
        awaitUi("A fresh plus press must enter selection",battle::selecting);
        ui(()->{assertEquals(0,app.controllers().hub.player(101));assertEquals(0,app.controllers().hub.player(202));assertFalse(app.controllers().hub.hasPlayers(2));});
    }
    @Test public void remoteCommandsAndFaceButtonsCannotClaimPlayerSlots()throws Exception{
        MainMenuActivity menu=launchMenu(false);
        ui(()->{
            devices.passive(10,descriptorPrefix+10);devices.pro(303,descriptorPrefix+303);
            for(int code:new int[]{KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,KeyEvent.KEYCODE_DPAD_CENTER,KeyEvent.KEYCODE_ENTER,KeyEvent.KEYCODE_DPAD_DOWN}){
                TestControllers.rawKey(menu,10,code,0,true);TestControllers.rawKey(menu,10,code,0,false);
                assertEquals(-1,app.controllers().hub.player(10));
            }
            TestControllers.nintendoPress(menu,303,Button.A);
            assertEquals(-1,app.controllers().hub.player(303));assertFalse(app.controllers().hub.hasPlayers(1));
        });
        press(menu,303,Button.START);
        ui(()->{assertEquals(0,app.controllers().hub.player(303));assertEquals(-1,app.controllers().hub.player(10));});
    }
    @Test public void proFirstAndPairSecondReconnectAsOnePlayer()throws Exception{mixedPair(false);}
    @Test public void pairFirstAndProSecondReconnectAsOnePlayer()throws Exception{mixedPair(true);}
    private void mixedPair(boolean pairFirst)throws Exception{
        MainMenuActivity menu=launchMenu(false);ui(()->devices.passive(10,descriptorPrefix+10));connectPair();ui(()->devices.pro(303,descriptorPrefix+303));
        if(pairFirst)pairStart(menu,202);else press(menu,303,Button.START);
        awaitEngine(menu,"First plus must join and stop at title",()->menu.title().screen==TitleSession.MENU);
        if(pairFirst)ui(()->TestControllers.scan(menu,101,0x13a));else press(menu,303,Button.SELECT);
        awaitEngine(menu,"Select must choose coop",()->menu.title().selected==1);
        if(pairFirst){press(menu,303,Button.START);pairStart(menu,202);}
        else {pairStart(menu,202);press(menu,303,Button.START);}
        Level1Activity battle=child(Level1Activity.class,null);awaitUi("Mixed controllers must reach selection",battle::selecting);
        ui(()->{assertEquals(-1,app.controllers().hub.player(10));assertEquals(pairFirst?0:1,app.controllers().hub.player(101));assertEquals(pairFirst?1:0,app.controllers().hub.player(303));});
        if(pairFirst)pairStart(battle,202);else press(battle,303,Button.START);
        awaitEngine(battle,"Mixed controllers must start coop",()->battle.session()!=null);
        AtomicBoolean first=new AtomicBoolean(),second=new AtomicBoolean();arena(battle,first,second);
        int pairPlayer=pairFirst?0:1,proPlayer=1-pairPlayer;
        leftAxes(battle,101,0,0);leftAxes(battle,101,1,0);
        ui(()->{TestControllers.axes(battle,303,0,0,0,0);TestControllers.axes(battle,303,0,-1,0,0);});
        awaitEngine(battle,"Pro and pair must move independently",()->battle.session().game.playerTank(pairPlayer).x>64+pairPlayer*64 && battle.session().game.playerTank(proPlayer).y<192);
        leftAxes(battle,101,0,0);ui(()->TestControllers.axes(battle,303,0,0,0,0));
        ui(()->TestControllers.scan(battle,202,0x130));press(battle,303,Button.A);
        awaitEngine(battle,"Both logical controllers must fire",()->first.get()&&second.get());
        int missing=pairFirst?202:101;
        ui(()->{
            devices.disconnect(missing);assertTrue(((TvEngine)battle.getEngine()).isExplicitlyPaused());
            assertNull(app.controllers().hub.playerController(pairPlayer));
            assertEquals(List.of(303),app.controllers().hub.playerController(proPlayer).deviceIds());
        });
        press(battle,303,Button.START);ui(()->assertTrue(((TvEngine)battle.getEngine()).isExplicitlyPaused()));
        ui(()->{
            devices.joycon(404,descriptorPrefix+missing,missing==101);
            assertEquals(pairPlayer,app.controllers().hub.player(404));
            assertEquals(pairPlayer,app.controllers().hub.player(missing==101?202:101));
            assertTrue(((TvEngine)battle.getEngine()).isExplicitlyPaused());
        });
        leftAxes(battle,missing==101?404:101,0,0);pairStart(battle,missing==202?404:202);
        ui(()->assertFalse(((TvEngine)battle.getEngine()).isExplicitlyPaused()));
    }
    @Test public void pairCannotStartSelectionUntilBothHalvesReturn()throws Exception{
        MainMenuActivity menu=launchMenu();connectPair();pairStart(menu,202);
        Level1Activity battle=child(Level1Activity.class,null);awaitUi("Selection must be ready",battle::selecting);
        ui(()->devices.disconnect(101));pairStart(battle,202);
        ui(()->{assertTrue(battle.selecting());assertFalse(battle.started());assertTrue(((TvEngine)battle.getEngine()).isExplicitlyPaused());devices.joycon(404,descriptorPrefix+101,true);});
        leftAxes(battle,404,0,0);pairStart(battle,202);
        ui(()->{assertTrue(battle.selecting());assertFalse(battle.started());assertFalse(((TvEngine)battle.getEngine()).isExplicitlyPaused());});
        pairStart(battle,202);awaitEngine(battle,"Second plus must start after resuming selection",()->battle.session()!=null);
    }
    @Test public void pairEditsWithBothHalvesAndReconnectsPaused()throws Exception{
        MainMenuActivity menu=launchMenu();connectPair();joinMenuPair();
        ui(()->{TestControllers.scan(menu,101,0x13a);TestControllers.scan(menu,101,0x13a);});pairStart(menu,202);
        ConstructionActivity editor=child(ConstructionActivity.class,null);awaitUi("Pair must own the editor",editor::editing);
        ui(()->TestControllers.scan(editor,101,0x223));awaitEngine(editor,"Left dpad must move cursor",()->editor.construction().x()==1);
        ui(()->TestControllers.scan(editor,202,0x131));
        awaitEngine(editor,"First right A must paint the current block",()->
                editor.construction().code()==0 && editor.construction().tiles()[3]==1);
        ui(()->TestControllers.scan(editor,202,0x131));
        awaitEngine(editor,"Second right A must cycle forward",()->editor.construction().code()==1);
        ui(()->{devices.disconnect(202);assertTrue(((TvEngine)editor.getEngine()).isExplicitlyPaused());devices.joycon(404,descriptorPrefix+202,false);});
        leftAxes(editor,101,0,0);pairStart(editor,404);
        ui(()->{assertFalse(editor.isFinishing());assertFalse(((TvEngine)editor.getEngine()).isExplicitlyPaused());});
        pairStart(editor,404);awaitUi("Next plus must save and return",editor::isDestroyed);awaitReturnedMenu(menu);
        ui(()->assertNotNull(app.memory().customTiles()));
    }
    @Test public void remainingSecondControllerCanStartFromTitleAfterPairDisconnects()throws Exception{
        MainMenuActivity menu=launchMenu();connectPair();ui(()->app.controllers().hub.join(202));connect(303);
        ui(()->{app.controllers().hub.join(303);devices.disconnect(101);devices.disconnect(202);});
        press(menu,303,Button.START);Level1Activity battle=child(Level1Activity.class,null);
        awaitUi("Remaining pad must reach selection",battle::selecting);
        ui(()->assertEquals(0,app.controllers().hub.player(303)));
    }
    @Test public void pairedExitConfirmationDefaultsToCancelAndNoAuxiliaryPageOpens()throws Exception{
        MainMenuActivity menu=launchMenu();connectPair();ui(()->TestControllers.scan(menu,202,0x134));
        boolean[] touchMode={false};ui(()->touchMode[0]=menu.getWindow().getDecorView().isInTouchMode());
        InstrumentationRegistry.getInstrumentation().setInTouchMode(true);
        try {
            ui(()->{assertNull(menu.currentDialog());assertEquals(1,activities.size());menu.onBackRequested();});
            awaitUi("Exit confirmation must focus Cancel in touch mode",()->menu.currentDialog()!=null
                    && menu.currentDialog().isShowing()
                    && menu.currentDialog().getWindow().getDecorView().hasWindowFocus()
                    && menu.currentDialog().getButton(android.app.AlertDialog.BUTTON_NEGATIVE).hasFocus());
            ui(()->TestControllers.scan(menu.currentDialog(),202,0x131));
            awaitUi("Confirming the default must cancel",()->menu.currentDialog()==null&&menu.hasWindowFocus());
            ui(()->assertFalse(menu.isFinishing()));
        } finally {
            InstrumentationRegistry.getInstrumentation().setInTouchMode(touchMode[0]);
        }
    }
    @Test public void actualGlAdapterMatchesSoftwareAcrossSpriteSizesAndPausedScreens()throws Exception{
        MainMenuActivity menu=launchMenu();AtomicReference<BattleRenderer> display=new AtomicReference<>();
        AtomicReference<org.anddev.andengine.entity.scene.Scene> previous=new AtomicReference<>();
        onEngine(menu,()->{
            ((TvEngine)menu.getEngine()).setExplicitlyPaused(true);previous.set(menu.getEngine().getScene());
            try{display.set(new BattleRenderer(menu,menu.getEngine()));}catch(java.io.IOException e){throw new java.io.UncheckedIOException(e);}
            var scene=new org.anddev.andengine.entity.scene.Scene(1);display.get().attach(scene);menu.getEngine().setScene(scene);
        });
        try(RasterCanvas raster=new RasterCanvas(menu)){
            org.jiangc.bc.presentation.GameRenderer oracle=new org.jiangc.bc.presentation.GameRenderer(raster);
            var memory=new org.jiangc.bc.game.GameMemory();var title=new TitleSession(new org.jiangc.bc.game.Level(new int[676],new int[20]),memory);title.returned();
            var game=new org.jiangc.bc.game.Game(new int[676],new int[20],false,1);game.state.phase=GameState.PLAYING;game.state.tanks.clear();
            var session=new BattleSession(game);var editor=new org.jiangc.bc.game.ConstructionState();
            for(int repeat=0;repeat<2;repeat++){
                onEngine(menu,()->display.get().title(title,memory));oracle.title(title,memory);awaitPixels(menu,"title pool",0,0,256,240,raster.pixels);
                onEngine(menu,()->{
                    game.state.tanks.clear();game.state.bullets.clear();
                    var player=new GameState.Tank();player.playerIndex=0;player.spawnTicks=0;player.x=player.y=64;game.state.tanks.add(player);
                    for(int d=0;d<4;d++){var bullet=new GameState.Bullet();bullet.x=32+d*40;bullet.y=40;bullet.direction=d;game.state.bullets.add(bullet);}
                    display.get().render(session);
                });
                oracle.render(session);awaitPixels(menu,"tank, four bullets and HUD",0,0,256,240,raster.pixels);
                for(int death:new int[]{0x73,0x63,0x53,0x43,0x33,0x13}){
                    var tank=new GameState.Tank();tank.x=tank.y=64;tank.deathTimer=death;tank.deathPoints=400;
                    onEngine(menu,()->{game.state.tanks.clear();game.state.bullets.clear();game.state.tanks.add(tank);display.get().render(session);});
                    oracle.render(session);awaitPixels(menu,"explosion pool",0,0,256,240,raster.pixels);
                }
                onEngine(menu,()->{session.screen=BattleSession.SCORE;display.get().render(session);});oracle.render(session);awaitPixels(menu,"score pool",0,0,256,240,raster.pixels);
                onEngine(menu,()->display.get().selection(1,true,16));oracle.selection(1,true,16);awaitPixels(menu,"paused selection",0,0,256,240,raster.pixels);
                onEngine(menu,()->display.get().construction(editor,0,true,16));oracle.construction(editor,0,true,16);awaitPixels(menu,"paused editor",0,0,256,240,raster.pixels);
                session.screen=BattleSession.BATTLE;
                onEngine(menu,()->{game.state.tanks.clear();game.state.bullets.clear();display.get().render(session);});
                oracle.render(session);awaitPixels(menu,"cleared sprite pool",0,0,256,240,raster.pixels);
            }
        }finally{onEngine(menu,()->{menu.getEngine().setScene(previous.get());((TvEngine)menu.getEngine()).setExplicitlyPaused(false);});}
    }
    @Test public void recreatedTitleConsumesOldCompletionBeforeAnEditorReturn()throws Exception{
        ui(()->app.memory().finishGame(new org.jiangc.bc.game.Game(new int[676],new int[20],false,1).state));
        MainMenuActivity menu=launchMenu();ui(()->assertFalse(app.memory().takeCompletedGame()));
        connect(101);selectInOneFrame(menu,2,KeyEvent.KEYCODE_DPAD_DOWN,KeyEvent.KEYCODE_DPAD_DOWN);
        remote(menu,KeyEvent.KEYCODE_DPAD_CENTER);ConstructionActivity editor=child(ConstructionActivity.class,null);
        press(editor,101,Button.START);awaitUi("Editor must return",editor::isDestroyed);awaitReady(menu);
        awaitEngine(menu,"Editor return must keep the static menu",()->menu.title().screen==TitleSession.MENU);
    }
    @Test public void incompletePairShowsItsReasonBeforeAnyMappedButton()throws Exception{
        MainMenuActivity menu=launchMenu();ui(()->devices.numberedJoycon(202,descriptorPrefix+202,false));
        awaitUi("Missing left half must be visible without a successful key",()->menu.hint.getVisibility()==android.view.View.VISIBLE&&menu.hint.getText().toString().contains("缺左"));
        ui(()->devices.numberedJoycon(101,descriptorPrefix+101,true));
        awaitUi("Completing the pair must clear its notice",()->menu.hint.getVisibility()==android.view.View.GONE);
        joinMenuPair();
        ui(()->TestControllers.numberedPress(menu,101,9));awaitEngine(menu,"Numbered minus must select coop",()->menu.title().selected==1);
    }
    @Test public void matchingSensorNodeDoesNotBecomeAnExtraLeftHalf()throws Exception{
        MainMenuActivity menu=launchMenu();connectPair();ui(()->devices.sensor(404,descriptorPrefix+404));
        ui(()->{assertEquals(2,app.controllers().hub.devices().size());assertNull(app.controllers().hub.joyconProblem());});
        pairStart(menu,202);Level1Activity battle=child(Level1Activity.class,null);ui(()->assertTrue(battle.selecting()));
    }
    @Test public void sourceChangePausesButR2CannotBecomeStart()throws Exception{
        MainMenuActivity menu=launchMenu();connectPair();pairStart(menu,202);Level1Activity battle=child(Level1Activity.class,null);
        pairStart(battle,202);awaitEngine(battle,"Native pair must start",()->battle.session()!=null);
        ui(()->{
            TestControllers.rawKey(battle,202,KeyEvent.KEYCODE_UNKNOWN,0x130,true);
            devices.numberedJoycon(202,descriptorPrefix+202,false);
            assertTrue(((TvEngine)battle.getEngine()).isExplicitlyPaused());
            assertTrue(app.controllers().hub.playerController(0).held().isEmpty());
            TestControllers.rawKey(battle,202,KeyEvent.KEYCODE_BUTTON_A,0x130,false);
            TestControllers.rawKey(battle,202,KeyEvent.KEYCODE_BUTTON_R2,0x139,true);
            TestControllers.rawKey(battle,202,KeyEvent.KEYCODE_BUTTON_R2,0x139,false);
            assertTrue("R2 must not resume as plus",((TvEngine)battle.getEngine()).isExplicitlyPaused());
            TestControllers.rawKey(battle,202,KeyEvent.KEYCODE_BUTTON_START,0x13b,true);
            TestControllers.rawKey(battle,202,KeyEvent.KEYCODE_BUTTON_START,0x13b,false);
            assertFalse(((TvEngine)battle.getEngine()).isExplicitlyPaused());
            assertEquals(List.of(101,202),app.controllers().hub.playerController(0).deviceIds());
        });
    }
    @Test public void titleSourceChangeDiscardsQueuedOldMenuActions()throws Exception{
        MainMenuActivity menu=launchMenu();
        ui(()->{devices.numberedJoycon(101,descriptorPrefix+101,true);devices.numberedJoycon(202,descriptorPrefix+202,false);});
        joinMenuPair();
        onEngine(menu,()->ui(()->{
            TestControllers.numberedPress(menu,101,9);
            devices.joycon(101,descriptorPrefix+101,true);
            try{
                var field=MainMenuActivity.class.getDeclaredField("inputs");field.setAccessible(true);
                assertTrue(((java.util.Deque<?>)field.get(menu)).isEmpty());
            }catch(ReflectiveOperationException e){throw new AssertionError(e);}
            TestControllers.scan(menu,101,0x13a);
        }));
        awaitEngine(menu,"Only the fresh minus may select coop",()->menu.title().selected==1);
    }
    @Test public void printedProButtonsWorkAcrossMenusEditorAndBattle()throws Exception{printedControlsAcrossPages(0);}
    @Test public void printedNativeJoyconButtonsWorkAcrossMenusEditorAndBattle()throws Exception{printedControlsAcrossPages(1);}
    @Test public void printedNumberedJoyconButtonsWorkAcrossMenusEditorAndBattle()throws Exception{printedControlsAcrossPages(2);}
    private void printedControlsAcrossPages(int kind)throws Exception{
        MainMenuActivity menu=launchMenu(false);
        ui(()->{
            if(kind==0)devices.pro(101,descriptorPrefix+101);
            else if(kind==1){devices.joycon(101,descriptorPrefix+101,true);devices.joycon(202,descriptorPrefix+202,false);}
            else {devices.numberedJoycon(101,descriptorPrefix+101,true);devices.numberedJoycon(202,descriptorPrefix+202,false);}
        });
        int left=101,right=kind==0?101:202;
        wirePress(menu,kind,left,right,Button.START);
        awaitEngine(menu,"First plus must join at title",()->menu.title().screen==TitleSession.MENU);
        wirePress(menu,kind,left,right,Button.X);wirePress(menu,kind,left,right,Button.Y);
        wirePress(menu,kind,left,right,Button.SELECT);
        awaitEngine(menu,"Only minus may change the title selection",()->menu.title().selected==1);
        wirePress(menu,kind,left,right,Button.SELECT);
        awaitEngine(menu,"Second minus must select construction",()->menu.title().selected==2);
        ui(menu::onBackRequested);
        awaitUi("Exit dialog must open",()->menu.currentDialog()!=null&&menu.currentDialog().isShowing());
        dialogPress(menu,kind,left,right,Button.RIGHT);
        awaitUi("Direction must focus the exit button",()->menu.currentDialog().getButton(android.app.AlertDialog.BUTTON_POSITIVE).hasFocus());
        dialogPress(menu,kind,left,right,Button.B);
        awaitUi("Printed B must cancel even when exit is focused",()->menu.currentDialog()==null&&menu.hasWindowFocus());
        ui(()->assertFalse(menu.isFinishing()));
        wirePress(menu,kind,left,right,Button.START);
        ConstructionActivity editor=child(ConstructionActivity.class,null);
        wirePress(editor,kind,left,right,Button.A);
        awaitEngine(editor,"Printed A must paint the initial block",()->editor.construction().tiles()[1]==1);
        wirePress(editor,kind,left,right,Button.A);
        awaitEngine(editor,"Printed A must cycle forward",()->editor.construction().code()==1);
        wirePress(editor,kind,left,right,Button.B);
        awaitEngine(editor,"Printed B must cycle backward",()->editor.construction().code()==0);
        wirePress(editor,kind,left,right,Button.RIGHT);
        awaitEngine(editor,"Direction must move the editor cursor",()->editor.construction().x()==1);
        wirePress(editor,kind,left,right,Button.START);
        awaitUi("Plus must save and return",editor::isDestroyed);awaitReturnedMenu(menu);
        wirePress(menu,kind,left,right,Button.SELECT);
        awaitEngine(menu,"Minus after construction must select single player",()->menu.title().selected==0);
        wirePress(menu,kind,left,right,Button.START);
        Level1Activity battle=child(Level1Activity.class,null);
        wirePress(battle,kind,left,right,Button.A);
        awaitEngine(battle,"Printed A must increase the stage",()->battle.selectedStage()==2);
        wirePress(battle,kind,left,right,Button.B);
        awaitEngine(battle,"Printed B must decrease the stage",()->battle.selectedStage()==1);
        wirePress(battle,kind,left,right,Button.START);
        awaitEngine(battle,"Plus must start the selected stage",()->battle.session()!=null);
        AtomicBoolean fired=new AtomicBoolean();arena(battle,fired,null);
        ui(()->{
            TestControllers.axes(battle,left,1,0,0,0);wireKey(battle,kind,left,right,Button.A,true);
            assertEquals(java.util.EnumSet.of(Button.RIGHT,Button.A),app.controllers().hub.playerController(0).held());
        });
        awaitEngine(battle,"Movement and printed A must fire together",()->fired.get()&&battle.session().game.playerTank(0).direction==1);
        ui(()->{wireKey(battle,kind,left,right,Button.A,false);TestControllers.axes(battle,left,0,0,0,0);});
        wirePress(battle,kind,left,right,Button.START);
        ui(()->assertTrue(((TvEngine)battle.getEngine()).isExplicitlyPaused()));
        wirePress(battle,kind,left,right,Button.START);
        ui(()->assertFalse(((TvEngine)battle.getEngine()).isExplicitlyPaused()));
        ui(battle::finish);awaitUi("Battle must finish",battle::isDestroyed);awaitReturnedMenu(menu);
        ui(menu::onBackRequested);
        awaitUi("Exit dialog must reopen",()->menu.currentDialog()!=null&&menu.currentDialog().isShowing());
        dialogPress(menu,kind,left,right,Button.RIGHT);
        awaitUi("Exit must have focus",()->menu.currentDialog().getButton(android.app.AlertDialog.BUTTON_POSITIVE).hasFocus());
        dialogPress(menu,kind,left,right,Button.A);
        awaitUi("Printed A must confirm exit",menu::isDestroyed);
    }
    private static void wirePress(android.view.Window.Callback target,int kind,int left,int right,Button printed){
        ui(()->{wireKey(target,kind,left,right,printed,true);wireKey(target,kind,left,right,printed,false);});
    }
    private static void dialogPress(MainMenuActivity menu,int kind,int left,int right,Button printed){
        ui(()->{wireKey(menu.currentDialog(),kind,left,right,printed,true);wireKey(menu.currentDialog(),kind,left,right,printed,false);});
    }
    private static void wireKey(android.view.Window.Callback target,int kind,int left,int right,Button printed,boolean down){
        int id=switch(printed){case UP,DOWN,LEFT,RIGHT,SELECT->left;default->right;};
        if(kind!=2){TestControllers.nintendoKey(target,id,printed,down);return;}
        int number=switch(printed){case A->2;case B->1;case X->4;case Y->3;case START->10;case SELECT->9;
            case UP->4;case DOWN->1;case LEFT->3;case RIGHT->2;default->throw new IllegalArgumentException("Unused button "+printed);};
        TestControllers.numberedKey(target,id,number,down);
    }
    private void connectPair(){ui(()->{devices.joycon(101,descriptorPrefix+101,true);devices.joycon(202,descriptorPrefix+202,false);});}
    // Like connect(id), arrange an assigned menu controller. Other tests exercise
    // joining through real START events; discovery alone must not join this pair.
    private void joinMenuPair(){ui(()->assertEquals("Complete pair must be assigned to 1P",0,app.controllers().hub.join(202)));}
    private static void pairStart(TvGameActivity activity,int rightId){ui(()->TestControllers.scan(activity,rightId,0x13b));}
    private static void leftAxes(android.view.Window.Callback target,int id,float x,float y){ui(()->TestControllers.rawAxes(target,id,new int[]{0,1},new float[]{x,y}));}
    private static void arena(Level1Activity battle,AtomicBoolean first,AtomicBoolean second)throws Exception{
        onEngine(battle,()->{
            GameState state=battle.session().game.state;state.phase=GameState.PLAYING;state.spawnTimer=10000;
            java.util.Arrays.fill(state.tiles,0);java.util.Arrays.fill(state.brickMasks,0);
            state.tanks.removeIf(t->t.team==1);state.tanks.forEach(t->{t.spawnTicks=0;t.shieldTicks=1000;});
            battle.getEngine().getScene().registerUpdateHandler(new IUpdateHandler(){
                public void reset(){}
                public void onUpdate(float seconds){for(GameState.Bullet b:state.bullets)if(b.team==0){if(b.playerIndex==0)first.set(true);else if(second!=null)second.set(true);}}
            });
        });
    }
    private static void awaitPixels(TvGameActivity activity,String label,int left,int top,int width,int height,int[] expected)throws Exception{
        long deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;
        do{
            android.graphics.Bitmap bitmap=capture(activity);
            try{if(pixelsMatch(bitmap,left,top,width,height,expected))return;}finally{bitmap.recycle();}
            SystemClock.sleep(30);
        }while(SystemClock.uptimeMillis()<deadline);
        fail("GL pixels differ from generated Web resources: "+label);
    }
    private static boolean pixelsMatch(android.graphics.Bitmap image,int left,int top,int width,int height,int[] expected){
        int scale=image.getWidth()/256;
        if(scale<1 || image.getWidth()!=256*scale || image.getHeight()!=240*scale)return false;
        for(int y=0;y<height*scale;y++)for(int x=0;x<width*scale;x++){
            int actual=image.getPixel(left*scale+x,top*scale+y),wanted=expected[(y/scale)*width+x/scale];
            for(int shift:new int[]{0,8,16})if(Math.abs((actual>>shift&255)-(wanted>>shift&255))>8)return false;
        }
        return true;
    }
    private static android.view.SurfaceView surface(android.view.View v){
        if(v instanceof android.view.SurfaceView s)return s;
        if(v instanceof android.view.ViewGroup g)for(int i=0;i<g.getChildCount();i++){android.view.SurfaceView s=surface(g.getChildAt(i));if(s!=null)return s;}
        return null;
    }
    private static android.graphics.Bitmap capture(TvGameActivity activity)throws Exception{
        java.util.concurrent.CountDownLatch copied=new java.util.concurrent.CountDownLatch(1);
        AtomicReference<android.graphics.Bitmap> bitmap=new AtomicReference<>();int[] result={-1};
        ui(()->{
            android.view.SurfaceView view=surface(activity.findViewById(android.R.id.content));assertNotNull(view);
            bitmap.set(android.graphics.Bitmap.createBitmap(view.getWidth(),view.getHeight(),android.graphics.Bitmap.Config.ARGB_8888));
            android.view.PixelCopy.request(view,bitmap.get(),code->{result[0]=code;copied.countDown();},new android.os.Handler(android.os.Looper.getMainLooper()));
        });
        assertTrue("PixelCopy must complete",copied.await(5,TimeUnit.SECONDS));assertEquals(android.view.PixelCopy.SUCCESS,result[0]);return bitmap.get();
    }
    private static void selectInOneFrame(MainMenuActivity menu, int selected, int... keys) throws Exception {
        ui(()->{
            TvEngine engine=(TvEngine)menu.getEngine();engine.setExplicitlyPaused(true);
            try{for(int key:keys)dispatchRemote(menu,key);}finally{engine.setExplicitlyPaused(false);}
        });
        awaitEngine(menu,"Rendered tank cursor must agree with selected mode",()->menu.displayedMenuSelection()==selected && menu.title().selected==selected);
    }

    private MainMenuActivity launchMenu() throws Exception { return launchMenu(true); }
    private MainMenuActivity launchMenu(boolean skipScroll) throws Exception {
        root = ActivityScenario.launch(MainMenuActivity.class);
        AtomicReference<MainMenuActivity> menu = new AtomicReference<>();
        root.onActivity(menu::set);
        awaitReady(menu.get());
        ui(() -> assertEquals(0, menu.get().getWindow().getAttributes().flags
                & android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        if(skipScroll){remote(menu.get(),KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE);
            awaitEngine(menu.get(),"Scroll skip must stop at the title",()->menu.get().title().screen==TitleSession.MENU);}
        return menu.get();
    }

    private <A extends TvGameActivity> A child(Class<A> type, A previous) {
        AtomicReference<A> found = new AtomicReference<>();
        awaitUi("Menu must launch " + type.getSimpleName(), () -> {
            for (Activity activity : activities) {
                if (type.isInstance(activity) && activity != previous && !activity.isDestroyed()) {
                    found.set(type.cast(activity));
                    return true;
                }
            }
            return false;
        });
        awaitReady(found.get());
        return found.get();
    }

    private void returned(MainMenuActivity menu, Activity child, int high, int first, int second) throws Exception {
        awaitUi("Child activity must finish", child::isDestroyed);
        awaitReturnedMenu(menu);
        ui(() -> {
            assertSame("The original menu must resume", menu, resumed);
            assertEquals("Returning must not create another menu", 1,
                    activities.stream().filter(a -> a instanceof MainMenuActivity).count());
            assertEquals("No child may remain on the activity stack", 1,
                    activities.stream().filter(a -> !a.isDestroyed()).count());
        });
        awaitEngine(menu, "Visible menu records must refresh", () -> {
            String row=menu.displayedRow(24);
            return row.substring(4,10).strip().equals(menuScore(first)) && row.substring(14,20).strip().equals(menuScore(high))
                && (!app.memory().lastCoop() || row.substring(23,29).strip().equals(menuScore(second)));
        });
        await("Returning to the menu must release audio", () -> audioWorkers() == 0);
    }

    private static String menuScore(int value) {
        int displayed = value % 1_000_000;
        return displayed == 0 ? "00" : Integer.toString(displayed);
    }

    private void awaitReturnedMenu(MainMenuActivity menu) throws Exception {
        awaitReady(menu);
        ui(() -> assertEquals(0, menu.getWindow().getAttributes().flags
                & android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        // Window focus can return before the queued engine reset is executed.
        awaitEngine(menu, "Returned menu must accept input and render its selection", () ->
                menu.acceptingInput() && menu.displayedMenuSelection() == menu.title().selected);
    }

    private static void start(Level1Activity battle) throws Exception {
        awaitUi("Stage selection must be active", battle::selecting);
        press(battle, 101, Button.START);
        // The original JAR executes queued tasks in reverse order; an empty task is not a barrier.
        awaitEngine(battle, "Battle session must be created", () -> battle.session() != null);
        await("Exactly one battle audio worker must exist", () -> audioWorkers() == 1);
    }

    private static void assertFreshGame(Level1Activity battle, LevelCatalog levels, boolean coop, int high) throws Exception {
        onEngine(battle, () -> {
            GameState state = battle.session().game.state;
            assertEquals(1, state.stage);
            assertEquals(high, battle.session().highScore);
            assertEquals(coop ? 2 : 1, state.players.length);
            assertArrayEquals(levels.level(1).start(coop, 1, 1, null).state.tiles, state.tiles);
            assertArrayEquals(levels.level(1).enemies(), state.enemyQueue);
            for (GameState.Player player : state.players) {
                assertEquals(0, player.score);
                assertEquals(2, player.lives);
                assertEquals(0, player.stars);
                assertEquals(20000, player.nextExtraLife);
                assertFalse(player.eliminated);
                assertArrayEquals(new int[4], player.kills);
            }
        });
        ui(() -> {
            assertEquals(101, battle.controllers().hub.playerController(0).deviceIds().get(0).intValue());
            if (coop) assertEquals(202, battle.controllers().hub.playerController(1).deviceIds().get(0).intValue());
        });
    }

    private static AtomicBoolean lose(Level1Activity battle, int... scores) throws Exception {
        AtomicBoolean recordShown = new AtomicBoolean();
        onEngine(battle, () -> {
            BattleSession session = battle.session();
            assertEquals(scores.length, session.game.state.players.length);
            for (int i = 0; i < scores.length; i++) {
                GameState.Player player = session.game.state.players[i];
                player.score = scores[i];
                player.lives = 0;
                player.stars = 3;
                player.nextExtraLife = -1;
                player.eliminated = true;
            }
            // Accelerate gameplay only. GAME_OVER, HISCORE, finish(), and menu refresh run normally.
            session.game.state.phase = GameState.LOST;
            session.screen = BattleSession.SCORE;
            session.elapsed = session.scoreCompletion() - 1;
            battle.getEngine().getScene().registerUpdateHandler(new IUpdateHandler() {
                @Override public void reset() { }
                @Override public void onUpdate(float seconds) {
                    if (session.screen == BattleSession.HISCORE) recordShown.set(true);
                }
            });
        });
        awaitEngine(battle, "Scoring must enter GAME_OVER", () -> battle.session().screen == BattleSession.GAME_OVER);
        return recordShown;
    }

    private void connect(int id){ui(()->{devices.connect(id,descriptorPrefix+id);app.controllers().hub.join(id);});}
    private static void press(TvGameActivity activity,int id,Button button){ui(()->TestControllers.press(activity,id,button));}

    private static void remote(TvGameActivity activity, int key) {
        ui(() -> dispatchRemote(activity, key));
    }

    private static void dispatchRemote(TvGameActivity activity, int key) {
        assertTrue(activity.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, key)));
        assertTrue(activity.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, key)));
    }

    private void clearSyntheticControllers() {
        ui(() -> {
            app.controllers().clear();
            app.memory().clearConstruction();
            for (InputHub.Device device : app.controllers().hub.devices()) {
                if (device.descriptor.startsWith(DEVICE_PREFIX)) app.controllers().hub.disconnect(device.id);
            }
        });
    }

    private void awaitReady(TvGameActivity activity) {
        awaitUi("Window, scene and input must be ready", () -> {
            DeviceTestDiagnostics.observe(activity);
            return resumed == activity
                && activity.foreground && activity.hasWindowFocus() && activity.getEngine() != null
                && activity.getEngine().getScene() != null
                && (!(activity instanceof Level1Activity b) || b.selecting() || b.started())
                && (!(activity instanceof ConstructionActivity c) || c.editing());
        });
    }

    private static void ui(Runnable action) { InstrumentationRegistry.getInstrumentation().runOnMainSync(action); }

    private static void await(String message, BooleanSupplier condition) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        do {
            if (condition.getAsBoolean()) return;
            SystemClock.sleep(20);
        } while (SystemClock.uptimeMillis() < deadline);
        throw DeviceTestDiagnostics.timeout(message, TIMEOUT_MS, null);
    }

    private static void awaitUi(String message, BooleanSupplier condition) {
        await(message, () -> {
            boolean[] matched = {false};
            ui(() -> matched[0] = condition.getAsBoolean());
            return matched[0];
        });
    }

    private static void onEngine(TvGameActivity activity, Runnable action) throws Exception {
        FutureTask<Void> task = new FutureTask<>(action, null);
        ui(() -> { DeviceTestDiagnostics.observe(activity); activity.runOnUpdateThread(task); });
        awaitTask(task);
    }

    private static void awaitTask(FutureTask<Void> task) throws Exception {
        try {
            task.get(TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (ExecutionException failure) {
            Throwable cause = failure.getCause();
            if (cause instanceof Error) throw (Error) cause;
            if (cause instanceof Exception) throw (Exception) cause;
            throw new AssertionError("Engine task failed", cause);
        } catch (TimeoutException failure) {
            task.cancel(false);
            throw DeviceTestDiagnostics.timeout("Engine task timed out; engine must be running", TIMEOUT_MS, failure);
        }
    }

    private static void awaitEngine(TvGameActivity activity, String message, BooleanSupplier condition) throws Exception {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        do {
            boolean[] matched = {false};
            onEngine(activity, () -> matched[0] = condition.getAsBoolean());
            if (matched[0]) return;
            SystemClock.sleep(20);
        } while (SystemClock.uptimeMillis() < deadline);
        throw DeviceTestDiagnostics.timeout(message, TIMEOUT_MS, null);
    }

    private static long audioWorkers() {
        return Thread.getAllStackTraces().keySet().stream()
                .filter(thread -> thread.isAlive() && thread.getName().equals("BattleCity audio")).count();
    }
}
