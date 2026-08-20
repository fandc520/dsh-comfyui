/**
 * Built-in ComfyUI workflow templates in API format (node id → class_type +
 * inputs). `txt2img` and `img2img` use only core ComfyUI nodes; `video` is a
 * Wan 2.1 text-to-video skeleton that requires the ComfyUI-WanVideoWrapper
 * custom nodes and matching model files. The `guide` field is shown to the
 * model so it can override the right node inputs.
 */

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  guide: string
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>
}

export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'txt2img',
    name: 'SDXL text-to-image',
    description: 'Generate an image from a text prompt using a standard SDXL checkpoint.',
    guide: 'Node ids: 4 checkpoint (ckpt_name), 5 EmptyLatentImage (width/height/batch_size), 6 positive CLIPTextEncode (text), 7 negative CLIPTextEncode (text), 3 KSampler (seed/steps/cfg/denoise), 9 SaveImage (filename_prefix). Override 6.text with the prompt and 7.text with negative prompt; set a random 3.seed for variety.',
    workflow: {
      '3': {
        class_type: 'KSampler',
        inputs: { seed: 0, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] },
      },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-comfyui', images: ['8', 0] } },
    },
  },
  {
    id: 'img2img',
    name: 'SDXL image-to-image',
    description: 'Edit or restyle an input image with a text prompt and denoise strength.',
    guide: 'Node ids: 4 checkpoint, 10 LoadImage (image), 11 VAEEncode, 6 positive text, 7 negative text, 3 KSampler (denoise controls how much the input changes, 0..1; seed/steps/cfg), 9 SaveImage. Put the input image filename in 10.image, the prompt in 6.text.',
    workflow: {
      '3': {
        class_type: 'KSampler',
        inputs: { seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 0.6, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['11', 0] },
      },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-comfyui', images: ['8', 0] } },
      '10': { class_type: 'LoadImage', inputs: { image: 'example.png' } },
      '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
    },
  },
  {
    id: 'video',
    name: 'Wan 2.1 text-to-video',
    description: 'Generate a short video from a text prompt (requires ComfyUI-WanVideoWrapper custom nodes and Wan 2.1 models).',
    guide: 'Node ids: 10 UNETLoader (unet_name), 11 CLIPLoader, 12 VAELoader, 13 WanTextEncode (prompt/negative_prompt), 14 WanImageToVideo (width/height/length frames/batch_size), 15 KSampler (seed/steps/cfg), 17 SaveVideo (filename_prefix). Requires the ComfyUI-WanVideoWrapper custom nodes and downloaded Wan 2.1 checkpoints; verify node names with comfyui_object_info if your install differs.',
    workflow: {
      '10': { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.1_t2v_14B_fp8_e4m3fn.safetensors', weight_dtype: 'fp8_e4m3fn' } },
      '11': { class_type: 'CLIPLoader', inputs: { clip_name: 'wan2.1_t2v_14B_clip.safetensors', type: 'wan' } },
      '12': { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
      '13': { class_type: 'WanTextEncode', inputs: { prompt: '', negative_prompt: '', clip: ['11', 0] } },
      '14': { class_type: 'WanImageToVideo', inputs: { positive: ['13', 0], negative: ['13', 1], vae: ['12', 0], width: 832, height: 480, length: 81, batch_size: 1 } },
      '15': { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 6, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['10', 0], positive: ['13', 0], negative: ['13', 1], latent_image: ['14', 0] } },
      '16': { class_type: 'WanVideoDecode', inputs: { samples: ['15', 0], vae: ['12', 0] } },
      '17': { class_type: 'SaveVideo', inputs: { filename_prefix: 'dsh-comfyui', video: ['16', 0] } },
    },
  },
]

/** Look up a template by id. */
export function findTemplate(id: string): WorkflowTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id)
}

/**
 * Merge per-node input overrides into a workflow copy. Each entry maps a node
 * id to a partial inputs object; later entries observe earlier merges.
 */
export function applyTemplateInputs(
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>,
  overrides: Record<string, Record<string, unknown>>,
): void {
  for (const [nodeId, partial] of Object.entries(overrides)) {
    const node = workflow[nodeId]
    if (node === undefined) continue
    if (typeof partial !== 'object' || partial === null) continue
    node.inputs = { ...node.inputs, ...partial }
  }
}

/** Clone a template workflow so callers never mutate the shared constant. */
export function cloneWorkflow(workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return JSON.parse(JSON.stringify(workflow))
}
