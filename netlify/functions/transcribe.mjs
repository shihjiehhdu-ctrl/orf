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

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const key = env("OPENAI_API_KEY");
  if (!key) return json({ ok: false, error: "server_not_configured" }, 500);

  let form;
  try { form = await req.formData(); } catch { return json({ ok: false, error: "bad_form" }, 400); }
  const audio = form.get("audio");
  const token = String(form.get("token") || "").trim().toUpperCase();
  if (!audio || typeof audio === "string") return json({ ok: false, error: "no_audio" }, 400);
  if (audio.size > MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);

  // 誰可以用：名單上的學生代碼；或在 ALLOW_PRACTICE=true 時開放自由練習
  if (token) {
    const sheet = env("SHEET_API");
    if (sheet) {
      try {
        const r = await fetch(sheet + "?" + new URLSearchParams({ action: "lookup", token }));
        const d = await r.json();
        if (!d.ok) return json({ ok: false, error: "bad_token" }, 403);
      } catch {
        return json({ ok: false, error: "roster_unreachable" }, 502);
      }
    }
  } else if (env("ALLOW_PRACTICE") !== "true") {
    return json({ ok: false, error: "token_required" }, 403);
  }

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
    r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    });
  } catch {
    return json({ ok: false, error: "openai_unreachable" }, 502);
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
