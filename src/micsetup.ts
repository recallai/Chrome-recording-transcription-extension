// src/micsetup.ts

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('enable') as HTMLButtonElement | null;
    const statusEl = document.getElementById('status') as HTMLParagraphElement | null;
  
    if (!btn || !statusEl) return;
  
    btn.addEventListener('click', async () => {
      statusEl.textContent = 'Requesting microphone…';
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
        statusEl.textContent = 'Microphone enabled. You can close this tab.';
      } catch (e: any) {
        statusEl.textContent = `Mic blocked: ${e?.name || e}. Check Chrome & OS settings.`;
        console.error('[micsetup] getUserMedia error:', e);
      }
    });
  });
  