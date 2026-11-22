const VOICE_STORAGE_KEY = 'michi-voice-enabled';
const state = window.michiState;

function isVoiceSupported() { return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; }
function voiceEnabled() { return localStorage.getItem(VOICE_STORAGE_KEY) !== 'false'; }
function setVoiceEnabled(enabled) {
  localStorage.setItem(VOICE_STORAGE_KEY, String(enabled));
  const button = document.getElementById('voiceBtn');
  if (button) { button.classList.toggle('muted', !enabled); button.textContent = enabled ? '🔊' : '🔇'; button.setAttribute('aria-label', enabled ? '音声案内をオフ' : '音声案内をオン'); }
  if (!enabled && isVoiceSupported()) speechSynthesis.cancel();
}
function speak(text) {
  if (!voiceEnabled() || !isVoiceSupported()) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP'; utterance.rate = 1.05; utterance.pitch = 1;
  speechSynthesis.speak(utterance);
}
window.michiVoice = { speak, setVoiceEnabled, voiceEnabled, isVoiceSupported };
