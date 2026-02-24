import "dotenv/config";
import express from "express";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import P from "pino";
import qrcode from "qrcode-terminal";

import { createSalesAgent } from "./salesAgent.js";
import { openai } from "./openaiClient.js";

const PORT = process.env.PORT || 3030;

const BOT_NAME = process.env.BOT_NAME || "SweetBot";
const COMPANY_NAME = process.env.COMPANY_NAME || "My Sweet Time";
const RESET_AFTER_MINUTES = Number(process.env.RESET_AFTER_MINUTES || 180);
const HUMAN_PHONE_E164 = process.env.HUMAN_PHONE_E164;
const ADMIN_JIDS = process.env.ADMIN_JIDS
  ? process.env.ADMIN_JIDS.split(",")
  : [];

const memoryStore = new Map();
const lastSeenStore = new Map();

const salesAgent = createSalesAgent({
  openai,
  botName: BOT_NAME,
  companyName: COMPANY_NAME
});

// Servidor HTTP (para que Docker no crea que el contenedor está muerto)
const app = express();
app.get("/", (_, res) => res.send("Bot activo"));
app.listen(PORT, () => {
  console.log(`🛜  HTTP Server ON http://localhost:${PORT}`);
});

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    browser: ["Bot MST", "Chrome", "1.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📲 QR recibido:");
      qrcode.generate(qr, { small: true });
      console.log("QR_RAW:", qr);
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado correctamente");
    }

    if (connection === "close") {
      const err = lastDisconnect?.error;
      const status = err?.output?.statusCode;

      console.log("🔌 Conexión cerrada:", {
        status,
        message: err?.message,
        data: err?.data
      });

      // ⛔ Si es 405 NO reconectamos automáticamente
      if (status === 405) {
        console.log("⛔ Error 405 detectado. Deteniendo reconexión automática.");
        return;
      }

      const shouldReconnect = status !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log("🔁 Intentando reconectar...");
        start();
      } else {
        console.log("🚪 Sesión cerrada (loggedOut).");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    if (!text) return;

    try {
      const reply = await salesAgent({
        userId: sender,
        text,
        memoryStore,
        lastSeenStore
      });

      await sock.sendMessage(sender, { text: reply });
    } catch (error) {
      console.error("❌ Error procesando mensaje:", error);
      await sock.sendMessage(sender, {
        text: "Ups, algo pasó procesando tu mensaje 😅 intentá de nuevo."
      });
    }
  });
}

start();