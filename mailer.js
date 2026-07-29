const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
  connectionTimeout: 15000,
});

// Fails loudly at boot if the Gmail credentials are wrong, instead of
// silently failing the first time a customer tries to sign up.
transporter.verify((err) => {
  if (err) {
    console.error("[mailer] Gmail connection FAILED — check GMAIL_USER / GMAIL_APP_PASSWORD in your environment variables.");
    console.error(err.message);
  } else {
    console.log("[mailer] Gmail connection OK — ready to send real emails.");
  }
});

const FROM_NAME = process.env.MAIL_FROM_NAME || "Shadab Restaurant";

async function sendOtpEmail(to, code, purpose) {
  const subject = purpose === "reset"
    ? "Your password reset code"
    : "Verify your email — Shadab Restaurant";

  const heading = purpose === "reset"
    ? "Reset your password"
    : "Welcome to Shadab Restaurant";

  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px;">
    <h2 style="color:#b8860b;margin-bottom:4px;">${heading}</h2>
    <p style="color:#333;">Your verification code is:</p>
    <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#111;color:#e6c35c;padding:16px;border-radius:8px;text-align:center;margin:16px 0;">
      ${code}
    </div>
    <p style="color:#666;font-size:14px;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
  </div>`;

  await transporter.sendMail({
    from: `"${FROM_NAME}" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
    text: `Your verification code is ${code}. It expires in 10 minutes.`,
  });
}

module.exports = { sendOtpEmail };
