import { afterEach, describe, expect, it, vi } from "vitest";
import { type LeafStep, workflowInput } from "../shared/schema";
import { newStep } from "../shared/examples";
import { DEMO_HOSTS, executeStep, type Scope } from "../worker/steps";

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX";
const DISCORD = "https://discord.com/api/webhooks/123456/abcdefSECRETabcdef";
const TOKEN = "123456789:AAH-abcdefghijklmnopqrstuvwxyz012345";

const scope: Scope = {
  trigger: { body: { action: "created", sender: { login: "ada" }, repository: { full_name: "o/r", stargazers_count: 7 }, n: 12 } },
  steps: {},
  run: { id: "run_1", startedAt: "" },
  workflow: { id: "wf_1", name: "Test" },
  secrets: { SLACK_WEBHOOK: SLACK, DISCORD_WEBHOOK: DISCORD, TELEGRAM_BOT_TOKEN: TOKEN, GITHUB_TOKEN: "github_pat_secretvalue123" },
};

function parse(step: unknown): LeafStep {
  return workflowInput.parse({ name: "x", trigger: { type: "manual" }, steps: [step] }).steps[0] as LeafStep;
}

type Call = { url: string; init: RequestInit };
function mockFetch(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return answer(call);
  });
  return calls;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const sentBody = (call: Call) => JSON.parse(String(call.init.body));
const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);

afterEach(() => vi.unstubAllGlobals());

describe("new steps", () => {
  it("every ready-made step's starting settings pass validation", () => {
    for (const type of ["slack", "discord", "telegram", "github"] as const) {
      expect(() => parse(newStep(type, []))).not.toThrow();
    }
  });
});

describe("slack", () => {
  it("posts the rendered text to the webhook from a secret", async () => {
    const calls = mockFetch(() => new Response("ok", { status: 200 }));
    const step = parse({ id: "s", name: "S", type: "slack", config: { webhookUrl: "{{ secrets.SLACK_WEBHOOK }}", text: "{{ trigger.body.sender.login }} starred" } });
    const result = await executeStep(step, scope);
    expect(result.kind).toBe("ok");
    expect(calls[0].url).toBe(SLACK);
    expect(calls[0].init.method).toBe("POST");
    expect(sentBody(calls[0])).toEqual({ text: "ada starred" });
    expect(JSON.stringify(result)).not.toContain("XXXXXXXX");
  });

  it("refuses a webhook URL on another host and never echoes it", async () => {
    const calls = mockFetch(() => new Response("ok"));
    const step = parse({ id: "s", name: "S", type: "slack", config: { webhookUrl: "https://evil.example/services/SECRETPATH", text: "hi" } });
    const result = await executeStep(step, scope);
    expect(result.kind).toBe("fail");
    expect(JSON.stringify(result)).not.toContain("SECRETPATH");
    expect(calls).toHaveLength(0);
  });

  it("reports what Slack said on failure", async () => {
    mockFetch(() => new Response("invalid_token", { status: 403 }));
    const step = parse({ id: "s", name: "S", type: "slack", config: { webhookUrl: SLACK, text: "hi" } });
    const result = await executeStep(step, scope);
    expect(result).toMatchObject({ kind: "fail", message: "Slack answered 403: invalid_token" });
  });

  it("turns @channel, @here and group pings from trigger data into plain text, unless allowed", async () => {
    const calls = mockFetch(() => new Response("ok"));
    const evil = { ...scope, trigger: { body: { title: "<!channel> hi <!here|here> <!subteam^S1|@team>" } } };
    await executeStep(parse({ id: "s", name: "S", type: "slack", config: { webhookUrl: SLACK, text: "New: {{ trigger.body.title }}" } }), evil);
    expect(sentBody(calls[0]).text).toBe("New: @channel hi @here @group");
    await executeStep(parse({ id: "s", name: "S", type: "slack", config: { webhookUrl: SLACK, text: "{{ trigger.body.title }}", mentions: true } }), evil);
    expect(sentBody(calls[1]).text).toContain("<!channel>");
  });

  it("quiets each string in blocks on its own, so a mention split across fields can't merge them", async () => {
    const calls = mockFetch(() => new Response("ok"));
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "x <!channel|" } }, { type: "section", text: { type: "mrkdwn", text: "y> <!here>" } }];
    await executeStep(parse({ id: "s", name: "S", type: "slack", config: { webhookUrl: SLACK, text: "hi", blocks } }), scope);
    const sent = sentBody(calls[0]).blocks;
    expect(sent).toHaveLength(2);
    expect(sent[1].text.text).toBe("y> @here");
  });

  it("names the secret to check when a credential renders empty", async () => {
    const calls = mockFetch(() => new Response("ok"));
    const noSecrets = { ...scope, secrets: {} };
    const result = await executeStep(parse({ id: "s", name: "S", type: "slack", config: { webhookUrl: "{{ secrets.SLACK_HOOK }}", text: "hi" } }), noSecrets);
    expect(result).toMatchObject({ kind: "fail", message: "The Slack webhook URL is empty. Check that the secret SLACK_HOOK exists in this workspace" });
    const tg = await executeStep(parse({ id: "t", name: "T", type: "telegram", config: { botToken: "{{ secrets.TG }}", chatId: "1", text: "hi" } }), noSecrets);
    expect(tg).toMatchObject({ kind: "fail", message: "The Telegram bot token is empty. Check that the secret TG exists in this workspace" });
    expect(calls).toHaveLength(0);
  });

  it("is blocked for the demo account", async () => {
    const calls = mockFetch(() => new Response("ok"));
    const step = parse({ id: "s", name: "S", type: "slack", config: { webhookUrl: SLACK, text: "hi" } });
    const result = await executeStep(step, scope, { allowHosts: DEMO_HOSTS });
    expect(result.kind).toBe("fail");
    expect(calls).toHaveLength(0);
  });
});

