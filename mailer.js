const FROM_NAME = process.env.MAIL_FROM_NAME || "Shadab Restaurant";
const FROM_EMAIL = process.env.GMAIL_USER;
const BREVO_API_KEY = process.env.BREVO_API_KEY;

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

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": BREVO_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("[mailer] Brevo send FAILED:", errText);
    throw new Error("Failed to send email");
  }

  console.log("[mailer] Email sent via Brevo to", to);
}

module.exports = { sendOtpEmail };
