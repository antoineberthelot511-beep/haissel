/*
 * Mode diagnostic des touchers : actif SEULEMENT si l'URL contient ?debug=touch.
 * Panneau semi-transparent en haut de l'écran (pointer-events: none) qui
 * montre le dernier toucher. Écouteurs en capture et passifs : ils ne changent
 * rien au comportement. Rien n'est envoyé au serveur.
 */
(function touchDebug() {
  'use strict';

  let params;
  try { params = new URLSearchParams(window.location.search); } catch (error) { return; }
  if (params.get('debug') !== 'touch') return;

  const WATCHED = ['transform', 'filter', 'backdropFilter', 'webkitBackdropFilter', 'contain', 'willChange'];
  const info = {};
  let panel = null;

  function describe(el) {
    if (!el || !el.tagName) return String(el);
    let text = el.tagName.toLowerCase();
    if (el.id) text += `#${el.id}`;
    if (typeof el.className === 'string' && el.className.trim()) text += `.${el.className.trim().split(/\s+/).join('.')}`;
    return text;
  }

  function suspects(el) {
    const out = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const cs = window.getComputedStyle(node);
      const found = [];
      if (node.inert || node.hasAttribute('inert')) found.push('inert');
      if (cs.pointerEvents === 'none') found.push('pointer-events:none');
      WATCHED.forEach((prop) => {
        const value = cs[prop];
        if (value && value !== 'none' && value !== 'auto' && value !== 'normal') found.push(`${prop}:${value}`);
      });
      if (found.length) out.push(`${describe(node)} → ${found.join(', ')}`);
    }
    return out;
  }

  function touchAction(el) {
    return el && el.nodeType === 1 ? window.getComputedStyle(el).touchAction : '-';
  }

  function render() {
    if (!panel) {
      panel = document.createElement('pre');
      panel.setAttribute('aria-hidden', 'true');
      Object.assign(panel.style, {
        position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647', margin: '0',
        padding: '6px 8px', maxHeight: '45vh', overflow: 'hidden', pointerEvents: 'none',
        background: 'rgba(0,0,0,.72)', color: '#9f9', font: '10px/1.35 ui-monospace, Menlo, monospace',
        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      });
      document.documentElement.append(panel);
    }
    const feed = document.querySelector('.discover-feed');
    const main = document.getElementById('main');
    const lines = [
      `view: ${document.body ? document.body.dataset.view : '-'}`,
      `touchstart: ${info.touchTarget || '-'}  dp=${info.touchstartPrevented}`,
      `touchmove dp=${info.touchmovePrevented}`,
      `pointerdown: ${info.pointerTarget || '-'} (${info.pointerType || '-'})`,
      `elementFromPoint(${info.x},${info.y}): ${info.fromPoint || '-'}`,
      `click reçu: ${info.click ? `oui → ${info.clickTarget} dp=${info.clickPrevented}` : 'non'}`,
      `scrollTop feed=${feed ? Math.round(feed.scrollTop) : '-'} doc=${document.scrollingElement ? Math.round(document.scrollingElement.scrollTop) : '-'}`,
      `touch-action cible=${info.targetTouchAction || '-'} #main=${touchAction(main)}`,
      'ancêtres suspects :',
      ...(info.suspects && info.suspects.length ? info.suspects.map((line) => `  ${line}`) : ['  (aucun)']),
    ];
    panel.textContent = lines.join('\n');
  }

  // Lecture de defaultPrevented après les autres écouteurs : file de tâches.
  function later(fn) { window.setTimeout(() => { fn(); render(); }, 0); }

  const opts = { capture: true, passive: true };

  window.addEventListener('touchstart', (event) => {
    const touch = event.touches[0];
    const target = event.target;
    info.click = false;
    info.touchTarget = describe(target);
    info.touchmovePrevented = '-';
    if (touch) {
      info.x = Math.round(touch.clientX);
      info.y = Math.round(touch.clientY);
      info.fromPoint = describe(document.elementFromPoint(touch.clientX, touch.clientY));
    }
    info.suspects = suspects(target);
    info.targetTouchAction = touchAction(target);
    later(() => { info.touchstartPrevented = event.defaultPrevented; });
  }, opts);

  window.addEventListener('touchmove', (event) => {
    later(() => { info.touchmovePrevented = event.defaultPrevented; });
  }, opts);

  window.addEventListener('pointerdown', (event) => {
    info.pointerTarget = describe(event.target);
    info.pointerType = event.pointerType;
    if (event.pointerType !== 'touch') {
      info.x = Math.round(event.clientX);
      info.y = Math.round(event.clientY);
      info.fromPoint = describe(document.elementFromPoint(event.clientX, event.clientY));
      info.suspects = suspects(event.target);
      info.targetTouchAction = touchAction(event.target);
    }
    render();
  }, opts);

  window.addEventListener('click', (event) => {
    info.click = true;
    info.clickTarget = describe(event.target);
    later(() => { info.clickPrevented = event.defaultPrevented; });
  }, opts);

  // En capture sur window : reçoit aussi le défilement de .discover-feed (scroll ne remonte pas).
  window.addEventListener('scroll', render, opts);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
}());
