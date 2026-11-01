package org.jiangc.bc.input;

import java.util.EnumSet;
import org.jiangc.bc.input.InputHub.Button;

/** UI-to-engine handoff for selection and construction; edges survive short taps. */
public final class ScreenInput {
    private EnumSet<Button> held=EnumSet.noneOf(Button.class),pressed=EnumSet.noneOf(Button.class);
    public record Frame(EnumSet<Button> held,EnumSet<Button> pressed) {
        public boolean down(Button button){return held.contains(button);}
        public boolean hit(Button button){return pressed.contains(button);}
    }
    public synchronized void held(EnumSet<Button> buttons){held=buttons.clone();}
    public synchronized void update(EnumSet<Button> buttons,EnumSet<Button> edges){held=buttons.clone();pressed.addAll(edges);}
    public synchronized Frame consume(){Frame frame=new Frame(held.clone(),pressed.clone());pressed.clear();return frame;}
    public synchronized void clear(){held.clear();pressed.clear();}
}
