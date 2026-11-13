import type { ChangelogEntry } from "./changelog.js";

export const esEntries: ChangelogEntry[] = [
  {
    version: "0.21.0",
    date: "2026-11-13",
    highlights: [
      "Proyectos, sesiones, complementos, modelos y tareas programadas conviven en una sola aplicación de escritorio.",
      "Elige el modo agente, plan o meta en cada sesión; cada llamada a herramienta pasa primero por la capa de permisos.",
      "Delega trabajo a cinco subagentes integrados (explorador, revisor de código, ejecutor de pruebas, corrector y diseñador de UI), cada uno con su propio contexto.",
      "Conecta cualquier endpoint compatible con OpenAI o un entorno local de modelos y cambia de modelo con la sesión en marcha.",
      "Amplía el propio escritorio con complementos: comandos, paneles, widgets flotantes, vistas del panel de trabajo, herramientas de agente, temas, servidores MCP y servicios en segundo plano.",
      "Los datos se quedan en este equipo: sesiones, registros y credenciales son locales y la aplicación no envía telemetría.",
      "Revisa cambios en el panel de diff, sigue los comandos en segundo plano y reabre cualquier archivo tocado desde la lista de artefactos.",
      "Ejecuta tareas programadas de agente con la aplicación abierta y muestra tarjetas interactivas dentro de la conversación.",
    ],
  },
];
