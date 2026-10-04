// Lógica compartida de los endpoints. El prefijo "_" evita que Vercel lo exponga como ruta.
// La clave NUNCA va aquí: se lee de variables de entorno (Vercel → Settings → Environment Variables).

const PROVIDER = () => (process.env.PROVIDER || "gemini").toLowerCase();

// Modelos configurables por entorno (los nombres de modelo cambian con el tiempo).
const MODELS = {
  gemini: () => process.env.GEMINI_MODEL || "gemini-2.5-flash",
  claude: () => process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
  groq: () => process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  groqVision: () => process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct",
};

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
      throw new Error(`Proveedor ${r.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
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
    const j = await postJSON(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini()}:generateContent`,
      { "x-goog-api-key": key },
      {
        contents: [{
          role: "user",
          parts: parts.map((p) => (p.image ? { inline_data: { mime_type: p.image.mime, data: p.image.data } } : { text: p.text })),
        }],
        generationConfig: { maxOutputTokens: maxTokens, temperature },
      }
    );
    const txt = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    if (!txt) throw new Error("Respuesta vacía de Gemini");
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
