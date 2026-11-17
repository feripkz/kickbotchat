const VOICE_PREFIX = 'piper:';

export function isPiperVoice(voice) {
  return typeof voice === 'string' && voice.startsWith(VOICE_PREFIX);
}

export function createPiperVoiceProvider(getVoices) {
  const voiceCache = new Map();

  return {
    async list() {
      return Object.fromEntries(getVoices().map(voice => [
        `${VOICE_PREFIX}${voice.id}`,
        { num_speakers: voice.numSpeakers },
      ]));
    },
    async fetch(voice) {
      const id = isPiperVoice(voice) ? voice.slice(VOICE_PREFIX.length) : '';
      const metadata = getVoices().find(item => item.id === id);
      if (!metadata) throw new Error('La voz Piper seleccionada ya no está disponible.');
      const cached = voiceCache.get(id);
      if (cached) return [cached.config, cached.modelUrl];

      const configResponse = await fetch(`/api/voices/${encodeURIComponent(id)}/config`);
      if (!configResponse.ok) {
        const data = await configResponse.json().catch(() => ({}));
        throw new Error(data.error || 'No se pudo cargar la configuración de la voz.');
      }
      const config = await configResponse.json();
      const chunks = [];
      for (let offset = 0; offset < metadata.chunks; offset += 4) {
        const batch = Array.from({ length: Math.min(4, metadata.chunks - offset) }, (_, index) => offset + index);
        const responses = await Promise.all(batch.map(async chunk => {
          const response = await fetch(`/api/voices/${encodeURIComponent(id)}/model/${chunk}`);
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || 'No se pudo descargar el modelo de voz.');
          }
          return response.blob();
        }));
        chunks.push(...responses);
      }
      const modelUrl = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' }));
      voiceCache.set(id, { config, modelUrl });
      return [config, modelUrl];
    },
    destroy() {
      for (const { modelUrl } of voiceCache.values()) URL.revokeObjectURL(modelUrl);
      voiceCache.clear();
    },
  };
}
