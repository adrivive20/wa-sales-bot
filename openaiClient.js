import OpenAI from "openai";

export function createOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Falta OPENAI_API_KEY en .env");
  return new OpenAI({ apiKey });
}