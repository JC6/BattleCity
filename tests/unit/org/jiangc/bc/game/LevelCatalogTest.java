package org.jiangc.bc.game;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import org.junit.Test;
import static org.junit.Assert.*;

public final class LevelCatalogTest {
    static LevelCatalog catalog() throws IOException {
        return LevelCatalog.read(path->Files.newInputStream(org.jiangc.bc.testing.GameData.path("assets/"+path)));
    }
    @Test public void allSeventyStagesUseTheBundledWebMapsAndRoundTwoWave() throws Exception {
        LevelCatalog catalog=catalog();Level[] expected=new Level[35];
        for(int i=0;i<35;i++)expected[i]=Level.read(Files.newInputStream(org.jiangc.bc.testing.GameData.path("assets/battle/stage"+(i+1)+".txt")));
        for(int stage=1;stage<=70;stage++){
            assertArrayEquals("map "+stage,expected[(stage-1)%35].tiles(),catalog.level(stage).tiles());
            assertArrayEquals("wave "+stage,expected[Math.min(stage,35)-1].enemies(),catalog.level(stage).enemies());
        }
        assertEquals(1,catalog.level(1).tiles()[2*26+2]);
        assertEquals(2,catalog.level(1).tiles()[6*26+12]);
        assertEquals(4,catalog.level(2).tiles()[8*26]);
    }
    @Test public void catalogAndGameDataCannotCorruptOtherStages() throws Exception {
        LevelCatalog catalog=catalog();Level original=catalog.level(1),other=catalog.level(1);
        Game game=original.start(false,1);
        game.state.tiles[0]=5;game.state.enemyQueue[0]=3;
        assertArrayEquals(other.tiles(),original.tiles());assertArrayEquals(other.enemies(),original.enemies());
        Arrays.fill(original.tiles(),5);Arrays.fill(original.enemies(),3);
        assertArrayEquals(other.tiles(),catalog.level(1).tiles());
        assertArrayEquals(other.tiles(),catalog.level(36).tiles());
        assertArrayEquals(other.enemies(),catalog.level(1).enemies());
        assertArrayEquals(catalog.level(35).enemies(),catalog.level(36).enemies());
    }
    @Test public void stageNormalizationAndActualSpawningFollowBothRounds() throws Exception {
        LevelCatalog catalog=catalog();
        int[][] cases={{1,1,186},{2,2,182},{35,35,50},{36,36,50},{70,70,50},{71,1,186},{140,70,50},{141,1,186}};
        for(int[] c:cases)for(boolean coop:new boolean[]{false,true}) {
            Game game=catalog.level(c[0]).start(coop,c[0],123,null);
            assertEquals(c[1],game.state.stage);
            for(int i=0;i<=96;i++)game.step(new PlayerInput[0]);
            assertEquals(1,game.state.spawned);
            assertEquals(c[2]-(coop?20:0),game.state.spawnTimer);
        }
        assertThrows(IllegalArgumentException.class,()->catalog.level(0));
        assertThrows(IllegalArgumentException.class,()->catalog.level(-1));
    }
    @Test public void missingOrMalformedBundledLevelsFailLoading() throws Exception {
        byte[] valid=Files.readAllBytes(org.jiangc.bc.testing.GameData.path("assets/battle/stage1.txt"));
        String terrain=new String(valid,StandardCharsets.UTF_8).split("\n")[0];
        for(String invalid:new String[]{"", "0\n0\n", terrain+"\n4\n", terrain+"\n0\nextra\n", terrain+",\n0\n"})
            assertThrows(IOException.class,()->Level.read(new ByteArrayInputStream(invalid.getBytes(StandardCharsets.UTF_8))));
        assertThrows(IOException.class,()->LevelCatalog.read(path->{
            if(path.endsWith("stage2.txt"))throw new IOException("Missing bundled stage");
            return new ByteArrayInputStream(valid);
        }));
        assertThrows(IOException.class,()->LevelCatalog.read(path->new ByteArrayInputStream((terrain+"\n0\n").getBytes(StandardCharsets.UTF_8))));
    }
}
