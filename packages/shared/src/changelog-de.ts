import type { ChangelogEntry } from "./changelog.js";

export const deEntries: ChangelogEntry[] = [
  {
    version: "0.21.0",
    date: "2026-11-13",
    highlights: [
      "Projekte, Sitzungen, Plugins, Modelle und geplante Aufgaben liegen in einer Desktop-App statt in getrennten Werkzeugen.",
      "Wähle pro Sitzung Agent-, Plan- oder Zielmodus; jede Werkzeugausführung entscheidet zuerst die Berechtigungsschicht.",
      "Delegiere Arbeit an fünf eingebaute Subagenten (Explorer, Code-Reviewer, Testläufer, Fixer und UI-Designer), jeweils mit eigenem Kontext.",
      "Verbinde beliebige OpenAI-kompatible Endpunkte oder eine lokale Modell-Laufzeit und wechsle das Modell in einer laufenden Sitzung.",
      "Erweitere den Desktop selbst mit Plugins: Befehle, Panels, schwebende Widgets, Arbeitsbereichsansichten, Agent-Werkzeuge, Themes, MCP-Server und Hintergrunddienste.",
      "Daten bleiben auf diesem Rechner: Sitzungen, Protokolle und Zugangsdaten liegen lokal, die App sendet keine Telemetrie.",
      "Prüfe Änderungen im Diff-Panel, verfolge Hintergrundbefehle und öffne jede berührte Datei über die Artefaktliste erneut.",
      "Führe geplante Agent-Aufgaben aus, während die App läuft, und rendere interaktive Karten direkt im Gespräch.",
    ],
  },
];
