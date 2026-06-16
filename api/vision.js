export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'Gemini API key not configured' });
  }

  const { imageBase64, mimeType, prompt } = req.body;
  if (!imageBase64) {
    return res.status(400).json({ error: 'No image provided' });
  }

  const payload = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
        { text: prompt }
      ]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
      responseMimeType: "application/json"
    }
  };

  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;

  // Retry hasta 2 veces si hay 429
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // Espera exponencial: 2s, 4s
      await new Promise(r => setTimeout(r, attempt * 2000));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let response;
    try {
      response = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        return res.status(504).json({ error: 'Gemini timeout' });
      }
      return res.status(500).json({ error: err.message });
    }
    clearTimeout(timeout);

    // Si es 429, reintenta
    if (response.status === 429 && attempt < 2) {
      continue;
    }

    const data = await response.json();

    if (!response.ok) {
      const msg = data.error?.message || 'Gemini error';
      // 429 en último intento — mensaje claro al usuario
      if (response.status === 429) {
        return res.status(429).json({ error: 'Demasiadas peticiones. Espera unos segundos e inténtalo de nuevo.' });
      }
      return res.status(response.status).json({ error: msg });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) {
      return res.status(500).json({ error: 'Respuesta vacía de Gemini' });
    }

    return res.status(200).json({ result: text });
  }
}
