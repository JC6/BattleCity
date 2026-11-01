package org.jiangc.bc.audio;

import java.util.Arrays;

/** Thread-safe command handoff; sample generation belongs exclusively to AudioTrack's worker. */
public final class AudioMixer {
    private final ApuSynth synth,pauseSynth;
    private final ApuDriver driver,pauseDriver;
    private final int sampleRate;
    private final int[] pending=new int[28];
    private boolean paused=true,resumeSilent;
    private double remaining,pauseRemaining;
    public AudioMixer(int rate){sampleRate=rate;synth=new ApuSynth(rate);pauseSynth=new ApuSynth(rate);driver=new ApuDriver(synth::write);pauseDriver=new ApuDriver(pauseSynth::write);reset();}
    private static boolean persistent(int id){return id==1 || id==2 || id==3 || id==17 || id==18 || (id>=21 && id<=26);}
    public synchronized void cue(int id){if(!paused || persistent(id))pending[id]=1;}
    public synchronized void stop(int id){pending[id]=-1;}
    public synchronized void reset(){Arrays.fill(pending,0);synth.reset();driver.reset();pauseSynth.reset();pauseDriver.reset();remaining=pauseRemaining=0;resumeSilent=false;}
    public synchronized void pause(boolean value,boolean manual){
        if(value==paused){if(value && !manual){pauseDriver.reset();pauseSynth.reset();}return;}
        paused=value;pauseDriver.reset();pauseSynth.reset();pauseRemaining=0;
        if(value){for(int i=0;i<28;i++)if(!persistent(i)){pending[i]=0;driver.stop(i);}synth.clearFilters();if(manual)pauseDriver.trigger(0);}
        else {resumeSilent=true;synth.clearFilters();}
        notifyAll();
    }
    public synchronized boolean silentPaused(){return paused && !pauseDriver.hasActivity();}
    public synchronized void awaitSound() throws InterruptedException {while(silentPaused())wait();}
    public synchronized void render(float[] output){
        for(int i=0;i<output.length;i++) {
            if(paused){if(pauseRemaining<=0){pauseDriver.tick(true);pauseRemaining+=sampleRate/60.0988;}output[i]=(float)pauseSynth.sample();pauseRemaining--;continue;}
            if(remaining<=0){for(int id=0;id<28;id++){if(pending[id]>0)driver.trigger(id);else if(pending[id]<0)driver.stop(id);pending[id]=0;}driver.tick();remaining+=sampleRate/60.0988;resumeSilent=false;}
            output[i]=resumeSilent?0:(float)synth.sample();remaining--;
        }
    }
}
