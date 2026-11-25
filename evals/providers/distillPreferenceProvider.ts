/** Custom Promptfoo provider invoking `distillUserPreferenceFromChat` for preference-extraction precision/recall evals. */
import 'dotenv/config';
import { createGeminiClient, FAST_MEMORY_MODEL } from '../../server/ai/geminiClient.ts';
import { distillUserPreferenceFromChat } from '../../server/ai/sideChatRevisionAgent.ts';

interface ProviderOptions {
  id?: string;
  config?: {
    modelOverride?: string;
    temperature?: number;
  };
}

interface CallContext {
  vars?: Record<string, unknown>;
}

export default class DistillPreferenceProvider {
  private readonly providerId: string;
  private readonly modelOverride?: string;
  private readonly temperature?: number;

  constructor(options: ProviderOptions = {}) {
    this.providerId = options.id ?? 'foliobrief-distill-preference';
    this.modelOverride = options.config?.modelOverride;
    this.temperature = options.config?.temperature;
  }

  id(): string {
    return this.providerId;
  }

  async callApi(prompt: string, context: CallContext = {}) {
    // Ensure missing GEMINI_API_KEY surfaces as an eval error rather than falling back to shouldSave=false
    createGeminiClient();

    const vars = context.vars ?? {};
    const userInstruction = String(vars.userInstruction ?? '');
    const toolUsed = String(vars.toolUsed ?? 'update_brief_section');
    const trimmedPrompt = prompt.trim();
    const promptOverride =
      trimmedPrompt && trimmedPrompt !== 'USE_DEFAULT_PROMPT' ? trimmedPrompt : undefined;

    const pref = await distillUserPreferenceFromChat({
      userInstruction,
      toolUsed,
      modelOverride: this.modelOverride,
      temperature: this.temperature,
      promptOverride,
      throwOnError: true,
    });

    return {
      output: JSON.stringify({
        model: this.modelOverride?.trim() || FAST_MEMORY_MODEL,
        shouldSave: pref !== null,
        preferenceKey: pref?.preferenceKey ?? null,
        learnedRule: pref?.learnedRule ?? null,
      }),
    };
  }
}
