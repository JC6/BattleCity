package org.jiangc.bc.testing;

import java.nio.file.Path;

public final class GameData {
    private GameData() { }
    public static Path path(String relative) {
        String directory=System.getProperty("battlecity.generatedDataDir");
        if(directory==null)throw new IllegalStateException("Missing battlecity.generatedDataDir");
        return Path.of(directory).resolve(relative);
    }
}
