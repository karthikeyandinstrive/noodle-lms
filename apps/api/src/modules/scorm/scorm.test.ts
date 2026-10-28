import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32 } from "../interactive/zip";
import {
  aggregateGrade,
  computeScore,
  computeStatus,
  formatDuration2004,
  formatTimespan12,
  mergeCmi,
  parseDuration2004,
  parseTimespan12,
  validateCmi,
} from "./cmi";
import { ManifestError, parseManifest, parseXml, splitHref } from "./manifest";
import { entryFor, foldSessionTime, initialCmi } from "./runtime";
import { contentPath, scormMime } from "./routes";
import { aggregateScos, contentToken, inspectScorm, verifyContentToken } from "./service";

const MANIFEST_12 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE manifest [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<manifest identifier="com.example.golf" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="golf_org">
    <organization identifier="golf_org">
      <title>Golf Explained &amp; More</title>
      <item identifier="item_1" identifierref="res_1" parameters="?lang=en">
        <title>Playing</title>
        <adlcp:masteryscore>80</adlcp:masteryscore>
        <adlcp:datafromlms><![CDATA[mode=<fast>]]></adlcp:datafromlms>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res_1" type="webcontent" adlcp:scormtype="sco" href="shared/launch page.html">
      <file href="shared/launch page.html"/>
    </resource>
    <resource identifier="res_css" type="webcontent" adlcp:scormtype="asset" href="shared/style.css"/>
  </resources>
</manifest>`;

const MANIFEST_2004 = `<?xml version="1.0" standalone="no" ?>
<manifest identifier="com.example.multi" version="1"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"
  xmlns:imsss="http://www.imsglobal.org/xsd/imsss">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>2004 4th Edition</schemaversion>
  </metadata>
  <organizations default="ORG">
    <organization identifier="OTHER"><title>Not default</title>
      <item identifier="x" identifierref="R2"><title>X</title></item>
    </organization>
    <organization identifier="ORG">
      <title>Multi SCO course</title>
      <item identifier="module">
        <title>Module 1</title>
        <item identifier="i1" identifierref="R1">
          <title>Lesson 1</title>
          <adlcp:completionThreshold completedByMeasure="true" minProgressMeasure="0.8" />
          <imsss:sequencing>
            <imsss:objectives>
              <imsss:primaryObjective objectiveID="PRIMARY" satisfiedByMeasure="true">
                <imsss:minNormalizedMeasure>0.7</imsss:minNormalizedMeasure>
              </imsss:primaryObjective>
            </imsss:objectives>
          </imsss:sequencing>
        </item>
        <item identifier="i2" identifierref="R2"><title>Lesson 2</title></item>
      </item>
    </organization>
  </organizations>
  <resources xml:base="content/">
    <resource identifier="R1" type="webcontent" adlcp:scormType="sco" xml:base="l1/" href="index.html"/>
    <resource identifier="R2" type="webcontent" adlcp:scormType="sco" href="l2/index.html"/>
  </resources>
</manifest>`;

/** Minimal ZIP writer for fixtures (stored + deflate). */
function makeZip(entries: { name: string; data: string; deflate?: boolean }[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data);
    const comp = e.deflate ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("XML parser", () => {
  it("parses elements, attributes, entities and CDATA", () => {
    const doc = parseXml(`<a x="1 &amp; 2"><b>t&#x41;&lt;</b><c/><![CDATA[<raw>]]></a>`);
    expect(doc.name).toBe("a");
    expect(doc.attrs.x).toBe("1 & 2");
    expect(doc.children.map((c) => c.name)).toEqual(["b", "c"]);
    expect(doc.children[0]!.text).toBe("tA<");
    expect(doc.text).toBe("<raw>");
  });

  it("never expands DOCTYPE entities and rejects malformed XML", () => {
    expect(parseXml(`<!DOCTYPE a [<!ENTITY e "boom">]><a>&e;</a>`).text).toBe("&e;");
    expect(() => parseXml("<a><b></a>")).toThrow(ManifestError);
    expect(() => parseXml("<a>")).toThrow(ManifestError);
    expect(() => parseXml("<a x=1></a>")).toThrow(ManifestError);
    expect(() => parseXml("<a/><b/>")).toThrow(ManifestError);
  });

  it("bounds nesting depth", () => {
    expect(() => parseXml("<a>".repeat(100) + "</a>".repeat(100))).toThrow(/too deep/);
  });
});

