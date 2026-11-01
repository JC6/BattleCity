import type { CoreContext } from './types';

export function addScore(context: CoreContext, playerIndex: number, value: number): void {
  const player = context.state.players[playerIndex];
  if (!player) return;
  player.score += value;
  if (context.state.pendingOutcome !== 'lost' && context.state.baseAlive && player.score >= player.nextExtraLife) {
    if (player.eliminated) {
      player.eliminated = false;
      player.respawnTicks = 1;
    } else player.lives++;
    // Grant a life at the first 20,000 points of a game, only once.
    player.nextExtraLife = Number.POSITIVE_INFINITY;
    context.events.push({ type: 'extra-life', playerIndex: player.index, reason: 'score' });
  }
}

/** CCD4–CEE7: only the surviving strict leader of a completed win. */
export function awardCoopBonus(context: CoreContext): void {
  if (context.state.mode !== 'coop' || context.state.phase !== 'won') return;
  const [first, second] = context.state.players;
  if (!first || !second) return;
  const a = first.kills.reduce((sum, count) => sum + count, 0);
  const b = second.kills.reduce((sum, count) => sum + count, 0);
  if (a === b) return;
  const winner = a > b ? first : second;
  if (winner.eliminated) return;
  addScore(context, winner.index, 1000);
  context.events.push({ type: 'score-bonus', playerIndex: winner.index });
}
