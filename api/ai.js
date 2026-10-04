// POST /api/ai — texto (y opcionalmente imagen en formato OpenAI).
// Entrada:  { messages, max_tokens, temperature }   (el campo "model" del cliente se ignora: manda el servidor)
// Salida:   formato OpenAI → { choices:[{ message:{ content } }] }  (lo que espera callIA en el HTML)
const { generate, handler, partsFromOpenAI } = require("./_lib");

module.exports = handler(async (req, res) => {
  const { messages, max_tokens, temperature } = req.body || {};
  const parts = partsFromOpenAI(messages);
  if (!parts.length) return res.status(400).json({ error: "Mensaje vacío" });

  const text = await generate(parts, {
    maxTokens: Math.min(Number(max_tokens) || 1000, 2000), // tope para controlar coste
    temperature: typeof temperature === "number" ? temperature : 0.3,
  });
  res.status(200).json({ choices: [{ message: { content: text } }] });
});
