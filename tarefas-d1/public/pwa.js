const button = document.getElementById("installApp");
const message = document.getElementById("installMessage");
let promptEvent;

const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

if (!standalone && appleMobile) button.hidden = false;

window.addEventListener("beforeinstallprompt", event => {
  if (standalone) return;
  event.preventDefault();
  promptEvent = event;
  button.hidden = false;
});

button.addEventListener("click", async () => {
  if (!promptEvent) {
    message.textContent = appleMobile
      ? "No Safari, toque em Compartilhar e depois em Adicionar à Tela de Início."
      : "Use a opção de instalação no menu do navegador.";
    message.hidden = false;
    return;
  }
  const pending = promptEvent;
  promptEvent = undefined;
  button.disabled = true;
  try {
    const { outcome } = await pending.prompt();
    button.hidden = outcome === "accepted";
  } catch {
    message.textContent = "Use a opção de instalação no menu do navegador.";
    message.hidden = false;
  } finally {
    button.disabled = false;
  }
});

window.addEventListener("appinstalled", () => {
  promptEvent = undefined;
  button.hidden = true;
  message.hidden = true;
});

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/service-worker.js").catch(error => {
    console.warn("Não foi possível preparar a tela offline do Drogalink.", error.name);
  });
}
