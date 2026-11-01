package org.jiangc.bc;

import android.app.Application;
import org.jiangc.bc.input.ControllerManager;
import org.jiangc.bc.game.GameMemory;

public final class BattleCityApplication extends Application {
    private ControllerManager controllers;
    private final GameMemory memory=new GameMemory();
    @Override public void onCreate() {
        super.onCreate();
        controllers = new ControllerManager(this);
    }
    public ControllerManager controllers() { return controllers; }
    public GameMemory memory() { return memory; }
}
