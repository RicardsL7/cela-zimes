// A10: lapu nedrīkst rādīt svešā lapā rāmī (iframe) — tā var pievilt lietotāju nospiest pogas (clickjacking).
// GitHub Pages neļauj iestatīt galvenes X-Frame-Options / CSP frame-ancestors (meta tagā tās nedarbojas), tāpēc
// pārbaude šeit: ja lapa ir rāmī, to nerāda un mēģina atvērt pa visu logu. Ielādē <head> sākumā, bez defer.
(function () {
  var framed;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (!framed) return;
  document.documentElement.style.display = 'none';
  try { window.top.location.replace(window.location.href); } catch (e) { /* pārlūks neļauj — lapa paliek paslēpta */ }
})();
