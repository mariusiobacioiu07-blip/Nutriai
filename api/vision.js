// POST /api/vision — análisis de foto.
// Entrada: { imageBase64, mimeType, prompt }    Salida: { result: "<texto>" }  (lo que espera callVision)
const { generate, handler } = require("./_lib");

const OK_MIME = ["image/jpeg", "image/png", "image/webp"];
const MAX_B64 = 4_000_000; // ~3 MB reales; Vercel limita el body a ~4.5 MB

module.exports = handler(async (req, res) => {
  const { imageBase64, mimeType, prompt } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== "string") return res.status(400).json({ error: "Falta la imagen" });
  if (!OK_MIME.includes(mimeType)) return res.status(400).json({ error: "Formato de imagen no soportado" });
  if (imageBase64.length > MAX_B64) return res.status(413).json({ error: "Imagen demasiado grande" });

  const text = await generate(
    [{ text: String(prompt || "Describe la comida de la imagen.") }, { image: { mime: mimeType, data: imageBase64 } }],
    { maxTokens: 1500, temperature: 0.2 }
  );
  res.status(200).json({ result: text });
});
