export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const OR_KEY = process.env.OPENROUTER_API_KEY;
  if (!OR_KEY) {
    return res.status(500).json({ error: 'OpenRouter API key not configured' });
  }

  const { imageBase64, mimeType, prompt } = req.body;
  if (!imageBase64) {
    return res.status(400).json({ error: 'No image provided' });
  }

  const payload = {
    model: 'google/gemini-2.0-flash-exp:free',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` }
        },
        { type: 'text', text: prompt }
      ]
    }]
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 2000));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let response;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OR_KEY}`,
          'HTTP-Referer': 'https://nutriai.app',
          'X-Title': 'NutriAI'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') return res.status(504).json({ error: 'Timeout analizando imagen' });
      return res.status(500).json({ error: err.message });
    }
    clearTimeout(timeout);

    if (response.status === 429 && attempt < 2) continue;

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 429) {
        return res.status(429).json({ error: 'Demasiadas peticiones, espera unos segundos' });
      }
      return res.status(response.status).json({ error: data.error?.message || 'Error del servidor' });
    }

    const text = data.choices?.[0]?.message?.content || '';
    if (!text) return res.status(500).json({ error: 'Respuesta vacía' });

    return res.status(200).json({ result: text });
  }
}
