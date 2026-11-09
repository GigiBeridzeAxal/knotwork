import { z } from "zod";

/**
 * GitHub: open an issue, comment on an issue or pull request, or read a repository. Writing needs a
 * token (a fine-grained personal access token with Issues: read and write), kept in a workspace
 * secret: `{{ secrets.GITHUB_TOKEN }}`. Reading a public repository works without one.
 */
export const GITHUB_HOST = "api.github.com";
export const githubActions = ["create_issue", "add_comment", "get_repo"] as const;
export type GithubAction = (typeof githubActions)[number];

export const githubConfig = z.object({
  action: z.enum(githubActions).default("create_issue"),
  /** Empty is allowed only for get_repo on a public repository. */
  token: z.string().trim().max(500).default(""),
  /** owner/name, templates allowed: `{{ trigger.body.repository.full_name }}`. */
  repo: z.string().trim().min(1, "Enter the repository as owner/name").max(300),
  title: z.string().max(1_000).default(""),
  body: z.string().max(8_000).default(""),
  /** For add_comment: the issue or pull request number. */
  number: z.string().trim().max(200).default(""),
  /** For create_issue: comma-separated label names. */
  labels: z.string().max(500).default(""),
});

export type GithubConfig = z.infer<typeof githubConfig>;
