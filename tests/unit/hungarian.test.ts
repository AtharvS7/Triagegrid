import { describe, it, expect } from "vitest";
import { hungarian, FORBIDDEN } from "../../supabase/functions/_shared/hungarian";

describe("hungarian assignment", () => {
  it("solves a trivial 1x1", () => {
    expect(hungarian([[5]])).toEqual([0]);
  });

  it("picks the global optimum over per-row greedy", () => {
    // Greedy row 0 would take col 0 (cost 1), forcing row 1 to cost 100.
    // Optimal: row0->col1 (2), row1->col0 (2) = 4 < 101.
    const cost = [
      [1, 2],
      [2, 100],
    ];
    const assign = hungarian(cost);
    const total = assign.reduce((s, c, r) => s + cost[r][c], 0);
    expect(total).toBe(4);
    expect(assign).toEqual([1, 0]);
  });

  it("handles rectangular rows<cols with unassigned = -1", () => {
    const cost = [
      [1, 5, 9],
      [5, 1, 9],
    ];
    const assign = hungarian(cost);
    expect(assign[0]).toBe(0);
    expect(assign[1]).toBe(1);
  });

  it("handles cols<rows via internal transpose", () => {
    const cost = [
      [10, 20],
      [20, 10],
      [30, 30],
    ];
    const assign = hungarian(cost); // 3 rows, 2 cols -> one row unassigned
    const assigned = assign.filter((c) => c >= 0);
    expect(assigned.length).toBe(2);
    const total = assign.reduce(
      (s, c, r) => (c >= 0 ? s + cost[r][c] : s),
      0,
    );
    expect(total).toBe(20); // best two rows take the two columns
  });

  it("avoids forbidden pairs when alternatives exist", () => {
    const F = FORBIDDEN;
    const cost = [
      [F, 3],
      [4, F],
    ];
    const assign = hungarian(cost);
    expect(assign[0]).toBe(1);
    expect(assign[1]).toBe(0);
  });
});
