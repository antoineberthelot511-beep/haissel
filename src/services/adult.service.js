/*
 * Majorité déclarée.
 *
 * MyLead exige 18 ans pour ouvrir un compte éditeur. HAISSEL mène vers ce
 * compte (parcours MyLead, lien de parrainage) et vers des liens affiliés :
 * ces chemins sont réservés aux membres qui ont déclaré être majeurs.
 *
 * Ce que HAISSEL sait, et ne sait pas :
 *   - is_adult === true   -> le membre a déclaré 18 ans ou plus. On peut donc
 *                           garantir « au moins 18 », rien de plus.
 *   - is_adult === false  -> il a déclaré moins de 18 ans. On ne connaît pas
 *                           son âge exact : aucune date de naissance n'est
 *                           enregistrée.
 *   - is_adult === null   -> la question n'a pas encore été posée (compte créé
 *                           avant la mise en place).
 *
 * Déclaration sur l'honneur : elle pose une limite nette et vérifiable dans
 * les journaux, elle ne prouve pas l'âge réel.
 */

const ADULT_AGE = 18;

/*
 * Délai avant de pouvoir passer de « moins de 18 ans » à « 18 ans ou plus ».
 *
 * Sans délai, la déclaration ne vaudrait rien : un mineur refusé n'aurait
 * qu'à répondre « oui » dans la foulée. Trente jours rendent le contournement
 * pénible sans enfermer personne : un anniversaire reste déclarable, au pire
 * avec un mois d'attente, ou tout de suite via l'administrateur.
 *
 * L'inverse — « oui » vers « non » — est toujours immédiat : se déclarer
 * mineur restreint ses propres droits, personne n'a à en être dissuadé.
 */
const ADULT_UPGRADE_DELAY_DAYS = 30;

/** Le membre a-t-il déclaré être majeur ? */
function isAdult(user) {
  return user?.is_adult === true;
}

/** La question doit-elle encore être posée ? */
function needsDeclaration(user) {
  return !user || user.is_adult === null || user.is_adult === undefined;
}

/**
 * Âge que HAISSEL peut certifier à partir de la déclaration.
 * 18 pour un majeur (au moins), 0 sinon : on ne sait rien de plus.
 */
function certifiedAge(user) {
  return isAdult(user) ? ADULT_AGE : 0;
}

/**
 * Une offre portant un âge minimum est-elle ouvrable par ce membre ?
 *
 * La déclaration est binaire : elle certifie « au moins 18 ans », jamais 21
 * ni 25. Une offre réservée aux 21 ans et plus n'est donc ouvrable par
 * personne tant que HAISSEL ne collecte pas d'âge précis — c'est volontaire :
 * mieux vaut refuser que laisser passer sur une donnée qu'on n'a pas.
 */
function meetsMinAge(user, minAge) {
  if (minAge === null || minAge === undefined) return true;
  return Number(minAge) <= certifiedAge(user);
}

/*
 * Motif de refus pour l'ouverture d'un lien affilié, ou null si c'est permis.
 * Trois cas distincts, pour que le message affiché soit juste :
 *   - la question n'a pas été posée  -> il faut y répondre d'abord ;
 *   - le membre est mineur           -> aucun lien affilié ;
 *   - l'offre exige plus que 18 ans  -> on ne peut pas le certifier.
 */
function refusalForAffiliateLink(user, minAge = null) {
  if (needsDeclaration(user)) {
    return {
      code: 'ADULT_DECLARATION_REQUIRED',
      message: 'Réponds d’abord à la question sur ton âge pour continuer.',
    };
  }
  if (!isAdult(user)) {
    return {
      code: 'ADULT_REQUIRED',
      message: 'Les liens affiliés sont réservés aux membres de 18 ans ou plus. '
        + 'Les guides de l’espace Apprendre restent accessibles.',
    };
  }
  if (!meetsMinAge(user, minAge)) {
    return {
      code: 'AGE_RESTRICTED',
      message: `Cette offre est réservée aux ${minAge} ans et plus. `
        + 'HAISSEL ne peut confirmer que « 18 ans ou plus », pas un âge précis.',
    };
  }
  return null;
}

/*
 * Un membre peut-il passer à « majeur » maintenant ?
 * Retourne { allowed: true } ou { allowed: false, daysLeft }.
 */
function canDeclareAdult(user) {
  // Jamais répondu, ou déjà majeur : aucune restriction.
  if (user?.is_adult !== false || !user.adult_declared_at) return { allowed: true };

  const declaredAt = new Date(user.adult_declared_at).getTime();
  const elapsedDays = (Date.now() - declaredAt) / 86400000;
  if (elapsedDays >= ADULT_UPGRADE_DELAY_DAYS) return { allowed: true };

  return { allowed: false, daysLeft: Math.max(1, Math.ceil(ADULT_UPGRADE_DELAY_DAYS - elapsedDays)) };
}

/*
 * Offres de l'équipe (liens affiliés, « affiliate ») : âge minimum fixé par
 * l'admin (13, 15, 16 ou 18). L'inscription certifie 15 ans au moins (case
 * obligatoire) et la déclaration de majorité 18 ans : un mineur voit les
 * offres 13+ et 15+, jamais les 16+ (âge non certifiable) ni les 18+.
 */
const TEAM_OFFER_AGES = [13, 15, 16, 18];
const SIGNUP_CERTIFIED_AGE = 15;

function canSeeTeamOffer(user, minAge) {
  if (needsDeclaration(user)) return false;
  if (isAdult(user)) return true;
  return minAge !== null && minAge !== undefined && Number(minAge) <= SIGNUP_CERTIFIED_AGE;
}

module.exports = {
  TEAM_OFFER_AGES,
  SIGNUP_CERTIFIED_AGE,
  canSeeTeamOffer,
  ADULT_AGE,
  ADULT_UPGRADE_DELAY_DAYS,
  canDeclareAdult,
  isAdult,
  needsDeclaration,
  certifiedAge,
  meetsMinAge,
  refusalForAffiliateLink,
};
