package org.jiangc.bc.audio;

import org.junit.Test;
import static org.junit.Assert.*;

public final class AudioMixerTest {
    private static double energy(float[] samples){double sum=0;for(float v:samples)sum+=v*v;return sum;}
    @Test public void focusPauseIsSilentManualPauseHasCueAndResetDropsOldEffects(){
        AudioMixer mixer=new AudioMixer(48000);float[] samples=new float[4800];
        mixer.pause(false,false);mixer.cue(15);mixer.render(samples);assertTrue(energy(samples)>0);
        mixer.pause(true,false);mixer.cue(7);mixer.render(samples);assertEquals(0,energy(samples),0);
        mixer.pause(false,false);mixer.pause(true,true);mixer.render(samples);assertTrue(energy(samples)>0);
        mixer.pause(true,false);mixer.render(samples);assertEquals(0,energy(samples),0);
        mixer.reset();mixer.pause(false,false);mixer.render(samples);assertEquals(0,energy(samples),0);
    }
    @Test public void pausedDurationDoesNotAdvancePersistentMusic(){
        for(int[] song:new int[][]{{1,2,3},{21,22,23}}){
        AudioMixer control=new AudioMixer(48000),paused=new AudioMixer(48000);float[] a=new float[4800],b=new float[4800];
        for(AudioMixer m:new AudioMixer[]{control,paused}){for(int id:song)m.cue(id);m.pause(false,false);m.render(new float[8000]);}
        // Both crosses the same pause boundary; only one spends time there.
        // Resume deliberately silences the fractional tick before updating registers.
        control.pause(true,false);control.pause(false,false);
        paused.pause(true,false);paused.render(new float[48000]);paused.pause(false,false);
        for(int block=0;block<5;block++){control.render(a);paused.render(b);}
        assertArrayEquals(a,b,0.000001f);
        }
    }
}
