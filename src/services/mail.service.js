const { getMailTransport, isProduction } = require('../config/security');
const { getLanAddresses } = require('../utils/lan-address');
const { logger } = require('../utils/logger');

/*
 * Envoi d'e-mails.
 *   MAIL_TRANSPORT=smtp    -> nodemailer (SMTP_HOST, SMTP_PORT, SMTP_USER,
 *                             SMTP_PASSWORD, SMTP_SECURE, MAIL_FROM)
 *   MAIL_TRANSPORT=console -> développement uniquement : le message est
 *                             affiché dans la console (interdit en production)
 *   MAIL_TRANSPORT=memory  -> tests automatisés uniquement
 *   MAIL_TRANSPORT=none    -> aucun envoi ; les fonctions qui en dépendent
 *                             sont désactivées (jamais de faux « e-mail envoyé »)
 *
 * Les liens secrets utilisent un fragment d'URL (#...) : le jeton n'est
 * jamais envoyé dans une requête HTTP, ni écrit dans un journal d'accès,
 * ni transmis dans l'en-tête Referer.
 */

const outbox = []; // transport memory (tests)
let smtpTransport;

function getSmtpTransport() {
  if (!smtpTransport) {
    // Chargé à la demande : inutile si l'envoi n'est pas configuré.
    // eslint-disable-next-line global-require
    const nodemailer = require('nodemailer');
    smtpTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      requireTLS: process.env.SMTP_SECURE !== 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    });
  }
  return smtpTransport;
}

/**
 * Base des liens envoyés par e-mail. Jamais déduite de l'en-tête Host de la
 * requête (falsifiable : empoisonnement des liens de réinitialisation).
 */
function getPublicBaseUrl() {
  const configured = String(process.env.APP_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^\s/]+$/.test(configured)) return configured;
  const port = Number(process.env.PUBLIC_PORT || process.env.PORT || 3000);
  const lan = getLanAddresses()[0];
  // HTTPS natif actif (certificat configuré) : les liens doivent être en https.
  const scheme = process.env.HTTPS_CERT_FILE && process.env.HTTPS_KEY_FILE ? 'https' : 'http';
  const defaultPort = scheme === 'https' ? 443 : 80;
  return `${scheme}://${lan ? lan.address : 'localhost'}${port === defaultPort ? '' : `:${port}`}`;
}

async function sendMail({ to, subject, text }) {
  const transport = getMailTransport();

  if (transport === 'none') return false;

  if (transport === 'memory') {
    outbox.push({ to, subject, text });
    return true;
  }

  if (transport === 'console') {
    if (isProduction()) return false;
    console.log(`\n===== E-MAIL (développement, non envoyé) =====\nÀ : ${to}\nObjet : ${subject}\n\n${text}\n==============================================\n`);
    return true;
  }

  try {
    await getSmtpTransport().sendMail({ from: process.env.MAIL_FROM, to, subject, text });
    return true;
  } catch (error) {
    logger.error('E-mail sending failed', { error: error.message });
    return false;
  }
}

function sendVerificationEmail(user, token) {
  const link = `${getPublicBaseUrl()}/app#verify=${token}`;
  return sendMail({
    to: user.email,
    subject: 'HAISSEL — confirmez votre adresse e-mail',
    text: `Bonjour,\n\nConfirmez votre adresse e-mail pour activer votre compte HAISSEL :\n${link}\n\nCe lien est valable 24 heures et ne fonctionne qu'une fois.\nSi vous n'avez pas créé de compte, ignorez ce message.`,
  });
}

function sendPasswordResetEmail(user, token) {
  const link = `${getPublicBaseUrl()}/app#reset=${token}`;
  return sendMail({
    to: user.email,
    subject: 'HAISSEL — réinitialisation du mot de passe',
    text: `Bonjour,\n\nUne réinitialisation du mot de passe a été demandée pour votre compte HAISSEL :\n${link}\n\nCe lien est valable 30 minutes et ne fonctionne qu'une fois.\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.`,
  });
}

function sendPasswordChangedNotice(user) {
  return sendMail({
    to: user.email,
    subject: 'HAISSEL — votre mot de passe a été modifié',
    text: `Bonjour,\n\nLe mot de passe de votre compte HAISSEL vient d'être modifié et toutes vos sessions ont été fermées.\nSi vous n'êtes pas à l'origine de ce changement, utilisez immédiatement « Mot de passe oublié » et prévenez l'administrateur.`,
  });
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordChangedNotice,
  getPublicBaseUrl,
  outbox,
};
