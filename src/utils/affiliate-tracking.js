/*
 * Reconnaissance des liens de suivi affilié.
 *
 * Les membres partagent des FICHES CAMPAGNE : un lien vers la page officielle
 * (site de l'annonceur, ou page de la campagne sur MyLead), jamais leur lien
 * affilié personnel. Chacun récupère son propre lien sur MyLead. Seuls les
 * ADMIN publient des liens affiliés.
 *
 * Les listes ci-dessous sont volontairement simples à compléter : ajoutez-y
 * tout domaine ou paramètre de suivi repéré lors de la modération. Elles sont
 * reprises en SQL par la migration 20261024_0010_campaign_sheets.sql pour la
 * reprise des offres existantes ; une nouvelle entrée ici ne s'applique
 * qu'aux nouvelles publications et modifications.
 */

/*
 * Domaines de MyLead (le site lui-même). Sur ces domaines, les pages de
 * campagne restent acceptées : seuls les chemins de redirection ci-dessous
 * sont des liens de suivi. À vérifier et compléter avec de vrais liens MyLead.
 */
const MYLEAD_HOSTS = /(^|\.)mylead\.(global|eu|pl)$/;
const MYLEAD_TRACKING_PATHS = /^\/(stl|l|r|c|click|go)\//i;

/*
 * Sous-domaines de redirection courants des plateformes de suivi
 * (track.exemple.com, trk.exemple.com…), quel que soit le domaine.
 */
const TRACKING_SUBDOMAINS = /^(track|trk|tracking|clicks?)\./;

/*
 * Paramètres d'URL typiques d'un lien affilié : sous-identifiants MyLead
 * (ml_sub1…ml_sub5), identifiants d'affilié et de clic.
 */
const TRACKING_PARAMS = [
  /^ml_sub\d*$/,
  /^aff_(id|sub\d*|click_id)$/,
  /^affiliate_id$/,
  /^click_?id$/,
  /^sub_?id$/,
  /^tracking_id$/,
];

const AFFILIATE_LINK_MESSAGE = 'Ne partage pas ton lien affilié ici : partage la page officielle. '
  + 'Chacun récupère son propre lien sur MyLead.';

/** L'URL (déjà validée et normalisée) ressemble-t-elle à un lien de suivi ? */
function isAffiliateTrackingUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (MYLEAD_HOSTS.test(host) && MYLEAD_TRACKING_PATHS.test(url.pathname)) return true;
  if (TRACKING_SUBDOMAINS.test(host)) return true;
  return [...url.searchParams.keys()].some((key) => TRACKING_PARAMS.some((pattern) => pattern.test(key.toLowerCase())));
}

module.exports = { isAffiliateTrackingUrl, AFFILIATE_LINK_MESSAGE };
