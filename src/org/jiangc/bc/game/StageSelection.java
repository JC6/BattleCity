package org.jiangc.bc.game;

import org.jiangc.bc.input.ScreenInput.Frame;
import static org.jiangc.bc.input.InputHub.Button.*;

/** Original selector clamps to 1..35; a held button repeats every eight ticks. */
public final class StageSelection {
    private int stage=1,direction,heldTicks;
    public int stage(){return stage;}
    public void clearInput(){direction=heldTicks=0;}
    public void step(Frame input){
        boolean a=input.down(A)||input.hit(A),b=input.down(B)||input.hit(B);
        int next=a==b?0:a?1:-1;
        if(next==0){clearInput();return;}
        if(next!=direction || input.hit(next>0?A:B)){direction=next;heldTicks=0;change(next);}
        else if(++heldTicks==8){heldTicks=0;change(next);}
    }
    private void change(int delta){stage=Math.max(1,Math.min(35,stage+delta));}
}
