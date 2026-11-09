import { EXAMPLES } from "../shared/examples";
import { type Collections, newHookKey, newWorkflowId, type WorkflowDoc } from "./mongo";

/**
 * The demo account: one shared account anyone can enter from the sign-in page with one click. It has
 * no password, so the login form can't reach it, and the daily reset puts its workflows back.
 */
export const DEMO_USER_ID = "usr_demo";
export const DEMO_WORKSPACE_ID = "ws_demo_personal";

export async function ensureDemo(c: Collections, now: number) {
  await c.users.updateOne(
    { _id: DEMO_USER_ID },
    { $setOnInsert: { name: "Demo", email: "demo@knotwork.invalid", password: null, demo: true, createdAt: now } },
    { upsert: true },
  );
  await c.workspaces.updateOne(
    { _id: DEMO_WORKSPACE_ID },
    { $setOnInsert: { ownerId: DEMO_USER_ID, name: "Personal", personal: true, createdAt: now } },
    { upsert: true },
  );
  if ((await c.workflows.countDocuments({ workspaceId: DEMO_WORKSPACE_ID })) === 0) await seed(c, now);
}

async function seed(c: Collections, now: number) {
  const docs: WorkflowDoc[] = EXAMPLES.map((example, i) => ({
    _id: newWorkflowId(),
    workspaceId: DEMO_WORKSPACE_ID,
    ownerId: DEMO_USER_ID,
    ...example.workflow,
    hookKey: newHookKey(),
    version: 1,
    lastScheduledAt: null,
    lastRun: null,
    createdAt: now - i,
    updatedAt: now - i,
  }));
  await c.workflows.insertMany(docs);
}

/** Puts the demo account back to its starting state: one Personal workspace with the examples. */
export async function resetDemo(c: Collections, now: number) {
  const extra = await c.workspaces.find({ ownerId: DEMO_USER_ID, _id: { $ne: DEMO_WORKSPACE_ID } }).toArray();
  const ids = [DEMO_WORKSPACE_ID, ...extra.map((w) => w._id)];
  await c.runs.deleteMany({ workspaceId: { $in: ids } });
  await c.workflows.deleteMany({ workspaceId: { $in: ids } });
  await c.workspaces.deleteMany({ _id: { $in: extra.map((w) => w._id) } });
  await c.workspaces.updateOne({ _id: DEMO_WORKSPACE_ID }, { $set: { name: "Personal" } });
  await c.sessions.updateMany({ userId: DEMO_USER_ID }, { $set: { workspaceIds: [DEMO_WORKSPACE_ID] } });
  await ensureDemo(c, now);
}
