package org.jiangc.bc;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Insets;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.EnumSet;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Predicate;
import org.jiangc.bc.game.BattleSession;
import org.jiangc.bc.audio.GameAudio;
import org.jiangc.bc.game.Game;
import org.jiangc.bc.game.GameState;
import org.jiangc.bc.game.TitleSession;
import org.jiangc.bc.input.InputHub;
import org.jiangc.bc.input.InputHub.Button;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Framework tests. Synthetic registry devices do not prove Bluetooth mappings. */
@RunWith(AndroidJUnit4.class)
public class TvLifecycleTest {
    private static final long TIMEOUT_MS = 10_000;
    private static final String DEVICE_PREFIX = "test-controller-";
    // Disconnected slots retain descriptors. A fresh prefix prevents automatic joins across tests.
    private final String descriptorPrefix = DEVICE_PREFIX + UUID.randomUUID() + "-";

    private TestControllers devices;
    @Before public void beforeTest() {
        clearSyntheticControllers();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{
            BattleCityApplication app=ApplicationProvider.getApplicationContext();devices=new TestControllers(app);
            devices.connect(101,descriptorPrefix+101);devices.connect(202,descriptorPrefix+202);
        });
        await("Previous audio worker must exit", () -> audioWorkers() == 0);
    }

    @After public void afterTest() {
        // Every ActivityScenario is closed by try-with-resources, including on assertion failure.
        clearSyntheticControllers();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->devices.close());
        await("Audio worker must exit after activity destruction", () -> audioWorkers() == 0);
    }

    private static void clearSyntheticControllers() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            BattleCityApplication app = ApplicationProvider.getApplicationContext();
            InputHub hub = app.controllers().hub;
            app.controllers().clear();
            app.memory().clearConstruction();
            for (InputHub.Device device : hub.devices()) {
                if (device.descriptor.startsWith(DEVICE_PREFIX)) hub.disconnect(device.id);
            }
        });
    }

    private void connect(TvGameActivity activity, int id, int descriptorId) {
        devices.connect(id,descriptorPrefix+descriptorId);
    }

    private void join(TvGameActivity activity, int id) {
        connect(activity, id, id);
        activity.controllers().hub.join(id);
    }

    private ActivityScenario<Level1Activity> launchBattle(boolean coop,int owner){
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{
            BattleCityApplication app=ApplicationProvider.getApplicationContext();
            app.controllers().hub.join(owner);if(coop)app.controllers().hub.join(owner==101?202:101);
        });
        return ActivityScenario.launch(new Intent(ApplicationProvider.getApplicationContext(),Level1Activity.class).putExtra("coop",coop));
    }
    private ActivityScenario<ConstructionActivity> launchEditor(){
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{
            BattleCityApplication app=ApplicationProvider.getApplicationContext();app.controllers().hub.join(101);
        });
        return ActivityScenario.launch(ConstructionActivity.class);
    }
    private static void await(String message, BooleanSupplier condition) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        do {
            if (condition.getAsBoolean()) return;
            SystemClock.sleep(20);
        } while (SystemClock.uptimeMillis() < deadline);
        throw DeviceTestDiagnostics.timeout(message, TIMEOUT_MS, null);
    }

    private static <A extends Activity> void awaitActivity(
            ActivityScenario<A> scenario, String message, Predicate<A> condition) {
        await(message, () -> {
            boolean[] matched = {false};
            scenario.onActivity(activity -> matched[0] = condition.test(activity));
            return matched[0];
        });
    }

    private static <A extends TvGameActivity> void awaitReady(ActivityScenario<A> scenario) {
        awaitActivity(scenario, "Battle window and resources must be ready", activity ->
                activity.foreground && activity.hasWindowFocus() && activity.getEngine() != null
                && activity.getEngine().getScene() != null
                && (!(activity instanceof Level1Activity b) || b.selecting() || b.started())
                && (!(activity instanceof ConstructionActivity c) || c.editing()));
    }

    private static <A extends TvGameActivity> void onEngine(ActivityScenario<A> scenario,
            Consumer<A> action) throws Exception {
        AtomicReference<FutureTask<Void>> pending = new AtomicReference<>();
        scenario.onActivity(activity -> {
            FutureTask<Void> task = new FutureTask<>(() -> { action.accept(activity); return null; });
            pending.set(task);
            activity.runOnUpdateThread(task);
        });
        try {
            pending.get().get(TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (ExecutionException failure) {
            Throwable cause = failure.getCause();
            if (cause instanceof Error) throw (Error) cause;
            if (cause instanceof Exception) throw (Exception) cause;
            throw new AssertionError("Engine task failed", cause);
        } catch (TimeoutException failure) {
            pending.get().cancel(false);
            throw DeviceTestDiagnostics.timeout("Engine task timed out; engine must be running", TIMEOUT_MS, failure);
        }
    }

    private static <A extends TvGameActivity> void awaitEngine(ActivityScenario<A> scenario,
            String message, Predicate<A> condition) throws Exception {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        do {
            boolean[] matched = {false};
            onEngine(scenario, activity -> matched[0] = condition.test(activity));
            if (matched[0]) return;
            SystemClock.sleep(20);
        } while (SystemClock.uptimeMillis() < deadline);
        throw DeviceTestDiagnostics.timeout(message, TIMEOUT_MS, null);
    }

    private static void awaitStarted(ActivityScenario<Level1Activity> scenario) throws Exception {awaitStarted(scenario,101);}
    private static void awaitStarted(ActivityScenario<Level1Activity> scenario,int owner) throws Exception {
        scenario.onActivity(activity->{
            assertTrue(activity.selecting());assertFalse(activity.started());
            activity.onButtons(owner,EnumSet.of(Button.START),true);
        });
        // The original JAR runs queued tasks in reverse order. An empty marker is not a barrier.
        awaitEngine(scenario, "Battle session must be created", activity -> activity.session() != null);
    }

    private static void stable(ActivityScenario<Level1Activity> scenario) {
        int[] tick = {-1};
        scenario.onActivity(activity -> {
            assertTrue(((TvEngine)activity.getEngine()).isExplicitlyPaused());
            synchronized (activity.getEngine()) { tick[0] = activity.session().game.state.tick; }
        });
        // This observation interval tests that a paused simulation does not advance.
        SystemClock.sleep(150);
        scenario.onActivity(activity -> {
            assertTrue(((TvEngine)activity.getEngine()).isExplicitlyPaused());
            synchronized (activity.getEngine()) {
                assertEquals(tick[0], activity.session().game.state.tick);
            }
        });
    }

    @Test public void inputConfigurationChangesKeepTheBattleInstance()throws Exception{
        try(ActivityScenario<Level1Activity> scenario=launchBattle(false,101)){
            awaitActivity(scenario,"Battle selection must be ready",a->a.selecting());
            scenario.onActivity(a->TestControllers.press(a,101,Button.START));
            awaitActivity(scenario,"Battle must be ready",a->a.session()!=null);
            scenario.onActivity(a->{
                try{
                    int flags=a.getPackageManager().getActivityInfo(a.getComponentName(),0).configChanges;
                    int expected=android.content.pm.ActivityInfo.CONFIG_KEYBOARD|android.content.pm.ActivityInfo.CONFIG_KEYBOARD_HIDDEN|android.content.pm.ActivityInfo.CONFIG_NAVIGATION;
                    assertEquals(expected,flags&expected);
                }catch(android.content.pm.PackageManager.NameNotFoundException e){throw new AssertionError(e);}
                Object session=a.session();
                android.content.res.Configuration changed=new android.content.res.Configuration(a.getResources().getConfiguration());
                changed.keyboard=android.content.res.Configuration.KEYBOARD_QWERTY;
                changed.navigation=android.content.res.Configuration.NAVIGATION_DPAD;
                a.onConfigurationChanged(changed);
                assertSame(session,a.session());assertFalse(a.isFinishing());assertFalse(a.selecting());
            });
        }
    }

    @Test public void soloUsesBoundControllerAndLifecycleKeepsPause()throws Exception{
        try(ActivityScenario<Level1Activity> scenario=launchBattle(false,202)){
            awaitReady(scenario);scenario.onActivity(a->{join(a,101);assertTrue(a.selecting());assertFalse(a.started());});
            awaitStarted(scenario,202);
            scenario.onActivity(a->{a.onControllerDisconnected(a.controllers().hub.player(101));assertFalse(((TvEngine)a.getEngine()).isExplicitlyPaused());a.onWindowFocusChanged(false);a.onWindowFocusChanged(true);});
            stable(scenario);
            scenario.onActivity(a->{TestControllers.press(a,101,Button.START);assertTrue(((TvEngine)a.getEngine()).isExplicitlyPaused());TestControllers.press(a,202,Button.START);assertFalse(((TvEngine)a.getEngine()).isExplicitlyPaused());});
            scenario.moveToState(Lifecycle.State.CREATED);scenario.moveToState(Lifecycle.State.RESUMED);awaitReady(scenario);stable(scenario);
        }
    }
    @Test public void coopDisconnectRequiresAllControllersAndManualResume()throws Exception{
        try(ActivityScenario<Level1Activity> scenario=launchBattle(true,101)){
            awaitReady(scenario);awaitStarted(scenario);
            scenario.onActivity(a->{devices.disconnect(202);TestControllers.press(a,101,Button.START);assertTrue(((TvEngine)a.getEngine()).isExplicitlyPaused());connect(a,303,202);});
            stable(scenario);scenario.onActivity(a->{TestControllers.press(a,303,Button.START);assertFalse(((TvEngine)a.getEngine()).isExplicitlyPaused());});
            onEngine(scenario,a->assertEquals(2,a.session().game.state.players.length));
        }
    }

    @Test public void coopInputsAreIsolatedAndGameOverFinishesActivity() throws Exception {
        try (ActivityScenario<Level1Activity> scenario = launchBattle(true,101)) {
            awaitReady(scenario);
            scenario.onActivity(activity -> {
                join(activity, 101);
                join(activity, 202);
            });
            awaitStarted(scenario);
            onEngine(scenario, activity -> {
                Game game = activity.session().game;
                game.state.phase = GameState.PLAYING;
                game.state.spawnTimer = 10000;
                for (GameState.Tank tank : game.state.tanks) {
                    tank.spawnTicks = 0;
                    tank.shieldTicks = 100;
                }
            });
            scenario.onActivity(activity -> {
                InputHub hub = activity.controllers().hub;
                hub.key(101, KeyEvent.KEYCODE_DPAD_UP, Button.UP, true, false);
                hub.key(202, KeyEvent.KEYCODE_DPAD_LEFT, Button.LEFT, true, false);
                activity.onInputChanged();
            });
            awaitEngine(scenario, "Both players must consume their own direction", activity -> {
                Game game = activity.session().game;
                return game.playerTank(0) != null && game.playerTank(1) != null
                        && game.playerTank(0).direction == 0 && game.playerTank(1).direction == 3;
            });
            AtomicReference<BattleSession> previous = new AtomicReference<>();
            onEngine(scenario, activity -> {
                BattleSession session = activity.session();
                previous.set(session);
                Game game = session.game;
                assertEquals(0, game.playerTank(0).direction);
                assertEquals(3, game.playerTank(1).direction);
                game.state.players[0].score = 1500;
                game.state.players[0].lives = 0;
                game.state.players[0].stars = 3;
                game.state.phase = GameState.LOST;
                session.screen = BattleSession.SCORE;
                session.elapsed = session.scoreCompletion() - 1;
            });
            await("Game Over must finish the battle activity",()->scenario.getState()==Lifecycle.State.DESTROYED);
            BattleCityApplication app=ApplicationProvider.getApplicationContext();
            assertArrayEquals(new int[]{1500,0},app.memory().lastScores());

        }
    }

    @Test public void victoryAdvancesAutomaticallyAndRequiresFreshInput() throws Exception {
        try (ActivityScenario<Level1Activity> scenario = launchBattle(false,101)) {
            awaitReady(scenario);
            scenario.onActivity(activity -> {
                join(activity, 101);
            });
            awaitStarted(scenario);
            scenario.onActivity(activity -> {
                InputHub hub = activity.controllers().hub;
                hub.key(101, KeyEvent.KEYCODE_DPAD_UP, Button.UP, true, false);
                hub.key(101, KeyEvent.KEYCODE_BUTTON_A, Button.A, true, false);
                hub.axes(101, 0, 0, 0, 0, .25f);
                hub.axes(101, 1, 0, 0, 0, .25f);
                activity.onInputChanged();
                activity.onButtons(101, EnumSet.of(Button.A), true);
            });
            onEngine(scenario, activity -> {
                BattleSession session = activity.session();
                GameState state = session.game.state;
                state.players[0].score = 23400;
                state.players[0].lives = 1;
                state.players[0].stars = 3;
                state.players[0].nextExtraLife = -1;
                state.phase = GameState.WON;
                session.screen = BattleSession.SCORE;
                session.elapsed = session.scoreCompletion() - 1;
            });
            awaitEngine(scenario, "Victory must enter stage two without confirmation", activity ->
                    activity.session().game.state.stage == 2);
            awaitActivity(scenario, "Stage boundary must clear held controls", activity ->
                    activity.controllers().hub.playerController(0).held().isEmpty());
            scenario.onActivity(activity -> {
                InputHub hub = activity.controllers().hub;
                assertEquals(101, hub.playerController(0).deviceIds().get(0).intValue());
                hub.key(101, KeyEvent.KEYCODE_DPAD_UP, Button.UP, true, false);
                hub.key(101, KeyEvent.KEYCODE_BUTTON_A, Button.A, true, false);
                hub.axes(101, 1, 0, 0, 0, .25f);
                assertTrue(hub.playerController(0).held().isEmpty());
                activity.onInputChanged();
            });
            awaitEngine(scenario, "New stage intro must complete", activity ->
                    activity.session().game.state.tick >= 180);
            onEngine(scenario, activity -> {
                Game game = activity.session().game;
                assertEquals(23400, game.state.players[0].score);
                assertEquals(1, game.state.players[0].lives);
                assertEquals(3, game.state.players[0].stars);
                assertEquals(-1, game.state.players[0].nextExtraLife);
                assertEquals(64, game.playerTank(0).x);
                assertEquals(192, game.playerTank(0).y);
                assertTrue(game.state.bullets.stream().noneMatch(bullet -> bullet.team == 0));
            });
            scenario.onActivity(activity -> {
                InputHub hub = activity.controllers().hub;
                hub.key(101, KeyEvent.KEYCODE_DPAD_UP, Button.UP, false, false);
                hub.key(101, KeyEvent.KEYCODE_BUTTON_A, Button.A, false, false);
                hub.axes(101, 0, 0, 0, 0, .25f);
                hub.key(101, KeyEvent.KEYCODE_DPAD_RIGHT, Button.RIGHT, true, false);
                activity.onInputChanged();
            });
            awaitEngine(scenario, "Fresh input must control the new stage", activity ->
                    activity.session().game.playerTank(0).direction == 1);
        }
    }

    @Test public void scoreBoundaryWaitsForManualResumeAfterCoopReconnect() throws Exception {
        try (ActivityScenario<Level1Activity> scenario = launchBattle(true,101)) {
            awaitReady(scenario);
            scenario.onActivity(activity -> {
                join(activity, 101);join(activity, 202);
            });
            awaitStarted(scenario);
            onEngine(scenario, activity -> {
                BattleSession session = activity.session();
                session.game.state.phase = GameState.WON;
                session.screen = BattleSession.SCORE;session.elapsed = 0;
            });
            AtomicReference<BattleSession> previous = new AtomicReference<>();
            scenario.onActivity(activity -> {
                activity.onButtons(101, EnumSet.of(Button.START), true);
                assertTrue(((TvEngine)activity.getEngine()).isExplicitlyPaused());
                synchronized (activity.getEngine()) {
                    BattleSession session = activity.session();previous.set(session);
                    session.elapsed = session.scoreCompletion() - 1;
                }
                activity.onControllerDisconnected(activity.controllers().hub.disconnect(202));
                connect(activity, 303, 202);activity.onInputChanged();
                assertTrue(((TvEngine)activity.getEngine()).isExplicitlyPaused());
            });
            stable(scenario);
            scenario.onActivity(activity -> {
                synchronized (activity.getEngine()) {
                    assertSame(previous.get(), activity.session());
                    assertEquals(1, activity.session().game.state.stage);
                    assertEquals(activity.session().scoreCompletion() - 1, activity.session().elapsed);
                }
                activity.onButtons(303, EnumSet.of(Button.START), true);
            });
            awaitEngine(scenario, "Manual resume must finish score and enter stage two", activity ->
                    activity.session().game.state.stage == 2);
            onEngine(scenario, activity -> assertEquals(2, activity.session().game.state.players.length));
            scenario.onActivity(activity -> {
                assertEquals(101, activity.controllers().hub.playerController(0).deviceIds().get(0).intValue());
                assertEquals(303, activity.controllers().hub.playerController(1).deviceIds().get(0).intValue());
                activity.onWindowFocusChanged(false);
            });
            stable(scenario);
            scenario.onActivity(activity -> activity.onWindowFocusChanged(true));
            stable(scenario);
        }
    }

    @Test public void exitCancelLeavesGamePausedAndDestroyStopsAudioWorker() throws Exception {
        try (ActivityScenario<Level1Activity> scenario = launchBattle(false,101)) {
            awaitReady(scenario);
            scenario.onActivity(activity -> {
                join(activity, 101);
            });
            awaitStarted(scenario);
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            awaitActivity(scenario, "Exit dialog must receive focus", activity -> !activity.hasWindowFocus());
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            awaitReady(scenario);
            scenario.onActivity(activity -> assertFalse(activity.isFinishing()));
            stable(scenario);
        }
        await("AudioTrack worker must exit after activity destruction", () -> audioWorkers() == 0);
    }

    @Test public void selectionUsesOwnerAndResumeDoesNotStartBattle()throws Exception{
        try(ActivityScenario<Level1Activity> scenario=launchBattle(false,202)){
            awaitReady(scenario);scenario.onActivity(a->{join(a,101);TestControllers.press(a,101,Button.A);});
            onEngine(scenario,a->assertEquals(1,a.selectedStage()));
            scenario.onActivity(a->TestControllers.press(a,202,Button.A));
            awaitEngine(scenario,"Owner A must select stage two",a->a.selectedStage()==2);
            scenario.onActivity(a->{a.onWindowFocusChanged(false);a.onWindowFocusChanged(true);});
            SystemClock.sleep(150);
            scenario.onActivity(a->{assertTrue(((TvEngine)a.getEngine()).isExplicitlyPaused());TestControllers.press(a,202,Button.START);assertTrue(a.selecting());assertFalse(a.started());});
            awaitStarted(scenario,202);onEngine(scenario,a->assertEquals(2,a.session().game.state.stage));
        }
    }

    @Test public void constructionPausesAndReentryKeepsDraftWithoutHeldInput() throws Exception {
        int[] draft=new int[676];
        try(ActivityScenario<ConstructionActivity> scenario=launchEditor()){
            awaitReady(scenario);
            scenario.onActivity(activity->{
                join(activity,101);assertTrue(activity.editing());
                activity.onButtons(101,EnumSet.of(Button.A),true);
            });
            awaitEngine(scenario,"Editor A must paint a brick",activity->activity.construction().tiles()[1]==1);
            scenario.onActivity(activity->{
                activity.controllers().hub.key(101,KeyEvent.KEYCODE_DPAD_RIGHT,Button.RIGHT,true,false);
                activity.onInputChanged();activity.onWindowFocusChanged(false);
            });
            scenario.moveToState(Lifecycle.State.CREATED);scenario.moveToState(Lifecycle.State.RESUMED);awaitReady(scenario);
            scenario.onActivity(activity->{
                connect(activity,303,101);activity.onInputChanged();assertTrue(((TvEngine)activity.getEngine()).isExplicitlyPaused());
                activity.onButtons(303,EnumSet.of(Button.START),true);assertFalse(activity.isFinishing());
            });
            onEngine(scenario,activity->{
                assertEquals(0,activity.construction().code());
                System.arraycopy(activity.construction().tiles(),0,draft,0,draft.length);
            });
            scenario.onActivity(activity->activity.onButtons(303,EnumSet.of(Button.START),true));
            await("Editor START must return to the menu",()->scenario.getState()==Lifecycle.State.DESTROYED);
        }
        BattleCityApplication app=ApplicationProvider.getApplicationContext();assertArrayEquals(draft,app.memory().customTiles());
        try(ActivityScenario<ConstructionActivity> scenario=launchEditor()){
            awaitReady(scenario);
            scenario.onActivity(activity->{join(activity,101);});
            onEngine(scenario,activity->{assertArrayEquals(draft,activity.construction().tiles());assertEquals(0,activity.construction().x());assertEquals(0,activity.construction().y());});
        }
    }

    @Test public void highScoreDisconnectFreezesPresentationAndFinishesOnce() throws Exception {
        BattleCityApplication app=ApplicationProvider.getApplicationContext();int record=app.memory().highScore()+1000;
        try(ActivityScenario<Level1Activity> scenario=launchBattle(false,101)){
            awaitReady(scenario);
            scenario.onActivity(activity->{join(activity,101);});awaitStarted(scenario);
            onEngine(scenario,activity->{
                BattleSession session=activity.session();session.game.state.players[0].score=record;session.game.state.phase=GameState.LOST;
                session.screen=BattleSession.SCORE;session.elapsed=session.scoreCompletion()-1;
            });
            awaitEngine(scenario,"New record must follow Game Over",activity->activity.session().screen==BattleSession.HISCORE);
            int[] elapsed={0};
            scenario.onActivity(activity->{
                activity.onControllerDisconnected(activity.controllers().hub.disconnect(101));
                synchronized(activity.getEngine()){elapsed[0]=activity.session().elapsed;}
                connect(activity,303,101);activity.onInputChanged();assertTrue(((TvEngine)activity.getEngine()).isExplicitlyPaused());
            });
            stable(scenario);
            scenario.onActivity(activity->{
                synchronized(activity.getEngine()){assertEquals(elapsed[0],activity.session().elapsed);assertEquals(BattleSession.HISCORE,activity.session().screen);}
                activity.onButtons(303,EnumSet.of(Button.START),true);assertFalse(activity.isFinishing());
            });
            onEngine(scenario,activity->assertEquals(BattleSession.HISCORE,activity.session().screen));
            await("New record must return automatically",()->scenario.getState()==Lifecycle.State.DESTROYED);
            assertEquals(record,app.memory().highScore());assertArrayEquals(new int[]{record,0},app.memory().lastScores());
        }
    }

    private static long audioWorkers() {
        return Thread.getAllStackTraces().keySet().stream()
                .filter(thread -> thread.isAlive() && thread.getName().equals("BattleCity audio")).count();
    }

    @Test public void titleDoesNotAdvanceWhileStopped() throws Exception {
        try (ActivityScenario<MainMenuActivity> scenario = ActivityScenario.launch(MainMenuActivity.class)) {
            awaitReady(scenario);
            AtomicReference<TitleSession> title = new AtomicReference<>();
            int[] initial = {0};
            onEngine(scenario, activity -> {
                title.set(activity.title());
                initial[0] = title.get().elapsed;
            });
            awaitEngine(scenario, "Title must advance after launch", a -> a.title().elapsed != initial[0]);
            scenario.moveToState(Lifecycle.State.CREATED);
            int stopped = title.get().elapsed;
            // Backgrounded title must not navigate or run its attract mode.
            SystemClock.sleep(2300);
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            assertEquals(Lifecycle.State.CREATED, scenario.getState());
            assertEquals("Stopped title must retain its logical frame", stopped, title.get().elapsed);
            scenario.moveToState(Lifecycle.State.RESUMED);
            awaitReady(scenario);
            awaitEngine(scenario, "Title must advance after resume", a -> a.title().elapsed != stopped);
        }
    }

    @Test public void systemBackCancelsMenuExit() {
        try (ActivityScenario<MainMenuActivity> scenario = ActivityScenario.launch(MainMenuActivity.class)) {
            awaitReady(scenario);
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            awaitActivity(scenario, "Menu exit confirmation must receive focus", a -> !a.hasWindowFocus());
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            awaitReady(scenario);
            scenario.onActivity(a -> assertFalse("Cancelling must retain the menu", a.isFinishing()));
        }
    }

    @Test public void systemBackFromConstructionPreservesDraft() throws Exception {
        try (ActivityScenario<ConstructionActivity> scenario = launchEditor()) {
            awaitReady(scenario);
            scenario.onActivity(a -> {
                join(a, 101);
                a.onButtons(101, EnumSet.of(Button.A), true);
            });
            awaitEngine(scenario, "Editor must paint before returning", a -> a.construction().tiles()[1] == 1);
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            await("System Back must close the editor", () -> scenario.getState() == Lifecycle.State.DESTROYED);
            BattleCityApplication app = ApplicationProvider.getApplicationContext();
            assertNotNull(app.memory().customTiles());
            assertEquals(1, app.memory().customTiles()[1]);
        }
    }

    @Test public void systemInsetsKeepGameContentInsideSafeArea() {
        try (ActivityScenario<MainMenuActivity> scenario = ActivityScenario.launch(MainMenuActivity.class)) {
            awaitReady(scenario);
            scenario.onActivity(TvLifecycleTest::assertSafeArea);
        }
    }

    private static void assertSafeArea(Activity activity) {
        View root = ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
        root.measure(View.MeasureSpec.makeMeasureSpec(640, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY));
        root.layout(0, 0, 640, 480);
        WindowInsets obstructed = new WindowInsets.Builder()
                .setInsets(WindowInsets.Type.systemBars(), Insets.of(100, 20, 40, 60))
                .setInsets(WindowInsets.Type.displayCutout(), Insets.of(0, 50, 0, 0)).build();
        for (int repeat = 0; repeat < 2; repeat++) {
            root.dispatchApplyWindowInsets(obstructed);
            // Available area is 500 x 370; five percent adds 25 x 18 pixels.
            assertArrayEquals(new int[]{125, 68, 65, 78}, new int[]{root.getPaddingLeft(),
                    root.getPaddingTop(), root.getPaddingRight(), root.getPaddingBottom()});
        }
        root.dispatchApplyWindowInsets(new WindowInsets.Builder()
                .setInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout(), Insets.NONE).build());
        assertArrayEquals(new int[]{32, 24, 32, 24}, new int[]{root.getPaddingLeft(),
                root.getPaddingTop(), root.getPaddingRight(), root.getPaddingBottom()});
        root.requestApplyInsets();
    }

    @Test public void audioFocusRequiresForegroundAndCanBeRetried() {
        AtomicReference<GameAudio> audio = new AtomicReference<>();
        try (ActivityScenario<MainMenuActivity> scenario = ActivityScenario.launch(MainMenuActivity.class)) {
            awaitActivity(scenario, "Menu window must be ready", Activity::hasWindowFocus);
            scenario.onActivity(activity -> {
                GameAudio player = new GameAudio(activity, activity::hasWindowFocus, () -> { });
                audio.set(player);
                assertTrue("Foreground audio must acquire focus", player.acquireFocus());
                player.pause(true, false);
            });
            scenario.moveToState(Lifecycle.State.CREATED);
            awaitActivity(scenario, "Background window must lose focus", a -> !a.hasWindowFocus());
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                    assertFalse("Background audio must reject focus", audio.get().acquireFocus()));
            scenario.moveToState(Lifecycle.State.RESUMED);
            awaitActivity(scenario, "Window must regain focus", Activity::hasWindowFocus);
            scenario.onActivity(a -> {
                assertTrue("Foreground retry must remain possible", audio.get().acquireFocus());
                audio.get().close();
                assertFalse("Closed audio must reject focus", audio.get().acquireFocus());
            });
        } finally {
            if (audio.get() != null) audio.get().close();
        }
    }
    @Test public void batchReconnectKeepsDescriptorsInTheirOriginalPlayerSlots(){
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{
            BattleCityApplication app=ApplicationProvider.getApplicationContext();
            app.controllers().hub.join(101);app.controllers().hub.join(202);int[] disconnected=new int[2];
            var listener=new org.jiangc.bc.input.ControllerManager.Listener(){
                public void onButtons(int id,EnumSet<Button> pressed,boolean gamepad){}public void onInputChanged(){}
                public void onControllerDisconnected(int player){disconnected[player]++;}
            };
            app.controllers().attach(listener);
            devices.replaceAll(303,descriptorPrefix+101,404,descriptorPrefix+202);
            assertEquals(0,app.controllers().hub.player(303));assertEquals(1,app.controllers().hub.player(404));
            assertArrayEquals(new int[]{1,1},disconnected);app.controllers().detach(listener);
        });
    }
}
