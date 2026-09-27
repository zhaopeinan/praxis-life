import { randomBytes } from "node:crypto";
import { sha256 } from "./passwords.js";

const CAPTCHA_TTL_MS = 5 * 60 * 1000;
/** 去掉易混淆字符 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type CaptchaChallenge = {
  captchaId: string;
  svg: string;
  /** 仅开发模式返回，便于自动化测试 */
  devAnswer?: string;
};

type Stored = {
  hash: string;
  expiresAt: number;
};

export class CaptchaStore {
  private items = new Map<string, Stored>();

  create(options?: { exposeAnswer?: boolean }): CaptchaChallenge {
    this.gc();
    const answer = Array.from({ length: 5 }, () => ALPHABET[randomBytes(1)[0]! % ALPHABET.length]).join("");
    const captchaId = `cap_${randomBytes(12).toString("hex")}`;
    this.items.set(captchaId, {
      hash: hashAnswer(answer),
      expiresAt: Date.now() + CAPTCHA_TTL_MS,
    });
    return {
      captchaId,
      svg: renderCaptchaSvg(answer),
      ...(options?.exposeAnswer ? { devAnswer: answer } : {}),
    };
  }

  /** 校验并消费；成功/失败都会删除，防重放 */
  consume(captchaId: string, answer: string): boolean {
    this.gc();
    const entry = this.items.get(captchaId);
    this.items.delete(captchaId);
    if (!entry || entry.expiresAt < Date.now()) return false;
    return entry.hash === hashAnswer(answer);
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, entry] of this.items) {
      if (entry.expiresAt < now) this.items.delete(id);
    }
  }
}

function hashAnswer(answer: string): string {
  return sha256(`captcha:${answer.trim().toUpperCase()}`);
}

function renderCaptchaSvg(text: string): string {
  const width = 160;
  const height = 48;
  const chars = text.split("");
  const noise = Array.from({ length: 6 }, (_, i) => {
    const x1 = (i * 27 + 5) % width;
    const y1 = (i * 11 + 3) % height;
    const x2 = (i * 41 + 40) % width;
    const y2 = (i * 17 + 20) % height;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#94a3b8" stroke-width="1" opacity="0.55"/>`;
  }).join("");
  const letters = chars
    .map((ch, i) => {
      const x = 18 + i * 28;
      const y = 30 + ((i % 2) * 4 - 2);
      const rot = (i % 3) * 8 - 8;
      return `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" font-size="24" font-family="ui-monospace,Menlo,monospace" font-weight="700" fill="#0f172a">${ch}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="验证码">
  <rect width="100%" height="100%" fill="#f1f5f9" rx="8"/>
  ${noise}
  ${letters}
</svg>`;
}
