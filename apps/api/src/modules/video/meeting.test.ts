import { describe, expect, it } from "vitest";
import { httpsUrl, jitsiJoinUrl, jitsiRoomName, joinWindow } from "./meeting";

describe("jitsiRoomName", () => {
  const org = "11111111-1111-1111-1111-111111111111";
  const act = "22222222-2222-2222-2222-222222222222";
  it("is stable for the same inputs and unguessable via the random suffix", () => {
    const a = jitsiRoomName(org, act, "a".repeat(32));
    expect(a).toBe(jitsiRoomName(org, act, "a".repeat(32)));
    expect(a).toMatch(/^lms-[0-9a-f]{12}-a{32}$/);
    expect(jitsiRoomName(org, act, "b".repeat(32))).not.toBe(a);
    expect(a).not.toContain(act);
  });
  it("rejects weak suffixes", () => {
    expect(() => jitsiRoomName(org, act, "short")).toThrow();
    expect(() => jitsiRoomName(org, act, "x/../".repeat(5))).toThrow();
  });
});

describe("jitsiJoinUrl", () => {
  it("puts the display name in the URL hash as JSON", () => {
    const url = jitsiJoinUrl("lms-abc-room", 'Zoë "Z" Doe', { subject: "Week 1" });
    expect(url.startsWith("https://meet.jit.si/lms-abc-room#")).toBe(true);
    const hash = new URLSearchParams(url.split("#")[1]);
    expect(JSON.parse(hash.get("userInfo.displayName")!)).toBe('Zoë "Z" Doe');
    expect(JSON.parse(hash.get("config.subject")!)).toBe("Week 1");
    expect(hash.get("config.startWithVideoMuted")).toBe("true");
  });
});

describe("joinWindow", () => {
  const start = new Date("2026-01-01T10:00:00Z");
  it("opens 15 minutes before and closes 15 minutes after the end", () => {
    expect(joinWindow(start, 60, new Date("2026-01-01T09:44:59Z")).open).toBe(false);
    expect(joinWindow(start, 60, new Date("2026-01-01T09:45:00Z")).open).toBe(true);
    expect(joinWindow(start, 60, new Date("2026-01-01T11:15:00Z")).open).toBe(true);
    expect(joinWindow(start, 60, new Date("2026-01-01T11:15:01Z")).open).toBe(false);
  });
});

describe("httpsUrl", () => {
  it("allows https only", () => {
    expect(httpsUrl("https://zoom.us/j/123?pwd=x")).toBe("https://zoom.us/j/123?pwd=x");
    expect(httpsUrl("http://zoom.us/j/123")).toBeNull();
    expect(httpsUrl("javascript:alert(1)")).toBeNull();
    expect(httpsUrl("https://u:p@zoom.us")).toBeNull();
  });
});
