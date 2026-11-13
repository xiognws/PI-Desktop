import type { ChangelogEntry } from "./changelog.js";

export const frEntries: ChangelogEntry[] = [
  {
    version: "0.21.0",
    date: "2026-11-13",
    highlights: [
      "Projets, sessions, extensions, modèles et tâches planifiées vivent dans une seule application de bureau.",
      "Choisissez le mode agent, plan ou objectif par session ; chaque appel d'outil passe d'abord par la couche de permissions.",
      "Déléguez le travail à cinq sous-agents intégrés (explorateur, relecteur de code, exécuteur de tests, correcteur et designer d'interface), chacun avec son propre contexte.",
      "Connectez n'importe quel point d'accès compatible OpenAI ou un moteur de modèles local, et changez de modèle dans une session en cours.",
      "Étendez le bureau lui-même avec des extensions : commandes, panneaux, widgets flottants, vues du panneau de travail, outils d'agent, thèmes, serveurs MCP et services d'arrière-plan.",
      "Les données restent sur cette machine : sessions, journaux et identifiants restent locaux, et l'application n'envoie aucune télémétrie.",
      "Relisez les modifications dans le panneau de diff, suivez les commandes d'arrière-plan et rouvrez les fichiers touchés depuis la liste des artefacts.",
      "Exécutez des tâches d'agent planifiées pendant que l'application est ouverte et affichez des cartes interactives dans la conversation.",
    ],
  },
];
