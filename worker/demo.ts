import { EXAMPLES } from "../shared/examples";
import { newHookKey } from "./auth";
import type { Collections } from "./mongo";

/**
 * The demo account: one shared account anyone can enter from the sign-in page with one click. It has
 * no password, so the login form can't reach it, and the daily reset puts its workflows back.
 */
export const DEMO_USER_ID = "usr_demo";
export const DEMO_WORKSPACE_ID = "ws_demo_personal";

/**
 * Two first visitors can both try to insert; the loser's upsert fails on the duplicate id, and the
 * document it wanted is there, so that error is ignored.
 */
const once = (p: Promise<unknown>) =>
  p.catch((err) => {
    if ((err as { code?: number }).code !== 11000) throw err;
  });

export async function ensureDemo(c: Collections, now: number, pepper: string) {
  await once(
    c.users.updateOne(
      { _id: DEMO_USER_ID },
      {
        $setOnInsert: {
          name: "Demo",
          email: "demo@knotwork.invalid",
          password: null,
          demo: true,
          createdAt: now,
        },
      },
      { upsert: true },
    ),
  );
  await once(
    c.workspaces.updateOne(
      { _id: DEMO_WORKSPACE_ID },
      {
        $setOnInsert: {
          ownerId: DEMO_USER_ID,
          name: "Personal",
          personal: true,
          createdAt: now,
        },
      },
      { upsert: true },
    ),
  );
  if ((await c.workflows.countDocuments({ workspaceId: DEMO_WORKSPACE_ID })) === 0) await seed(c, now, pepper);
}

/**
 * Puts the examples in. Each has a fixed id and is upserted, so two people opening the empty demo at
 * the same moment still end up with one copy of each.
 */
async function seed(c: Collections, now: number, pepper: string) {
  const keys = await Promise.all(EXAMPLES.map(() => newHookKey(pepper)));
  await Promise.all(
    EXAMPLES.map((example, i) =>
      once(
        c.workflows.updateOne(
          { _id: `wf_demo_${i + 1}` },
          {
            $setOnInsert: {
              workspaceId: DEMO_WORKSPACE_ID,
              ownerId: DEMO_USER_ID,
              ...example.workflow,
              hookKey: keys[i],
              version: 1,
              lastScheduledAt: null,
              lastRun: null,
              createdAt: now - i,
              updatedAt: now - i,
            },
          },
          { upsert: true },
        ),
      ),
    ),
  );
}

/** Puts the demo account back to its starting state: one Personal workspace with the examples. */
export async function resetDemo(c: Collections, now: number, pepper: string) {
  const extra = await c.workspaces.find({ ownerId: DEMO_USER_ID, _id: { $ne: DEMO_WORKSPACE_ID } }).toArray();
  const ids = [DEMO_WORKSPACE_ID, ...extra.map((w) => w._id)];
  await c.runs.deleteMany({ workspaceId: { $in: ids } });
  await c.versions.deleteMany({ workspaceId: { $in: ids } });
  await c.workflows.deleteMany({ workspaceId: { $in: ids } });
  await c.secrets.deleteMany({ workspaceId: { $in: ids } });
  await c.workspaces.deleteMany({ _id: { $in: extra.map((w) => w._id) } });
  await c.workspaces.updateOne({ _id: DEMO_WORKSPACE_ID }, { $set: { name: "Personal" } });
  await c.sessions.updateMany({ userId: DEMO_USER_ID }, { $set: { workspaceIds: [DEMO_WORKSPACE_ID] } });
  await ensureDemo(c, now, pepper);
}
