export const maxDuration = 30; // Vercel: permite hasta 30s en plan hobby

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

  try {
    const { imageBase64, mimeType, prompt } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const payload = {
      contents: [{
        parts: [
          {
            inline_data: {
              mime_type: mimeType || 'image/jpeg',
              data: imageBase64
            }
          },
          { text: prompt }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
        responseMimeType: "application/json"
      }
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini error:', JSON.stringify(data));
      return res.status(response.status).json({ error: data.error?.message || 'Gemini error' });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!text) {
      return res.status(500).json({ error: 'Gemini returned empty response' });
    }

    return res.status(200).json({ result: text });

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Gemini timeout after 25s' });
    }
    console.error('Vision handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
