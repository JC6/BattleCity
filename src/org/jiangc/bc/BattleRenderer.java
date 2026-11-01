package org.jiangc.bc;

import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.anddev.andengine.engine.Engine;
import org.anddev.andengine.entity.scene.Scene;
import org.anddev.andengine.entity.sprite.Sprite;
import org.anddev.andengine.opengl.texture.Texture;
import org.anddev.andengine.opengl.texture.TextureOptions;
import org.anddev.andengine.opengl.texture.region.TextureRegion;
import org.anddev.andengine.opengl.texture.region.TextureRegionFactory;
import org.jiangc.bc.presentation.GameRenderer;
import org.jiangc.bc.presentation.GameRenderer.Frame;

/** GL adapter; all screen layout lives in the JVM-tested GameRenderer. */
final class BattleRenderer extends GameRenderer {
    private final Display display;
    BattleRenderer(Context context,Engine engine)throws IOException{this(new Display(context,engine));}
    private BattleRenderer(Display display){super(display);this.display=display;}
    void attach(Scene scene){display.scene=scene;}
    String displayedRow(int y){
        char[] row=new char[32];Arrays.fill(row,' ');
        for(int i=0;i<display.used;i++){String key=display.keys.get(i);Sprite s=display.sprites.get(i);int x=(int)s.getX();
            if(key.startsWith("glyph:") && (int)s.getY()==y && x>=0 && x<256)row[x/8]=key.charAt(6);
        }return new String(row);
    }
    int menuSelection(){for(int i=0;i<display.used;i++)if(display.keys.get(i).startsWith("player:0:") && display.sprites.get(i).getX()==64)return ((int)display.sprites.get(i).getY()-132)/16;return -1;}
    private static final class Display implements Canvas {
        private final Texture texture=new Texture(512,512,TextureOptions.NEAREST_PREMULTIPLYALPHA);
        private final Map<String,Frame> frames=new HashMap<>();
        private final List<Sprite> sprites=new ArrayList<>();
        private final List<String> keys=new ArrayList<>();
        private Scene scene;
        private int used;
        Display(Context context,Engine engine)throws IOException{
            TextureRegionFactory.setAssetBasePath("");
            TextureRegionFactory.createFromAsset(texture,context,"battle/atlas.png",0,0);engine.getTextureManager().loadTexture(texture);
            try(BufferedReader reader=new BufferedReader(new InputStreamReader(context.getAssets().open("battle/atlas.txt"),StandardCharsets.UTF_8))){
                String line;while((line=reader.readLine())!=null){String[] p=line.split("\t");frames.put(p[0],new Frame(Integer.parseInt(p[1]),Integer.parseInt(p[2]),Integer.parseInt(p[3]),Integer.parseInt(p[4])));}
            }
        }
        public Frame frame(String key){return frames.get(key);}
        public void begin(){used=0;}
        public void draw(String key,int x,int y,int width,int height,int color){
            Frame f=frames.get(key);if(f==null)throw new IllegalArgumentException("Missing atlas frame: "+key);Sprite sprite;
            if(used==sprites.size()){sprite=new Sprite(0,0,new TextureRegion(texture,f.x(),f.y(),f.width(),f.height()));sprites.add(sprite);keys.add(key);scene.getLastChild().attachChild(sprite);}
            else {sprite=sprites.get(used);if(!keys.get(used).equals(key)){TextureRegion region=sprite.getTextureRegion();region.setWidth(f.width());region.setHeight(f.height());region.setTexturePosition(f.x(),f.y());keys.set(used,key);}}
            sprite.setVisible(true);sprite.setPosition(x,y);sprite.setSize(width,height);sprite.setColor((color>>16&255)/255f,(color>>8&255)/255f,(color&255)/255f);used++;
        }
        public void end(){for(int i=used;i<sprites.size();i++)sprites.get(i).setVisible(false);}
    }
}
