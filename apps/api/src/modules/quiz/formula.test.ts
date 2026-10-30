import { describe, expect, it } from "vitest";
import { checkFormula, evaluate, FormulaError, roundTo, variablesIn } from "./formula";

describe("calculated question formulas", () => {
  it("follows operator precedence and associativity", () => {
    expect(evaluate("1 + 2 * 3", {})).toBe(7);
    expect(evaluate("(1 + 2) * 3", {})).toBe(9);
    expect(evaluate("2 ^ 3 ^ 2", {})).toBe(512);
    expect(evaluate("2 ** 10", {})).toBe(1024);
    expect(evaluate("-2 ^ 2", {})).toBe(-4);
    expect(evaluate("10 - 4 - 3", {})).toBe(3);
    expect(evaluate("7 % 4 + 8 / 4", {})).toBe(5);
    expect(evaluate("1.5e2 + .5", {})).toBe(150.5);
  });

  it("substitutes variables and calls functions", () => {
    expect(evaluate("{a} * {b} + sqrt({c})", { a: 2, b: 3, c: 16 })).toBe(10);
    expect(evaluate("round(pi(), 2)", {})).toBe(3.14);
    expect(evaluate("max({x}, 3, min(1, 2))", { x: 5 })).toBe(5);
    expect(evaluate("log(8, 2)", {})).toBeCloseTo(3);
    expect(evaluate("deg2rad(180)", {})).toBeCloseTo(Math.PI);
    expect(evaluate("atan2(1, 1)", {})).toBeCloseTo(Math.PI / 4);
  });

  it("rejects anything that isn't arithmetic", () => {
    expect(() => evaluate("{x} + 1", {})).toThrow(FormulaError);
    expect(() => evaluate("alert(1)", {})).toThrow(/Unknown function/);
    expect(() => evaluate("constructor", {})).toThrow(FormulaError);
    expect(() => evaluate("1 +", {})).toThrow(FormulaError);
    expect(() => evaluate("(1", {})).toThrow(FormulaError);
    expect(() => evaluate("1; 2", {})).toThrow(FormulaError);
    expect(() => evaluate("sqrt(1, 2)", {})).toThrow(/arguments/);
    expect(() => evaluate("(".repeat(100) + "1" + ")".repeat(100), {})).toThrow(/nested/);
    expect(() => evaluate("1+".repeat(600) + "1", {})).toThrow(/too long/);
  });

  it("lists variables and checks formulas", () => {
    expect(variablesIn("Area of {w} by {h}, {w} again")).toEqual(["w", "h"]);
    expect(checkFormula("{w}*{h}", ["w", "h"])).toBeNull();
    expect(checkFormula("{w}*{z}", ["w", "h"])).toBe("Unknown variable {z}");
  });

  it("rounds half away from zero", () => {
    expect(roundTo(2.5, 0)).toBe(3);
    expect(roundTo(-2.5, 0)).toBe(-3);
    expect(roundTo(1.005, 2)).toBe(1.01);
  });
});
