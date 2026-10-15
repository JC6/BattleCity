// The original keeps HISCORE in powered-on memory. Reloading is a console reset.
// Legacy battlecity.web.v1 records are deliberately neither read nor deleted.
let highScore = 20000;

export const storage = {
  getHighScore(): number { return highScore; },
  highScore(score: number): number {
    if (Number.isFinite(score) && score >= 0) highScore = Math.max(highScore, score);
    return highScore;
  },
};
