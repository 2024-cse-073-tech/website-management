'use strict';

// Kept separate from app.js so password visibility still works even if the main app has a runtime issue.
(() => {
  function setPasswordVisibility(button) {
    const targetId = button.getAttribute('data-password-target');
    const input = targetId ? document.getElementById(targetId) : button.closest('.password-input-wrap')?.querySelector('input');
    if (!input) return;

    const shouldShow = input.type === 'password';
    try {
      input.type = shouldShow ? 'text' : 'password';
    } catch (_) {
      // Very old browser fallback. The CSS class below also removes masking where supported.
    }

    input.classList.toggle('password-revealed', shouldShow);
    button.textContent = shouldShow ? 'Hide' : 'Show';
    button.setAttribute('aria-label', shouldShow ? 'Hide password' : 'Show password');
    button.setAttribute('aria-pressed', shouldShow ? 'true' : 'false');

    // Preserve caret/focus without modifying the password value.
    input.focus({ preventScroll: true });
    try {
      const end = input.value.length;
      input.setSelectionRange(end, end);
    } catch (_) {}
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-password-toggle]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    setPasswordVisibility(button);
  }, true);
})();
