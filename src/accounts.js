import { db } from "./db.js";

// Permanently removes a person and everything the app holds about them. Used for "delete my account" and for erasure
// requests handled by an admin.
export async function eraseUser(userId) {
  await db.batch(
    [
      { sql: "DELETE FROM companies WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM submissions WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM sessions WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM user_tokens WHERE user_id = ?", args: [userId] },
      // Reviews this person made stay on other students' records, but no longer point at them.
      { sql: "UPDATE submissions SET reviewer_id = NULL WHERE reviewer_id = ?", args: [userId] },
      { sql: "UPDATE companies SET reviewed_by = NULL WHERE reviewed_by = ?", args: [userId] },
      { sql: "DELETE FROM users WHERE id = ?", args: [userId] },
    ],
    "write",
  );
}