describe("manifest parsing", () => {
  it("reads a SCORM 1.2 manifest", () => {
    const m = parseManifest(MANIFEST_12);
    expect(m.version).toBe("1.2");
    expect(m.schemaVersion).toBe("1.2");
    expect(m.title).toBe("Golf Explained & More");
    expect(m.entryHref).toBe("shared/launch page.html?lang=en");
    expect(m.scoCount).toBe(1);
    expect(m.multiSco).toBe(false);
    expect(m.masteryScore).toBe(80);
    expect(m.launchData).toBe("mode=<fast>");
  });

  it("reads a SCORM 2004 manifest: default organization, xml:base, first SCO, sequencing rules", () => {
    const m = parseManifest(MANIFEST_2004);
    expect(m.version).toBe("2004");
    expect(m.title).toBe("Multi SCO course");
    expect(m.entryHref).toBe("content/l1/index.html");
    expect(m.scoIdentifier).toBe("i1");
    expect(m.scoCount).toBe(2);
    expect(m.multiSco).toBe(true);
    expect(m.scaledPassingScore).toBe(0.7);
    expect(m.completionThreshold).toBe(0.8);
    expect(m.items.map((i) => i.identifier)).toEqual(["module", "i1", "i2"]);
  });

  it("detects the version from namespaces when schemaversion is missing", () => {
    const xml = MANIFEST_2004.replace(/<schemaversion>.*<\/schemaversion>/, "");
    expect(parseManifest(xml).version).toBe("2004");
    expect(parseManifest(MANIFEST_12.replace(/<schemaversion>.*<\/schemaversion>/, "")).version).toBe("1.2");
  });

  it("rejects manifests without a launchable resource", () => {
    expect(() => parseManifest(`<manifest><organizations/><resources/></manifest>`)).toThrow(/launchable/);
    expect(() => parseManifest(`<foo/>`)).toThrow(/manifest/);
  });

  it("splits hrefs into a decoded path and a suffix", () => {
    expect(splitHref("a/b%20c.html?x=1#y")).toEqual({ path: "a/b c.html", suffix: "?x=1#y" });
  });
});

describe("package inspection", () => {
  it("accepts a valid zip and finds the launch file", () => {
    const zip = makeZip([
      { name: "imsmanifest.xml", data: MANIFEST_12, deflate: true },
      { name: "shared/launch page.html", data: "<html></html>" },
      { name: "__MACOSX/._x", data: "junk" },
    ]);
    const out = inspectScorm(zip);
    expect(out.manifest.version).toBe("1.2");
    expect(out.files.map((f) => f.path)).toEqual(["imsmanifest.xml", "shared/launch page.html"]);
  });

  it("rejects zip slip, missing manifests and missing launch files", () => {
    expect(() => inspectScorm(makeZip([{ name: "../evil.html", data: "x" }]))).toThrow(/Unsafe path/);
    expect(() => inspectScorm(makeZip([{ name: "index.html", data: "x" }]))).toThrow(/imsmanifest/);
    expect(() => inspectScorm(makeZip([{ name: "imsmanifest.xml", data: MANIFEST_12 }]))).toThrow(/not in the package/);
    expect(() => inspectScorm(Buffer.from("not a zip at all, definitely not"))).toThrow();
  });
});

describe("content serving helpers", () => {
  it("normalizes request paths and blocks traversal", () => {
    expect(contentPath("shared/launch%20page.html")).toBe("shared/launch page.html");
    expect(contentPath("../../etc/passwd")).toBeNull();
    expect(contentPath("a/%2e%2e/%2e%2e/x")).toBeNull();
    expect(contentPath(".env")).toBeNull();
    expect(contentPath("%E0%A4%A")).toBeNull();
  });

  it("maps content types", () => {
    expect(scormMime("a/index.HTML")).toBe("text/html");
    expect(scormMime("x.js")).toBe("text/javascript");
    expect(scormMime("x.unknown")).toBe("application/octet-stream");
  });

  it("issues tokens bound to user, activity and package", () => {
    const t = contentToken("u1", "a1", "org/scorm/p/f");
    expect(verifyContentToken(t, "a1", "org/scorm/p/f")).toEqual({ userId: "u1" });
    expect(verifyContentToken(t, "a2", "org/scorm/p/f")).toBeNull();
    expect(verifyContentToken(t, "a1", "org/scorm/p/other")).toBeNull();
    expect(verifyContentToken(t.replace(/^u1/, "u2"), "a1", "org/scorm/p/f")).toBeNull();
    expect(verifyContentToken(t, "a1", "org/scorm/p/f", Date.now() + 7 * 3600_000)).toBeNull();
  });
});

