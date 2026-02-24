// salesAgent.js
import { buildWelcomePrompt, buildChatPrompt } from "./prompt.js";

const MAX_TURNS = 12;

function scoreEnglish(text) {
  const t = (text || "").toLowerCase();

  // Señales fuertes EN
  let score = 0;

  // Palabras muy comunes en inglés
  const enStrong =
    /\b(what|how|when|where|why|price|menu|delivery|location|hours|open|close|hi|hello|thanks|thank you|i need|i want|can you|do you|please)\b/i;

  // Contracciones típicas
  const contractions = /\b(i'm|you're|don't|can't|it's|that's|we're|they're)\b/i;

  // Estructuras típicas
  const enPhrases = /\b(how are you|what's included|how much|where are you located|opening hours)\b/i;

  if (enStrong.test(text)) score += 3;
  if (contractions.test(text)) score += 2;
  if (enPhrases.test(text)) score += 3;

  // Si el texto tiene muchos caracteres ascii y pocas tildes, suma un poquito (débil)
  const hasAccent = /[áéíóúñü]/i.test(t);
  if (!hasAccent && t.length >= 12) score += 1;

  return score;
}

function scoreSpanish(text) {
  const t = (text || "").toLowerCase();

  let score = 0;

  const esStrong =
    /\b(qué|que|cómo|como|cuándo|cuando|dónde|donde|precio|menú|menu|entregas|ubicación|ubicacion|horario|abren|cierran|gracias|por favor|necesito|quiero|puedes|podés|tienen)\b/i;

  // Tuteo/Costarriqueñismos
  const crHints = /\b(mae|pura vida|tuanis|diay|vos|podés)\b/i;

  if (esStrong.test(text)) score += 3;
  if (crHints.test(text)) score += 2;

  // Tildes son señal fuerte de ES
  if (/[áéíóúñü]/i.test(t)) score += 2;

  return score;
}

function detectLanguageSmart(text) {
  const en = scoreEnglish(text);
  const es = scoreSpanish(text);

  // Si ambos bajos, es ambiguo
  const max = Math.max(en, es);
  if (max < 3) return { lang: null, confidence: 0 }; // ambiguo

  if (en > es) return { lang: "en", confidence: en - es };
  if (es > en) return { lang: "es", confidence: es - en };

  return { lang: null, confidence: 0 };
}

export function createSalesAgent({ openai, botName, companyName, resetAfterMs, languageStore }) {
  const welcomePrompt = buildWelcomePrompt({ companyName });
  const chatPrompt = buildChatPrompt({ botName, companyName });

  const RESET_AFTER_MS = Number(resetAfterMs ?? 3 * 60 * 60 * 1000);

  // Config “switch”
  const SWITCH_STREAK = 2;     // 2 mensajes seguidos claros para cambiar
  const INSTANT_SWITCH_DIFF = 4; // si es MUY obvio, cambia de una

  return async function reply({ userId, text, memoryStore, lastSeenStore, customerName }) {
    const now = Date.now();

    const lastSeen = lastSeenStore.get(userId);
    const isReturningAfterLongTime = lastSeen && (now - lastSeen > RESET_AFTER_MS);
    lastSeenStore.set(userId, now);

    let history = memoryStore.get(userId) ?? [];

    // Si volvió después de mucho, reiniciamos todo (incluye idioma)
    if (isReturningAfterLongTime) {
      memoryStore.delete(userId);
      history = [];
      languageStore.delete(userId);
    }

    // Estructura por usuario: { lang: "es"|"en", streak: number, lastCandidate: "es"|"en"|null }
    let langState = languageStore.get(userId);
    if (!langState) {
      langState = { lang: "es", streak: 0, lastCandidate: null }; // default español
      languageStore.set(userId, langState);
    }

    // Detectar idioma candidato para este mensaje
    const { lang: candidate, confidence } = detectLanguageSmart(text);

    if (candidate && candidate !== langState.lang) {
      // Si es extremadamente obvio: cambio instantáneo
      if (confidence >= INSTANT_SWITCH_DIFF) {
        langState.lang = candidate;
        langState.streak = 0;
        langState.lastCandidate = null;
      } else {
        // Cambio por racha
        if (langState.lastCandidate === candidate) {
          langState.streak += 1;
        } else {
          langState.lastCandidate = candidate;
          langState.streak = 1;
        }

        if (langState.streak >= SWITCH_STREAK) {
          langState.lang = candidate;
          langState.streak = 0;
          langState.lastCandidate = null;
        }
      }
    } else {
      // Si el mensaje es del mismo idioma o es ambiguo: reiniciar racha de cambio
      langState.streak = 0;
      langState.lastCandidate = null;
    }

    // Guardar estado actualizado
    languageStore.set(userId, langState);

    const isFirstContact = history.length === 0;
    const basePrompt = isFirstContact ? welcomePrompt : chatPrompt;

    // Forzar idioma final (evita mezclas)
    const languageInstruction =
      langState.lang === "en"
        ? "IMPORTANT: Reply ONLY in English. Do not mix languages."
        : "IMPORTANTE: Respondé ÚNICAMENTE en español. No mezcles idiomas.";

    const nameHint = customerName ? `Nombre del cliente (WhatsApp): ${customerName}` : "";

    const messages = [
      { role: "system", content: basePrompt + "\n\n" + languageInstruction + (nameHint ? "\n\n" + nameHint : "") },
      ...(isFirstContact ? [] : history),
      { role: "user", content: text }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.5
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      (langState.lang === "en" ? "Could you repeat that, please? 🙂" : "¿Me repetís eso, porfa? 🙂");

    const updated = [
      ...history,
      { role: "user", content: text },
      { role: "assistant", content: answer }
    ].slice(-MAX_TURNS * 2);

    memoryStore.set(userId, updated);

    return answer;
  };
}