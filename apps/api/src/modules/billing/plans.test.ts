import { describe, expect, it } from "vitest";
import { exceedsLimit, limitsEnforced, planForSubscriptionStatus, planLimits } from "./plans";

describe("plans", () => {
  it("limits apply in SaaS mode, or when explicitly enforced", () => {
    expect(limitsEnforced({ SAAS_MODE: false, ENFORCE_PLAN_LIMITS: false })).toBe(false);
    expect(limitsEnforced({ SAAS_MODE: true, ENFORCE_PLAN_LIMITS: false })).toBe(true);
    expect(limitsEnforced({ SAAS_MODE: false, ENFORCE_PLAN_LIMITS: true })).toBe(true);
  });
  it("free plan limits 50 users / 5 courses; pro is unlimited", () => {
    expect(planLimits("free")).toEqual({ users: 50, courses: 5 });
    expect(planLimits("pro")).toEqual({ users: null, courses: null });
  });
  it("unknown plans fall back to free", () => {
    expect(planLimits("enterprise-legacy")).toEqual({ users: 50, courses: 5 });
    expect(planLimits(null)).toEqual({ users: 50, courses: 5 });
    expect(planLimits("__proto__")).toEqual({ users: 50, courses: 5 });
  });
  it("exceedsLimit", () => {
    expect(exceedsLimit(5, 4)).toBe(false);
    expect(exceedsLimit(5, 5)).toBe(true);
    expect(exceedsLimit(50, 40, 10)).toBe(false);
    expect(exceedsLimit(50, 40, 11)).toBe(true);
    expect(exceedsLimit(null, 1_000_000, 1000)).toBe(false);
  });
  it("maps subscription status to the effective plan", () => {
    expect(planForSubscriptionStatus("active")).toBe("pro");
    expect(planForSubscriptionStatus("trialing")).toBe("pro");
    expect(planForSubscriptionStatus("past_due")).toBe("pro");
    expect(planForSubscriptionStatus("canceled")).toBe("free");
    expect(planForSubscriptionStatus("unpaid")).toBe("free");
    expect(planForSubscriptionStatus("incomplete_expired")).toBe("free");
    expect(planForSubscriptionStatus(undefined)).toBe("free");
  });
});