describe("CMI whitelist and validation", () => {
  it("accepts valid SCORM 1.2 writes", () => {
    expect(
      validateCmi("1.2", {
        "cmi.core.lesson_status": "completed",
        "cmi.core.lesson_location": "page-3",
        "cmi.core.score.raw": "85.5",
        "cmi.core.score.max": "100",
        "cmi.core.session_time": "0001:02:03.45",
        "cmi.core.exit": "suspend",
        "cmi.suspend_data": "x".repeat(4096),
        "cmi.interactions.0.id": "q1",
        "cmi.interactions.0.type": "choice",
        "cmi.interactions.0.result": "wrong",
        "cmi.objectives.3.status": "passed",
      }),
    ).toEqual([]);
  });

  it("rejects unknown, read-only, invalid and out-of-range elements", () => {
    const problems = validateCmi("1.2", {
      "cmi.core.student_id": "hacker",
      "cmi.core.lesson_status": "done",
      "cmi.core.score.raw": "abc",
      "cmi.core.session_time": "1:2:3",
      "cmi.suspend_data": "x".repeat(4097),
      "cmi.foo": "1",
      "cmi.interactions.999.id": "q",
      "cmi.completion_status": "completed",
    });
    expect(Object.fromEntries(problems.map((p) => [p.key, p.reason]))).toEqual({
      "cmi.core.student_id": "read-only",
      "cmi.core.lesson_status": "invalid",
      "cmi.core.score.raw": "invalid",
      "cmi.core.session_time": "invalid",
      "cmi.suspend_data": "invalid",
      "cmi.foo": "unknown",
      "cmi.interactions.999.id": "index",
      "cmi.completion_status": "unknown",
    });
  });

  it("validates SCORM 2004 elements", () => {
    expect(
      validateCmi("2004", {
        "cmi.completion_status": "completed",
        "cmi.success_status": "passed",
        "cmi.score.scaled": "-0.5",
        "cmi.progress_measure": "1",
        "cmi.session_time": "PT1H30M5.25S",
        "cmi.location": "slide-9",
        "cmi.suspend_data": "x".repeat(64_000),
        "cmi.interactions.0.timestamp": "2024-01-02T03:04:05.1Z",
        "adl.nav.request": "continue",
      }),
    ).toEqual([]);
    const bad = validateCmi("2004", {
      "cmi.score.scaled": "1.5",
      "cmi.success_status": "completed",
      "cmi.session_time": "1:00:00",
      "cmi.learner_id": "x",
      "cmi.suspend_data": "x".repeat(64_001),
      "cmi.core.lesson_status": "passed",
    });
    expect(bad.map((p) => p.key).sort()).toEqual(
      ["cmi.core.lesson_status", "cmi.learner_id", "cmi.score.scaled", "cmi.session_time", "cmi.success_status", "cmi.suspend_data"].sort(),
    );
  });

  it("appends 1.2 comments and overwrites other elements", () => {
    const merged = mergeCmi("1.2", { "cmi.comments": "a", "cmi.core.lesson_location": "1" }, { "cmi.comments": "b", "cmi.core.lesson_location": "2" });
    expect(merged).toEqual({ "cmi.comments": "ab", "cmi.core.lesson_location": "2" });
  });
});

