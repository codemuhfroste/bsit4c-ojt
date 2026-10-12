import nodemailer from "nodemailer";

// With SMTP_URL set, mail is sent for real. Without it (local dev / tests), messages are
// logged to the console and kept in `outbox` so the links can be followed by hand.
export const outbox = [];

let transport;

export const appUrl = () => (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");

export async function sendMail({ to, subject, text }) {
  if (!process.env.SMTP_URL) {
    if (process.env.NODE_ENV === "production") {
      // Links are secrets: never keep or log them when mail cannot be delivered.
      console.error(`[mail] SMTP_URL is not set, so "${subject}" was not delivered.`);
      return;
    }
    outbox.push({ to, subject, text });
    if (outbox.length > 50) outbox.shift();
    if (process.env.NODE_ENV !== "test") console.log(`\n[mail] To: ${to}\n[mail] ${subject}\n${text}\n`);
    return;
  }
  transport ??= nodemailer.createTransport(process.env.SMTP_URL);
  await transport.sendMail({ from: process.env.MAIL_FROM || "BSIT 4C OJT <no-reply@localhost>", to, subject, text });
}

export const sendVerification = (email, token) =>
  sendMail({
    to: email,
    subject: "Verify your email",
    text: `Confirm your email for the BSIT 4C OJT Checklist:\n\n${appUrl()}/?verify=${token}\n\nThis link expires in 24 hours.`,
  });

export const sendPasswordReset = (email, token) =>
  sendMail({
    to: email,
    subject: "Reset your password",
    text: `Reset your BSIT 4C OJT Checklist password:\n\n${appUrl()}/?reset=${token}\n\nThis link expires in 1 hour. If you did not ask for this, ignore this email.`,
  });
