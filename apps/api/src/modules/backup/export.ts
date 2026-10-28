import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  activities,
  assignmentFeedback,
  assignments,
  assignmentSubmissions,
  attendances,
  attemptAnswers,
  attendanceRecords,
  attendanceSessions,
  badges,
  certificateActivities,
  certificateTemplates,
  contentResources,
  courseSections,
  courses,
  enrolments,
  files,
  forumDiscussions,
  forumPosts,
  forums,
  gradeCategories,
  gradeGrades,
  gradeItems,
  groupMembers,
  groups,
  interactiveContents,
  ltiLinks,
  ltiTools,
  organizations,
  questionCategories,
  questions,
  questionVersions,
  quizAttempts,
  quizSlots,
  quizzes,
  roleAssignments,
  roles,
  scormPackages,
  submissionFiles,
  users,
  videoMeetings,
  workshopAssessments,
  workshopSubmissions,
  workshops,
  type DB,
} from "@lms/db";
import { readFileBody } from "../../core/files";
import { BACKUP_FORMAT, BACKUP_VERSION, MAX_ARCHIVE_BYTES, type BackupActivity, type BackupCourse, type BackupFile, type BackupManifest } from "./format";
import { ZipWriter } from "./zip-writer";

/** Columns copied per activity type (everything except ids, tenant and timestamps). */
export const TYPE_COLUMNS = {
  content: ["content", "externalUrl", "fileId"],
  assignment: ["instructions", "allowText", "allowFiles", "maxFiles", "maxFileBytes", "acceptedTypes", "dueAt", "cutoffAt", "allowResubmit", "gradeMax", "gradePass", "blindMarking"],
  quiz: ["intro", "openAt", "closeAt", "timeLimitSeconds", "attemptsAllowed", "gradeMethod", "gradeMax", "gradePass", "shuffleQuestions", "shuffleAnswers", "reviewOptions"],
  forum: ["type", "intro", "subscriptionMode", "completionPosts"],
  workshop: [
    "instructions",
    "assessmentInstructions",
    "phase",
    "submissionEndAt",
    "assessmentEndAt",
    "submissionGradeMax",
    "assessmentGradeMax",
    "reviewsPerSubmission",
    "allowSelfAssessment",
    "criteria",
  ],
  attendance: ["gradeMax", "statusPoints", "allowSelfMarking"],
  interactive: ["kind", "packageFileId", "embedUrl", "gradeMax", "settings"],
  video: ["provider", "roomName", "joinUrl", "startsAt", "durationMinutes", "recordingUrl"],
  certificate: ["templateId", "requireCourseCompletion", "minGradePercent", "autoIssue", "expiresAfterDays"],
  lti: ["targetLinkUri", "customParams", "gradeMax", "openInNewWindow"],
  scorm: ["packageFileId", "version", "entryHref", "storagePrefix", "title", "manifest", "gradeMax", "gradeMethod", "maxAttempts"],
} as const;

export function pick(row: Record<string, unknown>, keys: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
}

const FILE_REF = /\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** File ids referenced from HTML (e.g. images inserted with the rich text editor). */
export function fileIdsInHtml(...html: (string | null | undefined)[]) {
  const out = new Set<string>();
  for (const h of html) if (h) for (const m of h.matchAll(FILE_REF)) out.add(m[1]!.toLowerCase());
  return out;
}

function byActivity<T extends { activityId: string }>(rows: T[]) {
  return new Map(rows.map((r) => [r.activityId, r]));
}

export type BuiltBackup = { zip: Buffer; manifest: BackupManifest; warnings: string[] };

/**
 * Reads a course and everything needed to recreate it into a backup ZIP.
 * Runs inside a tenant transaction (no request: called from the backup job).
 */
