// ORF 朗讀測驗：重述理解評分
// 1. 把學生的重述錄音轉成文字（不給原文當提示，避免把模糊的話「補」成原文）
// 2. 把原文、意義單位、轉寫文字交給 OpenAI 模型，逐條判斷學生有沒有說到每個意思
// 3. 分數由程式依固定規則計算，不讓模型直接給總分
//
// 環境變數（除了 OPENAI_API_KEY、SHEET_API、ALLOW_PRACTICE 之外，以下都可不設）：
//   RETELL_TRANSCRIBE_MODEL  轉錄模型，預設 gpt-transcribe（OpenAI 建議的新模型；舊的 gpt-4o-transcribe 將於 2027/2/26 移除）
//   RETELL_SCORE_MODEL       評分模型，預設 gpt-6-luna
//   RETELL_REASONING         評分模型的 reasoning effort，預設 none（最快；需要時可改 low）
//
// Netlify 同步函式最多執行 60 秒，超過會被強制中斷並回傳 504。
// 所以每一步都設了時限，總時間控制在約 50 秒內；逾時會回傳清楚的錯誤，而不是 504。

export const config = { path: "/api/retell" };

const MAX_BYTES = 4_000_000;
const LIMIT = { sheet: 10000, transcribe: 15000, score: 22000 };   // 各步驟時限（毫秒）；試算表查詢失敗會重試一次