describe("time parsing and summing", () => {
  it("parses and formats SCORM 1.2 timespans", () => {
    expect(parseTimespan12("0000:00:01.5")).toBe(1.5);
    expect(parseTimespan12("12:30:00")).toBe(45_000);
    expect(parseTimespan12("1:00:00")).toBeNull();
    expect(parseTimespan12("00:61:00")).toBeNull();
    expect(formatTimespan12(3723.456)).toBe("0001:02:03.46");
    expect(formatTimespan12(0)).toBe("0000:00:00.00");
  });

  it("parses and formats SCORM 2004 durations", () => {
    expect(parseDuration2004("PT1H2M3.5S")).toBe(3723.5);
    expect(parseDuration2004("P1DT1S")).toBe(86_401);
    expect(parseDuration2004("PT0S")).toBe(0);
    expect(parseDuration2004("P")).toBeNull();
    expect(parseDuration2004("PT")).toBeNull();
    expect(parseDuration2004("1H")).toBeNull();
    expect(formatDuration2004(3723.5)).toBe("PT1H2M3.5S");
    expect(formatDuration2004(0)).toBe("PT0S");
    expect(formatDuration2004(7200)).toBe("PT2H");
  });

  it("folds a pending session time into the total once", () => {
    const first = foldSessionTime("1.2", { "cmi.core.session_time": "0000:10:00", "cmi.core.lesson_location": "x" }, 60);
    expect(first).toEqual({ cmi: { "cmi.core.lesson_location": "x" }, totalSeconds: 660 });
    expect(foldSessionTime("1.2", first.cmi, first.totalSeconds).totalSeconds).toBe(660);
    expect(foldSessionTime("2004", { "cmi.session_time": "PT30S" }, 0).totalSeconds).toBe(30);
  });
});

describe("status and score normalization", () => {
  const none = { masteryScore: null, scaledPassingScore: null, completionThreshold: null };

  it("uses lesson_status in 1.2 and applies the mastery score", () => {
    expect(computeStatus("1.2", {}, none)).toBe("not attempted");
    expect(computeStatus("1.2", { "cmi.core.lesson_status": "incomplete" }, none)).toBe("incomplete");
    const mastery = { ...none, masteryScore: 80 };
    expect(computeStatus("1.2", { "cmi.core.lesson_status": "completed", "cmi.core.score.raw": "85" }, mastery)).toBe("passed");
    expect(computeStatus("1.2", { "cmi.core.lesson_status": "completed", "cmi.core.score.raw": "50" }, mastery)).toBe("failed");
    expect(computeStatus("1.2", { "cmi.core.lesson_status": "browsed", "cmi.core.score.raw": "50" }, mastery)).toBe("browsed");
  });

  it("combines completion and success in 2004 with LMS overrides", () => {
    expect(computeStatus("2004", { "cmi.completion_status": "completed", "cmi.success_status": "unknown" }, none)).toBe("completed");
    expect(computeStatus("2004", { "cmi.completion_status": "incomplete", "cmi.success_status": "passed" }, none)).toBe("passed");
    expect(computeStatus("2004", { "cmi.completion_status": "unknown" }, none)).toBe("not attempted");
    expect(computeStatus("2004", { "cmi.success_status": "passed", "cmi.score.scaled": "0.5" }, { ...none, scaledPassingScore: 0.7 })).toBe("failed");
    expect(computeStatus("2004", { "cmi.completion_status": "completed", "cmi.progress_measure": "0.5" }, { ...none, completionThreshold: 0.8 })).toBe("incomplete");
  });

  it("normalizes scores", () => {
    expect(computeScore("1.2", {})).toBeNull();
    expect(computeScore("1.2", { "cmi.core.score.raw": "40", "cmi.core.score.max": "50" })).toEqual({ raw: 40, max: 50 });
    expect(computeScore("1.2", { "cmi.core.score.raw": "75", "cmi.core.score.max": "" })).toEqual({ raw: 75, max: 100 });
    expect(computeScore("2004", { "cmi.score.scaled": "0.9", "cmi.score.raw": "3", "cmi.score.max": "10" })).toEqual({ raw: 90, max: 100 });
    expect(computeScore("2004", { "cmi.score.scaled": "-0.5" })).toEqual({ raw: 0, max: 100 });
    expect(computeScore("2004", { "cmi.score.raw": "15", "cmi.score.min": "10", "cmi.score.max": "20" })).toEqual({ raw: 5, max: 10 });
  });
});

