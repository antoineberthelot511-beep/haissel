const express = require('express');
const auth = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth.middleware');
const {
  authRateLimiter,
  registerRateLimiter,
  accountRecoveryRateLimiter,
  mfaRateLimiter,
} = require('../middleware/rate-limit.middleware');
const { requireTurnstile } = require('../middleware/turnstile.middleware');

const router = express.Router();
const pendingOk = authenticate({ allowMfaPending: true });
const signedIn = authenticate();

router.get('/config', auth.getAuthConfig);

// Limite par IP d'abord (même sans jeton Turnstile), puis vérification anti-robot.
router.post('/register', registerRateLimiter, requireTurnstile('register'), auth.register);
router.post('/login', authRateLimiter, requireTurnstile('login'), auth.login);
router.post('/mfa/verify', mfaRateLimiter, pendingOk, auth.verifyMfaLogin);

router.get('/me', pendingOk, auth.me);
// Déclaration de majorité (comptes créés avant sa mise en place).
router.post('/adult-declaration', authRateLimiter, signedIn, auth.declareAdult);
// Session et jeton CSRF obligatoires (signedIn).
router.post('/install-tuto/seen', authRateLimiter, signedIn, auth.markInstallTutoSeen);
// Réglages : profil visible par les autres membres (privé par défaut).
router.post('/me/profile-visibility', authRateLimiter, signedIn, auth.setProfileVisibility);
router.post('/logout', pendingOk, auth.logout);
router.post('/logout-all', signedIn, auth.logoutAll);

router.post('/email/verify', accountRecoveryRateLimiter, auth.verifyEmail);
router.post('/email/resend', accountRecoveryRateLimiter, auth.resendVerification);
// Formulaire public : protégé au même titre que l'inscription et la connexion.
router.post('/password/forgot', accountRecoveryRateLimiter, requireTurnstile('forgot-password'), auth.forgotPassword);
router.post('/password/reset', accountRecoveryRateLimiter, auth.resetPassword);
router.post('/password/change', authRateLimiter, signedIn, auth.changePassword);

router.post('/mfa/setup', mfaRateLimiter, signedIn, auth.mfaSetup);
router.post('/mfa/enable', mfaRateLimiter, signedIn, auth.mfaEnable);
router.post('/mfa/disable', mfaRateLimiter, signedIn, auth.mfaDisable);

// RGPD : export (art. 15/20) et suppression du compte (art. 17).
router.get('/me/export', accountRecoveryRateLimiter, signedIn, auth.exportMyData);
router.post('/me/delete', authRateLimiter, signedIn, auth.deleteMyAccount);

module.exports = router;