/* fetch with a time limit; a timeout rejects with name "TimeoutError" */
const tfetch = (url, opts = {}, ms = 10000) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
const isTimeout = (e) => e && (e.name === "TimeoutError" || e.name === "AbortError");
import { env, checkStudent, sheetGet } from "../lib/auth.mjs";
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const INSTRUCTIONS = `You score how well a young English learner in Taiwan understood a short passage, based on an oral retell.
The student read the passage aloud, then retold it in English from memory without looking at it.
The retell was transcribed automatically, so it may contain speech-recognition errors.

Judge MEANING ONLY:
- Ignore grammar, tense, plurals, word order, pronunciation, fillers ("um", "uh"), repetitions and very simple wording.
- Paraphrases, synonyms, simple general words and the student's own examples count when the meaning matches.
- A word that is plainly a transcription error for a passage word (similar sound, and the context fits) may be read as that word.
- Do not give credit for anything the student did not actually say. Do not guess what the student meant.

For each meaning unit decide:
- "full": the student clearly expressed this idea.
- "partial": the student expressed part of it, or it is vague but clearly pointing at this idea.
- "none": not mentioned, or stated incorrectly.
Give evidence as a short exact quote from the transcript (empty string when "none").

Also judge:
- sequence: 2 = events/steps the student mentions are in a sensible order, 1 = partly mixed up, 0 = confused;
  null when the student mentions fewer than two units, or the passage is not about a sequence of events or steps.
- misconceptions: statements that contradict the passage (quote or paraphrase each briefly). Empty list if none.
- verbatim: true if most of the retell repeats long stretches of the passage word for word.
- note_zh: 1-2 short sentences in Traditional Chinese for the teacher, about what the student understood or missed.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["units", "sequence", "misconceptions", "verbatim", "note_zh"],
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "status", "evidence"],
        properties: {
          n: { type: "integer" },
          status: { type: "string", enum: ["full", "partial", "none"] },
          evidence: { type: "string" },
        },
      },
    },
    sequence: { anyOf: [{ type: "integer", enum: [0, 1, 2] }, { type: "null" }] },
    misconceptions: { type: "array", items: { type: "string" } },
    verbatim: { type: "boolean" },
    note_zh: { type: "string" },
  },
};

/* passage markup (/ // {up} {down}) is for prosody only; strip it before the model sees the text */
const cleanText = (t) => String(t).split(/\s+/).filter((w) => !/^(\/\/?|\{(?:up|down)\})$/i.test(w)).join(" ").replace(/\{(?:up|down)\}/gi, "").trim();
const parseIdeas = (s) =>
  String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => ({ text: l.replace(/^\*\s*/, "").replace(/^\d+[.)]\s*/, "") }));  // 行首的 * 是舊格式的主旨標記，現在一律當作一般意義單位

function computeScore(units, ideas, j) {
  const pts = { full: 1, partial: 0.5, none: 0 };
  let got = 0, full = 0, partial = 0;
  ideas.forEach((_, i) => { const u = units[i]; const st = u ? u.status : "none"; got += pts[st]; if (st === "full") full++; if (st === "partial") partial++; });
  const recall = ideas.length ? got / ideas.length : 0;
  const mis = (j.misconceptions || []).length;
  let level = 1;
  if (recall >= 0.7 && mis === 0) level = 4;
  else if (recall >= 0.4) level = 3;
  else if (recall >= 0.25) level = 2;
  return { recall: Math.round(recall * 1000) / 10, full, partial, total: ideas.length, level };
}

/* 同一個函式實例在幾分鐘內會被重複使用，文章清單暫存 2 分鐘，減少向試算表查詢的次數 */
let passageCache = { at: 0, list: null };
async function getPassages(sheet) {
  if (passageCache.list && Date.now() - passageCache.at < 120000) return passageCache.list;
  const d = await sheetGet(sheet, { action: "passages" }, { ms: LIMIT.sheet });
  if (d && d.ok) { passageCache = { at: Date.now(), list: d.passages || [] }; return passageCache.list; }
  return null;   // 讀不到時，改用網頁送來的文章與意義單位
}

export default async (req) => {
  const t0 = Date.now(), lap = (label) => console.log(`[retell] ${label} ${Date.now() - t0}ms`);
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const key = env("OPENAI_API_KEY");
  if (!key) return json({ ok: false, error: "server_not_configured" }, 500);

  let form;
  try { form = await req.formData(); } catch { return json({ ok: false, error: "bad_form" }, 400); }
  const audio = form.get("audio");
  const token = String(form.get("token") || "").trim().toUpperCase();
  const ticket = String(form.get("ticket") || "");
  const pid = String(form.get("passage") || "");
  if (!audio || typeof audio === "string") return json({ ok: false, error: "no_audio" }, 400);
  if (audio.size > MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);

  // 身分檢查與文章來源：有 SHEET_API 時，以試算表上的文章與意義單位為準，不採用網頁送來的版本
  const sheet = env("SHEET_API");
  let text = String(form.get("text") || ""), ideasRaw = String(form.get("ideas") || "");
  // 身分驗證與讀取文章同時進行，不必一個等一個
  const [who, plist] = await Promise.all([checkStudent(token, ticket), sheet ? getPassages(sheet) : Promise.resolve(null)]);
  if (!who.ok) return json({ ok: false, error: who.error }, who.status);
  if (plist) {
    const p = plist.find((x) => String(x.id) === pid);
    if (p) { text = p.text; ideasRaw = p.ideas || ""; }
    else if (plist.length) return json({ ok: false, error: "passage_not_found" }, 400); // 試算表有文章時，不接受網頁自帶的版本
  }
  lap("roster+passages");
  const ideas = parseIdeas(ideasRaw);
  if (!text || !ideas.length) return json({ ok: false, error: "no_ideas" }, 400);

  // 1. 轉錄
  const fd = new FormData();
  fd.append("file", audio, audio.name || "retell.wav");
  const tModel = env("RETELL_TRANSCRIBE_MODEL") || "gpt-transcribe";
  fd.append("model", tModel);
  // gpt-transcribe 用 languages（複數）；舊模型用 language。兩者不能同時送，重述是英文，舊模型才加語言提示
  if (!/^gpt-transcribe|^gpt-live-transcribe/.test(tModel)) fd.append("language", "en");
  fd.append("response_format", "json");
  let transcript = "";
  try {
    const r = await tfetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd }, LIMIT.transcribe);
    if (!r.ok) { console.error("transcribe", r.status, await r.text()); return json({ ok: false, error: "openai_" + r.status }, 502); }
    transcript = String((await r.json()).text || "").trim();
  } catch (e) { return json({ ok: false, error: isTimeout(e) ? "transcribe_timeout" : "openai_unreachable" }, 502); }
  lap("transcribe");

  const words = transcript ? transcript.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length : 0;
  if (words < 2) {
    const units = ideas.map((_, i) => ({ n: i + 1, status: "none", evidence: "" }));
    const j = { sequence: null, misconceptions: [], verbatim: false, note_zh: "幾乎沒有說出內容。" };
    return json({ ok: true, transcript, words, units, ...j, ...computeScore(units, ideas, j) });
  }

  // 2. 評分
  const userMsg =
    `PASSAGE:\n${cleanText(text)}\n\nMEANING UNITS:\n` +
    ideas.map((u, i) => `${i + 1}. ${u.text}`).join("\n") +
    `\n\nSTUDENT RETELL (automatic transcript):\n"""${transcript}"""\n\nReturn one entry in "units" for each meaning unit, in order, with n = its number.`;
  const body = {
    model: env("RETELL_SCORE_MODEL") || "gpt-6-luna",
    reasoning: { effort: env("RETELL_REASONING") || "none" },
    input: [{ role: "system", content: INSTRUCTIONS }, { role: "user", content: userMsg }],
    text: { format: { type: "json_schema", name: "retell_score", schema: SCHEMA, strict: true } },
  };
  let j;
  try {
    const r = await tfetch("https://api.openai.com/v1/responses", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }, LIMIT.score);
    if (!r.ok) { console.error("score", r.status, await r.text()); return json({ ok: false, error: "score_" + r.status }, 502); }
    const d = await r.json();
    const parts = (d.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []);
    const txt = parts.find((c) => c.type === "output_text")?.text;
    if (!txt) return json({ ok: false, error: parts.some((c) => c.type === "refusal") ? "score_refused" : "score_empty" }, 502);
    j = JSON.parse(txt);
  } catch (e) {
    if (isTimeout(e)) { lap("score TIMEOUT"); return json({ ok: false, error: "score_timeout" }, 502); }
    console.error("score parse", e); return json({ ok: false, error: "score_failed" }, 502);
  }
  lap("score");

  const byN = new Map((j.units || []).map((u) => [u.n, u]));
  const units = ideas.map((_, i) => byN.get(i + 1) || { n: i + 1, status: "none", evidence: "" });
  return json({ ok: true, transcript, words, units, sequence: j.sequence,
    misconceptions: j.misconceptions || [], verbatim: !!j.verbatim, note_zh: j.note_zh || "", ...computeScore(units, ideas, j) });
};
