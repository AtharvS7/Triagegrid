/**
 * Jonker–Volgenant style shortest-augmenting-path min-cost bipartite
 * assignment. Rectangular-safe (transposes internally when rows > cols).
 * Exact optimum, O(n²m). Pure function — shared by the match-batch Edge
 * Function and unit tests.
 */
export const FORBIDDEN = 1e9;

export function hungarian(cost: number[][]): number[] {
  const nRows = cost.length;
  if (nRows === 0) return [];
  let n = nRows;
  let m = cost[0].length;
  let a = cost;
  let transposed = false;

  if (n > m) {
    transposed = true;
    [n, m] = [m, n];
    a = Array.from({ length: n }, (_, j) =>
      Array.from({ length: m }, (_, i) => cost[i][j]),
    );
  }

  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0); // p[j] = row matched to col j
  const way = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(m + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Number.POSITIVE_INFINITY;
      let j1 = -1;

      for (let j = 1; j <= m; j++) {
        if (!used[j]) {
          const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }

      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const rowToCol = new Array<number>(nRows).fill(-1);
  for (let j = 1; j <= m; j++) {
    if (p[j] !== 0) {
      if (!transposed) rowToCol[p[j] - 1] = j - 1;
      else rowToCol[j - 1] = p[j] - 1;
    }
  }
  return rowToCol;
}
