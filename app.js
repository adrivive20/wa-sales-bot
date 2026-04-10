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
app.listen(PORT, () => console.log(`🛜  HTTP Server ON http://localhost:${PORT}`));

const logger = pino({ level: "silent" });

// Memoria
const memoryStore = new Map();
const lastSeenStore = new Map();
const languageStore = new Map();

// Confirmación humano
const handoffPendingConfirm = new Set();

// Cooldown
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

function wantsHuman(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("humano") ||
    t.includes("asesor") ||
    t.includes("agente") ||
    t.includes("persona") ||
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
    t.includes("de acuerdo")
  );
}

function isNegative(text) {
  const t = (text || "").toLowerCase().trim();
  return (
    t === "no" || t === "n" ||
    t.includes("mejor no")
  );
}

function normalizeCustomerName(raw) {
  if (!raw) return "Cliente";

  let name = raw
    .toString()
    .replace(/[^\p{L}\p{M}\s'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) return "Cliente";
  if (name.length > 50) name = name.substring(0, 50).trim();

  return name;
}

function jidToPhone(jid) {
  // "506XXXXXXXX@s.whatsapp.net" -> "506XXXXXXXX"
  const m = (jid || "").match(/^(\d+)@/);
  return m?.[1] ?? null;
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
    logger,
    browser: ["Chrome (Bot MST)", "Windows", "10"],
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr } = update;

    if (qr) {
      console.log("📲 Escaneá este QR:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado");
    }

    if (connection === "close") {
      setTimeout(start, 2000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type !== "notify") return;

      const msg = messages?.[0];
      if (!msg?.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid === "status@broadcast") return;

      const userId = remoteJid;
      const customerName = normalizeCustomerName(msg.pushName);

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      const clean = normalizeText(text);
      if (!clean) return;

      if (!canReply(userId)) return;

      const clientPhone = jidToPhone(userId);
      const clientLink = clientPhone
        ? `https://wa.me/${clientPhone}`
        : null;

      // RESET
      if (isCommand(clean)) {
        memoryStore.delete(userId);
        lastSeenStore.delete(userId);
        languageStore.delete(userId);
        handoffPendingConfirm.delete(userId);

        await sock.sendMessage(remoteJid, {
          text: "Listo ✅ reinicié la conversación. ¿En qué te ayudo? 🙂"
        });
        return;
      }

      // CONFIRMACIÓN HUMANO
      if (handoffPendingConfirm.has(userId)) {

        if (isAffirmative(clean)) {
          handoffPendingConfirm.delete(userId);

          const summary = buildConversationSummary(userId);

          const adminMsg =
            `🧑‍💼 Solicitud de HUMANO\n` +
            `Cliente: ${customerName}\n` +
            (clientPhone ? `Número de teléfono: +${clientPhone}\n` : "") +
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

        if (isNegative(clean)) {
          handoffPendingConfirm.delete(userId);

          await sock.sendMessage(remoteJid, {
            text: "De una 🙂 seguimos por acá. ¿Qué necesitás saber? 🍓"
          });

          return;
        }

        await sock.sendMessage(remoteJid, {
          text: "¿Querés que te pase con un humano? Respondé: Sí / No 🙂"
        });

        return;
      }

      // PEDIR HUMANO
      if (clean === "AGENTE" || wantsHuman(clean)) {
        handoffPendingConfirm.add(userId);

        await sock.sendMessage(remoteJid, {
          text: "Claro 🙂 ¿Querés que te pase con un humano? Respondé: Sí / No"
        });

        return;
      }

      // BOT NORMAL
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

start().catch(console.error);