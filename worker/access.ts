import { LIMITS } from "../shared/limits";
import type { ApiKey, ApiKeyAccess, Invite, Member, MemberRole, NewApiKey, NewInvite, Role, Team, Workspace } from "../shared/schema";
import { API_KEY_PREFIX_CHARS, newApiKey, sha256url } from "./auth";
import { toWorkspace } from "./db";
import { type ApiKeyDoc, type Collections, type InviteDoc, memberId, randomId, type WorkspaceDoc } from "./mongo";

/**
 * Who may do what in a workspace.
 *
 * A workspace has one owner (`workspaces.ownerId`), for good. Other accounts join with an invite
 * link and get a row in `members` with a role: editors change workflows and start runs, viewers only
 * read. Runs, limits and storage are always charged to the owner, whoever started the run.
 *
 * Membership is read from the database on every request (one lookup by id), never from the session,
 * so removing someone or changing their role takes effect on their very next request.
 */

const DAY = 86_400_000;

export interface Access {
  role: Role;
  /** The workspace's owner: the account its workflows and runs are charged to. */
  ownerId: string;
}

/** The user's role in a workspace, or null when they have nothing to do with it. */
export async function accessTo(c: Collections, workspaceId: string, userId: string): Promise<Access | null> {
  const [owned, member] = await Promise.all([
    c.workspaces.findOne({ _id: workspaceId, ownerId: userId }, { projection: { _id: 1 } }),
    c.members.findOne({ _id: memberId(workspaceId, userId) }),
  ]);
  if (owned) return { role: "owner", ownerId: userId };
  // The row's own workspace id is compared too, so an id with a colon in it can't match another row.
  if (member && member.workspaceId === workspaceId && member.userId === userId) return { role: member.role, ownerId: member.ownerId };
  return null;
}

/** The user's own workspaces (Personal first), then the ones they joined, oldest first. */
export async function listWorkspacesFor(c: Collections, userId: string): Promise<Workspace[]> {
  const [own, memberships] = await Promise.all([
    c.workspaces.find({ ownerId: userId }).sort({ personal: -1, createdAt: 1 }).toArray(),
    c.members.find({ userId }).sort({ createdAt: 1 }).limit(LIMITS.joinedWorkspacesPerAccount).toArray(),
  ]);
  const joined = memberships.length ? await c.workspaces.find({ _id: { $in: memberships.map((m) => m.workspaceId) } }).toArray() : [];
  const byId = new Map(joined.map((w) => [w._id, w]));
  return [
    ...own.map((w) => toWorkspace(w, "owner")),
    ...memberships.flatMap((m) => {
      const ws = byId.get(m.workspaceId);
      // A shared workspace is never shown as personal to the people who joined it.
      return ws ? [{ ...toWorkspace(ws, m.role), personal: false }] : [];
    }),
  ];
}

/** Ids of the workspaces the user joined (not the ones they own). */
export async function joinedWorkspaceIds(c: Collections, userId: string): Promise<string[]> {
  const rows = await c.members.find({ userId }, { projection: { workspaceId: 1 } }).limit(LIMITS.joinedWorkspacesPerAccount).toArray();
  return rows.map((m) => m.workspaceId);
}

const toInvite = (doc: InviteDoc): Invite => ({
  id: doc._id,
  role: doc.role,
  createdAt: doc.createdAt,
  expiresAt: doc.expiresAt.getTime(),
  uses: doc.uses,
  maxUses: doc.maxUses,
});

/**
 * A workspace's links that can still let someone in. A link is deleted when its last place is taken
 * (see `acceptInvite`), so every link that hasn't expired is open, and the count can't be fooled
 * by a pile of used-up ones.
 */
const openFilter = (workspaceId: string, now: number) => ({ workspaceId, expiresAt: { $gt: new Date(now) } });

/** The people in a workspace, owner first. Open invite links are only given to the owner. */
export async function team(c: Collections, workspace: WorkspaceDoc, viewerId: string, now: number): Promise<Team> {
  const isOwner = workspace.ownerId === viewerId;
  const [members, invites] = await Promise.all([
    c.members.find({ workspaceId: workspace._id }).sort({ createdAt: 1 }).limit(LIMITS.membersPerWorkspace).toArray(),
    isOwner ? c.invites.find(openFilter(workspace._id, now)).sort({ createdAt: 1 }).limit(LIMITS.invitesPerWorkspace).toArray() : [],
  ]);
  // Names only: members never see each other's email addresses.
  const users = await c.users
    .find({ _id: { $in: [workspace.ownerId, ...members.map((m) => m.userId)] } }, { projection: { name: 1 } })
    .toArray();
  const name = new Map(users.map((u) => [u._id, u.name]));
  const row = (userId: string, role: Role, joinedAt: number): Member => ({
    userId,
    name: name.get(userId) ?? "Deleted account",
    role,
    joinedAt,
    you: userId === viewerId,
  });
  return {
    members: [row(workspace.ownerId, "owner", workspace.createdAt), ...members.map((m) => row(m.userId, m.role, m.createdAt))],
    invites: invites.map(toInvite),
  };
}

