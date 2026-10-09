// ORF 朗讀測驗：把錄音轉交 OpenAI whisper-1，取回逐字時間戳。
// 需要的環境變數（Netlify → Site configuration → Environment variables）：
//   OPENAI_API_KEY   必填。OpenAI 的 API 金鑰，只存在伺服器，不會出現在網頁原始碼裡。
//   SHEET_API        選填但建議設定。Apps Script 網址（結尾 /exec）；設定後會先核對學生代碼，只有名單上的代碼能用辨識。
//   ALLOW_PRACTICE   選填。設成 true 才允許沒輸入代碼的「自由練習」也使用真實辨識（會花 API 費用）。

export const config = { path: "/api/transcribe" };

const MAX_BYTES = 4_000_000; // Netlify 同步函式的請求上限約 4.5 MB（二進位資料）

// 給 Whisper 的提示：用帶有「嗯、重複、自我修正」的範例，讓它比較願意照實寫出不流暢的地方，
// 而不是自動整理成通順的句子。刻意不放原文，否則它會更傾向把讀錯的字「聽成」正確的字。
const PROMPT = "Umm, the, the dog is... is big. The cat, I mean the cap, is red. Uh, let me see.";

// ---- 身分驗證（通行票優先，其次查詢代碼）；兩個函式各自內建一份，不依賴其他檔案 ----
import crypto from "node:crypto";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

function verifyTicket(ticket, token) {
  const secret = env("TICKET_SECRET");
  if (!secret || !ticket || !token) return false;
  const i = ticket.lastIndexOf("."), sig = ticket.slice(i + 1), msg = ticket.slice(0, i);
  const j = msg.lastIndexOf("."), tk = msg.slice(0, j), exp = Number(msg.slice(j + 1));
  if (i < 0 || j < 0 || tk !== token || !(exp > Date.now() / 1000)) return false;
  const good = crypto.createHmac("sha256", secret).update(msg).digest("hex");
  return good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig));
}

/* GET the Apps Script web app with a time limit, retrying once; returns parsed JSON or null */
async function sheetGet(sheet, params, { ms = 10000, tries = 2 } = {}) {
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
async function checkStudent(token, ticket) {
  if (!token) return env("ALLOW_PRACTICE") === "true" ? { ok: true } : { ok: false, status: 403, error: "token_required" };
  if (verifyTicket(ticket, token)) return { ok: true, via: "ticket" };
  const sheet = env("SHEET_API");
  if (!sheet) return { ok: true, via: "no_sheet" };
  const d = await sheetGet(sheet, { action: "lookup", token });
  if (!d) return { ok: false, status: 502, error: "roster_unreachable" };
  return d.ok ? { ok: true, via: "lookup" } : { ok: false, status: 403, error: "bad_token" };
}
// ---- 身分驗證結束 ----
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const key = env("OPENAI_API_KEY");
  if (!key) return json({ ok: false, error: "server_not_configured" }, 500);

  let form;
  try { form = await req.formData(); } catch { return json({ ok: false, error: "bad_form" }, 400); }
  const audio = form.get("audio");
  const token = String(form.get("token") || "").trim();   // case-sensitive
  const ticket = String(form.get("ticket") || "");
  if (!audio || typeof audio === "string") return json({ ok: false, error: "no_audio" }, 400);
  if (audio.size > MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);

  // 誰可以用：名單上的學生（通行票或查詢代碼）；或在 ALLOW_PRACTICE=true 時開放自由練習
  const who = await checkStudent(token, ticket);
  if (!who.ok) return json({ ok: false, error: who.error }, who.status);

  const fd = new FormData();
  fd.append("file", audio, audio.name || "reading.webm");
  fd.append("model", "whisper-1");
  fd.append("language", "en");
  fd.append("response_format", "verbose_json");
  fd.append("timestamp_granularities[]", "word");
  fd.append("temperature", "0");
  fd.append("prompt", PROMPT);

  let r;
  try {
    // Netlify 同步函式上限 60 秒；辨識最多等 38 秒（前面的代碼查詢最多約 20 秒），逾時回傳清楚的錯誤而不是 504
    r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: AbortSignal.timeout(38000),
    });
  } catch (e) {
    const to = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return json({ ok: false, error: to ? "whisper_timeout" : "openai_unreachable" }, 502);
  }
  if (!r.ok) {
    console.error("OpenAI error", r.status, await r.text());
    return json({ ok: false, error: "openai_" + r.status }, 502);
  }
  const d = await r.json();
  return json({
    ok: true,
    engine: "whisper-1",
    text: d.text || "",
    duration: d.duration ?? null,
    words: (d.words || []).map((w) => ({ word: w.word, start: w.start, end: w.end })),
  });
};
