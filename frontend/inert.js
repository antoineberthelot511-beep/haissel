'use strict';

/*
 * Propriété partagée de l'attribut « inert ».
 *
 * Deux écrans couvrent la page et doivent rendre le contenu de dessous
 * inatteignable au clavier : l'accueil smartphone (mobile-splash.js) et la
 * question de majorité (app.js). Sans arbitrage, le second à se fermer
 * efface l'inertie que le premier veut encore — c'est exactement ce qui se
 * produisait : la connexion fermait l'accueil smartphone, qui remettait
 * « inert » à false sur .app-shell juste après que la question de majorité
 * l'eut posé, laissant le formulaire accessible à la tabulation derrière
 * l'écran.
 *
 * Ici, chaque élément garde la liste de ses demandeurs. Il reste inerte tant
 * qu'il en reste au moins un.
 */
window.HaisselInert = (function inertModule() {
  // element -> Set des noms de demandeurs
  const owners = new WeakMap();

  function apply(element) {
    const set = owners.get(element);
    element.inert = Boolean(set && set.size);
  }

  return {
    /**
     * @param {Element} element  élément à rendre inerte (ou non)
     * @param {string}  owner    nom du demandeur, ex. 'splash' ou 'age-gate'
     * @param {boolean} on       true = ce demandeur exige l'inertie
     */
    set(element, owner, on) {
      if (!element) return;
      let set = owners.get(element);
      if (!set) {
        set = new Set();
        owners.set(element, set);
      }
      if (on) set.add(owner); else set.delete(owner);
      apply(element);
    },
  };
}());