export async function buildCourseBackup(
  tx: DB,
  input: { organizationId: string; courseId: string; includeUserData: boolean; includeFiles: boolean },
): Promise<BuiltBackup> {
  const warnings: string[] = [];
  const [course] = await tx.select().from(courses).where(eq(courses.id, input.courseId)).limit(1);
  if (!course) throw new Error("Course not found");
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, input.organizationId)).limit(1);

  const sections = await tx.select().from(courseSections).where(eq(courseSections.courseId, course.id)).orderBy(asc(courseSections.position));
  const acts = await tx.select().from(activities).where(eq(activities.courseId, course.id)).orderBy(asc(activities.position));
  const ids = acts.map((a) => a.id);
  const any = ids.length ? ids : ["00000000-0000-0000-0000-000000000000"];

  const [content, assigns, quizRows, forumRows, workshopRows, attendanceRows, interactiveRows, videoRows, certRows, ltiRows, scormRows] = [
    byActivity(await tx.select().from(contentResources).where(inArray(contentResources.activityId, any))),
    byActivity(await tx.select().from(assignments).where(inArray(assignments.activityId, any))),
    byActivity(await tx.select().from(quizzes).where(inArray(quizzes.activityId, any))),
    byActivity(await tx.select().from(forums).where(inArray(forums.activityId, any))),
    byActivity(await tx.select().from(workshops).where(inArray(workshops.activityId, any))),
    byActivity(await tx.select().from(attendances).where(inArray(attendances.activityId, any))),
    byActivity(await tx.select().from(interactiveContents).where(inArray(interactiveContents.activityId, any))),
    byActivity(await tx.select().from(videoMeetings).where(inArray(videoMeetings.activityId, any))),
    byActivity(await tx.select().from(certificateActivities).where(inArray(certificateActivities.activityId, any))),
    byActivity(
      await tx
        .select({ link: ltiLinks, toolName: ltiTools.name })
        .from(ltiLinks)
        .innerJoin(ltiTools, eq(ltiTools.id, ltiLinks.toolId))
        .where(inArray(ltiLinks.activityId, any))
        .then((r) => r.map((x) => ({ ...x, activityId: x.link.activityId }))),
    ),
    byActivity(await tx.select().from(scormPackages).where(inArray(scormPackages.activityId, any))),
  ];

  const quizIds = [...quizRows.values()].map((q) => q.id);
  const slots = quizIds.length ? await tx.select().from(quizSlots).where(inArray(quizSlots.quizId, quizIds)).orderBy(asc(quizSlots.position)) : [];
  const attendanceIds = [...attendanceRows.values()].map((a) => a.id);
  const sessions = attendanceIds.length
    ? await tx.select().from(attendanceSessions).where(inArray(attendanceSessions.attendanceId, attendanceIds)).orderBy(asc(attendanceSessions.startsAt))
    : [];

  const out: BackupActivity[] = [];
  for (const a of acts) {
    let data: Record<string, unknown> | null = null;
    switch (a.type) {
      case "page":
      case "url":
      case "file": {
        const r = content.get(a.id);
        data = r ? pick(r, TYPE_COLUMNS.content) : null;
        break;
      }
      case "assignment": {
        const r = assigns.get(a.id);
        data = r ? pick(r, TYPE_COLUMNS.assignment) : null;
        break;
      }
      case "quiz": {
        const r = quizRows.get(a.id);
        data = r
          ? {
              ...pick(r, TYPE_COLUMNS.quiz),
              slots: slots.filter((s) => s.quizId === r.id).map((s) => ({ id: s.id, questionId: s.questionId, pinnedVersion: s.pinnedVersion, position: s.position, maxMark: s.maxMark })),
            }
          : null;
        break;
      }
      case "forum": {
        const r = forumRows.get(a.id);
        data = r ? pick(r, TYPE_COLUMNS.forum) : null;
        break;
      }
      case "workshop": {
        const r = workshopRows.get(a.id);
        data = r ? pick(r, TYPE_COLUMNS.workshop) : null;
        break;
      }
      case "attendance": {
        const r = attendanceRows.get(a.id);
        data = r
          ? {
              ...pick(r, TYPE_COLUMNS.attendance),
              sessions: sessions
                .filter((s) => s.attendanceId === r.id)
                .map((s) => ({ id: s.id, groupId: s.groupId, startsAt: s.startsAt, durationMinutes: s.durationMinutes, description: s.description })),
            }
          : null;
        break;
      }
      case "interactive": {
        const r = interactiveRows.get(a.id);
        data = r ? pick(r, TYPE_COLUMNS.interactive) : null;
        break;
      }
      case "video": {
        const r = videoRows.get(a.id);
        data = r ? pick(r, TYPE_COLUMNS.video) : null;
        break;
      }
      case "certificate": {
        const r = certRows.get(a.id);
        data = r ? pick(r, TYPE_COLUMNS.certificate) : null;
        break;
      }
      case "lti": {
        const r = ltiRows.get(a.id);
        data = r ? { ...pick(r.link, TYPE_COLUMNS.lti), toolName: r.toolName, toolId: r.link.toolId } : null;
        break;
      }
      case "scorm": {
        const r = scormRows.get(a.id);
        data = r ? pick(r, TYPE_COLUMNS.scorm) : null;
        break;
      }
    }
    if (!data) warnings.push(`Activity "${a.name}" (${a.type}) has no settings record`);
    out.push({
      id: a.id,
      sectionId: a.sectionId,
      type: a.type,
      name: a.name,
      description: a.description,
      position: a.position,
      visible: a.visible,
      availableFrom: a.availableFrom?.toISOString() ?? null,
      availableUntil: a.availableUntil?.toISOString() ?? null,
      completionRule: a.completionRule,
      groupMode: a.groupMode,
      data,
    });
  }

  // ─── Question bank: the course's categories + everything the quizzes use ───
  const courseCats = await tx.select().from(questionCategories).where(eq(questionCategories.courseId, course.id));
  const catIds = new Set(courseCats.map((c) => c.id));
  const courseQuestions = catIds.size
    ? await tx.select().from(questions).where(and(inArray(questions.categoryId, [...catIds]), isNull(questions.deletedAt)))
    : [];
  const questionIds = new Set([...courseQuestions.map((q) => q.id), ...slots.map((s) => s.questionId)]);
  const allQuestions = questionIds.size ? await tx.select().from(questions).where(inArray(questions.id, [...questionIds])) : [];
  const versions = questionIds.size
    ? await tx.select().from(questionVersions).where(inArray(questionVersions.questionId, [...questionIds])).orderBy(asc(questionVersions.version))
    : [];
  // Shared (organization) categories used by the quizzes, with their ancestors.
  const cats = new Map(courseCats.map((c) => [c.id, c]));
  let missing = [...new Set(allQuestions.map((q) => q.categoryId))].filter((id) => !cats.has(id));
  while (missing.length) {
    const rows = await tx.select().from(questionCategories).where(inArray(questionCategories.id, missing));
    for (const r of rows) cats.set(r.id, r);
    missing = [...new Set(rows.map((r) => r.parentId).filter((p): p is string => !!p))].filter((id) => !cats.has(id));
  }

  // ─── Certificate templates, gradebook, groups, badges ──────────────────────
  const templateIds = [...new Set([...certRows.values()].map((c) => c.templateId))];
  const templates = templateIds.length ? await tx.select().from(certificateTemplates).where(inArray(certificateTemplates.id, templateIds)) : [];
  const gradeCats = await tx.select().from(gradeCategories).where(eq(gradeCategories.courseId, course.id)).orderBy(asc(gradeCategories.createdAt));
  const items = await tx.select().from(gradeItems).where(eq(gradeItems.courseId, course.id)).orderBy(asc(gradeItems.position));
  const groupRows = await tx.select().from(groups).where(eq(groups.courseId, course.id));
  const badgeRows = await tx.select().from(badges).where(eq(badges.courseId, course.id));

  const backup: BackupCourse = {
    course: {
      fullname: course.fullname,
      shortname: course.shortname,
      summary: course.summary,
      format: course.format,
      visible: course.visible,
      startDate: course.startDate?.toISOString() ?? null,
      endDate: course.endDate?.toISOString() ?? null,
      enableCompletion: course.enableCompletion,
      selfEnrol: course.selfEnrol,
      priceCents: course.priceCents,
      currency: course.currency,
      imageFileId: course.imageFileId,
    },
    sections: sections.map((s) => ({ id: s.id, title: s.title, summary: s.summary, position: s.position, visible: s.visible })),
    activities: out,
    questionBank: {
      categories: [...cats.values()].map((c) => ({ id: c.id, parentId: c.parentId, name: c.name, shared: c.courseId === null })),
      questions: allQuestions.map((q) => ({
        id: q.id,
        categoryId: q.categoryId,
        latestVersion: q.latestVersion,
        versions: versions
          .filter((v) => v.questionId === q.id)
          .map((v) => ({ version: v.version, type: v.type, name: v.name, text: v.text, defaultMark: v.defaultMark, data: v.data, generalFeedback: v.generalFeedback })),
      })),
    },
    certificateTemplates: templates.map((t) => ({ id: t.id, name: t.name, orientation: t.orientation, backgroundFileId: t.backgroundFileId, elements: t.elements })),
    gradebook: {
      categories: gradeCats.map((c) => ({ id: c.id, parentId: c.parentId, name: c.name, aggregation: c.aggregation, dropLowest: c.dropLowest })),
      items: items.map((i) => ({
        id: i.id,
        categoryId: i.categoryId,
        type: i.type,
        activityId: i.activityId,
        name: i.name,
        gradeMax: i.gradeMax,
        gradeMin: i.gradeMin,
        gradePass: i.gradePass,
        weight: i.weight,
        hidden: i.hidden,
        locked: i.locked,
        position: i.position,
      })),
    },
    groups: groupRows.map((g) => ({ id: g.id, name: g.name, description: g.description })),
    badges: badgeRows.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      imageFileId: b.imageFileId,
      criteria: b.criteria as Record<string, unknown>,
      status: b.status,
      expiresAfterDays: b.expiresAfterDays,
    })),
    files: [],
  };

  // ─── User data (optional) ──────────────────────────────────────────────────
  const userFileIds = new Set<string>();
  if (input.includeUserData) {
    const enrolRows = await tx
      .select({ e: enrolments, u: { id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName } })
      .from(enrolments)
      .innerJoin(users, eq(users.id, enrolments.userId))
      .where(eq(enrolments.courseId, course.id));
    const roleRows = await tx
      .select({ userId: roleAssignments.userId, shortname: roles.shortname })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(eq(roleAssignments.contextId, course.contextId));
    const people = new Map(enrolRows.map((r) => [r.u.id, r.u]));
    const addPerson = async (id: string) => {
      if (people.has(id)) return;
      const [u] = await tx.select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, id)).limit(1);
      if (u) people.set(id, u);
    };
    const groupIds = groupRows.map((g) => g.id);
    const members = groupIds.length ? await tx.select().from(groupMembers).where(inArray(groupMembers.groupId, groupIds)) : [];
    const grades = items.length ? await tx.select().from(gradeGrades).where(inArray(gradeGrades.itemId, items.map((i) => i.id))) : [];

    const assignmentIds = [...assigns.values()].map((a) => a.id);
    const activityOfAssignment = new Map([...assigns.values()].map((a) => [a.id, a.activityId]));
    const subs = assignmentIds.length ? await tx.select().from(assignmentSubmissions).where(inArray(assignmentSubmissions.assignmentId, assignmentIds)) : [];
    const subIds = subs.map((s) => s.id);
    const subFiles = subIds.length ? await tx.select().from(submissionFiles).where(inArray(submissionFiles.submissionId, subIds)) : [];
    const feedback = subIds.length ? await tx.select().from(assignmentFeedback).where(inArray(assignmentFeedback.submissionId, subIds)) : [];
    const fbOf = new Map(feedback.map((f) => [f.submissionId, f]));

    const forumIds = [...forumRows.values()].map((f) => f.id);
    const activityOfForum = new Map([...forumRows.values()].map((f) => [f.id, f.activityId]));
    const discussions = forumIds.length ? await tx.select().from(forumDiscussions).where(inArray(forumDiscussions.forumId, forumIds)) : [];
    const posts = discussions.length
      ? await tx.select().from(forumPosts).where(inArray(forumPosts.discussionId, discussions.map((d) => d.id))).orderBy(asc(forumPosts.createdAt))
      : [];

    // Finished quiz attempts (in-progress ones can't be resumed in another course) with their answers.
    const activityOfQuiz = new Map([...quizRows.values()].map((q) => [q.id, q.activityId]));
    const attempts = quizIds.length
      ? await tx.select().from(quizAttempts).where(and(inArray(quizAttempts.quizId, quizIds), eq(quizAttempts.status, "finished")))
      : [];
    const answers = attempts.length
      ? await tx
          .select({ a: attemptAnswers, questionId: questionVersions.questionId, version: questionVersions.version })
          .from(attemptAnswers)
          .innerJoin(questionVersions, eq(questionVersions.id, attemptAnswers.questionVersionId))
          .where(inArray(attemptAnswers.attemptId, attempts.map((x) => x.id)))
      : [];
    const records = sessions.length ? await tx.select().from(attendanceRecords).where(inArray(attendanceRecords.sessionId, sessions.map((x) => x.id))) : [];
    const workshopIds = [...workshopRows.values()].map((w) => w.id);
    const activityOfWorkshop = new Map([...workshopRows.values()].map((w) => [w.id, w.activityId]));
    const wsSubs = workshopIds.length ? await tx.select().from(workshopSubmissions).where(inArray(workshopSubmissions.workshopId, workshopIds)) : [];
    const wsAssessments = wsSubs.length ? await tx.select().from(workshopAssessments).where(inArray(workshopAssessments.submissionId, wsSubs.map((x) => x.id))) : [];
    for (const sub of wsSubs) for (const f of sub.fileIds) userFileIds.add(f);

    for (const id of [
      ...grades.map((g) => g.userId),
      ...subs.map((s) => s.userId),
      ...discussions.map((d) => d.userId),
      ...posts.map((p) => p.userId),
      ...members.map((m) => m.userId),
      ...attempts.map((x) => x.userId),
      ...records.map((r) => r.userId),
      ...wsSubs.map((x) => x.userId),
      ...wsAssessments.map((x) => x.reviewerId),
    ]) {
      await addPerson(id);
    }
    for (const f of subFiles) userFileIds.add(f.fileId);

    backup.userData = {
      users: [...people.values()],
      enrolments: enrolRows.map((r) => ({
        userId: r.u.id,
        status: r.e.status,
        method: r.e.method,
        roles: roleRows.filter((x) => x.userId === r.u.id).map((x) => x.shortname),
        timeStart: r.e.timeStart?.toISOString() ?? null,
        timeEnd: r.e.timeEnd?.toISOString() ?? null,
      })),
      groupMembers: members.map((m) => ({ groupId: m.groupId, userId: m.userId })),
      grades: grades.map((g) => ({ itemId: g.itemId, userId: g.userId, rawGrade: g.rawGrade, finalGrade: g.finalGrade, overridden: g.overridden, feedback: g.feedback })),
      submissions: subs.map((s) => ({
        activityId: activityOfAssignment.get(s.assignmentId)!,
        userId: s.userId,
        attempt: s.attempt,
        status: s.status,
        text: s.text,
        submittedAt: s.submittedAt?.toISOString() ?? null,
        late: s.late,
        fileIds: subFiles.filter((f) => f.submissionId === s.id).map((f) => f.fileId),
        grade: fbOf.get(s.id)?.grade ?? null,
        feedback: fbOf.get(s.id)?.feedback ?? null,
      })),
      forumDiscussions: discussions.map((d) => ({
        id: d.id,
        activityId: activityOfForum.get(d.forumId)!,
        userId: d.userId,
        groupId: d.groupId,
        title: d.title,
        pinned: d.pinned,
        locked: d.locked,
        createdAt: d.createdAt.toISOString(),
      })),
      forumPosts: posts.map((p) => ({
        id: p.id,
        discussionId: p.discussionId,
        parentId: p.parentId,
        userId: p.userId,
        message: p.deletedAt ? "" : p.message,
        createdAt: p.createdAt.toISOString(),
        deleted: !!p.deletedAt,
      })),
      quizAttempts: attempts.map((x) => ({
        activityId: activityOfQuiz.get(x.quizId)!,
        userId: x.userId,
        attempt: x.attempt,
        layout: x.layout,
        startedAt: x.startedAt.toISOString(),
        finishedAt: x.finishedAt?.toISOString() ?? null,
        sumMarks: x.sumMarks,
        grade: x.grade,
        needsGrading: x.needsGrading,
        answers: answers
          .filter((r) => r.a.attemptId === x.id)
          .map((r) => ({
            slotId: r.a.slotId,
            questionId: r.questionId,
            version: r.version,
            variant: r.a.variant,
            response: r.a.response ?? null,
            fraction: r.a.fraction,
            mark: r.a.mark,
            maxMark: r.a.maxMark,
            needsGrading: r.a.needsGrading,
            comment: r.a.comment,
          })),
      })),
      attendanceRecords: records.map((r) => ({ sessionId: r.sessionId, userId: r.userId, status: r.status, remarks: r.remarks, takenAt: r.takenAt.toISOString() })),
      workshopSubmissions: wsSubs.map((x) => ({
        activityId: activityOfWorkshop.get(x.workshopId)!,
        userId: x.userId,
        title: x.title,
        content: x.content,
        fileIds: x.fileIds,
        grade: x.grade,
        gradeOverride: x.gradeOverride,
        createdAt: x.createdAt.toISOString(),
        assessments: wsAssessments
          .filter((a) => a.submissionId === x.id)
          .map((a) => ({ reviewerId: a.reviewerId, scores: a.scores, grade: a.grade, gradingGrade: a.gradingGrade, feedback: a.feedback, submittedAt: a.submittedAt?.toISOString() ?? null })),
      })),
    };
  }

  // ─── Files ─────────────────────────────────────────────────────────────────
  const zip = new ZipWriter();
  if (input.includeFiles) {
    const wanted = new Set<string>();
    const add = (id: unknown) => {
      if (typeof id === "string" && id) wanted.add(id.toLowerCase());
    };
    add(course.imageFileId);
    for (const a of out) {
      add(a.data?.fileId);
      add(a.data?.packageFileId);
      for (const id of fileIdsInHtml(a.description, a.data?.content as string, a.data?.intro as string, a.data?.instructions as string)) add(id);
    }
    for (const id of fileIdsInHtml(course.summary, ...sections.map((s) => s.summary))) add(id);
    for (const b of backup.badges) add(b.imageFileId);
    for (const t of backup.certificateTemplates) {
      add(t.backgroundFileId);
      for (const el of t.elements as { fileId?: string }[]) add(el?.fileId);
    }
    for (const q of backup.questionBank.questions) for (const v of q.versions) for (const id of fileIdsInHtml(v.text, v.generalFeedback)) add(id);
    for (const id of userFileIds) add(id);

    const rows = wanted.size
      ? await tx.select().from(files).where(and(inArray(files.id, [...wanted]), isNull(files.deletedAt), eq(files.status, "ready")))
      : [];
    let total = 0;
    for (const f of rows) {
      if (total + f.size > MAX_ARCHIVE_BYTES) {
        warnings.push(`Skipped file "${f.filename}": the backup size limit was reached`);
        continue;
      }
      let body: Buffer;
      try {
        body = await readFileBody(tx, input.organizationId, f);
      } catch {
        warnings.push(`File "${f.filename}" could not be read from storage`);
        continue;
      }
      const entry: BackupFile = { id: f.id, filename: f.filename, mimeType: f.mimeType, size: body.length, path: `files/${f.id}/${f.filename.replace(/[/\\]/g, "_")}` };
      // Media is usually compressed already; deflate only text-like files.
      zip.add({ name: entry.path, data: body, compress: /^(text\/|application\/(json|xml))/.test(f.mimeType) });
      backup.files.push(entry);
      total += body.length;
    }
  }

  const counts = {
    sections: backup.sections.length,
    activities: backup.activities.length,
    questions: backup.questionBank.questions.length,
    gradeItems: backup.gradebook.items.length,
    groups: backup.groups.length,
    badges: backup.badges.length,
    files: backup.files.length,
    users: backup.userData?.users.length ?? 0,
  };
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    source: {
      organizationId: input.organizationId,
      organizationName: org?.name ?? "",
      organizationSlug: org?.slug ?? "",
      courseId: course.id,
      app: "lms",
    },
    course: { fullname: course.fullname, shortname: course.shortname },
    options: { includeUserData: input.includeUserData, includeFiles: input.includeFiles },
    counts,
  };
  zip.add({ name: "manifest.json", data: JSON.stringify(manifest, null, 2) });
  zip.add({ name: "course.json", data: JSON.stringify(backup) });
  return { zip: zip.finish(), manifest, warnings };
}
