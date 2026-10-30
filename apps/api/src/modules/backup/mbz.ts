import type { ArchiveFiles } from "./archive";
import { parseMoodleGradebook } from "./mbz-gradebook";
import { moodleQuizSlots, parseMoodleQuestions } from "./mbz-questions";
import { zBackupCourse, type ParsedBackupCourse, type RestoreReport } from "./format";
import { child, children, numberOf, parseXml, path, textOf, type XmlNode } from "./xml";

/**
 * Best-effort import of Moodle course backups (.mbz) into our backup structure,
 * so the regular restore engine creates the course.
 *
 * Supported: course settings, sections, page, url, label (as page), assign,
 * forum, quiz (settings, question slots and random slots), file resources, folders (as a page
 * linking their files), the question bank (see mbz-questions.ts), the gradebook setup (see
 * mbz-gradebook.ts) and files embedded in course, section and activity HTML (@@PLUGINFILE@@
 * links). Everything else is reported as unsupported.
 */

/** Moodle module types we read, and the XML file that holds their settings. */
const SUPPORTED = new Set(["page", "url", "label", "assign", "forum", "quiz", "resource", "folder"]);

export function isMoodleBackup(files: ArchiveFiles) {
  return files.has("moodle_backup.xml");
}

/** Only the XML files the importer reads (keeps memory bounded for big .mbz files). */
export function mbzFilter(name: string) {
  return (
    name === "moodle_backup.xml" ||
    name === "course/course.xml" ||
    name === "questions.xml" ||
    name === "files.xml" ||
    name === "gradebook.xml" ||
    /^sections\/[^/]+\/section\.xml$/.test(name) ||
    /^activities\/[^/]+\/(module|page|url|label|assign|forum|quiz|resource|folder)\.xml$/.test(name)
  );
}

// ─── Embedded files ───────────────────────────────────────────────────────

/** File areas we import: files embedded in HTML, and the files of resources and folders. */
const EMBEDDED_AREAS = new Set([
  "course|summary",
  "course|section",
  "mod_page|content",
  "mod_assign|activity",
  "mod_assign|introattachment",
  "mod_resource|content",
  "mod_folder|content",
]);
const isEmbeddedArea = (component: string, area: string) => area === "intro" || EMBEDDED_AREAS.has(`${component}|${area}`);

type MoodleFile = {
  id: string;
  contextId: string;
  component: string;
  area: string;
  itemId: string;
  filepath: string;
  filename: string;
  mimeType: string;
  size: number;
  sortOrder: number;
  path: string;
};

