// app.js
import "dotenv/config";
import express from "express";
import pino from "pino";
import qrcode from "qrcode-terminal";

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import { createOpenAI } from "./openaiClient.js";
import { createSalesAgent } from "./salesAgent.js";

const PORT = Number(process.env.PORT ?? 3030);
const BOT_NAME = process.env.BOT_NAME ?? "SweetBot";
const COMPANY_NAME = process.env.COMPANY_NAME ?? "My Sweet Time";

/**
 * Reset configurable por inactividad
 * Preferido: RESET_AFTER_MINUTES
 * Fallback: RESET_AFTER_HOURS
 * Default: 180 minutos
 */
const RESET_AFTER_MINUTES = process.env.RESET_AFTER_MINUTES
  ? Number(process.env.RESET_AFTER_MINUTES)
  : (process.env.RESET_AFTER_HOURS ? Number(process.env.RESET_AFTER_HOURS) * 60 : 180);

const RESET_AFTER_MS = Math.max(1, RESET_AFTER_MINUTES) * 60 * 1000;

// Handoff / humano
const HUMAN_PHONE_E164 = (process.env.HUMAN_PHONE_E164 ?? "").trim();
const ADMIN_JIDS = (process.env.ADMIN_JIDS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const app = express();
app.get("/", (_req, res) => res.send("✅ WA Bot ON"));
app.listen(PORT, () => console.log(`🛜  HTTP Server ON http://localhost:${PORT}`));

const logger = pino({ level: "silent" });

// Memoria por usuario (RAM)
const memoryStore = new Map();
const lastSeenStore = new Map();
const languageStore = new Map();

// Estados de handoff
const handoffActive = new Set();
const handoffPendingConfirm = new Set();

// Cooldown para evitar spam por eventos repetidos
const cooldown = new Map();
const COOLDOWN_MS = 1200;

function canReply(userId) {
  const now = Date.now();
  const last = cooldown.get(userId) ?? 0;
  if (now - last < COOLDOWN_MS) return false;
  cooldown.set(userId, now);
  return true;
}

function normalizeText(t) {
  return (t ?? "").toString().trim();
}

function isCommand(text) {
  const t = text.toLowerCase();
  return t === "reset" || t === "/reset" || t === "reiniciar";
}

// Para reactivar bot después de handoff
function enableBotAgain(text) {
  const t = (text || "").toLowerCase().trim();
  return t === "bot" || t === "/bot" || t === "reactivar";
}

// Detecta intención de humano
function wantsHuman(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("humano") ||
    t.includes("asesor") ||
    t.includes("agente") ||
    t.includes("persona") ||
    t.includes("administrador") ||
    t.includes("admin")
  );
}

function isAffirmative(text) {
  const t = (text || "").toLowerCase().trim();
  return (
    t === "si" || t === "sí" || t === "s" ||
    t === "yes" || t === "y" ||
    t.includes("claro") ||
    t.includes("dale") ||
    t.includes("ok") ||
    t.includes("okay") ||
    t.includes("de acuerdo") ||
    t.includes("por favor")
  );
}

function isNegative(text) {
  const t = (text || "").toLowerCase().trim();
  return (
    t === "no" || t === "n" ||
    t === "nope" ||
    t.includes("negativo") ||
    t.includes("mejor no") ||
    t.includes("cancel")
  );
}

