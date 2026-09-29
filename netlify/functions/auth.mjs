// 共用：學生身分驗證
// 1. 優先驗證「通行票」：學生登入時由 Apps Script 簽發（HMAC-SHA256），這裡用同一把 TICKET_SECRET 驗證，
//    完全不必再呼叫 Apps Script，最快也最穩定。
// 2. 沒有設定 TICKET_SECRET、或通行票無效時，才退回向 Apps Script 查詢代碼（有時限，失敗會重試一次）。
import crypto from "node:crypto";

export const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export function verifyTicket(ticket, token) {
  const secret = env("TICKET_SECRET");
  if (!secret || !ticket || !token) return false;
  const i = ticket.lastIndexOf("."), sig = ticket.slice(i + 1), msg = ticket.slice(0, i);
  const j = msg.lastIndexOf("."), tk = msg.slice(0, j), exp = Number(msg.slice(j + 1));
  if (i < 0 || j < 0 || tk !== token || !(exp > Date.now() / 1000)) return false;
  const good = crypto.createHmac("sha256", secret).update(msg).digest("hex");
  return good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig));
}

/* GET the Apps Script web app with a time limit, retrying once; returns parsed JSON or null */
export async function sheetGet(sheet, params, { ms = 10000, tries = 2 } = {}) {
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(sheet + "?" + new URLSearchParams(params), { signal: AbortSignal.timeout(ms) });
      const text = await r.text();
      try { return JSON.parse(text); }
      catch { console.error(`[sheet] ${params.action} non-JSON (HTTP ${r.status}):`, text.slice(0, 200)); }
    } catch (e) {
      console.error(`[sheet] ${params.action} attempt ${k + 1} failed:`, e && e.name);
    }
  }
  return null;
}

/* Returns { ok:true } or { ok:false, status, error } */
export async function checkStudent(token, ticket) {
  if (!token) return env("ALLOW_PRACTICE") === "true" ? { ok: true } : { ok: false, status: 403, error: "token_required" };
  if (verifyTicket(ticket, token)) return { ok: true, via: "ticket" };
  const sheet = env("SHEET_API");
  if (!sheet) return { ok: true, via: "no_sheet" };
  const d = await sheetGet(sheet, { action: "lookup", token });
  if (!d) return { ok: false, status: 502, error: "roster_unreachable" };
  return d.ok ? { ok: true, via: "lookup" } : { ok: false, status: 403, error: "bad_token" };
}