/** Readable entries of files.xml that belong to areas we import (directories and empty files excluded). */
function moodleFiles(files: ArchiveFiles): MoodleFile[] {
  const root = path(xmlFile(files, "files.xml"), "files");
  const out: MoodleFile[] = [];
  const seen = new Set<string>();
  for (const f of children(root, "file")) {
    const filename = textOf(f, "filename") ?? "";
    const hash = (textOf(f, "contenthash") ?? "").trim();
    const component = textOf(f, "component") ?? "";
    const area = textOf(f, "filearea") ?? "";
    if (!filename || filename === "." || !/^[0-9a-f]{40}$/.test(hash) || !isEmbeddedArea(component, area)) continue;
    const key = `${textOf(f, "contextid")}|${component}|${area}|${textOf(f, "itemid")}|${textOf(f, "filepath")}|${filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: crypto.randomUUID(),
      contextId: (textOf(f, "contextid") ?? "").trim(),
      component,
      area,
      itemId: (textOf(f, "itemid") ?? "0").trim(),
      filepath: textOf(f, "filepath") ?? "/",
      filename,
      mimeType: textOf(f, "mimetype") ?? "application/octet-stream",
      size: numberOf(f, "filesize") ?? 0,
      sortOrder: numberOf(f, "sortorder") ?? 0,
      path: `files/${hash.slice(0, 2)}/${hash}`,
    });
  }
  return out;
}

/** Archive entries holding the bodies of embedded files (read in a second pass, so only these are kept in memory). */
export function mbzEmbeddedFilePaths(files: ArchiveFiles) {
  return new Set(moodleFiles(files).map((f) => f.path));
}

type FileScope = { contextId: string | undefined; component: string; areas: string[]; itemId?: string };

function xmlFile(files: ArchiveFiles, name: string): XmlNode | null {
  const buf = files.get(name);
  return buf ? parseXml(buf.toString("utf8")) : null;
}

const unix = (n: number | null) => (n && n > 0 ? new Date(n * 1000).toISOString() : null);
const bool = (n: number | null, fallback = true) => (n === null ? fallback : n !== 0);

/**
 * Rewrites @@PLUGINFILE@@ links to the imported copies (`/api/v1/files/<id>`, which the
 * restore engine maps to the stored file). Links to files that weren't in the backup are reported.
 */
function rewritePluginFiles(html: string | null, available: MoodleFile[], used: Set<MoodleFile>, report: RestoreReport, where: string, scope?: FileScope) {
  if (!html) return null;
  if (!html.includes("@@PLUGINFILE@@")) return html;
  let missing = 0;
  const out = html.replace(/@@PLUGINFILE@@(\/[^"'\s<>?#]*)/g, (m, rawPath: string) => {
    let decoded = rawPath;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      /* keep raw */
    }
    const slash = decoded.lastIndexOf("/");
    const filepath = decoded.slice(0, slash + 1);
    const filename = decoded.slice(slash + 1);
    const hit = scope
      ? available.find(
          (f) =>
            f.contextId === scope.contextId &&
            f.component === scope.component &&
            scope.areas.includes(f.area) &&
            (scope.itemId === undefined || f.itemId === scope.itemId) &&
            f.filepath === filepath &&
            f.filename === filename,
        )
      : undefined;
    if (!hit) {
      missing++;
      return m;
    }
    used.add(hit);
    return `/api/v1/files/${hit.id}?inline=true`;
  });
  if (missing) report.warnings.push(`${where}: ${missing} embedded Moodle file(s) were not in the backup and were left as broken links`);
  return out;
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
  // Embedded files whose bodies are in the archive (the caller loads them in a second pass).
  const available = moodleFiles(files).filter((f) => files.has(f.path));
  const used = new Set<MoodleFile>();
  const courseContextId = path(xmlFile(files, "course/course.xml"), "course")?.attrs.contextid;
  const moodleHtml = (html: string | null, _report: RestoreReport, where: string, scope?: FileScope) => rewritePluginFiles(html, available, used, report, where, scope);
  const contents = child(info, "contents");
  const sectionEntries = children(child(contents, "sections"), "section");
  const activityEntries = children(child(contents, "activities"), "activity");

  const sections: Record<string, unknown>[] = [];
  const sequenceOf = new Map<string, string[]>();
  for (const [i, s] of sectionEntries.entries()) {
    const sectionId = textOf(s, "sectionid") ?? String(i);
    const dir = textOf(s, "directory") ?? `sections/section_${sectionId}`;
    const xml = path(xmlFile(files, `${dir}/section.xml`), "section");
    const sectionScope: FileScope = { contextId: courseContextId, component: "course", areas: ["section"], itemId: xml?.attrs.id ?? sectionId };
    const number = numberOf(xml, "number") ?? i;
    // moodle_backup.xml's section <title> is just the section number: only <name> is meaningful.
    const name = textOf(xml, "name");
    sections.push({
      id: sectionId,
      title: (name && name.trim()) || (number === 0 ? "General" : `Topic ${number}`),
      summary: moodleHtml(textOf(xml, "summary"), report, `Section "${name ?? number}"`, sectionScope),
      position: number,
      visible: bool(numberOf(xml, "visible")),
    });
    sequenceOf.set(sectionId, (textOf(xml, "sequence") ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  }

  const acts: Record<string, unknown>[] = [];
  const unsupportedCounts = new Map<string, number>();
  /** "<module>:<instance id>" → imported activity id (the Moodle course module id), for grade items. */
  const instances = new Map<string, string>();
  const areaFiles = (contextId: string | undefined, component: string, area: string) =>
    available.filter((f) => f.contextId === contextId && f.component === component && f.area === area);
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
    const activityXml = path(xmlFile(files, `${dir}/${modName}.xml`), "activity");
    const mod = child(activityXml, modName);
    const contextId = activityXml?.attrs.contextid;
    const scope = (...areas: string[]): FileScope => ({ contextId, component: `mod_${modName}`, areas });
    if (!mod) {
      report.warnings.push(`Activity "${title}" (${modName}) has no settings file and was skipped`);
      continue;
    }
    const name = (textOf(mod, "name") ?? title ?? modName).trim().slice(0, 255) || modName;
    const intro = moodleHtml(textOf(mod, "intro"), report, `"${name}"`, scope("intro"));
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

    if (activityXml?.attrs.id) instances.set(`${modName}:${activityXml.attrs.id}`, moduleId);

    switch (modName) {
      case "resource": {
        // The main file has the highest sort order; other files are its dependencies (e.g. HTML packages).
        const list = areaFiles(contextId, "mod_resource", "content").sort((a, b) => b.sortOrder - a.sortOrder || a.filepath.localeCompare(b.filepath));
        const main = list[0];
        if (!main) {
          report.warnings.push(`File "${name}" had no file in the backup and was skipped`);
          instances.delete(`${modName}:${activityXml?.attrs.id}`);
          continue;
        }
        used.add(main);
        if (list.length > 1) report.warnings.push(`File "${name}": only the main file of ${list.length} was imported`);
        const display = numberOf(mod, "display") === 4 ? "download" : "inline";
        acts.push({ ...common, type: "file", description: intro, data: { content: JSON.stringify({ display }), fileId: main.id } });
        break;
      }
      case "folder": {
        const list = areaFiles(contextId, "mod_folder", "content").sort((a, b) => (a.filepath + a.filename).localeCompare(b.filepath + b.filename));
        for (const f of list) used.add(f);
        const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const links = list.map((f) => `<li><a href="/api/v1/files/${f.id}">${esc((f.filepath + f.filename).replace(/^\//, ""))}</a></li>`).join("");
        const content = `${intro ?? ""}${links ? `<ul>${links}</ul>` : "<p>(empty folder)</p>"}`;
        acts.push({ ...common, type: "page", description: null, data: { content } });
        report.warnings.push(`Folder "${name}" was imported as a page linking its ${list.length} file(s)`);
        break;
      }
      case "page":
        acts.push({ ...common, type: "page", description: intro, data: { content: moodleHtml(textOf(mod, "content"), report, `Page "${name}"`, scope("content")) ?? "" } });
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
            instructions: moodleHtml(textOf(mod, "activity"), report, `Assignment "${name}"`, scope("activity", "introattachment")),
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
  report.unsupported.push("Moodle user data (enrolments, grades, submissions, posts) and access restrictions are not imported");

  const gradebook = parseMoodleGradebook(xmlFile(files, "gradebook.xml"), (module, instance) => instances.get(`${module}:${instance}`) ?? null, report);

  return zBackupCourse.parse({
    course: {
      fullname: fullname.trim().slice(0, 255) || "Imported course",
      shortname: shortname.trim().slice(0, 100) || "imported",
      summary: moodleHtml(textOf(courseXml, "summary"), report, "Course summary", { contextId: courseContextId, component: "course", areas: ["summary"] }),
      format: format === "weeks" ? "weeks" : format === "singleactivity" ? "single" : "topics",
      visible: bool(numberOf(courseXml, "visible")),
      startDate: unix(numberOf(courseXml, "startdate")),
      endDate: unix(numberOf(courseXml, "enddate")),
    },
    sections,
    activities: acts,
    questionBank: { categories: bank.categories, questions: bank.questions },
    gradebook,
    files: [...used].map((f) => ({ id: f.id, filename: f.filename.slice(0, 255), mimeType: f.mimeType.slice(0, 255), size: f.size, path: f.path })),
  });
}
