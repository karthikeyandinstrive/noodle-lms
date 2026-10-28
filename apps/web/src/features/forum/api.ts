"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type Paged } from "@/lib/api";

export type ForumType = "general" | "news" | "qanda" | "single";
export type Author = { id: string; firstName: string; lastName: string };

export type ForumInfo = {
  activityId: string;
  type: ForumType;
  intro: string | null;
  subscriptionMode: "optional" | "forced" | "disabled";
  completionPosts: number;
  subscribed: boolean;
  groupMode: "none" | "separate" | "visible";
  groups: { id: string; name: string }[];
  canModerate: boolean;
  canStartDiscussion: boolean;
  canReply: boolean;
  singleDiscussionId: string | null;
  myPostCount: number;
};

export type DiscussionSummary = {
  id: string;
  title: string;
  pinned: boolean;
  locked: boolean;
  groupId: string | null;
  groupName: string | null;
  author: Author;
  createdAt: string;
  lastPostAt: string;
  replyCount: number;
};

export type Post = {
  id: string;
  parentId: string | null;
  author: Author;
  message: string;
  createdAt: string;
  updatedAt: string | null;
  deleted: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

export type DiscussionDetail = DiscussionSummary & { posts: Post[]; canReply: boolean; repliesHidden: boolean };

export type SearchHit = { postId: string; discussionId: string; discussionTitle: string; author: Author; excerpt: string; createdAt: string };

export const forumKeys = {
  all: (activityId: string) => ["forum", activityId] as const,
  info: (activityId: string) => ["forum", activityId, "info"] as const,
  discussions: (activityId: string, page: number) => ["forum", activityId, "discussions", page] as const,
  discussion: (activityId: string, id: string) => ["forum", activityId, "discussion", id] as const,
  search: (activityId: string, q: string, page: number) => ["forum", activityId, "search", q, page] as const,
};

export function useForumInfo(activityId: string) {
  return useQuery({ queryKey: forumKeys.info(activityId), queryFn: () => api<ForumInfo>(`/forums/${activityId}`) });
}

export function useDiscussions(activityId: string, page: number) {
  return useQuery({
    queryKey: forumKeys.discussions(activityId, page),
    queryFn: () => api<Paged<DiscussionSummary>>(`/forums/${activityId}/discussions`, { query: { page, pageSize: 20 } }),
  });
}

export function useDiscussion(activityId: string, discussionId: string) {
  return useQuery({
    queryKey: forumKeys.discussion(activityId, discussionId),
    queryFn: () => api<DiscussionDetail>(`/forums/${activityId}/discussions/${discussionId}`),
  });
}

export function useForumSearch(activityId: string, q: string, page: number) {
  return useQuery({
    queryKey: forumKeys.search(activityId, q, page),
    queryFn: () => api<Paged<SearchHit>>(`/forums/${activityId}/search`, { query: { q, page, pageSize: 20 } }),
    enabled: q.length >= 2,
  });
}
