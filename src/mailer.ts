import nodemailer from "nodemailer";

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

export function devCodesEnabled(): boolean {
  if (process.env.DUOWEI_DEV_CODES === "1") return true;
  if (process.env.DUOWEI_DEV_CODES === "0") return false;
  return !smtpConfigured();
}

export async function sendVerificationMail(email: string, code: string, purpose: "login" = "login"): Promise<void> {
  if (!smtpConfigured()) {
    throw new Error("未配置 SMTP，无法发送验证码邮件");
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "1",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
      : undefined,
  });
  void purpose;
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: `多维登录验证码`,
    text: `你的登录验证码是 ${code}，10 分钟内有效。如果不是你本人操作，请忽略这封邮件。`,
  });
}

export async function sendMail(input: { to: string; subject: string; text: string }): Promise<void> {
  if (!smtpConfigured()) {
    throw new Error("未配置 SMTP，无法发送邮件");
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "1",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
      : undefined,
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
}
