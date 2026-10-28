import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAssertion, describeCriteria, hashedIdentity, isTriggeredBy, meetsCriteria } from "./criteria";

const progress = (courses: string[], acts: string[]) => ({ completedCourseIds: new Set(courses), completedActivityIds: new Set(acts) });

describe("meetsCriteria", () => {
  it("never auto-awards manual badges", () => {
    expect(meetsCriteria({ type: "manual" }, progress(["c1"], ["a1"]))).toBe(false);
  });
  it("checks course completion", () => {
    expect(meetsCriteria({ type: "course_completion", courseId: "c1" }, progress(["c1"], []))).toBe(true);
    expect(meetsCriteria({ type: "course_completion", courseId: "c2" }, progress(["c1"], []))).toBe(false);
  });
  it("requires all activities", () => {
    const c = { type: "activities" as const, activityIds: ["a1", "a2"] };
    expect(meetsCriteria(c, progress([], ["a1"]))).toBe(false);
    expect(meetsCriteria(c, progress([], ["a1", "a2", "a3"]))).toBe(true);
    expect(meetsCriteria({ type: "activities", activityIds: [] }, progress([], ["a1"]))).toBe(false);
  });
});

describe("isTriggeredBy", () => {
  it("only reacts to relevant events", () => {
    expect(isTriggeredBy({ type: "course_completion", courseId: "c1" }, { courseCompleted: "c1" })).toBe(true);
    expect(isTriggeredBy({ type: "course_completion", courseId: "c1" }, { activityCompleted: "a1" })).toBe(false);
    expect(isTriggeredBy({ type: "activities", activityIds: ["a1"] }, { activityCompleted: "a1" })).toBe(true);
    expect(isTriggeredBy({ type: "manual" }, { courseCompleted: "c1" })).toBe(false);
  });
});

describe("describeCriteria", () => {
  it("is human readable", () => {
    expect(describeCriteria({ type: "course_completion", courseId: "c" }, { course: "Algebra" })).toBe('Complete the course "Algebra".');
    expect(describeCriteria({ type: "activities", activityIds: ["a"] })).toBe("Complete 1 required activity.");
  });
});

describe("Open Badges assertion", () => {
  it("hashes the recipient email with the salt", () => {
    const expected = createHash("sha256").update("ada@example.com" + "pepper").digest("hex");
    expect(hashedIdentity(" Ada@Example.com ", "pepper")).toBe(`sha256$${expected}`);
  });

  it("builds a hosted 2.0 assertion without leaking the email", () => {
    const a = buildAssertion({
      baseUrl: "https://lms.example.com/",
      uniqueHash: "hash1234567890abcdef",
      salt: "s4lt",
      recipientEmail: "ada@example.com",
      issuedOn: new Date("2026-01-02T03:04:05Z"),
      expires: null,
      badge: { id: "b1", name: "Star", description: "Shiny", criteriaNarrative: "Do things", hasImage: true },
      issuer: { name: "Acme", url: "https://lms.example.com" },
    });
    expect(a["@context"]).toBe("https://w3id.org/openbadges/v2");
    expect(a.type).toBe("Assertion");
    expect(a.id).toBe("https://lms.example.com/api/v1/badges/assertions/hash1234567890abcdef");
    expect(a.verification).toEqual({ type: "hosted" });
    expect(a.recipient.hashed).toBe(true);
    expect(JSON.stringify(a)).not.toContain("ada@example.com");
    expect(a.badge.image).toBe("https://lms.example.com/api/v1/badges/classes/b1/image");
    expect(a.issuedOn).toBe("2026-01-02T03:04:05.000Z");
    expect("expires" in a).toBe(false);
  });
});
