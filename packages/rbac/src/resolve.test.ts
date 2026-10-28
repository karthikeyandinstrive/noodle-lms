import { describe, expect, it } from "vitest";
import { resolveCapability, type PermissionEntry, type RoleGrant } from "./resolve";

const student: RoleGrant = { roleId: "student", archetype: "student", assignedDepth: 2 };
const teacher: RoleGrant = { roleId: "teacher", archetype: "editing_teacher", assignedDepth: 2 };

const defaults: PermissionEntry[] = [
  { roleId: "student", capability: "quiz:attempt", permission: "allow", depth: -1 },
  { roleId: "teacher", capability: "quiz:grade", permission: "allow", depth: -1 },
];

describe("resolveCapability", () => {
  it("allows a capability granted by role defaults", () => {
    expect(resolveCapability("quiz:attempt", [student], defaults)).toBe(true);
  });

  it("denies when the user holds no role granting it", () => {
    expect(resolveCapability("quiz:grade", [student], defaults)).toBe(false);
  });

  it("lets a deeper override beat the default", () => {
    const entries = [...defaults, { roleId: "student", capability: "quiz:attempt", permission: "prevent", depth: 3 } as const];
    expect(resolveCapability("quiz:attempt", [student], entries)).toBe(false);
  });

  it("allows when another held role still allows (prevent is not absolute)", () => {
    const entries: PermissionEntry[] = [
      ...defaults,
      { roleId: "teacher", capability: "quiz:attempt", permission: "allow", depth: -1 },
      { roleId: "student", capability: "quiz:attempt", permission: "prevent", depth: 3 },
    ];
    expect(resolveCapability("quiz:attempt", [student, teacher], entries)).toBe(true);
  });

  it("prohibit anywhere wins over every allow", () => {
    const entries: PermissionEntry[] = [
      ...defaults,
      { roleId: "teacher", capability: "quiz:attempt", permission: "allow", depth: 3 },
      { roleId: "student", capability: "quiz:attempt", permission: "prohibit", depth: 1 },
    ];
    expect(resolveCapability("quiz:attempt", [student, teacher], entries)).toBe(false);
  });

  it("super_admin bypasses everything", () => {
    expect(resolveCapability("site:config", [{ roleId: "sa", archetype: "super_admin", assignedDepth: 0 }], [])).toBe(true);
  });
});
