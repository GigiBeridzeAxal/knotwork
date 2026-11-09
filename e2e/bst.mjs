#!/usr/bin/env node
// Browser scenario testers: several actors (accounts), each in its own browser context on its own
// engine (Chromium, Firefox, WebKit), play multi-user scenarios against one app and get a report.
//
//   node bst.mjs run   --config app.config.mjs [--only a,b] [--browsers chromium,firefox] [--rotate 1]
//                      [--matrix] [--fallback] [--retries 2] [--trace] [--headed] [--out runs/<date>-<topic>]
//   node bst.mjs login --config app.config.mjs [--env path/to/accounts.env] [--only alice,bob]
//
// No dependency besides the `playwright` package (not @playwright/test).

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------- load playwright from wherever it is installed ----------
async function loadPlaywright() {
  const tries = [process.cwd() + "/", import.meta.url, "/opt/node-tools/", "/usr/local/lib/node_modules_global/"];
  for (const base of tries) {
    try {
      return createRequire(base.startsWith("file:") ? base : pathToFileURL(base).href)("playwright");
    } catch {}
  }
  for (const p of (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean)) {
    try {
      return createRequire(pathToFileURL(p + "/").href)("playwright");
    } catch {}
  }
  return import("playwright");
}

// ---------- args ----------
const [cmd = "run", ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith("--")) continue;
  const key = rest[i].slice(2);
  const next = rest[i + 1];
  if (next === undefined || next.startsWith("--")) args[key] = true;
  else args[key] = next, i++;
}
if (!args.config) die("Pass --config <file>.mjs");
const configPath = path.resolve(args.config);
const configDir = path.dirname(configPath);
const config = (await import(pathToFileURL(configPath).href)).default;
const pw = await loadPlaywright();

const ENGINES = ["chromium", "firefox", "webkit"];
const list = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);
const today = new Date().toISOString().slice(0, 10);

