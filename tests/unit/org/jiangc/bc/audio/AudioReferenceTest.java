package org.jiangc.bc.audio;

import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class AudioReferenceTest {
    @Test public void pauseSequenceWritesTheOriginalFirstNoteAfterOneTick(){
        // EE2C: channel 2, $82/$7F/$40, duration 4, note $1B.
        // ECE6 fourth period $06AE >> 3 = $D5; EA7E writes before decoding.
        List<String> writes=new ArrayList<>();ApuDriver d=new ApuDriver((c,r,v)->writes.add(c+","+r+","+v));d.reset();writes.clear();d.trigger(0);d.tick(true);
        assertFalse(writes.contains("1,2,213"));writes.clear();d.tick(true);
        assertTrue(writes.containsAll(List.of("1,0,130","1,1,127","1,2,213","1,3,64")));
    }
    @Test public void songsStopAtSourceDerivedDurationsAndPauseOnlyFreezesSongs(){
        // EEC1: (12*2+12*2+8*2)*5 +80+60 =460 note ticks plus initial decode.
        // EF3C: nine notes, durations 12*? (full duration checked below).
        ApuDriver d=new ApuDriver((c,r,v)->{});d.trigger(21);for(int i=0;i<460;i++)d.tick();assertTrue(d.active(21));
        for(int i=0;i<100;i++)d.tick(true);assertTrue(d.active(21));d.tick();assertFalse(d.active(21));
        d.reset();d.trigger(24);for(int i=0;i<108;i++)d.tick();assertTrue(d.active(24));d.tick();assertFalse(d.active(24));
    }
    @Test public void lowerSlotOwnsChannelAndStoppingItRevealsPendingTrack(){
        List<Integer> controls=new ArrayList<>();ApuDriver d=new ApuDriver((c,r,v)->{if(c==0 && r==0)controls.add(v);});
        d.trigger(1);d.trigger(21);d.tick();controls.clear();d.tick();assertEquals(List.of(129),controls);
        d.stop(1);controls.clear();d.tick();assertEquals(List.of(184),controls);
    }
    @Test public void synthesisIsFiniteAudibleAndRateIndependentInDuration(){
        for(int rate:new int[]{44100,48000}){
            ApuSynth synth=new ApuSynth(rate);ApuDriver d=new ApuDriver(synth::write);d.reset();d.trigger(0);double energy=0,remaining=0;int ticks=0;
            for(int i=0;i<rate;i++){if(remaining<=0){d.tick();ticks++;remaining+=rate/60.0988;}double sample=synth.sample();assertTrue(Double.isFinite(sample));assertTrue(Math.abs(sample)<2);energy+=sample*sample;remaining--;}
            assertTrue(energy>0);assertFalse(d.active(0));assertEquals(61,ticks);
        }
    }
}
