export type VoiceSpeaker = 'primary' | 'secondary';
export type VoiceSettings = {
  provider: 'system' | 'minimax';
  model: 'speech-2.8-hd' | 'speech-2.8-turbo';
  voice: 'Japanese_KindLady' | 'Japanese_IntellectualSenior' | 'Japanese_CalmLady' | 'Japanese_GentleButler';
  secondaryVoice: VoiceSettings['voice'];
  alternateSpeakers: boolean;
  speed: number;
  hasApiKey: boolean;
};
export type VoiceSettingsPatch = Partial<Omit<VoiceSettings, 'hasApiKey'>> & { apiKey?: string };
export type VoiceCacheStats = { clips: number; bytes: number };
export type VoiceSynthesisInput = { text: string; rate?: number; speaker?: VoiceSpeaker };

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  provider: 'system', model: 'speech-2.8-hd', voice: 'Japanese_KindLady', secondaryVoice: 'Japanese_IntellectualSenior',
  alternateSpeakers: true, speed: 1, hasApiKey: false,
};
