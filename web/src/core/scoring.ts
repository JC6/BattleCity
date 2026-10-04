import type { CoreContext } from './context';

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
    context.events.push({ type: 'extra-life' });
  }
}

export function awardCoopBonus(context: CoreContext): void {
  if (context.state.mode !== 'coop') return;
  const [first, second] = context.state.players;
  if (!first || !second) return;
  const firstKills = first.kills.reduce((sum, count) => sum + count, 0);
  const secondKills = second.kills.reduce((sum, count) => sum + count, 0);
  if (firstKills !== secondKills) addScore(context, firstKills > secondKills ? 0 : 1, 1000);
}
