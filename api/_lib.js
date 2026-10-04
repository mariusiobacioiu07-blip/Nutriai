// Lógica compartida de los endpoints. El prefijo "_" evita que Vercel lo exponga como ruta.
// La clave NUNCA va aquí: se lee de variables de entorno (Vercel → Settings → Environment Variables).

const PROVIDER = () => (process.env.PROVIDER || "gemini").toLowerCase();

// Modelos configurables por entorno (los nombres de modelo cambian con el tiempo).
const MODELS = {
  // "gemini-flash-latest" es un alias de Google que apunta al Flash vigente → evita que se rompa al retirar modelos.
  gemini: () => process.env.GEMINI_MODEL || "gemini-flash-latest",
  claude: () => process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
  groq: () => process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  groqVision: () => process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct",
};

// Reservas de Gemini, en orden. Se pueden cambiar con GEMINI_FALLBACKS="modelo1,modelo2" (sin "models/").
// Por defecto, modelos que aparecían en tu listado de ListModels.
const GEMINI_FALLBACKS = () =>
  (process.env.GEMINI_FALLBACKS || "gemini-3.5-flash,gemini-3.5-flash-lite").split(",").map((s) => s.trim());

// ── Límite de peticiones (best-effort: memoria de la instancia, no es global) ──
const hits = new Map();
function rateLimited(req, max = 30, windowMs = 60_000) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // evita crecimiento sin fin
  return arr.length > max;
}

// ── Mensajes normalizados: [{text}|{image:{mime,data}}] ──
// Convierte el formato OpenAI que manda el cliente (text / image_url con data URL).
function partsFromOpenAI(messages = []) {
  const parts = [];
  for (const m of messages) {
    const c = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
    for (const p of c) {
      if (p.type === "text") parts.push({ text: p.text });
      else if (p.type === "image_url") {
        const mt = /^data:([^;]+);base64,(.+)$/.exec(p.image_url?.url || "");
        if (mt) parts.push({ image: { mime: mt[1], data: mt[2] } });
      }
    }
  }
  return parts;
}

async function postJSON(url, headers, body, timeoutMs = 25_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!r.ok) {
      const msg = json?.error?.message || json?.error || text.slice(0, 200);
      const err = new Error(`Proveedor ${r.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
      err.status = r.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

// ── Llamada al proveedor → devuelve SIEMPRE texto plano ──
async function generate(parts, { maxTokens = 1000, temperature = 0.3 } = {}) {
  const provider = PROVIDER();
  const hasImage = parts.some((p) => p.image);

  if (provider === "gemini") {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Falta GEMINI_API_KEY en el servidor");
    const body = {
      contents: [{
        role: "user",
        parts: parts.map((p) => (p.image ? { inline_data: { mime_type: p.image.mime, data: p.image.data } } : { text: p.text })),
      }],
      // Los modelos Gemini recientes "piensan" y esos tokens cuentan dentro de maxOutputTokens.
      // Sin margen extra, la respuesta puede quedar cortada o vacía → sumamos holgura.
      generationConfig: { maxOutputTokens: maxTokens + 4096, temperature },
    };
    // Modelo principal + reservas (si Google responde 503/429/500 por saturación, probamos el siguiente).
    const chain = [MODELS.gemini(), ...GEMINI_FALLBACKS()].filter((m, i, a) => m && a.indexOf(m) === i);
    const started = Date.now();
    let j, lastErr;
    for (let i = 0; i < chain.length; i++) {
      if (Date.now() - started > 18_000) break; // Vercel corta a 30 s: no arrancamos intentos que no caben
      try {
        j = await postJSON(
          `https://generativelanguage.googleapis.com/v1beta/models/${chain[i]}:generateContent`,
          { "x-goog-api-key": key },
          body,
          12_000
        );
        break;
      } catch (e) {
        lastErr = e;
        const transient = e.name === "AbortError" || [429, 500, 503, 504].includes(e.status);
        const modelGone = e.status === 404 || e.status === 403; // retirado / no disponible para tu cuenta
        if (!transient && !modelGone) throw e; // 400 (petición mala), 401 (clave mala)… no se arregla cambiando de modelo
        if (e.status === 503 && i === 0) await new Promise((r) => setTimeout(r, 700)); // pausa breve antes de saltar
      }
    }
    if (!j) throw lastErr || new Error("Gemini no respondió");
    const cand = j?.candidates?.[0];
    const txt = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    if (!txt) {
      const why = cand?.finishReason || j?.promptFeedback?.blockReason || "desconocido";
      throw new Error(`Respuesta vacía de Gemini (motivo: ${why})`);
    }
    return txt;
  }

  if (provider === "claude") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Falta ANTHROPIC_API_KEY en el servidor");
    const j = await postJSON(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
      {
        model: MODELS.claude(),
        max_tokens: maxTokens,
        temperature,
        messages: [{
          role: "user",
          content: parts.map((p) => (p.image
            ? { type: "image", source: { type: "base64", media_type: p.image.mime, data: p.image.data } }
            : { type: "text", text: p.text })),
        }],
      }
    );
    const txt = (j?.content || []).map((b) => b.text || "").join("");
    if (!txt) throw new Error("Respuesta vacía de Claude");
    return txt;
  }

  if (provider === "groq") {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error("Falta GROQ_API_KEY en el servidor");
    const j = await postJSON(
      "https://api.groq.com/openai/v1/chat/completions",
      { Authorization: `Bearer ${key}` },
      {
        model: hasImage ? MODELS.groqVision() : MODELS.groq(),
        max_tokens: maxTokens,
        temperature,
        messages: [{
          role: "user",
          content: parts.map((p) => (p.image
            ? { type: "image_url", image_url: { url: `data:${p.image.mime};base64,${p.image.data}` } }
            : { type: "text", text: p.text })),
        }],
      }
    );
    const txt = j?.choices?.[0]?.message?.content || "";
    if (!txt) throw new Error("Respuesta vacía de Groq");
    return txt;
  }

  throw new Error(`PROVIDER desconocido: ${provider} (usa gemini | claude | groq)`);
}

// ── Plantilla de handler: método, límites, errores ──
function handler(fn) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
    if (rateLimited(req)) return res.status(429).json({ error: "Demasiadas peticiones, espera un minuto" });
    try {
      await fn(req, res);
    } catch (e) {
      console.error("[nutri-ai]", e.message); // sin cuerpo ni claves
      const status = e.name === "AbortError" ? 504 : 502;
      res.status(status).json({ error: e.name === "AbortError" ? "La IA tardó demasiado" : e.message });
    }
  };
}

module.exports = { generate, handler, partsFromOpenAI };
