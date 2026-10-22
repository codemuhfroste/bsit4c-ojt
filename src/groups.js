// Group detection for the MoA. Students who apply to the same company as a group only need one MoA between them, so when
// two students' final companies have (nearly) the same name they are treated as groupmates, and a MoA submitted by one
// counts for the others ("Submitted by groupmate").
import { db } from "./db.js";
import { similarCompany } from "./company-names.js";

const isMoa = (title) => /^memorandum of agreement/i.test(title);

// Who is covered by a groupmate's MoA right now. Returns { moaId, byUser } where byUser maps a student's id to
// { status, name, updatedAt } of the groupmate's submission. A student's own submission always wins, and a groupmate
// only counts once they have submitted (or been approved), and only through their final company: the one they chose
// among those that accepted them, or the only one that accepted them.
export async function moaViaGroup() {
  const { rows: reqs } = await db.execute("SELECT id, title FROM requirements");
  const moa = reqs.find((r) => isMoa(r.title));
  if (!moa) return { moaId: null, byUser: new Map() };

  const { rows: subs } = await db.execute({
    sql: `SELECT s.user_id, s.status, s.updated_at, u.full_name, u.email
          FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.requirement_id = ?`,
    args: [moa.id],
  });
  const own = new Map(subs.map((s) => [Number(s.user_id), s]));

  const { rows: accepted } = await db.execute(
    "SELECT user_id, name, is_final FROM companies WHERE response = 'accepted' ORDER BY id",
  );
  const finals = new Map();
  const perUser = new Map();
  for (const c of accepted) perUser.set(Number(c.user_id), [...(perUser.get(Number(c.user_id)) ?? []), c]);
  for (const [userId, list] of perUser) {
    const final = list.find((c) => c.is_final) ?? (list.length === 1 ? list[0] : null);
    if (final) finals.set(userId, final.name);
  }

  const byUser = new Map();
  for (const [userId, name] of finals) {
    if (own.has(userId)) continue;
    let best = null;
    for (const [otherId, otherName] of finals) {
      const theirs = own.get(otherId);
      if (otherId === userId || !theirs || !["submitted", "approved"].includes(theirs.status)) continue;
      if (!similarCompany(name, otherName)) continue;
      if (!best || (theirs.status === "approved" && best.status !== "approved")) {
        best = { status: theirs.status, name: theirs.full_name || theirs.email, updatedAt: theirs.updated_at };
      }
    }
    if (best) byUser.set(userId, best);
  }
  return { moaId: Number(moa.id), byUser };
}

// The shape of a submission that comes from a groupmate (it has no id of its own and cannot be reviewed).
export const groupSubmission = (via, { withName = false } = {}) => ({
  id: null,
  status: via.status,
  note: "",
  fileName: null,
  updatedAt: via.updatedAt,
  viaGroup: true,
  ...(withName ? { groupmate: via.name } : {}),
});
