package org.jiangc.bc.game;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public record Level(int[] tiles,int[] enemies,int[] brickMasks) {
    public Level(int[] tiles,int[] enemies){this(tiles,enemies,Arrays.stream(tiles).map(t->t==1?15:0).toArray());}
    public static Level read(InputStream stream) throws IOException {
        try(BufferedReader reader=new BufferedReader(new InputStreamReader(stream,StandardCharsets.UTF_8))) {
            int[] tiles=parse(reader.readLine()),enemies=parse(reader.readLine());
            String maskLine=reader.readLine();int[] masks=maskLine==null?Arrays.stream(tiles).map(t->t==1?15:0).toArray():parse(maskLine);
            if(tiles.length!=676 || enemies.length==0 || Arrays.stream(tiles).anyMatch(t->t<0 || t>5)
                    || Arrays.stream(enemies).anyMatch(e->e<0 || e>3) || masks.length!=676 || Arrays.stream(masks).anyMatch(m->m<0 || m>15) || reader.readLine()!=null)
                throw new IOException("Invalid level data");
            return new Level(tiles,enemies,masks);
        } catch(IllegalArgumentException e) {
            throw new IOException("Invalid level data",e);
        }
    }
    private static int[] parse(String line) {
        if(line==null) throw new IllegalArgumentException("Missing level row");
        return Arrays.stream(line.split(",",-1)).mapToInt(Integer::parseInt).toArray();
    }
    public Game start(boolean coop,int seed) { return start(coop,1,seed,null); }
    public Game start(boolean coop,int stage,int seed,PlayerCarry[] players) { Game game=new Game(tiles,enemies,coop,stage,seed,players);
        // Spawn clearance remains authoritative over supplied partial-brick geometry.
        for(int i=0;i<676;i++)game.state.brickMasks[i]=game.state.tiles[i]==1?brickMasks[i]:0;return game; }
}