// Nombre completo, sin recortar, pero limpiando emojis/símbolos raros
function normalizeCustomerName(raw) {
  if (!raw) return null;

  let name = raw
    .toString()
    .replace(/[^\p{L}\p{M}\s'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) return null;
  if (name.length > 50) name = name.substring(0, 50).trim();
  if (/\d/.test(name)) return null;

  return name;
}

function jidToPhone(jid) {
  // "506XXXXXXXX@s.whatsapp.net" -> "506XXXXXXXX"
  const m = (jid || "").match(/^(\d+)@/);
  return m?.[1] ?? null;
}

function toWaLinkFromPhone(phoneDigits) {
  if (!phoneDigits) return null;
  const digits = phoneDigits.replace(/\D/g, "");
  return `https://wa.me/${digits}`;
}

function buildConversationSummary(userId) {
  // Resumen simple: últimos mensajes del usuario + último del bot.
  // memoryStore guarda [{role,user/assistant, content}, ...]
  const hist = memoryStore.get(userId) ?? [];
  if (!hist.length) return "Sin historial guardado.";

  // Tomar últimos 10 items
  const tail = hist.slice(-10);

  const userLines = tail
    .filter(x => x.role === "user")
    .map(x => x.content)
    .slice(-4);

  const lastBot = [...tail].reverse().find(x => x.role === "assistant")?.content;

  let summary = "";
  if (userLines.length) summary += `Cliente dijo: ${userLines.join(" | ")}\n`;
  if (lastBot) summary += `Última respuesta del bot: ${lastBot}`;

  return summary.trim() || "Sin historial relevante.";
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const openai = createOpenAI();

  const agent = createSalesAgent({
    openai,
    botName: BOT_NAME,
    companyName: COMPANY_NAME,
    resetAfterMs: RESET_AFTER_MS,
    languageStore
  });

  const sock = makeWASocket({
    auth: state,
    logger
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📲 Escaneá este QR con WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      console.log("🔌 Conexión cerrada. Razón:", reason, "Reconexion:", shouldReconnect);
      if (shouldReconnect) start();
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado");
      console.log(`⏱️  Reset por inactividad: ${RESET_AFTER_MINUTES} minuto(s)`);
      console.log(`👤 Admins: ${ADMIN_JIDS.length ? ADMIN_JIDS.join(", ") : "(no configurados)"}`);
    }
  });

  // Dedupe por mensaje
  const processedMsgIds = new Set();

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type !== "notify") return;

      const msg = messages?.[0];
      if (!msg?.message) return;

      const msgId = msg.key?.id;
      if (msgId) {
        if (processedMsgIds.has(msgId)) return;
        processedMsgIds.add(msgId);
        if (processedMsgIds.size > 2000) processedMsgIds.clear();
      }

      if (msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid === "status@broadcast") return;

      const userId = remoteJid;
      const customerName = normalizeCustomerName(msg.pushName);

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      const clean = normalizeText(text);
      if (!clean) return;

      if (!canReply(userId)) return;

      if (isCommand(clean)) {
        memoryStore.delete(userId);
        lastSeenStore.delete(userId);
        languageStore.delete(userId);
        handoffActive.delete(userId);
        handoffPendingConfirm.delete(userId);

        await sock.sendMessage(remoteJid, {
          text: "Listo ✅ reinicié la conversación. ¿En qué te ayudo? 🙂"
        });
        return;
      }

      if (handoffActive.has(userId)) {
        if (enableBotAgain(clean)) {
          handoffActive.delete(userId);
          await sock.sendMessage(remoteJid, {
            text: "Listo ✅ ya estoy de vuelta. ¿En qué te ayudo? 🙂"
          });
        }
        return;
      }

      if (handoffPendingConfirm.has(userId)) {
        if (isAffirmative(clean)) {
          handoffPendingConfirm.delete(userId);
          handoffActive.add(userId);

          await sock.sendMessage(remoteJid, {
            text: "Listo ✅ en breve te contactará el administrador. Gracias por tu paciencia 🙂"
          });

          const clientPhone = jidToPhone(userId);
          const clientLink = clientPhone ? toWaLinkFromPhone(clientPhone) : null;
          const summary = buildConversationSummary(userId);

          const adminMsg =
            `🧑‍💼 Solicitud de HUMANO\n` +
            `Cliente: ${customerName ?? "(sin nombre)"}\n` +
            `Número de teléfono: +${clientPhone ?? userId}\n` +
            (clientLink ? `Link directo: ${clientLink}\n` : "") +
            `\nResumen:\n${summary}`;

          for (const adminJid of ADMIN_JIDS) {
            await sock.sendMessage(adminJid, { text: adminMsg });
          }

          return;
        }

        if (isNegative(clean)) {
          handoffPendingConfirm.delete(userId);
          await sock.sendMessage(remoteJid, {
            text: "De una 🙂 entonces seguimos por acá. ¿Qué necesitás saber? 🍓"
          });
          return;
        }

        await sock.sendMessage(remoteJid, {
          text: "¿Querés que te pase con un humano? Respondé: Sí / No 🙂"
        });
        return;
      }

      if (clean === "AGENTE" || wantsHuman(clean)) {
        handoffPendingConfirm.add(userId);
        await sock.sendMessage(remoteJid, {
          text: "Claro 🙂 ¿Querés que te pase con un humano? Respondé: Sí / No"
        });
        return;
      }

      await sock.sendPresenceUpdate("composing", remoteJid);

      const answer = await agent({
        userId,
        text: clean,
        memoryStore,
        lastSeenStore,
        customerName
      });

      await sock.sendMessage(remoteJid, { text: answer });
      await sock.sendPresenceUpdate("available", remoteJid);
    } catch (err) {
      console.error("❌ Error en messages.upsert:", err?.message || err);
    }
  });
}

start().catch((e) => console.error("❌ Fatal:", e));