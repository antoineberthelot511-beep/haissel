/*
 * Lignes dépliables de la page d'une offre (style Réglages iOS) :
 * <button aria-expanded aria-controls> + panneau. Toutes fermées au départ.
 * L'animation (hauteur ~250 ms, chevron qui tourne de 90°) est en CSS
 * (app-v2.css), coupée par prefers-reduced-motion. Aucun style en ligne.
 *
 * Logique sans DOM direct : testable (tests/disclosure.test.js).
 */
(function (root) {
  'use strict';

  function isOpen(button) {
    return button.getAttribute('aria-expanded') === 'true';
  }

  function setOpen(button, panel, open) {
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) panel.removeAttribute('inert');
    else panel.setAttribute('inert', '');
    if (panel.classList) panel.classList.toggle('is-open', open);
    return open;
  }

  function toggle(button, panel) {
    return setOpen(button, panel, !isOpen(button));
  }

  /** Une ligne n'est affichée que si son contenu n'est pas vide. */
  function hasContent(content) {
    if (content === null || content === undefined || content === false) return false;
    if (Array.isArray(content)) return content.some(hasContent);
    if (typeof content === 'string') return content.trim() !== '';
    return true;
  }

  root.HaisselDisclosure = { isOpen, setOpen, toggle, hasContent };
}(typeof window !== 'undefined' ? window : globalThis));
