import { and, eq } from "drizzle-orm";
import { conversationMembers } from "@lms/db";
import { on } from "../../core/events";
import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { notifyMessageRecipients } from "./notify";
import { routes } from "./routes";
import { addMembers, courseConversation } from "./service";

export const messagingModule: LmsModule = {
  name: "messaging",
  basePath: "/messages",
  routes,
  capabilities,
  setup() {
    on("message.sent", (tx, p) => notifyMessageRecipients(tx, p), { id: "messaging.notify" });
    // Keep the course conversation's membership in sync with enrolments.
    on(
      "user.enrolled",
      async (tx, p) => {
        const conv = await courseConversation(tx, p.courseId);
        if (conv) await addMembers(tx, conv, [p.userId]);
      },
      { id: "messaging.course_member_add" },
    );
    on(
      "user.unenrolled",
      async (tx, p) => {
        const conv = await courseConversation(tx, p.courseId);
        if (conv) {
          await tx
            .delete(conversationMembers)
            .where(and(eq(conversationMembers.conversationId, conv.id), eq(conversationMembers.userId, p.userId)));
        }
      },
      { id: "messaging.course_member_remove" },
    );
  },
};
