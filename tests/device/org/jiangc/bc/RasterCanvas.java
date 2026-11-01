package org.jiangc.bc;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.jiangc.bc.presentation.GameRenderer;
import org.jiangc.bc.presentation.GameRenderer.Frame;

/** Software oracle for the GL adapter; layout is independently checked by JVM tests. */
final class RasterCanvas implements GameRenderer.Canvas,AutoCloseable {
    final int[] pixels=new int[256*240];
    private final Bitmap atlas;
    private final Map<String,Frame> regions=new HashMap<>();
    RasterCanvas(Context context)throws IOException{
        try(InputStream input=context.getAssets().open("battle/atlas.png")){atlas=BitmapFactory.decodeStream(input);}
        try(BufferedReader input=new BufferedReader(new InputStreamReader(context.getAssets().open("battle/atlas.txt"),StandardCharsets.UTF_8))){
            String line;while((line=input.readLine())!=null){String[] fields=line.split("\t");regions.put(fields[0],new Frame(Integer.parseInt(fields[1]),Integer.parseInt(fields[2]),Integer.parseInt(fields[3]),Integer.parseInt(fields[4])));}
        }
    }
    public Frame frame(String key){return regions.get(key);}
    public void begin(){Arrays.fill(pixels,0xff000000);}public void end(){}
    public void draw(String key,int x,int y,int width,int height,int tint){
        Frame f=regions.get(key);
        for(int yy=0;yy<height;yy++)for(int xx=0;xx<width;xx++){
            if(x+xx<0||y+yy<0||x+xx>=256||y+yy>=240)continue;
            int color=atlas.getPixel(f.x()+xx*f.width()/width,f.y()+yy*f.height()/height);if((color>>>24)==0)continue;
            int red=(color>>16&255)*(tint>>16&255)/255,green=(color>>8&255)*(tint>>8&255)/255,blue=(color&255)*(tint&255)/255;
            pixels[(y+yy)*256+x+xx]=0xff000000|red<<16|green<<8|blue;
        }
    }
    public void close(){atlas.recycle();}
}