describe("discord", () => {
  it("posts with wait=true, no mass pings, and returns the message id", async () => {
    const calls = mockFetch(() => json({ id: "m1", channel_id: "c1" }));
    const step = parse({ id: "d", name: "D", type: "discord", config: { webhookUrl: "{{ secrets.DISCORD_WEBHOOK }}", content: "@everyone {{ trigger.body.repository.full_name }}", username: "Knotwork" } });
    const result = await executeStep(step, scope);
    expect(result).toMatchObject({ kind: "ok", output: { messageId: "m1", channelId: "c1" } });
    expect(new URL(calls[0].url).searchParams.get("wait")).toBe("true");
    expect(sentBody(calls[0])).toEqual({ content: "@everyone o/r", username: "Knotwork", allowed_mentions: { parse: ["users"] } });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("only accepts discord.com webhook paths", async () => {
    mockFetch(() => json({}));
    for (const webhookUrl of ["https://discord.com/channels/1/2", "http://discord.com/api/webhooks/1/x", "https://discord.com.evil.io/api/webhooks/1/x"]) {
      const result = await executeStep(parse({ id: "d", name: "D", type: "discord", config: { webhookUrl, content: "hi" } }), scope);
      expect(result.kind).toBe("fail");
    }
  });

  it("fails on messages over 2,000 characters before sending", async () => {
    const calls = mockFetch(() => json({}));
    const result = await executeStep(parse({ id: "d", name: "D", type: "discord", config: { webhookUrl: DISCORD, content: "x".repeat(2_001) } }), scope);
    expect(result.kind).toBe("fail");
    expect(calls).toHaveLength(0);
  });

  it("does not follow redirects, so the webhook can't be bounced elsewhere", async () => {
    mockFetch(() => new Response(null, { status: 302, headers: { location: "https://example.com/" } }));
    const result = await executeStep(parse({ id: "d", name: "D", type: "discord", config: { webhookUrl: DISCORD, content: "hi" } }), scope);
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") expect(result.message).toMatch(/redirect/);
  });

  it("names the wait Discord asks for on 429", async () => {
    mockFetch(() => json({ message: "You are being rate limited." }, 429, { "retry-after": "3" }));
    const result = await executeStep(parse({ id: "d", name: "D", type: "discord", config: { webhookUrl: DISCORD, content: "hi" } }), scope);
    expect(result).toMatchObject({ kind: "fail", message: "Discord answered 429: You are being rate limited. (asked to wait 3s)" });
  });
});

describe("telegram", () => {
  it("sends to the bot API and keeps the token out of the result", async () => {
    const calls = mockFetch(() => json({ ok: true, result: { message_id: 5, chat: { id: -100 } } }));
    const step = parse({ id: "t", name: "T", type: "telegram", config: { botToken: "{{ secrets.TELEGRAM_BOT_TOKEN }}", chatId: "-100", text: "n={{ trigger.body.n }}", parseMode: "HTML", silent: true } });
    const result = await executeStep(step, scope);
    expect(result).toMatchObject({ kind: "ok", output: { messageId: 5, chatId: -100 } });
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(sentBody(calls[0])).toEqual({ chat_id: "-100", text: "n=12", parse_mode: "HTML", disable_notification: true });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("rejects something that isn't a bot token without echoing it", async () => {
    const calls = mockFetch(() => json({ ok: true }));
    const result = await executeStep(parse({ id: "t", name: "T", type: "telegram", config: { botToken: "notatoken/../x", chatId: "1", text: "hi" } }), scope);
    expect(result.kind).toBe("fail");
    expect(JSON.stringify(result)).not.toContain("notatoken");
    expect(calls).toHaveLength(0);
  });

  it("hides the token even if an error repeats it", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error(`connect failed for /bot${TOKEN}/sendMessage`);
    });
    const result = await executeStep(parse({ id: "t", name: "T", type: "telegram", config: { botToken: TOKEN, chatId: "@my_channel", text: "hi" } }), scope);
    expect(result.kind).toBe("fail");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("shows Telegram's description on failure", async () => {
    mockFetch(() => json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400));
    const result = await executeStep(parse({ id: "t", name: "T", type: "telegram", config: { botToken: TOKEN, chatId: "42", text: "hi" } }), scope);
    expect(result).toMatchObject({ kind: "fail", message: "Telegram answered 400: Bad Request: chat not found" });
  });
});

describe("github", () => {
  it("opens an issue with labels and the token as a bearer header", async () => {
    const calls = mockFetch(() => json({ number: 9, id: 99, html_url: "https://github.com/o/r/issues/9" }, 201));
    const step = parse({
      id: "g",
      name: "G",
      type: "github",
      config: { action: "create_issue", token: "{{ secrets.GITHUB_TOKEN }}", repo: "{{ trigger.body.repository.full_name }}", title: "Star from {{ trigger.body.sender.login }}", labels: "a, b,," },
    });
    const result = await executeStep(step, scope);
    expect(result).toMatchObject({ kind: "ok", output: { number: 9, url: "https://github.com/o/r/issues/9" } });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues");
    expect(header(calls[0], "authorization")).toBe("Bearer github_pat_secretvalue123");
    expect(sentBody(calls[0])).toEqual({ title: "Star from ada", body: "", labels: ["a", "b"] });
  });

  it("comments on an issue", async () => {
    const calls = mockFetch(() => json({ id: 1, html_url: "u" }, 201));
    const step = parse({ id: "g", name: "G", type: "github", config: { action: "add_comment", token: "t0ken12345", repo: "o/r", number: "{{ trigger.body.n }}", body: "hi" } });
    expect((await executeStep(step, scope)).kind).toBe("ok");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/12/comments");
  });

  it("reads a public repo without a token, and is allowed for the demo", async () => {
    const calls = mockFetch(() => json({ full_name: "o/r", stargazers_count: 3, forks_count: 1 }));
    const step = parse({ id: "g", name: "G", type: "github", config: { action: "get_repo", repo: "o/r" } });
    const result = await executeStep(step, scope, { allowHosts: DEMO_HOSTS });
    expect(result).toMatchObject({ kind: "ok", output: { fullName: "o/r", stars: 3, forks: 1 } });
    expect(calls[0].init.method).toBe("GET");
    expect(header(calls[0], "authorization")).toBeNull();
  });

  it("rejects repo names that would change the API path", async () => {
    const calls = mockFetch(() => json({}));
    for (const repo of ["o/r/../../user", "o", "o/r?x=1", "../r", "o/..", "o/."]) {
      const result = await executeStep(parse({ id: "g", name: "G", type: "github", config: { action: "get_repo", repo } }), scope);
      expect(result.kind).toBe("fail");
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts repository names that start with a dot", async () => {
    const calls = mockFetch(() => json({ full_name: "o/.github", stargazers_count: 1 }));
    const result = await executeStep(parse({ id: "g", name: "G", type: "github", config: { action: "get_repo", repo: "o/.github" } }), scope);
    expect(result.kind).toBe("ok");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/.github");
  });

  it("needs a token to write, and hides it in errors", async () => {
    mockFetch(() => json({ message: "Bad credentials" }, 401));
    const noToken = await executeStep(parse({ id: "g", name: "G", type: "github", config: { action: "create_issue", repo: "o/r", title: "x" } }), scope);
    expect(noToken.kind).toBe("fail");
    const bad = await executeStep(parse({ id: "g", name: "G", type: "github", config: { action: "create_issue", token: "github_pat_secretvalue123", repo: "o/r", title: "x" } }), scope);
    expect(bad).toMatchObject({ kind: "fail", message: "GitHub answered 401: Bad credentials" });
  });
});
