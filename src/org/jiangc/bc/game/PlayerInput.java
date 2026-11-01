package org.jiangc.bc.game;

/** A tick's immutable input. Fire is an edge, directions are held states. */
public record PlayerInput(boolean up, boolean right, boolean down, boolean left, boolean firePressed) {
    public static final PlayerInput NONE = new PlayerInput(false, false, false, false, false);
}
