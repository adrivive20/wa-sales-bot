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
 * Reset configurable por inactividad:
 * Preferido: RESET_AFTER_MINUTES
 * Fallback: RESET_AFTER_HOURS
 * Default: 180 min
 */
const RESET_AFTER_MINUTES = process.env.RESET_AFTER_MINUTES
  ? Number(process.env.RESET_AFTER_MINUTES)
  : (process.env.RESET_AFTER_HOURS ? Number(process.env.RESET_AFTER_HOURS) * 60 : 180);

const RESET_AFTER_MS = Math.max(1, RESET_AFTER_MINUTES) * 60 * 1000;

// Server HTTP (para healthcheck)
const app = express();
app.get("/", (_req, res) => res.send("✅ WA Bot ON"));
app.listen(PORT, () => console.log(`🛜  HTTP Server ON http://localhost:${PORT}`));

const logger = pino({ level: "silent" });

// Memoria por usuario (RAM)
const memoryStore = new Map();
const lastSeenStore = new Map();

// Idioma por usuario (si tu salesAgent usa esto)
const languageStore = new Map();

// Dedupe
const processedMsgIds = new Set();

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

    // Log mínimo para debug
    console.log("📡 connection.update:", { connection, hasQR: !!qr });

    if (qr) {
      console.log("📲 Escaneá este QR con WhatsApp:");
      qrcode.generate(qr, { small: true });
      console.log("QR_RAW:", qr); // backup por si no se renderiza el ASCII
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado");
      console.log(`⏱️  Reset por inactividad: ${RESET_AFTER_MINUTES} minuto(s)`);
    }

    if (connection === "close") {
      const err = lastDisconnect?.error;
      const status = err?.output?.statusCode;

      console.log("🔌 Conexión cerrada:", {
        status,
        message: err?.message,
        data: err?.data
      });

      // ⛔ Si es 405 NO reconectamos automáticamente para evitar loop/bloqueo
      if (status === 405) {
        console.log("⛔ 405 detectado: deteniendo reconexión automática.");
        return;
      }

      const shouldReconnect = status !== DisconnectReason.loggedOut;
      console.log("🔁 Reconexion:", shouldReconnect);

      if (shouldReconnect) start();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type !== "notify") return;

      const msg = messages?.[0];
      if (!msg?.message) return;

      // Dedupe
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
      if (!canReply(userId)) return;

      const customerName = normalizeCustomerName(msg.pushName);

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      const clean = normalizeText(text);
      if (!clean) return;

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