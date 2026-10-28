import type { ArchiveFiles } from "./archive";
import { moodleQuizSlots, parseMoodleQuestions } from "./mbz-questions";
import { zBackupCourse, type ParsedBackupCourse, type RestoreReport } from "./format";
import { child, children, numberOf, parseXml, path, textOf, type XmlNode } from "./xml";

/**
 * Best-effort import of Moodle course backups (.mbz) into our backup structure,
 * so the regular restore engine creates the course.
 *
 * Supported: course settings, sections, page, url, label (as page), assign,
 * forum, quiz (settings and question slots) and the question bank (see mbz-questions.ts).
 * Everything else is reported as unsupported.
 */

/** Moodle module types we read, and the XML file that holds their settings. */
const SUPPORTED = new Set(["page", "url", "label", "assign", "forum", "quiz"]);

export function isMoodleBackup(files: ArchiveFiles) {
  return files.has("moodle_backup.xml");
}

/** Only the XML files the importer reads (keeps memory bounded for big .mbz files). */
export function mbzFilter(name: string) {
  return (
    name === "moodle_backup.xml" ||
    name === "course/course.xml" ||
    name === "questions.xml" ||
    /^sections\/[^/]+\/section\.xml$/.test(name) ||
    /^activities\/[^/]+\/(module|page|url|label|assign|forum|quiz)\.xml$/.test(name)
  );
}

function xmlFile(files: ArchiveFiles, name: string): XmlNode | null {
  const buf = files.get(name);
  return buf ? parseXml(buf.toString("utf8")) : null;
}

const unix = (n: number | null) => (n && n > 0 ? new Date(n * 1000).toISOString() : null);
const bool = (n: number | null, fallback = true) => (n === null ? fallback : n !== 0);

function moodleHtml(html: string | null, report: RestoreReport, where: string) {
  if (!html) return null;
  if (html.includes("@@PLUGINFILE@@")) {
    report.warnings.push(`${where}: embedded Moodle files (images, attachments) were not imported`);
  }
  return html;
}

function completionRule(module: XmlNode | null) {
  const completion = numberOf(module, "completion") ?? 0;
  if (completion === 1) return "manual";
  if (completion === 2) {
    if ((numberOf(module, "completionview") ?? 0) > 0) return "view";
    return "submit";
  }
  return "none";
}

function assignPluginConfig(assign: XmlNode | null, plugin: string, name: string) {
  for (const cfg of children(child(assign, "plugin_configs"), "plugin_config")) {
    if (textOf(cfg, "plugin") === plugin && textOf(cfg, "subtype") === "assignsubmission" && textOf(cfg, "name") === name) return textOf(cfg, "value");
  }
  return null;
}

