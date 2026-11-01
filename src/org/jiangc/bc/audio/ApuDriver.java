package org.jiangc.bc.audio;

import java.util.Arrays;

/** Original EA7E–ECAC bytecode sequencer: fixed slot priority and one-tick register latency. */
public final class ApuDriver {
    public interface Writer { void write(int channel,int register,int value); }
    private static final class Slot {
        int flag,channel,pointer,duration,remaining;
        final int[] registers=new int[4];
    }
    private final Slot[] slots=new Slot[28];
    private final int[] loops=new int[3],claimed=new int[4];
    private final Writer writer;
    public ApuDriver(Writer writer) {this.writer=writer;for(int i=0;i<28;i++)slots[i]=new Slot();}
    public void trigger(int id) {if(AudioCues.TRACKS[id]!=null)slots[id].flag=1;}
    public void stop(int id) {slots[id].flag=0;slots[id].channel=0;}
    public boolean active(int id) {return slots[id].flag!=0;}
    public boolean hasActivity(){for(Slot s:slots)if(s.flag!=0)return true;for(int c:claimed)if(c!=0)return true;return false;}
    public void reset() {
        for(Slot s:slots){s.flag=s.channel=s.pointer=s.duration=s.remaining=0;Arrays.fill(s.registers,0);}
        Arrays.fill(loops,0);Arrays.fill(claimed,0);
        for(int c=0;c<4;c++)writer.write(c,0,c==2?0:0x10);
    }
    public void tick() {tick(false);}
    public void tick(boolean pauseOnly) {
        int limit=pauseOnly?1:28;Arrays.fill(claimed,0);
        for(int id=0;id<limit;id++) {
            Slot s=slots[id];if(s.flag==0 || s.channel==0)continue;int c=(s.channel-1)%4;
            if(claimed[c]!=0)continue;claimed[c]=1;if(s.channel>=5)continue;s.channel+=4;
            for(int r=0;r<4;r++)writer.write(c,r,s.registers[r]);
        }
        for(int c=0;c<4;c++)if(claimed[c]==0)writer.write(c,0,c==2?0:0x10);
        for(int id=0;id<limit;id++) {
            Slot s=slots[id];int[] data=AudioCues.TRACKS[id];if(s.flag==0 || data==null)continue;
            if(s.flag==1) {
                s.flag=2;s.channel=data[0];s.registers[0]=data[1];s.registers[1]=data[2];s.registers[2]=0;s.registers[3]=data[3];s.pointer=4;s.duration=0;
                if(s.channel==4)s.registers[2]=data[s.pointer++];
            } else if(--s.remaining!=0)continue;
            decode(id,s,data);
        }
    }
    private void decode(int id,Slot s,int[] data) {
        for(int op=0;op<128 && s.pointer<data.length;op++) {
            int v=data[s.pointer++];
            if(v<0x60) {
                int timer=AudioCues.NOTES[v>>3]>>(v&7);s.registers[2]=timer&255;s.registers[3]=(s.registers[3]&0xf8)|(timer>>8);
                if(s.channel>=5)s.channel-=4;s.remaining=s.duration==0?256:s.duration;return;
            }
            if(v==0x60){s.remaining=s.duration==0?256:s.duration;return;}
            if(v<0xe8){s.duration=v-0x60;continue;}
            if(v==0xe8){stop(id);return;}
            if(v==0xef){Arrays.fill(loops,0);continue;}
            if(v>=0xf0 && v<=0xf2 && s.pointer+1<data.length) {
                int counter=v-0xf0,repeat=data[s.pointer++],target=data[s.pointer++];loops[counter]=(loops[counter]+1)&255;
                if(loops[counter]==repeat)loops[counter]=0;else s.pointer=target;continue;
            }
            if(v==0xf9 && s.pointer<data.length){s.pointer=data[s.pointer];continue;}
            if(v>=0xf3 && v<=0xf8){s.pointer++;continue;}
            if(s.pointer>=data.length)break;int value=data[s.pointer++];
            switch(v) {
                case 0xe9:s.registers[0]=(s.registers[0]&0x3f)|value;break;
                case 0xea:s.registers[0]=(s.registers[0]&0xc0)|value;break;
                case 0xeb:s.registers[0]=(s.registers[0]&0xf0)|value;break;
                case 0xec:s.registers[1]=value;break;
                case 0xed:s.registers[3]=value;break;
                case 0xee:s.registers[0]=value;break;
                default:stop(id);return;
            }
        }
        stop(id);
    }
}
