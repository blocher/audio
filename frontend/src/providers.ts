/** What each provider can do here, in plain words. */
export const PROVIDER_USES: Record<string, string> = {
  anthropic: "Ask only",
  openai: "Transcribe and Ask",
  gemini: "Transcribe and Ask",
  xai: "Ask only",
  groq: "Transcribe and Ask · cheapest transcription",
  openrouter: "Transcribe and Ask · many companies' models, one account",
};