export function parseMoodleBackup(files: ArchiveFiles, report: RestoreReport): ParsedBackupCourse {
  const doc = xmlFile(files, "moodle_backup.xml");
  const info = path(doc, "moodle_backup", "information");
  if (!info) throw new Error("moodle_backup.xml is missing or invalid");
  const release = textOf(info, "backup_release") ?? textOf(info, "moodle_release");
  report.source = { format: "moodle", organization: textOf(info, "original_wwwroot") ?? undefined, course: textOf(info, "original_course_fullname") ?? undefined };
  if (release) report.warnings.push(`Imported from a Moodle ${release.trim()} backup (best effort)`);

  const courseXml = path(xmlFile(files, "course/course.xml"), "course");
  const fullname = textOf(courseXml, "fullname") ?? textOf(info, "original_course_fullname") ?? "Imported course";
  const shortname = textOf(courseXml, "shortname") ?? textOf(info, "original_course_shortname") ?? "imported";
  const format = textOf(courseXml, "format");

  const bank = parseMoodleQuestions(xmlFile(files, "questions.xml"), report);
  const contents = child(info, "contents");
  const sectionEntries = children(child(contents, "sections"), "section");
  const activityEntries = children(child(contents, "activities"), "activity");

  const sections: Record<string, unknown>[] = [];
  const sequenceOf = new Map<string, string[]>();
  for (const [i, s] of sectionEntries.entries()) {
    const sectionId = textOf(s, "sectionid") ?? String(i);
    const dir = textOf(s, "directory") ?? `sections/section_${sectionId}`;
    const xml = path(xmlFile(files, `${dir}/section.xml`), "section");
    const number = numberOf(xml, "number") ?? i;
    // moodle_backup.xml's section <title> is just the section number: only <name> is meaningful.
    const name = textOf(xml, "name");
    sections.push({
      id: sectionId,
      title: (name && name.trim()) || (number === 0 ? "General" : `Topic ${number}`),
      summary: moodleHtml(textOf(xml, "summary"), report, `Section "${name ?? number}"`),
      position: number,
      visible: bool(numberOf(xml, "visible")),
    });
    sequenceOf.set(sectionId, (textOf(xml, "sequence") ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  }

  const acts: Record<string, unknown>[] = [];
  const unsupportedCounts = new Map<string, number>();
  for (const [i, a] of activityEntries.entries()) {
    const modName = (textOf(a, "modulename") ?? "").trim();
    const moduleId = textOf(a, "moduleid") ?? String(i);
    const sectionId = textOf(a, "sectionid") ?? "";
    const title = textOf(a, "title") ?? modName;
    if (!SUPPORTED.has(modName)) {
      unsupportedCounts.set(modName || "unknown", (unsupportedCounts.get(modName || "unknown") ?? 0) + 1);
      continue;
    }
    const dir = textOf(a, "directory") ?? `activities/${modName}_${moduleId}`;
    const module = path(xmlFile(files, `${dir}/module.xml`), "module");
    const mod = path(xmlFile(files, `${dir}/${modName}.xml`), "activity", modName);
    if (!mod) {
      report.warnings.push(`Activity "${title}" (${modName}) has no settings file and was skipped`);
      continue;
    }
    const name = (textOf(mod, "name") ?? title ?? modName).trim().slice(0, 255) || modName;
    const intro = moodleHtml(textOf(mod, "intro"), report, `"${name}"`);
    const seq = sequenceOf.get(sectionId) ?? [];
    const position = seq.indexOf(moduleId) >= 0 ? seq.indexOf(moduleId) : 1000 + i;
    const common = {
      id: moduleId,
      sectionId,
      name,
      position,
      visible: bool(numberOf(module, "visible")),
      availableFrom: null,
      availableUntil: null,
      completionRule: completionRule(module),
      groupMode: ["none", "separate", "visible"][numberOf(module, "groupmode") ?? 0] ?? "none",
    };

    switch (modName) {
      case "page":
        acts.push({ ...common, type: "page", description: intro, data: { content: moodleHtml(textOf(mod, "content"), report, `Page "${name}"`) ?? "" } });
        break;
      case "label":
        acts.push({ ...common, type: "page", description: null, data: { content: intro ?? "" } });
        report.warnings.push(`Label "${name}" was imported as a page`);
        break;
      case "url":
        acts.push({ ...common, type: "url", description: intro, data: { externalUrl: textOf(mod, "externalurl") ?? "" } });
        break;
      case "assign": {
        const grade = numberOf(mod, "grade") ?? 100;
        if (grade < 0) report.warnings.push(`Assignment "${name}" used a Moodle scale; it was imported with a 0–100 grade`);
        const maxFiles = Number(assignPluginConfig(mod, "file", "maxfilesubmissions") ?? 5);
        const maxBytes = Number(assignPluginConfig(mod, "file", "maxsubmissionsizebytes") ?? 0);
        acts.push({
          ...common,
          type: "assignment",
          description: intro,
          data: {
            instructions: moodleHtml(textOf(mod, "activity"), report, `Assignment "${name}"`),
            allowText: assignPluginConfig(mod, "onlinetext", "enabled") === "1",
            allowFiles: assignPluginConfig(mod, "file", "enabled") !== "0",
            maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? Math.min(maxFiles, 100) : 5,
            maxFileBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, 200 * 1024 * 1024) : 20 * 1024 * 1024,
            dueAt: unix(numberOf(mod, "duedate")),
            cutoffAt: unix(numberOf(mod, "cutoffdate")),
            allowResubmit: true,
            gradeMax: grade > 0 ? grade : 100,
            gradePass: null,
            blindMarking: (numberOf(mod, "blindmarking") ?? 0) > 0,
          },
        });
        break;
      }
      case "forum": {
        const t = (textOf(mod, "type") ?? "general").trim();
        const type = ["general", "news", "qanda", "single"].includes(t) ? t : "general";
        if (type !== t) report.warnings.push(`Forum "${name}" of Moodle type "${t}" was imported as a standard forum`);
        const force = numberOf(mod, "forcesubscribe") ?? 0;
        acts.push({
          ...common,
          type: "forum",
          description: intro,
          data: {
            type,
            intro,
            subscriptionMode: force === 1 ? "forced" : force === 3 ? "disabled" : "optional",
            completionPosts: Math.max(numberOf(mod, "completionposts") ?? 0, numberOf(mod, "completiondiscussions") ?? 0, numberOf(mod, "completionreplies") ?? 0),
          },
        });
        break;
      }
      case "quiz": {
        const methods = ["highest", "highest", "average", "first", "last"];
        const limit = numberOf(mod, "timelimit") ?? 0;
        acts.push({
          ...common,
          type: "quiz",
          description: intro,
          data: {
            intro,
            openAt: unix(numberOf(mod, "timeopen")),
            closeAt: unix(numberOf(mod, "timeclose")),
            timeLimitSeconds: limit > 0 ? limit : null,
            attemptsAllowed: Math.max(0, numberOf(mod, "attempts_number") ?? numberOf(mod, "attempts") ?? 0),
            gradeMethod: methods[numberOf(mod, "grademethod") ?? 1] ?? "highest",
            gradeMax: (numberOf(mod, "grade") ?? 10) > 0 ? numberOf(mod, "grade")! : 10,
            shuffleAnswers: bool(numberOf(mod, "shuffleanswers")),
            slots: moodleQuizSlots(mod, bank, report, name),
          },
        });
        break;
      }
    }
  }
  for (const [mod, n] of unsupportedCounts) report.unsupported.push(`${n} Moodle "${mod}" activit${n === 1 ? "y" : "ies"}`);
  report.unsupported.push("Moodle user data, files, grade setup and restrictions are not imported");

  return zBackupCourse.parse({
    course: {
      fullname: fullname.trim().slice(0, 255) || "Imported course",
      shortname: shortname.trim().slice(0, 100) || "imported",
      summary: moodleHtml(textOf(courseXml, "summary"), report, "Course summary"),
      format: format === "weeks" ? "weeks" : format === "singleactivity" ? "single" : "topics",
      visible: bool(numberOf(courseXml, "visible")),
      startDate: unix(numberOf(courseXml, "startdate")),
      endDate: unix(numberOf(courseXml, "enddate")),
    },
    sections,
    activities: acts,
    questionBank: { categories: bank.categories, questions: bank.questions },
  });
}
