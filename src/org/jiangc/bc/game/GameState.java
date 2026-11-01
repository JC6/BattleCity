package org.jiangc.bc.game;

import java.util.ArrayList;
import java.util.List;

/** Mutable only on the engine thread. Coordinates and timers use native pixels/ticks. */
public final class GameState {
    public static final int INTRO = 0, PLAYING = 1, WON = 2, LOST = 3;
    public static final String[] DIRECTIONS = {"up", "right", "down", "left"};
    public static final String[] KINDS = {"basic", "fast", "power", "armor"};
    public static final String[] POWERS = {"helmet", "timer", "shovel", "star", "grenade", "tank"};
    // C1D7/CC27/CCB2/C1F3/C37A/C859: map, attributes, curtain, final setup.
    public static final int MAP_FRAMES=13, ATTRIBUTE_FRAMES=64, OPEN_FRAMES=16, SETUP_FRAMES=3;
    public int stage = 1, tick, battleTicks, phase = INTRO, pendingOutcome = -1, rng;
    public int[] tiles, brickMasks, enemyQueue;
    public Player[] players;
    public List<Tank> tanks = new ArrayList<>();
    public List<Bullet> bullets = new ArrayList<>();
    public List<Effect> effects = new ArrayList<>();
    public PowerUp powerUp;
    public int spawned, killed, spawnTimer, freezeTicks, fortifyTicks, introTicks = MAP_FRAMES+ATTRIBUTE_FRAMES+OPEN_FRAMES+SETUP_FRAMES, outroTicks, baseExplosionTicks, lossBannerTicks;
    public boolean baseAlive = true, demo;
    public int eliminationPlayer=-1, eliminationTicks,demoMode;

    public static final class Player {
        public int index, score, lives = 2, stars, nextExtraLife = 20000, respawnTicks;
        public boolean eliminated;
        public int[] kills = new int[4];

    }
    public static final class Tank {
        public int id, team, playerIndex = -1, enemySlot = -1, kind, x, y, direction, hp = 1, stars;
        public int shieldTicks, spawnTicks = 28, stunTicks, aiTicks, tread, slideTicks, deathTimer, deathPoints;
        public boolean aiTurn, aiTarget, moving, directionHeld, carryingPowerUp;
        public boolean active(){return spawnTicks==0 && deathTimer==0;}
        public int slot() { return team == 0 ? playerIndex : enemySlot + 2; }
    }
    public static final class Bullet {
        public int id, gunSlot, team, playerIndex = -1, x, y, direction, speed, impactTicks = -1;
        public boolean steelPower;
    }
    public static final class Effect {
        public int x, y, remainingTicks, value;
    }
    public record PowerUp(int kind, int x, int y) { }

}
