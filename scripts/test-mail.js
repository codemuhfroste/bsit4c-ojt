// Sends one test email using SMTP_URL / MAIL_FROM from .env:  npm run mail:test -- you@example.com
import nodemailer from "nodemailer";

const to = process.argv[2];
if (!to || !process.env.SMTP_URL) {
  console.error("Usage: npm run mail:test -- <recipient>   (SMTP_URL must be set in .env)");
  process.exit(1);
}

const transport = nodemailer.createTransport(process.env.SMTP_URL);
try {
  await transport.verify();
  const info = await transport.sendMail({
    from: process.env.MAIL_FROM || "BSIT 4C OJT <no-reply@localhost>",
    to,
    subject: "BSIT 4C OJT test email",
    text: "If you can read this, SMTP is configured correctly.",
  });
  console.log("Sent:", info.response || info.messageId);
} catch (err) {
  console.error("Failed:", err.message);
  process.exit(1);
}