/**
 * Makes an invite link for a role. Only the SHA-256 of its token is stored, so the link can be shown
 * once and a copy of the database holds no working links. Inserted, then counted, so two requests at
 * once can't both squeeze under the limit.
 */
export async function createInvite(c: Collections, workspace: WorkspaceDoc, role: MemberRole, now: number): Promise<NewInvite | "full"> {
  const token = randomId(32);
  const doc: InviteDoc = {
    _id: await sha256url(token),
    workspaceId: workspace._id,
    ownerId: workspace.ownerId,
    role,
    uses: 0,
    maxUses: LIMITS.inviteUses,
    joined: [],
    createdAt: now,
    expiresAt: new Date(now + LIMITS.inviteDays * DAY),
  };
  await c.invites.insertOne(doc);
  if ((await c.invites.countDocuments(openFilter(workspace._id, now))) > LIMITS.invitesPerWorkspace) {
    await c.invites.deleteOne({ _id: doc._id });
    return "full";
  }
  return { ...toInvite(doc), token };
}

export type InviteLookup =
  | { ok: true; invite: InviteDoc; workspace: WorkspaceDoc }
  /** No such link, it was revoked, it expired, or its workspace is gone. */
  | { ok: false; reason: "gone" }
  /** Everyone it could let in has joined. */
  | { ok: false; reason: "used" };

export async function findInvite(c: Collections, token: string, now: number): Promise<InviteLookup> {
  const invite = await c.invites.findOne({ _id: await sha256url(token) });
  if (!invite || invite.expiresAt.getTime() <= now) return { ok: false, reason: "gone" };
  const workspace = await c.workspaces.findOne({ _id: invite.workspaceId, ownerId: invite.ownerId });
  if (!workspace || workspace.personal) return { ok: false, reason: "gone" };
  if (invite.uses >= invite.maxUses) return { ok: false, reason: "used" };
  return { ok: true, invite, workspace };
}

export type JoinResult =
  | { ok: true; workspaceId: string; already: boolean }
  /** "spent": this account already joined with this link once, and a link lets each account in once. */
  | { ok: false; reason: "gone" | "used" | "spent" | "full" | "too-many" };

/**
 * Joins the invite's workspace with the invite's role.
 *
 * A link lets each account in once. Otherwise someone the owner removed, or made a viewer, could
 * leave and walk back in through the link they first joined with, and get their old role back.
 * After a removal they need a new link from the owner.
 *
 * One place on the link is claimed with a single atomic update (which also records the account), so
 * a link for ten people lets in ten even when twenty click at once. The member row is then inserted
 * and the workspace counted; if it went over the limit, or the link or workspace was removed
 * meanwhile, the row is taken out again. Someone who already belongs keeps the role they have: a
 * link never changes an existing role.
 */
export async function acceptInvite(c: Collections, token: string, userId: string, now: number): Promise<JoinResult> {
  const found = await findInvite(c, token, now);
  if (!found.ok) return found;
  const { invite, workspace } = found;
  const id = memberId(workspace._id, userId);
  const isMember = async () => (await c.members.findOne({ _id: id }, { projection: { _id: 1 } })) !== null;
  if (workspace.ownerId === userId) return { ok: true, workspaceId: workspace._id, already: true };
  if (await isMember()) {
    // A member who opens another link holds it too: it's noted (without taking a place), so it ends
    // with the others if they are removed or made a viewer.
    await c.invites.updateOne({ _id: invite._id }, { $addToSet: { joined: userId } });
    return { ok: true, workspaceId: workspace._id, already: true };
  }
  if (invite.joined.includes(userId)) return { ok: false, reason: "spent" };
  if ((await c.members.countDocuments({ userId }, { limit: LIMITS.joinedWorkspacesPerAccount })) >= LIMITS.joinedWorkspacesPerAccount) {
    return { ok: false, reason: "too-many" };
  }
  const claimed = await c.invites.updateOne(
    { _id: invite._id, expiresAt: { $gt: new Date(now) }, uses: { $lt: invite.maxUses }, joined: { $ne: userId } },
    { $inc: { uses: 1 }, $addToSet: { joined: userId } },
  );
  if (claimed.modifiedCount === 0) {
    // Lost a race: with this account's own second click (which is joining), or for the last place.
    return (await isMember()) ? { ok: true, workspaceId: workspace._id, already: true } : { ok: false, reason: "used" };
  }
  /** For a join that didn't happen: the place and this account's one use go back. */
  const unclaim = () => c.invites.updateOne({ _id: invite._id, joined: userId }, { $inc: { uses: -1 }, $pull: { joined: userId } });
  try {
    await c.members.insertOne({ _id: id, workspaceId: workspace._id, userId, ownerId: workspace.ownerId, role: invite.role, createdAt: now });
  } catch (err) {
    await unclaim();
    throw err;
  }
  const [count, mine, stillInvited, stillThere] = await Promise.all([
    c.members.countDocuments({ workspaceId: workspace._id }),
    c.members.countDocuments({ userId }, { limit: LIMITS.joinedWorkspacesPerAccount + 1 }),
    c.invites.findOne({ _id: invite._id }, { projection: { _id: 1 } }),
    c.workspaces.findOne({ _id: workspace._id }, { projection: { _id: 1 } }),
  ]);
  // Counted again after the insert, so two joins at once can't slip past either limit.
  const over = count > LIMITS.membersPerWorkspace ? "full" : mine > LIMITS.joinedWorkspacesPerAccount ? "too-many" : null;
  if (over || !stillInvited || !stillThere) {
    await c.members.deleteOne({ _id: id });
    await unclaim();
    return { ok: false, reason: stillInvited && stillThere ? over! : "gone" };
  }
  // The last place was taken: the link is done, so it goes (and stops counting as an open link).
  await c.invites.deleteOne({ _id: invite._id, uses: { $gte: invite.maxUses } });
  return { ok: true, workspaceId: workspace._id, already: false };
}