function die(msg) {
  console.error(msg);
  process.exit(2);
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// ---------- engines: launch what is installed, record what is not ----------
async function launchEngines(wanted) {
  const launched = {};
  const missing = {};
  for (const name of wanted) {
    try {
      const opts = { headless: !args.headed, ...(config.launch?.[name] ?? {}) };
      const browser = await pw[name].launch(opts);
      launched[name] = { browser, version: browser.version() };
    } catch (e) {
      missing[name] = String(e.message).split("\n")[0].slice(0, 200);
    }
  }
  return { launched, missing };
}

// Actors without a fixed browser are spread round-robin over the engines that launched; --rotate N
// shifts that spread so a second pass puts every actor on a different engine.
// With --fallback, an actor pinned to an engine that is not installed runs on the first one that is,
// and the report says so.
function assignBrowsers(actors, engines, rotate = 0) {
  return actors.map((a, i) => {
    if (a.browser && (engines.includes(a.browser) || !args.fallback)) return { ...a, engine: a.browser };
    if (a.browser) return { ...a, engine: engines[0], fallbackFrom: a.browser };
    return { ...a, engine: engines[(i + rotate) % engines.length] };
  });
}

// ---------- env file for credentials ----------
function readEnv(file) {
  const out = {};
  if (!file) return out;
  for (const line of fs.readFileSync(path.resolve(file), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
function resolveCreds(creds = {}, env) {
  const out = {};
  for (const [k, v] of Object.entries(creds)) {
    out[k] = typeof v === "string" && v.startsWith("env:") ? env[v.slice(4)] ?? process.env[v.slice(4)] : v;
  }
  return out;
}

// ---------- actor: one account in one isolated browser context ----------
async function openActor(spec, engines, outDir) {
  const engine = engines[spec.engine];
  if (!engine) return null;
  const device = spec.device ? pw.devices[spec.device] : {};
  if (spec.device && !device) throw new Error(`Unknown Playwright device "${spec.device}"`);
  const statePath = spec.storageState ? path.resolve(configDir, spec.storageState) : null;
  const ctxOpts = {
    baseURL: config.baseURL,
    ...(spec.engine === "firefox" ? { ...device, isMobile: undefined } : device),
    ...(config.contextOptions ?? {}),
    ...(spec.contextOptions ?? {}),
    ...(statePath && fs.existsSync(statePath) ? { storageState: statePath } : {}),
  };
  if (spec.engine === "firefox") delete ctxOpts.isMobile; // Firefox has no mobile emulation
  const context = await engine.browser.newContext(ctxOpts);
  context.setDefaultTimeout(config.timeouts?.action ?? 10000);
  if (args.trace) await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const actor = { ...spec, browserVersion: engine.version, context, page, events: [], currentStep: null };
  const origin = new URL(config.baseURL).origin;
  const note = (kind, text) => actor.events.push({ t: Date.now(), step: actor.currentStep, kind, text: String(text).slice(0, 500) });
  const watch = (p) => {
    p.on("console", (m) => m.type() === "error" && note("console", m.text()));
    p.on("pageerror", (e) => note("pageerror", e.message));
    p.on("requestfailed", (r) => {
      const why = r.failure()?.errorText ?? "";
      if (!/aborted|cancelled|NS_BINDING_ABORTED/i.test(why)) note("requestfailed", `${r.method()} ${r.url()} ${why}`);
    });
    p.on("response", (r) => {
      if (r.status() >= 400 && r.url().startsWith(origin)) note(`http${r.status()}`, `${r.request().method()} ${r.url()}`);
    });
    p.on("dialog", (d) => {
      note("dialog", `${d.type()}: ${d.message()}`);
      if (!actor.handlesDialogs) d.accept().catch(() => {});
    });
  };
  watch(page);
  context.on("page", watch);
  if (config.setupActor) await config.setupActor({ actor, context, page, baseURL: config.baseURL });
  actor.newTab = async () => context.newPage();
  return actor;
}

async function closeActor(actor, outDir, keepTrace) {
  if (!actor) return;
  try {
    if (args.trace) {
      if (keepTrace) await actor.context.tracing.stop({ path: path.join(outDir, "traces", `${slug(actor.traceName)}.zip`) });
      else await actor.context.tracing.stop();
    }
  } catch {}
  await actor.context.close().catch(() => {});
}

// ---------- assertions and helpers handed to scenarios ----------
class CheckError extends Error {}
function check(condition, message, details) {
  if (!condition) {
    const e = new CheckError(message);
    e.details = details;
    throw e;
  }
}
async function eventually(fn, { timeout = 15000, interval = 500, message = "condition never became true" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new CheckError(`${message} (after ${timeout}ms; last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
async function sees(actorOrPage, target, opts = {}) {
  const page = actorOrPage.page ?? actorOrPage;
  const loc = typeof target === "string" ? page.getByText(target, { exact: opts.exact ?? false }).first() : target;
  await loc.waitFor({ state: "visible", timeout: opts.timeout ?? 10000 }).catch(() => {
    throw new CheckError(`expected to see ${typeof target === "string" ? JSON.stringify(target) : String(target)} on ${page.url()}`);
  });
  return loc;
}
async function doesNotSee(actorOrPage, target, opts = {}) {
  const page = actorOrPage.page ?? actorOrPage;
  const loc = typeof target === "string" ? page.getByText(target, { exact: opts.exact ?? false }) : target;
  await page.waitForTimeout(opts.settle ?? 500);
  const n = await loc.count();
  check(n === 0, `expected NOT to see ${typeof target === "string" ? JSON.stringify(target) : String(target)} on ${page.url()}, found ${n}`);
}

// ---------- run one scenario ----------
async function runScenario(scn, specs, engines, outDir, attempt) {
  const result = { name: scn.name, file: scn.file, tags: scn.tags ?? [], attempt, steps: [], actors: [], status: "pass", ms: 0 };
  const started = Date.now();
  const needed = scn.actors ?? specs.map((s) => s.name);
  const actors = {};
  let failed = false;
  try {
    for (const name of needed) {
      const spec = specs.find((s) => s.name === name);
      if (!spec) throw new Error(`Scenario needs actor "${name}", which the config does not define`);
      if (!engines[spec.engine]) {
        result.status = "not-run";
        result.reason = `${name} needs ${spec.engine}, which is not installed here`;
        return result;
      }
      actors[name] = await openActor(spec, engines, outDir);
      actors[name].traceName = `${scn.name}-${name}-${spec.engine}-try${attempt}`;
      result.actors.push({ name, role: spec.role, engine: spec.engine, version: actors[name].browserVersion, device: spec.device, fallbackFrom: spec.fallbackFrom });
    }

    const shoot = async (label) => {
      const shots = [];
      for (const a of Object.values(actors)) {
        const file = path.join("shots", `${slug(scn.name)}-t${attempt}-${slug(label)}-${a.name}-${a.engine}.png`);
        try {
          await a.page.screenshot({ path: path.join(outDir, file), fullPage: false });
          shots.push(file);
        } catch {}
      }
      return shots;
    };

    const step = async (actor, title, fn, { soft = false } = {}) => {
      const rec = { actor: actor?.name ?? "-", engine: actor?.engine ?? "-", title, status: "pass", ms: 0 };
      result.steps.push(rec);
      if (failed && !soft) {
        rec.status = "skipped";
        return;
      }
      const t0 = Date.now();
      if (actor) actor.currentStep = title;
      try {
        const limit = config.timeouts?.step ?? 30000;
        let timer;
        await Promise.race([
          fn(actor ?? {}),
          new Promise((_, rej) => (timer = setTimeout(() => rej(new CheckError(`step timed out after ${limit}ms`)), limit))),
        ]).finally(() => clearTimeout(timer));
      } catch (e) {
        rec.status = "fail";
        rec.error = String(e.message).split("\n").slice(0, 6).join("\n");
        rec.kind = e instanceof CheckError ? "check" : "error";
        rec.url = actor?.page?.url();
        rec.shots = await shoot(title);
        rec.events = Object.values(actors).flatMap((a) => a.events.slice(-8).map((ev) => ({ actor: a.name, ...ev })));
        if (!soft) failed = true;
        result.status = "fail";
      } finally {
        rec.ms = Date.now() - t0;
        if (actor) actor.currentStep = null;
      }
    };

    // Run several actors' steps at the same moment (races, concurrent edits). All of them finish
    // before the scenario moves on, and any failure fails the scenario.
    const together = async (...steps) => {
      await Promise.all(steps.map((s) => (typeof s === "function" ? s() : s)));
    };

    const ctx = {
      actors,
      step,
      together,
      check,
      eventually,
      sees,
      doesNotSee,
      baseURL: config.baseURL,
      runTag: `[BST-${today}-${Math.random().toString(36).slice(2, 6)}]`,
      data: {},
      // A finding that is not a failure (a missing warning, a slow screen, a design question).
      note: (text) => (result.notes ??= []).push(text),
      // Record test data as it is made; call the returned function once it is cleaned up. Whatever is
      // still recorded at the end is listed under "Test data left behind".
      leftBehind: (what) => {
        (result.leftBehind ??= []).push(what);
        return () => (result.leftBehind = result.leftBehind.filter((x) => x !== what));
      },
    };
    const limit = config.timeouts?.scenario ?? 180000;
    let timer;
    await Promise.race([
      scn.run(ctx),
      new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`scenario timed out after ${limit}ms`)), limit))),
    ]).finally(() => clearTimeout(timer));
  } catch (e) {
    result.status = "fail";
    result.steps.push({ actor: "-", engine: "-", title: "scenario code", status: "fail", kind: "error", error: String(e.message).split("\n").slice(0, 6).join("\n") });
  } finally {
    result.warnings = Object.values(actors).flatMap((a) =>
      a.events.filter((ev) => ev.kind !== "dialog" && !(scn.expectedHttp ?? []).some((code) => ev.kind === `http${code}` || (ev.kind === "console" && ev.text.includes(`status of ${code}`)))).map((ev) => ({ actor: a.name, engine: a.engine, ...ev })),
    );
    for (const a of Object.values(actors)) await closeActor(a, outDir, result.status === "fail");
    result.ms = Date.now() - started;
  }
  return result;
}

// ---------- report ----------
function writeReport(outDir, meta, outcomes) {
  const icon = { pass: "PASS", fail: "FAIL", flaky: "FLAKY", "not-run": "NOT RUN" };
  const count = (s) => outcomes.filter((o) => o.verdict === s).length;
  const L = [];
  L.push(`# Scenario test report: ${meta.app}`, "");
  L.push(`- **Date:** ${meta.date}`);
  L.push(`- **Target:** ${meta.baseURL}`);
  L.push(`- **Engines:** ${Object.entries(meta.engines).map(([n, v]) => `${n} ${v}`).join(", ") || "none"}${Object.keys(meta.missing).length ? `; not available: ${Object.keys(meta.missing).join(", ")}` : ""}`);
  L.push(`- **Actors:** ${meta.actors.map((a) => `${a.name}${a.role ? ` (${a.role})` : ""} on ${a.engine}${a.device ? `, ${a.device}` : ""}`).join("; ")}`);
  L.push(`- **Retries for failures:** ${meta.retries}`, "");
  L.push(`**Verdict:** ${count("pass")} of ${outcomes.length} scenarios pass. ${count("fail")} fail, ${count("flaky")} flaky, ${count("not-run")} not run.`, "");
  L.push("| # | Scenario | Actors | Result | Time |", "|---|---|---|---|---|");
  outcomes.forEach((o, i) => {
    const first = o.attempts[0];
    const who = first.actors.map((a) => `${a.name}@${a.engine}${a.fallbackFrom ? ` (for ${a.fallbackFrom})` : ""}`).join(", ") || first.reason || "-";
    L.push(`| ${i + 1} | ${o.name} | ${who} | ${icon[o.verdict]} | ${(first.ms / 1000).toFixed(1)}s |`);
  });
  const fails = outcomes.filter((o) => o.verdict === "fail");
  if (fails.length) {
    L.push("", "## Failures", "", "_Each reproduced on every attempt from fresh contexts. Triage into bugs (with severity) before sharing._");
    fails.forEach((o, i) => {
      const a = o.attempts[0];
      const bad = a.steps.find((s) => s.status === "fail");
      L.push("", `### F${i + 1}. ${o.name}: ${bad?.title ?? "failed"}`);
      L.push(`- **Who:** ${bad?.actor}@${bad?.engine}${bad?.url ? ` at ${bad.url}` : ""}`);
      L.push(`- **Failed with:** ${bad?.kind === "check" ? "check" : "error"}: ${(bad?.error ?? "").replace(/\n/g, " ")}`);
      L.push(`- **Reproduced:** ${o.attempts.filter((t) => t.status === "fail").length} of ${o.attempts.length} attempts`);
      L.push("- **Steps to reproduce:**");
      a.steps.filter((s) => s.status !== "skipped").forEach((s, n) => L.push(`  ${n + 1}. ${s.actor === "-" ? "" : `${s.actor} (${s.engine}): `}${s.title}${s.status === "fail" ? "  <- fails here" : ""}`));
      if (bad?.shots?.length) L.push(`- **Screenshots:** ${bad.shots.map((s) => `[${path.basename(s)}](${s})`).join(", ")}`);
      if (bad?.events?.length) {
        L.push("- **Console and network around the failure:**");
        bad.events.slice(-10).forEach((ev) => L.push(`  - ${ev.actor} ${ev.kind}: ${ev.text}`));
      }
      if (args.trace) L.push(`- **Traces:** \`traces/\` (open with \`npx playwright show-trace <file>\`)`);
    });
  }
  const notes = outcomes.flatMap((o) => (o.attempts.at(-1).notes ?? []).map((n) => `- **${o.name}:** ${n}`));
  if (notes.length) L.push("", "## Findings that are not failures", "", ...notes);
  const flaky = outcomes.filter((o) => o.verdict === "flaky");
  if (flaky.length) {
    L.push("", "## Flaky", "");
    flaky.forEach((o) => {
      const bad = o.attempts.find((t) => t.status === "fail")?.steps.find((s) => s.status === "fail");
      L.push(`- **${o.name}**: failed ${o.attempts.filter((t) => t.status === "fail").length} of ${o.attempts.length} attempts at "${bad?.title}" (${bad?.actor}@${bad?.engine}): ${(bad?.error ?? "").split("\n")[0]}`);
    });
  }
  const warn = outcomes.flatMap((o) => (o.attempts.at(-1).warnings ?? []).map((w) => ({ scenario: o.name, ...w })));
  if (warn.length) {
    L.push("", "## Warnings seen during runs", "", "_Console errors, page errors, failed requests and 4xx/5xx from the app, including in passing scenarios. Not failures by themselves._", "");
    const seen = new Map();
    for (const w of warn) {
      const key = `${w.kind} ${w.text.replace(/[A-Za-z0-9_-]{16,}/g, "<id>")}`;
      const e = seen.get(key) ?? { ...w, n: 0, engines: new Set(), scenarios: new Set() };
      e.n++, e.engines.add(w.engine), e.scenarios.add(w.scenario);
      seen.set(key, e);
    }
    for (const [key, e] of [...seen].slice(0, 40)) L.push(`- ${key} (x${e.n}; ${[...e.engines].join(", ")}; in: ${[...e.scenarios].join(", ")})`);
  }
  const notRun = outcomes.filter((o) => o.verdict === "not-run");
  if (notRun.length || Object.keys(meta.missing).length) {
    L.push("", "## Not run", "");
    for (const [n, why] of Object.entries(meta.missing)) L.push(`- Engine **${n}** could not launch: ${why}`);
    notRun.forEach((o) => L.push(`- ${o.name}: ${o.attempts[0].reason}`));
  }
  const left = [...new Set(outcomes.flatMap((o) => o.attempts.flatMap((t) => t.leftBehind ?? [])))];
  L.push("", "## Test data left behind", "", left.length ? left.map((x) => `- ${x}`).join("\n") : "- None recorded.");
  fs.writeFileSync(path.join(outDir, "REPORT.md"), L.join("\n") + "\n");
}

// ---------- commands ----------
async function cmdRun() {
  const outDir = path.resolve(args.out ?? path.join(configDir, "runs", `${today}-${slug(config.app ?? "app")}`));
  fs.mkdirSync(path.join(outDir, "shots"), { recursive: true });
  if (args.trace) fs.mkdirSync(path.join(outDir, "traces"), { recursive: true });

  const wanted = list(args.browsers) ?? config.browsers ?? ENGINES;
  const { launched, missing } = await launchEngines(wanted);
  const available = wanted.filter((e) => launched[e]);
  if (!available.length) die(`No browser engine could launch: ${JSON.stringify(missing)}`);
  // --matrix runs the suite once per engine rotation, so every actor meets every engine.
  const rotations = args.matrix ? available.map((_, i) => i) : [Number(args.rotate ?? 0)];

  const only = list(args.only);
  const files = (config.scenarios ?? []).filter((f) => !only || only.some((o) => f.includes(o)));
  const retries = Number(args.retries ?? config.retries ?? 2);
  const outcomes = [];
  let specs;
  for (const rot of rotations) {
  specs = assignBrowsers(config.actors, available, rot);
  for (const f of files) {
    const mod = (await import(pathToFileURL(path.resolve(configDir, f)).href)).default;
    const scns = Array.isArray(mod) ? mod : [mod];
    for (const s of scns) {
      const scn = { ...s, name: rotations.length > 1 ? `${s.name} [rotation ${rot + 1}]` : s.name, file: f };
      const attempts = [];
      process.stdout.write(`- ${scn.name} ... `);
      let r = await runScenario(scn, specs, launched, outDir, 1);
      attempts.push(r);
      // A failure only counts if it comes back from a clean start. Retry with fresh contexts.
      for (let i = 2; r.status === "fail" && i <= retries + 1; i++) {
        r = await runScenario(scn, specs, launched, outDir, i);
        attempts.push(r);
        if (r.status === "pass") break;
      }
      const fails = attempts.filter((a) => a.status === "fail").length;
      const verdict = attempts[0].status === "not-run" ? "not-run" : fails === 0 ? "pass" : fails === attempts.length ? "fail" : "flaky";
      console.log(verdict.toUpperCase());
      outcomes.push({ name: scn.name, file: f, verdict, attempts });
    }
  }
  }
  for (const e of Object.values(launched)) await e.browser.close().catch(() => {});

  const meta = {
    app: config.app ?? "app",
    date: today,
    baseURL: config.baseURL,
    engines: Object.fromEntries(Object.entries(launched).map(([n, v]) => [n, v.version])),
    missing,
    actors: rotations.length > 1 ? config.actors.map(({ name, role, device }) => ({ name, role, device, engine: "rotated" })) : specs.map(({ name, role, engine, device }) => ({ name, role, engine, device })),
    retries,
  };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ meta, outcomes }, null, 2));
  writeReport(outDir, meta, outcomes);
  console.log(`\nReport: ${path.join(outDir, "REPORT.md")}`);
  process.exit(outcomes.some((o) => o.verdict === "fail") ? 1 : 0);
}

// Signs each account in once, one at a time, and saves its session to its storageState file.
// The config supplies `login({ page, actor, creds, baseURL })`; credentials come from --env or the
// environment and are never written anywhere else.
async function cmdLogin() {
  if (!config.login) die("This config has no login() function: its actors need no sign-in.");
  const env = readEnv(args.env);
  const only = list(args.only);
  const engineName = args.browser ?? "chromium";
  const browser = await pw[engineName].launch({ headless: !args.headed });
  for (const actor of config.actors.filter((a) => (!only || only.includes(a.name)) && a.storageState)) {
    const context = await browser.newContext({ baseURL: config.baseURL, ...(config.contextOptions ?? {}) });
    const page = await context.newPage();
    try {
      await config.login({ page, actor, creds: resolveCreds(actor.credentials, env), baseURL: config.baseURL });
      const file = path.resolve(configDir, actor.storageState);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await context.storageState({ path: file });
      console.log(`signed in: ${actor.name}`);
    } catch (e) {
      console.log(`FAILED: ${actor.name}: ${String(e.message).split("\n")[0]}`);
    }
    await context.close();
    await new Promise((r) => setTimeout(r, config.loginGapMs ?? 1500)); // parallel logins trip rate limits
  }
  await browser.close();
}

if (cmd === "run") await cmdRun();
else if (cmd === "login") await cmdLogin();
else die(`Unknown command "${cmd}". Use run or login.`);
