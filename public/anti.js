/* ===========================
   ANTI KLIK KANAN
=========================== */
document.addEventListener("contextmenu", e => e.preventDefault());

/* ===========================
   ANTI SENTUH LAMA
=========================== */
let touchStartTime = 0;

document.addEventListener("touchstart", () => {
  touchStartTime = Date.now();
});

document.addEventListener("touchend", e => {
  if (Date.now() - touchStartTime > 500) {
    e.preventDefault();
  }
});

/* ===========================
   ANTI SELEKSI TEKS & COPY
=========================== */
document.addEventListener("selectstart", e => e.preventDefault());
document.addEventListener("copy", e => e.preventDefault());

/* ===========================
   ANTI DRAG
=========================== */
document.addEventListener("dragstart", e => e.preventDefault());

/* ===========================
   ANTI DEVTOOLS (basic)
=========================== */
(function devtoolsBlocker() {
  function checkDevTools() {
    if (
      window.outerWidth - window.innerWidth > 200 ||
      window.outerHeight - window.innerHeight > 200
    ) {
      document.body.innerHTML = "";
    }
  }
  setInterval(checkDevTools, 500);
})();

/* ===========================
   BLOK CTRL + U, CTRL + C, F12, CTRL+SHIFT+I
=========================== */
document.addEventListener("keydown", e => {
  if (
    e.key === "F12" ||
    (e.ctrlKey && e.key.toLowerCase() === "u") ||
    (e.ctrlKey && e.key.toLowerCase() === "c") ||
    (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "i")
  ) {
    e.preventDefault();
  }
});