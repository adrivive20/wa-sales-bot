// app.js
import "dotenv/config";
import express from "express";
import pino from "pino";
import qrcode from "qrcode-terminal";

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import { createOpenAI } from "./openaiClient.js";
import { createSalesAgent } from "./salesAgent.js";

const PORT = Number(process.env.PORT ?? 3040);
const BOT_NAME = process.env.BOT_NAME ?? "SweetBot";
const COMPANY_NAME = process.env.COMPANY_NAME ?? "My Sweet Time";

const RESET_AFTER_MINUTES = process.env.RESET_AFTER_MINUTES
  ? Number(process.env.RESET_AFTER_MINUTES)
  : (process.env.RESET_AFTER_HOURS ? Number(process.env.RESET_AFTER_HOURS) * 60 : 180);

const RESET_AFTER_MS = Math.max(1, RESET_AFTER_MINUTES) * 60 * 1000;

const ADMIN_JIDS = (process.env.ADMIN_JIDS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const app = express();
app.get("/", (_req, res) => res.send("✅ WA Bot ON"));
app.listen(PORT, () => console.log(`🛜 HTTP Server ON http://localhost:${PORT}`));

const logger = pino({ level: "silent" });

const memoryStore = new Map();
const lastSeenStore = new Map();
const languageStore = new Map();

const handoffActive = new Set();
const handoffPendingConfirm = new Set();

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

function enableBotAgain(text) {
  const t = (text || "").toLowerCase().trim();
  return t === "bot" || t === "/bot" || t === "reactivar";
}

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

// 🔥 FIX @lid
function extractEffectiveUserJid(key) {
  if (key?.addressingMode === "lid" && key?.remoteJidAlt) {
    return key.remoteJidAlt;
  }
  return key?.participant || key?.remoteJid;
}

function jidToPhone(jid) {
  const m = (jid || "").match(/^(\d+)@/);
  return m?.[1] ?? null;
}

function toWaLinkFromPhone(phoneDigits) {
  if (!phoneDigits) return null;
  const digits = phoneDigits.replace(/\D/g, "");
  return `https://wa.me/${digits}`;
}

function buildConversationSummary(userId) {
  const hist = memoryStore.get(userId) ?? [];
  if (!hist.length) return "Sin historial guardado.";

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

let sock;

async function start() {
  console.log("🚀 Iniciando bot...");

  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const openai = createOpenAI();

  const agent = createSalesAgent({
    openai,
    botName: BOT_NAME,
    companyName: COMPANY_NAME,
    resetAfterMs: RESET_AFTER_MS,
    languageStore
  });

  sock = makeWASocket({
    version,
    auth: state,
    logger
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, qr }) => {
    if (qr) {
      console.log("📲 Escaneá el QR:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado");
    }

    if (connection === "close") {
      console.log("🔁 Reconectando...");
      setTimeout(start, 2000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type !== "notify") return;

      const msg = messages?.[0];
      if (!msg?.message) return;
      if (msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid === "status@broadcast") return;

      const userId = extractEffectiveUserJid(msg.key);
      const customerName = normalizeCustomerName(msg.pushName);

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      const clean = normalizeText(text);
      if (!clean) return;

      if (!canReply(userId)) return;

      if (handoffPendingConfirm.has(userId)) {
        if (isAffirmative(clean)) {
          handoffPendingConfirm.delete(userId);

          const clientPhone = jidToPhone(userId);
          console.log(`🧑‍💼 HUMANO: ${customerName ?? "(sin nombre)"} | ${clientPhone ?? userId}`);

          const clientLink = clientPhone ? toWaLinkFromPhone(clientPhone) : null;
          const summary = buildConversationSummary(userId);

          const adminMsg =
            `🧑‍💼 Solicitud de HUMANO\n` +
            `Cliente: ${customerName ?? "(sin nombre)"}\n` +
            `Contacto: ${clientPhone ?? userId}\n` +
            (clientLink ? `Link directo: ${clientLink}\n` : "") +
            `\nResumen:\n${summary}`;

          for (const adminJid of ADMIN_JIDS) {
            await sock.sendMessage(adminJid, { text: adminMsg });
          }

          await sock.sendMessage(remoteJid, {
            text: "Perfecto 🙌 ya le pasé tu caso a un humano. Mientras tanto, puedo seguir ayudándote por acá 🙂"
          });

          return;
        }
      }

      if (clean === "AGENTE" || wantsHuman(clean)) {
        handoffPendingConfirm.add(userId);
        await sock.sendMessage(remoteJid, {
          text: "Claro 🙂 ¿Querés que te pase con un humano? Respondé: Sí / No"
        });
        return;
      }

      const answer = await agent({
        userId,
        text: clean,
        memoryStore,
        lastSeenStore,
        customerName
      });

      await sock.sendMessage(remoteJid, { text: answer });

    } catch (err) {
      console.error("❌ Error:", err);
    }
  });
}

start();