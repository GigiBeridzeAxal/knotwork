import { GITHUB_HOST } from "../../shared/connectors/github";
import type { Step } from "../../shared/schema";
import { type Budget, renderText } from "../../shared/template";
import { clip, type Scope, type StepOptions, type StepResult } from "../steps";
import { callService, field } from "./common";

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,9}$/;
const MAX_TITLE = 256;
const MAX_BODY = 65_536;
const MAX_LABELS = 20;

export async function github(step: Extract<Step, { type: "github" }>, scope: Scope, options: StepOptions, budget: Budget): Promise<StepResult> {
  const { config } = step;
  const repo = renderText(config.repo, scope, budget).trim();
  if (!REPO.test(repo) || repo.includes("/.") || repo.endsWith(".")) {
    return { kind: "fail", message: `"${clip(repo, 120)}" isn't a repository name like owner/name` };
  }
  const token = renderText(config.token, scope, budget).trim();
  if (!token && config.action !== "get_repo") return { kind: "fail", message: "GitHub needs a token to write. Add one in the Token field, ideally from a secret" };
  if (/[\s\r\n]/.test(token)) return { kind: "fail", message: "The GitHub token has spaces or line breaks in it" };

  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (token) headers.authorization = `Bearer ${token}`;
  const base = `https://${GITHUB_HOST}/repos/${repo}`;
  const reason = (body: unknown) => {
    const message = field(body, "message");
    return typeof message === "string" ? message : undefined;
  };

  switch (config.action) {
    case "create_issue": {
      const title = renderText(config.title, scope, budget).trim();
      if (!title) return { kind: "fail", message: "The issue title came out empty" };
      if (title.length > MAX_TITLE) return { kind: "fail", message: `GitHub issue titles can be at most ${MAX_TITLE} characters` };
      const body = renderText(config.body, scope, budget);
      if (body.length > MAX_BODY) return { kind: "fail", message: "The issue body is longer than GitHub allows (65,536 characters)" };
      const labels = renderText(config.labels, scope, budget)
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, MAX_LABELS);
      const answer = await callService("GitHub", new URL(`${base}/issues`), { headers, json: { title, body, labels } }, options, [token], reason);
      if (!answer.ok) return answer.result;
      const number = field(answer.body, "number");
      return {
        kind: "ok",
        output: { number: number ?? null, id: field(answer.body, "id") ?? null, url: field(answer.body, "html_url") ?? null },
        message: `Opened issue #${number} in ${repo}`,
      };
    }
    case "add_comment": {
      const number = renderText(config.number, scope, budget).trim();
      if (!NUMBER.test(number)) return { kind: "fail", message: `"${clip(number, 40)}" isn't an issue or pull request number` };
      const body = renderText(config.body, scope, budget);
      if (!body.trim()) return { kind: "fail", message: "The comment came out empty" };
      if (body.length > MAX_BODY) return { kind: "fail", message: "The comment is longer than GitHub allows (65,536 characters)" };
      const answer = await callService("GitHub", new URL(`${base}/issues/${number}/comments`), { headers, json: { body } }, options, [token], reason);
      if (!answer.ok) return answer.result;
      return {
        kind: "ok",
        output: { id: field(answer.body, "id") ?? null, url: field(answer.body, "html_url") ?? null },
        message: `Commented on #${number} in ${repo}`,
      };
    }
    case "get_repo": {
      const answer = await callService("GitHub", new URL(base), { method: "GET", headers }, options, [token], reason);
      if (!answer.ok) return answer.result;
      const b = answer.body;
      const stars = field(b, "stargazers_count");
      return {
        kind: "ok",
        output: {
          fullName: field(b, "full_name") ?? repo,
          description: field(b, "description") ?? "",
          stars: stars ?? null,
          forks: field(b, "forks_count") ?? null,
          openIssues: field(b, "open_issues_count") ?? null,
          watchers: field(b, "subscribers_count") ?? null,
          defaultBranch: field(b, "default_branch") ?? null,
          url: field(b, "html_url") ?? null,
        },
        message: `Read ${repo}: ${stars} stars`,
      };
    }
  }
}
