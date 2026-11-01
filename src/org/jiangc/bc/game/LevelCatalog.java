package org.jiangc.bc.game;

import java.io.IOException;
import java.io.InputStream;

/** The 35 bundled maps, shared by two rounds without sharing mutable game data. */
public final class LevelCatalog {
    public static final int MAP_COUNT = 35, STAGE_COUNT = 70;
    @FunctionalInterface public interface Source { InputStream open(String path) throws IOException; }
    private final Level[] levels;

    private LevelCatalog(Level[] levels) { this.levels=levels; }

    public static LevelCatalog read(Source source) throws IOException {
        Level[] levels=new Level[MAP_COUNT];
        for(int i=0;i<levels.length;i++) {
            levels[i]=Level.read(source.open("battle/stage"+(i+1)+".txt"));
            if(levels[i].enemies().length!=20) throw new IOException("A bundled stage must contain 20 enemies");
        }
        return new LevelCatalog(levels);
    }

    public static int normalize(int stage) {
        if(stage<1) throw new IllegalArgumentException("Stage must be positive");
        return (stage-1)%STAGE_COUNT+1;
    }

    public Level level(int stage) {
        int normalized=normalize(stage);
        Level terrain=levels[(normalized-1)%MAP_COUNT];
        Level wave=levels[Math.min(normalized,MAP_COUNT)-1];
        return new Level(terrain.tiles().clone(),wave.enemies().clone());
    }
}
