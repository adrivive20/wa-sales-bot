import "dotenv/config";
import express from "express";
import pino from "pino";
import qrcode from "qrcode-terminal";

import makeWASocket, {
  useMultiFileAuthState,
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

const memoryStore = new Map();
const lastSeenStore = new Map();
const languageStore = new Map();

// 🔥 store de teléfonos
const phoneStore = new Map();

// 🔥 confirmación humano
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
    t.includes("ok")
  );
}

function isNegative(text) {
  const t = (text || "").toLowerCase().trim();
  return (
    t === "no" || t === "n" ||
    t.includes("mejor no")
  );
}

// 🔥 extracción REAL del número
function extractPhone(msg) {
  const id =
    msg.key.participant ||
    msg.key.remoteJid ||
    "";

  const match = id.match(/(\d{8,15})/);
  if (!match) return null;

  let digits = match[1];

  if (digits.length > 12) return null;

  if (digits.length === 8) {
    digits = "506" + digits;
  }

  return digits;
}

function toWaLinkFromPhone(phoneDigits) {
  if (!phoneDigits) return null;
  return `https://wa.me/${phoneDigits}`;
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
      const userId = remoteJid;

      const customerName = msg.pushName || "Cliente";

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      const clean = normalizeText(text);
      if (!clean) return;

      if (!canReply(userId)) return;

      // 🔥 guardar teléfono válido
      const detectedPhone = extractPhone(msg);
      if (detectedPhone) {
        phoneStore.set(userId, detectedPhone);
      }

      const clientPhone = phoneStore.get(userId);
      const clientLink = toWaLinkFromPhone(clientPhone);

      // 👉 pedir humano
      if (clean === "AGENTE" || wantsHuman(clean)) {
        handoffPendingConfirm.add(userId);

        await sock.sendMessage(remoteJid, {
          text: "Claro 🙂 ¿Querés que te pase con un humano? Respondé: Sí / No"
        });

        return;
      }

      // 👉 confirmación humano
      if (handoffPendingConfirm.has(userId)) {

        if (isAffirmative(clean)) {
          handoffPendingConfirm.delete(userId);

          const summary = buildConversationSummary(userId);

          let adminMsg =
            `🧑‍💼 Solicitud de HUMANO\n` +
            `Cliente: ${customerName}\n`;

          if (clientLink) {
            adminMsg += `Link directo: ${clientLink}\n`;
          }

          adminMsg += `\nResumen:\n${summary}`;

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
            text: "De una 🙂 seguimos por acá entonces. ¿Qué necesitás saber? 🍓"
          });

          return;
        }

        await sock.sendMessage(remoteJid, {
          text: "¿Querés que te pase con un humano? Respondé: Sí / No 🙂"
        });

        return;
      }

      // 🤖 flujo normal
      const answer = await agent({
        userId,
        text: clean,
        memoryStore,
        lastSeenStore
      });

      await sock.sendMessage(remoteJid, { text: answer });

    } catch (err) {
      console.error("❌ Error:", err);
    }
  });
}

start().catch(console.error);