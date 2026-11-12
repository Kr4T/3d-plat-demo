// tier.mjs: which model a device gets, and where each model comes from.
// Chosen 12 Nov 2026 (research + Kr4T/ai-stack catalog/): runtime WebLLM 0.2.88 (Apache-2.0, vendor/web-llm-0.2.88),
// models Qwen3.5-2B and Qwen3.5-0.8B (Alibaba, Apache-2.0: the LICENSE file read at the base revisions below), as
// converted by mlc-ai to 4-bit weights. Every URL is pinned to a commit, and the compiled model library carries an SRI
// hash, so what runs is what was checked.
//   full      desktop with WebGPU and shader-f16: Qwen3.5-2B q4f16_1
//   fullF32   desktop WebGPU without shader-f16: the f32 build of the same model
//   small     8 GB phones (on a tap, never on their own) and low-memory desktops: Qwen3.5-0.8B
//   rules     no WebGPU, under 8 GB on a phone, Save-Data on, or asked for: lib/director/rules.mjs, no download
// downloadMB is the sum of the repo's files (Hugging Face API, 12 Nov 2026); vramMB is WebLLM's own figure.
const HF = (repo, rev) => `https://huggingface.co/mlc-ai/${repo}/resolve/${rev}/`;
const LIBS = 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/146ed9cd4b4062e967b017fd2291f7106b50599f/web-llm-models/v0_2_87/base/';
const B2 = 'Qwen/Qwen3.5-2B@15852e8c16360a2fea060d615a32b45270f8a8fc', B08 = 'Qwen/Qwen3.5-0.8B@2fc06364715b967f1860aea9cf38778875588b17';
const M = (o) => Object.freeze({ licence: 'Apache-2.0', stopTokenIds: Object.freeze([248046, 248044]), ...o });

export const MODELS = Object.freeze({
  full: M({ id: 'Qwen3.5-2B-q4f16_1-MLC', base: B2, f16: true, downloadMB: 1032, vramMB: 2245,
    url: HF('Qwen3.5-2B-q4f16_1-MLC', 'dd74e9c8a20c4546df85c844103bff87b6dcacad'), lib: `${LIBS}Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm`,
    libIntegrity: 'sha384-4KkQ4FA7ppT9wPnUWy6onfnwXajVlL7YfP5TQL0d+uEcWxZFf9WSPzPmT6bE9dYN' }),
  fullF32: M({ id: 'Qwen3.5-2B-q4f32_1-MLC', base: B2, f16: false, downloadMB: 1032, vramMB: 2592,
    url: HF('Qwen3.5-2B-q4f32_1-MLC', 'd835e5c41aa56174d915e8a3940cde599d3f5a30'), lib: `${LIBS}Qwen3.5-2B-q4f32_1_cs1k-webgpu.wasm`,
    libIntegrity: 'sha384-uCnfAU0CyyPxGOv6RqU3OYVdJpIUgZdmntfTlOk6+1l1k9InybYI/ZhYreCIb9vF' }),
  small: M({ id: 'Qwen3.5-0.8B-q4f16_1-MLC', base: B08, f16: true, downloadMB: 426, vramMB: 1629,
    url: HF('Qwen3.5-0.8B-q4f16_1-MLC', '0ec138972555613c1d7812a821778ad0398c8790'), lib: `${LIBS}Qwen3.5-0.8B-q4f16_1_cs1k-webgpu.wasm`,
    libIntegrity: 'sha384-Av2oV4gHPTeAXbNJIs/IXPX+UnU7NAI5ReruvIkQeS3d4+KgsO2qfSgIgrPlfvnR' }),
  smallF32: M({ id: 'Qwen3.5-0.8B-q4f32_1-MLC', base: B08, f16: false, downloadMB: 426, vramMB: 1894,
    url: HF('Qwen3.5-0.8B-q4f32_1-MLC', '4ed017713f04c91ffe55a9dca8c7ac853c41314d'), lib: `${LIBS}Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm`,
    libIntegrity: 'sha384-9RDRBqK3uwN9i78tgzQz0tmH/XfYISTUATFxokou3BKehgj6qpHoS0fc4+MZrNJ8' }),
});

