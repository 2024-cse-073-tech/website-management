'use strict';

(() => {
  try {
    const saved = localStorage.getItem('flowmate-theme') || localStorage.getItem('orbit_theme') || 'light';
    const preference = ['light', 'dark', 'system'].includes(saved) ? saved : 'light';
    const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#17171f' : '#f6f7fb');
  } catch {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.themePreference = 'light';
    document.documentElement.style.colorScheme = 'light';
  }
})();
