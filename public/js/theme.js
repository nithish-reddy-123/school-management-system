// Runs before first paint (loaded without defer) so the saved theme and sidebar state never flash.
(function () {
  try {
    var root = document.documentElement;
    root.classList.add('js'); // lets CSS enable JS-only effects (scroll reveal) without hiding content when JS is off
    var theme = localStorage.getItem('sms-theme');
    if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
    if (localStorage.getItem('sms-sidebar') === 'collapsed') root.classList.add('sidebar-collapsed');
    if (localStorage.getItem('sms-anim') === 'paused') root.classList.add('anim-paused');
  } catch (e) { /* storage blocked: use defaults */ }
})();