describe("grade aggregation", () => {
  const r = [0.5, null, 0.9, 0.7];
  it("supports highest, average, first and last", () => {
    expect(aggregateGrade("highest", r)).toBe(0.9);
    expect(aggregateGrade("average", r)).toBeCloseTo(0.7);
    expect(aggregateGrade("first", r)).toBe(0.5);
    expect(aggregateGrade("first", [null, 1])).toBeNull();
    expect(aggregateGrade("last", r)).toBe(0.7);
    expect(aggregateGrade("last", [0.4, null])).toBe(0.4);
    expect(aggregateGrade("highest", [])).toBeNull();
    expect(aggregateGrade("average", [null])).toBeNull();
  });
});

describe("runtime initial data", () => {
  it("computes cmi.entry", () => {
    expect(entryFor("1.2", {}, true)).toBe("ab-initio");
    expect(entryFor("1.2", { "cmi.core.exit": "suspend" }, false)).toBe("resume");
    expect(entryFor("2004", { "cmi.exit": "normal" }, false)).toBe("");
  });

  it("builds the 1.2 model without write-only values", () => {
    const cmi = initialCmi({
      version: "1.2",
      stored: { "cmi.core.lesson_location": "p2", "cmi.core.session_time": "0000:01:00", "cmi.suspend_data": "abc" },
      totalSeconds: 90,
      entry: "resume",
      mode: "normal",
      user: { id: "u1", firstName: "Ada", lastName: "Lovelace" },
      manifest: { masteryScore: 80, launchData: "x=1" },
    });
    expect(cmi["cmi.core.student_name"]).toBe("Lovelace, Ada");
    expect(cmi["cmi.core.lesson_location"]).toBe("p2");
    expect(cmi["cmi.suspend_data"]).toBe("abc");
    expect(cmi["cmi.core.entry"]).toBe("resume");
    expect(cmi["cmi.core.total_time"]).toBe("0000:01:30.00");
    expect(cmi["cmi.core.credit"]).toBe("credit");
    expect(cmi["cmi.student_data.mastery_score"]).toBe("80");
    expect(cmi["cmi.core.session_time"]).toBeUndefined();
  });

  it("builds the 2004 model", () => {
    const cmi = initialCmi({
      version: "2004",
      stored: {},
      totalSeconds: 0,
      entry: "ab-initio",
      mode: "browse",
      user: { id: "u1", firstName: "Ada", lastName: "Lovelace" },
      manifest: { scaledPassingScore: 0.7 },
    });
    expect(cmi["cmi.learner_id"]).toBe("u1");
    expect(cmi["cmi.mode"]).toBe("browse");
    expect(cmi["cmi.credit"]).toBe("no-credit");
    expect(cmi["cmi.completion_status"]).toBe("unknown");
    expect(cmi["cmi.scaled_passing_score"]).toBe("0.7");
    expect(cmi["cmi.total_time"]).toBe("PT0S");
  });
});

describe("multi-SCO aggregation", () => {
  const t = (status: string, scoreRaw: number | null = null, scoreMax: number | null = null, totalTimeSeconds = 10) => ({ status, scoreRaw, scoreMax, totalTimeSeconds });

  it("is incomplete until every SCO is finished", () => {
    expect(aggregateScos(3, []).status).toBe("not attempted");
    expect(aggregateScos(3, [t("not attempted")]).status).toBe("not attempted");
    expect(aggregateScos(3, [t("passed"), t("completed")]).status).toBe("incomplete");
    expect(aggregateScos(2, [t("passed"), t("incomplete")]).status).toBe("incomplete");
  });

  it("fails if any SCO failed, passes only if all passed", () => {
    expect(aggregateScos(2, [t("passed"), t("failed")]).status).toBe("failed");
    expect(aggregateScos(2, [t("passed"), t("passed")]).status).toBe("passed");
    expect(aggregateScos(2, [t("passed"), t("completed")]).status).toBe("completed");
  });

  it("sums scores of scored SCOs and all time", () => {
    expect(aggregateScos(3, [t("passed", 8, 10), t("completed"), t("failed", 3, 20)])).toMatchObject({ scoreRaw: 11, scoreMax: 30, totalTimeSeconds: 30 });
    expect(aggregateScos(1, [t("completed")])).toMatchObject({ scoreRaw: null, scoreMax: null });
  });
});
