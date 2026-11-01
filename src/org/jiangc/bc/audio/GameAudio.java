package org.jiangc.bc.audio;

import android.content.Context;
import android.media.*;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Log;
import java.util.List;
import java.util.function.BooleanSupplier;
import org.jiangc.bc.game.GameEvent;
import org.jiangc.bc.game.GameState;
import org.jiangc.bc.game.GameState.Tank;

/** Native streaming audio; initialization failure leaves the game playable in silence. */
public final class GameAudio implements AutoCloseable {
    private final AudioManager manager;
    private final AudioFocusRequest focus;
    private final AudioAttributes attributes;
    private final AudioMixer mixer;
    private final Thread worker;
    private final BooleanSupplier mayPlay;
    private volatile boolean closed,failed;
    private int engine=-1;
    private boolean ice;
    public GameAudio(Context context,BooleanSupplier mayPlay,Runnable focusLost) {
        this.mayPlay=mayPlay;
        manager=context.getSystemService(AudioManager.class);
        attributes=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();
        focus=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes)
                .setWillPauseWhenDucked(true).setOnAudioFocusChangeListener(change->{if(change!=AudioManager.AUDIOFOCUS_GAIN && !closed)focusLost.run();},new Handler(Looper.getMainLooper())).build();
        int rate=48000;
        try{String property=manager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE);if(property!=null)rate=Integer.parseInt(property);}catch(RuntimeException ignored){ }
        if(rate<8000 || rate>192000)rate=48000;
        mixer=new AudioMixer(rate);final int sampleRate=rate;
        worker=new Thread(()->stream(sampleRate),"BattleCity audio");worker.start();
    }
    private void stream(int rate) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);AudioTrack track=null;
        try {
            int min=AudioTrack.getMinBufferSize(rate,AudioFormat.CHANNEL_OUT_MONO,AudioFormat.ENCODING_PCM_FLOAT);
            track=new AudioTrack.Builder().setAudioAttributes(attributes).setAudioFormat(new AudioFormat.Builder()
                    .setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_FLOAT).build())
                    .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(Math.max(min,2048))
                    .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY).build();
            if(track.getState()!=AudioTrack.STATE_INITIALIZED)throw new IllegalStateException("AudioTrack initialization failed");
            float[] pcm=new float[256];
            while(!closed){
                if(mixer.silentPaused()){
                    if(track.getPlayState()==AudioTrack.PLAYSTATE_PLAYING){track.pause();track.flush();}
                    mixer.awaitSound();if(closed)break;
                }
                if(track.getPlayState()!=AudioTrack.PLAYSTATE_PLAYING)track.play();
                mixer.render(pcm);int offset=0;
                while(offset<pcm.length && !closed){int written=track.write(pcm,offset,pcm.length-offset,AudioTrack.WRITE_BLOCKING);if(written<=0)throw new IllegalStateException("AudioTrack write: "+written);offset+=written;}
            }
        } catch(InterruptedException stopped){Thread.currentThread().interrupt();}
        catch(RuntimeException failure){failed=true;Log.w("BattleCity","Audio unavailable; continuing silently",failure);}
        finally {if(track!=null){try{track.pause();track.flush();}catch(IllegalStateException ignored){ }track.release();}}
    }
    public boolean acquireFocus(){
        if(closed || !mayPlay.getAsBoolean())return false;
        return failed || manager.requestAudioFocus(focus)==AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }
    public boolean unavailable(){return failed;}
    public void pause(boolean paused,boolean manual){mixer.pause(paused,manual);if(paused && !manual)manager.abandonAudioFocusRequest(focus);}
    public void reset(){mixer.reset();engine=-1;ice=false;}
    public void intro(){for(int id:new int[]{1,2,3})mixer.cue(id);}
    public void gameOver(){for(int id:new int[]{24,25,26})mixer.cue(id);}
    public void highScore(){for(int id:new int[]{21,22,23})mixer.cue(id);}
    public void count(){mixer.cue(19);mixer.cue(20);}
    public void bonus(){mixer.cue(27);}
    public void state(GameState s) {
        boolean active=s.phase==GameState.PLAYING && s.pendingOutcome<0,sliding=false;
        for(Tank t:s.tanks)if(active && t.team==0 && t.active()){if(t.slideTicks>0)sliding=true;}
        int next=EngineSound.cue(s);
        if(next!=engine){mixer.stop(17);mixer.stop(18);if(next>=0)mixer.cue(next);engine=next;}
        if(sliding && !ice)mixer.cue(16);ice=sliding;
    }
    public void play(List<GameEvent> events) {
        for(GameEvent e:events)switch(e.type){
            case "score-bonus":bonus();break;
            case "fire":if(e.team.equals("player"))mixer.cue(15);break;
            case "hit":if(e.target.equals("tank")){if(!e.tankTeam.equals("player"))mixer.cue(14);}
                else if(e.steelPower && !e.target.equals("boundary"))mixer.cue(12);
                else if(e.gunSlot<2)mixer.cue(e.target.equals("brick")?12:13);break;
            case "explosion":if(e.owner.equals("base")){mixer.cue(11);mixer.cue(7);}else mixer.cue(e.owner.equals("enemy")?10:7);break;
            case "powerup":mixer.cue(e.action.equals("appear")?9:6);break;
            case "extra-life":mixer.cue(4);mixer.cue(5);break;
            default:break;
        }
    }
    @Override public void close(){if(closed)return;closed=true;mixer.pause(true,false);manager.abandonAudioFocusRequest(focus);worker.interrupt();}
}