/**
 * Is this a low-end graphics device for a 2B model? (The coordinator's rule, 12 Nov 2026; the same rule as the drop-latency
 * branch's builder/prewarm.js readDevice, which is not on the base yet: when it lands, use that.) Low when the adapter is a
 * fallback (software) adapter, or integrated (Intel; Apple; an AMD APU: "Radeon Graphics", "Vega", "APU", no discrete
 * "RX" / "Radeon Pro" name), or its limits are small (maxBufferSize or maxStorageBufferBindingSize under 1 GiB), or the
 * device reports under 8 GB of memory. adapter: { vendor, architecture, description, device, isFallbackAdapter,
 * maxBufferSize, maxStorageBufferBindingSize } as GPUAdapterInfo and GPUSupportedLimits give them (any may be missing).
 * -> { low, why }
 */
export function deviceClass(adapter = {}, deviceMemory = undefined) {
  const txt = [adapter.vendor, adapter.architecture, adapter.description, adapter.device].filter(Boolean).join(' ').toLowerCase();
  const GiB = 1024 ** 3;
  if (adapter.isFallbackAdapter) return { low: true, why: 'a fallback (software) graphics adapter' };
  if (/\bintel\b/.test(txt)) return { low: true, why: 'integrated graphics (Intel)' };
  if (/\bapple\b/.test(txt)) return { low: true, why: 'integrated graphics (Apple)' };
  if (/\b(amd|ati|radeon)\b/.test(txt) && /(radeon(\(tm\))? graphics|vega|\bapu\b)/.test(txt) && !/\brx\b|radeon pro|firepro/.test(txt)) return { low: true, why: 'integrated graphics (AMD APU)' };
  if ((adapter.maxBufferSize !== undefined && adapter.maxBufferSize < GiB) || (adapter.maxStorageBufferBindingSize !== undefined && adapter.maxStorageBufferBindingSize < GiB)) return { low: true, why: 'small graphics limits' };
  if (deviceMemory !== undefined && deviceMemory < 8) return { low: true, why: 'under 8 GB memory' };
  return { low: false, why: 'a discrete graphics adapter' };
}

/**
 * caps: { webgpu, f16, mobile, deviceMemory (GB, as navigator.deviceMemory: undefined on Safari and Firefox), saveData,
 *         lowGpu: { low, why } from deviceClass (optional) }
 * forced: 'rules' | 'small' | 'full' from ?director=, or nothing.
 * -> { tier: 'full' | 'small' | 'rules', model: MODELS.x | null, autoload, why }
 */
export function pickTier(caps = {}, forced = null) {
  const rules = (why) => ({ tier: 'rules', model: null, autoload: false, why });
  if (forced === 'rules') return rules('rules asked for');
  if (!caps.webgpu) return rules('no WebGPU on this device');
  const small = () => (caps.f16 ? MODELS.small : MODELS.smallF32), full = () => (caps.f16 ? MODELS.full : MODELS.fullF32);
  const f = caps.f16 ? '' : ', f32 build (no shader-f16)';
  if (forced === 'small') return { tier: 'small', model: small(), autoload: true, why: `small model asked for${f}` };
  if (forced === 'full') return { tier: 'full', model: full(), autoload: true, why: `full model asked for${f}` };
  if (caps.saveData) return rules('Save-Data is on: no model download');
  if (caps.mobile) {
    if (!(caps.deviceMemory >= 8)) return rules('phone with under 8 GB memory (or unknown)');
    return { tier: 'small', model: small(), autoload: false, why: `phone with WebGPU and 8 GB: small model, downloaded on a tap${f}` };
  }
  if (caps.lowGpu?.low) return { tier: 'small', model: small(), autoload: true, why: `desktop with ${caps.lowGpu.why}: small model${f}` };
  if (caps.deviceMemory !== undefined && caps.deviceMemory < 8) return { tier: 'small', model: small(), autoload: true, why: `desktop with under 8 GB memory: small model${f}` };
  return { tier: 'full', model: full(), autoload: true, why: `desktop WebGPU${f}` };
}
