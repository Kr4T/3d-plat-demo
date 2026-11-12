// model-output.mjs: what the runtime hands back around the model's own tokens.
// Thinking is switched off for Qwen3.5 with WebLLM's enable_thinking: false. WebLLM 0.2.88 does that by starting the
// assistant's turn with a fixed empty block, "<think>\n\n</think>\n\n" (its forwardPrefill), and returns that prefix as
// part of the message: the model generates only what follows, and the grammar constrains it from its first token.
// Seen on a real GPU (RTX 4090, 12 Nov 2026): every answer was that prefix, then schema-valid JSON.
// So the prefix is the runtime's, a constant, and it is taken off here, exactly: nothing else is stripped. A block with
// anything inside it means the model did think, and the answer is left as it is, for the strict parser to refuse.
export const RUNTIME_PREFIX = '<think>\n\n</think>\n\n';

/** { text, prefix }: the answer without the runtime's fixed empty-thinking prefix, and whether it was there. */
export function withoutRuntimePrefix(text) {
  if (typeof text !== 'string') return { text: '', prefix: false };
  return text.startsWith(RUNTIME_PREFIX) ? { text: text.slice(RUNTIME_PREFIX.length), prefix: true } : { text, prefix: false };
}