/**
 * Ends the invite links an account joined a workspace with. Called when that person is removed,
 * leaves or is made a viewer: the link they hold would otherwise let them back in, with its role,
 * from a second account. Other people who got the same link and haven't used it need a new one.
 */
export const endLinksOf = (c: Collections, workspaceId: string, userId: string) => c.invites.deleteMany({ workspaceId, joined: userId });

/**
 * Takes someone out of a workspace, with the API keys they made for it and the invite links they
 * joined with. False when they weren't in it.
 */
export async function removeMember(c: Collections, workspaceId: string, userId: string): Promise<boolean> {
  // The membership goes first: from then on their session and their keys are refused.
  const res = await c.members.deleteOne({ _id: memberId(workspaceId, userId), workspaceId, userId });
  if (res.deletedCount === 0) return false;
  await Promise.all([c.apiKeys.deleteMany({ workspaceId, userId }), endLinksOf(c, workspaceId, userId)]);
  return true;
}

/** For a deleted account: its keys and memberships, and the members, links and keys of its workspaces. */
export async function deleteAccountAccess(c: Collections, userId: string) {
  await Promise.all([
    c.apiKeys.deleteMany({ $or: [{ userId }, { ownerId: userId }] }),
    c.members.deleteMany({ $or: [{ userId }, { ownerId: userId }] }),
    c.invites.deleteMany({ ownerId: userId }),
  ]);
}

// ---------- API keys ----------

export const toApiKey = (doc: ApiKeyDoc): ApiKey => ({
  id: doc._id,
  name: doc.name,
  workspaceId: doc.workspaceId,
  access: doc.access,
  prefix: doc.prefix,
  createdAt: doc.createdAt,
  lastUsedAt: doc.lastUsedAt,
});

export async function listApiKeys(c: Collections, userId: string): Promise<ApiKey[]> {
  const docs = await c.apiKeys.find({ userId }).sort({ createdAt: 1 }).limit(LIMITS.apiKeysPerAccount).toArray();
  return docs.map(toApiKey);
}

/**
 * Makes a key for one workspace. Only its SHA-256 is stored (the key is 24 random bytes, so a fast
 * hash is enough), plus its first characters to tell keys apart in the list.
 */
export async function createApiKey(
  c: Collections,
  userId: string,
  workspaceId: string,
  ownerId: string,
  input: { name: string; access: ApiKeyAccess },
  now: number,
  pepper: string,
): Promise<NewApiKey | "full"> {
  const key = await newApiKey(pepper);
  const doc: ApiKeyDoc = {
    _id: await sha256url(key),
    userId,
    workspaceId,
    ownerId,
    name: input.name,
    access: input.access,
    prefix: key.slice(0, API_KEY_PREFIX_CHARS),
    createdAt: now,
    lastUsedAt: null,
  };
  await c.apiKeys.insertOne(doc);
  if ((await c.apiKeys.countDocuments({ userId })) > LIMITS.apiKeysPerAccount) {
    await c.apiKeys.deleteOne({ _id: doc._id });
    return "full";
  }
  return { ...toApiKey(doc), key };
}

const HOUR = 3_600_000;

/** Notes that a key was used, at most once an hour per key, so busy scripts don't write on every call. */
export async function touchApiKey(c: Collections, doc: ApiKeyDoc, now: number) {
  if (doc.lastUsedAt !== null && now - doc.lastUsedAt < HOUR) return;
  await c.apiKeys.updateOne({ _id: doc._id }, { $set: { lastUsedAt: now } });
}
