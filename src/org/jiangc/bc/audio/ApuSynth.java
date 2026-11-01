package org.jiangc.bc.audio;

import java.util.Arrays;

/** CPU-clocked four-voice APU: timers, envelopes and sweep, with approximate analog filtering. */
public final class ApuSynth {
    private static final int[] LENGTHS={10,254,20,2,40,4,80,6,160,8,60,10,14,12,26,14,12,16,24,18,48,20,96,22,192,24,72,26,16,28,32,30};
    private static final int[] NOISE_PERIODS={4,8,16,32,64,96,128,160,202,254,380,508,762,1016,2034,4068};
    private static final int[] DUTIES={1,3,15,252},BOUNDARIES={7457,14913,22371,29829,37281};
    private static final class Channel {
        final int[] registers=new int[4];int timer,phase,length,envelope,divider,sweepDivider;
        double clock;boolean envelopeStart,sweepReload;
    }
    private final Channel[] channels=new Channel[4];
    private int linear,noise=1,sequencerStep;
    private boolean linearReload;
    private double sequencer,previousInput,hp90,hp440,previous90,low;
    private final double cyclesPerSample,high90,high440,low14k;
    public ApuSynth(int sampleRate) {
        for(int i=0;i<4;i++)channels[i]=new Channel();
        cyclesPerSample=1789773.0/sampleRate;high90=Math.exp(-2*Math.PI*90/sampleRate);
        high440=Math.exp(-2*Math.PI*440/sampleRate);low14k=1-Math.exp(-2*Math.PI*14000/sampleRate);
    }
    public void reset() {
        for(Channel c:channels){Arrays.fill(c.registers,0);c.timer=c.phase=c.length=c.envelope=c.divider=c.sweepDivider=0;c.clock=0;c.envelopeStart=c.sweepReload=false;}
        linear=sequencerStep=0;linearReload=false;noise=1;sequencer=0;clearFilters();
    }
    public void clearFilters(){previousInput=hp90=hp440=previous90=low=0;}
    public void write(int index,int register,int value) {
        Channel c=channels[index];value&=255;c.registers[register]=value;
        if(register==1 && index<2)c.sweepReload=true;
        if(register==2 && index<3)c.timer=(c.timer&0x700)|value;
        if(register==3){c.timer=(c.timer&255)|((value&7)<<8);c.length=LENGTHS[value>>3];c.envelopeStart=true;
            if(index<2){c.phase=0;c.clock=0;}if(index==2)linearReload=true;}
    }
    public double sample() {
        sequencer+=cyclesPerSample;
        if(sequencer>=BOUNDARIES[sequencerStep]) {
            if(sequencerStep!=3)quarterFrame();if(sequencerStep==1 || sequencerStep==4)halfFrame();
            if(++sequencerStep==5){sequencer-=37282;sequencerStep=0;}
        }
        int pulse=0;
        for(int i=0;i<2;i++) {
            Channel c=channels[i];c.clock+=cyclesPerSample;int period=2*(c.timer+1),steps=(int)Math.floor(c.clock/period);
            c.clock-=steps*period;c.phase=(c.phase+steps)&7;
            if(c.length!=0 && c.timer>=8 && sweepTarget(i)<=0x7ff && ((DUTIES[c.registers[0]>>6]>>c.phase)&1)!=0)pulse+=volume(c);
        }
        Channel triangle=channels[2];
        if(triangle.length!=0 && linear!=0 && triangle.timer>1){triangle.clock+=cyclesPerSample;int period=triangle.timer+1,steps=(int)Math.floor(triangle.clock/period);triangle.clock-=steps*period;triangle.phase=(triangle.phase+steps)&31;}
        int tri=triangle.length!=0 && linear!=0 && triangle.registers[0]!=0?(triangle.phase<16?15-triangle.phase:triangle.phase-16):0;
        Channel n=channels[3];n.clock+=cyclesPerSample;int period=NOISE_PERIODS[n.registers[2]&15];
        // Stepping a muted LFSR also preserves its phase, without the browser's quiet-block optimization.
        int steps=(int)Math.floor(n.clock/period);n.clock-=steps*period;
        int tap=(n.registers[2]&0x80)!=0?6:1;
        for(int i=0;i<steps;i++)noise=(noise>>1)|(((noise^(noise>>tap))&1)<<14);
        int noiseOutput=n.length!=0 && (noise&1)==0?volume(n):0;
        double tnd=tri/8227.0+noiseOutput/12241.0;
        double input=(pulse!=0?95.88/(8128.0/pulse+100):0)+(tnd!=0?159.79/(1/tnd+100):0);
        hp90=high90*(hp90+input-previousInput);previousInput=input;
        hp440=high440*(hp440+hp90-previous90);previous90=hp90;low+=low14k*(hp440-low);return low;
    }
    private int volume(Channel c){return (c.registers[0]&0x10)!=0?c.registers[0]&15:c.envelope;}
    private void quarterFrame() {
        for(int i=0;i<4;i++)if(i!=2){Channel c=channels[i];
            if(c.envelopeStart){c.envelopeStart=false;c.envelope=15;c.divider=c.registers[0]&15;}
            else if(c.divider!=0)c.divider--;else{c.divider=c.registers[0]&15;if(c.envelope!=0)c.envelope--;else if((c.registers[0]&0x20)!=0)c.envelope=15;}}
        Channel t=channels[2];if(linearReload)linear=t.registers[0]&0x7f;else if(linear!=0)linear--;
        if((t.registers[0]&0x80)==0)linearReload=false;
    }
    private int sweepTarget(int index){Channel c=channels[index];int sweep=c.registers[1],delta=c.timer>>(sweep&7);return (sweep&8)!=0?c.timer-delta-(index==0?1:0):c.timer+delta;}
    private void halfFrame() {
        for(int i=0;i<4;i++){Channel c=channels[i];int control=c.registers[0];if((control&(i==2?0x80:0x20))==0 && c.length!=0)c.length--;
            if(i>=2)continue;int sweep=c.registers[1],target=sweepTarget(i);
            if(c.sweepDivider==0 && (sweep&0x80)!=0 && (sweep&7)!=0 && c.timer>=8 && target<=0x7ff)c.timer=target;
            if(c.sweepDivider==0 || c.sweepReload){c.sweepDivider=(sweep>>4)&7;c.sweepReload=false;}else c.sweepDivider--;}
    }
}
